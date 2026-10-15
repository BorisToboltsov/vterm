import { Channel, invoke } from "@tauri-apps/api/core";
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
export const checkUpdate = (): Promise<UpdateRelease> => invoke("update_check");
export const updateSnapshot = (): Promise<UpdateRelease | null> => invoke("update_snapshot");
export function downloadUpdate(version: string, onProgress: (progress: UpdateProgress) => void): Promise<void> {
  const progress = new Channel<UpdateProgress>();
  progress.onmessage = onProgress;
  return invoke("update_download", { version, progress });
}
export const installUpdate = (version: string): Promise<void> => invoke("update_install", { version });
export const updateWindowReady = (token: string, dirty: boolean): Promise<void> =>
  invoke("update_window_ready", { token, dirty });
export const updateStartup = (): Promise<string | null> => invoke("update_startup");
