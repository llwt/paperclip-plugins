import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePluginAction, usePluginData, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import {
  LINKED_ISSUES_DATA_KEY,
  SET_STATE_ACTION_KEY,
  type LinkedIssue,
  type LinkedIssuesResult,
  type SetStateResult
} from "../control.js";
import { TTL_SECONDS } from "../providers/types.js";

const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minHeight: 28 };
const muted: CSSProperties = { opacity: 0.7, fontSize: 12 };
const select: CSSProperties = {
  font: "inherit",
  fontSize: 13,
  color: "inherit",
  background: "transparent",
  border: "1px solid currentColor",
  borderRadius: 6,
  padding: "2px 6px",
  maxWidth: "100%"
};

// Asks the host to re-read the task's link chips. The host skips a chip it
// read within the last TTL, so the result says whether a later retry is needed.
async function refreshChips(issueId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/issues/${encodeURIComponent(issueId)}/external-objects/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    if (!response.ok) return true;
    const body = (await response.json()) as { refreshed?: Array<{ refreshed?: boolean }> };
    return Array.isArray(body.refreshed) && body.refreshed.every((entry) => entry.refreshed !== false);
  } catch {
    return true;
  }
}

function IssueRow({
  issue,
  busy,
  onPick
}: {
  issue: LinkedIssue;
  busy: boolean;
  onPick: (identifier: string, stateId: string) => void;
}) {
  return (
    <div style={row}>
      <strong style={{ fontSize: 13, minWidth: 72 }}>{issue.identifier}</strong>
      {issue.status === "ok" ? (
        <select
          aria-label={`State of ${issue.identifier} in Linear`}
          style={select}
          value={issue.state.id}
          disabled={busy}
          onChange={(event) => onPick(issue.identifier, event.target.value)}
        >
          {issue.states.map((state) => (
            <option key={state.id} value={state.id}>
              {state.name}
            </option>
          ))}
        </select>
      ) : (
        <span style={muted}>{issue.message}</span>
      )}
    </div>
  );
}

export function LinearStatusControl({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  const { data, loading, error, refresh } = usePluginData<LinkedIssuesResult>(LINKED_ISSUES_DATA_KEY, { issueId });
  const setState = usePluginAction(SET_STATE_ACTION_KEY);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (retry.current) clearTimeout(retry.current);
    },
    []
  );

  // One pick sends one change for one Linear issue. A failure is shown and
  // never retried.
  async function pick(identifier: string, stateId: string) {
    setBusy(identifier);
    setNotice(null);
    try {
      const result = (await setState({ issueId, identifier, stateId })) as SetStateResult;
      if (!result.ok) {
        setNotice(`${identifier}: ${result.message}`);
        return;
      }
      if (!(await refreshChips(issueId))) {
        // The host read the chip too recently to read it again now. Ask once
        // more when its TTL has passed.
        if (retry.current) clearTimeout(retry.current);
        retry.current = setTimeout(() => void refreshChips(issueId), (TTL_SECONDS + 5) * 1000);
        setNotice(`${identifier} is now ${result.state.name}. The link chip can take a few minutes to follow.`);
      }
    } catch {
      setNotice(`${identifier}: Linear request failed`);
    } finally {
      setBusy(null);
      refresh();
    }
  }

  // Nothing is shown on a task with no Linear links.
  if (!data && loading) return null;
  if (error) return <div style={muted}>Linear: could not load the linked issues</div>;
  if (!data || data.issues.length === 0) return null;

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Linear</div>
      {data.issues.map((issue) => (
        <IssueRow key={issue.identifier} issue={issue} busy={busy !== null} onPick={(id, stateId) => void pick(id, stateId)} />
      ))}
      {data.truncated ? <div style={muted}>Only the first {data.issues.length} linked issues are listed.</div> : null}
      {notice ? (
        <div role="status" style={muted}>
          {notice}
        </div>
      ) : null}
    </div>
  );
}
