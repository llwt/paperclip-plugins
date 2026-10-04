// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINKED_ISSUES_DATA_KEY,
  LINKED_ISSUES_PAGE_SIZE,
  SET_STATE_ACTION_KEY,
  type LinkedIssue,
  type LinkedIssuesResult,
  type WorkflowState
} from "../src/control.js";
import { LinearStatusControl, MAX_CHIP_RETRIES } from "../src/ui/index.js";

// Stands in for the host bridge: `usePluginData` reads from `sdk.getData` and
// reads again on `refresh()`, `usePluginAction` returns `sdk.action`.
const sdk = vi.hoisted(() => ({ getData: vi.fn(), action: vi.fn(), actionKeys: [] as string[] }));
vi.mock("@paperclipai/plugin-sdk/ui", async () => {
  const React = await import("react");
  return {
    usePluginData: (key: string, params: Record<string, unknown>) => {
      const [version, setVersion] = React.useState(0);
      const serialized = JSON.stringify(params);
      const data = React.useMemo(() => sdk.getData(key, JSON.parse(serialized)), [key, serialized, version]);
      return { data, loading: false, error: null, refresh: () => setVersion((current) => current + 1) };
    },
    usePluginAction: (key: string) => {
      sdk.actionKeys.push(key);
      return sdk.action;
    }
  };
});

const ISSUE_ID = "issue-1";
const TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted" };
const IN_PROGRESS: WorkflowState = { id: "state-progress", name: "In Progress", type: "started" };
const DONE: WorkflowState = { id: "state-done", name: "Done", type: "completed" };
const STATES = [TODO, IN_PROGRESS, DONE];
const TTL_MS = 300_000;

// What Linear holds, as the worker would report it.
let linear: Map<string, WorkflowState>;
// What the host's chips show, and whether the host agrees to re-read them.
let chips: Map<string, string>;
let hostRefresh: "refreshes" | "backoff" | "http-503" | "network-error";
const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function chipObject(identifier: string) {
  return {
    id: `object-${identifier}`,
    providerKey: "linear",
    externalId: identifier,
    statusLabel: chips.get(identifier) ?? null,
    nextRefreshAt: new Date(Date.now() + TTL_MS).toISOString()
  };
}

