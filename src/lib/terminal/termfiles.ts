// Files named in terminal output (v1.24, ADR 0035): a click on a name `ls` or
// `dir` printed — or on a path anywhere in the output — opens the file in the
// editor, a folder in the file panel.
//
// The click is the easy part; the hard one is which file a line names. `ls`
// prints `nginx.conf`, not `/etc/nginx/nginx.conf`, and the folder it ran in
// is not the folder the shell stands in now. So:
//
//   * every command gets the folder it ran in, taken when it was sent (a
//     "block", from one Enter to the next — the terminal keeps them as
//     markers). Unknown is a legal answer and stays unknown: no guessing from
//     the prompt, no borrowing the folder of the command before;
//   * a listing command's own argument (`ls /etc`) and the headers it prints
//     (`dir` → ` Directory of C:\x`, `ls a b` → `a:`) move the folder of the
//     lines under them;
//   * nothing is parsed out of the listing format. A word is a link only when
//     the folder's real listing has an entry of that name (Principle 5): the
//     format of `ls` differs between GNU, BSD and busybox, with `-l`, `-F`,
//     colours and quoting on top — the listing does not.
//
// Pure: settings, the text of a line with the cell of each character, the
// candidates a line offers, the folders they need listed, which of them the
// listings confirm, the listing command, headers and what a click does. The
// provider (`filelinkprovider.ts`) feeds it xterm's buffer and the listings.

import { baseName, isRoot, parentOf, resolveRelative } from "../files/fspath";

// ── Settings ─────────────────────────────────────────────────────────────────

/** `settings.terminalFileLinks`: ask before opening, open right away, or never. */
export const FILE_LINK_MODES = ["confirm", "direct", "off"] as const;
export type FileLinkMode = (typeof FILE_LINK_MODES)[number];
export const DEFAULT_FILE_LINK_MODE: FileLinkMode = "confirm";

export const isFileLinkMode = (v: unknown): v is FileLinkMode =>
  typeof v === "string" && (FILE_LINK_MODES as readonly string[]).includes(v);

/**
 * `settings.terminalFileLinkClick`: a plain click, or only ⌘-click (macOS) /
 * Ctrl-click (Windows, Linux) — for those who click into the terminal to
 * focus it and would rather not land on a name.
 */
export const FILE_LINK_CLICKS = ["click", "modifier"] as const;
export type FileLinkClick = (typeof FILE_LINK_CLICKS)[number];
export const DEFAULT_FILE_LINK_CLICK: FileLinkClick = "click";

export const isFileLinkClick = (v: unknown): v is FileLinkClick =>
  typeof v === "string" && (FILE_LINK_CLICKS as readonly string[]).includes(v);

