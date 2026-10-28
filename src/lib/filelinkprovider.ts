// File links in one terminal (v1.24, ADR 0035): the xterm side of termfiles.ts.
//
// Three jobs, all for the terminal that creates it:
//
//   * blocks — a marker at the line each command was sent from, with the
//     folder it ran in. Taken when the line is sent (`noteSubmit`, fed by
//     every write that carries Enter): on a local tab the backend notes the
//     shell's folder just before the bytes reach it, and only while the shell
//     itself holds the terminal (a line typed into `ssh` or a REPL is that
//     program's). Over SSH — and in PowerShell, whose process folder does not
//     follow `cd` — the folder is the one the shell reported (OSC 7/9;9)
//     since the last command, and unknown when it reported none: a line sent
//     before the next report went to whatever the last command started;
//   * links — for a hovered line, the names its folder's listing confirms
//     (listings are cached briefly and dropped on every command, which may
//     have changed them);
//   * the click — never with a selection (dragging across a name selects
//     it), never on the first click of a double-click (which selects the
//     name), only with ⌘/Ctrl in modifier mode.

import type { IBufferLine, ILink, ILinkProvider, IMarker, Terminal } from "@xterm/xterm";
import type { CdShell } from "./cdterminal";
import type { FileEntry } from "./types";
import {
  blockAt,
  clickOpens,
  dirsToList,
  DOUBLE_CLICK_MS,
  headerDir,
  lineCandidates,
  lineText,
  listingCommand,
  listingDir,
  listingOf,
  pickLinks,
  resolveName,
  spanRange,
  unplacedNames,
  type FileLinkClick,
  type FileLinkTarget,
  type Listing,
  type PathStyle,
} from "./termfiles";

/** What the terminal tells the provider, read when needed. */
export interface FileLinkHost {
  /** A local shell rather than SSH. */
  local: boolean;
  style(): PathStyle;
  /** The dialect of the local shell (PowerShell's process folder is stale). */
  shell(): CdShell;
  /** Folders are links: the file panel can show them. */
  dirs(): boolean;
  click(): FileLinkClick;
  mac(): boolean;
  /** A link was clicked (and the click counts). */
  open(target: FileLinkTarget): void;
  list(dir: string): Promise<FileEntry[]>;
  /** Local tabs: the folder the last line sent ran in (`local_submitted_cwd`). */
  submittedCwd(): Promise<string | null>;
}

/** The part of xterm the provider uses — a fake one stands in for tests. */
export type LinkTerminal = Pick<Terminal, "buffer" | "cols" | "modes" | "registerMarker" | "hasSelection">;

export interface FileLinks {
  provider: ILinkProvider;
  /** A line carrying Enter was sent to the session; `written` settles once it got there. */
  noteSubmit(written: Promise<void>): void;
  /** The shell reported its folder (OSC 7 / OSC 9;9). */
  noteCwd(path: string): void;
  /** What a selection on buffer row `row` (0-based) names, for the menu. */
  targetOf(text: string, row: number): Promise<FileLinkTarget | null>;
  dispose(): void;
}

interface Block {
  marker: IMarker;
  /** undefined while the backend is asked. */
  cwd: string | null | undefined;
}

/** Commands kept; each one is a marker in xterm. */
const MAX_BLOCKS = 2000;
/** A listing answers for this long — and never past the next command. */
const LISTING_TTL_MS = 5000;
const MAX_LISTINGS = 32;
/** How far above a line a listing header is looked for. */
const HEADER_REACH = 3000;
/** How many rows a wrapped line may span and still be read. */
const MAX_WRAPPED_ROWS = 20;

