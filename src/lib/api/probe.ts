// Network utilities API (Phase 34). One thin wrapper over the `probe_run`
// backend command; the frontend builds argument vectors and parses output in the
// per-tool pure modules (tls/http). SSH only — a local tab runs the command in
// its PTY instead (variant B), so this is not called for local sessions.
import { invoke } from "@tauri-apps/api/core";

/** Captured result of one probe invocation (mirror of `netprobe::ProbeOutput`). */
export interface ProbeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run one diagnostic command on the SSH session's host, capturing
 * stdout/stderr/exit code. `args` is the argument vector (each token is
 * shell-quoted on the backend). Never throws on a non-zero exit — inspect
 * `exitCode`/`stderr`. Rejects only when there is no SSH session for `sessionId`.
 * `mirror` audits the run into the session recording (`[util] $ …`) like git.
 */
export function probeRun(
  sessionId: string,
  args: string[],
  timeoutSecs = 20,
  mirror = true,
): Promise<ProbeOutput> {
  return invoke<ProbeOutput>("probe_run", { sessionId, args, timeoutSecs, mirror });
}