/** The keys of a click that decide whether it opens. */
export interface ClickKeys {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * Whether a click on a file link opens it. Alt-click is xterm's "move the
 * cursor here" and never opens; in `modifier` mode only ⌘ (macOS) or Ctrl
 * (elsewhere) does.
 */
export function clickOpens(click: FileLinkClick, keys: ClickKeys, mac: boolean): boolean {
  if (keys.altKey) return false;
  if (click === "click") return true;
  return mac ? keys.metaKey : keys.ctrlKey;
}

/**
 * How long a plain click waits before it opens: long enough for the second
 * click of a double-click, which selects the name instead (the user wants to
 * copy it). A ⌘/Ctrl-click opens at once — nobody double-clicks with it held.
 */
export const DOUBLE_CLICK_MS = 400;

// ── What a click does ────────────────────────────────────────────────────────

/** How paths are spelled where the shell runs: SSH and macOS/Linux — POSIX. */
export type PathStyle = "posix" | "windows";

/** A name confirmed by its folder's listing. */
export interface NamedPath {
  kind: "file" | "dir";
  path: string;
  /** The line the output named in the file (`x.c:42`), 1-based; files only. */
  line?: number;
}

/**
 * What a link leads to: a confirmed file or folder, or — on an SSH tab that
 * does not report its folder — a name in a listing nobody can place. The
 * last one offers path sync instead of opening anything.
 */
export type FileLinkTarget = NamedPath | { kind: "unplaced" };

export type FileLinkAction =
  | { kind: "ignore" }
  | { kind: "open"; target: NamedPath }
  | { kind: "ask"; target: NamedPath }
  | { kind: "offerSync" };

/**
 * Whether a tab's output names files of its own session. A shell inside a
 * container or pod (`Tab.attach`) runs on the container's filesystem, and the
 * session's SFTP reads the host's: the same path there is another file.
 */
export function fileLinksAllowed(tab: { attach?: unknown }): boolean {
  return !tab.attach;
}

/** What the window asks about a clicked file link. `where` is the server's
 *  name; null — this computer. */
export type FileLinkQuestion =
  | { kind: "open"; sessionId: string; target: NamedPath; where: string | null; prod: boolean }
  | { kind: "sync"; sessionId: string; where: string | null; following: boolean };

/** A click on a file link that `clickOpens` let through. */
export function fileLinkClick(mode: FileLinkMode, target: FileLinkTarget): FileLinkAction {
  if (mode === "off") return { kind: "ignore" };
  // Not a question about a file: in any mode, the folder is what is missing.
  if (target.kind === "unplaced") return { kind: "offerSync" };
  return mode === "direct" ? { kind: "open", target } : { kind: "ask", target };
}

// ── A line as text, with the cell of each character ──────────────────────────

/** The part of an xterm buffer cell `lineText` reads. */
export interface CellLike {
  getChars(): string;
  getWidth(): number;
}

/** The part of an xterm buffer line `lineText` reads. */
export interface RowLike {
  length: number;
  getCell(x: number): CellLike | undefined;
}

/**
 * A logical line — a row and the rows it wraps onto — as text. `cells[i]` is
 * the cell of `text[i]` counted from the first row (`row * cols + column`),
 * `widths[i]` how many cells that character takes: a wide character (CJK, an
 * emoji) takes two, and the string index alone would put a link beside the
 * name it belongs to.
 */
export interface LineText {
  text: string;
  cells: number[];
  widths: number[];
}

export function lineText(rows: RowLike[], cols: number): LineText {
  let text = "";
  const cells: number[] = [];
  const widths: number[] = [];
  rows.forEach((row, r) => {
    for (let x = 0; x < row.length; x++) {
      const cell = row.getCell(x);
      if (!cell) continue;
      const width = cell.getWidth();
      // The second half of a wide character: its first half carries it.
      if (width === 0) continue;
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) {
        text += chars[i];
        cells.push(r * cols + x);
        widths.push(width);
      }
    }
  });
  let end = text.length;
  while (end > 0 && text[end - 1] === " ") end--;
  return { text: text.slice(0, end), cells: cells.slice(0, end), widths: widths.slice(0, end) };
}

/** A range as xterm takes it: 1-based, end inclusive. */
export interface CellRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/**
 * The cells of `text[from..to)`. `firstRow` is the 0-based buffer row the
 * logical line starts on.
 */
export function spanRange(line: LineText, from: number, to: number, cols: number, firstRow: number): CellRange {
  const first = line.cells[from];
  const last = line.cells[to - 1] + line.widths[to - 1] - 1;
  return {
    start: { x: (first % cols) + 1, y: firstRow + Math.floor(first / cols) + 1 },
    end: { x: (last % cols) + 1, y: firstRow + Math.floor(last / cols) + 1 },
  };
}

// ── Candidates ───────────────────────────────────────────────────────────────

/** A path, split where its folder's listing is asked. */
export interface Resolved {
  path: string;
  dir: string;
  base: string;
  /** Spelled with a trailing separator (`src/`, `ls -F`): only a folder fits. */
  wantsDir: boolean;
}

/**
 * The absolute path `name` names from `dir`, `.` and `..` collapsed — null
 * when it cannot be placed: a relative name with no folder known, `~` (whose
 * home is not known here), a `..` above the root.
 */
