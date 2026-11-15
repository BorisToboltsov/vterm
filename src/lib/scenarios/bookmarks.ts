// What the Scenarios panel remembers (ADR 0071, 0072): the folders of this
// computer the library reads recipes from, the projects pinned to its
// "Projects" group — a folder of a server of the catalog or of this computer —
// and the shipped recipes it wrote into "Mine". Settings data: a backup carries
// it, every window shares it. Pure.
import type { ProjectKind } from "./project";

export interface ProjectBookmark {
  kind: ProjectKind;
  /** The project folder, absolute. */
  root: string;
  /** The server it lies on; null — this computer. */
  serverId: string | null;
}

export type ScenarioTab = "library" | "runs";

/** The most folders the library reads, and the most pinned projects. */
export const MAX_SOURCES = 20;
export const MAX_BOOKMARKS = 50;

const absolute = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

/** Recipe folders as stored: absolute paths, each once. */
export function sanitizeSources(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const p = x.trim();
    if (p && absolute(p) && !out.includes(p)) out.push(p);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

const sameBookmark = (a: ProjectBookmark, b: ProjectBookmark): boolean => a.root === b.root && a.serverId === b.serverId;

/** Pinned projects as stored: a known kind, an absolute folder, each once. */
export function sanitizeBookmarks(v: unknown): ProjectBookmark[] {
  if (!Array.isArray(v)) return [];
  const out: ProjectBookmark[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if ((o.kind !== "ansible" && o.kind !== "terraform") || typeof o.root !== "string" || !absolute(o.root)) continue;
    const b: ProjectBookmark = { kind: o.kind, root: o.root, serverId: typeof o.serverId === "string" && o.serverId ? o.serverId : null };
    if (!out.some((y) => sameBookmark(y, b))) out.push(b);
    if (out.length >= MAX_BOOKMARKS) break;
  }
  return out;
}

export const sanitizeScenarioTab = (v: unknown): ScenarioTab => (v === "runs" ? "runs" : "library");

/** Whether the project is pinned. */
export const isPinned = (list: readonly ProjectBookmark[], b: ProjectBookmark): boolean => list.some((y) => sameBookmark(y, b));

/** The list with the project pinned, or unpinned when it was. */
export function togglePin(list: readonly ProjectBookmark[], b: ProjectBookmark): ProjectBookmark[] {
  return isPinned(list, b) ? list.filter((y) => !sameBookmark(y, b)) : [...list, b].slice(-MAX_BOOKMARKS);
}

/** The last segment of a folder: how a project is named in a list. */
export function folderName(root: string): string {
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/**
 * What the app remembers of a shipped file it wrote into "Mine": the
 * fingerprint of the text written and its language. `hash: ""` — a file of that
 * name was already the user's when the build came: never the app's to write.
 */
export interface SeedMark {
  hash: string;
  lang: string;
}

export type SeedState = Record<string, SeedMark>;

/** The marks as stored: library file names, each with a fingerprint and a language. */
export function sanitizeSeeded(v: unknown): SeedState {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: SeedState = {};
  for (const [file, mark] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
    if (!/^[\w.-]+\.(sh|ya?ml)$/.test(file) || !mark || typeof mark !== "object") continue;
    const m = mark as Record<string, unknown>;
    if (typeof m.hash !== "string" || typeof m.lang !== "string" || m.hash.length > 32 || m.lang.length > 16) continue;
    out[file] = { hash: m.hash, lang: m.lang };
  }
  return out;
}
