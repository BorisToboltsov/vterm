<script lang="ts">
  import { onMount } from "svelte";
  import { tooltip } from "$lib/actions/tooltip";
  import { fade } from "svelte/transition";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import {
    connectPlan,
    deleteServer,
    forgetSecrets,
    listFolders,
    listServers,
    moveFolder,
    setServerGroup,
    setServerNotes,
    sftpReadText,
    sftpWriteText,
    isFileChangedError,
    isPermissionError,
    readLocalText,
    writeLocalText,
    takePendingOpens,
    pickOpenFile,
    writeToTerminal,
    serverToolsStatus,
    nginxConfigFiles,
    OPEN_FILE_EVENT,
  } from "$lib/api";
  import type { ServerProfile } from "$lib/types";
  import { nameOf } from "$lib/tree";
  import {
    clamp,
    layout,
    LEFT_MAX,
    LEFT_MIN,
    SFTP_MAX,
    SFTP_MIN,
  } from "$lib/stores/layout.svelte";
  import {
    closeTab as closeTabStore,
    closeTabsForServer,
    dotClass,
    findTab,
    isLive,
    moveTab,
    newTabAction,
    nextTabIndex,
    openTab as openTabStore,
    openLocalTab,
    reconnectTab as reconnectTabStore,
    setTabStatus,
    tabsState,
    type Tab,
  } from "$lib/stores/tabs.svelte";
  import { resizableHandle } from "$lib/actions/drag";
  import { handleClipboardShortcut } from "$lib/actions/clipboardKeys";
  import TerminalView from "$lib/Terminal.svelte";
  import ConnectingOverlay from "$lib/ConnectingOverlay.svelte";
  import type { ConnPhase } from "$lib/connphase";
  import { sshErrorView } from "$lib/ssherror";
  import { showNoSignal } from "$lib/connlost";
  import RightDock from "$lib/RightDock.svelte";
  import EditorTab from "$lib/EditorTab.svelte";
  import DiffModal from "$lib/DiffModal.svelte";
  import ToolInstallDialog from "$lib/ToolInstallDialog.svelte";
  import type { ToolStatus } from "$lib/servertools";
  import {
    editorLangOrPlain,
    editorLangWithIncludes,
    editorLangWithDialect,
    couldBeNginxInclude,
  } from "$lib/editorlang";
  import { lineDiffStat } from "$lib/util";
  import {
    getWorkspace,
    addEditor,
    addScratchEditor,
    fillEditor,
    closeEditor as closeEditorStore,
    setActiveView,
    findEditorByPath,
    setEditorSudo,
    markSaved,
    isDirty,
    removeWorkspace,
    TERMINAL_VIEW,
    type EditorDoc,
  } from "$lib/stores/workspaces.svelte";
  import { removeChat, getChat } from "$lib/stores/aichat.svelte";
  import SettingsPanel from "$lib/SettingsPanel.svelte";
  import ServerFormModal from "$lib/ServerFormModal.svelte";
  import NotesModal from "$lib/NotesModal.svelte";
  import { hasNotes, notesTarget } from "$lib/notes";
  import FolderModals from "$lib/FolderModals.svelte";
  import SecretPrompt from "$lib/SecretPrompt.svelte";
  import HelpPanel from "$lib/HelpPanel.svelte";
  import ThemeOverlay from "$lib/ThemeOverlay.svelte";
  import IdleOverlay from "$lib/IdleOverlay.svelte";
  import StatusBar from "$lib/StatusBar.svelte";
  import MonitoringOverlay from "$lib/MonitoringOverlay.svelte";
  import TopBar from "$lib/TopBar.svelte";
  import ServerTree from "$lib/ServerTree.svelte";
  import Modal from "$lib/Modal.svelte";
  import ConfirmDialog from "$lib/ConfirmDialog.svelte";
  import { OSC7_SETUP, osc7SetupDisplay } from "$lib/shellintegration";
  import Icon from "$lib/Icon.svelte";
  import Toast from "$lib/Toast.svelte";
  import EmptyState from "$lib/EmptyState.svelte";
  import CommandPalette from "$lib/CommandPalette.svelte";
  import RecordingsPanel from "$lib/RecordingsPanel.svelte";
  import type { CommandItem } from "$lib/command";
  import { notifyError, notifySuccess, notifyInfo } from "$lib/stores/toasts.svelte";
  import { applyProgress } from "$lib/stores/transfers.svelte";
  import {
    recordingState,
    recordingPaused,
    isRecording,
    isRecordingPaused,
    setRecording,
    setRecordingPausedState,
    clearRecording,
  } from "$lib/stores/recordings.svelte";
  import type { SftpProgress } from "$lib/api";
  import { settings } from "$lib/settings.svelte";
  import { t } from "$lib/i18n";
  import {
    setMenuLanguage,
    startRecording,
    stopRecording,
    setRecordingPaused,
    setRecordingMeta,
    setBatchLabel,
    deleteRecording,
    annotateRecording,
    fetchMetrics,
    readRecording,
  } from "$lib/api";
  import { extractTranscript } from "$lib/recording";
  import { DEFAULT_TAIL_LINES, type RawContext } from "$lib/aicontext";
  import { isProdServer } from "$lib/aiexec";
  import { getVersion } from "@tauri-apps/api/app";
  import RecordingSaveDialog from "$lib/RecordingSaveDialog.svelte";
  import { localizedStatus } from "$lib/stores/tabs.svelte";
  import BroadcastBar from "$lib/BroadcastBar.svelte";
  import BroadcastRoster from "$lib/BroadcastRoster.svelte";
  import {
    broadcastState,
    isBroadcastMember,
    toggleBroadcastMember,
    setBroadcastMembers,
    clearBroadcastMembers,
    removeBroadcastMember,
    effectiveLayout,
  } from "$lib/stores/broadcast.svelte";
  import {
    eligibleMembers,
    frameCommand,
    groupHasProd,
    gridColumns,
    prodMembers,
  } from "$lib/broadcast";

  let servers = $state<ServerProfile[]>([]);
  let selectedId = $state<string | null>(null);
  // Highlighted folder in the left tree. When set, "Add server" pre-fills this
  // folder as the new server's group. Mutually exclusive with a selected server.
  let selectedFolder = $state<string | null>(null);
  // Add/edit server form (owns its own field state); opened via its exported methods.
  let serverForm: ServerFormModal | undefined = $state();
  // Folder create/rename/delete modals (own their own state); opened via exports.
  let folderModals: FolderModals | undefined = $state();
  let showSettings = $state(false);
  // Deep-link target section when opening settings (null = default group).
  let settingsSection = $state<string | null>(null);
  /** Open the settings panel, optionally focused on a section's group. */
  function openSettings(section: string | null = null) {
    settingsSection = section;
    showSettings = true;
  }
  let showHelp = $state(false);
  let helpTab = $state<"help" | "about" | "manual">("help");
  let showPalette = $state(false);
  let showMonitoring = $state(false);
  let showRecordings = $state(false);
  // The server whose notes window is open (snapshot at open time), or null.
  let notesServer = $state<ServerProfile | null>(null);
  // After stopping a recording: prompt to name/describe or discard it.
  let saveRec = $state<{ path: string; defaultTitle: string } | null>(null);

  // Last-known terminal dimensions per session (for the recording header).
  const termDims = $state<Record<string, { cols: number; rows: number }>>({});
  // Live terminal components per session, for reading the current prompt at REC
  // start and for collecting AI context (selection / buffer) on demand.
  const termRefs: Record<
    string,
    {
      currentPromptLine?: () => string;
      selectionText?: () => string;
      bufferText?: (maxLines?: number) => string;
    }
  > = {};
  // Current SSH connection phase per session, driving the connecting overlay.
  const connPhase = $state<Record<string, ConnPhase>>({});
  // Latest terminal cwd (OSC 7) per session, and whether the file panel should
  // follow it — both **per tab** (each session keeps its own toggle).
  const terminalCwd = $state<Record<string, string>>({});
  const followTerminal = $state<Record<string, boolean>>({});
  // ── Idle screensaver (Phase 0.28) ──
  // Bumped on any terminal output so the screensaver never covers a printing
  // terminal ("no output" rule). `idleWasConnected` tracks which sessions actually
  // reached Connected, so an unexpected drop (tab survives) shows NO SIGNAL —
  // never a manual close (tab is gone) or a failed connect. See connlost.ts.
  let idleOutputTick = $state(0);
  const idleWasConnected = new Set<string>();
  let noSignalSession = $state<string | null>(null);
  // The central terminal-panes area — the screensaver covers only this, not the
  // sidebar / tab bar / right dock / status bar. Null when no tabs; the overlay
  // then falls back to `mainArea` (the central column) for the ambient card, so
  // it still never spills onto the sidebar / status bar.
  let terminalArea = $state<HTMLElement>();
  // The central column (`<main>`), used as the screensaver's fallback target when
  // no tab is open (so the ambient card stays within the central area).
  let mainArea = $state<HTMLElement>();
  // Sessions where we've already typed the OSC 7 shell-integration snippet, and the
  // session awaiting the user's confirmation before we type it.
  const shellIntegrated = $state<Record<string, boolean>>({});
  let pendingFollowSession = $state<string | null>(null);

  // ── Panel resize (widths/collapse live in the layout store) ────────────────
  let resizing = $state<null | "left" | "sftp">(null);
  let resizeStartW = 0;

  // Password / passphrase prompt (owns its own state); opened via its export.
  let secretPrompt: SecretPrompt | undefined = $state();

  // Folders
  let folders = $state<string[]>([]);

  // Tab drag-to-reorder (pointer events)
  let barEl = $state<HTMLDivElement>();
  let dragSession = $state<string | null>(null);
  let dragStartX = 0;
  let dragMoved = $state(false);
  let tabDragX = $state(0);
  let tabDragY = $state(0);
  const draggingTab = $derived(
    dragSession && dragMoved ? findTab(dragSession) : null,
  );

  const selected = $derived(servers.find((s) => s.id === selectedId) ?? null);
  // Drop a stale folder highlight after the folder is renamed/deleted.
  $effect(() => {
    if (selectedFolder !== null && !folders.includes(selectedFolder)) selectedFolder = null;
  });
  const activeTab = $derived(findTab(tabsState.activeId));
  // serverId → statuses of its open SSH tabs, for the connection dots in the tree.
  const serverConnections = $derived.by(() => {
    const map: Record<string, string[]> = {};
    for (const tab of tabsState.list) {
      if (tab.kind !== "ssh") continue;
      (map[tab.serverId] ??= []).push(tab.status);
    }
    return map;
  });
  const sftpReady = $derived(activeTab ? activeTab.status.startsWith("Connected") : false);
  // Top-bar breadcrumb of the active connection. Alias comes from the tab (SSH
  // alias or "Local shell"); the `user@host:port` line needs the SSH profile.
  const activeServer = $derived(
    activeTab?.kind === "ssh" ? (servers.find((s) => s.id === activeTab.serverId) ?? null) : null,
  );
  // Notes belong to the active SSH tab's server when one is focused; on a local
  // tab (or with no tab) they fall back to the tree-selected server.
  const notesServerTarget = $derived(notesTarget(activeServer, selected));

  // ── Broadcast: synchronous multi-server input (Phase 22) ───────────────────
  // Broadcast mode is bound to the active tab: we're "in broadcast" whenever the
  // active tab belongs to the group, so switching tabs enters/leaves the mode.
  const bcOn = $derived(
    !!tabsState.activeId && isBroadcastMember(tabsState.activeId),
  );
  // Measured width of the terminal area → how many grid columns stay readable.
  let bcAreaWidth = $state(0);
  // Open tabs in the group, in tab order (may include connecting/errored ones,
  // which still tile so their overlay is visible).
  const bcMemberTabs = $derived(
    tabsState.list.filter((tab) => isBroadcastMember(tab.sessionId)),
  );
  // Live members that would actually receive a sent command.
  const bcTargets = $derived(eligibleMembers(broadcastState.members, tabsState.list));
  const bcLayout = $derived(effectiveLayout(bcTargets.length));
  // The focused member (focus layout) is simply the active tab.
  const bcFocusId = $derived(tabsState.activeId);
  const bcHasProd = $derived(groupHasProd(bcTargets, tabsState.list, servers));
  const bcCols = $derived(gridColumns(bcAreaWidth || 1200, bcMemberTabs.length));
  // Roster rows (focus layout): the full group, including the focused member
  // (marked `active`), so the whole list stays visible in the sidebar.
  const bcRosterRows = $derived(
    bcMemberTabs.map((tab) => {
      const srv = servers.find((s) => s.id === tab.serverId);
      return {
        sessionId: tab.sessionId,
        alias: tabAlias(tab),
        host: srv ? `${srv.username}@${srv.host}:${srv.port}` : t("tab.localShell"),
        status: localizedStatus(tab.status),
        dot: dotClass(tab.status),
        isProd: !!srv && isProdServer(srv.tags),
        active: tab.sessionId === bcFocusId,
      };
    }),
  );

  /** Add/remove the active tab to/from the group (entering/leaving broadcast). */
  function toggleActiveBroadcast() {
    const id = tabsState.activeId;
    if (id) toggleBroadcastMember(id);
    void syncBatchRecording();
  }

  /** Add every live SSH/local session to the group (keeps existing members). */
  function addAllConnected() {
    setBroadcastMembers([
      ...broadcastState.members,
      ...tabsState.list
        .filter((tab) => (tab.kind === "ssh" || tab.kind === "local") && isLive(tab.status))
        .map((tab) => tab.sessionId),
    ]);
    void syncBatchRecording();
  }

  // ── Group recording for broadcast (Phase 22) ───────────────────────────────
  // While a broadcast group is being recorded, `broadcastBatch` holds the shared
  // batch id (tags every member's cast → the library bundles them). Recordings are
  // still per-session under the hood; this just fans start/stop out to the group.
  let broadcastBatch = $state<string | null>(null);
  let batchRecMembers = new Set<string>();

  /** Start recording the whole group under a fresh batch id. */
  async function startGroupRecording() {
    broadcastBatch = `bcast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    batchRecMembers = new Set();
    await syncBatchRecording();
  }

  /** Stop every recording started as part of the current batch; returns the batch
   *  id + saved file paths so the caller can offer to name (or discard) the bundle. */
  async function stopGroupRecording(): Promise<{ batchId: string; paths: string[] } | null> {
    const batchId = broadcastBatch;
    const ids = [...batchRecMembers];
    broadcastBatch = null;
    batchRecMembers = new Set();
    const paths: string[] = [];
    for (const id of ids) {
      const path = recordingState[id];
      if (isRecording(id)) {
        try {
          await stopRecording(id);
        } catch {
          /* file is flushed regardless */
        }
        clearRecording(id);
      }
      if (path) paths.push(path);
    }
    return batchId ? { batchId, paths } : null;
  }

  /** Reconcile group recording with the live members: start missing, stop gone. */
  async function syncBatchRecording() {
    const batch = broadcastBatch;
    if (!batch) return;
    const live = new Set(eligibleMembers(broadcastState.members, tabsState.list));
    const starts: Promise<void>[] = [];
    for (const id of live) {
      if (batchRecMembers.has(id) || isRecording(id)) continue;
      batchRecMembers.add(id);
      const tab = findTab(id);
      if (tab) {
        starts.push(
          startSessionRecording(tab, batch).catch(() => {
            batchRecMembers.delete(id);
          }),
        );
      }
    }
    for (const id of [...batchRecMembers]) {
      if (live.has(id)) continue;
      batchRecMembers.delete(id);
      if (isRecording(id)) {
        try {
          await stopRecording(id);
        } catch {
          /* gone */
        }
        clearRecording(id);
      }
    }
    await Promise.all(starts);
  }

  /** Start the group recording if it isn't running (prod broadcast audit). */
  async function ensureGroupRecording() {
    if (!broadcastBatch) await startGroupRecording();
  }

  // A command awaiting confirmation because the group includes a prod server.
  let pendingBroadcast = $state<{ frame: string; targets: string[]; cmd: string } | null>(null);
  const pendingProdAliases = $derived(
    pendingBroadcast
      ? prodMembers(pendingBroadcast.targets, tabsState.list, servers).map((id) => {
          const tab = findTab(id);
          return tab ? tabAlias(tab) : id;
        })
      : [],
  );

  /** Send the composed command to every live member (prod → confirm first). */
  function requestBroadcast(cmd: string) {
    const frame = frameCommand(cmd);
    if (!frame) return;
    const targets = eligibleMembers(broadcastState.members, tabsState.list);
    if (targets.length === 0) return;
    if (groupHasProd(targets, tabsState.list, servers)) {
      pendingBroadcast = { frame, targets, cmd };
      return;
    }
    doBroadcast(frame, targets, cmd);
  }

  /** The actual fan-out: one `write_to_terminal` per target (reused contract),
   *  plus an audit marker of the command into every member that's recording. */
  function doBroadcast(frame: string, targets: string[], cmd: string) {
    const bytes = new TextEncoder().encode(frame);
    for (const id of targets) {
      writeToTerminal(id, bytes).catch(() => {});
      if (isRecording(id)) annotateRecording(id, `broadcast: ${cmd}`).catch(() => {});
    }
  }
  const topTitle = $derived(activeTab?.alias ?? t("status.notConnected"));
  const topSubtitle = $derived(
    activeServer ? `${activeServer.username}@${activeServer.host}:${activeServer.port}` : "",
  );
  const topConnected = $derived(
    activeTab?.kind === "ssh" && (activeTab?.status.startsWith("Connected") ?? false),
  );
  // Prod-flagged active server (by tag) → the AI assistant may not auto-execute (17.4).
  const aiProd = $derived(
    activeTab?.kind === "ssh"
      ? isProdServer(servers.find((s) => s.id === activeTab.serverId)?.tags)
      : false,
  );
  // `noAi`-flagged active server → AI context + execution are fully blocked (17.7).
  const aiNoAi = $derived(
    activeTab?.kind === "ssh"
      ? servers.find((s) => s.id === activeTab.serverId)?.noAi === true
      : false,
  );

  /** Open the detailed monitoring overlay (needs a connected SSH session). */
  function openMonitoring() {
    if (activeTab?.kind === "ssh" && activeTab.status.startsWith("Connected")) {
      showMonitoring = true;
    } else {
      notifyError(t("page.monitoringNeedsSsh"));
    }
  }

  /**
   * Collect the live session context the AI tab offers (Phase 17.3). Reads the
   * terminal selection + buffer always; the recording transcript and host
   * metadata only when their (opt-in) tiers are enabled — so the expensive
   * recording read / metrics probe runs only when actually attached. All of it
   * is redacted + shown in the consent dialog (in AiChat) before it is sent.
   */
  async function gatherAiContext(): Promise<RawContext> {
    const id = tabsState.activeId;
    if (!id) return {};
    const ref = termRefs[id];
    // Tiers are chosen per-chat (Context popover); gate the expensive reads by them.
    const tiers = getChat(id).context;
    const raw: RawContext = {};
    if (ref?.selectionText) raw.selection = ref.selectionText();
    if (ref?.bufferText) {
      raw.buffer = ref.bufferText();
      raw.tail = ref.bufferText(DEFAULT_TAIL_LINES);
    }
    if (tiers.includeRecording) {
      const path = recordingState[id];
      if (path) {
        try {
          raw.recording = extractTranscript(await readRecording(path));
        } catch {
          /* recording unreadable — skip this tier */
        }
      }
    }
    if (tiers.includeMetadata) raw.metadata = await aiMetadataBlock(id);
    return raw;
  }

  /** Host/session metadata block for the AI metadata tier (best-effort). */
  async function aiMetadataBlock(id: string): Promise<string> {
    const tab = findTab(id);
    const lines: string[] = [];
    const srv = tab ? servers.find((s) => s.id === tab.serverId) : undefined;
    if (srv) {
      lines.push(`Host: ${srv.host}:${srv.port}`, `User: ${srv.username}`, `Alias: ${srv.alias}`);
    } else if (tab) {
      lines.push(`Session: ${recordingTitle(tab)}`);
    }
    try {
      const m = await fetchMetrics(id);
      lines.push(`OS: ${m.prettyName || m.os}`, `Hostname: ${m.hostname}`, `Kernel: ${m.kernel}`);
    } catch {
      /* metrics probe failed — keep profile-derived fields */
    }
    return lines.join("\n");
  }

  /** Title for a recording: the tab's server alias (or "Local shell"). */
  function recordingTitle(tab: Tab): string {
    if (tab.kind === "local") return t("tab.localShell");
    return servers.find((s) => s.id === tab.serverId)?.alias ?? tab.serverId;
  }

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
      const srv = servers.find((s) => s.id === tab.serverId);
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
   *  REC toggle and by auto-record on connect. */
  async function startSessionRecording(tab: Tab, batchId?: string) {
    const id = tab.sessionId;
    if (isRecording(id)) return;
    const dims = termDims[id] ?? { cols: 80, rows: 24 };
    // Seed the recording with the on-screen prompt so the first command has one.
    const prompt = termRefs[id]?.currentPromptLine?.() ?? "";
    let env = await recordingEnv(tab);
    // Broadcast group recording: tag each member's cast with the batch id so the
    // library can bundle them (rides in the `vterm` env metadata → header).
    if (batchId) {
      try {
        const obj = JSON.parse(env);
        obj.batch = batchId;
        env = JSON.stringify(obj);
      } catch {
        /* keep the plain env if it somehow isn't valid JSON */
      }
    }
    const path = await startRecording(
      id,
      recordingTitle(tab),
      dims.cols,
      dims.rows,
      prompt,
      env,
      settings.recordMaskPasswords,
      settings.recordMode,
    );
    setRecording(id, path);
  }

  /** Start/stop recording the active session (manual REC button / palette). In
   *  broadcast mode this records the whole group instead of a single tab. */
  async function toggleRecording() {
    if (bcOn) {
      try {
        if (broadcastBatch) {
          const res = await stopGroupRecording();
          // Offer to name (or discard) the bundle, like the single-recording flow.
          if (res && res.paths.length > 0) saveBatch = { batchId: res.batchId, paths: res.paths };
          else notifySuccess(t("recordings.groupStopped"));
        } else {
          await startGroupRecording();
          notifySuccess(t("recordings.groupStarted", { count: bcTargets.length }));
        }
      } catch (e) {
        notifyError(String(e));
      }
      return;
    }
    const tab = activeTab;
    if (!tab || !isLive(tab.status)) {
      notifyError(t("recordings.needsSession"));
      return;
    }
    const id = tab.sessionId;
    try {
      if (isRecording(id)) {
        const path = await stopRecording(id);
        clearRecording(id);
        // Prompt to name/describe (or discard) the just-saved recording.
        if (path) saveRec = { path, defaultTitle: recordingTitle(tab) };
        else notifySuccess(t("recordings.stopped"));
      } else {
        await startSessionRecording(tab);
        notifySuccess(t("recordings.started"));
      }
    } catch (e) {
      notifyError(String(e));
    }
  }

  /**
   * Auto-record on connect for servers flagged `autoRecord` (e.g. production):
   * starts a recording the moment an SSH session connects, for an audit trail.
   */
  async function maybeAutoRecord(tab: Tab) {
    if (tab.kind !== "ssh" || isRecording(tab.sessionId)) return;
    if (!servers.find((s) => s.id === tab.serverId)?.autoRecord) return;
    try {
      await startSessionRecording(tab);
      notifyInfo(t("recordings.autoStarted", { alias: recordingTitle(tab) }));
    } catch (e) {
      notifyError(String(e));
    }
  }

  /** Finalize a recording when its session closes (stamps end time), then clear. */
  async function finalizeRecordingOnClose(sessionId: string) {
    batchRecMembers.delete(sessionId);
    if (isRecording(sessionId)) {
      try {
        await stopRecording(sessionId);
      } catch {
        /* session already gone — file is flushed regardless */
      }
    }
    clearRecording(sessionId);
  }

  // ── Recording pause: skip disk when a recording tab is unwatched or idle ──────
  let recordIdleTimer: ReturnType<typeof setTimeout> | undefined;
  // The active recording tab we last resumed — guards against clobbering an idle
  // pause when the effect re-runs for an unrelated reason.
  let resumedTab: string | null = null;

  function clearRecordIdleTimer() {
    if (recordIdleTimer) clearTimeout(recordIdleTimer);
    recordIdleTimer = undefined;
  }

  /** Pause/resume a recording: update the tab indicator + tell the backend (only on change). */
  function applyPause(sessionId: string, paused: boolean) {
    if (isRecordingPaused(sessionId) === paused) return;
    setRecordingPausedState(sessionId, paused);
    setRecordingPaused(sessionId, paused).catch(() => {});
  }

  /** (Re)arm the idle countdown that pauses the active recording tab. */
  function armRecordIdleTimer(sessionId: string) {
    clearRecordIdleTimer();
    const secs = settings.recordIdlePauseSecs;
    if (secs <= 0 || !isRecording(sessionId)) return;
    recordIdleTimer = setTimeout(() => applyPause(sessionId, true), secs * 1000);
  }

  /** Keystroke on the active terminal → resume (if idle-paused) and re-arm the idle timer. */
  function handleTerminalActivity(sessionId: string) {
    if (sessionId !== tabsState.activeId || !isRecording(sessionId)) return;
    applyPause(sessionId, false); // backend also auto-resumes on input
    armRecordIdleTimer(sessionId);
  }

  // Keep exactly the active recording tab running; pause background recording tabs
  // and re-arm the idle timer when the active recording tab changes.
  $effect(() => {
    const active = tabsState.activeId;
    const ids = Object.keys(recordingState);
    for (const id of ids) {
      if (id !== active) applyPause(id, true);
    }
    const activeRecording = active && ids.includes(active) ? active : null;
    if (activeRecording && activeRecording !== resumedTab) {
      applyPause(activeRecording, false);
      armRecordIdleTimer(activeRecording);
    }
    if (!activeRecording) clearRecordIdleTimer();
    resumedTab = activeRecording;
  });

  /** Save the title/description entered after stopping a recording. */
  async function saveRecording(title: string, description: string) {
    const rec = saveRec;
    saveRec = null;
    if (!rec) return;
    try {
      await setRecordingMeta(rec.path, title, description);
      notifySuccess(t("recordings.stopped"));
    } catch (e) {
      notifyError(String(e));
    }
  }

  /** Discard the just-made recording from the save prompt. */
  async function discardRecording() {
    const rec = saveRec;
    saveRec = null;
    if (!rec) return;
    try {
      await deleteRecording(rec.path);
      notifyInfo(t("recordings.discarded"));
    } catch (e) {
      notifyError(String(e));
    }
  }

  // Naming prompt for a just-stopped broadcast bundle (batch id + member paths).
  let saveBatch = $state<{ batchId: string; paths: string[] } | null>(null);

  /** Name the broadcast bundle: writes the label into every member recording. */
  async function saveBatchName(title: string) {
    const b = saveBatch;
    saveBatch = null;
    if (!b) return;
    try {
      if (title) await setBatchLabel(b.batchId, title);
      notifySuccess(t("recordings.groupStopped"));
    } catch (e) {
      notifyError(String(e));
    }
  }

  /** Discard the whole just-made broadcast bundle (delete every member file). */
  async function discardBatch() {
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
  }

  // ── Command palette (⌘K) ────────────────────────────────────────────────────
  const paletteCommands = $derived<CommandItem[]>([
    { id: "act:add", title: t("palette.addServer"), icon: "plus", group: t("palette.groupActions"),
      keywords: "add server new сервер добавить", run: () => serverForm?.openAdd(selectedFolder ?? "") },
    // Duplicate acts on the currently selected server; hidden when none is selected.
    ...(selected
      ? [{ id: "act:duplicate", title: t("palette.duplicateServer"), icon: "copy",
          group: t("palette.groupActions"),
          keywords: "duplicate copy clone дублировать копировать копия",
          run: () => serverForm?.openDuplicate(selected) } satisfies CommandItem]
      : []),
    { id: "act:newfolder", title: t("palette.newFolder"), icon: "folderPlus", group: t("palette.groupActions"),
      keywords: "folder new папка новая", run: () => folderModals?.openCreate("") },
    { id: "act:settings", title: t("palette.settings"), icon: "settings", group: t("palette.groupActions"),
      keywords: "settings preferences параметры настройки", run: () => openSettings() },
    { id: "act:monitoring", title: t("palette.monitoring"), icon: "barChart", group: t("palette.groupActions"),
      keywords: "monitoring metrics метрики мониторинг cpu ram disk графики", run: openMonitoring },
    { id: "act:record",
      title: activeTab && isRecording(activeTab.sessionId) ? t("palette.stopRecording") : t("palette.startRecording"),
      icon: "activity", group: t("palette.groupActions"),
      keywords: "record recording session запись сессия rec asciicast", run: toggleRecording },
    { id: "act:recordings", title: t("palette.recordings"), icon: "activity", group: t("palette.groupActions"),
      keywords: "recordings library записи библиотека asciicast", run: () => (showRecordings = true) },
    { id: "act:help", title: t("palette.help"), icon: "info", group: t("palette.groupActions"),
      keywords: "help помощь справка", run: () => { helpTab = "help"; showHelp = true; } },
    { id: "act:manual", title: t("palette.manual"), icon: "info", group: t("palette.groupActions"),
      keywords: "manual readme инструкция документация docs", run: () => { helpTab = "manual"; showHelp = true; } },
    { id: "act:about", title: t("palette.about"), icon: "info", group: t("palette.groupActions"),
      keywords: "about version версия о программе", run: () => { helpTab = "about"; showHelp = true; } },
    { id: "act:toggle-left",
      title: layout.leftCollapsed ? t("palette.showServerList") : t("palette.hideServerList"),
      icon: "server", group: t("palette.groupActions"), keywords: "panel sidebar toggle панель серверы",
      run: () => (layout.leftCollapsed = !layout.leftCollapsed) },
    { id: "act:toggle-sftp",
      title: layout.sftpCollapsed ? t("palette.showSftp") : t("palette.hideSftp"),
      icon: "file", group: t("palette.groupActions"), keywords: "sftp files panel toggle панель файлы",
      run: () => {
        if (layout.sftpCollapsed) {
          layout.dockTab = "files";
          layout.sftpCollapsed = false;
        } else {
          layout.sftpCollapsed = true;
        }
      } },
    { id: "act:toggle-ai",
      title: t("palette.showAi"),
      icon: "aiMark", group: t("palette.groupActions"), keywords: "ai chat assistant llm панель ии ассистент чат",
      run: () => {
        layout.dockTab = "ai";
        layout.sftpCollapsed = false;
      } },
    { id: "act:new-local", title: t("palette.newLocalTerminal"), icon: "terminal",
      group: t("palette.groupActions"), keywords: "local terminal shell new локальный терминал новый",
      run: () => openLocalTab() },
    { id: "act:open-local-file", title: t("palette.openLocalFile"), icon: "pencil",
      group: t("palette.groupActions"), keywords: "open local file edit editor открыть локальный файл редактор",
      run: () => openLocalFileFromDialog() },
    ...servers.map((s): CommandItem => ({
      id: `srv:${s.id}`,
      title: s.alias,
      subtitle: `${s.username}@${s.host}:${s.port}`,
      icon: "server",
      group: t("palette.groupServers"),
      keywords: `${s.tags.join(" ")} ${s.group ?? ""} connect подключить`,
      run: () => {
        selectedId = s.id;
        connectServer(s);
      },
    })),
    ...folders.map((f): CommandItem => ({
      id: `fld:${f}`,
      title: nameOf(f),
      subtitle: f,
      icon: "folder",
      group: t("palette.groupFolders"),
      keywords: "folder add server папка добавить",
      run: () => serverForm?.openAdd(f),
    })),
  ]);

  // Keep the native application menu in the same language as the rest of the UI.
  // Re-runs whenever `settings.language` changes (read via `t()`); errors are
  // ignored so a non-Tauri context (e.g. plain `pnpm dev`) doesn't throw.
  $effect(() => {
    setMenuLanguage({
      fileMenu: t("menu.fileMenu"),
      helpMenu: t("menu.helpMenu"),
      settings: t("menu.settings"),
      about: t("menu.about"),
      help: t("menu.help"),
      manual: t("menu.manual"),
      monitoring: t("menu.monitoring"),
    }).catch(() => {});
  });

  function onGlobalKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      showPalette = !showPalette;
      return;
    }
    // Cmd/Ctrl+T — new tab of the active server, or a local shell when the active
    // tab isn't SSH (including when nothing is open). Modifier-exact so it doesn't
    // steal Cmd+Shift+T etc. (Phase 20.15).
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      const action = newTabAction(activeTab);
      if (action.kind === "ssh") {
        const server = servers.find((s) => s.id === action.serverId);
        if (server) {
          void connectServer(server);
          return;
        }
      }
      openLocalTab();
    }
  }

  onMount(() => {
    refresh();
    const unlisteners: UnlistenFn[] = [];
    listen("menu://settings", () => openSettings()).then((u) => unlisteners.push(u));
    listen("menu://about", () => {
      helpTab = "about";
      showHelp = true;
    }).then((u) => unlisteners.push(u));
    listen("menu://help", () => {
      helpTab = "help";
      showHelp = true;
    }).then((u) => unlisteners.push(u));
    listen("menu://manual", () => {
      helpTab = "manual";
      showHelp = true;
    }).then((u) => unlisteners.push(u));
    listen("menu://monitoring", () => openMonitoring()).then((u) => unlisteners.push(u));
    // App-level SFTP progress feed → shared store (read by SFTP panel + status bar).
    listen<SftpProgress>("sftp://progress", (e) => applyProgress(e.payload)).then((u) =>
      unlisteners.push(u),
    );
    // "Open with vterm": files asked for at launch (drained now) and while running.
    takePendingOpens()
      .then((paths) => paths.forEach(handleOpenFile))
      .catch(() => {});
    listen<string>(OPEN_FILE_EVENT, (e) => handleOpenFile(e.payload)).then((u) =>
      unlisteners.push(u),
    );
    // Global Cmd/Ctrl + V/C/X/A for every text input (capture phase, so it works
    // even inside modals and before any field-local handler). See clipboardKeys.ts.
    document.addEventListener("keydown", handleClipboardShortcut, true);
    return () => {
      unlisteners.forEach((u) => u());
      document.removeEventListener("keydown", handleClipboardShortcut, true);
    };
  });

  async function refresh() {
    [servers, folders] = await Promise.all([listServers(), listFolders()]);
    if (!selectedId && servers.length > 0) selectedId = servers[0].id;
  }

  // ── Resize handles ─────────────────────────────────────────────────────────
  function startLeftResize() {
    resizing = "left";
    resizeStartW = layout.leftWidth;
  }
  function startSftpResize() {
    resizing = "sftp";
    resizeStartW = layout.sftpWidth;
  }
  const endResize = () => (resizing = null);

  // Persist the notes window's edits and reflect them in the local server list
  // (so the top-bar "has notes" dot updates). Throws so NotesModal shows an error.
  async function saveNotes(id: string, notes: string) {
    const updated = await setServerNotes(id, notes);
    servers = servers.map((s) => (s.id === updated.id ? updated : s));
  }

  // ── Folder drag (move a server into a group / a folder under a new parent) ──
  async function moveServerToGroup(id: string, groupPath: string | null) {
    try {
      const updated = await setServerGroup(id, groupPath);
      servers = servers.map((s) => (s.id === updated.id ? updated : s));
    } catch (e) {
      notifyError(String(e));
    }
  }
  async function moveFolderAndRefresh(path: string, parent: string | null) {
    try {
      await moveFolder(path, parent);
      [servers, folders] = await Promise.all([listServers(), listFolders()]);
    } catch (e) {
      notifyError(String(e));
    }
  }

  /** Alias shown on a tab — follows server edits, falls back to the snapshot. */
  function tabAlias(tab: Tab): string {
    if (tab.kind === "local") return t("tab.localShell");
    return servers.find((s) => s.id === tab.serverId)?.alias ?? tab.alias;
  }

  // ── Connection / tabs ──────────────────────────────────────────────────────
  async function connectServer(server: ServerProfile) {
    try {
      const plan = await connectPlan(server.id);
      if (plan.needsSecret) secretPrompt?.prompt(server, plan.secretLabel);
      else openTabStore(server.id, server.alias, null, false);
    } catch (e) {
      notifyError(String(e));
    }
  }

  async function startConnect() {
    if (selected) await connectServer(selected);
  }

  /**
   * The server rejected the credentials. Drop the failed tab, forget a stale
   * saved secret (if one was used), and re-open the prompt so the user can retry.
   */
  async function reauth(sessionId: string) {
    const tab = findTab(sessionId);
    if (!tab) return;
    const server = servers.find((s) => s.id === tab.serverId);
    const usedSaved = tab.secret === null;
    closeTabStore(sessionId);
    if (usedSaved) {
      await forgetSecrets(tab.serverId);
      servers = servers.map((s) =>
        s.id === tab.serverId ? { ...s, hasSavedPassword: false } : s,
      );
    }
    if (server) {
      const plan = await connectPlan(server.id);
      const msg =
        plan.secretLabel === "Passphrase"
          ? t("page.passphraseRejected")
          : t("page.passwordRejected");
      secretPrompt?.prompt(server, plan.secretLabel, msg);
    }
  }

  // Confirmation before closing a live tab (settings-gated).
  let closeConfirmId = $state<string | null>(null);
  const closeConfirmTab = $derived(findTab(closeConfirmId));

  function requestCloseTab(sessionId: string) {
    const tab = findTab(sessionId);
    if (tab && isLive(tab.status)) closeConfirmId = sessionId;
    else closeTabFully(sessionId);
  }

  /** Drop a tab and its workspace (open editors) + AI conversation together. */
  function closeTabFully(sessionId: string) {
    removeWorkspace(sessionId);
    removeChat(sessionId);
    removeBroadcastMember(sessionId);
    nginxConfigCache.delete(sessionId);
    closeTabStore(sessionId);
  }

  // ── Config editor (Phase 12) ────────────────────────────────────────────────
  let savingEditorId = $state<string | null>(null);
  let closeEditorConfirm = $state<{ sid: string; doc: EditorDoc } | null>(null);
  // Pre-save diff confirmation (settings-gated) and conflict resolution.
  let diffSave = $state<{ sid: string; doc: EditorDoc } | null>(null);
  let conflict = $state<{ sid: string; doc: EditorDoc; serverText: string } | null>(null);

  /** Configured editor open-size limit, in bytes. */
  const editorMaxBytes = () => settings.sftp.maxOpenMb * 1024 * 1024;

  // Sudo prompt: reopen a permission-denied file as root, or retry a save as root.
  let sudoPrompt = $state<
    | { kind: "open"; path: string; name: string; gotoLine?: number }
    | { kind: "save"; sid: string; doc: EditorDoc }
    | null
  >(null);
  let sudoPasswordInput = $state("");
  const sudoPromptPath = $derived(
    sudoPrompt?.kind === "open"
      ? sudoPrompt.path
      : sudoPrompt?.kind === "save"
        ? sudoPrompt.doc.path
        : "",
  );
  const sudoPromptTitle = $derived(
    sudoPrompt?.kind === "save" ? t("editor.sudoSaveTitle") : t("editor.sudoTitle"),
  );
  const sudoPromptConfirm = $derived(
    sudoPrompt?.kind === "save" ? t("editor.save") : t("editor.sudoOpen"),
  );

  // Per-session cache of the paths nginx actually loads (`nginx -T`), so files that
  // include-outside `/etc/nginx/` still get nginx highlighting + lint. Fetched lazily
  // once per session, best-effort (empty set on error). Cleared in closeTabFully.
  const nginxConfigCache = new Map<
    string,
    { promise: Promise<ReadonlySet<string>>; sudo: boolean }
  >();
  async function ensureNginxConfigs(
    sid: string,
    sudoPassword?: string,
  ): Promise<ReadonlySet<string>> {
    const cached = nginxConfigCache.get(sid);
    if (cached) {
      const set = await cached.promise;
      // Reuse the cached result, except retry with sudo when a plain fetch came back
      // empty and we now hold a password (an open-as-root can read a config tree the
      // plain user can't) — this is silent, no fresh prompt.
      if (!(set.size === 0 && sudoPassword && !cached.sudo)) return set;
    }
    const promise = nginxConfigFiles(sid, sudoPassword)
      .then((list) => new Set(list) as ReadonlySet<string>)
      .catch(() => new Set<string>() as ReadonlySet<string>);
    nginxConfigCache.set(sid, { promise, sudo: !!sudoPassword });
    return promise;
  }

  /** Open a remote file in the in-app editor (invoked from the SFTP panel). */
  async function openFileInEditor(
    path: string,
    name: string,
    opts: { gotoLine?: number; sudo?: boolean; sudoPassword?: string; gitBase?: string } = {},
  ) {
    const sid = tabsState.activeId;
    if (!sid) return;
    // Any file opens in the editor; unknown/extensionless types fall back to plain
    // text (binary/oversize files are still rejected by the backend read below).
    // Pass the full path so custom nginx configs (conf.d, sites-available…) are
    // detected by directory, not just `nginx.conf` by name.
    let lang = editorLangOrPlain(path);
    const existing = findEditorByPath(sid, path);
    if (existing) {
      setActiveView(sid, existing.id);
      return;
    }
    // For a config-shaped file not already recognised as nginx, also consult the set
    // of configs nginx actually loads (nginx -T) — catches includes outside the
    // `/etc/nginx/` tree. Fetched in parallel with the read; resolved just before open.
    const nginxSetP =
      lang.kind !== "nginx" && couldBeNginxInclude(path)
        ? ensureNginxConfigs(sid, opts.sudoPassword)
        : null;
    // Read first, so binary/too-large files just toast instead of opening a tab.
    let file;
    try {
      file = await sftpReadText(sid, path, editorMaxBytes(), opts.sudo, opts.sudoPassword);
    } catch (e) {
      // No read access on a non-sudo read → offer to reopen as root.
      if (!opts.sudo && isPermissionError(e)) {
        sudoPasswordInput = "";
        sudoPrompt = { kind: "open", path, name, gotoLine: opts.gotoLine };
        return;
      }
      notifyError(String(e));
      return;
    }
    if (nginxSetP) lang = editorLangWithIncludes(path, await nginxSetP);
    // Content-based YAML dialects (k8s/Ansible) have no distinguishing name — upgrade
    // once the buffer is read so kubeconform/ansible-lint can run (no-op for non-YAML).
    lang = editorLangWithDialect(lang, file.content);
    const id = addEditor(sid, path, name, lang, "sftp", {
      gotoLine: opts.gotoLine,
      sudo: opts.sudo,
      sudoPassword: opts.sudoPassword,
      gitBase: opts.gitBase,
    });
    fillEditor(sid, id, file);
  }

  /** Confirm the sudo prompt: reopen the pending file as root, or retry the save. */
  function confirmSudo() {
    const p = sudoPrompt;
    const pw = sudoPasswordInput;
    sudoPrompt = null;
    sudoPasswordInput = "";
    if (!p) return;
    if (p.kind === "open") {
      void openFileInEditor(p.path, p.name, { gotoLine: p.gotoLine, sudo: true, sudoPassword: pw });
    } else {
      // Remember sudo on the doc (future saves reuse it), then retry from the store.
      setEditorSudo(p.sid, p.doc.id, pw);
      const updated = findEditorByPath(p.sid, p.doc.path);
      if (updated) void doWriteEditor(p.sid, updated, updated.baseSha256);
    }
  }

  /** Open a LOCAL file in a given workspace's editor (from "Open with vterm"). */
  async function openLocalFileInEditor(sid: string, path: string, opts: { gitBase?: string } = {}) {
    const name = path.split(/[\\/]/).pop() ?? path;
    const existing = findEditorByPath(sid, path);
    if (existing) {
      setActiveView(sid, existing.id);
      return;
    }
    let file;
    try {
      file = await readLocalText(path, editorMaxBytes());
    } catch (e) {
      notifyError(String(e));
      return;
    }
    const id = addEditor(sid, path, name, editorLangOrPlain(path), "local", {
      gitBase: opts.gitBase,
    });
    fillEditor(sid, id, file);
  }

  /** Open a git-changed file as an editable inline diff (from the git panel). */
  function openGitDiff(absPath: string, gitBase: string) {
    const sid = tabsState.activeId;
    if (!sid) return;
    if (activeTab?.kind === "ssh") {
      void openFileInEditor(absPath, absPath.split("/").pop() ?? absPath, { gitBase });
    } else {
      void openLocalFileInEditor(sid, absPath, { gitBase });
    }
  }

  /** Append a pattern to the repo's .gitignore (git panel "Ignore" action). */
  async function appendGitignore(gitignorePath: string, pattern: string) {
    const sid = tabsState.activeId;
    if (!sid) return;
    const ssh = activeTab?.kind === "ssh";
    let current = "";
    try {
      const f = ssh
        ? await sftpReadText(sid, gitignorePath, editorMaxBytes())
        : await readLocalText(gitignorePath, editorMaxBytes());
      current = f.content;
    } catch {
      current = ""; // no .gitignore yet → create it
    }
    if (current.split(/\r?\n/).some((l) => l.trim() === pattern)) {
      notifyInfo(t("git.alreadyIgnored"));
      return;
    }
    const sep = current && !current.endsWith("\n") ? "\n" : "";
    const next = `${current}${sep}${pattern}\n`;
    try {
      if (ssh) await sftpWriteText(sid, gitignorePath, next, "lf", null);
      else await writeLocalText(gitignorePath, next, "lf", null);
      notifySuccess(t("git.ignored", { pattern }));
    } catch (e) {
      notifyError(String(e));
    }
  }

  /**
   * Open an AI-generated script (17.6) as a scratch editor in the active
   * workspace. On an SSH tab it opens as an sftp doc so the server-side linter
   * (shellcheck/yamllint) runs on the buffer; on a local tab it opens locally
   * (syntax lint only). Needs an active session to host the editor.
   */
  function openGeneratedScript(name: string, content: string) {
    const sid = tabsState.activeId;
    if (!sid || (activeTab?.kind !== "ssh" && activeTab?.kind !== "local")) {
      notifyError(t("recordings.scriptNeedsSession"));
      return;
    }
    const source = activeTab.kind === "ssh" ? "sftp" : "local";
    const id = addScratchEditor(sid, name, editorLangOrPlain(name), content, source);
    setActiveView(sid, id);
    showRecordings = false;
  }

  // ── Server tools install helper (Phase 12.8) ────────────────────────────────
  const toolsSessionId = $derived(activeTab?.kind === "ssh" ? activeTab.sessionId : null);
  let installTool = $state<{ sessionId: string; tool: ToolStatus } | null>(null);
  // Bumped after a sudo install finishes so the Settings catalogue re-checks and the
  // tool flips to ✓ Installed without a manual refresh (Phase 20.14).
  let toolsReloadToken = $state(0);

  /** Open the install dialog for a tool on the active SSH connection. */
  function openToolInstall(tool: ToolStatus) {
    if (toolsSessionId) installTool = { sessionId: toolsSessionId, tool };
  }

  /**
   * Open the install dialog for a tool by id/name (used by the monitoring overlay's
   * "Install lm-sensors" CTA). Unlike `offerLintInstall`, it opens the dialog even
   * when the tool reports installed (e.g. `sensors` present but unconfigured — the
   * very case the CTA appears) and surfaces a toast instead of failing silently.
   */
  async function openToolInstallByName(toolName: string) {
    const sid = toolsSessionId;
    if (!sid) return;
    try {
      const status = await serverToolsStatus(sid);
      const tool = status.tools.find((t) => t.name === toolName || t.id === toolName);
      if (tool) installTool = { sessionId: sid, tool };
      else notifyError(t("servertools.notFound", { tool: toolName }));
    } catch {
      notifyError(t("servertools.statusFailed"));
    }
  }

  /**
   * Toggle "follow terminal" for the active session. Turning it off is immediate.
   * Turning it on: if the shell already reports its cwd (OSC 7 seen) or we've already
   * set it up this session, just enable; otherwise open a confirm dialog before typing
   * the shell-integration snippet (session-only, nothing saved on the server).
   */
  function toggleFollowTerminal() {
    const id = tabsState.activeId;
    if (!id) return;
    if (followTerminal[id]) {
      followTerminal[id] = false;
      return;
    }
    if (terminalCwd[id] || shellIntegrated[id]) {
      followTerminal[id] = true;
      return;
    }
    pendingFollowSession = id;
  }

  /** User confirmed: type the OSC 7 setup into the shell and enable following. */
  function confirmFollowSetup() {
    const id = pendingFollowSession;
    pendingFollowSession = null;
    if (!id) return;
    writeToTerminal(id, new TextEncoder().encode(OSC7_SETUP + "\n")).catch(() => {});
    shellIntegrated[id] = true;
    followTerminal[id] = true;
  }

  /**
   * Two-way OSC 7 sync: when the user navigates in the SFTP panel (follow-terminal
   * on), cd the terminal to the same folder. Only fires on user navigation (not on
   * the panel following the terminal), so there's no feedback loop; a no-op when the
   * terminal is already there.
   */
  function cdTerminalTo(path: string) {
    const id = tabsState.activeId;
    if (!id || terminalCwd[id] === path) return;
    const quoted = `'${path.replace(/'/g, "'\\''")}'`;
    void writeToTerminal(id, new TextEncoder().encode(`cd ${quoted}\n`));
  }

  /** Type an install command into the active terminal (user reviews + runs it). */
  function runInstallInTerminal(command: string) {
    const sid = installTool?.sessionId ?? toolsSessionId;
    if (!sid) return;
    setActiveView(sid, TERMINAL_VIEW);
    showSettings = false;
    void writeToTerminal(sid, new TextEncoder().encode(command));
    notifyInfo(t("servertools.typed"));
  }

  /** Lint reported a missing tool: fetch its install command and offer to install. */
  async function offerLintInstall(toolName: string) {
    const sid = toolsSessionId;
    if (!sid) return;
    try {
      const status = await serverToolsStatus(sid);
      const tool = status.tools.find((t) => t.name === toolName || t.id === toolName);
      if (tool && !tool.installed) installTool = { sessionId: sid, tool };
    } catch {
      /* ignore — the toast already told the user it's missing */
    }
  }

  /** Palette "Open local file…": pick a file and open it (like OS open-with). */
  async function openLocalFileFromDialog() {
    const path = await pickOpenFile();
    if (path) handleOpenFile(path);
  }

  /** OS asked to open a file: ensure a local terminal tab, then open the editor. */
  function handleOpenFile(path: string) {
    let sid =
      activeTab?.kind === "local"
        ? activeTab.sessionId
        : (tabsState.list.find((t) => t.kind === "local")?.sessionId ?? null);
    if (!sid) {
      sid = openLocalTab(); // creates the tab and makes it active
    } else {
      tabsState.activeId = sid;
    }
    void openLocalFileInEditor(sid, path);
  }

  /** Save trigger: nothing to do if unchanged; show the diff first when enabled. */
  function saveEditor(sid: string, doc: EditorDoc) {
    if (doc.readOnly || savingEditorId || doc.content === doc.baseContent) return;
    if (settings.editor.diffBeforeSave) {
      diffSave = { sid, doc };
      return;
    }
    void doWriteEditor(sid, doc, doc.baseSha256);
  }

  /** Actually write to the server. `expectedSha` null = force overwrite (conflict). */
  async function doWriteEditor(sid: string, doc: EditorDoc, expectedSha: string | null) {
    if (savingEditorId) return;
    savingEditorId = doc.id;
    try {
      const before = doc.baseContent;
      const res =
        doc.source === "local"
          ? await writeLocalText(doc.path, doc.content, doc.eol, expectedSha)
          : await sftpWriteText(sid, doc.path, doc.content, doc.eol, expectedSha, {
              sudo: doc.sudo,
              sudoPassword: doc.sudoPassword,
              backup: settings.editor.backupOnSave,
            });
      const stat = lineDiffStat(before, doc.content);
      markSaved(sid, doc.id, res);
      notifySuccess(t("editor.saved", { name: doc.name }));
      // Audit trail (Phase 11 tie-in): record the edit if the session is recording.
      if (isRecording(sid)) {
        void annotateRecording(
          sid,
          t("editor.auditEdit", { path: doc.path, added: stat.added, removed: stat.removed }),
        );
      }
    } catch (e) {
      if (isFileChangedError(e)) {
        // Fetch the current on-disk text and let the user resolve the conflict.
        try {
          const cur =
            doc.source === "local"
              ? await readLocalText(doc.path, editorMaxBytes())
              : await sftpReadText(sid, doc.path, editorMaxBytes(), doc.sudo, doc.sudoPassword);
          conflict = { sid, doc, serverText: cur.content };
        } catch {
          notifyError(t("editor.conflict", { name: doc.name }));
        }
      } else if (!doc.sudo && doc.source === "sftp" && isPermissionError(e)) {
        // Can't write into the target dir (no permission) → offer to save as root.
        sudoPasswordInput = "";
        sudoPrompt = { kind: "save", sid, doc };
      } else {
        notifyError(String(e));
      }
    } finally {
      savingEditorId = null;
    }
  }

  function confirmDiffSave() {
    const s = diffSave;
    diffSave = null;
    if (s) void doWriteEditor(s.sid, s.doc, s.doc.baseSha256);
  }

  /** Conflict: overwrite the server's newer version with mine (skip the hash check). */
  function overwriteConflict() {
    const c = conflict;
    conflict = null;
    if (c) void doWriteEditor(c.sid, c.doc, null);
  }

  /** Conflict: discard my changes and reopen the file fresh from the server. */
  function reopenConflict() {
    const c = conflict;
    conflict = null;
    if (!c) return;
    closeEditorStore(c.sid, c.doc.id);
    if (c.doc.source === "local") void openLocalFileInEditor(c.sid, c.doc.path);
    else
      void openFileInEditor(c.doc.path, c.doc.name, {
        sudo: c.doc.sudo,
        sudoPassword: c.doc.sudoPassword,
      });
  }

  /** Close an editor sub-tab, confirming first when it has unsaved changes. */
  function requestCloseEditor(sid: string, doc: EditorDoc) {
    if (isDirty(doc)) closeEditorConfirm = { sid, doc };
    else closeEditorStore(sid, doc.id);
  }

  // Roving keyboard navigation across tabs (a11y): arrows/Home/End move focus
  // and selection; Enter/Space activate the focused tab.
  function focusTab(index: number) {
    barEl?.querySelectorAll<HTMLElement>("[data-tab]")[index]?.focus();
  }

  function onTabKey(event: KeyboardEvent, sessionId: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      tabsState.activeId = sessionId;
      return;
    }
    const i = tabsState.list.findIndex((t) => t.sessionId === sessionId);
    const next = nextTabIndex(i, tabsState.list.length, event.key);
    if (next === null) return;
    event.preventDefault();
    tabsState.activeId = tabsState.list[next].sessionId;
    focusTab(next);
  }

  // ── Tab drag-to-reorder ────────────────────────────────────────────────────
  function tabPointerDown(event: PointerEvent, sessionId: string) {
    if (!barEl || (event.target as HTMLElement).closest("[data-close]")) return;
    dragSession = sessionId;
    dragStartX = event.clientX;
    dragMoved = false;
  }

  function barPointerMove(event: PointerEvent) {
    if (dragSession === null || !barEl) return;
    if (!dragMoved) {
      if (Math.abs(event.clientX - dragStartX) < 4) return;
      dragMoved = true;
      barEl.setPointerCapture(event.pointerId);
    }
    tabDragX = event.clientX;
    tabDragY = event.clientY;

    const els = Array.from(barEl.querySelectorAll<HTMLElement>("[data-tab]"));
    let over = -1;
    for (let k = 0; k < els.length; k++) {
      const r = els[k].getBoundingClientRect();
      if (event.clientX >= r.left && event.clientX <= r.right) {
        over = k;
        break;
      }
    }
    if (over !== -1 && dragSession) moveTab(dragSession, over);
  }

  function barPointerUp(event: PointerEvent) {
    if (dragSession !== null) {
      if (dragMoved) {
        try {
          barEl?.releasePointerCapture(event.pointerId);
        } catch {
          /* capture may already be released */
        }
      } else {
        tabsState.activeId = dragSession;
      }
    }
    dragSession = null;
    dragMoved = false;
  }

  // ── Server CRUD ────────────────────────────────────────────────────────────
  let serverToDelete = $state<ServerProfile | null>(null);

  async function doDeleteServer(id: string) {
    const alias = servers.find((s) => s.id === id)?.alias ?? t("page.serverFallbackName");
    closeTabsForServer(id);
    try {
      await deleteServer(id);
      servers = servers.filter((s) => s.id !== id);
      if (selectedId === id) selectedId = servers[0]?.id ?? null;
      notifySuccess(t("page.serverDeleted", { alias }));
    } catch (e) {
      notifyError(String(e));
    }
  }