export function absPath(name: string, dir: string | null, style: PathStyle): string | null {
  if (name === "" || name.startsWith("~")) return null;
  if (style === "windows") {
    // `\x` hangs off "the current drive", which is not known here.
    if (/^[\\/](?![\\/])/.test(name)) return null;
    return resolveRelative(dir ?? "", name);
  }
  // POSIX: `/` is the only separator — a backslash is part of a name there.
  const absolute = name.startsWith("/");
  if (!absolute && (dir === null || !dir.startsWith("/"))) return null;
  const segs: string[] = [];
  for (const seg of (absolute ? name : `${dir}/${name}`).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return `/${segs.join("/")}`;
}

/**
 * Where `name` points from `lineDir`, split for the listing that confirms it;
 * null as `absPath`, and for a root — no listing has an entry for it.
 */
export function resolveName(name: string, lineDir: string | null, style: PathStyle): Resolved | null {
  const wantsDir = style === "windows" ? /[\\/]$/.test(name) : name.length > 1 && name.endsWith("/");
  const path = absPath(name, lineDir, style);
  if (path === null || isRoot(path)) return null;
  if (style === "windows") return { path, dir: parentOf(path), base: baseName(path), wantsDir };
  const cut = path.lastIndexOf("/");
  return { path, dir: cut === 0 ? "/" : path.slice(0, cut), base: path.slice(cut + 1), wantsDir };
}

/** A run of words a name may span, as one way of reading it. */
export interface Candidate {
  /** First and last word of the run. */
  i: number;
  j: number;
  /** The characters a link would cover. */
  from: number;
  to: number;
  target: Resolved;
  /** The place in the file the output named after the name, if any. */
  line?: number;
}

interface Word {
  start: number;
  end: number;
}

function words(text: string): Word[] {
  const out: Word[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * A name may have spaces in it (BSD `ls` prints `My Notes.txt` as is), so a
 * run of up to this many words is tried as one name.
 */
export const MAX_NAME_WORDS = 6;

/** One way to read some characters as a name. */
interface Reading {
  value: string;
  from: number;
  to: number;
  line?: number;
}

// A place in the file after its name: `x.c:42`, `x.c:42:5`, `x.c:42:5:`
// (grep -n, gcc, rustc, eslint, nginx -t), `x.ts(17,3)` (tsc). The column is
// read past, not kept: the editor opens on the line.
const LOCATION = /(?::(\d+)(?::\d+)?|\((\d+)(?:,\s*\d+)?\)):?$/;
// Python names the line after the name: `File "/srv/app.py", line 17, in main`.
const LINE_AFTER = /^["']?,\s*line\s+(\d+)/;

/** Ways to read the characters `text[from..to)` as a name, the plainest first. */
function readings(text: string, from: number, to: number): Reading[] {
  const out: Reading[] = [];
  const add = (value: string, a: number, b: number, line?: number) => {
    if (value === "" || out.some((r) => r.value === value)) return;
    const after = line === undefined ? LINE_AFTER.exec(text.slice(b)) : null;
    const at = line ?? (after ? Number(after[1]) : undefined);
    const r: Reading = { value, from: a, to: b };
    if (at !== undefined && at >= 1) r.line = at;
    out.push(r);
  };
  // The name with the place after it taken off: the link covers both, as the
  // output printed them, but a trailing colon is punctuation.
  const located = (value: string, a: number, b: number) => {
    const m = LOCATION.exec(value);
    if (!m || m.index === 0) return;
    const end = value.endsWith(":") ? b - 1 : b;
    add(value.slice(0, m.index), a, end, Number(m[1] ?? m[2]));
  };
  const raw = text.slice(from, to);
  // The plain name first: a file really called `notes:12` is that file.
  add(raw, from, to);
  // GNU `ls` quotes a name with spaces or quotes in it (`'my file.txt'`); the
  // link keeps the quotes, the name loses them.
  const quoted = /^(['"])(.+)\1$/.exec(raw);
  if (quoted) add(quoted[2], from, to);
  // `ls -F` marks the kind after the name: `run*`, `src/`, `link@`, `pipe|`.
  // The mark is not underlined; a trailing `/` stays in the name (only a
  // folder fits it).
  if (/[*@|=]$/.test(raw)) add(raw.slice(0, -1), from, to - 1);
  located(raw, from, to);
  // A path in a sentence or a header: `(see /etc/hosts).`, `src:`, and a
  // stack frame `(/app/x.js:12:5)`.
  const lead = /^[(["'<]+/.exec(raw)?.[0].length ?? 0;
  const trail = /[)\]"'>.,;:]+$/.exec(raw.slice(lead))?.[0].length ?? 0;
  if (lead + trail > 0 && lead + trail < raw.length) {
    const core = raw.slice(lead, raw.length - trail);
    located(core, from + lead, to - trail);
    add(core, from + lead, to - trail);
  }
  return out;
}

/**
 * Every way a line can name a file from `lineDir`, ordered for `pickLinks`:
 * by first word, the longest run first, the plainest reading first.
 */
export function lineCandidates(text: string, lineDir: string | null, style: PathStyle): Candidate[] {
  const ws = words(text);
  // A word that starts at a root starts a path of its own: no name runs on
  // into it (`a.txt /etc/hosts` is two names, not a folder called `a.txt `).
  const root = style === "windows" ? /^["'(]?(?:[A-Za-z]:[\\/]|\\\\)/ : /^["'(]?\//;
  const out: Candidate[] = [];
  for (let i = 0; i < ws.length; i++) {
    let reach = Math.min(ws.length, i + MAX_NAME_WORDS) - 1;
    for (let k = i + 1; k <= reach; k++) {
      if (root.test(text.slice(ws[k].start, ws[k].end))) reach = k - 1;
    }
    for (let j = reach; j >= i; j--) {
      for (const r of readings(text, ws[i].start, ws[j].end)) {
        const target = resolveName(r.value, lineDir, style);
        if (!target) continue;
        const c: Candidate = { i, j, from: r.from, to: r.to, target };
        if (r.line) c.line = r.line;
        out.push(c);
      }
    }
  }
  return out;
}

/**
 * How many folders one line may have listed. The folder of the line comes
 * first; the rest are those of paths in it (`find` prints one per line).
 */
export const MAX_DIRS_PER_LINE = 4;

/**
 * The folders whose listings decide the line: `lineDir` first, then those of
 * one-word paths, then the rest — capped, so a line of prose with slashes in
 * it does not list half a server.
 */
export function dirsToList(cands: Candidate[], lineDir: string | null, max = MAX_DIRS_PER_LINE): string[] {
  const out: string[] = [];
  const add = (d: string) => {
    if (out.length < max && !out.includes(d)) out.push(d);
  };
  if (lineDir !== null && cands.some((c) => c.target.dir === lineDir)) add(lineDir);
  for (const c of cands) if (c.i === c.j) add(c.target.dir);
  for (const c of cands) add(c.target.dir);
  return out;
}

// ── Listings ─────────────────────────────────────────────────────────────────

export type EntryKind = "file" | "dir";

/** The names of a folder and what each is. Keys are lower case on Windows. */
export type Listing = Map<string, EntryKind>;

const nameKey = (name: string, style: PathStyle): string =>
  style === "windows" ? name.toLowerCase() : name;

/**
 * What an entry opens as: a folder, a file — or nothing. A FIFO, a socket or
 * a device is no file to read: opening one would block or never end. The
 * SFTP listing reports the type in `mode`; where it does not (a local panel
 * reports the permission bits only), an entry that is no folder is a file.
 */
export function entryKind(entry: { isDir: boolean; mode: number | null }): EntryKind | null {
  if (entry.isDir) return "dir";
  const type = (entry.mode ?? 0) & 0o170000;
  return type === 0 || type === 0o100000 || type === 0o120000 ? "file" : null;
}

export function listingOf(
  entries: { name: string; isDir: boolean; mode: number | null }[],
  style: PathStyle,
): Listing {
  const out: Listing = new Map();
  for (const e of entries) {
    const kind = entryKind(e);
    if (kind) out.set(nameKey(e.name, style), kind);
  }
  return out;
}

/** A stretch of a line that names a confirmed file or folder. */
export interface FileSpan {
  from: number;
  to: number;
  target: NamedPath;
}

/**
 * The names the listings confirm, left to right and never overlapping: at
 * each word the longest run that names an entry wins. `listing(dir)` is
 * undefined for a folder not listed (or not readable) — its names stay text.
 * Folders are links only when `dirs` (the file panel can show them).
 */
export function pickLinks(
  cands: Candidate[],
  listing: (dir: string) => Listing | undefined,
  style: PathStyle,
  dirs: boolean,
): FileSpan[] {
  const byWord = new Map<number, Candidate[]>();
  for (const c of cands) {
    const at = byWord.get(c.i);
    if (at) at.push(c);
    else byWord.set(c.i, [c]);
  }
  const out: FileSpan[] = [];
  const last = cands.reduce((n, c) => Math.max(n, c.j), -1);
  for (let i = 0; i <= last; i++) {
    for (const c of byWord.get(i) ?? []) {
      const kind = listing(c.target.dir)?.get(nameKey(c.target.base, style));
      if (!kind || (kind === "dir" && !dirs) || (c.target.wantsDir && kind !== "dir")) continue;
      // A line is a place in a file; a folder has none.
      const target: NamedPath =
        kind === "file" && c.line ? { kind, path: c.target.path, line: c.line } : { kind, path: c.target.path };
      out.push({ from: c.from, to: c.to, target });
      i = c.j;
      break;
    }
  }
  return out;
}

// ── Where a block of output stands ───────────────────────────────────────────

/** What a listing command asked for. */
export interface ListingCommand {
  /** The one folder it was given, as typed; null — the folder it ran in. */
  dir: string | null;
  /** It lists several folders (`ls a b`, `ls -R`, a glob): its headers place
   *  the lines under them. */
  several: boolean;
}

const LISTERS = "ls|ll|la|l|dir|vdir|gci|get-childitem|exa|eza|lsd";
// The command starts after the prompt: at the line's start or after the
// character a prompt ends with (`$ `, `# `, `% `, `> `, `C:\x>`, `❯ `).
const COMMAND = new RegExp(`(?:^|[$#%>❯»➜λ✗✔→]\\s*)(${LISTERS})(?=\\s|$)(.*)$`, "i");

function args(rest: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * The listing command on a command line, or null for any other command. A
 * line of the prompt and what was typed after it; which part is which is a
 * guess — that is why it only ever narrows the folder a name is looked up
 * in, and the listing still has to confirm the name.
 */
export function listingCommand(line: string, style: PathStyle): ListingCommand | null {
  const m = COMMAND.exec(line);
  if (!m) return null;
  const paths: string[] = [];
  let recursive = false;
  let options = true;
  for (const a of args(m[2])) {
    if (options && a === "--") {
      options = false;
      continue;
    }
    const isOption = options && (a.startsWith("-") || (style === "windows" && a.startsWith("/")));
    if (isOption) {
      // `ls -R`/`-laR`/`--recursive`, PowerShell `-Recurse`, cmd `dir /s`
      // (POSIX `-s` is the block size, not recursion).
      const deep =
        /^-[a-zA-Z]*R/.test(a) ||
        a === "--recursive" ||
        (style === "windows" && (/^\/s$/i.test(a) || /^-recurse$/i.test(a)));
      if (deep) recursive = true;
      continue;
    }
    paths.push(a);
  }
  const glob = paths.some((p) => /[*?[]/.test(p));
  const several = recursive || glob || paths.length > 1;
  return { dir: !several && paths.length === 1 ? paths[0] : null, several };
}

/**
 * The folder a listing header names: `dir`'s ` Directory of C:\x`,
 * PowerShell's `    Directory: C:\x` (whatever the language of the label),
 * or `ls a b`'s `a:` — the last only where the command listed several.
 */
export function headerDir(line: string, style: PathStyle, several: boolean): string | null {
  if (style === "windows") {
    const m = /^\s*\S.{0,40}?\s([A-Za-z]:\\[^<>|?*"]*?)\s*$/.exec(line);
    return m ? m[1] : null;
  }
  if (!several) return null;
  const m = /^(\S(?:.*\S)?):$/.exec(line);
  return m ? m[1] : null;
}

/**
 * The folder the names of a listing line are looked up in: the nearest
 * header above it in the block, else the folder the command named, else the
 * folder it ran in. `dir` from the command is resolved from `cwd`.
 */
export function listingDir(
  cwd: string | null,
  cmd: ListingCommand | null,
  header: string | null,
  style: PathStyle,
): string | null {
  if (header !== null) return absPath(header, cwd, style);
  if (cmd?.dir) return absPath(cmd.dir, cwd, style);
  return cwd;
}

// ── A listing nobody can place ───────────────────────────────────────────────

// `ls -l` puts the name after the date: `Oct 28 14:03`, `28 окт 2025`,
// `2026-10-28 14:03` (long-iso), `2026-10-28 14:03:05.123 +0300` (full-iso).
const LONG_DATE =
  /(?:\s(?:\p{L}{3,5}\.?\s+\d{1,2}|\d{1,2}\s+\p{L}{3,5}\.?)\s+(?:\d{1,2}:\d{2}|\d{4})|\s\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s+[+-]\d{4})?)\s+(?=\S)/u;
const LONG_LINE = /^[-bcdlpsDn?][-rwxsStTlL]{9}[.+@]?\s/;
const NOT_A_NAME = /^(?:[\d.,:]+[KMGTPkmgtp]?i?B?|total|итого)$/;

/**
 * The names in a line of a listing whose folder is unknown: after the date
 * of an `ls -l` line (without its `-> target`), else each word that does not
 * read as a number. Nothing is confirmed here — these spans only offer path
 * sync, which is what would let them be confirmed.
 */
export function unplacedNames(text: string): { from: number; to: number }[] {
  if (LONG_LINE.test(text)) {
    const m = LONG_DATE.exec(text);
    if (!m) return [];
    const from = m.index + m[0].length;
    const arrow = text.indexOf(" -> ", from);
    const to = arrow < 0 ? text.length : arrow;
    return to > from ? [{ from, to }] : [];
  }
  return words(text)
    .filter((w) => !NOT_A_NAME.test(text.slice(w.start, w.end)))
    .map((w) => ({ from: w.start, to: w.end }));
}

// ── Blocks ───────────────────────────────────────────────────────────────────

/**
 * The block a buffer line belongs to: the last one that starts at or above
 * it. `starts` are the 0-based lines blocks start on, in order; -1 when the
 * line comes before the first.
 */
export function blockAt(starts: number[], line: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= line) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
