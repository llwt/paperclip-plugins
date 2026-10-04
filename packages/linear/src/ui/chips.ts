import type { LinkedIssue } from "../control.js";
import { isRecord, TTL_SECONDS } from "../providers/types.js";

// Keeps the host's link chips in step with what the control read from Linear.
//
// The plugin cannot write a chip. It can only ask the host to read it again,
// and the host declines while the chip's TTL is running. So a sync can end in
// three ways, and a declined or failed one is reported instead of assumed.

export type ChipSync =
  /**
   * Every chip holds what Linear returned. `updated` is true when the host
   * re-read one just now: the host does not redraw a chip already on screen.
   */
  | { status: "synced"; updated: boolean }
  /** The host declined to re-read at least one chip yet. Ask again at `retryAt`. */
  | { status: "pending"; retryAt: number }
  /** The host could not be asked, or answered with something unexpected. */
  | { status: "failed" };

export interface ExpectedChip {
  identifier: string;
  /** The status label the chip shows once it is up to date. */
  label: string;
}

/** What each chip should show for a page of the control. Issues whose state could not be read are left out. */
export function expectedChips(issues: LinkedIssue[]): ExpectedChip[] {
  const expected: ExpectedChip[] = [];
  for (const issue of issues) {
    if (issue.status === "ok") expected.push({ identifier: issue.identifier, label: issue.state.name });
    else if (issue.code === "archived") expected.push({ identifier: issue.identifier, label: "Archived" });
    else if (issue.code === "not_found") expected.push({ identifier: issue.identifier, label: "Not found" });
  }
  return expected;
}

interface HostChip {
  id: string;
  identifier: string;
  label: string | null;
  nextRefreshAt: number | null;
}

function parseChip(value: unknown): HostChip | null {
  if (!isRecord(value) || value.providerKey !== "linear") return null;
  if (typeof value.id !== "string" || typeof value.externalId !== "string") return null;
  const nextRefreshAt = typeof value.nextRefreshAt === "string" ? Date.parse(value.nextRefreshAt) : NaN;
  return {
    id: value.id,
    identifier: value.externalId,
    label: typeof value.statusLabel === "string" ? value.statusLabel : null,
    nextRefreshAt: Number.isFinite(nextRefreshAt) ? nextRefreshAt : null
  };
}

async function hostJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { credentials: "include", ...init });
  if (!response.ok) throw new Error("host request failed");
  return response.json();
}

/**
 * Compares the task's chips with `expected` and asks the host to re-read the
 * ones that differ. Sends nothing to Linear and changes nothing when the chips
 * already match.
 */
export async function syncChips(issueId: string, expected: ExpectedChip[], now = Date.now()): Promise<ChipSync> {
  if (expected.length === 0) return { status: "synced", updated: false };
  const labels = new Map(expected.map((chip) => [chip.identifier, chip.label]));
  const isStale = (chip: HostChip) => labels.has(chip.identifier) && labels.get(chip.identifier) !== chip.label;
  const base = `/api/issues/${encodeURIComponent(issueId)}/external-objects`;

  try {
    const listed = await hostJson(base);
    if (!Array.isArray(listed)) return { status: "failed" };
    const stale = listed
      .map((group) => (isRecord(group) ? parseChip(group.object) : null))
      .filter((chip): chip is HostChip => chip !== null && isStale(chip));
    if (stale.length === 0) return { status: "synced", updated: false };

    const answer = await hostJson(`${base}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectIds: stale.map((chip) => chip.id) })
    });
    if (!isRecord(answer) || !Array.isArray(answer.refreshed)) return { status: "failed" };
    const after = new Map<string, HostChip>();
    for (const entry of answer.refreshed) {
      const chip = isRecord(entry) ? parseChip(entry.object) : null;
      if (chip) after.set(chip.id, chip);
    }

    // A chip the host did not answer for counts as still stale.
    const remaining = stale.map((chip) => after.get(chip.id) ?? chip).filter(isStale);
    if (remaining.length === 0) return { status: "synced", updated: true };
    const retryAt = Math.max(...remaining.map((chip) => chip.nextRefreshAt ?? now + TTL_SECONDS * 1000));
    return { status: "pending", retryAt: Math.max(retryAt, now) + 2000 };
  } catch {
    return { status: "failed" };
  }
}
