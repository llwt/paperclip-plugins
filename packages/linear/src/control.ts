import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  classifyError,
  hasNoIssueData,
  ISSUE_IDENTIFIER,
  LINEAR_API_URL,
  linearProvider
} from "./providers/linear.js";
import { isRecord, readJson, type ProviderFetch } from "./providers/types.js";

// The manual status control. It lists the Linear issues linked on a task and
// changes the state of one of them when a board user picks another state.
// Nothing else in this plugin writes to Linear.

export const LINKED_ISSUES_DATA_KEY = "linked-issues";
export const SET_STATE_ACTION_KEY = "set-issue-state";

// The only two GraphQL documents the control sends: one read and one mutation.
export const LINEAR_WORKFLOW_QUERY = `query ManualStatusIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    archivedAt
    state { id name type }
    team { states(first: 100) { nodes { id name type position } } }
  }
}`;

export const LINEAR_SET_STATE_MUTATION = `mutation ManualStatusUpdate($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { identifier state { id name type } }
  }
}`;

// Linked issues are read a page at a time, which bounds the Linear calls one
// request can cause. Every linked issue is reachable through a later page.
export const LINKED_ISSUES_PAGE_SIZE = 25;

const LINEAR_LINK = /https:\/\/linear\.app\/[^\s<>()[\]"'`]+/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

// Every message shown or returned is one of these fixed strings. Upstream
// error text is never forwarded: it can echo the credential.
const MESSAGES = {
  auth_required: "Bind a Linear API key with write scope in the plugin settings",
  auth_rejected: "Linear rejected the configured credential",
  not_found: "Not found in Linear",
  archived: "Archived in Linear, so its state cannot be changed here",
  error: "Linear request failed",
  invalid_request: "Not a valid request",
  not_user: "Only a board user can change a Linear issue state",
  not_linked: "That Linear issue is not linked on this task",
  invalid_state: "That state is not in the issue's team workflow",
  update_failed: "Linear did not apply the change"
} as const;

type FailureCode = keyof typeof MESSAGES;

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

export type LinkedIssue =
  | { identifier: string; status: "ok"; state: WorkflowState; states: WorkflowState[] }
  | { identifier: string; status: "unavailable"; code: FailureCode; message: string };

export interface LinkedIssuesResult {
  /** One page of the task's linked issues, in order of first appearance. */
  issues: LinkedIssue[];
  /** How many Linear issues the task links in total. */
  total: number;
  /** Offset of the next page, or null when this is the last one. */
  nextOffset: number | null;
}

export type SetStateResult =
  | { ok: true; identifier: string; state: WorkflowState; changed: boolean }
  | { ok: false; code: FailureCode; message: string };

function failure(code: FailureCode): { ok: false; code: FailureCode; message: string } {
  return { ok: false, code, message: MESSAGES[code] };
}

function isSecretRef(value: unknown): value is { type: "secret_ref"; secretId: string } {
  return isRecord(value) && value.type === "secret_ref";
}

/** Linear issue identifiers linked in a text, in order of first appearance. */
export function linearIdentifiersIn(text: string): string[] {
  const identifiers: string[] = [];
  for (const match of text.matchAll(LINEAR_LINK)) {
    let url: URL;
    try {
      url = new URL(match[0].replace(/[.,;:!?*_]+$/, ""));
    } catch {
      continue;
    }
    const detection = linearProvider.detect(url);
    if (detection && !identifiers.includes(detection.externalId)) identifiers.push(detection.externalId);
  }
  return identifiers;
}

// The plugin is not given the links the host detected, so it reads the task's
// description and comments itself. Links that sit only in a task document are
// not seen. Returns null when the task does not exist in the company.
async function linkedIdentifiers(host: PluginContext, issueId: string, companyId: string): Promise<string[] | null> {
  const issue = await host.issues.get(issueId, companyId);
  if (!issue) return null;
  const comments = await host.issues.listComments(issueId, companyId);
  const texts = [issue.description ?? "", ...comments.map((comment) => comment.body ?? "")];
  return [...new Set(texts.flatMap(linearIdentifiersIn))];
}

function parseState(value: unknown): WorkflowState | null {
  if (!isRecord(value)) return null;
  const { id, name, type } = value;
  if (typeof id !== "string" || !UUID.test(id) || typeof name !== "string" || typeof type !== "string") return null;
  return { id, name, type };
}

function stateRank(type: string): number {
  const rank = STATE_TYPE_ORDER.indexOf(type);
  return rank === -1 ? STATE_TYPE_ORDER.length : rank;
}

type GraphQLOutcome = { kind: "data"; data: Record<string, unknown> } | { kind: "failure"; code: FailureCode };

// Sends one GraphQL document. Never retries.
async function sendGraphQL(
  fetch: ProviderFetch,
  token: string,
  query: string,
  variables: Record<string, string>
): Promise<GraphQLOutcome> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({ query, variables })
  });
  if (response.status === 401 || response.status === 403) return { kind: "failure", code: "auth_rejected" };
  if (!response.ok) return { kind: "failure", code: "error" };

  const body = await readJson(response);
  if (!isRecord(body)) return { kind: "failure", code: "error" };
  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors) || body.errors.length === 0) return { kind: "failure", code: "error" };
    const kinds = body.errors.map(classifyError);
    if (kinds.includes("auth")) return { kind: "failure", code: "auth_rejected" };
    if (kinds.every((kind) => kind === "not_found") && hasNoIssueData(body.data)) {
      return { kind: "failure", code: "not_found" };
    }
    return { kind: "failure", code: "error" };
  }
  if (!isRecord(body.data)) return { kind: "failure", code: "error" };
  return { kind: "data", data: body.data };
}