export function createFileLinks(term: LinkTerminal, host: FileLinkHost): FileLinks {
  let blocks: Block[] = [];
  let reported: string | null = null;
  // The shell reported its folder after the last line it was sent: it stands
  // at its prompt, and the next line runs there.
  let armed = false;
  const listings = new Map<string, { at: number; listing: Promise<Listing | undefined> }>();
  let pending: ReturnType<typeof setTimeout> | undefined;

  const live = (): Block[] => {
    if (blocks.some((b) => b.marker.isDisposed)) blocks = blocks.filter((b) => !b.marker.isDisposed);
    return blocks;
  };

  function listing(dir: string): Promise<Listing | undefined> {
    const now = Date.now();
    const hit = listings.get(dir);
    if (hit && now - hit.at < LISTING_TTL_MS) return hit.listing;
    const style = host.style();
    const fresh = host.list(dir).then(
      (entries) => listingOf(entries, style),
      () => undefined,
    );
    listings.delete(dir);
    listings.set(dir, { at: now, listing: fresh });
    while (listings.size > MAX_LISTINGS) listings.delete(listings.keys().next().value as string);
    return fresh;
  }

  /** The rows of the logical line holding row `y` (0-based): first row and rows. */
  function logical(y: number): { first: number; rows: IBufferLine[] } {
    const buf = term.buffer.active;
    let first = y;
    while (first > 0 && y - first < MAX_WRAPPED_ROWS && buf.getLine(first)?.isWrapped) first--;
    const rows: IBufferLine[] = [];
    for (let r = first; rows.length < MAX_WRAPPED_ROWS; r++) {
      const row = buf.getLine(r);
      if (!row || (r > first && !row.isWrapped)) break;
      rows.push(row);
    }
    return { first, rows };
  }

  const textAt = (y: number): string => lineText(logical(y).rows, term.cols).text;

  /** Where a line at row `first` stands: the folder its names are read in. */
  function place(first: number) {
    const style = host.style();
    const all = live();
    const at = blockAt(
      all.map((b) => b.marker.line),
      first,
    );
    const block = at >= 0 ? all[at] : null;
    const cwd = block?.cwd ?? null;
    const cmd = block ? listingCommand(textAt(block.marker.line), style) : null;
    let header: string | null = null;
    if (block && cmd) {
      const stop = Math.max(block.marker.line + 1, first - HEADER_REACH);
      for (let y = first - 1; y >= stop && header === null; y--) {
        header = headerDir(textAt(y), style, cmd.several);
      }
    }
    const dir = listingDir(cwd, cmd, header, style);
    // `ls -l notes.txt` names a file, not a folder: its line reads where the
    // command ran when the named "folder" has no listing.
    const fallback = header === null && cmd?.dir ? cwd : null;
    return { style, cmd, dir, fallback, start: block?.marker.line ?? -1 };
  }

  /** The confirmed names of a line, against `dir` (and its fallback). */
  async function confirmed(text: string, dir: string | null, fallback: string | null, style: PathStyle) {
    const read = async (from: string | null) => {
      const cands = lineCandidates(text, from, style);
      const dirs = dirsToList(cands, from);
      const got = new Map<string, Listing | undefined>();
      await Promise.all(dirs.map(async (d) => got.set(d, await listing(d))));
      return { cands, got, missing: from !== null && !got.get(from) };
    };
    let r = await read(dir);
    if (r.missing && fallback !== null && fallback !== dir) r = await read(fallback);
    return pickLinks(r.cands, (d) => r.got.get(d), style, host.dirs());
  }

  function activate(event: MouseEvent, target: FileLinkTarget): void {
    clearTimeout(pending);
    pending = undefined;
    if (term.hasSelection() || !clickOpens(host.click(), event, host.mac())) return;
    // The second click of a double-click: it selects the name.
    if (event.detail > 1) return;
    if (host.click() === "modifier") {
      host.open(target);
      return;
    }
    pending = setTimeout(() => {
      pending = undefined;
      if (!term.hasSelection()) host.open(target);
    }, DOUBLE_CLICK_MS);
  }

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const buf = term.buffer.active;
      // A full-screen program owns its screen, and one that takes the mouse
      // takes the clicks.
      if (buf.type !== "normal" || term.modes.mouseTrackingMode !== "none") {
        callback(undefined);
        return;
      }
      const { first, rows } = logical(bufferLineNumber - 1);
      const cols = term.cols;
      const line = lineText(rows, cols);
      if (line.text === "") {
        callback(undefined);
        return;
      }
      const { style, cmd, dir, fallback, start } = place(first);
      void confirmed(line.text, dir, fallback, style)
        .then((spans) => {
          // The line may have been rewritten while the listings were asked.
          if (lineText(logical(first).rows, cols).text !== line.text) return undefined;
          const links: ILink[] = spans.map((s) => ({
            range: spanRange(line, s.from, s.to, cols, first),
            text: line.text.slice(s.from, s.to),
            activate: (event) => activate(event, s.target),
          }));
          // Over SSH, a listing whose folder nobody reported: its names offer
          // path sync — the one thing that would let them open. Not on the
          // command's own line: that is the prompt and what was typed.
          if (!host.local && cmd && dir === null && first !== start) {
            const taken = (from: number, to: number) => spans.some((s) => s.from < to && from < s.to);
            for (const n of unplacedNames(line.text)) {
              if (taken(n.from, n.to)) continue;
              links.push({
                range: spanRange(line, n.from, n.to, cols, first),
                text: line.text.slice(n.from, n.to),
                activate: (event) => activate(event, { kind: "unplaced" }),
              });
            }
          }
          return links.length ? links : undefined;
        })
        .catch(() => undefined)
        .then(callback);
    },
  };

  return {
    provider,
    noteSubmit(written) {
      listings.clear();
      const fromReport = armed ? reported : null;
      armed = false;
      // Enter inside vim or less is no command of the shell's.
      if (term.buffer.active.type !== "normal") return;
      const marker = term.registerMarker(0);
      if (!marker) return;
      const block: Block = { marker, cwd: undefined };
      blocks.push(block);
      while (blocks.length > MAX_BLOCKS) blocks.shift()?.marker.dispose();
      if (host.local && host.shell() !== "powershell") {
        written.then(() => host.submittedCwd()).then(
          (cwd) => (block.cwd = cwd),
          () => (block.cwd = null),
        );
      } else {
        block.cwd = fromReport;
      }
    },
    noteCwd(path) {
      reported = path;
      armed = true;
    },
    async targetOf(text, row) {
      const name = text.trim();
      if (name === "" || name.includes("\n")) return null;
      const { first } = logical(row);
      const { style, cmd, dir, fallback, start } = place(first);
      const spans = await confirmed(name, dir, fallback, style);
      const whole = spans.find((s) => s.from === 0 && s.to === name.length);
      if (whole) return whole.target;
      if (!host.local && cmd && dir === null && first !== start && resolveName(name, null, style) === null) {
        return { kind: "unplaced" };
      }
      return null;
    },
    dispose() {
      clearTimeout(pending);
      for (const b of blocks) b.marker.dispose();
      blocks = [];
      listings.clear();
    },
  };
}