</script>

<svelte:window onkeydown={onGlobalKey} />

<div class="flex h-screen w-screen flex-col">
  <!-- Signature-theme depth: a subtle full-window overlay above all content,
       below modals — unifies terminal + chrome without touching the renderer. -->
  <ThemeOverlay />
  <!-- Idle screensaver (Phase 0.28): full-window canvas over the terminal after
       inactivity, and the NO SIGNAL takeover on an unexpected drop. Copies the
       buffer; never writes to the PTY. -->
  <IdleOverlay
    sessionId={topConnected && activeTab?.kind === "ssh" ? activeTab.sessionId : null}
    alias={activeTab?.alias ?? ""}
    bufferText={() => termRefs[tabsState.activeId ?? ""]?.bufferText?.() ?? ""}
    outputTick={idleOutputTick}
    noSignal={noSignalSession !== null}
    targetEl={terminalArea ?? mainArea ?? null}
    onnosignaldismiss={() => (noSignalSession = null)}
  />
  <TopBar
    title={topTitle}
    subtitle={topSubtitle}
    connected={topConnected}
    canRecord={bcOn ? bcTargets.length > 0 : !!(activeTab && isLive(activeTab.status))}
    recording={bcOn ? !!broadcastBatch : !!(activeTab && isRecording(activeTab.sessionId))}
    onToggleRecording={toggleRecording}
    onOpenRecordings={() => (showRecordings = true)}
    onOpenMonitoring={openMonitoring}
    onOpenSettings={() => openSettings("servertools")}
    canBroadcast={!!tabsState.activeId}
    broadcastActive={bcOn}
    onToggleBroadcast={toggleActiveBroadcast}
    showNotes={!!notesServerTarget}
    hasNotes={hasNotes(notesServerTarget?.notes)}
    onOpenNotes={() => (notesServer = notesServerTarget)}
  />

  <div class="flex min-h-0 flex-1">
    <ServerTree
      {servers}
      {folders}
      {selectedId}
      {selectedFolder}
      connections={serverConnections}
      onSelect={(id) => {
        selectedId = id;
        selectedFolder = null;
      }}
      onSelectFolder={(p) => {
        selectedFolder = p;
        selectedId = null;
      }}
      onConnect={startConnect}
      onAddServer={() => serverForm?.openAdd(selectedFolder ?? "")}
      onEditServer={(s) => {
        selectedId = s.id;
        serverForm?.openEdit(s);
      }}
      onDuplicateServer={(s) => {
        selectedId = s.id;
        serverForm?.openDuplicate(s);
      }}
      onDeleteServer={(s) => (serverToDelete = s)}
      onNewFolder={(p) => folderModals?.openCreate(p)}
      onRenameFolder={(p) => folderModals?.openRename(p)}
      onDeleteFolder={(p) => folderModals?.openDelete(p)}
      onMoveServer={moveServerToGroup}
      onMoveFolder={moveFolderAndRefresh}
      animateWidth={resizing !== "left"}
    />
    {#if !layout.leftCollapsed}
      <!-- Drag handle to resize the server list. -mx-0.5 cancels its 4px layout
           width so the panel border sits flush against the tab bar; the strip
           overlays the seam (blue on hover) instead of wedging a gap into it. -->
      <div
        role="separator"
        aria-orientation="vertical"
        class="relative z-10 -mx-0.5 w-1 shrink-0 cursor-col-resize hover:bg-accent {resizing === 'left'
          ? 'bg-accent'
          : 'bg-transparent'}"
        use:resizableHandle={{
          onStart: startLeftResize,
          onResize: (dx) => (layout.leftWidth = clamp(resizeStartW + dx, LEFT_MIN, LEFT_MAX)),
          onEnd: endResize,
        }}
      ></div>
    {/if}

    <!-- Right: tabbed terminals -->
    <main bind:this={mainArea} class="flex min-w-0 flex-1 flex-col bg-panel">
      <!-- Tab bar always visible so the local-terminal "+" is reachable even
           with no open sessions. -->
      <div
        bind:this={barEl}
        role="tablist"
        tabindex={-1}
        onpointermove={barPointerMove}
        onpointerup={barPointerUp}
        class="flex min-h-8 select-none items-stretch border-b border-edge bg-panel-alt"
      >
        {#each tabsState.list as tab (tab.sessionId)}
          <div
            data-tab
            role="tab"
            tabindex={tabsState.activeId === tab.sessionId ? 0 : -1}
            aria-selected={tabsState.activeId === tab.sessionId}
            onpointerdown={(e) => tabPointerDown(e, tab.sessionId)}
            onkeydown={(e) => onTabKey(e, tab.sessionId)}
            class="flex max-w-48 cursor-grab items-center gap-2 border-r border-edge px-3 py-1.5 text-sm touch-none active:cursor-grabbing {tabsState.activeId ===
            tab.sessionId
              ? 'bg-panel text-white'
              : 'text-muted hover:bg-edge'}"
            title={localizedStatus(tab.status)}
          >
            <!-- Status / recording / broadcast dots grouped tightly together. -->
            <span class="flex shrink-0 items-center gap-0.5">
              <span class="h-2 w-2 rounded-full {dotClass(tab.status)}"></span>
              {#if recordingState[tab.sessionId]}
                {#if recordingPaused[tab.sessionId]}
                  <Icon
                    name="pause"
                    size={12}
                    class="text-green-500"
                    title={t("recordings.paused")}
                  />
                {:else}
                  <span
                    class="h-2 w-2 animate-pulse rounded-full bg-danger"
                    use:tooltip={t("recordings.recording")}
                    aria-label={t("recordings.recording")}
                  ></span>
                {/if}
              {/if}
              <!-- Broadcast membership indicator: a blue dot on every tab that
                   belongs to the group — shown regardless of which tab is active,
                   so the group stays visible while viewing a non-member tab. -->
              {#if isBroadcastMember(tab.sessionId)}
                <span
                  data-broadcast-member
                  class="h-2 w-2 rounded-full bg-blue-500"
                  use:tooltip={t("broadcast.memberDot")}
                  aria-label={t("broadcast.memberDot")}
                ></span>
              {/if}
            </span>
            <span class="truncate">{tabAlias(tab)}</span>
            <button
              data-close
              class="shrink-0 rounded p-0.5 text-muted hover:text-danger"
              aria-label={t("tab.close")}
              onclick={(e) => {
                e.stopPropagation();
                requestCloseTab(tab.sessionId);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        {/each}
        <!-- Open a local-shell terminal tab (same "+" as the top bar). -->
        <button
          data-testid="new-local-terminal"
          class="flex shrink-0 items-center rounded-none px-2.5 py-1.5 text-muted hover:bg-edge hover:text-white"
          use:tooltip={t("tab.openLocalTerminal")}
          aria-label={t("tab.openLocalTerminal")}
          onclick={() => openLocalTab()}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      {#if tabsState.list.length > 0}
        <div class="flex min-h-0 flex-1">
          <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            {#if bcOn}
              <!-- Broadcast toolbar: group size, layout, quick actions, exit. -->
              <div class="flex shrink-0 items-center gap-2 border-b border-edge bg-panel-alt px-2 py-1 text-xs">
                <Icon name="broadcast" size={14} class="text-accent" />
                <span class="font-medium text-white">{t("broadcast.title")}</span>
                <span class="text-muted">{t("broadcast.targetCount", { count: bcTargets.length })}</span>
                <div class="mx-1 flex items-center gap-0.5 rounded bg-panel p-0.5">
                  <button
                    class="rounded p-1 {bcLayout === 'grid' ? 'bg-edge text-white' : 'text-muted hover:text-white'}"
                    onclick={() => (broadcastState.layoutMode = "grid")}
                    use:tooltip={t("broadcast.layoutGrid")}
                    aria-label={t("broadcast.layoutGrid")}
                  >
                    <Icon name="layoutGrid" size={14} />
                  </button>
                  <button
                    class="rounded p-1 {bcLayout === 'focus' ? 'bg-edge text-white' : 'text-muted hover:text-white'}"
                    onclick={() => (broadcastState.layoutMode = "focus")}
                    use:tooltip={t("broadcast.layoutFocus")}
                    aria-label={t("broadcast.layoutFocus")}
                  >
                    <Icon name="layoutFocus" size={14} />
                  </button>
                </div>
                <button
                  class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-white"
                  onclick={addAllConnected}
                  use:tooltip={t("broadcast.addAllConnected")}
                  aria-label={t("broadcast.addAllConnected")}
                >
                  <Icon name="plus" size={14} />
                </button>
                <button
                  class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-danger"
                  onclick={clearBroadcastMembers}
                  use:tooltip={t("broadcast.clear")}
                  aria-label={t("broadcast.clear")}
                >
                  <Icon name="trash" size={14} />
                </button>
                <div class="flex-1"></div>
                <button
                  class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-white"
                  onclick={() => {
                    if (tabsState.activeId) removeBroadcastMember(tabsState.activeId);
                    void syncBatchRecording();
                  }}
                  use:tooltip={t("broadcast.exit")}
                  aria-label={t("broadcast.exit")}
                >
                  <Icon name="minus" size={14} />
                </button>
              </div>
            {/if}
            <div
              bind:this={terminalArea}
              bind:clientWidth={bcAreaWidth}
              class={bcOn
                ? bcLayout === "grid"
                  ? "grid min-h-0 min-w-0 flex-1 gap-1 overflow-y-auto p-1"
                  : "flex min-h-0 min-w-0 flex-1 gap-1 p-1"
                : "relative min-h-0 min-w-0 flex-1"}
              style={bcOn && bcLayout === "grid"
                ? `grid-template-columns: repeat(${bcCols}, minmax(0, 1fr)); grid-auto-rows: minmax(220px, 1fr);`
                : ""}
            >
            {#each tabsState.list as tab (tab.sessionId)}
              {@const ws = getWorkspace(tab.sessionId)}
              {@const bcTile = bcOn && (bcLayout === "grid" ? isBroadcastMember(tab.sessionId) : tab.sessionId === bcFocusId)}
              {@const bcSrv = servers.find((s) => s.id === tab.serverId)}
              <div
                class={bcOn && !bcTile
                  ? "hidden"
                  : bcTile
                    ? bcLayout === "grid"
                      ? "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-edge"
                      : "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded border border-edge"
                    : `absolute inset-0 flex flex-col ${tabsState.activeId === tab.sessionId ? "" : "invisible"}`}
              >
                {#if bcTile}
                  <div class="flex shrink-0 items-center gap-2 border-b border-edge bg-panel-alt px-2 py-1 font-mono text-[11px]">
                    <span class="h-2 w-2 shrink-0 rounded-full {dotClass(tab.status)}"></span>
                    <span class="shrink-0 truncate text-white">{tabAlias(tab)}</span>
                    <span class="min-w-0 flex-1 truncate text-muted">
                      {bcSrv ? `${bcSrv.username}@${bcSrv.host}:${bcSrv.port}` : ""}
                    </span>
                    {#if bcSrv && isProdServer(bcSrv.tags)}
                      <span class="shrink-0 rounded bg-danger/30 px-1 text-[10px] text-danger">prod</span>
                    {/if}
                  </div>
                {/if}
                {#if ws.editors.length > 0 && !bcOn}
                  <!-- Workspace sub-tabs: terminal + open editors (Phase 12). -->
                  <div class="flex shrink-0 items-stretch overflow-x-auto border-b border-edge bg-panel-alt text-xs">
                    <button
                      class="flex shrink-0 items-center gap-1.5 border-r border-edge px-3 py-1 {ws.active ===
                      TERMINAL_VIEW
                        ? 'bg-panel text-white'
                        : 'text-muted hover:bg-edge hover:text-white'}"
                      onclick={() => setActiveView(tab.sessionId, TERMINAL_VIEW)}
                    >
                      <Icon name="terminal" size={13} />
                      {t("workspace.terminal")}
                    </button>
                    {#each ws.editors as ed (ed.id)}
                      <div
                        class="group flex shrink-0 items-center border-r border-edge {ws.active === ed.id
                          ? 'bg-panel text-white'
                          : 'text-muted hover:bg-edge'}"
                      >
                        <button
                          class="flex items-center gap-1.5 py-1 pl-2"
                          title={ed.path}
                          onclick={() => setActiveView(tab.sessionId, ed.id)}
                        >
                          <Icon name="file" size={13} />
                          <span class="max-w-32 truncate">{ed.name}</span>
                          {#if isDirty(ed)}
                            <span class="h-1.5 w-1.5 rounded-full bg-accent" use:tooltip={t("editor.unsaved")}></span>
                          {/if}
                        </button>
                        <button
                          class="rounded px-1.5 py-1 opacity-60 hover:text-danger hover:opacity-100"
                          aria-label={t("common.close")}
                          onclick={() => requestCloseEditor(tab.sessionId, ed)}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}
                <div class="relative min-h-0 flex-1 p-1">
                <div class="absolute inset-0 {ws.active === TERMINAL_VIEW || bcOn ? '' : 'invisible'}">
                {#if tab.kind === "ssh" && tab.status.startsWith("Connecting")}
                  {@const srv = servers.find((s) => s.id === tab.serverId)}
                  <ConnectingOverlay
                    alias={tab.alias}
                    host={srv ? `${srv.username}@${srv.host}:${srv.port}` : tab.alias}
                    phase={connPhase[tab.sessionId] ?? "connecting"}
                    proxy={srv?.proxy ? (srv.proxy.kind === "jump" ? "jump" : "tcp") : null}
                    via={srv?.proxy ? `${srv.proxy.host}:${srv.proxy.port}` : undefined}
                  />
                {:else if tab.kind === "ssh" && (tab.status.startsWith("Error") || tab.status.startsWith("Disconnected"))}
                  {@const srv = servers.find((s) => s.id === tab.serverId)}
                  {@const ev = sshErrorView(
                    tab.status,
                    connPhase[tab.sessionId] ?? "connecting",
                  )}
                  <ConnectingOverlay
                    failed
                    alias={tab.alias}
                    host={srv ? `${srv.username}@${srv.host}:${srv.port}` : tab.alias}
                    phase={ev.phase}
                    title={t(ev.titleKey)}
                    detail={ev.detailKey ? t(ev.detailKey) : ev.detailText}
                    showSteps={ev.showSteps}
                    proxy={srv?.proxy ? (srv.proxy.kind === "jump" ? "jump" : "tcp") : null}
                    via={srv?.proxy ? `${srv.proxy.host}:${srv.proxy.port}` : undefined}
                  >
                    {#if ev.action === "reauth"}
                      <button
                        class="flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-panel-alt hover:bg-accent-hover"
                        onclick={() => reauth(tab.sessionId)}
                      >
                        {t("connecting.retryAuth")}
                      </button>
                    {:else}
                      <button
                        class="flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-panel-alt hover:bg-accent-hover"
                        onclick={() => reconnectTabStore(tab.sessionId)}
                      >
                        <Icon name="refresh" size={14} />
                        {t("common.reconnect")}
                      </button>
                    {/if}
                  </ConnectingOverlay>
                {:else if tab.status.startsWith("Disconnected") || tab.status.startsWith("Error")}
                  <!-- Local shells: keep the lightweight top banner. -->
                  <div
                    class="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 border-b border-edge bg-panel-alt/95 px-3 py-1.5 text-xs"
                  >
                    <span class="text-muted">{localizedStatus(tab.status)}</span>
                    <button
                      class="rounded bg-accent px-2 py-0.5 text-panel-alt hover:bg-accent-hover"
                      onclick={() => reconnectTabStore(tab.sessionId)}
                    >
                      {t("common.reconnect")}
                    </button>
                  </div>
                {/if}
                {#key tab.gen}
                  <TerminalView
                    bind:this={termRefs[tab.sessionId]}
                    sessionId={tab.sessionId}
                    serverId={tab.serverId}
                    secret={tab.secret}
                    remember={tab.remember}
                    local={tab.kind === "local"}
                    onresize={(cols, rows) => (termDims[tab.sessionId] = { cols, rows })}
                    onactivity={() => handleTerminalActivity(tab.sessionId)}
                    onoutput={() => idleOutputTick++}
                    oncwd={(path) => (terminalCwd[tab.sessionId] = path)}
                    onphase={(p) => (connPhase[tab.sessionId] = p)}
                    onstatus={(st, d) => {
                      setTabStatus(tab.sessionId, st, d);
                      if (st === "connecting") connPhase[tab.sessionId] = "connecting";
                      if (st === "connected") idleWasConnected.add(tab.sessionId);
                      if (st === "connecting" && noSignalSession === tab.sessionId)
                        noSignalSession = null;
                      if (st === "closed") {
                        finalizeRecordingOnClose(tab.sessionId);
                        // Unexpected drop of a connected session (tab survives) →
                        // NO SIGNAL, unless auto-reconnect will bring it back.
                        const was = idleWasConnected.delete(tab.sessionId);
                        if (
                          findTab(tab.sessionId) &&
                          !settings.autoReconnect &&
                          tab.kind === "ssh" &&
                          showNoSignal({ userInitiated: false, wasConnected: was })
                        ) {
                          noSignalSession = tab.sessionId;
                        }
                      }
                      if (st === "connected") maybeAutoRecord(tab);
                      // Auth failures now keep the tab and show the error overlay
                      // (the user re-enters the secret via its button), so we no
                      // longer auto-close/re-prompt here.
                      if (st === "closed" && settings.autoReconnect && tab.kind === "ssh") {
                        setTimeout(() => {
                          if (findTab(tab.sessionId)) reconnectTabStore(tab.sessionId);
                        }, 1000);
                      }
                    }}
                  />
                {/key}
                </div>
                {#if !bcOn}
                {#each ws.editors as ed (ed.id)}
                  <div class="absolute inset-0 {ws.active === ed.id ? '' : 'invisible'}">
                    {#if ed.loadError}
                      <div class="p-4 text-sm text-danger">{ed.loadError}</div>
                    {:else if ed.loading}
                      <div class="p-4 text-sm text-muted">{t("editor.loading")}</div>
                    {:else}
                      <EditorTab
                        sessionId={tab.sessionId}
                        doc={ed}
                        saving={savingEditorId === ed.id}
                        onsave={() => saveEditor(tab.sessionId, ed)}
                        onLintMissing={offerLintInstall}
                      />
                    {/if}
                  </div>
                {/each}
                {/if}
                </div>
              </div>
            {/each}
              {#if bcOn && bcLayout === "focus" && bcMemberTabs.length > 0}
                <BroadcastRoster
                  rows={bcRosterRows}
                  onfocus={(id) => (tabsState.activeId = id)}
                  onremove={(id) => {
                    removeBroadcastMember(id);
                    void syncBatchRecording();
                  }}
                />
              {/if}
            </div>
            {#if bcOn}
              <BroadcastBar
                disabled={bcTargets.length === 0}
                prodWarn={bcHasProd}
                onsend={requestBroadcast}
              />
            {/if}
          </div>
          {#if tabsState.activeId && (activeTab?.kind === "ssh" || activeTab?.kind === "local")}
            {#if !layout.sftpCollapsed}
              <div
                role="separator"
                aria-orientation="vertical"
                class="relative z-10 -mx-0.5 w-1 shrink-0 cursor-col-resize hover:bg-accent {resizing === 'sftp'
                  ? 'bg-accent'
                  : 'bg-transparent'}"
                use:resizableHandle={{
                  onStart: startSftpResize,
                  onResize: (dx) => (layout.sftpWidth = clamp(resizeStartW - dx, SFTP_MIN, SFTP_MAX)),
                  onEnd: endResize,
                }}
              ></div>
            {/if}
            {#key tabsState.activeId}
              <RightDock
                width={layout.sftpWidth}
                bind:collapsed={layout.sftpCollapsed}
                bind:activeTab={layout.dockTab}
                animateWidth={resizing !== "sftp"}
                kind={activeTab?.kind === "ssh" ? "ssh" : "local"}
                sessionId={tabsState.activeId}
                chatPromptId={activeTab?.kind === "ssh"
                  ? (servers.find((s) => s.id === activeTab.serverId)?.chatPromptId ?? null)
                  : null}
                serverExecMode={activeTab?.kind === "ssh"
                  ? (servers.find((s) => s.id === activeTab.serverId)?.execMode ?? null)
                  : null}
                sessionReady={sftpReady}
                terminalCwd={tabsState.activeId ? (terminalCwd[tabsState.activeId] ?? null) : null}
                followTerminal={tabsState.activeId
                  ? (followTerminal[tabsState.activeId] ?? false)
                  : false}
                onToggleFollowTerminal={toggleFollowTerminal}
                getAiContext={gatherAiContext}
                {aiProd}
                {aiNoAi}
                onOpenFile={(path, name, gotoLine) =>
                  openFileInEditor(path, name, { gotoLine })}
                onOpenLocalFile={(path) => {
                  if (tabsState.activeId) openLocalFileInEditor(tabsState.activeId, path);
                }}
                onOpenGitDiff={openGitDiff}
                onIgnoreGitignore={appendGitignore}
                onSftpNavigate={cdTerminalTo}
              />
            {/key}
          {/if}
        </div>
      {:else}
        <EmptyState
          icon="server"
          title={selected ? t("page.emptyServerTitle", { alias: selected.alias }) : t("page.emptyNoSession")}
          hint={selected ? t("page.hintConnect") : t("page.hintSelect")}
        >
          {#if selected}
            <button
              data-testid="connect"
              class="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-500"
              onclick={startConnect}
            >
              {t("common.connect")}
            </button>
          {/if}
        </EmptyState>
      {/if}
    </main>
  </div>

  {#if settings.showStatusBar && tabsState.activeId && activeTab?.kind === "ssh" && activeTab?.status.startsWith("Connected")}
    {#key tabsState.activeId}
      <StatusBar sessionId={tabsState.activeId} />
    {/key}
  {/if}
</div>

{#if tabsState.activeId}
  <MonitoringOverlay
    bind:open={showMonitoring}
    sessionId={tabsState.activeId}
    onInstallTool={openToolInstallByName}
  />
{/if}

<!-- While resizing: keep the col-resize cursor and suppress text selection. -->
{#if resizing}
  <div class="fixed inset-0 z-50 cursor-col-resize select-none"></div>
{/if}

<!-- Drag ghost for a terminal tab being reordered. -->
{#if draggingTab}
  <div
    in:fade={{ duration: 120 }}
    class="pointer-events-none fixed z-50 flex max-w-48 items-center gap-2 rounded border border-accent bg-panel-alt px-3 py-1.5 text-sm opacity-90 shadow-lg"
    style="left: {tabDragX + 12}px; top: {tabDragY + 8}px"
  >
    <span class="h-2 w-2 shrink-0 rounded-full {dotClass(draggingTab.status)}"></span>
    <span class="truncate">{tabAlias(draggingTab)}</span>
  </div>
{/if}

<SettingsPanel
  bind:open={showSettings}
  onImported={refresh}
  {toolsSessionId}
  {toolsReloadToken}
  onInstallTool={openToolInstall}
  initialSection={settingsSection}
/>

<!-- Server tool install dialog (Phase 12.8) -->
<ToolInstallDialog
  open={!!installTool}
  sessionId={installTool?.sessionId ?? ""}
  tool={installTool?.tool ?? null}
  onRunInTerminal={runInstallInTerminal}
  onInstalled={() => (toolsReloadToken += 1)}
  onclose={() => (installTool = null)}
/>
<HelpPanel bind:open={showHelp} bind:tab={helpTab} />

<!-- Per-server notes editor (opened from the top bar for the selected server). -->
{#if notesServer}
  <NotesModal
    server={notesServer}
    onsave={(notes) => saveNotes(notesServer!.id, notes)}
    onclose={() => (notesServer = null)}
  />
{/if}

<!-- Folder create / rename / delete modals (own their own state; Phase 18.4.3) -->
<FolderModals
  bind:this={folderModals}
  onchanged={async () => {
    [servers, folders] = await Promise.all([listServers(), listFolders()]);
  }}
/>

<!-- Delete server confirmation -->
<ConfirmDialog
  open={!!serverToDelete}
  title={t("page.deleteServerTitle")}
  confirmLabel={t("common.delete")}
  onconfirm={async () => {
    if (serverToDelete) await doDeleteServer(serverToDelete.id);
    serverToDelete = null;
  }}
  oncancel={() => (serverToDelete = null)}
>
  {t("page.deleteServerBody1")} <span class="text-white">{serverToDelete?.alias}</span> {t("page.deleteServerBody2")}
</ConfirmDialog>

<!-- Broadcast: confirm before sending to a group that includes a prod server -->
<ConfirmDialog
  open={!!pendingBroadcast}
  title={t("broadcast.prodConfirmTitle")}
  confirmLabel={t("broadcast.prodConfirmSend")}
  danger
  onconfirm={async () => {
    const pb = pendingBroadcast;
    pendingBroadcast = null;
    if (!pb) return;
    // Prod broadcast → auto-record the whole group first (audit trail), then send.
    await ensureGroupRecording();
    doBroadcast(pb.frame, pb.targets, pb.cmd);
  }}
  oncancel={() => (pendingBroadcast = null)}
>
  {t("broadcast.prodConfirmBody1")}
  <span class="text-white">{pendingBroadcast?.targets.length ?? 0}</span>
  {t("broadcast.prodConfirmBody2")}
  <span class="text-danger">{pendingProdAliases.join(", ")}</span>
  <pre
    class="mt-2 overflow-x-auto rounded border border-edge bg-panel p-2 text-[11px] leading-relaxed text-muted"
  >{pendingBroadcast ? pendingBroadcast.frame.replace(/\n$/, "") : ""}</pre>
</ConfirmDialog>

<!-- Shell-integration consent for "follow terminal" (session-only OSC 7 setup) -->
<ConfirmDialog
  open={pendingFollowSession !== null}
  title={t("sftp.followSetupTitle")}
  confirmLabel={t("sftp.followSetupConfirm")}
  danger={false}
  onconfirm={confirmFollowSetup}
  oncancel={() => (pendingFollowSession = null)}
>
  <p class="mb-2">{t("sftp.followSetupBody")}</p>
  <pre
    class="overflow-x-auto rounded border border-edge bg-panel p-2 text-[11px] leading-relaxed text-muted"
  >{osc7SetupDisplay()}</pre>
</ConfirmDialog>

<!-- Tab close confirmation -->
<ConfirmDialog
  open={!!closeConfirmTab}
  title={t("page.closeTabTitle")}
  confirmLabel={t("common.close")}
  danger={false}
  onconfirm={() => {
    if (closeConfirmId) closeTabFully(closeConfirmId);
    closeConfirmId = null;
  }}
  oncancel={() => (closeConfirmId = null)}
>
  {t("page.closeTabBody1")} <span class="text-white">{closeConfirmTab ? tabAlias(closeConfirmTab) : ""}</span>
  {t("page.closeTabBody2")}
</ConfirmDialog>

<!-- Discard-unsaved confirmation when closing an edited file -->
<ConfirmDialog
  open={!!closeEditorConfirm}
  title={t("editor.discardTitle")}
  confirmLabel={t("editor.discard")}
  danger
  onconfirm={() => {
    if (closeEditorConfirm) closeEditorStore(closeEditorConfirm.sid, closeEditorConfirm.doc.id);
    closeEditorConfirm = null;
  }}
  oncancel={() => (closeEditorConfirm = null)}
>
  {t("editor.discardBody1")}
  <span class="text-white">{closeEditorConfirm?.doc.name}</span>
  {t("editor.discardBody2")}
</ConfirmDialog>

<!-- Sudo prompt: reopen (or re-save) a permission-denied file as root -->
<Modal open={!!sudoPrompt} title={sudoPromptTitle} onclose={() => (sudoPrompt = null)}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      confirmSudo();
    }}
  >
    <p class="mb-2 break-all text-xs text-muted">{sudoPromptPath}</p>
    <input
      type="password"
      autocomplete="off"
      class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
      placeholder={t("editor.sudoPassword")}
      bind:value={sudoPasswordInput}
    />
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-white"
        onclick={() => (sudoPrompt = null)}>{t("common.cancel")}</button
      >
      <button
        type="submit"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
        >{sudoPromptConfirm}</button
      >
    </div>
  </form>
</Modal>

<!-- Pre-save diff: server version ⇄ what we'll write (settings-gated) -->
<DiffModal
  open={!!diffSave}
  title={diffSave ? t("editor.diffSaveTitle", { name: diffSave.doc.name }) : ""}
  original={diffSave?.doc.baseContent ?? ""}
  modified={diffSave?.doc.content ?? ""}
  originalLabel={t("editor.serverVersion")}
  modifiedLabel={t("editor.yourVersion")}
  onclose={() => (diffSave = null)}
>
  <button
    class="rounded px-3 py-1 text-sm text-muted hover:text-white"
    onclick={() => (diffSave = null)}>{t("common.cancel")}</button
  >
  <button
    class="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-500"
    onclick={confirmDiffSave}>{t("editor.save")}</button
  >
</DiffModal>

<!-- Conflict: the file changed on the server since it was opened -->
<DiffModal
  open={!!conflict}
  title={conflict ? t("editor.conflictTitle", { name: conflict.doc.name }) : ""}
  original={conflict?.serverText ?? ""}
  modified={conflict?.doc.content ?? ""}
  originalLabel={t("editor.serverNow")}
  modifiedLabel={t("editor.yourVersion")}
  onclose={() => (conflict = null)}
>
  <button
    class="rounded px-3 py-1 text-sm text-muted hover:text-white"
    onclick={() => (conflict = null)}>{t("common.cancel")}</button
  >
  <button
    class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
    onclick={reopenConflict}>{t("editor.reopen")}</button
  >
  <button
    class="rounded bg-danger px-3 py-1 text-sm text-panel-alt hover:opacity-90"
    onclick={overwriteConflict}>{t("editor.overwrite")}</button
  >
</DiffModal>

<!-- Name/describe (or discard) a recording right after stopping it -->
<RecordingSaveDialog
  open={saveRec !== null}
  heading={t("recordings.saveTitle")}
  defaultTitle={saveRec?.defaultTitle ?? ""}
  onsave={saveRecording}
  ondelete={discardRecording}
  onclose={() => (saveRec = null)}
/>

<!-- Name (or discard) a just-stopped broadcast bundle. -->
<RecordingSaveDialog
  open={saveBatch !== null}
  heading={t("recordings.saveBroadcastTitle")}
  onsave={(title) => saveBatchName(title)}
  ondelete={discardBatch}
  onclose={() => (saveBatch = null)}
/>

<!-- Password / passphrase prompt (owns its own state; Phase 18.4.4) -->
<SecretPrompt bind:this={secretPrompt} />

<!-- Add / Edit server modal (owns its own form state; Phase 18.4.2) -->
<ServerFormModal
  bind:this={serverForm}
  onsaved={(server, mode) => {
    if (mode === "edit") {
      servers = servers.map((s) => (s.id === server.id ? server : s));
    } else {
      servers = [...servers, server];
      selectedId = server.id;
      selectedFolder = null;
    }
  }}
  onforgotten={(id) => {
    servers = servers.map((s) => (s.id === id ? { ...s, hasSavedPassword: false } : s));
  }}
  onOpenAiPrompts={() => openSettings("ai")}
/>

<!-- Command palette (⌘K) -->
<CommandPalette bind:open={showPalette} commands={paletteCommands} />

<!-- Session recordings library (Phase 11) -->
<RecordingsPanel bind:open={showRecordings} onOpenScript={openGeneratedScript} />

<!-- Global non-blocking notifications -->
<Toast />
