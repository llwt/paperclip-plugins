import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueComment } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import {
  LINEAR_SET_STATE_MUTATION,
  LINEAR_WORKFLOW_QUERY,
  LINKED_ISSUES_DATA_KEY,
  MAX_LINKED_ISSUES,
  SET_STATE_ACTION_KEY,
  linearIdentifiersIn,
  type LinkedIssuesResult,
  type SetStateResult
} from "../src/control.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "company-1";
const ISSUE_ID = "issue-1";
const LINEAR_TOKEN = "linear-token-s3cr3t";
const SECRET_CONFIG = {
  linearApiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" }
};
const USER = { actor: { type: "user", userId: "user-1" }, companyId: COMPANY_ID } as const;

const TODO = { id: "00000000-0000-4000-8000-000000000001", name: "Todo", type: "unstarted" };
const IN_PROGRESS = { id: "00000000-0000-4000-8000-000000000002", name: "In Progress", type: "started" };
const DONE = { id: "00000000-0000-4000-8000-000000000003", name: "Done", type: "completed" };
const OTHER_TEAM_STATE = "00000000-0000-4000-8000-0000000000ff";
// Returned out of order on purpose: the control lists them in workflow order.
const TEAM_STATES = [
  { ...DONE, position: 2 },
  { ...TODO, position: 0 },
  { ...IN_PROGRESS, position: 1 }
];

