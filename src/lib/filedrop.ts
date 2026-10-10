// Dragging files (v1.13) — the pure half: what is carried, what it can be
// dropped on, and what a drop there means. The store (`stores/filedrag`) only
// tracks the pointer and asks these; the page only does what the answer says.
//
// Files are carried from one of three places: a file panel of this window, a
// file panel of another window of the app (told through the backend — see
// `describeFiles`), or the desktop (the system's own drag). They land on one of
// two kinds of target: a folder a file panel shows, or a session as a whole —
// its tab, its terminal, a panel that lists nothing yet.
//
// A drop between two sessions always copies. Deleting the source on one server
// after a copy to another is not something to do behind a gesture; the only
// move is the old one, inside one panel.

/** One file or folder in the air. */
export interface CarriedEntry {
  path: string;
  name: string;
  isDir: boolean;
}

/** What is being dragged. */
export interface CarriedFiles {
  /** The tab whose file panel they come from; null — from outside the app (the desktop). */
  from: string | null;
  /** They are on this machine: a local tab's panel, or the desktop. */
  local: boolean;
  /** What that tab is called. */
  label: string;
  entries: CarriedEntry[];
  /**
   * A drag of the system's own carries them (v1.14): files of a server taken
   * out of their window. The system draws them wherever they are — a window
   * they pass back over shows where they would land, and no label of its own.
   */
  system?: boolean;
}

/** What files can be dropped on. */
export type FileTarget =
  /** A folder a file panel shows — a row of its list, or the list itself. */
  | { kind: "folder"; session: string; dir: string }
  /** A session as a whole: its tab, its terminal, a file panel that lists nothing. */
  | { kind: "session"; session: string };

export function sameTarget(a: FileTarget | null, b: FileTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.session !== b.session) return false;
  return a.kind !== "folder" || a.dir === (b as { dir: string }).dir;
}

/**
 * How long files are held over a tab — or the dock's Files tab, or a folded
 * dock — before it opens under them. Long enough not to open everything the
 * pointer crosses, short enough not to read as "nothing happens".
 */
export const SPRING_MS = 700;

/** What a drop needs to know of a tab. */
export interface DropTab {
  sessionId: string;
  kind: "ssh" | "local";
  /** Its session is up — files can be read from it or written to it. */
  connected: boolean;
}

/** What letting go over a target does. */
export type DropMeaning =
  /** Inside the panel they came from: the move that panel always did, with its question. */
  | { kind: "move"; session: string; dir: string }
  /** To another session, through the dialog that names the folder (`dir` null — it is asked). */
  | { kind: "copy"; to: string; dir: string | null }
  /** Files from the desktop into a folder a panel shows: sent at once, as a drop always was. */
  | { kind: "send"; to: string; dir: string }
  /** Files from the desktop onto a local terminal: their paths are typed into it. */
  | { kind: "paste"; to: string };

/**
 * What a drop of `files` on `target` means; null — nothing, and the target is
 * not offered at all.
 */
export function dropMeaning(
  files: CarriedFiles,
  target: FileTarget | null,
  tabs: readonly DropTab[],
): DropMeaning | null {
  if (!target || files.entries.length === 0) return null;
  const tab = tabs.find((t) => t.sessionId === target.session);
  if (!tab) return null;
  if (files.from === target.session) {
    // Back onto its own tab or terminal there is nothing to do; onto a folder
    // of its own panel it is the move.
    return target.kind === "folder"
      ? { kind: "move", session: target.session, dir: target.dir }
      : null;
  }
  // A session that is not up can neither be listed nor written to.
  if (!tab.connected) return null;
  if (files.from === null) {
    if (target.kind === "folder") return { kind: "send", to: target.session, dir: target.dir };
    // A local terminal takes the paths, as every terminal does; a server's
    // session is asked where on the server they should go.
    return tab.kind === "local"
      ? { kind: "paste", to: target.session }
      : { kind: "copy", to: target.session, dir: null };
  }
  return {
    kind: "copy",
    to: target.session,
    dir: target.kind === "folder" ? target.dir : null,
  };
}

/** What the label at the pointer says: one name, or how many. */
export function carriedCount(files: CarriedFiles): number {
  return files.entries.length;
}

// ── Between two windows ──────────────────────────────────────────────────────
// A page draws nothing outside its window, and its pointer events end at the
// edge. Held over another window of the app, the files are drawn by that window
// — on the word of this one, passed through the backend (the same relay a tab
// uses, `drag_over` → `window://drag`). What is passed is read, not trusted.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** More than this is not carried between windows in one message. */
export const MAX_RELAYED = 2000;

/** The files, as told to another window. */
export function describeFiles(files: CarriedFiles): Record<string, unknown> {
  return {
    kind: "files",
    from: files.from,
    local: files.local,
    label: files.label,
    entries: files.entries.map(({ path, name, isDir }) => ({ path, name, isDir })),
    ...(files.system ? { system: true } : {}),
  };
}

/** Read what another window said it carries; null — it is not files, or not whole. */
export function parseFiles(raw: unknown): CarriedFiles | null {
  if (!isRecord(raw) || raw.kind !== "files") return null;
  const { from, local, label, entries } = raw;
  if (typeof from !== "string" || from === "") return null;
  if (typeof local !== "boolean" || typeof label !== "string") return null;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_RELAYED) return null;
  const out: CarriedEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return null;
    const { path, name, isDir } = entry;
    if (typeof path !== "string" || path === "" || typeof name !== "string" || name === "") {
      return null;
    }
    if (typeof isDir !== "boolean") return null;
    out.push({ path, name, isDir });
  }
  const read: CarriedFiles = { from, local, label, entries: out };
  // Said in so many words, or not at all: anything else is not "the system's".
  if (raw.system === true) read.system = true;
  return read;
}

/** What this window is told of files dragged from another one. */
export type FileDragMessage =
  | { kind: "over" | "drop"; x: number; y: number; files: CarriedFiles }
  | { kind: "leave" };

/**
 * Read a relayed drag message as one about files. Null for anything else — a
 * tab's message among them, which `parseDragMessage` reads.
 */
export function parseFileDragMessage(raw: unknown): FileDragMessage | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "leave") return { kind: "leave" };
  if (raw.kind !== "over" && raw.kind !== "drop") return null;
  const { x, y } = raw;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // The backend relays what is dragged under the name `tab`, whatever it is.
  const files = parseFiles(raw.tab);
  return files ? { kind: raw.kind, x, y, files } : null;
}

// ── From the desktop ─────────────────────────────────────────────────────────

/** The last segment of a local path, whichever separator it uses. */
function localName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

/**
 * Files the system is dragging over the window. Which of them are folders is
 * not known until they are dropped (`isDir` false here; asked then).
 */
export function desktopFiles(paths: readonly string[]): CarriedFiles {
  return {
    from: null,
    local: true,
    label: "",
    entries: paths.map((path) => ({ path, name: localName(path), isDir: false })),
  };
}

/**
 * A point the system reports in device pixels, as a point of the page. The
 * system's drag knows nothing of the page's zoom.
 */
export function pagePoint(
  position: { x: number; y: number },
  devicePixelRatio: number,
): { x: number; y: number } {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { x: position.x / ratio, y: position.y / ratio };
}
