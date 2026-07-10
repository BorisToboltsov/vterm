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

// ── Sectioning: outer "group by" over the bundle-collapsed entries ───────────────
//
// A second, orthogonal layer on top of `groupRecordings`: partition the entries
// (singles + broadcast bundles) into collapsible sections by server or start
// date. Bundle-collapsing stays underneath — a broadcast bundle is one logical
// recording split across servers, so it is never split by this layer; it lands in
// a dedicated "broadcast" section when grouping by server, or by its own timestamp
// when grouping by date. Pure → unit-tested without the DOM (ADR 0003).

/** How the library partitions entries into sections. `none` = one flat list. */
export type RecGroupBy = "none" | "server" | "date";

/** Bucket identity for a section — the component maps it to a localized header. */
export type RecSectionBucket =
  | "all" // group-by "none": a single implicit section, no header
  | "server" // a named server (label = the server string)
  | "noServer" // singles with no server (local shell tabs)
  | "broadcast" // broadcast bundles (span multiple servers)
  | "today"
  | "yesterday"
  | "week"
  | "month"
  | "older"
  | "unknownDate";

export interface RecSection {
  /** Stable key for `{#each}` and per-section collapse state. */
  key: string;
  bucket: RecSectionBucket;
  /** Literal header text for server sections (the server name); "" otherwise —
   *  date/special buckets are localized by the component from `bucket`. */
  label: string;
  /** Total recordings under this section (bundle members counted individually). */
  count: number;
  entries: RecEntry[];
}

/** Recordings represented by an entry (bundle members counted individually). */
function entryCount(entry: RecEntry): number {
  return entry.kind === "single" ? 1 : entry.items.length;
}

const DAY_MS = 86_400_000;

/** Local-midnight epoch (ms) of an epoch-seconds instant. */
function dayStart(epochSecs: number): number {
  const d = new Date(epochSecs * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Which relative-date bucket a start time falls into, versus `now` (epoch secs). */
function dateBucket(timestamp: number, now: number): RecSectionBucket {
  if (!timestamp) return "unknownDate";
  const days = Math.round((dayStart(now) - dayStart(timestamp)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  if (days < 31) return "month";
  return "older";
}

/** The server bucket + label for an entry. Bundles always land in `broadcast`. */
function serverBucket(entry: RecEntry): { bucket: RecSectionBucket; label: string } {
  if (entry.kind === "group") return { bucket: "broadcast", label: "" };
  const server = entry.rec.server.trim();
  return server ? { bucket: "server", label: server } : { bucket: "noServer", label: "" };
}

/**
 * Partition already-sorted entries into collapsible sections. Sections appear in
 * first-appearance order (so they respect the caller's sort), and entries keep
 * their input order within each section. `none` returns a single `all` section so
 * callers can iterate sections uniformly; the component omits the header for it.
 */
export function sectionRecordings(
  entries: RecEntry[],
  mode: RecGroupBy,
  now: number,
): RecSection[] {
  const total = (list: RecEntry[]) => list.reduce((n, e) => n + entryCount(e), 0);
  if (mode === "none") {
    return [{ key: "all", bucket: "all", label: "", count: total(entries), entries }];
  }
  const sections: RecSection[] = [];
  const byKey = new Map<string, RecSection>();
  for (const entry of entries) {
    const ts = entry.kind === "single" ? entry.rec.timestamp : entry.timestamp;
    const { bucket, label } =
      mode === "server" ? serverBucket(entry) : { bucket: dateBucket(ts, now), label: "" };
    // Server names disambiguate their own sections; other buckets are singletons.
    const key = bucket === "server" ? `server:${label}` : bucket;
    const existing = byKey.get(key);
    if (existing) {
      existing.entries.push(entry);
      existing.count += entryCount(entry);
    } else {
      const section: RecSection = { key, bucket, label, count: entryCount(entry), entries: [entry] };
      byKey.set(key, section);
      sections.push(section);
    }
  }
  return sections;
}
