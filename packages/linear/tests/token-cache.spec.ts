import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { EnvSecretRefBinding, Issue, PluginExternalObjectRecordSnapshot } from "@paperclipai/plugin-sdk";
import { LINKED_ISSUES_DATA_KEY, SET_STATE_ACTION_KEY } from "../src/control.js";
import manifest from "../src/manifest.js";
import { TOKEN_CACHE_TTL_MS } from "../src/token-cache.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "company-1";
const SECRET_REF: EnvSecretRefBinding = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" };
const TODO = { id: "00000000-0000-4000-8000-000000000001", name: "Todo", type: "unstarted" };
const DONE = { id: "00000000-0000-4000-8000-000000000002", name: "Done", type: "completed" };

// Valid for both the status chip query and the manual control workflow query.
function issueResponse() {
  return new Response(JSON.stringify({
    data: {
      issue: {
        id: "10000000-0000-4000-8000-000000000001",
        identifier: "ENG-1",
        title: "Example issue",
        archivedAt: null,
        state: TODO,
        team: { states: { nodes: [TODO, DONE] } }
      }
    }
  }));
}

function resolve(companyId = COMPANY_ID) {
  return plugin.definition.onResolveExternalObject!({
    companyId,
    providerKey: "linear",
    objectType: "issue",
    externalId: "ENG-1",
    object: {} as PluginExternalObjectRecordSnapshot
  });
}

describe("worker token cache", () => {
  let harness: ReturnType<typeof createTestHarness>;
  let secret: ReturnType<typeof vi.spyOn>;
  let config: ReturnType<typeof vi.spyOn>;
  const fetchMock = vi.fn<typeof fetch>();

  function list() {
    return harness.getData(LINKED_ISSUES_DATA_KEY, { companyId: COMPANY_ID, issueId: "issue-1" });
  }

  function setState() {
    return harness.performAction(
      SET_STATE_ACTION_KEY,
      { issueId: "issue-1", identifier: "ENG-1", stateId: DONE.id },
      { actor: { type: "user", userId: "user-1" }, companyId: COMPANY_ID }
    );
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockImplementation(async () => issueResponse());
    vi.stubGlobal("fetch", fetchMock);
    harness = createTestHarness({ manifest, config: { linearApiKey: SECRET_REF } });
    harness.seed({ issues: [{
      id: "issue-1", companyId: COMPANY_ID, title: "Task", description: "https://linear.app/acme/issue/ENG-1"
    } as Issue] });
    secret = vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("test-token");
    config = vi.spyOn(harness.ctx.config, "get").mockResolvedValue({ linearApiKey: SECRET_REF });
    await plugin.definition.setup(harness.ctx);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares one resolve across repeated chip reads, control reads and mutations within the TTL", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const { query } = JSON.parse(init?.body as string);
      return query.startsWith("mutation")
        ? new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: { state: DONE } } } }))
        : issueResponse();
    });
    expect(await resolve()).toMatchObject({ ok: true });
    await list();
    expect(await setState()).toMatchObject({ ok: true });
    vi.advanceTimersByTime(TOKEN_CACHE_TTL_MS - 1);
    await resolve();
    expect(secret).toHaveBeenCalledTimes(1);
    expect(secret).toHaveBeenCalledWith(SECRET_REF, { companyId: COMPANY_ID, configPath: "linearApiKey" });
  });

  it("resolves again when the five-minute TTL expires", async () => {
    await resolve();
    vi.advanceTimersByTime(TOKEN_CACHE_TTL_MS);
    await list();
    expect(secret).toHaveBeenCalledTimes(2);
  });

  it("misses for another company, secret id or version without a config event", async () => {
    await resolve();
    await resolve("company-2");
    config.mockResolvedValue({ linearApiKey: { ...SECRET_REF, secretId: "22222222-2222-4222-8222-222222222222" } });
    await resolve();
    config.mockResolvedValue({ linearApiKey: { ...SECRET_REF, version: 2 } });
    await resolve();
    expect(secret).toHaveBeenCalledTimes(4);
  });

  it.each([401, 403])("evicts on chip HTTP %s so the next control call resolves the rotated token", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    expect(await resolve()).toMatchObject({ ok: false, liveness: "auth_required" });
    secret.mockResolvedValue("rotated-test-token");
    await list();
    expect(secret).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ authorization: "rotated-test-token" });
  });

  it.each([401, 403])("evicts on control read HTTP %s so the next chip call resolves again", async (status) => {
    await resolve();
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    await list();
    await resolve();
    expect(secret).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("evicts on mutation HTTP %s without retrying the mutation", async (status) => {
    fetchMock.mockResolvedValueOnce(issueResponse()).mockResolvedValueOnce(new Response(null, { status }));
    expect(await setState()).toMatchObject({ ok: false, code: "auth_rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await resolve();
    expect(secret).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight resolve between parallel chip and control misses", async () => {
    let finish!: (token: string) => void;
    secret.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const requests = [resolve(), list(), resolve()];
    await vi.waitFor(() => expect(secret).toHaveBeenCalledTimes(1));
    finish("test-token");
    await Promise.all(requests);
    expect(secret).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed resolve or expose its error", async () => {
    secret.mockRejectedValueOnce(new Error("contains-test-token"));
    const result = await resolve();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("contains-test-token");
    expect(await resolve()).toMatchObject({ ok: true });
    expect(secret).toHaveBeenCalledTimes(2);
  });

  it("evicts only the company whose configuration changed", async () => {
    await resolve();
    await resolve("company-2");
    await plugin.definition.onConfigChanged!({}, { companyId: COMPANY_ID });
    await resolve("company-2");
    expect(secret).toHaveBeenCalledTimes(2);
    await list();
    expect(secret).toHaveBeenCalledTimes(3);
  });

  it.each([null, undefined])("evicts all companies for an unscoped config change (%s)", async (companyId) => {
    await resolve();
    await resolve("company-2");
    await plugin.definition.onConfigChanged!({}, companyId === undefined ? undefined : { companyId });
    await resolve();
    await resolve("company-2");
    expect(secret).toHaveBeenCalledTimes(4);
  });

  it("does not let a late 401 evict a fresh entry", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const oldRequest = resolve();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(TOKEN_CACHE_TTL_MS);
    await resolve();
    finish(new Response(null, { status: 401 }));
    await oldRequest;
    await list();
    expect(secret).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate an invalidated entry when its pending resolve finishes", async () => {
    let finish!: (token: string) => void;
    secret.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const oldRequest = resolve();
    await vi.waitFor(() => expect(secret).toHaveBeenCalledTimes(1));
    await plugin.definition.onConfigChanged!({}, { companyId: COMPANY_ID });
    await resolve();
    finish("old-test-token");
    await oldRequest;
    await list();
    expect(secret).toHaveBeenCalledTimes(2);
  });
});
