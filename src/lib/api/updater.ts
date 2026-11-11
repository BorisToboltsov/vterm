import { Channel } from "@tauri-apps/api/core";
import { call } from "./call";
export interface UpdateRelease {
  current: string;
  version: string;
  notes: string;
  url: string;
  available: boolean;
  kind: string | null;
  trustedUpdates: boolean;
  ready: boolean;
}
export interface UpdateProgress { downloaded: number; total: number }
export const checkUpdate = (): Promise<UpdateRelease> => call("update_check");
export const updateSnapshot = (): Promise<UpdateRelease | null> => call("update_snapshot");
export function downloadUpdate(version: string, onProgress: (progress: UpdateProgress) => void): Promise<void> {
  const progress = new Channel<UpdateProgress>();
  progress.onmessage = onProgress;
  return call("update_download", { version, progress });
}
export const installUpdate = (version: string): Promise<void> => call("update_install", { version });
export const updateWindowReady = (token: string, dirty: boolean): Promise<void> =>
  call("update_window_ready", { token, dirty });
export const updateStartup = (): Promise<string | null> => call("update_startup");
