import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginExternalObjectRecordSnapshot } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { LINEAR_ISSUE_QUERY } from "../src/providers/linear.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "company-1";
const LINEAR_TOKEN = "linear-token-s3cr3t";
const SECRET_CONFIG = {
  linearApiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" }
};

function candidate(url: string) {
  return {
    sanitizedCanonicalUrl: url,
    sanitizedDisplayUrl: url,
    canonicalIdentityHash: `hash:${url}`,
    canonicalIdentity: {},
    redactedMatchedText: url
  };
}

async function detect(urls: string[]) {
  const result = await plugin.definition.onDetectExternalObjects!({
    companyId: COMPANY_ID,
    urls: urls.map(candidate),
    sourceContext: {
      companyId: COMPANY_ID,
      sourceIssueId: "issue-1",
      sourceKind: "description",
      sourceRecordId: null,
      documentKey: null,
      propertyKey: null
    }
  });
  return result.detections;
}

function resolve(providerKey: string, objectType: string, externalId: string) {
  return plugin.definition.onResolveExternalObject!({
    companyId: COMPANY_ID,
    providerKey,
    objectType,
    externalId,
    object: {} as PluginExternalObjectRecordSnapshot
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

describe("manifest", () => {
  it("has the Linear plugin identity and a single setting", () => {
    expect(manifest.id).toBe("llwt.paperclip-linear");
    expect(manifest.displayName).toBe("Linear");
    expect(manifest.capabilities).toEqual([
      "external.objects.detect",
      "external.objects.read",
      "http.outbound",
      "secrets.read-ref"
    ]);
    expect(Object.keys(manifest.instanceConfigSchema?.properties ?? {})).toEqual(["linearApiKey"]);
  });

  // Paperclip validates saved settings with Ajv, treating `secret-ref` as a
  // UI hint only, so the declared type has to match the saved binding object.
  it("accepts the secret binding the settings form saves", () => {
    const ajv = new Ajv({ allErrors: true });
    ajv.addFormat("secret-ref", { validate: () => true });
    const validate = ajv.compile(manifest.instanceConfigSchema ?? {});

    expect(validate(SECRET_CONFIG)).toBe(true);
    expect(validate({ linearApiKey: { ...SECRET_CONFIG.linearApiKey, version: "latest" } })).toBe(true);
    expect(validate({})).toBe(true);
  });

  it("declares detect and read for Linear only", () => {
    expect(manifest.capabilities).toContain("external.objects.detect");
    expect(manifest.capabilities).toContain("external.objects.read");
    expect(manifest.objectReferences?.map((entry) => entry.providerKey)).toEqual(["linear"]);
  });

  it("stays read-only", () => {
    expect(manifest.capabilities).not.toContain("external.objects.write");
    expect(manifest.capabilities.filter((capability) => /\.(write|create|update)$/.test(capability))).toEqual([]);
  });
});

describe("onDetectExternalObjects", () => {
  it("detects Linear issue links", async () => {
    const url = "https://linear.app/acme/issue/ENG-123/example-issue";
    expect(await detect([url])).toEqual([
      {
        urlIdentityHash: `hash:${url}`,
        providerKey: "linear",
        iconKey: "linear",
        confidence: "exact",
        objectType: "issue",
        externalId: "ENG-123",
        displayKey: "ENG-123",
        displayTitle: "ENG-123"
      }
    ]);
  });

  it("normalizes the Linear identifier and accepts links without a slug", async () => {
    const [detection] = await detect(["https://linear.app/acme/issue/eng-123"]);
    expect(detection.externalId).toBe("ENG-123");
  });

  it("ignores other URLs, including non-issue Linear pages and Todoist task links", async () => {
    expect(
      await detect([
        "https://github.com/acme/widgets/pull/1",
        "https://linear.app/acme/project/some-project-abc123",
        "https://linear.app.evil.example/acme/issue/ENG-1",
        "https://app.todoist.com/app/task/8212345678",
        "https://app.usepylon.com/issues?issueNumber=1",
        "not a url"
      ])
    ).toEqual([]);
  });

  it("rejects non-HTTPS links", async () => {
    expect(
      await detect([
        "http://linear.app/acme/issue/ENG-1",
        "ftp://linear.app/acme/issue/ENG-1"
      ])
    ).toEqual([]);
  });
});

describe("onResolveExternalObject", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let harness: ReturnType<typeof createTestHarness>;
  let resolveSecret: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    harness = createTestHarness({ manifest, config: SECRET_CONFIG });
    resolveSecret = vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue(LINEAR_TOKEN);
    warn = vi.spyOn(harness.ctx.logger, "warn");
    await plugin.definition.setup(harness.ctx);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function linearIssue(
    state: { name: string; type: string },
    archivedAt: string | null = null,
    title: string | null = "Example issue"
  ) {
    return jsonResponse({
      data: { issue: { identifier: "ENG-123", title, archivedAt, state } }
    });
  }

  it("resolves a Linear issue with a read-only query", async () => {
    fetchMock.mockResolvedValue(linearIssue({ name: "In Progress", type: "started" }));

    const result = await resolve("linear", "issue", "ENG-123");

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        displayKey: "ENG-123",
        displayTitle: "Example issue",
        statusKey: "started",
        statusLabel: "In Progress",
        statusCategory: "running",
        statusTone: "info",
        isTerminal: false
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init?.headers as Record<string, string>).authorization).toBe(LINEAR_TOKEN);
    const body = JSON.parse(init?.body as string);
    expect(body.variables).toEqual({ id: "ENG-123" });
    expect(body.query.trimStart().startsWith("query")).toBe(true);
    expect(body.query).not.toMatch(/mutation/i);
  });

  it.each([
    ["triage", "open", "neutral", "clock", false],
    ["backlog", "open", "neutral", "circle", false],
    ["unstarted", "open", "neutral", "circle", false],
    ["started", "running", "info", "loader", false],
    ["completed", "succeeded", "success", "check-circle", true],
    ["canceled", "closed", "muted", "x-circle", true],
    ["something-new", "unknown", "neutral", "circle", false]
  ])("maps Linear state type %s to %s", async (type, statusCategory, statusTone, statusIconKey, isTerminal) => {
    fetchMock.mockResolvedValue(linearIssue({ name: "State", type }));
    expect(await resolve("linear", "issue", "ENG-123")).toMatchObject({
      ok: true,
      snapshot: {
        displayKey: "ENG-123",
        displayTitle: "Example issue",
        statusKey: type,
        statusLabel: "State",
        statusCategory,
        statusTone,
        statusIconKey,
        isTerminal
      }
    });
  });

  // The host shows `displayKey` in the first column and builds the second from
  // `displayTitle` and the status label, so the identifier must not repeat.
  it("sends the identifier as the key and the issue title alone as the title", async () => {
    fetchMock.mockResolvedValue(linearIssue({ name: "Todo", type: "unstarted" }));
    const result = await resolve("linear", "issue", "ENG-123");
    expect(result).toMatchObject({
      ok: true,
      snapshot: { displayKey: "ENG-123", displayTitle: "Example issue", statusLabel: "Todo" }
    });
    expect(result.ok && result.snapshot.displayTitle).not.toContain("ENG-123");
  });

  // The host renders an empty `displayTitle` as is and falls back to the link
  // URL when it is missing, so the identifier stands in for an absent title.
  it.each([
    ["null", null],
    ["empty", ""],
    ["blank", "   "]
  ])("falls back to the identifier when the issue title is %s", async (_label, title) => {
    fetchMock.mockResolvedValue(linearIssue({ name: "Todo", type: "unstarted" }, null, title));
    expect(await resolve("linear", "issue", "ENG-123")).toMatchObject({
      ok: true,
      snapshot: { displayKey: "ENG-123", displayTitle: "ENG-123" }
    });
  });

  it("renders an archived Linear issue as terminal Archived, not its workflow state", async () => {
    fetchMock.mockResolvedValue(linearIssue({ name: "In Progress", type: "started" }, "2026-01-01T00:00:00.000Z"));
    expect(await resolve("linear", "issue", "ENG-123")).toMatchObject({
      ok: true,
      snapshot: {
        displayKey: "ENG-123",
        displayTitle: "Example issue",
        statusKey: "archived",
        statusLabel: "Archived",
        statusIconKey: "archive",
        statusCategory: "archived",
        statusTone: "muted",
        isTerminal: true,
        data: { stateType: "started", archived: true }
      }
    });
  });

  it("reports a confirmed missing Linear issue as not found", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: null,
        errors: [
          {
            message: "Entity not found: Issue",
            path: ["issue"],
            extensions: { type: "invalid input", code: "INPUT_ERROR" }
          }
        ]
      })
    );
    expect(await resolve("linear", "issue", "ENG-999")).toMatchObject({
      ok: true,
      snapshot: {
        displayKey: "ENG-999",
        displayTitle: "ENG-999",
        statusKey: "not_found",
        statusLabel: "Not found",
        statusIconKey: "archive",
        statusCategory: "archived",
        statusTone: "muted",
        isTerminal: true
      }
    });
  });

  it.each([
    ["an internal error", { data: null, errors: [{ message: "boom", extensions: { code: "INTERNAL_SERVER_ERROR" } }] }],
    ["an unrelated input error", { data: null, errors: [{ message: "Bad argument", extensions: { code: "INPUT_ERROR" } }] }],
    ["an error without extensions", { errors: [{ message: "Entity not found: Issue", path: ["issue"] }] }],
    ["mixed errors", {
      errors: [
        { message: "Entity not found: Issue", path: ["issue"], extensions: { code: "INPUT_ERROR" } },
        { message: "boom", extensions: { code: "INTERNAL_SERVER_ERROR" } }
      ]
    }],
    ["a nested not-found error with a partially returned issue", {
      data: { issue: { identifier: "ENG-123", title: "Example issue", archivedAt: null, state: null } },
      errors: [
        {
          message: "Entity not found: WorkflowState",
          path: ["issue", "state"],
          extensions: { type: "invalid input", code: "INPUT_ERROR" }
        }
      ]
    }],
    ["a nested not-found error with null bubbling to the issue", {
      data: { issue: null },
      errors: [
        {
          message: "Entity not found: WorkflowState",
          path: ["issue", "state"],
          extensions: { type: "invalid input", code: "INPUT_ERROR" }
        }
      ]
    }],
    ["a nested not-found error with null bubbling to data", {
      data: null,
      errors: [
        {
          message: "Entity not found: WorkflowState",
          path: ["issue", "state"],
          extensions: { type: "invalid input", code: "INPUT_ERROR" }
        }
      ]
    }],
    ["a nested error that names Issue", {
      data: null,
      errors: [{ message: "Entity not found: Issue", path: ["issue", "state"], extensions: { code: "INPUT_ERROR" } }]
    }],
    ["a root error that names another entity", {
      data: null,
      errors: [{ message: "Entity not found: WorkflowState", path: ["issue"], extensions: { code: "INPUT_ERROR" } }]
    }],
    ["a root error that names an Issue-prefixed entity", {
      data: null,
      errors: [{ message: "Entity not found: IssueLabel", path: ["issue"], extensions: { code: "INPUT_ERROR" } }]
    }],
    ["a not-found error without a path", {
      data: null,
      errors: [{ message: "Entity not found: Issue", extensions: { type: "invalid input", code: "INPUT_ERROR" } }]
    }],
    ["a root not-found error alongside a returned issue", {
      data: { issue: { identifier: "ENG-123", title: "Example issue", archivedAt: null, state: { name: "Todo", type: "unstarted" } } },
      errors: [{ message: "Entity not found: Issue", path: ["issue"], extensions: { code: "INPUT_ERROR" } }]
    }]
  ])("keeps %s from Linear as a retryable failure", async (_name, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));
    expect(await resolve("linear", "issue", "ENG-123")).toEqual({
      ok: false,
      liveness: "unreachable",
      errorCode: "linear_graphql_error",
      errorMessage: "linear API returned a GraphQL error"
    });
  });

  it("reports Linear GraphQL rate limiting", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }] })
    );
    expect(await resolve("linear", "issue", "ENG-123")).toMatchObject({
      ok: false,
      liveness: "unreachable",
      errorCode: "linear_rate_limited"
    });
  });

  it.each([
    ["an empty object", {}],
    ["null data", { data: null }],
    ["a null issue", { data: { issue: null } }],
    ["an empty errors array", { errors: [] }],
    ["an issue without a state", { data: { issue: { identifier: "ENG-123", title: "x", archivedAt: null } } }],
    ["a non-string state type", {
      data: { issue: { identifier: "ENG-123", title: "x", archivedAt: null, state: { name: "Done", type: 1 } } }
    }],
    ["a malformed identifier", {
      data: { issue: { identifier: 281, title: "x", archivedAt: null, state: { name: "Done", type: "completed" } } }
    }],
    ["a non-string archivedAt", {
      data: { issue: { identifier: "ENG-123", title: "x", archivedAt: true, state: { name: "Done", type: "completed" } } }
    }]
  ])("fails on malformed Linear data: %s", async (_name, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));
    expect(await resolve("linear", "issue", "ENG-123")).toEqual({
      ok: false,
      liveness: "unreachable",
      errorCode: "linear_malformed_response",
      errorMessage: "linear API returned an unexpected response"
    });
  });

  it("fails on a non-JSON body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));
    expect(await resolve("linear", "issue", "ENG-123")).toMatchObject({ ok: false, errorCode: "linear_malformed_response" });
  });

  it("reports Linear auth failures", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [] }, 401));
    expect(await resolve("linear", "issue", "ENG-123")).toMatchObject({
      ok: false,
      liveness: "auth_required",
      errorCode: "linear_auth_required"
    });

    fetchMock.mockResolvedValue(
      jsonResponse({ errors: [{ message: "nope", extensions: { code: "AUTHENTICATION_ERROR" } }] })
    );
    expect(await resolve("linear", "issue", "ENG-123")).toMatchObject({ ok: false, liveness: "auth_required" });
  });

  describe("credential redaction", () => {
    it("never returns upstream GraphQL error text", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          errors: [
            {
              message: `Authentication failed for key ${LINEAR_TOKEN}`,
              extensions: { code: "AUTHENTICATION_ERROR", userPresentableMessage: `Bad key ${LINEAR_TOKEN}` }
            }
          ]
        })
      );
      const result = await resolve("linear", "issue", "ENG-123");
      expect(result).toEqual({
        ok: false,
        liveness: "auth_required",
        errorCode: "linear_auth_required",
        errorMessage: "linear rejected the configured credential"
      });

      fetchMock.mockResolvedValue(
        jsonResponse({ errors: [{ message: `boom ${LINEAR_TOKEN}`, extensions: { code: `X ${LINEAR_TOKEN}` } }] })
      );
      expect(JSON.stringify(await resolve("linear", "issue", "ENG-123"))).not.toContain(LINEAR_TOKEN);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(LINEAR_TOKEN);
    });

    it("never logs or returns transport error text", async () => {
      fetchMock.mockRejectedValue(new Error(`request failed: authorization: Bearer ${LINEAR_TOKEN}`));

      const result = await resolve("linear", "issue", "ENG-123");

      expect(result).toEqual({
        ok: false,
        liveness: "unreachable",
        errorCode: "linear_unreachable",
        errorMessage: "linear request failed"
      });
      expect(warn.mock.calls).toEqual([["External object resolve failed", { providerKey: "linear" }]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(LINEAR_TOKEN);
    });

    it("never logs secret resolution error text", async () => {
      resolveSecret.mockRejectedValue(new Error(`cannot resolve ${LINEAR_TOKEN}`));
      const result = await resolve("linear", "issue", "ENG-123");
      expect(JSON.stringify(result)).not.toContain(LINEAR_TOKEN);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(LINEAR_TOKEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("resolve boundary", () => {
    it.each([
      ["linear", "issue", "ENG-123\" }"],
      ["linear", "issue", "eng-123"],
      ["linear", "issue", "not-an-id"],
      ["linear", "project", "ENG-123"]
    ])("rejects %s %s %j before resolving a secret or calling the API", async (providerKey, objectType, externalId) => {
      expect(await resolve(providerKey, objectType, externalId)).toEqual({
        ok: false,
        liveness: "unreachable",
        errorCode: "linear_invalid_reference",
        errorMessage: "Not a valid linear issue reference"
      });
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ["pylon", "issue", "1"],
      ["todoist", "task", "8212345678"]
    ])("rejects the unknown provider %s", async (providerKey, objectType, externalId) => {
      expect(await resolve(providerKey, objectType, externalId)).toEqual({
        ok: false,
        liveness: "unreachable",
        errorCode: "unsupported_provider"
      });
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("reports outages as unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    expect(await resolve("linear", "issue", "ENG-123")).toEqual({
      ok: false,
      liveness: "unreachable",
      errorCode: "linear_unreachable",
      errorMessage: "linear request failed"
    });
  });

  it("asks for a credential instead of calling the API when no secret is bound", async () => {
    const unbound = createTestHarness({ manifest, config: {} });
    await plugin.definition.setup(unbound.ctx);

    expect(await resolve("linear", "issue", "ENG-123")).toMatchObject({
      ok: false,
      liveness: "auth_required",
      errorCode: "linear_auth_required"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The plugin must not be able to write, even with a Read and Write key.
  it("only ever sends the one fixed GraphQL query document to Linear", async () => {
    expect(LINEAR_ISSUE_QUERY).toMatch(/^query\s/);
    expect(LINEAR_ISSUE_QUERY).not.toMatch(/\b(mutation|subscription)\b/i);
    expect(LINEAR_ISSUE_QUERY.match(/\b(query|mutation|subscription)\b/gi)).toHaveLength(1);

    const notFound = {
      data: null,
      errors: [{ message: "Entity not found: Issue", path: ["issue"], extensions: { code: "INPUT_ERROR" } }]
    };
    const responses = [
      () => linearIssue({ name: "Done", type: "completed" }),
      () => linearIssue({ name: "In Progress", type: "started" }, "2026-01-01T00:00:00.000Z"),
      () => jsonResponse(notFound),
      () => jsonResponse({ errors: [{ message: "boom", extensions: { code: "INTERNAL_SERVER_ERROR" } }] }),
      () => jsonResponse({ errors: [] }, 401),
      () => new Response("", { status: 429 }),
      () => new Response("<html>", { status: 200 })
    ];
    for (const [index, respond] of responses.entries()) {
      fetchMock.mockResolvedValueOnce(respond());
      await resolve("linear", "issue", `CS-${index + 1}`);
    }

    expect(fetchMock).toHaveBeenCalledTimes(responses.length);
    for (const [index, [url, init]] of fetchMock.mock.calls.entries()) {
      expect(url).toBe("https://api.linear.app/graphql");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({
        query: LINEAR_ISSUE_QUERY,
        variables: { id: `CS-${index + 1}` }
      });
    }
  });
});
