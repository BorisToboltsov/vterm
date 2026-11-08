// What a tab held, kept across a restart (v1.36, ADR 0057): its terminal output
// and its conversation with the assistant — only under the setting
// `restoreOutput`, never for a production server. The backend keeps one file
// per tab in the data folder (`tabcontent.rs`); what goes in it, and when, is
// the restore flow's (`page/restoreflow.svelte.ts`), and only it calls these
// (`vterm/owned-imports`).

import { invoke } from "@tauri-apps/api/core";

/** Keep what tab `sessionId` holds, written down as JSON. */
export function tabContentSave(sessionId: string, content: string): Promise<void> {
  return invoke<void>("tab_content_save", { sessionId, content });
}

/** What was kept for tab `sessionId`, or null. */
export function tabContentLoad(sessionId: string): Promise<string | null> {
  return invoke<string | null>("tab_content_load", { sessionId });
}

/** These tabs are closed (or no longer kept): their content goes. */
export function tabContentForget(sessionIds: string[]): Promise<void> {
  return invoke<void>("tab_content_forget", { sessionIds });
}

/** Everything but the content of `sessionIds` goes; empty — all of it. */
export function tabContentKeepOnly(sessionIds: string[]): Promise<void> {
  return invoke<void>("tab_content_keep_only", { sessionIds });
}
