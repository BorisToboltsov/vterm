// Session recording as the page drives it (v1.25.2, out of +page.svelte): the
// REC toggle for a tab and for a broadcast group, auto-record of prod servers,
// pausing what is not on screen or idle, and the save/discard prompts after a
// stop. The recordings themselves are the backend's (recording.rs) and their
// flags live in the recordings store; this is the orchestration around them.
//
// What it needs from the page arrives as getters, read at the moment of use —
// the page's own state stays the page's.

import { getVersion } from "@tauri-apps/api/app";
import {
  deleteRecording,
  fetchMetrics,
  setBatchLabel,
  setRecordingMeta,
  setRecordingPaused,
  startRecording,
  stopRecording,
} from "../api";
import { eligibleMembers } from "../terminal/broadcast";
import { recordingPauses } from "../layout/centerview";
import { t } from "../i18n";
import { newBatchId, withBatch } from "../recording/recording";
import { settings } from "../settings/settings.svelte";
import {
  clearRecording,
  isRecording,
  isRecordingPaused,
  recordingState,
  setRecording,
  setRecordingPausedState,
} from "../stores/recordings.svelte";
import { isLive, type Tab } from "../stores/tabs.svelte";
import { notifyError, notifyInfo, notifySuccess } from "../stores/toasts.svelte";
import type { ServerProfile } from "../types";

/** What the page tells the recording flow, each read when it is needed. */
export interface RecordingDeps {
  servers: () => ServerProfile[];
  findTab: (id: string) => Tab | null | undefined;
  /** The tab REC acts on outside broadcast. */
  activeTab: () => Tab | null | undefined;
  /** Whether broadcast mode is on — REC then records the group. */
  broadcasting: () => boolean;
  /** Members of the broadcast group, in tab order. */
  members: () => string[];
  /** Tabs in tab order (what a group recording may include). */
  orderedTabs: () => Tab[];
  /** Sessions on screen — the only ones whose recording runs. */
  onScreen: () => Set<string>;
  /** Last-known terminal size per session, for the recording header. */
  termSize: (id: string) => { cols: number; rows: number } | undefined;
  /** The prompt on screen, seeding the recording so its first command has one. */
  promptLine: (id: string) => string;
}

/** Title for a recording: the tab's server alias (or "Local shell"). */
export function recordingTitle(tab: Tab, servers: ServerProfile[]): string {
  if (tab.kind === "local") return t("tab.localShell");
  return servers.find((s) => s.id === tab.serverId)?.alias ?? tab.serverId;
}