type Workflow =
  | { kind: "ok"; id: string; identifier: string; state: WorkflowState; states: WorkflowState[] }
  | { kind: "failure"; code: FailureCode };

async function readWorkflow(fetch: ProviderFetch, token: string, identifier: string): Promise<Workflow> {
  const outcome = await sendGraphQL(fetch, token, LINEAR_WORKFLOW_QUERY, { id: identifier });
  if (outcome.kind === "failure") return outcome;

  const issue = outcome.data.issue;
  if (!isRecord(issue) || typeof issue.id !== "string" || !UUID.test(issue.id)) return { kind: "failure", code: "error" };
  if (issue.archivedAt !== null && typeof issue.archivedAt !== "string") return { kind: "failure", code: "error" };
  if (issue.archivedAt !== null) return { kind: "failure", code: "archived" };

  const state = parseState(issue.state);
  const nodes = isRecord(issue.team) && isRecord(issue.team.states) ? issue.team.states.nodes : null;
  if (!state || !Array.isArray(nodes)) return { kind: "failure", code: "error" };
  const states: Array<WorkflowState & { position: number }> = [];
  for (const node of nodes) {
    const parsed = parseState(node);
    if (!parsed) return { kind: "failure", code: "error" };
    const position = isRecord(node) && typeof node.position === "number" ? node.position : 0;
    states.push({ ...parsed, position });
  }
  states.sort((a, b) => stateRank(a.type) - stateRank(b.type) || a.position - b.position);

  return {
    kind: "ok",
    id: issue.id,
    identifier,
    state,
    states: states.map(({ id, name, type }) => ({ id, name, type }))
  };
}

// Resolved per call and never cached or logged. Returns null when no secret
// is bound.
async function resolveToken(host: PluginContext, companyId: string): Promise<string | null> {
  const config = await host.config.get(companyId);
  const secretRef = config[linearProvider.configKey];
  if (!isSecretRef(secretRef)) return null;
  return host.secrets.resolve(secretRef, { companyId, configPath: linearProvider.configKey });
}

