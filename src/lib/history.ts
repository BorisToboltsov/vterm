// Pure helpers for the Ctrl+R command-history overlay (Phase 23). The backend
// reads the current session's shell history file (`~/.zsh_history` /
// `~/.bash_history`) over the existing SSH connection (or locally for a shell
// tab); here we parse that raw text into a clean, newest-first, de-duplicated
// command list and filter it as the user types. Kept DOM-free so it's unit-
// tested without a terminal (ADR 0003).

/** zsh EXTENDED_HISTORY line: `: <started>:<elapsed>;<command>`. */
const ZSH_EXTENDED = /^: \d+:\d+;(.*)$/;
/** bash timestamp marker line (with `HISTTIMEFORMAT`): `#1700000000`. */
const BASH_TIMESTAMP = /^#\d+$/;

/**
 * Parse raw shell-history text into commands in file order (oldest → newest).
 * Handles both formats:
 *  - zsh `EXTENDED_HISTORY` (`: ts:elapsed;cmd`) — the metadata prefix is
 *    stripped, and a command split across lines by a trailing backslash is
 *    rejoined (zsh stores the literal `\` + newline).
 *  - bash / plain zsh — one command per line; bash `#<epoch>` timestamp lines
 *    (written under `HISTTIMEFORMAT`) are skipped.
 * Blank lines are dropped; CRLF is normalised.
 */
export function parseShellHistory(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const zsh = ZSH_EXTENDED.exec(line);
    let cmd = zsh ? zsh[1] : line;
    if (!zsh && BASH_TIMESTAMP.test(line)) continue;
    // Rejoin backslash-continued commands (zsh writes `foo \` then the rest).
    while (/(^|[^\\])(\\\\)*\\$/.test(cmd) && i + 1 < lines.length) {
      cmd = `${cmd.slice(0, -1)}\n${lines[++i]}`;
    }
    cmd = cmd.replace(/\s+$/, "");
    if (cmd.trim()) out.push(cmd);
  }
  return out;
}

/**
 * Commands newest-first with duplicates removed, keeping each command at its
 * most-recent position — the natural order for a Ctrl+R recall list. Given raw
 * history text (oldest → newest in the file), the last occurrence of a repeated
 * command wins.
 */
export function recentUniqueCommands(text: string): string[] {
  const parsed = parseShellHistory(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = parsed.length - 1; i >= 0; i--) {
    const cmd = parsed[i];
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

/**
 * Case-insensitive substring filter over the command list, preserving order.
 * An empty query returns the list unchanged. Whitespace in the query is matched
 * literally after trimming the ends, so `git  push` still finds `git  push`.
 */
export function filterCommands(commands: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.toLowerCase().includes(q));
}

/**
 * Merge several command lists (highest priority first) into one, keeping the
 * first occurrence of each command. Used to surface the live session's just-typed
 * commands (client capture) above the shell history file in the Ctrl+R overlay.
 */
export function mergeCommands(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const cmd of list) {
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      out.push(cmd);
    }
  }
  return out;
}

/**
 * A stateful reducer over the terminal *input* stream (`term.onData`) that
 * reconstructs the command lines the user types this session — the client-side
 * source for the Ctrl+R overlay, so current-session commands show up immediately
 * (a bash history file is only flushed on shell exit). Precision over recall: a
 * line is committed only when the user pressed Enter without cursor navigation or
 * tab-completion, since those edit the line via output we can't observe. Feed raw
 * input chunks; each call returns the commands committed in that chunk.
 *
 * Handled controls: Backspace/DEL, Ctrl-U (kill line), Ctrl-W (kill word), Ctrl-C
 * /Ctrl-G (cancel). Escape sequences (arrows, Home/End) and Tab / Ctrl-A / Ctrl-E
 * mark the line "dirty" so it's dropped rather than captured wrong.
 */
export function createCommandCapture(): { feed(data: string): string[] } {
  let buf = "";
  let dirty = false;
  // Escape-sequence tracking so cursor keys don't land in the buffer.
  let esc: "none" | "esc" | "csi" = "none";

  function feed(data: string): string[] {
    const emitted: string[] = [];
    for (const ch of data) {
      const c = ch.codePointAt(0) ?? 0;
      if (esc === "esc") {
        esc = ch === "[" || ch === "O" ? "csi" : "none";
        continue;
      }
      if (esc === "csi") {
        // CSI ends on a final byte @–~ (0x40–0x7e); params/intermediates before it.
        if (c >= 0x40 && c <= 0x7e) esc = "none";
        continue;
      }
      if (c === 0x1b) {
        esc = "esc";
        dirty = true; // cursor navigation / history recall — distrust the line
      } else if (ch === "\r" || ch === "\n") {
        const cmd = buf.trim();
        if (!dirty && cmd) emitted.push(cmd);
        buf = "";
        dirty = false;
      } else if (c === 0x7f || c === 0x08) {
        buf = buf.slice(0, -1); // Backspace / DEL
      } else if (c === 0x15) {
        buf = ""; // Ctrl-U — kill line
      } else if (c === 0x17) {
        buf = buf.replace(/\s*\S*$/, ""); // Ctrl-W — kill previous word
      } else if (c === 0x03 || c === 0x07) {
        buf = ""; // Ctrl-C / Ctrl-G — cancel; the line was never run
        dirty = false;
      } else if (c === 0x09 || c === 0x01 || c === 0x05) {
        dirty = true; // Tab completion / Ctrl-A / Ctrl-E — line becomes unreliable
      } else if (c >= 0x20) {
        buf += ch; // printable (incl. multi-byte)
      }
      // Other control bytes are ignored.
    }
    return emitted;
  }

  return { feed };
}
