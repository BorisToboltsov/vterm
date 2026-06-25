<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import {
    addFolder,
    addServer,
    connectPlan,
    deleteFolder,
    deleteServer,
    forgetSecrets,
    listFolders,
    listServers,
    moveFolder,
    pickKeyFile,
    renameFolder,
    setServerGroup,
    updateServer,
  } from "$lib/api";
  import type { AuthMethod, ServerProfile } from "$lib/types";
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
  import SftpPanel from "$lib/SftpPanel.svelte";
  import SettingsPanel from "$lib/SettingsPanel.svelte";
  import HelpPanel from "$lib/HelpPanel.svelte";
  import StatusBar from "$lib/StatusBar.svelte";
  import MonitoringOverlay from "$lib/MonitoringOverlay.svelte";
  import TopBar from "$lib/TopBar.svelte";
  import ServerTree from "$lib/ServerTree.svelte";
  import Modal from "$lib/Modal.svelte";
  import ConfirmDialog from "$lib/ConfirmDialog.svelte";
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
    deleteRecording,
    fetchMetrics,
  } from "$lib/api";
  import { getVersion } from "@tauri-apps/api/app";
  import RecordingSaveDialog from "$lib/RecordingSaveDialog.svelte";
  import { localizedStatus } from "$lib/stores/tabs.svelte";

  let servers = $state<ServerProfile[]>([]);
  let selectedId = $state<string | null>(null);
  let showForm = $state(false);
  let formMode = $state<"add" | "edit">("add");
  let editId = $state<string | null>(null);
  let showSettings = $state(false);
  let showHelp = $state(false);
  let helpTab = $state<"help" | "about" | "manual">("help");
  let showPalette = $state(false);
  let showMonitoring = $state(false);
  let showRecordings = $state(false);
  // After stopping a recording: prompt to name/describe or discard it.
  let saveRec = $state<{ path: string; defaultTitle: string } | null>(null);

  // Last-known terminal dimensions per session (for the recording header).
  const termDims = $state<Record<string, { cols: number; rows: number }>>({});
  // Live terminal components per session, for reading the current prompt at REC start.
  const termRefs: Record<string, { currentPromptLine?: () => string }> = {};
  // Current SSH connection phase per session, driving the connecting overlay.
  const connPhase = $state<Record<string, ConnPhase>>({});

  // ── Panel resize (widths/collapse live in the layout store) ────────────────
  let resizing = $state<null | "left" | "sftp">(null);
  let resizeStartW = 0;

  // Secret prompt state (password or key passphrase)
  let secretTarget = $state<ServerProfile | null>(null);
  let secretLabel = $state("Password");
  let secretValue = $state("");
  let rememberSecret = $state(false);
  let secretError = $state("");
  let confirmForget = $state(false);

  // Add/Edit form fields
  let alias = $state("");
  let host = $state("");
  let port = $state(22);
  let username = $state("");
  let authMethod = $state<AuthMethod>("password");
  let keyPath = $state<string | null>(null);
  let group = $state("");
  let tagsInput = $state("");
  let autoRecord = $state(false);

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
  const activeTab = $derived(findTab(tabsState.activeId));
  // Raw status drives logic (startsWith checks); localize only for the top bar.
  const status = $derived(localizedStatus(activeTab?.status ?? "Not connected"));
  const sftpReady = $derived(activeTab ? activeTab.status.startsWith("Connected") : false);

  /** Open the detailed monitoring overlay (needs a connected SSH session). */
  function openMonitoring() {
    if (activeTab?.kind === "ssh" && activeTab.status.startsWith("Connected")) {
      showMonitoring = true;
    } else {
      notifyError(t("page.monitoringNeedsSsh"));
    }
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
  async function startSessionRecording(tab: Tab) {
    const id = tab.sessionId;
    if (isRecording(id)) return;
    const dims = termDims[id] ?? { cols: 80, rows: 24 };
    // Seed the recording with the on-screen prompt so the first command has one.
    const prompt = termRefs[id]?.currentPromptLine?.() ?? "";
    const env = await recordingEnv(tab);
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

  /** Start/stop recording the active session (manual REC button / palette). */
  async function toggleRecording() {
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

  // ── Command palette (⌘K) ────────────────────────────────────────────────────
  const paletteCommands = $derived<CommandItem[]>([
    { id: "act:add", title: t("palette.addServer"), icon: "plus", group: t("palette.groupActions"),
      keywords: "add server new сервер добавить", run: () => openAdd() },
    { id: "act:newfolder", title: t("palette.newFolder"), icon: "folderPlus", group: t("palette.groupActions"),
      keywords: "folder new папка новая", run: () => openFolderForm("") },
    { id: "act:settings", title: t("palette.settings"), icon: "settings", group: t("palette.groupActions"),
      keywords: "settings preferences параметры настройки", run: () => (showSettings = true) },
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
      icon: "file", group: t("palette.groupActions"), keywords: "sftp panel toggle панель",
      run: () => (layout.sftpCollapsed = !layout.sftpCollapsed) },
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
      run: () => openAdd(f),
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
    }
  }

  onMount(() => {
    refresh();
    const unlisteners: UnlistenFn[] = [];
    listen("menu://settings", () => (showSettings = true)).then((u) => unlisteners.push(u));
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

  // ── Folder create / rename / delete ────────────────────────────────────────
  let showFolderForm = $state(false);
  let folderParent = $state("");
  let folderName = $state("");
  let folderToDelete = $state<string | null>(null);
  let folderToRename = $state<string | null>(null);
  let renameName = $state("");

  function openFolderForm(parent: string) {
    folderParent = parent;
    folderName = "";
    showFolderForm = true;
  }

  async function submitFolder(event: Event) {
    event.preventDefault();
    const name = folderName.trim();
    if (!name) return;
    const path = folderParent ? `${folderParent}/${name}` : name;
    try {
      folders = await addFolder(path);
      showFolderForm = false;
      notifySuccess(t("page.folderCreated", { name }));
    } catch (e) {
      notifyError(String(e));
    }
  }

  function openFolderRename(path: string) {
    folderToRename = path;
    renameName = nameOf(path);
  }

  async function submitFolderRename(event: Event) {
    event.preventDefault();
    const name = renameName.trim();
    if (!folderToRename || !name || name === nameOf(folderToRename)) {
      folderToRename = null;
      return;
    }
    try {
      await renameFolder(folderToRename, name);
      [servers, folders] = await Promise.all([listServers(), listFolders()]);
    } catch (e) {
      notifyError(String(e));
    }
    folderToRename = null;
  }

  async function confirmDeleteFolder() {
    if (!folderToDelete) return;
    const path = folderToDelete;
    folderToDelete = null;
    try {
      await deleteFolder(path);
      [servers, folders] = await Promise.all([listServers(), listFolders()]);
      notifySuccess(t("page.folderDeleted", { name: nameOf(path) }));
    } catch (e) {
      notifyError(String(e));
    }
  }

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
      if (plan.needsSecret) promptSecret(server, plan.secretLabel);
      else openTabStore(server.id, server.alias, null, false);
    } catch (e) {
      notifyError(String(e));
    }
  }

  async function startConnect() {
    if (selected) await connectServer(selected);
  }

  function promptSecret(server: ServerProfile, label: string, error = "") {
    secretTarget = server;
    secretLabel = label;
    secretValue = "";
    rememberSecret = false;
    secretError = error;
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
      promptSecret(server, plan.secretLabel, msg);
    }
  }

  /**
   * Presentation for the connection-error overlay (ConnectingOverlay `failed`).
   * Maps a tab's terminal status to a title, optional red detail, the phase that
   * failed (so the checklist freezes on it) and which action button to show.
   */
  function sshErrorView(
    sessionId: string,
    status: string,
  ): {
    title: string;
    detail?: string;
    phase: ConnPhase;
    showSteps: boolean;
    action: "reconnect" | "reauth";
  } {
    if (status.startsWith("Disconnected")) {
      // Dropped after a successful connect — not a phase failure.
      return { title: t("connecting.lost"), phase: "session", showSteps: false, action: "reconnect" };
    }
    const raw = status.replace(/^Error:\s*/, "");
    if (raw.includes("auth-rejected")) {
      return {
        title: t("connecting.authFailed"),
        detail: t("connecting.authFailedDetail"),
        phase: "authenticating",
        showSteps: true,
        action: "reauth",
      };
    }
    if (raw.includes("host-key-rejected")) {
      return {
        title: t("connecting.hostKeyFailed"),
        detail: t("connecting.hostKeyDetail"),
        phase: connPhase[sessionId] ?? "connecting",
        showSteps: true,
        action: "reconnect",
      };
    }
    return {
      title: t("connecting.connectFailed"),
      detail: raw,
      phase: connPhase[sessionId] ?? "connecting",
      showSteps: true,
      action: "reconnect",
    };
  }

  function submitSecret(event: Event) {
    event.preventDefault();
    if (!secretTarget) return;
    openTabStore(secretTarget.id, secretTarget.alias, secretValue, rememberSecret);
    secretTarget = null;
    secretValue = "";
    rememberSecret = false;
  }

  // Confirmation before closing a live tab (settings-gated).
  let closeConfirmId = $state<string | null>(null);
  const closeConfirmTab = $derived(findTab(closeConfirmId));

  function requestCloseTab(sessionId: string) {
    const tab = findTab(sessionId);
    if (tab && isLive(tab.status) && settings.confirmCloseTab) closeConfirmId = sessionId;
    else closeTabStore(sessionId);
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
  function openAdd(prefillGroup = "") {
    formMode = "add";
    editId = null;
    alias = host = username = "";
    port = settings.defaultPort;
    authMethod = "password";
    keyPath = null;
    group = prefillGroup;
    tagsInput = "";
    autoRecord = false;
    showForm = true;
  }

  function openEdit(server: ServerProfile) {
    selectedId = server.id;
    formMode = "edit";
    editId = server.id;
    alias = server.alias;
    host = server.host;
    port = server.port;
    username = server.username;
    authMethod = server.authMethod;
    keyPath = server.keyPath;
    group = server.group ?? "";
    tagsInput = server.tags.join(", ");
    autoRecord = server.autoRecord;
    showForm = true;
  }

  async function browseKey() {
    const picked = await pickKeyFile();
    if (picked) keyPath = picked;
  }

  async function forgetSaved() {
    if (!editId) return;
    try {
      await forgetSecrets(editId);
      servers = servers.map((s) => (s.id === editId ? { ...s, hasSavedPassword: false } : s));
      notifySuccess(t("page.savedSecretRemoved"));
    } catch (e) {
      notifyError(String(e));
    }
  }

  async function submitForm(event: Event) {
    event.preventDefault();
    if (!alias || !host || !username) return;
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const payload = {
      alias,
      host,
      port,
      username,
      authMethod,
      keyPath,
      group: group.trim() || null,
      tags,
      autoRecord,
    };
    try {
      if (formMode === "edit" && editId) {
        const updated = await updateServer(editId, payload);
        servers = servers.map((s) => (s.id === updated.id ? updated : s));
        notifySuccess(t("page.serverUpdated", { alias: updated.alias }));
      } else {
        const created = await addServer(payload);
        servers = [...servers, created];
        selectedId = created.id;
        notifySuccess(t("page.serverAdded", { alias: created.alias }));
      }
      showForm = false;
    } catch (e) {
      notifyError(String(e));
    }
  }

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

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }
</script>

<svelte:window onkeydown={onGlobalKey} />

<div class="flex h-screen w-screen flex-col">
  <TopBar {status} />

  <div class="flex min-h-0 flex-1">
    <ServerTree
      {servers}
      {folders}
      {selectedId}
      onSelect={(id) => (selectedId = id)}
      onConnect={startConnect}
      onAddServer={() => openAdd()}
      onEditServer={openEdit}
      onDeleteServer={(s) => (serverToDelete = s)}
      onNewFolder={openFolderForm}
      onRenameFolder={openFolderRename}
      onDeleteFolder={(p) => (folderToDelete = p)}
      onMoveServer={moveServerToGroup}
      onMoveFolder={moveFolderAndRefresh}
      animateWidth={resizing !== "left"}
    />
    {#if !layout.leftCollapsed}
      <!-- Drag handle to resize the server list -->
      <div
        role="separator"
        aria-orientation="vertical"
        class="w-1 shrink-0 cursor-col-resize hover:bg-accent {resizing === 'left'
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
    <main class="flex min-w-0 flex-1 flex-col bg-panel">
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
            <span class="h-2 w-2 shrink-0 rounded-full {dotClass(tab.status)}"></span>
            {#if recordingState[tab.sessionId]}
              {#if recordingPaused[tab.sessionId]}
                <Icon
                  name="pause"
                  size={12}
                  class="shrink-0 text-green-500"
                  title={t("recordings.paused")}
                />
              {:else}
                <span
                  class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger"
                  title={t("recordings.recording")}
                  aria-label={t("recordings.recording")}
                ></span>
              {/if}
            {/if}
            <span class="truncate">{tabAlias(tab)}</span>
            <button
              data-close
              class="shrink-0 rounded p-0.5 text-muted hover:bg-danger hover:text-white"
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
          title={t("tab.openLocalTerminal")}
          aria-label={t("tab.openLocalTerminal")}
          onclick={() => openLocalTab()}
        >
          <Icon name="plus" size={14} />
        </button>

        <!-- Recording controls (right-aligned). -->
        <div class="ml-auto flex shrink-0 items-center">
          {#if activeTab && isLive(activeTab.status)}
            <button
              data-testid="record-toggle"
              class="flex items-center gap-1 px-2.5 py-1.5 text-xs {activeTab &&
              isRecording(activeTab.sessionId)
                ? 'text-danger'
                : 'text-muted hover:bg-edge hover:text-white'}"
              title={activeTab && isRecording(activeTab.sessionId)
                ? t("recordings.stop")
                : t("recordings.start")}
              aria-label={activeTab && isRecording(activeTab.sessionId)
                ? t("recordings.stop")
                : t("recordings.start")}
              aria-pressed={!!(activeTab && isRecording(activeTab.sessionId))}
              onclick={toggleRecording}
            >
              <span
                class="h-2.5 w-2.5 rounded-full {activeTab && isRecording(activeTab.sessionId)
                  ? 'animate-pulse bg-danger'
                  : 'border border-current'}"
              ></span>
              REC
            </button>
          {/if}
          <button
            data-testid="open-recordings"
            class="flex items-center rounded-none px-2.5 py-1.5 text-muted hover:bg-edge hover:text-white"
            title={t("recordings.title")}
            aria-label={t("recordings.title")}
            onclick={() => (showRecordings = true)}
          >
            <Icon name="activity" size={14} />
          </button>
        </div>
      </div>

      {#if tabsState.list.length > 0}
        <div class="flex min-h-0 flex-1">
          <div class="relative min-h-0 min-w-0 flex-1">
            {#each tabsState.list as tab (tab.sessionId)}
              <div class="absolute inset-0 p-1 {tabsState.activeId === tab.sessionId ? '' : 'invisible'}">
                {#if tab.kind === "ssh" && tab.status.startsWith("Connecting")}
                  {@const srv = servers.find((s) => s.id === tab.serverId)}
                  <ConnectingOverlay
                    alias={tab.alias}
                    host={srv ? `${srv.username}@${srv.host}:${srv.port}` : tab.alias}
                    phase={connPhase[tab.sessionId] ?? "connecting"}
                  />
                {:else if tab.kind === "ssh" && (tab.status.startsWith("Error") || tab.status.startsWith("Disconnected"))}
                  {@const srv = servers.find((s) => s.id === tab.serverId)}
                  {@const ev = sshErrorView(tab.sessionId, tab.status)}
                  <ConnectingOverlay
                    failed
                    alias={tab.alias}
                    host={srv ? `${srv.username}@${srv.host}:${srv.port}` : tab.alias}
                    phase={ev.phase}
                    title={ev.title}
                    detail={ev.detail}
                    showSteps={ev.showSteps}
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
                    onphase={(p) => (connPhase[tab.sessionId] = p)}
                    onstatus={(st, d) => {
                      setTabStatus(tab.sessionId, st, d);
                      if (st === "connecting") connPhase[tab.sessionId] = "connecting";
                      if (st === "closed") finalizeRecordingOnClose(tab.sessionId);
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
            {/each}
          </div>
          {#if tabsState.activeId && activeTab?.kind === "ssh"}
            {#if !layout.sftpCollapsed}
              <div
                role="separator"
                aria-orientation="vertical"
                class="w-1 shrink-0 cursor-col-resize hover:bg-accent {resizing === 'sftp'
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
              <SftpPanel
                sessionId={tabsState.activeId}
                width={layout.sftpWidth}
                bind:collapsed={layout.sftpCollapsed}
                sessionReady={sftpReady}
                animateWidth={resizing !== "sftp"}
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
      <StatusBar sessionId={tabsState.activeId} onOpenMonitoring={openMonitoring} />
    {/key}
  {/if}
</div>

{#if tabsState.activeId}
  <MonitoringOverlay bind:open={showMonitoring} sessionId={tabsState.activeId} />
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

<SettingsPanel bind:open={showSettings} onImported={refresh} />
<HelpPanel bind:open={showHelp} bind:tab={helpTab} />

<!-- New folder -->
<Modal open={showFolderForm} title={t("page.newFolderTitle")} onclose={() => (showFolderForm = false)}>
  <form onsubmit={submitFolder}>
    {#if folderParent}
      <p class="mb-3 text-xs text-muted">
        {t("page.inside")} <span class="text-white">{folderParent}</span>
      </p>
    {/if}
    <input
      use:focusOnMount
      class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
      placeholder={t("sftp.folderNamePlaceholder")}
      bind:value={folderName}
    />
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-white"
        onclick={() => (showFolderForm = false)}>{t("common.cancel")}</button
      >
      <button
        type="submit"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
        >{t("common.create")}</button
      >
    </div>
  </form>
</Modal>

<!-- Rename folder -->
<Modal open={!!folderToRename} title={t("page.renameFolderTitle")} onclose={() => (folderToRename = null)}>
  <form onsubmit={submitFolderRename}>
    <input
      use:focusOnMount
      class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
      placeholder={t("sftp.folderNamePlaceholder")}
      bind:value={renameName}
    />
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-white"
        onclick={() => (folderToRename = null)}>{t("common.cancel")}</button
      >
      <button
        type="submit"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
        >{t("common.rename")}</button
      >
    </div>
  </form>
</Modal>

<!-- Delete folder confirmation -->
<ConfirmDialog
  open={!!folderToDelete}
  title={t("page.deleteFolderTitle")}
  confirmLabel={t("common.delete")}
  onconfirm={confirmDeleteFolder}
  oncancel={() => (folderToDelete = null)}
>
  {t("page.deleteFolderBody1")} <span class="text-white">{folderToDelete}</span> {t("page.deleteFolderBody2")}
</ConfirmDialog>

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

<!-- Tab close confirmation -->
<ConfirmDialog
  open={!!closeConfirmTab}
  title={t("page.closeTabTitle")}
  confirmLabel={t("common.close")}
  danger={false}
  onconfirm={() => {
    if (closeConfirmId) closeTabStore(closeConfirmId);
    closeConfirmId = null;
  }}
  oncancel={() => (closeConfirmId = null)}
>
  {t("page.closeTabBody1")} <span class="text-white">{closeConfirmTab ? tabAlias(closeConfirmTab) : ""}</span>
  {t("page.closeTabBody2")}
</ConfirmDialog>

<!-- Name/describe (or discard) a recording right after stopping it -->
<RecordingSaveDialog
  open={saveRec !== null}
  heading={t("recordings.saveTitle")}
  defaultTitle={saveRec?.defaultTitle ?? ""}
  onsave={saveRecording}
  ondelete={discardRecording}
  onclose={() => (saveRec = null)}
/>

<!-- Secret prompt (password or key passphrase) -->
<Modal open={!!secretTarget} title={t("page.secretTitle")} onclose={() => (secretTarget = null)}>
  {#if secretTarget}
    <form onsubmit={submitSecret}>
      <p class="mb-3 text-xs text-muted">
        {secretTarget.username}@{secretTarget.host}:{secretTarget.port}
      </p>
      {#if secretError}
        <p class="mb-3 rounded border border-danger px-2 py-1 text-xs text-danger">{secretError}</p>
      {/if}
      <label class="block text-xs text-muted">
        {secretLabel === "Passphrase" ? t("page.secretPassphrase") : t("page.secretPassword")}
        <input
          type="password"
          data-testid="secret-input"
          use:focusOnMount
          class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          bind:value={secretValue}
        />
      </label>
      <label class="mt-3 flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" bind:checked={rememberSecret} />
        {t("page.rememberKeychain")}
      </label>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="rounded px-3 py-1 text-sm text-muted hover:text-white"
          onclick={() => (secretTarget = null)}>{t("common.cancel")}</button
        >
        <button
          type="submit"
          data-testid="secret-connect"
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
          >{t("common.connect")}</button
        >
      </div>
    </form>
  {/if}
</Modal>

<!-- Add / Edit server modal -->
<Modal
  open={showForm}
  title={formMode === "edit" ? t("page.editServerTitle") : t("page.newServerTitle")}
  onclose={() => (showForm = false)}
>
  <form onsubmit={submitForm}>
    <label class="mb-2 block text-xs text-muted">
      {t("page.alias")}
      <input
        data-testid="field-alias"
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
        bind:value={alias}
        placeholder={t("page.aliasPlaceholder")}
      />
    </label>
    <label class="mb-2 block text-xs text-muted">
      {t("page.hostIp")}
      <input
        data-testid="field-host"
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
        bind:value={host}
        placeholder="192.168.1.10"
      />
    </label>
    <div class="mb-2 flex gap-2">
      <label class="block w-20 text-xs text-muted">
        {t("page.port")}
        <input
          type="number"
          class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          bind:value={port}
        />
      </label>
      <label class="block flex-1 text-xs text-muted">
        {t("page.username")}
        <input
          data-testid="field-username"
          class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          bind:value={username}
          placeholder="root"
        />
      </label>
    </div>

    <div class="mb-2 text-xs text-muted">
      {t("page.authentication")}
      <div class="mt-1 flex gap-3 text-sm text-white">
        <label class="flex items-center gap-1">
          <input type="radio" value="password" bind:group={authMethod} />
          {t("page.authPassword")}
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="key" bind:group={authMethod} />
          {t("page.authKey")}
        </label>
      </div>
    </div>

    {#if authMethod === "key"}
      <label class="mb-2 block text-xs text-muted">
        {t("page.privateKeyFile")}
        <div class="mt-1 flex gap-2">
          <input
            readonly
            class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none"
            value={keyPath ?? ""}
            placeholder="~/.ssh/id_ed25519"
          />
          <button
            type="button"
            class="shrink-0 rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
            onclick={browseKey}>{t("common.browse")}</button
          >
        </div>
      </label>
    {/if}

    <label class="mb-2 block text-xs text-muted">
      {t("page.tags")}
      <input
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
        bind:value={tagsInput}
        placeholder="web, eu"
      />
    </label>

    <label class="mb-2 flex items-center gap-2 text-xs text-text">
      <input type="checkbox" bind:checked={autoRecord} />
      {t("page.autoRecord")}
    </label>
    <p class="mb-2 text-[11px] text-muted">{t("page.autoRecordHint")}</p>

    <div class="mt-3 flex items-center gap-2">
      {#if formMode === "edit"}
        <button
          type="button"
          class="rounded px-2 py-1 text-xs text-danger hover:underline"
          onclick={() => (confirmForget = true)}
          title={t("page.forgetSavedSecretTitle")}
        >
          {t("page.forgetSavedSecret")}
        </button>
      {/if}
      <div class="ml-auto flex gap-2">
        <button
          type="button"
          class="rounded px-3 py-1 text-sm text-muted hover:text-white"
          onclick={() => (showForm = false)}>{t("common.cancel")}</button
        >
        <button
          type="submit"
          data-testid="save-server"
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
          >{formMode === "edit" ? t("common.update") : t("common.save")}</button
        >
      </div>
    </div>
  </form>
</Modal>

<!-- Forget-secret confirmation -->
<ConfirmDialog
  open={confirmForget}
  title={t("page.forgetSecretTitle")}
  confirmLabel={t("common.forget")}
  onconfirm={async () => {
    await forgetSaved();
    confirmForget = false;
  }}
  oncancel={() => (confirmForget = false)}
>
  {t("page.forgetSecretBody")}
</ConfirmDialog>

<!-- Command palette (⌘K) -->
<CommandPalette bind:open={showPalette} commands={paletteCommands} />

<!-- Session recordings library (Phase 11) -->
<RecordingsPanel bind:open={showRecordings} />

<!-- Global non-blocking notifications -->
<Toast />
