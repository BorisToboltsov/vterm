// Session recording (Phase 11): start/stop/pause/annotate + library CRUD +
// export/import + file pickers.
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { RecordingMeta } from "../types";

// ── Session recording (Phase 11) ───────────────────────────────────────────────

/** Start recording a session to a new asciicast file; resolves to its path. */
export function startRecording(
  sessionId: string,
  title: string,
  cols: number,
  rows: number,
  prompt: string,
  env: string,
  maskPasswords: boolean,
  mode: string,
): Promise<string> {
  return invoke<string>("start_recording", {
    sessionId,
    title,
    cols,
    rows,
    prompt,
    env,
    maskPasswords,
    mode,
  });
}

/** Stop recording a session; resolves to the file path if one was active. */
export function stopRecording(sessionId: string): Promise<string | null> {
  return invoke<string | null>("stop_recording", { sessionId });
}

/** Pause or resume the active recording (tab switched away / idle). */
export function setRecordingPaused(sessionId: string, paused: boolean): Promise<void> {
  return invoke<void>("set_recording_paused", { sessionId, paused });
}

/** Write an audit annotation (e.g. an in-app config edit) into the recording. */
export function annotateRecording(sessionId: string, text: string): Promise<void> {
  return invoke<void>("annotate_recording", { sessionId, text });
}

/** List stored recordings, newest first. */
export function listRecordings(): Promise<RecordingMeta[]> {
  return invoke<RecordingMeta[]>("list_recordings");
}

/** Set a recording's title and description (rewrites its asciicast header). */
export function setRecordingMeta(path: string, title: string, description: string): Promise<void> {
  return invoke<void>("set_recording_meta", { path, title, description });
}

/** Delete a stored recording by path. */
export function deleteRecording(path: string): Promise<void> {
  return invoke<void>("delete_recording", { path });
}

/** Read a recording's raw asciicast content (for transcript export / player). */
export function readRecording(path: string): Promise<string> {
  return invoke<string>("read_recording", { path });
}

/** Write exported text (transcript or .cast copy) to a user-chosen path. */
export function exportRecording(path: string, content: string): Promise<void> {
  return invoke<void>("export_recording", { path, content });
}

/** Native "save as" dialog for an export; returns the chosen path or null. */
export function pickExportSavePath(defaultName: string): Promise<string | null> {
  return save({ defaultPath: defaultName });
}

/**
 * Import (upload) an external `.cast` recording into the library. The backend
 * validates it's an asciicast v2 file and copies it in; returns the new entry's
 * metadata. The player needs the full raw `.cast` stream, so only `.cast` files
 * (not transcripts) replay correctly.
 */
export function importRecording(srcPath: string): Promise<RecordingMeta> {
  return invoke<RecordingMeta>("import_recording", { srcPath });
}

/** Native open dialog for a `.cast` recording to upload; returns the path or null. */
export async function pickRecordingFile(): Promise<string | null> {
  const res = await open({
    multiple: false,
    directory: false,
    title: "Upload recording",
    filters: [{ name: "asciicast", extensions: ["cast"] }],
  });
  return typeof res === "string" ? res : null;
}
