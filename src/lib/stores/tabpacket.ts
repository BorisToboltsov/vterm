// A tab's packet, out of the stores and back into them (ADR 0017).
//
// Moving a tab to another window means moving what the stores hold under its
// session id. `packTab` gathers it in the window giving the tab up, `unpackTab`
// puts it into the stores of the window taking it. The rules about when a tab
// may go, and the packet's shape, are in `../tabhandoff.ts`.
//
// What a tab leaves behind is dropped by the ordinary teardown (`closeTabFully`
// in the page, told to keep the session) — there is no second list of
// per-session state to keep in step with this one beyond the two functions here.

import {
  PACKET_VERSION,
  type PageSessionState,
  type TabPacket,
  type TermSnapshot,
} from "../tabhandoff";
import { adoptChat, peekChat } from "./aichat.svelte";
import { adoptDockState, peekDockState } from "./dockstate.svelte";
import {
  isRecordingPaused,
  recordingState,
  setRecording,
  setRecordingPausedState,
} from "./recordings.svelte";
import type { TabDrop } from "../splitlayout";
import { adoptSyncJob, peekSyncJob } from "./syncjob.svelte";
import { adoptTab, findTab } from "./tabs.svelte";
import { adoptWorkspace, peekWorkspace } from "./workspaces.svelte";

/** What the page adds: the per-session facts it keeps outside the stores. */
export type PageFacts = Omit<PageSessionState, "recording" | "recordingPaused">;

/**
 * Everything this window holds for the tab, serialized for the trip. `null`
 * when the tab is not here (it was closed while the handoff was starting).
 */
export function packTab(sessionId: string, terminal: TermSnapshot, page: PageFacts): string | null {
  const tab = findTab(sessionId);
  if (!tab) return null;
  // A tab that itself arrived from another window has long used its snapshot up.
  const { adopt: _used, ...plain } = tab;
  const packet: TabPacket = {
    v: PACKET_VERSION,
    tab: plain,
    terminal,
    workspace: peekWorkspace(sessionId),
    chat: peekChat(sessionId),
    dock: peekDockState(sessionId),
    sync: peekSyncJob(sessionId),
    page: {
      ...page,
      recording: recordingState[sessionId] ?? null,
      recordingPaused: isRecordingPaused(sessionId),
    },
  };
  return JSON.stringify(packet);
}

/**
 * Put a packet's state into this window's stores and open its tab — where it
 * was dropped, when it was (`drop`). The tab goes in last: its terminal and
 * panels mount against what is already restored.
 */
export function unpackTab(packet: TabPacket, drop: TabDrop | null = null): void {
  const id = packet.tab.sessionId;
  if (packet.workspace) adoptWorkspace(id, packet.workspace);
  if (packet.chat) adoptChat(id, packet.chat);
  if (packet.dock) adoptDockState(id, packet.dock);
  if (packet.sync) adoptSyncJob(id, packet.sync);
  if (packet.page.recording) {
    // The recording itself is the backend's and never stopped; this window
    // only learns that it is running, so its indicator and pauses follow it.
    setRecording(id, packet.page.recording);
    setRecordingPausedState(id, packet.page.recordingPaused);
  }
  adoptTab(packet.tab, packet.terminal, drop);
}
