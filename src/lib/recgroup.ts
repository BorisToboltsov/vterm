// Group broadcast (synchronous-input) recordings into bundles for the library
// (Phase 22). Recordings made from one broadcast session share a `batchId`; here
// we collapse them into a single expandable entry while leaving ordinary
// recordings as-is. Pure → unit-tested without the DOM (ADR 0003).

import type { RecordingMeta } from "./types";

export interface RecGroupEntry {
  kind: "group";
  batchId: string;
  /** User-given bundle name (from any member), or undefined if never named. */
  label?: string;
  /** Earliest member timestamp (epoch seconds) — the bundle's sort/display time. */
  timestamp: number;
  /** Bundle members, in the order they appear in the input. */
  items: RecordingMeta[];
}

export interface RecSingleEntry {
  kind: "single";
  rec: RecordingMeta;
}

export type RecEntry = RecGroupEntry | RecSingleEntry;

/**
 * Collapse recordings sharing a `batchId` into one group entry, positioned at the
 * first member in the (already sorted) input; recordings without a batch stay as
 * single entries. A lone member of a batch is still shown as a group (so the
 * "Broadcast → N" affordance is consistent even if the others were deleted). The
 * group's `timestamp` is the earliest member's, so callers can sort bundles by it.
 */
export function groupRecordings(items: RecordingMeta[]): RecEntry[] {
  const out: RecEntry[] = [];
  const groupAt = new Map<string, RecGroupEntry>();
  for (const rec of items) {
    const id = rec.batchId;
    if (!id) {
      out.push({ kind: "single", rec });
      continue;
    }
    const existing = groupAt.get(id);
    if (existing) {
      existing.items.push(rec);
      existing.timestamp = Math.min(existing.timestamp, rec.timestamp);
      if (!existing.label && rec.batchLabel) existing.label = rec.batchLabel;
    } else {
      const entry: RecGroupEntry = {
        kind: "group",
        batchId: id,
        label: rec.batchLabel || undefined,
        timestamp: rec.timestamp,
        items: [rec],
      };
      groupAt.set(id, entry);
      out.push(entry);
    }
  }
  return out;
}