function refreshPosts() {
  return fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/refresh") && init?.method === "POST");
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function open() {
  return render(<LinearStatusControl context={{ entityId: ISSUE_ID, entityType: "issue" } as never} />);
}

function pickState(identifier: string, state: WorkflowState) {
  fireEvent.change(screen.getByLabelText(`State of ${identifier} in Linear`), { target: { value: state.id } });
}

beforeEach(() => {
  vi.useFakeTimers();
  linear = new Map([
    ["ENG-1", DONE],
    ["ENG-2", TODO]
  ]);
  chips = new Map([
    ["ENG-1", "Done"],
    ["ENG-2", "Todo"]
  ]);
  hostRefresh = "refreshes";
  sdk.actionKeys.length = 0;

  sdk.getData.mockReset().mockImplementation((_key: string, params: { offset: number }): LinkedIssuesResult => {
    const identifiers = [...linear.keys()];
    const page = identifiers.slice(params.offset, params.offset + LINKED_ISSUES_PAGE_SIZE);
    const end = params.offset + page.length;
    return {
      issues: page.map((identifier): LinkedIssue => ({ identifier, status: "ok", state: linear.get(identifier)!, states: STATES })),
      total: identifiers.length,
      nextOffset: end < identifiers.length ? end : null
    };
  });
  sdk.action.mockReset().mockImplementation(async ({ identifier, stateId }: { identifier: string; stateId: string }) => {
    const state = STATES.find((entry) => entry.id === stateId)!;
    linear.set(identifier, state);
    return { ok: true, identifier, state, changed: true };
  });

  fetchMock.mockReset().mockImplementation(async (url, init) => {
    if (init?.method !== "POST") return json([...chips.keys()].map((identifier) => ({ object: chipObject(identifier) })));
    if (hostRefresh === "http-503") return json({ error: "unavailable" }, 503);
    if (hostRefresh === "network-error") throw new Error("network down");
    const { objectIds } = JSON.parse(init.body as string) as { objectIds: string[] };
    return json({
      refreshed: objectIds.map((id) => {
        const identifier = id.replace("object-", "");
        if (hostRefresh === "refreshes") chips.set(identifier, linear.get(identifier)!.name);
        return { object: chipObject(identifier), refreshed: hostRefresh === "refreshes" };
      })
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LinearStatusControl", () => {
  it("lists each linked issue with its state and asks the host for nothing when the chips match", async () => {
    open();
    await settle();

    expect(sdk.getData).toHaveBeenCalledWith(LINKED_ISSUES_DATA_KEY, { issueId: ISSUE_ID, offset: 0 });
    expect((screen.getByLabelText("State of ENG-1 in Linear") as HTMLSelectElement).value).toBe(DONE.id);
    expect((screen.getByLabelText("State of ENG-2 in Linear") as HTMLSelectElement).value).toBe(TODO.id);
    expect(refreshPosts()).toHaveLength(0);
    expect(sdk.action).not.toHaveBeenCalled();
  });

  it("sends one change for the one picked issue and brings its chip up to date", async () => {
    open();
    await settle();

    // A terminal chip (Done) moved back to an active state.
    pickState("ENG-1", IN_PROGRESS);
    await settle();

    expect(sdk.actionKeys.every((key) => key === SET_STATE_ACTION_KEY)).toBe(true);
    expect(sdk.action.mock.calls).toEqual([[{ issueId: ISSUE_ID, identifier: "ENG-1", stateId: IN_PROGRESS.id }]]);
    expect(screen.getByText("ENG-1 is now In Progress in Linear.")).toBeTruthy();
    expect(refreshPosts().map(([, init]) => JSON.parse(init?.body as string))).toEqual([{ objectIds: ["object-ENG-1"] }]);
    expect(chips.get("ENG-1")).toBe("In Progress");
    expect(chips.get("ENG-2")).toBe("Todo");
  });

  it("does not lose the chip refresh when the page is left while the host still declines it", async () => {
    hostRefresh = "backoff";
    const first = open();
    await settle();
    pickState("ENG-1", IN_PROGRESS);
    await settle();

    expect(screen.getByText(/The link chips are behind Linear/)).toBeTruthy();
    expect(refreshPosts()).toHaveLength(1);
    expect(chips.get("ENG-1")).toBe("Done");

    // Leave the task before the retry is due. The retry timer goes with the page.
    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TTL_MS * 2);
    });
    expect(refreshPosts()).toHaveLength(1);
    expect(chips.get("ENG-1")).toBe("Done");

    // Coming back asks again, without any new pick, and the chip follows.
    hostRefresh = "refreshes";
    open();
    await settle();

    expect(refreshPosts()).toHaveLength(2);
    expect(chips.get("ENG-1")).toBe("In Progress");
    expect(screen.queryByText(/The link chips are behind Linear/)).toBeNull();
    expect(sdk.action).toHaveBeenCalledTimes(1);
  });

  it("asks again when the chip's TTL has passed while the page stays open, a bounded number of times", async () => {
    hostRefresh = "backoff";
    open();
    await settle();
    pickState("ENG-1", IN_PROGRESS);
    await settle();
    expect(refreshPosts()).toHaveLength(1);

    for (let attempt = 0; attempt < MAX_CHIP_RETRIES + 2; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TTL_MS + 5_000);
      });
    }
    expect(refreshPosts()).toHaveLength(1 + MAX_CHIP_RETRIES);

    hostRefresh = "refreshes";
    fireEvent.change(screen.getByLabelText("State of ENG-2 in Linear"), { target: { value: DONE.id } });
    await settle();
    expect(chips.get("ENG-1")).toBe("In Progress");
    expect(chips.get("ENG-2")).toBe("Done");
  });

  it.each(["http-503", "network-error"] as const)(
    "reports a failed chip refresh (%s) apart from the completed change and recovers without a second change",
    async (failure) => {
      open();
      await settle();
      hostRefresh = failure;
      pickState("ENG-1", IN_PROGRESS);
      await settle();

      expect(screen.getByText("ENG-1 is now In Progress in Linear.")).toBeTruthy();
      expect(screen.getByText(/The link chips could not be refreshed/)).toBeTruthy();
      expect(chips.get("ENG-1")).toBe("Done");
      // A failed refresh is not retried on a timer.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TTL_MS * 2);
      });
      expect(refreshPosts()).toHaveLength(1);

      hostRefresh = "refreshes";
      fireEvent.click(screen.getByRole("button", { name: "Refresh chips" }));
      await settle();

      expect(chips.get("ENG-1")).toBe("In Progress");
      expect(screen.queryByText(/could not be refreshed/)).toBeNull();
      expect(sdk.action).toHaveBeenCalledTimes(1);
    }
  );

  it("shows a refused or failed change with its fixed text and does not retry it", async () => {
    open();
    await settle();

    sdk.action.mockResolvedValueOnce({ ok: false, code: "update_failed", message: "Linear did not apply the change" });
    pickState("ENG-1", IN_PROGRESS);
    await settle();
    expect(screen.getByText("ENG-1: Linear did not apply the change")).toBeTruthy();

    sdk.action.mockRejectedValueOnce(new Error("bridge down"));
    pickState("ENG-2", DONE);
    await settle();
    expect(screen.getByText("ENG-2: Linear request failed")).toBeTruthy();

    expect(sdk.action).toHaveBeenCalledTimes(2);
    expect((screen.getByLabelText("State of ENG-1 in Linear") as HTMLSelectElement).value).toBe(DONE.id);
    expect(refreshPosts()).toHaveLength(0);
  });

  it("reaches every linked issue through Show more", async () => {
    const count = LINKED_ISSUES_PAGE_SIZE + 2;
    linear = new Map(Array.from({ length: count }, (_, index) => [`ENG-${index + 1}`, TODO]));
    chips = new Map([...linear.keys()].map((identifier) => [identifier, "Todo"]));
    open();
    await settle();

    expect(screen.getAllByRole("combobox")).toHaveLength(LINKED_ISSUES_PAGE_SIZE);
    fireEvent.click(screen.getByRole("button", { name: "Show more (2 more)" }));
    await settle();

    expect(sdk.getData).toHaveBeenCalledWith(LINKED_ISSUES_DATA_KEY, { issueId: ISSUE_ID, offset: LINKED_ISSUES_PAGE_SIZE });
    expect(screen.getAllByRole("combobox")).toHaveLength(count);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();

    pickState(`ENG-${count}`, DONE);
    await settle();
    expect(sdk.action.mock.calls).toEqual([[{ issueId: ISSUE_ID, identifier: `ENG-${count}`, stateId: DONE.id }]]);
  });

  it("renders nothing on a task without Linear links", async () => {
    linear = new Map();
    const { container } = open();
    await settle();

    expect(container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
