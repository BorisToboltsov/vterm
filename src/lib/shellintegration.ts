// Shell-integration bootstrap for the "follow terminal" feature. Most SSH shells
// (Ubuntu 24.04 / OEL9 bash, etc.) don't emit OSC 7 — the escape that reports the
// working directory — by default, so the panels can't follow `cd`. With the user's
// explicit consent (a confirm dialog) we type this one-liner into the *current*
// shell session so each new prompt reports the cwd. Session-only: nothing is written
// to the server. Kept as a plain constant so the dialog can show exactly what runs.

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
