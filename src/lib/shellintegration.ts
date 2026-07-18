// Shell-integration bootstrap for the "follow terminal" feature. Most shells don't
// emit OSC 7 — the escape that reports the working directory — by default, so the
// panels can't follow `cd`. With the user's explicit consent (a confirm dialog) we
// type this one-liner into the *current* shell session so each new prompt reports
// the cwd. Session-only: nothing is written to the server. Kept as a plain constant
// so the dialog can show exactly what runs.
//
// Phase 39.3 narrowed this to **SSH tabs only**. A local tab needs no shell
// cooperation at all any more: we own the pty, so the cwd is read straight from the
// OS (`local_cwd` → proccwd.rs). That matters because the default shells people
// actually use are silent — measured on a stock Mac, zsh emits OSC 7 zero times,
// because the emitter lives in /etc/zshrc_Apple_Terminal and only loads when
// $TERM_PROGRAM says Apple_Terminal; PowerShell and cmd.exe emit nothing ever.

/**
 * bash/zsh snippet that makes the shell emit OSC 7 (cwd) on every prompt.
 * - Leading space keeps it out of history (Ubuntu's default `HISTCONTROL=ignoreboth`).
 * - Idempotent: re-running is a no-op (bash guard / `add-zsh-hook`).
 * - Calls the emitter once at the end to sync the current directory immediately.
 * `fish` already emits OSC 7 natively, so it never needs this.
 */
export const OSC7_SETUP =
  " __vtcwd(){ printf '\\033]7;file://%s%s\\a' \"${HOSTNAME:-}\" \"$PWD\"; }; " +
  "if [ -n \"$ZSH_VERSION\" ]; then autoload -Uz add-zsh-hook && add-zsh-hook precmd __vtcwd; " +
  "else case \";$PROMPT_COMMAND;\" in *\";__vtcwd;\"*) ;; " +
  "*) PROMPT_COMMAND=\"__vtcwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\";; esac; fi; __vtcwd";

/** The command as shown in the confirm dialog (leading history-guard space trimmed). */
export function osc7SetupDisplay(): string {
  return OSC7_SETUP.trim();
}

/**
 * Whether enabling "follow terminal" still has to ask the user to run
 * {@link OSC7_SETUP} in their shell (Phase 39.3).
 *
 * False for a **local** tab whatever the shell does: its cwd is polled from the OS,
 * so there is nothing to set up and no dialog to show. False for an SSH tab that
 * already announced a cwd (the shell emits OSC 7 by itself — many Linux hosts ship
 * `/etc/profile.d/vte.sh`) or where we already typed the snippet this session.
 * Only the remaining case — an SSH tab whose shell has said nothing — needs asking.
 */
export function needsShellSetup(
  kind: "ssh" | "local" | undefined,
  hasReportedCwd: boolean,
  alreadyIntegrated: boolean,
): boolean {
  if (kind === "local") return false;
  return !hasReportedCwd && !alreadyIntegrated;
}
