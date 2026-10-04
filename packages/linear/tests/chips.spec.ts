import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedIssue } from "../src/control.js";
import { expectedChips, syncChips } from "../src/ui/chips.js";

const ISSUE_ID = "issue-1";
const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const LIST_URL = `/api/issues/${ISSUE_ID}/external-objects`;
const REFRESH_URL = `${LIST_URL}/refresh`;

function chip(identifier: string, statusLabel: string | null, extra: Record<string, unknown> = {}) {
  return { id: `object-${identifier}`, providerKey: "linear", externalId: identifier, statusLabel, nextRefreshAt: null, ...extra };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("expectedChips", () => {
  it("maps readable issues to the label their chip shows and skips unreadable ones", () => {
    const state = { id: "s", name: "In Review", type: "started" };
    const issues: LinkedIssue[] = [
      { identifier: "ENG-1", status: "ok", state, states: [state] },
      { identifier: "ENG-2", status: "unavailable", code: "archived", message: "x" },
      { identifier: "ENG-3", status: "unavailable", code: "not_found", message: "x" },
      { identifier: "ENG-4", status: "unavailable", code: "error", message: "x" },
      { identifier: "ENG-5", status: "unavailable", code: "auth_required", message: "x" }
    ];
    expect(expectedChips(issues)).toEqual([
      { identifier: "ENG-1", label: "In Review" },
      { identifier: "ENG-2", label: "Archived" },
      { identifier: "ENG-3", label: "Not found" }
    ]);
  });
});

describe("syncChips", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function refreshBody() {
    const call = fetchMock.mock.calls.find(([url]) => url === REFRESH_URL);
    return call ? JSON.parse(call[1]?.body as string) : null;
  }

  it("asks for nothing when there is nothing to compare or the chips already match", async () => {
    expect(await syncChips(ISSUE_ID, [], NOW)).toEqual({ status: "synced", updated: false });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json([{ object: chip("ENG-1", "Todo") }, { object: null }]));
    expect(await syncChips(ISSUE_ID, [{ identifier: "ENG-1", label: "Todo" }], NOW)).toEqual({
      status: "synced",
      updated: false
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([LIST_URL]);
  });

  it("refreshes only the stale Linear chips and reports them synced once the host re-read them", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json([
          { object: chip("ENG-1", "Done") },
          { object: chip("ENG-2", "Todo") },
          { object: chip("DOC-9", "Todo") },
          { object: { ...chip("ENG-1", "Open"), id: "other", providerKey: "github" } }
        ])
      )
      .mockResolvedValueOnce(json({ refreshed: [{ object: chip("ENG-1", "In Progress"), refreshed: true, reason: "resolved" }] }));

    // A terminal chip (Done) moved back to an active state.
    const result = await syncChips(
      ISSUE_ID,
      [
        { identifier: "ENG-1", label: "In Progress" },
        { identifier: "ENG-2", label: "Todo" }
      ],
      NOW
    );

    expect(result).toEqual({ status: "synced", updated: true });
    expect(refreshBody()).toEqual({ objectIds: ["object-ENG-1"] });
    expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
  });

  it("reports pending, with the time to ask again, when the host declines to re-read yet", async () => {
    const nextRefreshAt = new Date(NOW + 120_000).toISOString();
    fetchMock
      .mockResolvedValueOnce(json([{ object: chip("ENG-1", "Done") }]))
      .mockResolvedValueOnce(json({ refreshed: [{ object: chip("ENG-1", "Done", { nextRefreshAt }), refreshed: false, reason: "backoff" }] }));

    expect(await syncChips(ISSUE_ID, [{ identifier: "ENG-1", label: "In Progress" }], NOW)).toEqual({
      status: "pending",
      retryAt: NOW + 122_000
    });
  });

  it("falls back to the chip TTL when the host gives no next refresh time or no answer for a chip", async () => {
    fetchMock.mockResolvedValueOnce(json([{ object: chip("ENG-1", "Done") }])).mockResolvedValueOnce(json({ refreshed: [] }));

    expect(await syncChips(ISSUE_ID, [{ identifier: "ENG-1", label: "In Progress" }], NOW)).toEqual({
      status: "pending",
      retryAt: NOW + 302_000
    });
  });

  it("reports failure, never success, when the host cannot be asked", async () => {
    const stale = () => json([{ object: chip("ENG-1", "Done") }]);
    const expected = [{ identifier: "ENG-1", label: "In Progress" }];
    const cases: Array<Array<() => Response | Promise<Response>>> = [
      [() => json({ error: "unavailable" }, 503)],
      [() => Promise.reject(new Error("network down"))],
      [() => json({ not: "a list" })],
      [stale, () => json({ error: "unavailable" }, 503)],
      [stale, () => Promise.reject(new Error("network down"))],
      [stale, () => new Response("<html>", { status: 200 })],
      [stale, () => json({ refreshed: "nope" })]
    ];

    for (const responses of cases) {
      fetchMock.mockReset();
      for (const respond of responses) fetchMock.mockImplementationOnce(async () => respond());
      expect(await syncChips(ISSUE_ID, expected, NOW)).toEqual({ status: "failed" });
      expect(fetchMock).toHaveBeenCalledTimes(responses.length);
    }
  });

  it("only ever calls the two host chip routes for the task", async () => {
    fetchMock
      .mockResolvedValueOnce(json([{ object: chip("ENG-1", "Done") }]))
      .mockResolvedValueOnce(json({ refreshed: [{ object: chip("ENG-1", "Todo") }] }));

    await syncChips("issue/with space", [{ identifier: "ENG-1", label: "Todo" }], NOW);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      ["/api/issues/issue%2Fwith%20space/external-objects", "GET"],
      ["/api/issues/issue%2Fwith%20space/external-objects/refresh", "POST"]
    ]);
  });
});
