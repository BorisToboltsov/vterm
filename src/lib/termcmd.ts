// Rendering an argv into the command line typed into a terminal tab. Pure and
// DOM-free so the quoting — the risky part — is unit-tested (ADR 0003).
//
// The Docker/k8s panels open a shell in a container by typing `docker exec …`
// into a NEW tab. On a local Windows tab that tab runs cmd.exe or PowerShell,
// and the POSIX form `sh -c '… >/dev/null 2>&1 && exec bash || exec sh'` misfires
// in cmd.exe: `'` is not quoting there, so cmd itself parses `>/dev/null` as a
// redirect into a missing path and splits the line at `&&`, running `exec bash`
// as its own command. So the panels hand over argv, and the page renders it for
// the shell the tab actually spawned (the same dialect `cdCommand` uses).
import type { CdShell } from "./cdterminal";

/** In-container script for "open shell": prefer bash, fall back to sh on minimal images. */
export const SHELL_SCRIPT = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";

// Tokens that mean the same thing bare in each dialect. Anything else is quoted.
const SAFE: Record<CdShell, RegExp> = {
  posix: /^[A-Za-z0-9_@%+=:,./-]+$/,
  // No `,` (array operator) and no leading `@` (splatting) in PowerShell.
  powershell: /^[A-Za-z0-9_+=:./-]+$/,
  // No `%` (variable expansion) and none of cmd's `&|<>^()` metacharacters.
  cmd: /^[A-Za-z0-9_@+=:,./\\-]+$/,
};

function quote(arg: string, shell: CdShell): string | null {
  // `--` bare is PowerShell's own end-of-parameters marker, which older versions
  // strip before calling a native program — kubectl would then never see it.
  if (SAFE[shell].test(arg) && !(shell === "powershell" && arg === "--")) return arg;
  switch (shell) {
    case "posix":
      return `'${arg.replace(/'/g, "'\\''")}'`;
    case "powershell":
      return `'${arg.replace(/'/g, "''")}'`;
    case "cmd":
      // Double quotes are the only quoting cmd has and there is no escape for an
      // embedded `"` or for `%VAR%` expansion inside them — refuse such a token.
      return /["%]/.test(arg) ? null : `"${arg}"`;
  }
}

/**
 * The line to type into `shell` to run `argv`, WITHOUT a trailing newline (the
 * caller adds one via `submitLine`). Returns null when some token can't be
 * expressed safely in that dialect — the caller must then send nothing rather
 * than a line that runs something else.
 */
export function renderArgv(argv: string[], shell: CdShell): string | null {
  if (argv.length === 0) return null;
  // A newline would turn one command into two — never emit that.
  if (argv.some((a) => /[\r\n]/.test(a))) return null;
  const parts: string[] = [];
  for (const arg of argv) {
    const q = quote(arg, shell);
    if (q === null) return null;
    parts.push(q);
  }
  // A quoted first token is a string expression in PowerShell, not a command;
  // the call operator makes it run (a kubectl path under `Program Files`).
  if (shell === "powershell" && parts[0] !== argv[0]) parts[0] = `& ${parts[0]}`;
  return parts.join(" ");
}

/**
 * Paths as they are typed into `shell`, quoted for it and separated by spaces —
 * what dropping files onto a terminal types (v1.13), as every terminal does.
 * Nothing is run: there is no newline, and the caller pastes the text. Null
 * when a path cannot be written safely in that dialect, or holds a newline.
 */
export function quotePaths(paths: readonly string[], shell: CdShell): string | null {
  if (paths.length === 0 || paths.some((p) => p === "" || /[\r\n]/.test(p))) return null;
  const parts: string[] = [];
  for (const path of paths) {
    const q = quote(path, shell);
    if (q === null) return null;
    parts.push(q);
  }
  return parts.join(" ");
}

/**
 * Like {@link renderArgv}, but the tab's shell ENDS with the command: a
 * container/pod tab lives exactly as long as the session inside it (tabattach.ts).
 * POSIX replaces the shell (`exec`); cmd.exe and PowerShell have no `exec`, so
 * they `exit` once the command returns — whatever its status, so a failed
 * `docker exec` (container gone) also ends the tab, its error left on screen.
 */
export function renderSessionCommand(argv: string[], shell: CdShell): string | null {
  const cmd = renderArgv(argv, shell);
  if (cmd === null) return null;
  switch (shell) {
    case "posix":
      return `exec ${cmd}`;
    case "powershell":
      return `${cmd}; exit`;
    case "cmd":
      return `${cmd} & exit`;
  }
}
