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
