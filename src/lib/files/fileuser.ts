// Whom the file panel works as, against who the terminal is (v1.26, ADR 0047).
//
// `su` in the terminal changes nothing for SFTP, a channel of its own logged in as
// the connection's user: a transfer then runs as someone the user is no longer
// thinking of. The backend reads who the terminal is from the server's process tree
// and can run the panel through `sudo`; this decides what the panel says about it.
//
// The panel never follows by itself: what it creates as root stays root's, so
// taking on a user is a button and a question. Going back drops rights and is a
// button alone.

/** What the backend reports (`shell_user`). */
export interface ShellUserReport {
  /** Whom the file panel works as. */
  files: string | null;
  /** Whom the connection logged in as. */
  login: string | null;
  /** Who the terminal is; null when unknown or hidden. */
  shell: string | null;
  /** The terminal is someone else, and the server hides who (`hidepid`). */
  hidden: boolean;
}

/** What the panel shows above its list. */
export interface FileUserRow {
  files: string;
  /** The terminal's user, when it is not whom the files are. */
  shell: string | null;
  hidden: boolean;
  /** Take the terminal's user on. */
  openAs: string | null;
  /** Back to the login user. */
  back: string | null;
}

/**
 * The row for a report, or null when there is nothing to say: files and terminal
 * agree under the login user, or nobody knows who the terminal is — an unknown is
 * no reason to speak (Principle 5). A hidden user cannot be taken on: no name.
 */
export function fileUserRow(r: ShellUserReport | null): FileUserRow | null {
  if (!r?.files) return null;
  const switched = r.login !== null && r.files !== r.login;
  const differs = r.shell !== null && r.shell !== r.files;
  if (!switched && !differs && !r.hidden) return null;
  return {
    files: r.files,
    shell: differs ? r.shell : null,
    hidden: r.hidden,
    openAs: differs && r.shell !== r.login ? r.shell : null,
    back: switched ? r.login : null,
  };
}

/** How often the panel asks while it is on screen: `exit` by Ctrl+D sends no Enter. */
export const SHELL_USER_POLL_MS = 15_000;
/** How long after an Enter it asks: `su` takes a moment to start the shell. */
export const AFTER_ENTER_MS = 1_000;

/** What became of asking to work as someone. */
export type FileUserFailure =
  | { kind: "needPassword" }
  | { kind: "wrongPassword" }
  | { kind: "refused"; reason: string }
  | { kind: "noServer" }
  | { kind: "other"; text: string };

/** Reads the backend's markers (`AppError`). */
export function fileUserFailure(e: unknown): FileUserFailure {
  const text = String(e);
  if (text.startsWith("sudo-password:")) return { kind: "needPassword" };
  if (text.startsWith("sudo-rejected:")) return { kind: "wrongPassword" };
  if (text.startsWith("sudo-refused:")) return { kind: "refused", reason: text.slice("sudo-refused:".length).trim() };
  if (text.startsWith("sftp-server-missing:")) return { kind: "noServer" };
  return { kind: "other", text };
}
