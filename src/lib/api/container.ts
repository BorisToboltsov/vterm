// Docker panel API (Phase 35). One thin wrapper over the `container_run` backend
// command; the frontend builds argument vectors and parses output in `docker.ts`.
// Both transports (SSH + local) go through this one command — the backend
// dispatches by session kind, like `git_run`.
import { invoke } from "@tauri-apps/api/core";

/** Captured result of one `docker` invocation (mirror of `container::ContainerOutput`). */
export interface ContainerOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run one `docker` command for the session (SSH or local — the backend
 * dispatches by session kind). `args[0]` is the program (`docker`); the rest are
 * its arguments (each token is shell-quoted on the backend for SSH). Never throws
 * on a non-zero docker exit — inspect `exitCode`/`stderr`. Rejects only when there
 * is no session at all for `sessionId`. `mirror` (mutating ops only) audits the
 * command into the session recording as `[docker] $ …` — never emitted live.
 */
export function containerRun(
  sessionId: string,
  args: string[],
  timeoutSecs = 20,
  mirror = false,
): Promise<ContainerOutput> {
  return invoke<ContainerOutput>("container_run", { sessionId, args, timeoutSecs, mirror });
}

/**
 * Log the session's docker into a registry (Phase 36). The password is read from
 * the OS keychain on the backend and fed via `--password-stdin`, so it never
 * crosses this boundary at login time nor appears on a command line. `args` is
 * built by `docker.ts loginArgs`; `url` keys the stored secret ("" = Docker Hub).
 */
export function dockerLogin(
  sessionId: string,
  url: string,
  args: string[],
): Promise<ContainerOutput> {
  return invoke<ContainerOutput>("docker_login", { sessionId, url, args });
}

/** Store a Docker registry password in the OS keychain (keyed by url). */
export function setRegistrySecret(url: string, secret: string): Promise<void> {
  return invoke<void>("set_registry_secret", { url, secret });
}

/** Forget a stored Docker registry password. */
export function deleteRegistrySecret(url: string): Promise<void> {
  return invoke<void>("delete_registry_secret", { url });
}
