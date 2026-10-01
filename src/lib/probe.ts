// Shared pure logic for the network utilities (Phase 34). These tools run a
// diagnostic on the ACTIVE SESSION'S host, transport by session: on an SSH tab
// the backend runs it remotely (`probe_run` → `exec_captured`); on a local tab
// it spawns the user's own `curl`/`openssl` on this machine (ADR 0014) — either
// way we parse the output here. A local tab can also type the command into its
// terminal instead, rendered for the shell that tab actually runs. Nothing here
// touches the DOM or network, so it unit-tests cleanly and the `Util*.svelte`
// shells stay thin (INVARIANTS: "чистая логика в .ts").
import type { CdShell } from "./cdterminal";

/** The session a network utility targets, resolved from the active tab. */
export interface ProbeSession {
  id: string;
  /** "ssh" runs remotely (structured parse); "local" runs in the PTY (variant B). */
  kind: "ssh" | "local";
  /** Whether the tab is live (connected) — a dead tab can't run anything. */
  live: boolean;
  /** Display label for the "runs on …" hint (host for SSH, "local" for local). */
  host: string;
  /** Prod-tagged server — gate noisy ops (port scan) behind a confirm. */
  isProd: boolean;
  /** The shell the tab runs (SSH is always POSIX) — for "run in terminal". */
  shell: CdShell;
}

/**
 * A probe as a chain of argv steps for a local tab: each step's stdout is the
 * next one's stdin — a pipe without `sh -c`, which Windows doesn't have. The
 * last step's output is the result.
 */
export type ProbeSteps = string[][];

/** Captured output of one step (mirror of `api.ProbeOutput`, kept DOM/API-free). */
export interface StepOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Whether a chain stops after this step's output instead of feeding the next:
 * a failed step (the connect was refused, the tool is missing) carries the
 * message worth showing — the next tool would only say "no input".
 */
export function stepFailed(out: StepOutput): boolean {
  return probeError(out.stdout, out.stderr, out.exitCode) !== "";
}

/** The program name for `curl` in a shell: PowerShell 5.1 aliases bare `curl`. */
export function curlProgram(shell: CdShell): string {
  return shell === "posix" ? "curl" : "curl.exe";
}

// Characters safe to leave unquoted when a builder embeds a token in a POSIX
// pipeline (the TLS `sh -c` string, the access-check script). Anything else gets
// single-quoted.
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,.\/-]+$/;

/** Single-quote a token for a shell command (POSIX), escaping embedded quotes. */
export function shellQuote(token: string): string {
  if (token !== "" && SAFE_TOKEN.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether a probe failed because the diagnostic binary isn't installed on the
 * host (e.g. `mtr`/`traceroute` missing on a minimal server). Lets the UI say
 * "install it" instead of surfacing a raw shell error. Pure — matches the
 * canonical wording of common shells.
 */
export function isCommandMissing(output: string): boolean {
  return /command not found|not found|No such file or directory|not installed|executable file not found/i.test(
    output,
  );
}

/**
 * Combine a ProbeOutput's streams into a single error string when it failed
 * (non-zero exit or nothing on stdout). Returns "" when the command succeeded
 * with usable stdout. Keeps every `Util*` from re-deriving the same check.
 */
export function probeError(stdout: string, stderr: string, exitCode: number): string {
  if (exitCode === 0 && stdout.trim()) return "";
  const msg = stderr.trim() || stdout.trim();
  return msg || `exit ${exitCode}`;
}
