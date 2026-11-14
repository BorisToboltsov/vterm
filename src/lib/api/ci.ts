// CI panel API (ADR 0069). One thin wrapper over the `ci_run` backend command:
// a `gh api` / `glab api` call (or `auth status`) over the session's transport.
// The argv comes from `ci/ciapi.ts`, the answers are read by `ci/ciparse.ts`.
import { call } from "./call";
import type { ExecOutput } from "../types";

/**
 * Run one `gh`/`glab` call for the session (SSH or local — the backend
 * dispatches by session kind; its policy lets through only the paths of a
 * repository's runs). Never throws on a non-zero exit — inspect
 * `exitCode`/`stderr`. `mirror` (the writes: run again, cancel, start)
 * audits the call into the session recording as `[ci] $ …`.
 */
export function ciRun(sessionId: string, args: string[], timeoutSecs = 25, mirror = false): Promise<ExecOutput> {
  return call<ExecOutput>("ci_run", { sessionId, args, timeoutSecs, mirror });
}