export function createRecordingFlow(deps: RecordingDeps) {
  // While a broadcast group is being recorded, `batch` holds the shared batch id
  // (tags every member's cast → the library bundles them). Recordings are still
  // per-session under the hood; this just fans start/stop out to the group.
  let batch = $state<string | null>(null);
  let batchMembers = new Set<string>();
  // After stopping a recording: prompt to name/describe or discard it.
  let saveRec = $state<{ path: string; defaultTitle: string } | null>(null);
  // After stopping a group: prompt to name (or discard) the bundle.
  let saveBatch = $state<{ batchId: string; paths: string[] } | null>(null);

  // One idle countdown per recording that is on screen.
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // The on-screen recordings already resumed — guards against clobbering an idle
  // pause when the effect re-runs for an unrelated reason.
  let resumed = new Set<string>();

  const titleOf = (tab: Tab) => recordingTitle(tab, deps.servers());

  /**
   * Collect host/session metadata to embed in the recording header (for later
   * analysis and the export's info block). App version always; for SSH sessions
   * a one-shot metrics probe adds hostname/ip/user/OS/kernel. Best-effort — never
   * blocks recording on a failure.
   */
  async function recordingEnv(tab: Tab): Promise<string> {
    const env: Record<string, string | number> = {};
    try {
      env.appVersion = await getVersion();
    } catch {
      /* version unavailable */
    }
    if (tab.kind === "ssh") {
      const srv = deps.servers().find((s) => s.id === tab.serverId);
      if (srv) {
        env.connectedHost = srv.host;
        env.port = srv.port;
        if (srv.username) env.username = srv.username;
      }
      try {
        const m = await fetchMetrics(tab.sessionId);
        if (m.hostname) env.hostname = m.hostname;
        if (m.ip) env.ip = m.ip;
        if (m.user) env.username = m.user;
        if (m.prettyName || m.os) env.os = m.prettyName || m.os;
        if (m.kernel) env.kernel = m.kernel;
        if (m.serverTime) env.serverTime = m.serverTime;
      } catch {
        /* metrics probe failed — keep profile-derived fields */
      }
    }
    return JSON.stringify(env);
  }

  /** Start recording a session (no-op if already recording). Used by the manual
   *  REC toggle, by auto-record on connect and by a group recording. */
  async function startSessionRecording(tab: Tab, batchId?: string) {
    const id = tab.sessionId;
    if (isRecording(id)) return;
    const dims = deps.termSize(id) ?? { cols: 80, rows: 24 };
    const prompt = deps.promptLine(id);
    let env = await recordingEnv(tab);
    if (batchId) env = withBatch(env, batchId);
    const path = await startRecording(
      id,
      titleOf(tab),
      dims.cols,
      dims.rows,
      prompt,
      env,
      settings.recordMaskPasswords,
      settings.recordMode,
    );
    setRecording(id, path);
  }

  /** Stop and forget one session's recording, keeping whatever was flushed. */
  async function stopQuietly(id: string) {
    if (isRecording(id)) {
      try {
        await stopRecording(id);
      } catch {
        /* session already gone — the file is flushed regardless */
      }
    }
    clearRecording(id);
  }

  /** Reconcile group recording with the live members: start missing, stop gone. */
  async function syncBatchRecording() {
    const current = batch;
    if (!current) return;
    const live = new Set(eligibleMembers(deps.members(), deps.orderedTabs()));
    const starts: Promise<void>[] = [];
    for (const id of live) {
      if (batchMembers.has(id) || isRecording(id)) continue;
      batchMembers.add(id);
      const tab = deps.findTab(id);
      if (tab) {
        starts.push(
          startSessionRecording(tab, current).catch(() => {
            batchMembers.delete(id);
          }),
        );
      }
    }
    for (const id of [...batchMembers]) {
      if (live.has(id)) continue;
      batchMembers.delete(id);
      if (isRecording(id)) await stopQuietly(id);
    }
    await Promise.all(starts);
  }

  /** Start recording the whole group under a fresh batch id. */
  async function startGroupRecording() {
    batch = newBatchId(Date.now());
    batchMembers = new Set();
    await syncBatchRecording();
  }

  /** Stop every recording started as part of the current batch; returns the batch
   *  id + saved file paths so the caller can offer to name (or discard) the bundle. */
  async function stopGroupRecording(): Promise<{ batchId: string; paths: string[] } | null> {
    const batchId = batch;
    const ids = [...batchMembers];
    batch = null;
    batchMembers = new Set();
    const paths: string[] = [];
    for (const id of ids) {
      const path = recordingState[id];
      if (isRecording(id)) await stopQuietly(id);
      if (path) paths.push(path);
    }
    return batchId ? { batchId, paths } : null;
  }

  /** Start/stop recording a specific tab (single-session flow, no broadcast). */
  async function toggleRecordingFor(tab: Tab) {
    if (!isLive(tab.status)) {
      notifyError(t("recordings.needsSession"));
      return;
    }
    const id = tab.sessionId;
    try {
      if (isRecording(id)) {
        const path = await stopRecording(id);
        clearRecording(id);
        // Prompt to name/describe (or discard) the just-saved recording.
        if (path) saveRec = { path, defaultTitle: titleOf(tab) };
        else notifySuccess(t("recordings.stopped"));
      } else {
        await startSessionRecording(tab);
        notifySuccess(t("recordings.started"));
      }
    } catch (e) {
      notifyError(String(e));
    }
  }

  // ── Pausing what is not watched ────────────────────────────────────────────

  function clearIdleTimer(sessionId: string) {
    clearTimeout(idleTimers.get(sessionId));
    idleTimers.delete(sessionId);
  }

  /** Pause/resume a recording: update the tab indicator + tell the backend (only on change). */
  function applyPause(sessionId: string, paused: boolean) {
    if (isRecordingPaused(sessionId) === paused) return;
    setRecordingPausedState(sessionId, paused);
    setRecordingPaused(sessionId, paused).catch(() => {});
  }

  /** (Re)arm the idle countdown that pauses a recording tab on screen. */
  function armIdleTimer(sessionId: string) {
    clearIdleTimer(sessionId);
    const secs = settings.recordIdlePauseSecs;
    if (secs <= 0 || !isRecording(sessionId)) return;
    idleTimers.set(
      sessionId,
      setTimeout(() => applyPause(sessionId, true), secs * 1000),
    );
  }

  // A recording runs only while its tab is on screen — one tab per pane, every
  // member of the broadcast grid (centerview.ts). The others are paused; a tab
  // that comes back on screen resumes with a fresh idle countdown.
  $effect(() => {
    const { pause, watch } = recordingPauses(Object.keys(recordingState), [...deps.onScreen()]);
    for (const id of pause) applyPause(id, true);
    for (const id of watch) {
      if (resumed.has(id)) continue;
      applyPause(id, false);
      armIdleTimer(id);
    }
    for (const id of [...idleTimers.keys()]) {
      if (!watch.includes(id)) clearIdleTimer(id);
    }
    resumed = new Set(watch);
  });

  return {
    /** The batch id while a broadcast group is being recorded. */
    get batch() {
      return batch;
    },
    get saveRec() {
      return saveRec;
    },
    get saveBatch() {
      return saveBatch;
    },
    startSessionRecording,
    syncBatchRecording,

    /** Start the group recording if it isn't running (prod broadcast audit). */
    async ensureGroupRecording() {
      if (!batch) await startGroupRecording();
    },

    /** Start/stop recording the active session (manual REC button / palette). In
     *  broadcast mode this records the whole group instead of a single tab. */
    async toggle(groupSize: number) {
      if (deps.broadcasting()) {
        try {
          if (batch) {
            const res = await stopGroupRecording();
            // Offer to name (or discard) the bundle, like the single-recording flow.
            if (res && res.paths.length > 0) saveBatch = { batchId: res.batchId, paths: res.paths };
            else notifySuccess(t("recordings.groupStopped"));
          } else {
            await startGroupRecording();
            notifySuccess(t("recordings.groupStarted", { count: groupSize }));
          }
        } catch (e) {
          notifyError(String(e));
        }
        return;
      }
      const tab = deps.activeTab();
      if (!tab || !isLive(tab.status)) {
        notifyError(t("recordings.needsSession"));
        return;
      }
      await toggleRecordingFor(tab);
    },
    toggleRecordingFor,

    /**
     * Auto-record on connect for servers flagged `autoRecord` (e.g. production):
     * starts a recording the moment an SSH session connects, for an audit trail.
     */
    async maybeAutoRecord(tab: Tab) {
      if (tab.kind !== "ssh" || isRecording(tab.sessionId)) return;
      if (!deps.servers().find((s) => s.id === tab.serverId)?.autoRecord) return;
      try {
        await startSessionRecording(tab);
        notifyInfo(t("recordings.autoStarted", { alias: titleOf(tab) }));
      } catch (e) {
        notifyError(String(e));
      }
    },

    /** Finalize a recording when its session closes (stamps end time), then clear. */
    async finalizeOnClose(sessionId: string) {
      batchMembers.delete(sessionId);
      await stopQuietly(sessionId);
    },

    /** Keystroke in a terminal on screen → resume (if idle-paused) and re-arm its idle timer. */
    activity(sessionId: string) {
      if (!deps.onScreen().has(sessionId) || !isRecording(sessionId)) return;
      applyPause(sessionId, false); // backend also auto-resumes on input
      armIdleTimer(sessionId);
    },

    /** Drop what the flow keeps under a session id — the tab is gone from this
     *  window (closed, or handed to another). The recording flags are the
     *  store's, cleared by the teardown itself. */
    forget(sessionId: string) {
      clearIdleTimer(sessionId);
      batchMembers.delete(sessionId);
    },

    /** Save the title/description entered after stopping a recording. */
    async saveRecording(title: string, description: string) {
      const rec = saveRec;
      saveRec = null;
      if (!rec) return;
      try {
        await setRecordingMeta(rec.path, title, description);
        notifySuccess(t("recordings.stopped"));
      } catch (e) {
        notifyError(String(e));
      }
    },

    /** Discard the just-made recording from the save prompt. */
    async discardRecording() {
      const rec = saveRec;
      saveRec = null;
      if (!rec) return;
      try {
        await deleteRecording(rec.path);
        notifyInfo(t("recordings.discarded"));
      } catch (e) {
        notifyError(String(e));
      }
    },

    closeSavePrompt() {
      saveRec = null;
    },

    /** Name the broadcast bundle: writes the label into every member recording. */
    async saveBatchName(title: string) {
      const b = saveBatch;
      saveBatch = null;
      if (!b) return;
      try {
        if (title) await setBatchLabel(b.batchId, title);
        notifySuccess(t("recordings.groupStopped"));
      } catch (e) {
        notifyError(String(e));
      }
    },

    /** Discard the whole just-made broadcast bundle (delete every member file). */
    async discardBatch() {
      const b = saveBatch;
      saveBatch = null;
      if (!b) return;
      for (const path of b.paths) {
        try {
          await deleteRecording(path);
        } catch {
          /* keep going; avoid a toast storm on partial failure */
        }
      }
      notifyInfo(t("recordings.discarded"));
    },

    closeBatchPrompt() {
      saveBatch = null;
    },
  };
}

export type RecordingFlow = ReturnType<typeof createRecordingFlow>;
