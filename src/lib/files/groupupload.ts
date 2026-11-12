// Upload to the synchronous-input group (ADR 0064): one batch of local files,
// the same folder on every member's server. DOM-free (ADR 0003): the flow lists
// each folder and starts each job; this module says what a folder's listing
// means for the batch, what each server is sent, and how a listing of the
// group compares with the folder the panel shows.
//
// The folder is the one the panel shows, by its absolute path, on every server
// — never wherever another member's panel happens to stand: that is not on the
// screen. Nothing is replaced without the answer of the group's own question.

import type { FileEntry } from "../types";

/** A local file or folder of the batch. */
export interface UploadSource {
  path: string;
  name: string;
  isDir: boolean;
}

/** A name of the batch already in a server's folder. */
export interface TakenName {
  name: string;
  isDir: boolean;
  size: number;
  modified: number | null;
}

/** What a server's folder means for the batch. */
export type HostCheck =
  | { kind: "ready"; free: string[]; taken: TakenName[] }
  /** The folder is not there. Nothing is created on a server without being asked. */
  | { kind: "noFolder" }
  /** The folder could not be listed — said with the reason, not taken for empty. */
  | { kind: "unread"; error: string };

/** Whether a listing's failure says the folder is not there, or only that it was not read. */
export function listFailure(error: string): HostCheck {
  return /no such file|not found|does not exist/i.test(error)
    ? { kind: "noFolder" }
    : { kind: "unread", error };
}

/** The batch against the names a server's folder holds. */
export function hostCheck(sources: readonly UploadSource[], entries: readonly FileEntry[]): HostCheck {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const free: string[] = [];
  const taken: TakenName[] = [];
  for (const s of sources) {
    const e = byName.get(s.name);
    if (e) taken.push({ name: e.name, isDir: e.isDir, size: e.size, modified: e.modified });
    else free.push(s.name);
  }
  return { kind: "ready", free, taken };
}

/**
 * What a server is sent: the free names, and the taken ones only when the
 * group's question was answered "replace". Null — nothing goes there (the
 * folder is missing or unread, or every name is taken and kept).
 */
export function hostSources(
  sources: readonly UploadSource[],
  check: HostCheck,
  replace: boolean,
): { sources: UploadSource[]; replace: boolean } | null {
  if (check.kind !== "ready") return null;
  if (replace) return sources.length > 0 ? { sources: [...sources], replace: true } : null;
  const free = new Set(check.free);
  const go = sources.filter((s) => free.has(s.name));
  return go.length > 0 ? { sources: go, replace: false } : null;
}

/** Whether a server can be sent anything at all — what the question offers to tick. */
export const canReceive = (check: HostCheck): boolean => check.kind === "ready";

/** A server of the group in the upload's question. */
export interface UploadHost {
  id: string;
  label: string;
  prod: boolean;
  /** Null while its folder is being listed. */
  check: HostCheck | null;
  picked: boolean;
}

/** The upload's question: what goes where. */
export interface UploadAsk {
  /** The member whose panel asked. */
  lead: string;
  destDir: string;
  sources: UploadSource[];
  hosts: UploadHost[];
  /** Members whose file panel is no server's folder (a local shell, a container's): named, not sent to. */
  outside: string[];
  /** The answer to "replace the names already there". */
  replace: boolean;
}

// ── The panel's folder against the group's ──────────────────────────────────

/** A name of the panel's folder on another server. */
export type Mark = "same" | "differs" | "absent" | "unknown";

/**
 * How a member's copy of `lead` compares: size and time as the listing says
 * them, and nothing more — "same" means the listing could not tell them apart,
 * which is said so in the legend, not that their bytes are equal. A folder is
 * "same" when it is a folder there too. Null listing — the member was not read.
 */
export function markOf(lead: FileEntry, member: readonly FileEntry[] | null): Mark {
  if (member === null) return "unknown";
  const other = member.find((e) => e.name === lead.name);
  if (!other) return "absent";
  if (other.isDir !== lead.isDir) return "differs";
  if (lead.isDir) return "same";
  return other.size === lead.size && other.modified === lead.modified ? "same" : "differs";
}

/** Names the other members hold in that folder that the panel's server does not. */
export function elsewhere(
  lead: readonly FileEntry[],
  members: readonly { label: string; entries: readonly FileEntry[] | null }[],
): { name: string; on: string[] }[] {
  const here = new Set(lead.map((e) => e.name));
  const found = new Map<string, string[]>();
  for (const m of members) {
    for (const e of m.entries ?? []) {
      if (here.has(e.name)) continue;
      found.set(e.name, [...(found.get(e.name) ?? []), m.label]);
    }
  }
  return [...found.entries()]
    .map(([name, on]) => ({ name, on }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a member's file panel is given while synchronous input is on for it (ADR 0064). */
export interface SftpGroup {
  /** Servers an upload goes to, this one among them. */
  servers: number;
  upload: (destDir: string, sources: UploadSource[]) => void;
  compare: (dir: string) => void;
  clearCompare: () => void;
  /** The comparison of `dir`, while the panel is in it. */
  compared: (dir: string) => { loading: boolean } | null;
  marks: (dir: string, entry: FileEntry) => { label: string; mark: Mark }[] | null;
  elsewhere: (dir: string) => { name: string; on: string[] }[];
}

/** A mark's dot, in the theme's tokens: as here — accent, differs — warn, absent — an empty ring. */
export const MARK_DOT: Record<Mark, string> = {
  same: "bg-accent",
  differs: "bg-warn",
  absent: "border border-muted",
  unknown: "bg-edge",
};
