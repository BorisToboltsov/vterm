// What the Scenarios panel remembers (ADR 0071): the folders of this computer
// the library reads recipes from, and the projects pinned to its "Projects"
// group — a folder of a server of the catalog or of this computer. Settings
// data: a backup carries it, every window shares it. Pure.
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
