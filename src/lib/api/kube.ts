// Kubernetes panel API (Phase 37). One thin wrapper over the `kubectl_run`
// backend command; the frontend builds argument vectors and parses output in
// `k8s.ts`. Both transports (SSH + local) go through this one command — the
// backend dispatches by session kind, like `container_run`.
import { invoke } from "@tauri-apps/api/core";

/** Captured result of one `kubectl` invocation (mirror of `kube::KubeOutput`). */
export interface KubeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run one `kubectl` command for the session (SSH or local — the backend
 * dispatches by session kind). `args` is a full argv whose leading token(s) are
 * the program (`kubectl`, or a configured wrapper) with the scope flags already
 * baked in by `k8s.ts withScope` (each token is shell-quoted on the backend for
 * SSH). Never throws on a non-zero kubectl exit — inspect `exitCode`/`stderr`.
 * Rejects only when there is no session at all for `sessionId`. `mirror` (mutating
 * ops only) audits the command into the session recording as `[k8s] $ …` — never
 * emitted live.
 */
export function kubectlRun(
  sessionId: string,
  args: string[],
  timeoutSecs = 20,
  mirror = false,
): Promise<KubeOutput> {
  return invoke<KubeOutput>("kubectl_run", { sessionId, args, timeoutSecs, mirror });
}
