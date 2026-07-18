// Building the `cd` line that the file panel types into the terminal for two-way
// "follow terminal" sync (Phase 39.4). Pure and DOM-free so the quoting rules —
// the risky part — are unit-tested (ADR 0003).
//
// SFTP has had this since Phase 29: navigating in the panel `cd`s the remote
// shell to match. Local tabs did not, and could not simply reuse the SFTP code:
// the remote end is always POSIX, whereas a local tab may be running cmd.exe or
// PowerShell, where the POSIX form is wrong in ways that actively misfire.
//
//   * **cmd.exe** does not treat `'` as quoting at all, so `cd 'C:\Users'` tries
//     to enter a directory whose name literally begins with a quote. It also
//     needs `/d` to change *drive*: plain `cd D:\x` from `C:` silently changes
//     D:'s working directory without moving you there — the panel and the shell
//     would then disagree, which is exactly what this feature exists to prevent.
//   * **PowerShell** does accept single quotes, but escapes an embedded quote by
//     doubling it (`''`), not the POSIX `'\''`. It also glob-expands `[`/`]` in a
//     path unless `-LiteralPath` is used, and brackets are legal in filenames.

/** Which quoting/`cd` dialect a terminal expects. */
export type CdShell = "posix" | "powershell" | "cmd";

/**
 * Classify the program a local tab actually spawned. `program` is what
 * `resolveLocalShell` returned — `null` meaning "the OS default", which is
 * `%ComSpec%` (cmd.exe) on Windows and `$SHELL` on Unix.
 *
 * Matching is on the file name, so a full path like
 * `C:\Program Files\PowerShell\7\pwsh.exe` classifies correctly.
 */
export function cdShellKind(os: string, program: string | null): CdShell {
  const windows = os === "windows";
  const name = (program ?? "").trim().toLowerCase().replace(/^.*[\\/]/, "");
  if (!name) return windows ? "cmd" : "posix"; // OS default
  if (name.startsWith("pwsh") || name.startsWith("powershell")) return "powershell";
  // A POSIX shell can be installed on Windows (Git Bash, MSYS, WSL wrappers) and
  // then wants POSIX quoting despite the host OS.
  if (/^(bash|zsh|sh|fish|dash|ksh|busybox)/.test(name)) return "posix";
  if (name.startsWith("cmd")) return "cmd";
  return windows ? "cmd" : "posix";
}

/** POSIX single-quoting: close, escape, reopen — the only safe general form. */
function posixQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * The command to type into `shell` to move it to `path`, WITHOUT a trailing
 * newline (the caller adds one). Returns null when the path can't be expressed
 * safely, in which case the caller must send nothing rather than a broken line.
 */
export function cdCommand(path: string, shell: CdShell): string | null {
  if (!path.trim()) return null;
  // A newline in a path would turn one command into two — never emit that.
  if (/[\r\n]/.test(path)) return null;
  switch (shell) {
    case "posix":
      return `cd ${posixQuote(path)}`;
    case "powershell":
      // -LiteralPath so `[`/`]` in a name aren't treated as a wildcard; PowerShell
      // escapes an embedded single quote by doubling it.
      return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'`;
    case "cmd":
      // `/d` also switches drive; double quotes are the only quoting cmd has.
      // A `"` cannot appear in a Windows path (illegal character), so wrapping is
      // always safe. Note: a literal `%VAR%` in a path would be expanded by the
      // interactive parser and there is no escape for it — vanishingly rare, and
      // the visible failure is a wrong `cd`, not a destructive action.
      return `cd /d "${path}"`;
  }
}
