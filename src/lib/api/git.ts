// Git panel API (Phase 29). One thin wrapper over the `git_run` backend command;
// the frontend builds argument vectors and parses output in `git.ts`.
import { invoke } from "@tauri-apps/api/core";

/** Captured result of one `git` invocation (mirror of `git::GitOutput`). */
export interface GitOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run one `git` command in `cwd` for the session (SSH or local — the backend
 * dispatches by session kind). `args` is the argument vector after `git -C
 * <cwd>`. Never throws on non-zero git exits — inspect `exitCode`/`stderr`.
 * `mirror` (mutating ops only) audits the command into the active session
 * recording; reads pass it false so they don't flood the recording.
 */
export function gitRun(
  sessionId: string,
  cwd: string,
  args: string[],
  timeoutSecs = 30,
  mirror = false,
): Promise<GitOutput> {
  return invoke<GitOutput>("git_run", { sessionId, cwd, args, timeoutSecs, mirror });
}
