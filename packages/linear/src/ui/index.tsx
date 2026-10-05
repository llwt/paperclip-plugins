import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { usePluginAction, usePluginData, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import {
  LINKED_ISSUES_DATA_KEY,
  LINKED_ISSUES_PAGE_SIZE,
  SET_STATE_ACTION_KEY,
  type LinkedIssue,
  type LinkedIssuesResult,
  type SetStateResult
} from "../control.js";
import { expectedChips, syncChips, type ChipSync } from "./chips.js";

// How many times a page asks the host again, on its own, for a chip the host
// declined to re-read. Each attempt waits for the chip's TTL.
export const MAX_CHIP_RETRIES = 3;

const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minHeight: 28 };
const muted: CSSProperties = { opacity: 0.7, fontSize: 12 };
const control: CSSProperties = {
  font: "inherit",
  fontSize: 13,
  color: "inherit",
  background: "transparent",
  border: "1px solid currentColor",
  borderRadius: 6,
  padding: "2px 6px",
  maxWidth: "100%"
};

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
          style={control}
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

function ChipStatus({ chips, onRetry }: { chips: ChipSync | null; onRetry: () => void }) {
  if (!chips) return null;
  if (chips.status === "failed") {
    return (
      <div role="status" style={{ ...muted, ...row }}>
        The link chips could not be refreshed.
        <button type="button" style={control} onClick={onRetry}>
          Refresh chips
        </button>
      </div>
    );
  }
  if (chips.status === "pending") {
    return (
      <div role="status" style={muted}>
        The link chips are behind Linear. Paperclip reads them again within 5 minutes; reload the page after that.
      </div>
    );
  }
  return chips.updated ? (
    <div role="status" style={muted}>
      A link chip has a new state. Reload the page to see it.
    </div>
  ) : null;
}

function IssuePage({
  issueId,
  offset,
  isLast,
  onMore
}: {
  issueId: string;
  offset: number;
  isLast: boolean;
  onMore: () => void;
}) {
  const { data, error, refresh } = usePluginData<LinkedIssuesResult>(LINKED_ISSUES_DATA_KEY, { issueId, offset });
  const setState = usePluginAction(SET_STATE_ACTION_KEY);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chips, setChips] = useState<ChipSync | null>(null);
  const mounted = useRef(true);
  const retries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only ever asks the host to re-read chips. It never sends a change.
  const sync = useCallback(
    async (issues: LinkedIssue[]) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const result = await syncChips(issueId, expectedChips(issues));
      if (!mounted.current) return;
      setChips(result);
      if (result.status === "pending" && retries.current < MAX_CHIP_RETRIES) {
        retries.current += 1;
        timer.current = setTimeout(() => void sync(issues), Math.max(1000, result.retryAt - Date.now()));
      }
    },
    [issueId]
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Runs whenever the linked issues are read, which includes coming back to
  // the task. A chip that was still waiting when the page was left is asked
  // for again, so leaving the page cannot lose the refresh.
  useEffect(() => {
    if (!data) return;
    retries.current = 0;
    void sync(data.issues);
  }, [data, sync]);

  // One pick sends one change for one Linear issue. A failure is shown and
  // never retried.
  async function pick(identifier: string, stateId: string) {
    setBusy(identifier);
    setNotice(null);
    try {
      const result = (await setState({ issueId, identifier, stateId })) as SetStateResult;
      if (result.ok) {
        setNotice(`${identifier} is now ${result.state.name} in Linear.`);
      } else {
        setNotice(`${identifier}: ${result.message}`);
      }
    } catch {
      setNotice(`${identifier}: Linear request failed`);
    } finally {
      setBusy(null);
      // Reads the page again, which also brings the chips up to date.
      refresh();
    }
  }

  if (error) return <div style={muted}>Linear: could not load the linked issues</div>;
  // Nothing is shown on a task with no Linear links.
  if (!data || data.issues.length === 0) return null;

  return (
    <>
      {offset === 0 ? <div style={{ fontSize: 13, fontWeight: 600 }}>Linear</div> : null}
      {data.issues.map((issue) => (
        <IssueRow key={issue.identifier} issue={issue} busy={busy !== null} onPick={(id, stateId) => void pick(id, stateId)} />
      ))}
      {notice ? (
        <div role="status" style={muted}>
          {notice}
        </div>
      ) : null}
      <ChipStatus
        chips={chips}
        onRetry={() => {
          retries.current = 0;
          void sync(data.issues);
        }}
      />
      {isLast && data.nextOffset !== null ? (
        <div>
          <button type="button" style={control} onClick={onMore}>
            Show more ({data.total - data.nextOffset} more)
          </button>
        </div>
      ) : null}
    </>
  );
}

export function LinearStatusControl({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  // Linked issues are read a page at a time. Each page added here is one more
  // read of the worker, so a task with many links stays cheap to open.
  const [offsets, setOffsets] = useState([0]);

  return (
    <div style={{ display: "grid", gap: 4 }}>
      {offsets.map((offset, index) => (
        <IssuePage
          key={offset}
          issueId={issueId}
          offset={offset}
          isLast={index === offsets.length - 1}
          onMore={() => setOffsets((current) => [...current, current[current.length - 1] + LINKED_ISSUES_PAGE_SIZE])}
        />
      ))}
    </div>
  );
}
