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