function linearUuid(identifier: string) {
  return `10000000-0000-4000-8000-${identifier.replace(/\D/g, "").padStart(12, "0")}`;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function workflowResponse(identifier: string, state = TODO, archivedAt: string | null = null) {
  return jsonResponse({
    data: {
      issue: { id: linearUuid(identifier), identifier, archivedAt, state, team: { states: { nodes: TEAM_STATES } } }
    }
  });
}

function updateResponse(identifier: string, state: typeof TODO, success = true) {
  return jsonResponse({ data: { issueUpdate: { success, issue: { identifier, state } } } });
}

const NOT_FOUND = {
  data: null,
  errors: [{ message: "Entity not found: Issue", path: ["issue"], extensions: { code: "INPUT_ERROR" } }]
};

describe("linearIdentifiersIn", () => {
  it("finds each linked issue once, in order, and ignores other links", () => {
    expect(
      linearIdentifiersIn(
        [
          "See https://linear.app/acme/issue/ENG-2/second, then (https://linear.app/acme/issue/eng-1).",
          "[again](https://linear.app/acme/issue/ENG-2/second) and http://linear.app/acme/issue/ENG-9",
          "https://linear.app/acme/project/roadmap https://evil.example/linear.app/acme/issue/ENG-8",
          "ENG-7 on its own is not a link"
        ].join("\n")
      )
    ).toEqual(["ENG-2", "ENG-1"]);
  });
});

describe("manual status control", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let harness: ReturnType<typeof createTestHarness>;
  let resolveSecret: ReturnType<typeof vi.spyOn>;

  function seedTask(description: string, comments: string[] = []) {
    harness.seed({
      issues: [{ id: ISSUE_ID, companyId: COMPANY_ID, title: "Task", description } as Issue],
      issueComments: comments.map(
        (body, index) => ({ id: `comment-${index}`, issueId: ISSUE_ID, companyId: COMPANY_ID, body }) as IssueComment
      )
    });
  }

  function list(issueId = ISSUE_ID) {
    return harness.getData<LinkedIssuesResult>(LINKED_ISSUES_DATA_KEY, { issueId, companyId: COMPANY_ID });
  }

  function setState(identifier: string, stateId: string, options: Parameters<typeof harness.performAction>[2] = USER) {
    return harness.performAction<SetStateResult>(
      SET_STATE_ACTION_KEY,
      { issueId: ISSUE_ID, identifier, stateId },
      options
    );
  }

  function sentBodies() {
    return fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
  }

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    harness = createTestHarness({ manifest, config: SECRET_CONFIG });
    resolveSecret = vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue(LINEAR_TOKEN);
    await plugin.definition.setup(harness.ctx);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("listing", () => {
    it("lists every Linear issue linked in the description and comments with its own state", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1/one and https://linear.app/acme/issue/ENG-2/two", [
        "see https://linear.app/acme/issue/OPS-3",
        "https://linear.app/acme/issue/ENG-1/one again"
      ]);
      fetchMock.mockImplementation(async (_url, init) => {
        const { variables } = JSON.parse(init?.body as string);
        return workflowResponse(variables.id, variables.id === "ENG-2" ? IN_PROGRESS : TODO);
      });

      const result = await list();

      expect(result.truncated).toBe(false);
      expect(result.issues).toEqual([
        { identifier: "ENG-1", status: "ok", state: TODO, states: [TODO, IN_PROGRESS, DONE] },
        { identifier: "ENG-2", status: "ok", state: IN_PROGRESS, states: [TODO, IN_PROGRESS, DONE] },
        { identifier: "OPS-3", status: "ok", state: TODO, states: [TODO, IN_PROGRESS, DONE] }
      ]);
      expect(sentBodies()).toEqual(
        ["ENG-1", "ENG-2", "OPS-3"].map((id) => ({ query: LINEAR_WORKFLOW_QUERY, variables: { id } }))
      );
    });

    it("shows archived and missing issues without a state to pick", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1 https://linear.app/acme/issue/ENG-2");
      fetchMock
        .mockResolvedValueOnce(workflowResponse("ENG-1", DONE, "2026-01-01T00:00:00.000Z"))
        .mockResolvedValueOnce(jsonResponse(NOT_FOUND));

      expect((await list()).issues).toEqual([
        {
          identifier: "ENG-1",
          status: "unavailable",
          code: "archived",
          message: "Archived in Linear, so its state cannot be changed here"
        },
        { identifier: "ENG-2", status: "unavailable", code: "not_found", message: "Not found in Linear" }
      ]);
    });

    it("makes no Linear call for a task without Linear links, an unknown task or an unbound secret", async () => {
      seedTask("no links here, only https://github.com/acme/widgets/pull/1");
      expect(await list()).toEqual({ issues: [], truncated: false });
      expect(await list("missing-issue")).toEqual({ issues: [], truncated: false });

      seedTask("https://linear.app/acme/issue/ENG-1");
      harness.setConfig({});
      expect((await list()).issues).toEqual([
        {
          identifier: "ENG-1",
          status: "unavailable",
          code: "auth_required",
          message: "Bind a Linear API key with write scope in the plugin settings"
        }
      ]);
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("bounds how many linked issues one task can make it read", async () => {
      const links = Array.from({ length: MAX_LINKED_ISSUES + 3 }, (_, index) => `https://linear.app/acme/issue/ENG-${index + 1}`);
      seedTask(links.join("\n"));
      fetchMock.mockImplementation(async (_url, init) => workflowResponse(JSON.parse(init?.body as string).variables.id));

      const result = await list();

      expect(result.truncated).toBe(true);
      expect(result.issues).toHaveLength(MAX_LINKED_ISSUES);
      expect(fetchMock).toHaveBeenCalledTimes(MAX_LINKED_ISSUES);
    });

    it("reports a failed read with fixed text and no retry", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");
      const warn = vi.spyOn(harness.ctx.logger, "warn");
      fetchMock.mockRejectedValue(new Error(`request failed: authorization: ${LINEAR_TOKEN}`));

      const result = await list();

      expect(result.issues).toEqual([
        { identifier: "ENG-1", status: "unavailable", code: "error", message: "Linear request failed" }
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([result, warn.mock.calls, harness.logs])).not.toContain(LINEAR_TOKEN);
    });
  });

  describe("changing a state", () => {
    it("changes the picked issue with one read and one mutation", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1/one");
      fetchMock.mockResolvedValueOnce(workflowResponse("ENG-1", TODO)).mockResolvedValueOnce(updateResponse("ENG-1", DONE));

      expect(await setState("ENG-1", DONE.id)).toEqual({ ok: true, identifier: "ENG-1", state: DONE, changed: true });

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://api.linear.app/graphql",
        "https://api.linear.app/graphql"
      ]);
      expect(fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).authorization)).toEqual([
        LINEAR_TOKEN,
        LINEAR_TOKEN
      ]);
      expect(sentBodies()).toEqual([
        { query: LINEAR_WORKFLOW_QUERY, variables: { id: "ENG-1" } },
        { query: LINEAR_SET_STATE_MUTATION, variables: { id: linearUuid("ENG-1"), stateId: DONE.id } }
      ]);
    });

    it("changes only the picked issue on a task with several links", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1 https://linear.app/acme/issue/ENG-2", [
        "https://linear.app/acme/issue/OPS-3"
      ]);
      fetchMock
        .mockResolvedValueOnce(workflowResponse("ENG-2", TODO))
        .mockResolvedValueOnce(updateResponse("ENG-2", IN_PROGRESS));

      expect(await setState("ENG-2", IN_PROGRESS.id)).toMatchObject({ ok: true, identifier: "ENG-2", changed: true });

      const bodies = sentBodies();
      expect(bodies).toHaveLength(2);
      expect(bodies.filter((body) => body.query === LINEAR_SET_STATE_MUTATION)).toEqual([
        { query: LINEAR_SET_STATE_MUTATION, variables: { id: linearUuid("ENG-2"), stateId: IN_PROGRESS.id } }
      ]);
      expect(JSON.stringify(bodies)).not.toMatch(/ENG-1|OPS-3/);
    });

    it("accepts an issue that is linked only in a comment", async () => {
      seedTask("no link", ["https://linear.app/acme/issue/OPS-3/in-a-comment"]);
      fetchMock.mockResolvedValueOnce(workflowResponse("OPS-3", TODO)).mockResolvedValueOnce(updateResponse("OPS-3", DONE));

      expect(await setState("OPS-3", DONE.id)).toMatchObject({ ok: true, changed: true });
    });

    it("refuses an issue that is not linked on the task, before any secret or request", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");

      expect(await setState("ENG-2", DONE.id)).toEqual({
        ok: false,
        code: "not_linked",
        message: "That Linear issue is not linked on this task"
      });
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a task from another company", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");

      expect(await setState("ENG-1", DONE.id, { ...USER, companyId: "company-2" })).toMatchObject({
        ok: false,
        code: "not_linked"
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses agents and system callers", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");

      for (const actor of [{ type: "agent", agentId: "agent-1" }, { type: "system" }] as const) {
        expect(await setState("ENG-1", DONE.id, { actor, companyId: COMPANY_ID })).toEqual({
          ok: false,
          code: "not_user",
          message: "Only a board user can change a Linear issue state"
        });
      }
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses malformed requests without calling Linear", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");

      expect(await setState("ENG-1", "not-a-state-id")).toMatchObject({ ok: false, code: "invalid_request" });
      expect(await setState('ENG-1") { id } }', DONE.id)).toMatchObject({ ok: false, code: "invalid_request" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an archived issue without sending a mutation", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");
      fetchMock.mockResolvedValueOnce(workflowResponse("ENG-1", TODO, "2026-01-01T00:00:00.000Z"));

      expect(await setState("ENG-1", DONE.id)).toEqual({
        ok: false,
        code: "archived",
        message: "Archived in Linear, so its state cannot be changed here"
      });
      expect(sentBodies()).toEqual([{ query: LINEAR_WORKFLOW_QUERY, variables: { id: "ENG-1" } }]);
    });

    it("refuses a missing issue without sending a mutation", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");
      fetchMock.mockResolvedValueOnce(jsonResponse(NOT_FOUND));

      expect(await setState("ENG-1", DONE.id)).toEqual({ ok: false, code: "not_found", message: "Not found in Linear" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refuses a state from outside the issue's team workflow", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");
      fetchMock.mockResolvedValueOnce(workflowResponse("ENG-1", TODO));

      expect(await setState("ENG-1", OTHER_TEAM_STATE)).toMatchObject({ ok: false, code: "invalid_state" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends no mutation when the issue is already in the picked state", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");
      fetchMock.mockResolvedValueOnce(workflowResponse("ENG-1", DONE));

      expect(await setState("ENG-1", DONE.id)).toEqual({ ok: true, identifier: "ENG-1", state: DONE, changed: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports a failed Linear call with fixed text and no retry", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");
      const warn = vi.spyOn(harness.ctx.logger, "warn");
      const failures: Array<[() => Response | Promise<Response>, string, string]> = [
        [() => Promise.reject(new Error(`socket closed: ${LINEAR_TOKEN}`)), "error", "Linear request failed"],
        [() => new Response(`upstream ${LINEAR_TOKEN}`, { status: 502 }), "error", "Linear request failed"],
        [() => new Response("<html>", { status: 200 }), "error", "Linear request failed"],
        [
          () => jsonResponse({ errors: [{ message: `boom ${LINEAR_TOKEN}`, extensions: { code: "INTERNAL_SERVER_ERROR" } }] }),
          "error",
          "Linear request failed"
        ],
        [
          () => jsonResponse({ errors: [{ message: `no write scope ${LINEAR_TOKEN}`, extensions: { code: "FORBIDDEN" } }] }),
          "auth_rejected",
          "Linear rejected the configured credential"
        ],
        [() => updateResponse("ENG-1", DONE, false), "update_failed", "Linear did not apply the change"],
        [() => updateResponse("ENG-1", TODO), "update_failed", "Linear did not apply the change"]
      ];

      for (const [respond, code, message] of failures) {
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(workflowResponse("ENG-1", TODO)).mockImplementationOnce(async () => respond());

        const result = await setState("ENG-1", DONE.id);

        expect(result).toEqual({ ok: false, code, message });
        // One read and one mutation attempt. A failure is never retried.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(result)).not.toContain(LINEAR_TOKEN);
      }
      expect(JSON.stringify([warn.mock.calls, harness.logs])).not.toContain(LINEAR_TOKEN);
    });

    it("never logs or returns secret resolution error text", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");
      resolveSecret.mockRejectedValue(new Error(`cannot resolve ${LINEAR_TOKEN}`));

      const result = await setState("ENG-1", DONE.id);

      expect(result).toEqual({ ok: false, code: "error", message: "Linear request failed" });
      expect(JSON.stringify(harness.logs)).not.toContain(LINEAR_TOKEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("asks for a credential instead of calling Linear when no secret is bound", async () => {
      seedTask("https://linear.app/acme/issue/ENG-1");
      harness.setConfig({});

      expect(await setState("ENG-1", DONE.id)).toMatchObject({ ok: false, code: "auth_required" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // The control may write to Linear, but only through these two documents.
  it("only ever sends its one read query and its one mutation to Linear", async () => {
    expect(LINEAR_WORKFLOW_QUERY).toMatch(/^query\s/);
    expect(LINEAR_WORKFLOW_QUERY.match(/\b(query|mutation|subscription)\b/gi)).toHaveLength(1);
    expect(LINEAR_SET_STATE_MUTATION).toMatch(/^mutation\s/);
    expect(LINEAR_SET_STATE_MUTATION.match(/\b(query|mutation|subscription)\b/gi)).toHaveLength(1);
    // The mutation can only set a state: `stateId` is the single input field.
    expect(LINEAR_SET_STATE_MUTATION.match(/\b\w+(?=\()/g)).toEqual(["ManualStatusUpdate", "issueUpdate"]);
    expect(LINEAR_SET_STATE_MUTATION).toContain("input: { stateId: $stateId }");

    seedTask("https://linear.app/acme/issue/ENG-1 https://linear.app/acme/issue/ENG-2");
    fetchMock.mockImplementation(async (_url, init) => {
      const { query, variables } = JSON.parse(init?.body as string);
      return query === LINEAR_SET_STATE_MUTATION ? updateResponse("ENG-1", DONE) : workflowResponse(variables.id, TODO);
    });

    await list();
    await setState("ENG-1", DONE.id);
    await setState("ENG-2", OTHER_TEAM_STATE);
    await setState("ENG-9", DONE.id);
    await list();

    const bodies = sentBodies();
    expect(bodies.length).toBeGreaterThan(0);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://api.linear.app/graphql");
      expect(init?.method).toBe("POST");
    }
    for (const body of bodies) {
      expect([LINEAR_WORKFLOW_QUERY, LINEAR_SET_STATE_MUTATION]).toContain(body.query);
    }
    expect(bodies.filter((body) => body.query === LINEAR_SET_STATE_MUTATION)).toHaveLength(1);
  });
});
