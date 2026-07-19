// How vterm submits a command into a terminal (Phase 39.5).
//
// The bug this fixes: every call site appended `"\n"` (LF), and on Windows the
// command appeared on the prompt but never ran. LF is not what pressing Enter
// sends — a terminal sends **CR** (0x0D). Our own `history.ts` already knows
// this (it checks `"\r"` first when detecting a committed line), but the
// write-a-command paths didn't.
//
// It worked on Linux/macOS by accident: an interactive shell's line editor
// (readline in bash, ZLE in zsh) binds Ctrl+J — which is LF — to accept-line as
// well as Ctrl+M/CR. Windows has no such courtesy: PSReadLine and cmd.exe accept
// only CR, so LF got inserted into the line buffer and sat there. Sending CR is
// therefore not a Windows workaround but the correct thing everywhere, because it
// is exactly what the user's own keypress produces.
//
// Multi-line blocks matter too: an AI-suggested script sent with internal LFs
// would submit only its final line on Windows, silently running the wrong thing.
// So `submitBlock` converts every line ending, not just the trailing one.

/** The byte a terminal sends when the user presses Enter. */
export const SUBMIT = "\r";

/**
 * A single command, terminated so the shell runs it. Not trimmed — leading or
 * trailing spaces are the caller's (and often the user's) decision, and a leading
 * space is deliberately used to keep a command out of shell history.
 */
export function submitLine(cmd: string): string {
  return cmd + SUBMIT;
}

/**
 * A multi-line block, with **every** line ending normalised to CR so each line is
 * submitted in turn, plus a final CR to run the last one. Trailing blank lines are
 * dropped so the shell doesn't get a run of empty prompts.
 */
export function submitBlock(block: string): string {
  const body = block.replace(/\r\n?/g, "\n").replace(/\n+$/u, "");
  if (!body) return "";
  return body.replace(/\n/g, SUBMIT) + SUBMIT;
}
