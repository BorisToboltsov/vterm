// Network utilities API (Phase 34). One thin wrapper over the `probe_run`
// backend command; the frontend builds argument vectors and parses output in the
// per-tool pure modules (tls/http). Transport by session: an SSH tab runs it on
// the server, a local tab spawns the user's own curl/openssl here (ADR 0014).
import { invoke } from "@tauri-apps/api/core";

/** Captured result of one probe invocation (mirror of `netprobe::ProbeOutput`). */
export interface ProbeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run one diagnostic command on the session's host, capturing
 * stdout/stderr/exit code. `args` is the argument vector (shell-quoted per
 * token on SSH, passed verbatim locally — where only curl/openssl may run).
 * `stdin` feeds the command and closes it. Never throws on a non-zero exit —
 * inspect `exitCode`/`stderr`. Rejects when `sessionId` has no live session.
 * `mirror` audits the run into the session recording (`[util] $ …`) like git.
 */
export function probeRun(
  sessionId: string,
  args: string[],
  timeoutSecs = 20,
  mirror = true,
  stdin: string | null = null,
): Promise<ProbeOutput> {
  return invoke<ProbeOutput>("probe_run", { sessionId, args, timeoutSecs, mirror, stdin });
}

/** One host with its ports for `netcheckRun` (mirror of `netcheck::NetTarget`). */
export interface NetCheckTarget {
  host: string;
  ports: number[];
}

/**
 * Network access check (v1.0.36). Transport by session: an SSH tab runs `args`
 * (the script from `netcheckArgs`) on the server; a local tab connects to
 * `targets` natively from this machine. Both answer in the netcheck line
 * protocol — parse `stdout` with `parseNetReport`. Empty `targets` = identity
 * probe (hostname/addresses/method only).
 */
export function netcheckRun(
  sessionId: string,
  args: string[],
  targets: NetCheckTarget[],
  connectTimeoutSecs: number,
  timeoutSecs: number,
): Promise<ProbeOutput> {
  return invoke<ProbeOutput>("netcheck_run", {
    sessionId,
    args,
    targets,
    connectTimeoutSecs,
    timeoutSecs,
  });
}