async function listLinkedIssues(host: PluginContext, params: Record<string, unknown>): Promise<LinkedIssuesResult> {
  const { issueId, companyId } = params;
  const empty: LinkedIssuesResult = { issues: [], total: 0, nextOffset: null };
  if (typeof issueId !== "string" || typeof companyId !== "string") return empty;
  const offset = typeof params.offset === "number" && Number.isInteger(params.offset) && params.offset > 0 ? params.offset : 0;

  const linked = await linkedIdentifiers(host, issueId, companyId);
  if (!linked) return empty;
  const identifiers = linked.slice(offset, offset + LINKED_ISSUES_PAGE_SIZE);
  const total = linked.length;
  const nextOffset = offset + identifiers.length < total ? offset + identifiers.length : null;
  if (identifiers.length === 0) return { issues: [], total, nextOffset: null };
  const page = (issues: LinkedIssue[]): LinkedIssuesResult => ({ issues, total, nextOffset });
  const unavailable = (identifier: string, code: FailureCode): LinkedIssue => ({
    identifier,
    status: "unavailable",
    code,
    message: MESSAGES[code]
  });

  let token: string | null;
  try {
    token = await resolveToken(host, companyId);
  } catch {
    host.logger.warn("Linear status control read failed");
    return page(identifiers.map((identifier) => unavailable(identifier, "error")));
  }
  if (token === null) {
    return page(identifiers.map((identifier) => unavailable(identifier, "auth_required")));
  }

  const secret = token;
  const fetch: ProviderFetch = (url, init) => host.http.fetch(url, init);
  const issues = await Promise.all(
    identifiers.map(async (identifier): Promise<LinkedIssue> => {
      try {
        const workflow = await readWorkflow(fetch, secret, identifier);
        if (workflow.kind === "failure") return unavailable(identifier, workflow.code);
        return { identifier, status: "ok", state: workflow.state, states: workflow.states };
      } catch {
        // The thrown error is deliberately dropped: it can carry the credential.
        host.logger.warn("Linear status control read failed");
        return unavailable(identifier, "error");
      }
    })
  );
  return page(issues);
}

async function setIssueState(
  host: PluginContext,
  params: Record<string, unknown>,
  actor: { type: string; companyId: string | null }
): Promise<SetStateResult> {
  // Only a person on the board may write. Agents and system callers reach the
  // same bridge route, so the host-supplied actor is checked here.
  if (actor.type !== "user") return failure("not_user");

  const { issueId, identifier, stateId } = params;
  const companyId = actor.companyId;
  if (
    typeof companyId !== "string" ||
    typeof issueId !== "string" ||
    typeof identifier !== "string" ||
    !ISSUE_IDENTIFIER.test(identifier) ||
    typeof stateId !== "string" ||
    !UUID.test(stateId)
  ) {
    return failure("invalid_request");
  }

  try {
    // The task is read again on every change, so the action cannot be pointed
    // at a Linear issue that is not linked on it.
    const linked = await linkedIdentifiers(host, issueId, companyId);
    if (!linked || !linked.includes(identifier)) return failure("not_linked");

    const token = await resolveToken(host, companyId);
    if (token === null) return failure("auth_required");
    const fetch: ProviderFetch = (url, init) => host.http.fetch(url, init);

    const workflow = await readWorkflow(fetch, token, identifier);
    if (workflow.kind === "failure") return failure(workflow.code);
    const target = workflow.states.find((state) => state.id === stateId);
    if (!target) return failure("invalid_state");
    if (workflow.state.id === target.id) return { ok: true, identifier, state: target, changed: false };

    const outcome = await sendGraphQL(fetch, token, LINEAR_SET_STATE_MUTATION, { id: workflow.id, stateId });
    if (outcome.kind === "failure") return failure(outcome.code);
    const update = outcome.data.issueUpdate;
    const applied = isRecord(update) && isRecord(update.issue) ? parseState(update.issue.state) : null;
    if (!isRecord(update) || update.success !== true || !applied || applied.id !== stateId) {
      return failure("update_failed");
    }
    host.logger.info("Linear issue state changed by hand", { identifier, stateType: applied.type });
    return { ok: true, identifier, state: applied, changed: true };
  } catch {
    // The thrown error is deliberately dropped: transport and secret errors
    // can carry the credential, so only fixed text is logged or returned.
    host.logger.warn("Linear status control change failed");
    return failure("error");
  }
}

export function registerControl(host: PluginContext): void {
  host.data.register(LINKED_ISSUES_DATA_KEY, (params) => listLinkedIssues(host, params));
  host.actions.register(SET_STATE_ACTION_KEY, (params, context) => setIssueState(host, params, context.actor));
}
