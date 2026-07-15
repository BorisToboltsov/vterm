// Shared pure logic for the network utilities (Phase 34). These tools run a
// diagnostic on the ACTIVE SESSION'S host: on an SSH tab the backend runs it
// remotely (`probe_run` → `exec_captured`) and we parse the output here; on a
// local tab we write the command into the PTY (variant B) and let the user's own
// shell run it. Nothing here touches the DOM or network, so it unit-tests
// cleanly and the `Util*.svelte` shells stay thin (INVARIANTS: "чистая логика в
// .ts"). The offline invariant holds because the app never opens a third-party
// socket itself — the user's server (or the user's own shell) does.

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
}

// Characters safe to leave unquoted when rendering a command for the PTY
// (variant B). Anything else gets single-quoted so the user's shell runs the
// exact same tokens the backend would. The backend quotes unconditionally; this
// is only about keeping the echoed terminal line readable.
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,.\/-]+$/;

/** Single-quote a token for a shell command (POSIX), escaping embedded quotes. */
export function shellQuote(token: string): string {
  if (token !== "" && SAFE_TOKEN.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Render an argv as a shell command line — written into the PTY for variant B. */
export function toShellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ");
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
