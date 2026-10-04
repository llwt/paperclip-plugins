import type { PluginExternalObjectResolvedSnapshot } from "@paperclipai/plugin-sdk";
import {
  authRequired,
  failureForStatus,
  isRecord,
  malformedResponse,
  readJson,
  TTL_SECONDS,
  type Provider
} from "./types.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

// The only GraphQL document this plugin ever sends. It is a query, never a
// mutation: the plugin must not write to Linear.
export const LINEAR_ISSUE_QUERY = `query ExternalStatusIssue($id: String!) {
  issue(id: $id) {
    identifier
    title
    archivedAt
    state { name type }
  }
}`;

// https://linear.app/<workspace>/issue/<TEAM-123>[/<slug>]
const ISSUE_PATH = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$)/;
const ISSUE_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

interface LinearIssue {
  identifier: string;
  title: string | null;
  archivedAt: string | null;
  state: { name: string; type: string };
}

function parseIssue(value: unknown): LinearIssue | null {
  if (!isRecord(value) || !isRecord(value.state)) return null;
  const { identifier, title, archivedAt, state } = value;
  if (typeof identifier !== "string" || !ISSUE_IDENTIFIER.test(identifier)) return null;
  if (title !== null && typeof title !== "string") return null;
  if (archivedAt !== null && typeof archivedAt !== "string") return null;
  if (typeof state.name !== "string" || typeof state.type !== "string") return null;
  return { identifier, title, archivedAt, state: { name: state.name, type: state.type } };
}

type GraphQLErrorKind = "auth" | "not_found" | "rate_limited" | "other";

// Classified from the machine-readable `extensions` and `path` only. `message`
// is used solely to recognise Linear's fixed "Entity not found: Issue" text and
// is never returned or logged.
function classifyError(error: unknown): GraphQLErrorKind {
  if (!isRecord(error)) return "other";
  const extensions = isRecord(error.extensions) ? error.extensions : {};
  const code = `${String(extensions.code ?? "")} ${String(extensions.type ?? "")}`;
  if (/authentication|forbidden/i.test(code)) return "auth";
  if (/ratelimit/i.test(code)) return "rate_limited";
  // Only the root `issue` lookup failing to find an Issue confirms absence. A
  // missing nested entity (path ["issue", "state"]), another entity type or an
  // error without a path says nothing about whether the issue exists.
  if (
    /input_error|invalid input/i.test(code) &&
    typeof error.message === "string" &&
    /^Entity not found: Issue(?![A-Za-z0-9_])/.test(error.message) &&
    Array.isArray(error.path) &&
    error.path.length === 1 &&
    error.path[0] === "issue"
  ) {
    return "not_found";
  }
  return "other";
}

// True when the response carries no issue at all. A partially returned issue
// contradicts absence.
function hasNoIssueData(data: unknown): boolean {
  if (data === undefined || data === null) return true;
  return isRecord(data) && (data.issue === undefined || data.issue === null);
}

type StatusFields = Pick<
  PluginExternalObjectResolvedSnapshot,
  "statusCategory" | "statusTone" | "statusIconKey" | "isTerminal"
>;

// Linear workflow state types: triage, backlog, unstarted, started, completed, canceled.
function statusForStateType(type: string): StatusFields {
  switch (type) {
    case "started":
      return { statusCategory: "running", statusTone: "info", statusIconKey: "circle-dot", isTerminal: false };
    case "completed":
      return { statusCategory: "succeeded", statusTone: "success", statusIconKey: "check-circle", isTerminal: true };
    case "canceled":
      return { statusCategory: "closed", statusTone: "muted", statusIconKey: "circle", isTerminal: true };
    case "triage":
    case "backlog":
    case "unstarted":
      return { statusCategory: "open", statusTone: "neutral", statusIconKey: "circle", isTerminal: false };
    default:
      return { statusCategory: "unknown", statusTone: "neutral", statusIconKey: "circle", isTerminal: false };
  }
}

export const linearProvider: Provider = {
  providerKey: "linear",
  iconKey: "linear",
  objectType: "issue",
  configKey: "linearApiKey",

  detect(url) {
    if (url.host !== "linear.app") return null;
    const match = ISSUE_PATH.exec(url.pathname);
    if (!match) return null;
    const identifier = match[1].toUpperCase();
    return { objectType: "issue", externalId: identifier, displayKey: identifier };
  },

  isValidExternalId(externalId) {
    return ISSUE_IDENTIFIER.test(externalId);
  },

  async resolve({ externalId, token, fetch }) {
    const response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ query: LINEAR_ISSUE_QUERY, variables: { id: externalId } })
    });
    const failure = failureForStatus("linear", response);
    if (failure) return failure;

    const body = await readJson(response);
    if (!isRecord(body)) return malformedResponse("linear");

    if (body.errors !== undefined) {
      if (!Array.isArray(body.errors) || body.errors.length === 0) return malformedResponse("linear");
      const kinds = body.errors.map(classifyError);
      if (kinds.includes("auth")) return authRequired("linear");
      if (kinds.includes("rate_limited")) {
        return {
          ok: false,
          liveness: "unreachable",
          errorCode: "linear_rate_limited",
          errorMessage: "linear API rate limit reached"
        };
      }
      // Only an explicit "Entity not found: Issue" input error on the root
      // lookup, with no issue data, confirms absence. Anything else is an
      // operational failure and stays retryable.
      if (kinds.every((kind) => kind === "not_found") && hasNoIssueData(body.data)) {
        return {
          ok: true,
          snapshot: {
            displayKey: externalId,
            iconKey: "linear",
            statusKey: "not_found",
            statusLabel: "Not found",
            statusIconKey: "archive",
            statusCategory: "archived",
            statusTone: "muted",
            isTerminal: true,
            ttlSeconds: TTL_SECONDS
          }
        };
      }
      return {
        ok: false,
        liveness: "unreachable",
        errorCode: "linear_graphql_error",
        errorMessage: "linear API returned a GraphQL error"
      };
    }

    const issue = isRecord(body.data) ? parseIssue(body.data.issue) : null;
    if (!issue) return malformedResponse("linear");

    const base = {
      displayKey: issue.identifier,
      iconKey: "linear",
      displayTitle: issue.title ? `${issue.identifier}: ${issue.title}` : issue.identifier,
      ttlSeconds: TTL_SECONDS
    };
    // An archived issue keeps its last workflow state, which would otherwise
    // render as live. Archival wins.
    if (issue.archivedAt !== null) {
      return {
        ok: true,
        snapshot: {
          ...base,
          statusKey: "archived",
          statusLabel: "Archived",
          statusIconKey: "archive",
          statusCategory: "archived",
          statusTone: "muted",
          isTerminal: true,
          data: { stateType: issue.state.type, archived: true }
        }
      };
    }
    return {
      ok: true,
      snapshot: {
        ...base,
        statusKey: issue.state.type,
        statusLabel: issue.state.name,
        ...statusForStateType(issue.state.type),
        data: { stateType: issue.state.type, archived: false }
      }
    };
  }
};
