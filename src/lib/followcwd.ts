// "Follow terminal" as one switch for the whole dock (v1.0.24). While it is on,
// the terminal's cwd moves the dock's shared directory (`dockstate.cwd`), which the
// file panel follows and git reads. This decides *when* a terminal cwd is written.
//
// Only a change counts. The caller re-runs on any session's update, and rewriting
// an unchanged cwd would snap a session back over a folder the user has since
// opened in the file panel — e.g. the mirrored `cd` never ran because the terminal
// was busy in vim. Switching following on counts as a change (the entry in `seen`
// is dropped while off), so the dock jumps to the terminal at once.

/**
 * The `[sessionId, cwd]` pairs to write into the dock's shared directory now.
 * `seen` is the caller's per-session memory of the last cwd written; it is
 * updated in place (and must be cleared with the tab — see `closeTabFully`).
 */
export function followUpdates(
  following: Record<string, boolean>,
  terminalCwd: Record<string, string | undefined>,
  seen: Record<string, string | undefined>,
): [string, string][] {
  const out: [string, string][] = [];
  for (const [id, on] of Object.entries(following)) {
    if (!on) {
      delete seen[id];
      continue;
    }
    const cwd = terminalCwd[id];
    if (cwd && seen[id] !== cwd) {
      seen[id] = cwd;
      out.push([id, cwd]);
    }
  }
  return out;
}

/**
 * The directory the git panel works on (v1.0.35). While "follow terminal" is on
 * the terminal and the file panel move together, so git reads the dock's shared
 * directory — a folder opened in the file panel counts even if the mirrored `cd`
 * never reached a busy shell. While it is off, git follows the terminal alone:
 * the file panel's listing (home, on connect) says nothing about where the user
 * is working. An unknown terminal cwd is `null`, never the panel's folder —
 * that fallback showed "not a git repository" for the folder the session
 * started in.
 */
export function gitCwd(
  following: boolean,
  dockCwd: string | null,
  terminalCwd: string | null,
): string | null {
  return (following ? dockCwd : terminalCwd) || null;
}

/**
 * Whether a local tab's cwd has to be polled from the OS right now: while
 * following (the file panel tracks it) or while the git panel is on screen (git
 * tracks it with following off). SSH has no local pid — its cwd arrives by OSC 7.
 */
export function pollsLocalCwd(
  kind: "ssh" | "local" | undefined,
  following: boolean,
  gitShown: boolean,
): boolean {
  return kind === "local" && (following || gitShown);
}
