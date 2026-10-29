<script lang="ts">
  import { onMount, untrack, tick } from "svelte";
  import { tooltip } from "#lib/actions/tooltip.ts";
  import { fade } from "svelte/transition";
  import { motion } from "#lib/ui/motion.ts";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import {
    connectPlan,
    deleteServer,
    deleteFolderWithServers,
    forgetSecrets,
    listFolders,
    listServers,
    moveFolder,
    setServerGroup,
    setServerNotes,
    localCwd,
    takePendingOpens,
    pickOpenFile,
    writeToTerminal,
    serverToolsStatus,
    takeStoreWarnings,
    OPEN_FILE_EVENT,
    disconnect,
    listenHere,
    transferList,
    TARGETS_EVENT,
    closeWindow,
    reportWindowSummary,
    otherWindowsSummary,
    broadcastSettings,
    announceServersDeleted,
    CATALOG_EVENT,
    DRAG_EVENT,
    HANDOFF_EVENT,
    SERVERS_DELETED_EVENT,
    SETTINGS_EVENT,
    WINDOW_CLOSE_EVENT,
    WINDOWS_EVENT,
    type ServersDeleted,
    type SettingsBroadcast,
  } from "#lib/api/index.ts";
  import {
    isMainWindow,
    windowLabel,
  } from "#lib/windows/appwindow.ts";
  import {
    WINDOW_ROWS,
    ghostPlace,
    paneDetachOffered,
    paneMoveOffered,
    type TermSnapshot,
  } from "#lib/windows/tabhandoff.ts";
  import { waitView } from "#lib/tabs/tabrestore.ts";
  import { forgetSavedTabs } from "#lib/stores/tabrestore.svelte.ts";
  import { createRestoreFlow } from "#lib/page/restoreflow.svelte.ts";
  import type { ServerProfile } from "#lib/types.ts";
  import { storeWarningMessage } from "#lib/servers/storewarn.ts";
  import { sessionBarParts, showSessionBar } from "#lib/terminal/sessionbar.ts";
  import ViewModeToggle from "#lib/ui/ViewModeToggle.svelte";
  import { moveConfirmKeys, nameOf, serversInSubtree, type MoveRequest } from "#lib/servers/tree.ts";
  import {
    isPanelHidden,
    layout,
    movePanel,
    resetPanelLayout,
    revealPanel,
    setDockCollapsed,
    setPanelHidden,
    toggleDock,
  } from "#lib/stores/layout.svelte.ts";
  import { dockOf, isPanelShown, PANEL_IDS, type PanelId } from "#lib/layout/docklayout.ts";
  import { glide } from "#lib/actions/drag.ts";
  import { moveLabel, moveTargets, panelLabel } from "#lib/layout/dockui.ts";
  import {
    activateTab,
    clearAdopt,
    closeTab as closeTabStore,
    tabsForServer,
    dotClass,
    findTab,
    focusPane,
    isLive,
    isMonitorable,
    joinPanes,
    monitoredSessionId,
    moveTabTo,
    newTabAction,
    nextTabIndex,
    openTab as openTabStore,
    openLocalTab,
    reconnectTab as reconnectTabStore,
    setSplitRatio,
    setTabStatus,
    splitTabOff,
    tabsState,
    tilePanes,
    untilePanes,
    type NewTabAction,
    type Tab,
  } from "#lib/stores/tabs.svelte.ts";
  import {
    canSplit,
    gridFit,
    layoutRects,
    neighbourPane,
    orderedTabs,
    paneOf,
    panes,
    previewIncoming,
    previewTabs,
    shownTabs,
    type Edge,
    type Pane,
  } from "#lib/layout/splitlayout.ts";
  import {
    onScreenSessions,
    pendingAuthSession,
    confinedGhost,
    rectStyle,
    stripStyle,
  } from "#lib/layout/centerview.ts";
  import {
    beginTabDrag,
    consumeTabDragClick,
    tabDrag,
  } from "#lib/stores/tabdrag.svelte.ts";
  import {
    INCOMING_TAB,
    applyDragMessage,
    incoming,
    incomingAsTab,
    parseDragMessage,
  } from "#lib/stores/tabincoming.svelte.ts";
  import SplitDivider from "#lib/layout/SplitDivider.svelte";
  import { handleClipboardShortcut } from "#lib/actions/clipboardKeys.ts";
  import TerminalView from "#lib/terminal/Terminal.svelte";
  import ConnectingOverlay from "#lib/connect/ConnectingOverlay.svelte";
  import type { ConnPhase } from "#lib/connect/connphase.ts";
  import { sshErrorView } from "#lib/connect/ssherror.ts";
  import { showNoSignal } from "#lib/connect/connlost.ts";
  import Dock from "#lib/layout/Dock.svelte";
  import DockPanel from "#lib/layout/DockPanel.svelte";
  import DockDragGhost from "#lib/layout/DockDragGhost.svelte";
  import EditorTab from "#lib/editor/EditorTab.svelte";
  import DiffModal from "#lib/editor/DiffModal.svelte";
  import ToolInstallDialog from "#lib/editor/ToolInstallDialog.svelte";
  import type { ToolStatus } from "#lib/editor/servertools.ts";
  import { editorLangOrPlain } from "#lib/editor/editorlang.ts";
  import {
    getWorkspace,
    workspacesState,
    addScratchEditor,
    setEditorSaveIssue,
    isDirty,
    removeWorkspace,
    hasUnsaved,
    focusSessionZone,
    joinSessionZones,
    moveSessionViewNext,
    setSessionZoneRatio,
    showSessionView,
    splitSessionView,
  } from "#lib/stores/workspaces.svelte.ts";
  import { TERMINAL_VIEW, focusedFile, terminalFocused, terminalShown } from "#lib/layout/sessionviews.ts";
  import { beginViewDrag, consumeViewDragClick, viewDrag } from "#lib/stores/viewdrag.svelte.ts";
  import { removeChat, getChat, askAbout } from "#lib/stores/aichat.svelte.ts";
  import { removeDockState, setDockCwd } from "#lib/stores/dockstate.svelte.ts";
  import { baseName } from "#lib/files/fspath.ts";
  import { fileLinksAllowed } from "#lib/terminal/termfiles.ts";
  import { followUpdates, pollsLocalCwd } from "#lib/pathsync/followcwd.ts";
  import { aiReady } from "#lib/ai/ai.ts";
  import SettingsPanel from "#lib/settings/SettingsPanel.svelte";
  import UtilitiesPanel from "#lib/utilities/UtilitiesPanel.svelte";
  import ServerFormModal from "#lib/servers/ServerFormModal.svelte";
  import NotesModal from "#lib/servers/NotesModal.svelte";
  import { hasNotes, notesTarget } from "#lib/servers/notes.ts";
  import FolderModals from "#lib/servers/FolderModals.svelte";
  import SecretPrompt from "#lib/connect/SecretPrompt.svelte";
  import AuthPromptDialog from "#lib/connect/AuthPromptDialog.svelte";
  import { authPrompts, clearAuthPrompt, setAuthPrompt } from "#lib/stores/authprompt.svelte.ts";
  import HelpPanel from "#lib/app/HelpPanel.svelte";
  import ThemeOverlay from "#lib/appearance/ThemeOverlay.svelte";
  import IdleOverlay from "#lib/screensaver/IdleOverlay.svelte";
  import StatusBar from "#lib/monitoring/StatusBar.svelte";
  import MonitoringOverlay from "#lib/monitoring/MonitoringOverlay.svelte";
  import TopBar from "#lib/topbar/TopBar.svelte";
  import { allTopbarIds, canUnpin, type SessionAction } from "#lib/topbar/topbaractions.ts";
  import type { SessionActionState } from "#lib/utilities/sessionactions.ts";
  import { actionLabel } from "#lib/topbar/topbarui.ts";
  import { isPinned, pinAction, resetTopbar, unpinAction } from "#lib/stores/topbarpins.svelte.ts";
  import TitleBar from "#lib/windows/TitleBar.svelte";
  import { hostEnv } from "#lib/stores/hostenv.svelte.ts";
  import ServerTree from "#lib/servers/ServerTree.svelte";
  import Modal from "#lib/ui/Modal.svelte";
  import PasswordInput from "#lib/ui/PasswordInput.svelte";
  import ConfirmDialog from "#lib/ui/ConfirmDialog.svelte";
  import UnsavedCloseDialog from "#lib/editor/UnsavedCloseDialog.svelte";
  import { activeTabStrip } from "#lib/tabs/tabstrip.ts";
  import { installUpdate, updateWindowReady, updateStartup } from "#lib/api/updater.ts";
  import { updateError } from "#lib/app/updates.ts";
  import QuitDialog from "#lib/windows/QuitDialog.svelte";
  import { mergeQuitRows, quitRows, type QuitRow } from "#lib/windows/quitsummary.ts";
  import ContextMenu from "#lib/ui/ContextMenu.svelte";
  import type { MenuAction, MenuItem, OpenMenu } from "#lib/ui/ctxmenu.ts";
  import PathSyncDialog from "#lib/pathsync/PathSyncDialog.svelte";
  import { createPathSyncFlow } from "#lib/page/pathsyncflow.svelte.ts";
  import { cdCommand, type CdShell } from "#lib/pathsync/cdterminal.ts";
  import { renderArgv, renderSessionCommand } from "#lib/terminal/termcmd.ts";
  import { attachIcon, attachRows, attachTitle, type AttachTarget } from "#lib/tabs/tabattach.ts";
  import { submitLine } from "#lib/terminal/terminput.ts";
  import {
    isNewTabChord,
    isPaletteChord,
    isSplitDownChord,
    isSplitRightChord,
    paneStepChord,
  } from "#lib/app/appshortcuts.ts";
  import Icon from "#lib/ui/Icon.svelte";
  import Toast from "#lib/ui/Toast.svelte";
  import EmptyState from "#lib/ui/EmptyState.svelte";
  import CommandPalette from "#lib/app/CommandPalette.svelte";
  import RecordingsPanel from "#lib/recording/RecordingsPanel.svelte";
  import { createRecordingFlow, recordingTitle } from "#lib/page/recordingflow.svelte.ts";
  import { createCopyFlow } from "#lib/page/copyflow.svelte.ts";
  import type { CommandItem } from "#lib/app/command.ts";
  import { notifyError, notifySuccess, notifyInfo } from "#lib/stores/toasts.svelte.ts";
  import {
    applyJob,
    applyProgress,
    dropTransfersOf,
    removeTransfer,
    transfersState,
  } from "#lib/stores/transfers.svelte.ts";
  import { jobNotice, jobVisibleInWindow } from "#lib/files/transfer.ts";
  import {
    fileSelectionOf,
    setFileSelection,
  } from "#lib/stores/filecopy.svelte.ts";
  import { fileDrag } from "#lib/stores/filedrag.svelte.ts";
  import { parseFileDragMessage } from "#lib/files/filedrop.ts";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import FileDragGhost from "#lib/files/FileDragGhost.svelte";
  import {
    foreignTargets,
    targetsFrom,
  } from "#lib/files/copyto.ts";
  import CopyToDialog from "#lib/files/CopyToDialog.svelte";
  import ReplaceDialog from "#lib/files/ReplaceDialog.svelte";
  import LinkOpenDialog from "#lib/terminal/LinkOpenDialog.svelte";
  import FileLinkDialog from "#lib/terminal/FileLinkDialog.svelte";
  import { createFileLinkFlow } from "#lib/page/filelinkflow.svelte.ts";
  import { createEditorFlow } from "#lib/page/editorflow.svelte.ts";
  import { createFileDragFlow } from "#lib/page/filedragflow.svelte.ts";
  import { createWindowFlow } from "#lib/page/windowflow.svelte.ts";
  import { applySyncProgress } from "#lib/stores/syncrun.svelte.ts";
  import { applyScanProgress, isBusy, peekSyncJob, removeSyncJob } from "#lib/stores/syncjob.svelte.ts";
  import {
    recordingState,
    recordingPaused,
    isRecording,
    clearRecording,
  } from "#lib/stores/recordings.svelte.ts";
  import type { SftpProgress, TransferJob } from "#lib/api/index.ts";
  import { applyImportedSettings, settings } from "#lib/settings/settings.svelte.ts";
  import { t } from "#lib/i18n/index.ts";
  import {
    setMenuLanguage,
    armCloseGuard,
    quitApp,
    annotateRecording,
    fetchMetrics,
    readRecording,
  } from "#lib/api/index.ts";
  import { extractTranscript } from "#lib/recording/recording.ts";
  import { DEFAULT_TAIL_LINES, type RawContext } from "#lib/ai/aicontext.ts";
  import type { PromptVars } from "#lib/ai/aicore.ts";
  import { isProdServer } from "#lib/ai/aiexec.ts";
  import type { ProbeSession } from "#lib/utilities/probe.ts";
  import RecordingSaveDialog from "#lib/recording/RecordingSaveDialog.svelte";
  import { dockConnection, localizedStatus } from "#lib/stores/tabs.svelte.ts";
  import type { HostServer, HostTab } from "#lib/netcheck/netroute.ts";
  import BroadcastBar from "#lib/terminal/BroadcastBar.svelte";
  import BroadcastRoster from "#lib/terminal/BroadcastRoster.svelte";
  import {
    broadcastState,
    isBroadcastMember,
    toggleBroadcastMember,
    setBroadcastMembers,
    clearBroadcastMembers,
    removeBroadcastMember,
  } from "#lib/stores/broadcast.svelte.ts";
  import {
    eligibleMembers,
    frameCommand,
    groupHasProd,
    gridColumns,
    prodMembers,
  } from "#lib/terminal/broadcast.ts";

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
  // Utilities panel (Phase 33) — tool overlay above the working screen.
  let showUtilities = $state(false);
  let utilitiesInitial = $state<string | null>(null);
  /** Open the Utilities panel, optionally focused on a specific tool. */
  function openUtilities(utility: string | null = null) {
    utilitiesInitial = utility;
    showUtilities = true;
  }
  let showHelp = $state(false);
  // Quit confirmation (window close / ⌘Q / File → Exit, via `menu://quit`). In a
  // window a tab was moved out to (ADR 0017) the same dialog asks about closing
  // that window, via `window://close`.
  let showQuit = $state(false);
  let quitForUpdate = $state(false);
  let updateVersion = $state("");
  let updateFreeze = $state(false);
  const dirtyEditors = () => Object.values(workspacesState.map).reduce((n, ws) => n + ws.editors.filter(isDirty).length, 0);
  async function askToUpdate(version: string) {
    updateVersion = version;
    quitForUpdate = true;
    otherWindowRows = await otherWindowsSummary().catch(() => []);
    showQuit = true;
  }
  async function confirmUpdate() {
    showQuit = false;
    try { await installUpdate(updateVersion); }
    catch (e) { notifyError(t(updateError(e))); }
    finally { quitForUpdate = false; }
  }
  // What the other windows would lose — asked for when the main window's dialog
  // opens, so that quitting lists the whole app.
  let otherWindowRows = $state<unknown>([]);
  /** What closing this window would cut off right now — read when the dialog opens. */
  function quitRowsNow() {
    return quitRows({
      tabs: tabsState.list,
      transfers: Object.values(transfersState.map),
      syncBusy: tabsState.list.filter((tab) => isBusy(peekSyncJob(tab.sessionId))).length,
      recordings: Object.values(recordingState).filter(Boolean).length,
      dirtyEditors: dirtyEditors(),
    });
  }
  let helpTab = $state<"help" | "about" | "manual" | "changelog" | "updates">("help");
  // Custom window chrome replaces the OS title bar + menu on Windows/Linux; macOS
  // keeps its native decorations, so the TitleBar is never mounted there. Empty
  // `os` (pre-resolve) also renders nothing, so macOS never flashes a custom bar.
  const showWindowChrome = $derived(hostEnv.os !== "" && hostEnv.os !== "macos");
  let showPalette = $state(false);
  let showMonitoring = $state(false);
  let showRecordings = $state(false);
  // The server whose notes window is open (snapshot at open time), or null.
  let notesServer = $state<ServerProfile | null>(null);

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
      find?: () => void;
      focus?: () => void;
      pasteText?: (text: string) => void;
      setViewMode?: (structured: boolean) => void;
      clear?: () => void;
      snapshot?: (sent: number) => Promise<TermSnapshot | null>;
    }
  > = {};
  // Raw (false) ↔ structured table (true) per session, reported by the terminal —
  // drives the session bar's switch. Cleared in closeTabFully.
  const termStructured = $state<Record<string, boolean>>({});
  // Whether the terminal has a selection — enables the session bar's "Ask AI".
  // Cleared in closeTabFully.
  const termSelection = $state<Record<string, number>>({}); // selected lines, 0 = none
  /** How often to ask the OS for a local shell's cwd while following (Phase 39.3).
   *  One second is well under human reaction time for a `cd`, and the underlying
   *  read is a single cheap syscall on Linux/macOS. */
  const LOCAL_CWD_POLL_MS = 1000;
  /** How long a command typed into a freshly connected shell waits, so the login
   *  prompt is up first (a pending command, the path-sync snippet on connect). */
  const LOGIN_PROMPT_DELAY_MS = 500;

  // Current SSH connection phase per session, driving the connecting overlay.
  const connPhase = $state<Record<string, ConnPhase>>({});
  // Latest terminal cwd (OSC 7) per session. Whether the dock follows it is the
  // path-sync flow's, per tab too (page/pathsyncflow).
  const terminalCwd = $state<Record<string, string>>({});
  // Command (argv) to type into a freshly-opened terminal tab once it connects
  // (Docker/k8s "open shell": `docker exec -it …` on a sibling tab of the same
  // host). Kept as argv and rendered on flush, for the shell the tab really runs.
  const pendingCommand: Record<string, string[]> = {};
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
  // Height of the terminal tab bar. The left dock's tab strip stands right next to
  // it and takes the same height, so their bottom borders form one line — the bar
  // is taller once a tab (with its close button) is in it.
  let tabBarHeight = $state(0);
  // What the single strip measures. Kept apart from `tabBarHeight` so that the
  // height survives the strip going away: split, the panes' own strips take it.
  let flatBarHeight = $state(0);
  $effect(() => {
    if (flatBarHeight > 0) tabBarHeight = flatBarHeight;
  });
  // Which `cd` dialect each local tab's shell speaks, reported by Terminal at spawn
  // (Phase 39.4). Keyed per session because a tab keeps the shell it opened with
  // even if the preference changes afterwards.
  const localShellKind = $state<Record<string, CdShell>>({});

  // Password / passphrase prompt (owns its own state); opened via its export.
  let secretPrompt: SecretPrompt | undefined = $state();

  // Folders
  let folders = $state<string[]>([]);

  // The terminal tab being dragged (stores/tabdrag.svelte.ts) — for its floating label.
  const draggingTab = $derived(findTab(tabDrag.tab));

  const selected = $derived(servers.find((s) => s.id === selectedId) ?? null);
  // Drop a stale folder highlight after the folder is renamed/deleted.
  $effect(() => {
    if (selectedFolder !== null && !folders.includes(selectedFolder)) selectedFolder = null;
  });
  // The tab in focus: the one shown by the focused pane (v1.2). Everything that
  // follows a single session — docks, status bar, top bar, assistant — reads this.
  const activeTab = $derived(findTab(tabsState.activeId));

  // ── The centre: panes side by side (v1.2) ──────────────────────────────────
  // The tree of panes lives in the tabs store; here it becomes rectangles. The
  // terminals stay in ONE flat keyed list (`tabsState.list`) and are positioned
  // by the rectangle of the pane that holds them, so moving a tab to another pane
  // never remounts its `Terminal` (which would disconnect the session).
  const center = $derived(tabsState.center);
  const paneList = $derived(panes(center));
  const isSplit = $derived(paneList.length > 1);
  /** The tab each pane shows — the terminals on screen outside broadcast mode. */
  const shownIds = $derived(new Set(shownTabs(center)));
  const tabPane = $derived.by(() => {
    const map: Record<string, string> = {};
    for (const pane of paneList) for (const id of pane.tabs) map[id] = pane.id;
    return map;
  });
  const tabById = $derived(new Map(tabsState.list.map((tab) => [tab.sessionId, tab])));
  // A tab held over this window from another one (ADR 0018), as a strip draws
  // it: a place kept for it among this window's tabs. It is in no list of tabs —
  // only in what `tabsOf` hands a strip that previews it.
  const incomingTab = $derived(incomingAsTab());
  const tabsOf = (ids: readonly string[]): Tab[] =>
    ids.flatMap((id) => (id === INCOMING_TAB ? (incomingTab ?? []) : (tabById.get(id) ?? [])));
  // Every session in strip order, pane by pane — "tab order" for whatever lists
  // sessions in a row (the broadcast grid).
  const orderedTabList = $derived(tabsOf(orderedTabs(center)));

  // serverId → statuses of its open SSH tabs, for the connection dots in the tree.
  const serverConnections = $derived.by(() => {
    const map: Record<string, string[]> = {};
    for (const tab of tabsState.list) {
      if (tab.kind !== "ssh") continue;
      (map[tab.serverId] ??= []).push(tab.status);
    }
    return map;
  });
  const dockConn = $derived(activeTab ? dockConnection(activeTab.status) : "offline");
  // The session the docks' session panels work on — the tab in focus. Null with
  // no tab open: the docks then offer only the server tree.
  const dockSessionId = $derived(activeTab ? activeTab.sessionId : null);
  const panelShown = (panel: PanelId): boolean =>
    isPanelShown(layout.docks, panel, dockSessionId !== null, settings.hiddenPanels);
  /** Palette toggle: bring a panel on screen, or collapse the dock showing it. */
  function togglePanel(panel: PanelId) {
    if (panelShown(panel)) setDockCollapsed(dockOf(layout.docks, panel), true);
    else revealPanel(panel);
  }
  // Top-bar breadcrumb of the active connection. Alias comes from the tab (SSH
  // alias or "Local shell"); the `user@host:port` line needs the SSH profile.
  const activeServer = $derived(
    activeTab?.kind === "ssh" ? (servers.find((s) => s.id === activeTab.serverId) ?? null) : null,
  );
  // Active-tab context for the Utilities network tools (Phase 34): SSH tabs run
  // the probe on the server, local tabs on this computer (ADR 0014) or typed
  // into the tab's terminal — in the dialect of the shell it spawned.
  const utilSession = $derived.by<ProbeSession | null>(() => {
    const tab = activeTab;
    if (!tab || (tab.kind !== "ssh" && tab.kind !== "local")) return null;
    const srv = tab.kind === "ssh" ? servers.find((s) => s.id === tab.serverId) : null;
    return {
      id: tab.sessionId,
      kind: tab.kind,
      live: isLive(tab.status),
      host: tab.kind === "ssh" ? (srv?.host ?? tab.alias) : "local",
      isProd: tab.kind === "ssh" ? isProdServer(srv) : false,
      shell: tab.kind === "local" ? (localShellKind[tab.sessionId] ?? "posix") : "posix",
    };
  });
  // The access check picks its servers from the catalog and the open tabs
  // (v1.21, netroute.ts): where a rule's source lives, and whether a session to
  // it is open.
  const netServers = $derived<HostServer[]>(
    servers.map((s) => ({ id: s.id, alias: s.alias, host: s.host, isProd: isProdServer(s) })),
  );
  const netTabs = $derived<HostTab[]>(
    tabsState.list.map((tab) => ({
      sessionId: tab.sessionId,
      kind: tab.kind,
      serverId: tab.serverId,
      live: isLive(tab.status),
      connecting: !tab.waiting && dockConnection(tab.status) === "connecting",
    })),
  );

  /** "Connect" in the access check: the server's tab, opened the usual way. */
  function connectServerById(serverId: string) {
    const server = servers.find((s) => s.id === serverId);
    if (server) void connectServer(server);
  }

  // Notes belong to the active SSH tab's server when one is focused; on a local
  // tab (or with no tab) they fall back to the tree-selected server.
  const notesServerTarget = $derived(notesTarget(activeServer, selected));

  // ── Broadcast: synchronous multi-server input (Phase 22) ───────────────────
  // Broadcast mode is bound to the active tab: we're "in broadcast" whenever the
  // active tab belongs to the group, so switching tabs enters/leaves the mode.
  const bcOn = $derived(
    !!tabsState.activeId && isBroadcastMember(tabsState.activeId),
  );
  // Measured width of the centre area (its panes are laid out in it).
  let bcAreaWidth = $state(0);
  // Open tabs in the group, in tab order (may include connecting/errored ones).
  const bcMemberTabs = $derived(
    orderedTabList.filter((tab) => isBroadcastMember(tab.sessionId)),
  );
  // Live members that would actually receive a sent command.
  const bcTargets = $derived(eligibleMembers(broadcastState.members, orderedTabList));
  const bcHasProd = $derived(groupHasProd(bcTargets, tabsState.list, servers));
  // Every open SSH tab whose server is production — its tab gets a red top strip
  // + `prod` chip and its terminal a red frame (grid tiles: a red border), so
  // "am I typing into prod" is answered wherever the eye is.
  const prodTabIds = $derived(
    new Set(prodMembers(tabsState.list.map((tab) => tab.sessionId), tabsState.list, servers)),
  );
  // Roster rows: the full group, the member in focus marked `active`. It is
  // shown while some member is not on screen — those receive what is sent too.
  const bcRosterRows = $derived(
    bcMemberTabs.map((tab) => {
      const srv = servers.find((s) => s.id === tab.serverId);
      return {
        sessionId: tab.sessionId,
        alias: tabTitle(tab),
        host: srv ? `${srv.username}@${srv.host}:${srv.port}` : t("tab.localShell"),
        status: localizedStatus(tab.status),
        dot: dotClass(tab.status),
        isProd: !!srv && isProdServer(srv),
        active: tab.sessionId === tabsState.activeId,
      };
    }),
  );

  // Height of the centre area (its width is `bcAreaWidth`, measured for the grid too).
  let areaHeight = $state(0);
  const areaBounds = $derived({ width: bcAreaWidth, height: areaHeight });
  const placement = $derived(layoutRects(center.root, areaBounds));
  // Each pane carries its own tab strip only while there is more than one pane.
  // Unsplit there is a single strip above the area, exactly as before splits
  // existed.
  const paneStrips = $derived(isSplit);
  const stripInset = $derived(paneStrips ? tabBarHeight : 0);
  // Every visible pane keeps its shown tab inside the horizontally scrollable
  // part of the strip. Programmatic activation (palette, restore, split focus)
  // has no focused DOM node for the browser to reveal by itself.
  $effect(() => {
    const visible = paneList.map((pane) => pane.active).filter((id): id is string => !!id);
    queueMicrotask(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>("[data-tab]")];
      for (const id of visible) {
        nodes.find((node) => node.dataset.tab === id)?.scrollIntoView?.({
          block: "nearest",
          inline: "nearest",
        });
      }
    });
  });
  // The sessions whose terminals are on screen: the tab each pane shows, when
  // that connection shows its terminal (one showing only a file has no terminal
  // on screen — v1.11). A recording runs only while its terminal is on screen,
  // and a server's login question waits until it is.
  const onScreenIds = $derived(
    new Set(onScreenSessions([...shownIds], (id) => terminalShown(getWorkspace(id).layout))),
  );
  // Members of the synchronous-input group that no pane shows: they get what
  // is sent all the same, so the roster names them (v1.9).
  const bcOffScreen = $derived(bcMemberTabs.filter((tab) => !onScreenIds.has(tab.sessionId)));
  // The sessions the panes show: their dock panels stay mounted.
  const dockSessions = $derived([...shownIds]);
  // Whose panel the docks show — said only while there are panes to tell apart.
  const dockCaption = $derived(paneStrips && activeTab ? tabTitle(activeTab) : null);
  const authSession = $derived(
    pendingAuthSession([...onScreenIds], tabsState.activeId, (id) => !!authPrompts[id]),
  );

  /** Give a pane the focus and put the keyboard in the terminal it shows. */
  /** Height of the strip of views a zone of a connection carries, px. */
  const VIEW_STRIP = 28;

  // ── A connection's own zones (v1.11, ADR 0024) ────────────────────────────
  // A connection's area — its pane, less the pane's strip — is divided between
  // its terminal and the files open through it (`sessionviews.ts`, the layout is
  // the workspace store's). The same tree and the same rectangles as the
  // centre's panes, one level down.
  /** The room a connection has for its zones, px. */
  const sessionBounds = (sessionId: string): { width: number; height: number } => {
    const rect = placement.panes[tabPane[sessionId]];
    return { width: rect?.w ?? 0, height: Math.max(0, (rect?.h ?? 0) - stripInset) };
  };
  /** Whether a zone of a connection has room to be split at `edge`. */
  const canSplitZone = (sessionId: string, zone: string, edge: Edge): boolean =>
    canSplit(
      layoutRects(getWorkspace(sessionId).layout.root, sessionBounds(sessionId)).panes[zone],
      edge,
    );

  /** Show a view of a connection; the terminal also takes the keyboard. */
  function showView(sessionId: string, view: string) {
    showSessionView(sessionId, view);
    if (view === TERMINAL_VIEW) termRefs[sessionId]?.focus?.();
  }

  // ── View drag: reorder, move to another zone, split (stores/viewdrag.svelte.ts) ──
  function viewPointerDown(event: PointerEvent, sessionId: string, view: string) {
    if ((event.target as HTMLElement).closest("[data-close]")) return;
    beginViewDrag(event, sessionId, view);
  }

  /** A click on a view shows it — unless the click is the end of a drag. */
  function viewClick(sessionId: string, view: string) {
    if (!consumeViewDragClick()) showView(sessionId, view);
  }

  function focusPaneAndTerminal(pane: Pane) {
    focusPane(pane.id);
    if (pane.active) termRefs[pane.active]?.focus?.();
  }

  /** Whether the focused pane can be split at `edge`: it holds a tab and has the room. */
  const canSplitFocused = (edge: Edge): boolean =>
    activeTab !== null && canSplit(placement.panes[center.focus], edge);

  /**
   * A new terminal in a new pane at `edge` of the focused one: the tab ⌘T would
   * open, split off the moment it exists — so there is never an empty pane on
   * screen, and a cancelled password prompt changes nothing.
   */
  function splitWithNewTerminal(edge: Edge) {
    if (!canSplitFocused(edge)) {
      if (activeTab) notifyInfo(t("split.noRoom"));
      return;
    }
    const anchor = center.focus;
    openNewTab(newTabAction(activeTab), (sid) => splitTabOff(sid, anchor, edge));
  }

  // ── A grid of panes with one command (v1.9, ADR 0022) ──────────────────────
  // The synchronous-input group has no view of its own: its members stand in the
  // panes of the centre. "Show them all" is the layout's command — each asked-for
  // tab gets a pane, as many as keep the pane minimum; the rest stay tabs of the
  // first pane and are said so.

  /** Lay the sessions `ids` out as a grid of panes (two or more of them). */
  function tileSessions(ids: string[]) {
    if (ids.length < 2) return;
    const fit = gridFit(areaBounds, gridColumns(areaBounds.width || 1200, ids.length));
    let shown = ids.slice(0, fit.panes);
    if (ids.length > fit.panes) {
      // Not all fit. The session in focus is not the one to leave out.
      const focus = tabsState.activeId;
      if (focus && ids.includes(focus) && !shown.includes(focus)) {
        shown = [...shown.slice(0, -1), focus];
      }
      notifyInfo(t("split.gridPartial", { shown: fit.panes, total: ids.length }));
    }
    // In tab order, whoever was picked.
    tilePanes(ids.filter((id) => shown.includes(id)), fit.cols);
  }

  /** Add/remove the active tab to/from the group (entering/leaving broadcast). */
  function toggleActiveBroadcast() {
    const id = tabsState.activeId;
    if (id) toggleBroadcastMember(id);
    void recFlow.syncBatchRecording();
  }

  /** Add every live SSH/local session to the group (keeps existing members). */
  function addAllConnected() {
    setBroadcastMembers([
      ...broadcastState.members,
      ...tabsState.list
        .filter((tab) => (tab.kind === "ssh" || tab.kind === "local") && isLive(tab.status))
        .map((tab) => tab.sessionId),
    ]);
    void recFlow.syncBatchRecording();
  }

  // ── Recording (the flow lives in page/recordingflow.svelte.ts) ─────────────
  const recFlow = createRecordingFlow({
    servers: () => servers,
    findTab,
    activeTab: () => activeTab,
    broadcasting: () => bcOn,
    members: () => broadcastState.members,
    orderedTabs: () => orderedTabList,
    onScreen: () => onScreenIds,
    termSize: (id) => termDims[id],
    promptLine: (id) => termRefs[id]?.currentPromptLine?.() ?? "",
  });

  // A command awaiting confirmation because the group includes a prod server.
  let pendingBroadcast = $state<{ frame: string; targets: string[]; cmd: string } | null>(null);
  const pendingProdAliases = $derived(
    pendingBroadcast
      ? prodMembers(pendingBroadcast.targets, tabsState.list, servers).map((id) => {
          const tab = findTab(id);
          return tab ? tabTitle(tab) : id;
        })
      : [],
  );

  /** Send the composed command to every live member (prod → confirm first). */
  function requestBroadcast(cmd: string) {
    const frame = frameCommand(cmd);
    if (!frame) return;
    const targets = eligibleMembers(broadcastState.members, orderedTabList);
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
      // Input reached this session: its recording is not idle.
      recFlow.activity(id);
    }
  }
  const topTitle = $derived(activeTab?.alias ?? t("status.notConnected"));
  const topSubtitle = $derived(
    activeServer ? `${activeServer.username}@${activeServer.host}:${activeServer.port}` : "",
  );
  // Monitoring (status bar + overlay) works on SSH *and* local tabs (Phase 38): a
  // live local PTY reports metrics natively via sysinfo. Gates the monitoring
  // button, the status bar and the idle card (`monitoredSessionId`).
  const monitorConnected = $derived(isMonitorable(activeTab));
  /** Open the detailed monitoring overlay (needs a connected SSH or local session). */
  function openMonitoring() {
    if (monitorConnected) {
      showMonitoring = true;
    } else {
      notifyError(t("page.monitoringNeedsSession"));
    }
  }

  // The session actions of the top bar (v1.16): what decides whether each can
  // run now, and the one way to run it — read by the bar and by the Utilities
  // window, where a button taken off the bar is still found.
  const sessionActions = $derived<SessionActionState>({
    connected: monitorConnected,
    canRecord: bcOn ? bcTargets.length > 0 : !!(activeTab && isLive(activeTab.status)),
    recording: bcOn ? !!recFlow.batch : !!(activeTab && isRecording(activeTab.sessionId)),
    canBroadcast: !!tabsState.activeId,
    broadcastActive: bcOn,
    notesFor: notesServerTarget?.alias ?? null,
  });
  // A record, not a chain of `if`s: an action added to the bar without a way to
  // run it does not compile.
  const SESSION_RUN: Record<SessionAction, () => void> = {
    monitoring: () => openMonitoring(),
    record: () => void recFlow.toggle(bcTargets.length),
    recordings: () => (showRecordings = true),
    broadcast: () => toggleActiveBroadcast(),
    notes: () => (notesServer = notesServerTarget),
  };
  const runSessionAction = (id: SessionAction): void => SESSION_RUN[id]();

  /**
   * Collect the live session context the AI tab offers (Phase 17.3). Reads the
   * terminal selection + buffer always; the recording transcript and host
   * metadata only when their (opt-in) tiers are enabled — so the expensive
   * recording read / metrics probe runs only when actually attached. All of it
   * is redacted + shown in the consent dialog (in AiChat) before it is sent.
   */
  async function gatherAiContext(id: string): Promise<RawContext> {
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

  /**
   * Values for the `{os}`/`{host}`/… placeholders a user may put in their AI
   * prompt (Phase 41). Only what is already in memory — this is read on every
   * send, so it must not probe the host. An unknown value stays empty and the
   * placeholder expands to nothing.
   */
  function aiPromptVarsFor(tab: Tab): PromptVars {
    const srv = tab.kind === "ssh" ? servers.find((s) => s.id === tab.serverId) : undefined;
    return {
      host: srv?.host ?? "",
      alias: srv?.alias ?? (tab.kind === "local" ? t("tab.localShell") : ""),
      cwd: terminalCwd[tab.sessionId] || "",
      shell: tab.kind === "local" ? (settings.localShellPath ?? "") : "",
      // `os` is deliberately absent: it costs a metrics probe, and the consent-gated
      // metadata tier is the honest place for host details.
    };
  }

  /** Whether the assistant is usable at all — gates every "ask AI" entry point. */
  // Every "ask the assistant about this" entry point hangs on this one flag. A
  // hidden AI panel switches them off as well: a button that opened the panel the
  // user had put away would undo that choice from across the window.
  const aiOn = $derived(aiReady(settings.ai) && !isPanelHidden("ai"));

  /**
   * Attach a terminal selection to the assistant's composer (Phase 41). The user
   * asks about it (or sends the preset question), and the send runs the normal
   * consent dialog, so the text is redacted and previewed before anything leaves
   * the machine — the entry point buys convenience, not access.
   */
  function explainWithAi(sessionId: string, selection: string) {
    const text = selection.trim();
    if (!text) return;
    askAbout(sessionId, { source: "selection", context: text });
    revealPanel("ai");
  }

  /**
   * Ask the assistant about a container or pod (Phase 41). The panel has already
   * fetched its state and logs, so the question carries them; consent still runs
   * in the chat, exactly as for a hand-attached context.
   */
  function askAiAboutResource(id: string, context: string, kind: "container" | "pod") {
    askAbout(id, { source: kind, context });
    revealPanel("ai");
  }

  /** Ask the assistant to read the host's metrics snapshot (Phase 41). */
  function askAiAboutMetrics(snapshot: string) {
    const id = tabsState.activeId;
    if (!id) return;
    askAbout(id, { source: "metrics", context: snapshot });
    revealPanel("ai");
  }

  /** Host/session metadata block for the AI metadata tier (best-effort). */
  async function aiMetadataBlock(id: string): Promise<string> {
    const tab = findTab(id);
    const lines: string[] = [];
    const srv = tab ? servers.find((s) => s.id === tab.serverId) : undefined;
    if (srv) {
      lines.push(`Host: ${srv.host}:${srv.port}`, `User: ${srv.username}`, `Alias: ${srv.alias}`);
    } else if (tab) {
      lines.push(`Session: ${recordingTitle(tab, servers)}`);
    }
    try {
      const m = await fetchMetrics(id);
      lines.push(`OS: ${m.prettyName || m.os}`, `Hostname: ${m.hostname}`, `Kernel: ${m.kernel}`);
    } catch {
      /* metrics probe failed — keep profile-derived fields */
    }
    return lines.join("\n");
  }

  // ── Command palette (⌘K) ────────────────────────────────────────────────────
  const PANE_KEYWORDS =
    "split pane terminal side by side layout сплит разделить область рядом терминал раскладка";
  const paneCommands = $derived.by((): CommandItem[] => {
    const group = t("palette.groupActions");
    const out: CommandItem[] = [];
    const add = (id: string, title: string, icon: CommandItem["icon"], run: () => void) =>
      out.push({ id, title, icon, group, keywords: PANE_KEYWORDS, run });
    const tab = activeTab;
    // The tab the commands move: the one in focus.
    const tabId = tabsState.activeId;
    const pane = tabId ? paneOf(center, tabId) : null;
    if (canSplitFocused("right")) {
      add("pane:new-right", t("palette.splitRight"), "splitRight", () => splitWithNewTerminal("right"));
    }
    if (canSplitFocused("bottom")) {
      add("pane:new-down", t("palette.splitDown"), "splitDown", () => splitWithNewTerminal("bottom"));
    }
    if (tabId && pane && pane.tabs.length > 1) {
      if (canSplitFocused("right")) {
        add("pane:tab-right", t("palette.moveTabRight"), "splitRight", () =>
          splitTabOff(tabId, pane.id, "right"),
        );
      }
      if (canSplitFocused("bottom")) {
        add("pane:tab-down", t("palette.moveTabDown"), "splitDown", () =>
          splitTabOff(tabId, pane.id, "bottom"),
        );
      }
    }
    if (isSplit) {
      if (tabId && pane) {
        add("pane:tab-next", t("palette.moveTabNextPane"), "arrowRight", () =>
          moveTabTo(tabId, neighbourPane(center, pane.id, 1).id),
        );
      }
      add("pane:focus-next", t("palette.focusNextPane"), "arrowRight", () =>
        focusPaneAndTerminal(neighbourPane(center, center.focus, 1)),
      );
      add("pane:focus-prev", t("palette.focusPrevPane"), "arrowLeft", () =>
        focusPaneAndTerminal(neighbourPane(center, center.focus, -1)),
      );
      add("pane:join", t("palette.joinPanes"), "layoutFocus", joinPanes);
    }
    // Every terminal in a pane of its own — or back to the layout before that.
    if (tabsState.list.length > 1) {
      add("pane:tile", t("palette.tilePanes"), "layoutGrid", () =>
        tileSessions(orderedTabList.map((item) => item.sessionId)),
      );
    }
    if (tabsState.tiled) {
      add("pane:untile", t("palette.untilePanes"), "layoutFocus", untilePanes);
    }
    // The connection's own zones (v1.11): the file in focus beside the
    // terminal or beside another file, and back to one zone.
    if (tab) {
      const sid = tab.sessionId;
      const views = getWorkspace(sid).layout;
      const zones = panes(views).length;
      const file = focusedFile(views);
      const zone = file ? paneOf(views, file) : null;
      if (file && zone && zone.tabs.length > 1) {
        if (canSplitZone(sid, zone.id, "right")) {
          add("view:right", t("palette.viewRight"), "splitRight", () =>
            splitSessionView(sid, file, "right"),
          );
        }
        if (canSplitZone(sid, zone.id, "bottom")) {
          add("view:down", t("palette.viewDown"), "splitDown", () =>
            splitSessionView(sid, file, "bottom"),
          );
        }
      }
      if (file && zones > 1) {
        add("view:next", t("palette.viewNextZone"), "arrowRight", () =>
          moveSessionViewNext(sid, file),
        );
      }
      if (zones > 1) {
        add("view:join", t("palette.joinZones"), "layoutFocus", () => joinSessionZones(sid));
      }
    }
    if (tab && tabId === tab.sessionId && tab.status.startsWith("Connected")) {
      // Another window that is already open — the main one first: the way back.
      for (const w of windows.targets) {
        out.push({
          id: `window:move:${w.label}`,
          title: t("palette.moveTabTo", { target: windows.targetName(w) }),
          icon: "popOut",
          group,
          keywords: "window move return back main окно перенести вернуть обратно главное другое",
          run: () => void windows.detachTab(tab.sessionId, { window: w.label }),
        });
      }
      if (windows.canOfferDetach) {
        out.push({
          id: "window:detach",
          title: t("palette.moveTabToWindow"),
          icon: "popOut",
          group,
          keywords: "window detach pop out tear off monitor окно отдельное вынести второй монитор",
          run: () => void windows.detachTab(tab.sessionId),
        });
      }
    }
    // The pane in focus as a whole (v1.10) — when it is more than one tab.
    const paneTabs = windows.paneSessions(center.focus).length;
    if (paneMoveOffered(paneTabs)) {
      const focus = center.focus;
      for (const w of windows.targets) {
        out.push({
          id: `window:pane:move:${w.label}`,
          title: t("palette.movePaneTo", { target: windows.targetName(w) }),
          icon: "popOut",
          group,
          keywords: "window pane all tabs group move окно область все вкладки группа перенести",
          run: () => void windows.movePane(focus, { window: w.label }),
        });
      }
      if (paneDetachOffered({ mainWindow: isMainWindow, tabs: tabsState.list.length }, paneTabs)) {
        out.push({
          id: "window:pane:detach",
          title: t("palette.movePaneToWindow"),
          icon: "popOut",
          group,
          keywords: "window pane all tabs group detach monitor окно область все вкладки группа отдельное",
          run: () => void windows.movePane(focus),
        });
      }
    }
    return out;
  });

  const copyCommands = $derived.by<CommandItem[]>(() => {
    const from = tabsState.activeId;
    const picked = from ? fileSelectionOf(from) : null;
    if (!from || !picked) return [];
    const what =
      picked.entries.length === 1
        ? picked.entries[0].name
        : t("sftp.dragCount", { count: picked.entries.length });
    return targetsFrom(copyFlow.all, from).map((target) => ({
      id: `copyto:${target.sessionId}`,
      title: t("palette.copyTo", { what, target: target.title }),
      icon: "arrowRight",
      group: t("palette.groupActions"),
      keywords: "copy file transfer server session копировать файл перенести сервер сессия",
      run: () =>
        void copyFlow.open({
          from,
          local: picked.local,
          to: target.sessionId,
          entries: picked.entries,
        }),
    }));
  });

  // ── Dragging files (v1.13–v1.14; the flow lives in page/filedragflow.svelte.ts) ──
  let fileGhost = $state<ReturnType<typeof FileDragGhost>>();

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
    { id: "act:utilities", title: t("palette.utilities"), icon: "wrench", group: t("palette.groupActions"),
      keywords: "utilities tools keygen cidr subnet base64 jwt cron password timestamp known hosts tls http утилиты инструменты", run: () => openUtilities() },
    { id: "act:monitoring", title: t("palette.monitoring"), icon: "barChart", group: t("palette.groupActions"),
      keywords: "monitoring metrics метрики мониторинг cpu ram disk графики", run: openMonitoring },
    { id: "act:record",
      title: activeTab && isRecording(activeTab.sessionId) ? t("palette.stopRecording") : t("palette.startRecording"),
      icon: "activity", group: t("palette.groupActions"),
      keywords: "record recording session запись сессия rec asciicast", run: () => void recFlow.toggle(bcTargets.length) },
    { id: "act:recordings", title: t("palette.recordings"), icon: "activity", group: t("palette.groupActions"),
      keywords: "recordings library записи библиотека asciicast", run: () => (showRecordings = true) },
    // Broadcast and the notes had no way in but their top-bar buttons; a button
    // can be taken off the bar now (v1.16), so each has a command of its own.
    ...(sessionActions.canBroadcast
      ? [{ id: "act:broadcast",
          title: sessionActions.broadcastActive ? t("broadcast.removeFromGroup") : t("broadcast.addToGroup"),
          icon: "broadcast", group: t("palette.groupActions"),
          keywords: "broadcast synchronized sync input group servers синхронный ввод группа рассылка серверы",
          run: () => runSessionAction("broadcast") } satisfies CommandItem]
      : []),
    ...(sessionActions.notesFor !== null
      ? [{ id: "act:notes", title: t("sessionact.notes.title"), subtitle: sessionActions.notesFor,
          icon: "note", group: t("palette.groupActions"),
          keywords: "notes server markdown memo заметки сервер записка",
          run: () => runSessionAction("notes") } satisfies CommandItem]
      : []),
    // Copy what is selected in the focused session's file panel to another
    // session — the row menu's "Copy to session", without the mouse (v1.12).
    ...copyCommands,
    { id: "act:help", title: t("palette.help"), icon: "info", group: t("palette.groupActions"),
      keywords: "help помощь справка", run: () => { helpTab = "help"; showHelp = true; } },
    { id: "act:manual", title: t("palette.manual"), icon: "info", group: t("palette.groupActions"),
      keywords: "manual readme инструкция документация docs", run: () => { helpTab = "manual"; showHelp = true; } },
    { id: "act:about", title: t("palette.about"), icon: "info", group: t("palette.groupActions"),
      keywords: "about version версия о программе", run: () => { helpTab = "about"; showHelp = true; } },
    { id: "act:toggle-left",
      title: panelShown("servers") ? t("palette.hideServerList") : t("palette.showServerList"),
      icon: "server", group: t("palette.groupActions"), keywords: "panel sidebar toggle панель серверы",
      run: () => togglePanel("servers") },
    // A hidden panel is not offered here; it comes back through "Show panel: …"
    // below (and Settings → Appearance → Panels).
    ...(isPanelHidden("files") ? [] : [{ id: "act:toggle-sftp",
      title: panelShown("files") ? t("palette.hideSftp") : t("palette.showSftp"),
      icon: "file", group: t("palette.groupActions"), keywords: "sftp files panel toggle панель файлы",
      run: () => togglePanel("files") } satisfies CommandItem]),
    ...(isPanelHidden("ai") ? [] : [{ id: "act:toggle-ai",
      title: t("palette.showAi"),
      icon: "aiMark", group: t("palette.groupActions"), keywords: "ai chat assistant llm панель ии ассистент чат",
      run: () => revealPanel("ai") } satisfies CommandItem]),
    { id: "act:toggle-bottom",
      title: layout.docks.bottom.collapsed ? t("palette.showBottomPanel") : t("palette.hideBottomPanel"),
      icon: "layoutGrid", group: t("palette.groupActions"),
      keywords: "bottom panel dock toggle docker k8s нижняя панель док",
      run: () => toggleDock("bottom") },
    { id: "act:reset-layout", title: t("palette.resetLayout"), icon: "layoutGrid",
      group: t("palette.groupActions"),
      keywords: "reset layout panels docks columns default сбросить раскладка панели доки колонки",
      run: resetPanelLayout },
    // The top bar's buttons without the mouse — the twin of its right-click
    // menu: put on what is not there, take off what is (Settings stays).
    ...allTopbarIds().filter((id) => !isPinned(id)).map((id): CommandItem => ({
      id: `topbar:pin:${id}`,
      title: t("topbar.pinCommand", { action: actionLabel(id) }),
      icon: "pin",
      group: t("palette.groupActions"),
      keywords: "top bar toolbar button pin add quick верхняя панель кнопка закрепить добавить быстрый доступ",
      run: () => pinAction(id),
    })),
    ...settings.topbar.filter(canUnpin).map((id): CommandItem => ({
      id: `topbar:unpin:${id}`,
      title: t("topbar.unpinCommand", { action: actionLabel(id) }),
      icon: "close",
      group: t("palette.groupActions"),
      keywords: "top bar toolbar button unpin remove hide верхняя панель кнопка убрать открепить скрыть",
      run: () => unpinAction(id),
    })),
    { id: "topbar:reset", title: t("topbar.reset"), icon: "refresh", group: t("palette.groupActions"),
      keywords: "top bar toolbar buttons reset default верхняя панель кнопки сбросить исходный набор",
      run: resetTopbar },
    // The way back for a panel hidden from its tab's menu or in settings.
    ...PANEL_IDS.filter(isPanelHidden).map((id): CommandItem => ({
      id: `dock:show:${id}`,
      title: t("palette.showPanel", { panel: panelLabel(id) }),
      icon: "eye",
      group: t("palette.groupActions"),
      keywords: "panel dock show hidden unhide панель док показать скрытая вернуть",
      run: () => {
        setPanelHidden(id, false);
        revealPanel(id);
      },
    })),
    // Moving a tool panel to another dock without the mouse — the twin of
    // dragging its tab (and of the tab's right-click menu).
    ...PANEL_IDS.filter((id) => !isPanelHidden(id)).flatMap((id) =>
      moveTargets(dockOf(layout.docks, id)).map((to): CommandItem => ({
        id: `dock:${id}:${to}`,
        title: `${panelLabel(id)}: ${moveLabel(to)}`,
        icon: "layoutGrid",
        group: t("palette.groupActions"),
        keywords: "panel dock move layout left right bottom панель док переместить раскладка",
        run: () => movePanel(id, to),
      })),
    ),
    { id: "act:new-local", title: t("palette.newLocalTerminal"), icon: "terminal",
      group: t("palette.groupActions"), keywords: "local terminal shell new локальный терминал новый",
      run: () => openLocalTab() },
    // Tabs that came back from the previous launch and still wait (ADR 0019).
    ...(tabsState.list.some((tab) => tab.waiting && tab.waiting !== "checking")
      ? [{ id: "act:connect-restored", title: t("palette.connectRestored"), icon: "plug",
          group: t("palette.groupActions"),
          keywords: "restore restored tabs connect all previous session восстановить вкладки подключить все прошлый запуск",
          run: () => restoreFlow.wakeAll() } satisfies CommandItem]
      : []),
    // Panes of the centre — the twins of dragging a tab to a pane's edge and of
    // the tab's right-click menu. Offered only while they would do something.
    ...paneCommands,
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
  // ignored so a non-Tauri context (e.g. plain `pnpm dev`) doesn't throw. Only
  // macOS has a native menu now — Windows/Linux draw the HTML menu in TitleBar —
  // so skip the IPC there (reading `hostEnv.os` also makes this reactive to it).
  $effect(() => {
    if (hostEnv.os !== "macos") return;
    setMenuLanguage({
      fileMenu: t("menu.fileMenu"),
      helpMenu: t("menu.helpMenu"),
      settings: t("menu.settings"),
      about: t("menu.about"),
      help: t("menu.help"),
      manual: t("menu.manual"),
      changelog: t("menu.changelog"),
      updates: t("menu.updates"),
      monitoring: t("menu.monitoring"),
      quit: t("menu.quit"),
    }).catch(() => {});
  });

  function onGlobalKey(e: KeyboardEvent) {
    // ⌘K (macOS) / Ctrl+Shift+K (Windows/Linux). Plain Ctrl+K belongs to the shell
    // (readline kill-line), so the terminal only releases the Shift form — see
    // appshortcuts.ts for why the two must agree.
    if (isPaletteChord(e)) {
      e.preventDefault();
      showPalette = !showPalette;
      return;
    }
    // ⌘T (macOS) / Ctrl+Shift+T (Windows/Linux) — new tab of the active server, or a
    // local shell when the active tab isn't SSH (including when nothing is open).
    // Plain Ctrl+T stays with the shell (transpose-chars / fzf).
    if (isNewTabChord(e)) {
      e.preventDefault();
      openNewTab(newTabAction(activeTab));
      return;
    }
    onPaneKey(e);
  }

  /**
   * Open what ⌘T opens: another tab of the same server, or a local shell.
   * `place` is told the new tab's session id as soon as the tab exists (for an
   * SSH server that asks for a password — once the user has given it).
   */
  function openNewTab(action: NewTabAction, place?: (sessionId: string) => void) {
    if (action.kind === "ssh") {
      const server = servers.find((s) => s.id === action.serverId);
      if (server) {
        void connectServer(server, place);
        return;
      }
    }
    // Not `place?.(openLocalTab())`: with no `place` the argument is never
    // evaluated, and the tab would not open at all.
    const sessionId = openLocalTab();
    place?.(sessionId);
  }

  /**
   * Pane chords (appshortcuts.ts): ⌘D / ⌘⇧D open a new terminal to the right /
   * below, ⌘] / ⌘[ move the focus between panes (Ctrl+Shift+D / E / ] / [ on
   * Windows and Linux). They belong to the terminal area: a chord the focused
   * control already handled (the editor binds ⌘D and ⌘]) or one typed into a
   * text field is left alone.
   */
  function onPaneKey(e: KeyboardEvent) {
    const right = isSplitRightChord(e);
    const down = !right && isSplitDownChord(e);
    const step = right || down ? null : paneStepChord(e);
    if (!right && !down && step === null) return;
    if (e.defaultPrevented) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    const field =
      !!el &&
      !el.closest(".xterm") &&
      (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
    if (field) return;
    if (step !== null) {
      if (!isSplit) return;
      e.preventDefault();
      focusPaneAndTerminal(neighbourPane(center, center.focus, step));
      return;
    }
    e.preventDefault();
    splitWithNewTerminal(right ? "right" : "bottom");
  }

  onMount(() => {
    // The tabs of the previous launch come back once the catalog is known
    // (ADR 0019) — in the main window; another window starts with the tab it
    // was opened for.
    void refresh().then(() => {
      if (isMainWindow) restoreFlow.restore();
    });
    // Resolve the host OS once so the custom window chrome (TitleBar) and the
    // macOS-only native-menu sync below become reactively available.
    void hostEnv.resolve();
    const unlisteners: UnlistenFn[] = [];
    // Everything a window is told individually is heard through `listenHere`:
    // the plain `listen` also hears what the backend sent to ANOTHER window.
    // Native-menu commands go to the window in focus.
    listenHere("menu://settings", () => openSettings()).then((u) => unlisteners.push(u));
    listenHere("menu://about", () => {
      helpTab = "about";
      showHelp = true;
    }).then((u) => unlisteners.push(u));
    listenHere("menu://help", () => {
      helpTab = "help";
      showHelp = true;
    }).then((u) => unlisteners.push(u));
    listenHere("menu://manual", () => {
      helpTab = "manual";
      showHelp = true;
    }).then((u) => unlisteners.push(u));
    for (const section of ["changelog", "updates"] as const) {
      listenHere(`menu://${section}`, () => { helpTab = section; showHelp = true; })
        .then((u) => unlisteners.push(u));
    }
    listenHere<string>("update://prepare", (e) => {
      updateFreeze = true;
      void tick().then(() => updateWindowReady(e.payload, dirtyEditors() > 0 || notesServer !== null || showSettings || !!recFlow.saveRec));
    }).then((u) => unlisteners.push(u));
    listenHere("update://resume", () => { updateFreeze = false; }).then((u) => unlisteners.push(u));
    if (isMainWindow) void updateStartup().then((status) => {
      if (status === "updated") notifySuccess(t("updates.updated"));
      else if (status) notifyError(t(updateError(status)));
    }).catch(() => {});
    listenHere("menu://monitoring", () => openMonitoring()).then((u) => unlisteners.push(u));
    // Close confirmation: the main window is asked about quitting, any other one
    // about closing itself. The guard is armed only once the listener is in
    // place — an armed guard nobody answers would make the window impossible to
    // close.
    listenHere(CLOSE_ASKED_EVENT, () => void askToClose())
      .then((u) => {
        unlisteners.push(u);
        return armCloseGuard();
      })
      .catch(() => {});
    // This window's SFTP progress feed → shared store (read by SFTP panel + status
    // bar), plus the sync-run store (the dialog's per-row bars; ignores non-sync ids).
    listenHere<SftpProgress>("sftp://progress", (e) => {
      applyProgress(e.payload);
      applySyncProgress(e.payload);
    }).then((u) => unlisteners.push(u));
    // Transfers are jobs of the backend (v1.12, ADR 0025): it tells the window
    // that shows the tab of a session a job touches. Listened to first, then
    // asked what is already under way — a window opened to take a tab over
    // finds the job that came with it.
    listenHere<TransferJob>("sftp://job", (e) => hearJob(e.payload))
      .then((u) => {
        unlisteners.push(u);
        return refreshTransfers();
      })
      .catch(() => {});
    // Sync compare counters (files hashed per side) → the session's sync job.
    listenHere<{ id: string; files: number }>("sync://scan", (e) =>
      applyScanProgress(e.payload),
    ).then((u) => unlisteners.push(u));
    // What windows tell each other (ADR 0017). The catalog and the settings are
    // the app's, not a window's: each window keeps a copy and re-reads it when
    // another one changes it.
    listen(CATALOG_EVENT, () => void refresh()).then((u) => unlisteners.push(u));
    listen<SettingsBroadcast>(SETTINGS_EVENT, (e) => applySettingsFrom(e.payload)).then((u) =>
      unlisteners.push(u),
    );
    listen<ServersDeleted>(SERVERS_DELETED_EVENT, (e) => {
      if (e.payload.from === windowLabel) return;
      for (const id of e.payload.ids) for (const sid of tabsForServer(id)) closeTabFully(sid);
    }).then((u) => unlisteners.push(u));
    // Tabs move between open windows (ADR 0018). This window hears which others
    // take tabs, and the offer of one — and says that it takes tabs itself only
    // once both listeners are in place: a window announced earlier would be
    // offered a tab it cannot hear of.
    Promise.all([
      listen<unknown>(WINDOWS_EVENT, (e) => windows.heardWindows(e.payload)),
      // What every window offers as a place to copy files to; this window's
      // own list is left out of it.
      listen<unknown>(TARGETS_EVENT, (e) => {
        copyFlow.heardOthers(foreignTargets(e.payload, windowLabel));
      }),
      // A tab of another window held over this one: it is drawn here.
      listenHere<unknown>(DRAG_EVENT, (e) => {
        const msg = parseDragMessage(e.payload);
        if (msg) applyDragMessage(msg);
        // The same relay carries files held over this window from another one.
        const files = parseFileDragMessage(e.payload);
        if (files) fileDrags.heardOtherWindow(files);
      }),
      listenHere(HANDOFF_EVENT, () => void windows.receiveTab()),
    ])
      .then((us) => {
        unlisteners.push(...us);
        windows.listening();
      })
      .catch(() => {});
    if (isMainWindow) {
      // A config file that failed to parse was quarantined during the backend's
      // startup load. Reported without a TTL: "your server list is gone and here
      // is where it went" must not scroll away after six seconds.
      void takeStoreWarnings().then((warnings) => {
        for (const w of warnings) {
          const m = storeWarningMessage(w);
          notifyError(t(m.key, m.params), 0);
        }
      });
      // "Open with vterm": files asked for at launch (drained now) and while
      // running. The main window's alone — a second one would open them twice.
      takePendingOpens()
        .then((paths) => paths.forEach(handleOpenFile))
        .catch(() => {});
      listenHere<string>(OPEN_FILE_EVENT, (e) => handleOpenFile(e.payload)).then((u) =>
        unlisteners.push(u),
      );
    } else {
      // This window was opened for a tab: take it over.
      void windows.adoptHandoff();
    }
    // Files the system drags over the window from the desktop (v1.13). One
    // listener for the window: where they are dropped is read from where the
    // pointer is, not from which panel happens to be mounted.
    try {
      getCurrentWebview()
        .onDragDropEvent((ev) => fileDrags.heardDesktop(ev.payload))
        .then((u) => unlisteners.push(u))
        .catch(() => {});
    } catch {
      /* no webview (browser preview) — nothing is dragged in */
    }
    // Global Cmd/Ctrl + V/C/X/A for every text input (capture phase, so it works
    // even inside modals and before any field-local handler). See clipboardKeys.ts.
    document.addEventListener("keydown", handleClipboardShortcut, true);
    return () => {
      unlisteners.forEach((u) => u());
      document.removeEventListener("keydown", handleClipboardShortcut, true);
    };
  });

  // ── Windows (ADR 0017) ─────────────────────────────────────────────────────
  // The question this window is asked before it goes: the main one about
  // quitting the app, any other one about closing itself.
  const CLOSE_ASKED_EVENT = isMainWindow ? "menu://quit" : WINDOW_CLOSE_EVENT;

  /** Open the close confirmation with what would be cut off. */
  async function askToClose() {
    quitForUpdate = false;
    // Quitting lists every window's sessions, not just this one's.
    otherWindowRows = isMainWindow ? await otherWindowsSummary().catch(() => []) : [];
    showQuit = true;
  }

  /** The rows of the close confirmation: this window's, plus — when quitting — the others'. */
  function closeRowsNow(): QuitRow[] {
    return mergeQuitRows(quitRowsNow(), otherWindowRows);
  }

  // A secondary window tells the backend what it would lose, as it changes, so
  // the main window's quit confirmation can list it.
  $effect(() => {
    if (isMainWindow) return;
    void reportWindowSummary(quitRowsNow()).catch(() => {});
  });

  // A secondary window exists for its tabs: once it has taken its first one, it
  // goes with its last. (The main window stays — it is where servers are opened.)
  let windowHasHadTab = $state(false);
  $effect(() => {
    if (!isMainWindow && windowHasHadTab && tabsState.list.length === 0) {
      void closeWindow().catch(() => {});
    }
  });

  // Settings are the app's: a change here goes to the other windows, a change
  // there is applied here. `syncedSettings` is the snapshot both sides agree on —
  // applying a received one must not send it back.
  let syncedSettings = JSON.stringify(settings);
  let settingsBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const json = JSON.stringify(settings);
    if (json === syncedSettings) return;
    // Debounced: a pinch-zoom of the font writes a setting on every wheel tick.
    clearTimeout(settingsBroadcastTimer);
    settingsBroadcastTimer = setTimeout(() => {
      if (json === syncedSettings) return;
      syncedSettings = json;
      void broadcastSettings({ from: windowLabel, json }).catch(() => {});
    }, 150);
  });

  /** Another window changed the settings: take its snapshot. */
  function applySettingsFrom(msg: SettingsBroadcast) {
    if (msg.from === windowLabel) return;
    let raw: unknown;
    try {
      raw = JSON.parse(msg.json);
    } catch {
      return;
    }
    // The same sanitizing merge a backup import goes through; then note what we
    // hold now (it may differ from what was sent only by that sanitizing).
    applyImportedSettings(raw);
    syncedSettings = JSON.stringify(settings);
  }

  // The window's size — where the label of a tab dragged out of it is pinned.
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);

  // ── Tabs and panes between windows (ADR 0017, 0018, 0023) ─────────────────
  // The trip a tab takes, a pane moving whole, a tab dropped outside, a tab
  // arriving: page/windowflow.svelte.ts. What stays here is what this window
  // draws of it.
  const windows = createWindowFlow({
    title: tabTitle,
    alias: tabAlias,
    editorBusy: (sid) => getWorkspace(sid).editors.some((ed) => ed.loading || ed.id === editors.savingId),
    snapshot: async (sid, sent) => (await termRefs[sid]?.snapshot?.(sent)) ?? null,
    carried: (sid) => ({
      terminalCwd: terminalCwd[sid] ?? null,
      followTerminal: pathSync.following[sid] ?? false,
      followSeen: followSeen[sid] ?? null,
      localShell: localShellKind[sid] ?? null,
      shellIntegrated: pathSync.integrated(sid),
    }),
    arrived: (sid, page) => {
      if (page.terminalCwd) terminalCwd[sid] = page.terminalCwd;
      pathSync.adopt(sid, { following: page.followTerminal, integrated: page.shellIntegrated });
      if (page.followSeen) followSeen[sid] = page.followSeen;
      if (page.localShell) localShellKind[sid] = page.localShell;
      // It arrives connected — a later drop of it is a real one (NO SIGNAL).
      idleWasConnected.add(sid);
    },
    teardown: closeTabFully,
    refreshTransfers: () => void refreshTransfers(),
    ghostProbe: () => ghostProbe,
    areaBounds: () => areaBounds,
  });
  // Where the tab over the desktop is drawn by a window of its own (mirror of
  // `dragghost::SUPPORTED`). There the label never stops at this window's edge,
  // so it has nothing to say about what letting go will do.
  const floatsOutside = $derived(hostEnv.os === "macos" || hostEnv.os === "windows");
  /** The tab in the air is over another window of the app, which draws it. */
  const heldOverWindow = $derived(windows.targets.some((w) => w.label === tabDrag.window));
  // The edge of a pane a drop would make a new pane at: of a tab of this
  // window, or of one held over it from another.
  const dropZone = $derived(tabDrag.zone ?? incoming.zone ?? viewDrag.zone ?? fileDrag.zone);

  // An unseen copy of the label a dragged tab gets — measured, and its colours
  // read, for the floating label that shows the tab over the desktop (a window
  // of its own: this page cannot draw there).
  let ghostProbe = $state<HTMLElement>();
  // The label of a view dragged inside its connection, as drawn: it stops
  // flush with the edge of the connection's area only when its size is known.
  let viewGhost = $state({ w: 0, h: 0 });

  async function refresh() {
    [servers, folders] = await Promise.all([listServers(), listFolders()]);
    if (!selectedId && servers.length > 0) selectedId = servers[0].id;
  }

  // Persist the notes window's edits and reflect them in the local server list
  // (so the top-bar "has notes" dot updates). Throws so NotesModal shows an error.
  async function saveNotes(id: string, notes: string) {
    const updated = await setServerNotes(id, notes);
    servers = servers.map((s) => (s.id === updated.id ? updated : s));
  }

  // ── Folder drag (move a server into a group / a folder under a new parent) ──
  // A drop only *requests* the move; it runs after the confirmation dialog — a
  // slipped drag would otherwise silently re-file a server into the wrong folder.
  let pendingMove = $state<MoveRequest | null>(null);
  const pendingMoveKeys = $derived(pendingMove ? moveConfirmKeys(pendingMove) : null);
  function requestMoveServer(id: string, groupPath: string | null) {
    const server = servers.find((s) => s.id === id);
    if (server) pendingMove = { kind: "server", id, label: server.alias, target: groupPath };
  }
  function requestMoveFolder(path: string, parent: string | null) {
    pendingMove = { kind: "folder", id: path, label: path, target: parent };
  }
  async function confirmMove() {
    const req = pendingMove;
    pendingMove = null;
    if (!req) return;
    if (req.kind === "server") await moveServerToGroup(req.id, req.target);
    else await moveFolderAndRefresh(req.id, req.target);
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
  // ── Transfers: jobs of the backend (v1.12, ADR 0025) ─────────────────────────
  /** What the backend says of a job: the list, and a word when it ends badly. */
  function hearJob(job: TransferJob) {
    if (!jobVisibleInWindow(job, new Set(tabsState.list.map((tab) => tab.sessionId)))) {
      removeTransfer(job.id);
      return;
    }
    applyJob(job);
    const notice = jobNotice(job);
    if (!notice) return;
    const text = t(notice.key, notice.vars);
    if (notice.kind === "error") notifyError(text);
    else notifyInfo(text);
  }

  /** The jobs of this window's sessions that are under way right now. */
  async function refreshTransfers() {
    try {
      for (const job of await transferList()) {
        if (jobVisibleInWindow(job, new Set(tabsState.list.map((tab) => tab.sessionId)))) {
          applyJob(job);
        } else {
          removeTransfer(job.id);
        }
      }
    } catch {
      /* no backend (browser preview) — nothing to show */
    }
  }

  // ── Copy to another session (page/copyflow.svelte.ts) ─────────────────────
  const pathSync = createPathSyncFlow({
    findTab,
    servers: () => servers,
    serverSaved: (updated) => (servers = servers.map((s) => (s.id === updated.id ? updated : s))),
    isProd: (id) => prodTabIds.has(id),
    terminalCwd: (id) => terminalCwd[id] ?? null,
    forgetCwd: (id) => delete terminalCwd[id],
    promptDelayMs: LOGIN_PROMPT_DELAY_MS,
  });
  // Files named in terminal output (v1.24, ADR 0035): a file opens the way the
  // file panel opens one, a folder in the file panel itself.
  const fileLinks = createFileLinkFlow({
    findTab,
    servers: () => servers,
    isProd: (id) => prodTabIds.has(id),
    following: (id) => !!pathSync.following[id],
    enablePathSync: (id) => pathSync.enable(id),
    openFile: (id, path, opts) => void editors.openFile(id, path, baseName(path), opts),
    openLocalFile: (id, path, opts) => void editors.openLocal(id, path, opts),
  });
  const fileDrags = createFileDragFlow({
    title: tabTitle,
    copy: { open: (request, into) => copyFlow.open(request, into), get mine() { return copyFlow.mine; } },
    localShell: (id) => localShellKind[id] ?? "posix",
    paste: (id, text) => termRefs[id]?.pasteText?.(text),
    otherWindows: () => windows.targets.length > 0,
    ghostLook: () => fileGhost?.look() ?? null,
  });
  const copyFlow = createCopyFlow({
    tabs: () => tabsState.list,
    findTab,
    title: tabTitle,
    isProd: (sessionId) => prodTabIds.has(sessionId),
    terminalCwd: (sessionId) => terminalCwd[sessionId] ?? null,
  });

  function tabAlias(tab: Tab): string {
    if (tab.kind === "local") return t("tab.localShell");
    return servers.find((s) => s.id === tab.serverId)?.alias ?? tab.alias;
  }

  /** Full title of a tab: `nginx · Rescalc dev` for a container/pod tab. */
  function tabTitle(tab: Tab): string {
    return attachTitle(tabAlias(tab), tab.attach);
  }

  /** Hover card of a container/pod tab: what it is attached to, then its status. */
  function attachTooltip(tab: Tab): string | undefined {
    if (!tab.attach) return undefined;
    const head = t(tab.attach.kind === "pod" ? "tab.attachPod" : "tab.attachContainerTitle", {
      name: tab.attach.name,
    });
    const rows = attachRows(tab.attach, tabAlias(tab)).map(([k, v]) => `${t(k)}: ${v}`);
    return [head, ...rows, localizedStatus(tab.status)].join("\n");
  }

  // ── Tabs of the previous launch (ADR 0019) ─────────────────────────────────
  // A session cannot be restored; its tab can: they come back and wait, and
  // which of them open their session by themselves is the restore flow's
  // policy (page/restoreflow) — a waiting tab otherwise opens by its button.
  const restoreFlow = createRestoreFlow({
    servers: () => servers,
    askSecret: (server, label, sessionId) => secretPrompt?.prompt(server, label, "", undefined, sessionId),
  });

  // ── Connection / tabs ──────────────────────────────────────────────────────
  async function connectServer(server: ServerProfile, place?: (sessionId: string) => void) {
    try {
      const plan = await connectPlan(server.id);
      if (plan.needsSecret) {
        secretPrompt?.prompt(server, plan.secretLabel, "", place);
        return;
      }
      const sessionId = openTabStore(server.id, server.alias, null, false);
      place?.(sessionId);
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
    // Full teardown, not just the row: this session id is dead, and anything
    // keyed by it (editors, chat, broadcast membership) has to go with it.
    closeTabFully(sessionId);
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
    // Its open files close with it (they are saved through it): unsaved edits
    // are a reason to ask even when the session itself is already dead.
    if (tab && (isLive(tab.status) || hasUnsaved(getWorkspace(sessionId)))) closeConfirmId = sessionId;
    else closeTabFully(sessionId);
  }
  /** Files of the tab being closed that have unsaved edits — said in the question. */
  const closeConfirmUnsaved = $derived(
    closeConfirmId ? getWorkspace(closeConfirmId).editors.filter(isDirty).length : 0,
  );

  /**
   * The one way a tab goes away. A session id keys state in four places besides
   * the tab list, and closing the row alone leaks all of it — the workspace holds
   * open editors' file contents, the chat holds the conversation plus terminal
   * context, and a leftover broadcast member is a *dead* session in the send set,
   * which is a correctness bug rather than just memory.
   *
   * Every close path routes here (close button, bulk close, server deletion,
   * failed re-auth); `closeTabStore` is called nowhere else, enforced by
   * [tabteardown.guard.test.ts](../lib/tabs/tabteardown.guard.test.ts). Adding
   * per-session state anywhere means adding its cleanup here.
   */
  function closeTabFully(sessionId: string, keepSession = false) {
    // The session ends here — not when its terminal unmounts (ADR 0017). The one
    // exception is a tab handed to another window (`keepSession`): that window
    // owns the session now, and the backend would refuse this one anyway.
    if (!keepSession) void disconnect(sessionId).catch(() => {});
    removeWorkspace(sessionId);
    removeChat(sessionId);
    removeBroadcastMember(sessionId);
    removeDockState(sessionId);
    fileLinks.forget(sessionId);
    // Its transfers are the backend's: a closed session's are stopped there, a
    // handed-over one's go on and are told to the window that has the tab now.
    // Here only their rows go — but a copy to a tab still in this window stays.
    dropTransfersOf(sessionId, (other) => tabsState.list.some((x) => x.sessionId === other));
    setFileSelection(sessionId, null);
    removeSyncJob(sessionId); // also stops a compare/run still going on
    // Flags only — a recording handed over with its tab keeps running; left set,
    // this window would go on pausing it as "not on screen here".
    clearRecording(sessionId);
    recFlow.forget(sessionId);
    delete followSeen[sessionId];
    pathSync.forget(sessionId);
    delete terminalCwd[sessionId];
    delete localShellKind[sessionId];
    delete pendingCommand[sessionId];
    delete connPhase[sessionId];
    delete termDims[sessionId];
    idleWasConnected.delete(sessionId);
    editors.forget(sessionId);
    delete termStructured[sessionId];
    delete termSelection[sessionId];
    clearAuthPrompt(sessionId);
    closeTabStore(sessionId);
  }

  // ── Tab-bar right-click menu ────────────────────────────────────────────────
  // Bulk-close skips the per-tab confirm dialog (it would stack N dialogs);
  // closing a single live tab still confirms via requestCloseTab.
  let tabCtxMenu = $state<OpenMenu | null>(null);

  // "Others" and "to the right" mean the tabs of the strip the menu was opened
  // on (`peers`): a pane's own tabs, or all of them in the single strip.
  // A connection with unsaved edits in its files is left open by a bulk close:
  // it has a question of its own to ask, and several at once would stack.
  function closeInBulk(tab: Tab) {
    if (!hasUnsaved(getWorkspace(tab.sessionId))) closeTabFully(tab.sessionId);
  }

  function closeOtherTabs(keep: string, peers: Tab[]) {
    for (const tab of peers) {
      if (tab.sessionId !== keep) closeInBulk(tab);
    }
  }

  function closeTabsToRight(id: string, peers: Tab[]) {
    const idx = peers.findIndex((tab) => tab.sessionId === id);
    if (idx < 0) return;
    for (const tab of peers.slice(idx + 1)) closeInBulk(tab);
  }

  /**
   * Where a pane can go as a whole: the windows that take tabs, then a window
   * of its own. Empty when the pane is one session tab — that is the tab's own
   * move. Why it cannot go right now is said when it is asked for, as for a tab.
   */
  function paneWindowActions(paneId: string): MenuAction[] {
    const count = windows.paneSessions(paneId).length;
    if (!paneMoveOffered(count)) return [];
    const out: MenuAction[] = windows.targets.map((w) => ({
      icon: "popOut",
      label: windows.targetName(w),
      onSelect: () => void windows.movePane(paneId, { window: w.label }),
    }));
    if (paneDetachOffered({ mainWindow: isMainWindow, tabs: tabsState.list.length }, count)) {
      out.push({
        icon: "popOut",
        label: t("ctx.moveToWindow"),
        onSelect: () => void windows.movePane(paneId),
      });
    }
    return out;
  }

  function openTabMenu(e: MouseEvent, tab: Tab, peers: Tab[]) {
    e.preventDefault();
    const id = tab.sessionId;
    const idx = peers.findIndex((peer) => peer.sessionId === id);
    const hasOthers = peers.length > 1;
    const hasRight = idx >= 0 && idx < peers.length - 1;
    const items: MenuItem[] = [
      {
        icon: "close",
        label: t("ctx.closeTab"),
        onSelect: () => requestCloseTab(id),
      },
      {
        icon: "close",
        label: t("ctx.closeOthers"),
        disabled: !hasOthers,
        onSelect: () => closeOtherTabs(id, peers),
      },
      {
        icon: "arrowRight",
        label: t("ctx.closeRight"),
        disabled: !hasRight,
        onSelect: () => closeTabsToRight(id, peers),
      },
    ];
    // Panes: the tab into a new one beside or below its own, or into the next
    // one — the twins of dragging it there. Not in broadcast mode, which lays
    // the terminals out itself.
    const pane = paneOf(center, id);
    if (pane) {
      const rect = placement.panes[pane.id];
      const alone = pane.tabs.length < 2;
      items.push({ kind: "separator" });
      items.push({
        icon: "splitRight",
        label: t("ctx.splitRight"),
        disabled: alone || !canSplit(rect, "right"),
        onSelect: () => splitTabOff(id, pane.id, "right"),
      });
      items.push({
        icon: "splitDown",
        label: t("ctx.splitDown"),
        disabled: alone || !canSplit(rect, "bottom"),
        onSelect: () => splitTabOff(id, pane.id, "bottom"),
      });
      if (isSplit) {
        items.push({
          icon: "arrowRight",
          label: t("ctx.moveToNextPane"),
          onSelect: () => moveTabTo(id, neighbourPane(center, pane.id, 1).id),
        });
      }
    }
    // Another window — the twin of dropping the tab outside this one: one that
    // is already open (the main one first — the way back), or one of its own.
    // Why the tab cannot go right now (a transfer, an answer still streaming) is
    // said when it is asked for; a tab that is not connected has no session to
    // take along.
    const connected = tab.status.startsWith("Connected");
    const toWindows: MenuAction[] = windows.targets.map((w) => ({
      icon: "popOut",
      label: windows.targetName(w),
      disabled: !connected,
      onSelect: () => void windows.detachTab(tab.sessionId, { window: w.label }),
    }));
    if (toWindows.length > WINDOW_ROWS) {
      items.push({
        kind: "submenu",
        key: "moveToWindow",
        icon: "popOut",
        label: t("ctx.moveToOtherWindow"),
        items: toWindows,
      });
    } else {
      items.push(...toWindows);
    }
    if (windows.canOfferDetach) {
      items.push({
        icon: "popOut",
        label: t("ctx.moveToWindow"),
        disabled: !connected,
        onSelect: () => void windows.detachTab(tab.sessionId),
      });
    }
    // The pane as a whole (v1.10): the same windows, every tab of the pane.
    if (pane) {
      const whole = paneWindowActions(pane.id);
      if (whole.length > 0) {
        items.push({
          kind: "submenu",
          key: "movePane",
          icon: "popOut",
          label: t("ctx.movePane"),
          items: whole,
        });
      }
    }
    if (tab.waiting) {
      // A tab of the previous launch (ADR 0019): the menu opens its session the
      // way its button does — asking for the secret when the server takes one.
      const action = waitView(tab.waiting, tab).action;
      if (action) {
        items.push({ kind: "separator" });
        items.push({ icon: "plug", label: t(action), onSelect: () => void restoreFlow.wake(tab.sessionId) });
      }
    } else if (tab.kind === "ssh") {
      items.push({ kind: "separator" });
      items.push({
        icon: "refresh",
        label: t("ctx.reconnect"),
        onSelect: () => reconnectTabStore(tab.sessionId),
      });
    }
    if (!bcOn && isLive(tab.status)) {
      items.push({ kind: "separator" });
      const rec = isRecording(tab.sessionId);
      items.push({
        icon: rec ? "stop" : "activity",
        label: rec ? t("ctx.stopRecording") : t("ctx.startRecording"),
        onSelect: () => void recFlow.toggleRecordingFor(tab),
      });
    }
    tabCtxMenu = { x: e.clientX, y: e.clientY, items };
  }

  // ── Config editor (Phase 12; the flow lives in page/editorflow.svelte.ts) ──
  const editors = createEditorFlow({ findTab });
  // What the sudo prompt says: reopen, check access ahead of editing, or save.
  const sudoPromptPath = $derived(
    editors.sudo?.kind === "open" ? editors.sudo.path : editors.sudo ? editors.sudo.doc.path : "",
  );
  const sudoPromptTitle = $derived(
    editors.sudo?.kind === "save"
      ? t("editor.sudoSaveTitle")
      : editors.sudo?.kind === "check"
        ? t("editor.checkSudo")
        : t("editor.sudoTitle"),
  );
  const sudoPromptConfirm = $derived(
    editors.sudo?.kind === "save"
      ? t("editor.save")
      : editors.sudo?.kind === "check"
        ? t("editor.checkSudo")
        : t("editor.sudoOpen"),
  );

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
    // The new document opens in a tab of its own, shown, in the pane in focus.
    addScratchEditor(sid, name, editorLangOrPlain(name), content, source);
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
  async function openToolInstallByName(toolName: string, sessionId?: string) {
    const sid = sessionId ?? toolsSessionId;
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

  // Poll the OS for a local shell's cwd while following is on (Phase 39.3). This
  // is what makes the feature work with a stock zsh on macOS or PowerShell on
  // Windows, neither of which emits OSC 7: no shell setup, no injected snippet.
  // It also catches a `cd` inside a script or subshell, which never draws a prompt
  // and so never fires a precmd hook. OSC 7/9;9 stay wired in parallel — a shell
  // that does announce its cwd still gets the instant, event-driven update.
  // Git on screen polls too: with following off it tracks the terminal (v1.0.35).
  $effect(() => {
    const id = tabsState.activeId;
    if (!id) return;
    const gitShown = isPanelShown(layout.docks, "git", true, settings.hiddenPanels);
    // SSH has no local pid to inspect.
    if (!pollsLocalCwd(findTab(id)?.kind, !!pathSync.following[id], gitShown)) return;
    let stopped = false;
    const tick = async () => {
      const path = await localCwd(id).catch(() => null);
      // Untracked compare: writing the same value back would re-run this effect.
      if (!stopped && path && untrack(() => terminalCwd[id]) !== path) {
        terminalCwd[id] = path;
      }
    };
    void tick();
    const timer = setInterval(tick, LOCAL_CWD_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });

  // "Follow terminal" is one switch for the whole dock (v1.0.24): the terminal's
  // cwd moves the dock's shared directory, which the file panel follows and git
  // reads. When a cwd is written is pure logic — see followcwd.ts.
  const followSeen: Record<string, string | undefined> = {};
  $effect(() => {
    const writes = followUpdates(pathSync.following, terminalCwd, followSeen);
    untrack(() => writes.forEach(([id, cwd]) => setDockCwd(id, cwd)));
  });

  /**
   * Two-way OSC 7 sync: when the user navigates in the SFTP panel (follow-terminal
   * on), cd the terminal to the same folder. Only fires on user navigation (not on
   * the panel following the terminal), so there's no feedback loop; a no-op when the
   * terminal is already there.
   */
  function cdTerminalTo(id: string, path: string) {
    if (terminalCwd[id] === path) return;
    // Phase 39.4: local tabs get this too, so the command has to match the shell
    // that tab actually spawned — cmd.exe neither quotes with apostrophes nor
    // changes drive without `/d`. SSH is always POSIX.
    const shell = findTab(id)?.kind === "local" ? (localShellKind[id] ?? "posix") : "posix";
    const cmd = cdCommand(path, shell);
    // Null means the path can't be expressed safely (empty, or holding a newline
    // that would run a second command) — send nothing rather than a broken line.
    if (!cmd) return;
    void writeToTerminal(id, new TextEncoder().encode(submitLine(cmd)));
  }

  /**
   * Docker/k8s panel "open shell": open a new terminal tab on the SAME host as
   * session `of` (reusing its credentials for SSH — no re-prompt) and run the
   * `docker exec -it …` command once it connects. Reuses the terminal contract —
   * no new backend. With a `target` the tab is a container/pod tab (tabattach.ts):
   * it carries the argv, runs it on every connect and ends with it. Without one
   * (port-forward) the argv is a one-shot `pendingCommand`.
   */
  function openContainerShell(of: string, argv: string[], target?: AttachTarget) {
    const tab = findTab(of);
    if (!tab) return;
    const attach = target ? { ...target, argv } : undefined;
    const sid =
      tab.kind === "local"
        ? openLocalTab(attach)
        : openTabStore(tab.serverId, tab.alias, tab.secret, tab.remember, attach);
    if (!attach) pendingCommand[sid] = argv;
  }

  /** Type an install command into the active terminal (user reviews + runs it). */
  function runInstallInTerminal(command: string) {
    const sid = installTool?.sessionId ?? toolsSessionId;
    if (!sid) return;
    // Show the terminal the command is typed into (a file may be in front of it).
    activateTab(sid);
    showSessionView(sid, TERMINAL_VIEW);
    showSettings = false;
    // The access check offers telnet from the Utilities overlay, which would
    // otherwise keep covering the terminal the command was just typed into.
    showUtilities = false;
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
      activateTab(sid);
    }
    void editors.openLocal(sid, path);
  }

  /**
   * The menu of a view in a connection's strip (v1.11): a file closes; any view
   * — the terminal too — goes into a zone of its own beside or below the one it
   * is in, or into the next zone; the zones join back into one.
   */
  function openViewMenu(e: MouseEvent, sessionId: string, view: string) {
    e.preventDefault();
    const ws = getWorkspace(sessionId);
    const zone = paneOf(ws.layout, view);
    if (!zone) return;
    const doc = ws.editors.find((ed) => ed.id === view) ?? null;
    const alone = zone.tabs.length < 2;
    const zones = panes(ws.layout).length;
    const items: MenuItem[] = [];
    if (doc) {
      items.push({
        icon: "close",
        label: t("common.close"),
        onSelect: () => editors.requestClose(sessionId, doc),
      });
      items.push({ kind: "separator" });
    }
    items.push({
      icon: "splitRight",
      label: t("views.splitRight"),
      disabled: alone || !canSplitZone(sessionId, zone.id, "right"),
      onSelect: () => splitSessionView(sessionId, view, "right"),
    });
    items.push({
      icon: "splitDown",
      label: t("views.splitDown"),
      disabled: alone || !canSplitZone(sessionId, zone.id, "bottom"),
      onSelect: () => splitSessionView(sessionId, view, "bottom"),
    });
    if (zones > 1) {
      items.push({
        icon: "arrowRight",
        label: t("views.moveNext"),
        onSelect: () => moveSessionViewNext(sessionId, view),
      });
      items.push({
        icon: "layoutFocus",
        label: t("views.join"),
        onSelect: () => joinSessionZones(sessionId),
      });
    }
    tabCtxMenu = { x: e.clientX, y: e.clientY, items };
  }

  // Roving keyboard navigation across the tabs of one strip (a11y): arrows/Home/End
  // move focus and selection; Enter/Space activate the focused tab.
  function onTabKey(event: KeyboardEvent, id: string, peers: Tab[]) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateTab(id);
      return;
    }
    const i = peers.findIndex((tab) => tab.sessionId === id);
    const next = nextTabIndex(i, peers.length, event.key);
    if (next === null) return;
    event.preventDefault();
    const target = peers[next].sessionId;
    activateTab(target);
    const strip = (event.currentTarget as HTMLElement).closest("[data-tabstrip]");
    [...(strip?.querySelectorAll<HTMLElement>("[data-tab]") ?? [])]
      .find((el) => el.dataset.tab === target)
      ?.focus();
  }

  // ── Tab drag: reorder, move to another pane, split (stores/tabdrag.svelte.ts) ──
  function tabPointerDown(event: PointerEvent, sessionId: string) {
    if ((event.target as HTMLElement).closest("[data-close]")) return;
    beginTabDrag(event, sessionId);
  }

  /** A click on a tab shows it — unless the click is the end of a drag. */
  function tabClick(sessionId: string) {
    if (!consumeTabDragClick()) activateTab(sessionId);
  }

  // ── Server CRUD ────────────────────────────────────────────────────────────
  let serverToDelete = $state<ServerProfile | null>(null);

  async function doDeleteServer(id: string) {
    const alias = servers.find((s) => s.id === id)?.alias ?? t("page.serverFallbackName");
    for (const sid of tabsForServer(id)) closeTabFully(sid);
    try {
      await deleteServer(id);
      // Its tabs in other windows close too (their own teardown, their own windows).
      void announceServersDeleted({ from: windowLabel, ids: [id] }).catch(() => {});
      servers = servers.filter((s) => s.id !== id);
      if (selectedId === id) selectedId = servers[0]?.id ?? null;
      notifySuccess(t("page.serverDeleted", { alias }));
    } catch (e) {
      notifyError(String(e));
    }
  }

  // Delete a folder together with the servers inside it. Mirrors doDeleteServer's
  // teardown for each victim (close its tabs, drop the selection) before the
  // backend wipes the servers, their secrets and their live sessions in one call.
  async function doDeleteFolderWithServers(path: string) {
    const victims = serversInSubtree(servers, path);
    const removed = new Set(victims.map((s) => s.id));
    for (const s of victims) for (const sid of tabsForServer(s.id)) closeTabFully(sid);
    try {
      await deleteFolderWithServers(path);
      void announceServersDeleted({ from: windowLabel, ids: [...removed] }).catch(() => {});
      servers = servers.filter((s) => !removed.has(s.id));
      folders = await listFolders();
      if (selectedId && removed.has(selectedId)) selectedId = servers[0]?.id ?? null;
      notifySuccess(t("page.folderServersDeleted", { name: nameOf(path) }));
    } catch (e) {
      notifyError(String(e));
    }
  }
</script>

<svelte:window
  onkeydown={onGlobalKey}
  bind:innerWidth={viewportWidth}
  bind:innerHeight={viewportHeight}
/>

<!-- A tool panel, for whichever dock holds it (Dock.svelte calls this). The
     panels are told whether they are on screen, never which dock they are in.
     A session panel is built for the session the dock names (`sid`), not for
     "the active tab": the docks keep the panels of every session on screen
     mounted, and a hidden one must go on working for its own session. -->
{#snippet dockPanel(id: PanelId, visible: boolean, sid: string | null)}
  {#if id === "servers"}
    <ServerTree
      {servers}
      {folders}
      {selectedId}
      {selectedFolder}
      connections={serverConnections}
      onSelect={(serverId) => {
        selectedId = serverId;
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
      onDeleteFolder={(p) => folderModals?.openDelete(p, serversInSubtree(servers, p).length)}
      onMoveServer={requestMoveServer}
      onMoveFolder={requestMoveFolder}
    />
  {:else}
    {@const tab = findTab(sid)}
    {#if tab}
      {@const srv =
        tab.kind === "ssh" ? (servers.find((s) => s.id === tab.serverId) ?? null) : null}
      <DockPanel
        {id}
        {visible}
        kind={tab.kind === "ssh" ? "ssh" : "local"}
        sessionId={tab.sessionId}
        chatPromptId={srv?.chatPromptId ?? null}
        serverExecMode={srv?.execMode ?? null}
        connection={dockConnection(tab.status)}
        terminalCwd={terminalCwd[tab.sessionId] ?? null}
        promptVars={aiPromptVarsFor(tab)}
        followTerminal={pathSync.following[tab.sessionId] ?? false}
        onToggleFollowTerminal={() => pathSync.toggle(tab.sessionId)}
        onEnablePathSync={pathSync.needsSetup(tab.sessionId) ? () => pathSync.enable(tab.sessionId) : undefined}
        getAiContext={() => gatherAiContext(tab.sessionId)}
        aiSelectionLines={termSelection[tab.sessionId] ?? 0}
        aiRecording={!!recordingState[tab.sessionId]}
        aiProd={isProdServer(srv)}
        aiNoAi={srv?.noAi === true}
        onOpenFile={(path, name, gotoLine) => editors.openFile(tab.sessionId, path, name, { gotoLine })}
        onOpenLocalFile={(path) => editors.openLocal(tab.sessionId, path)}
        onOpenGitDiff={(absPath, gitBase) => editors.openGitDiff(tab.sessionId, absPath, gitBase)}
        onIgnoreGitignore={(path, pattern) => editors.appendGitignore(tab.sessionId, path, pattern)}
        onSftpNavigate={(path) => cdTerminalTo(tab.sessionId, path)}
        onOpenContainerShell={(argv, target) => openContainerShell(tab.sessionId, argv, target)}
        onAskAi={aiOn
          ? (context, kind) => askAiAboutResource(tab.sessionId, context, kind)
          : undefined}
      />
    {/if}
  {/if}
{/snippet}

<!-- The tabs of one strip, and its "+". `tabs` is what the strip draws (while a
     tab is dragged — the order the drop would give), `peers` the tabs it really
     holds: a pane's own, or all of them in the single strip. `shownId` is the tab
     the pane shows and `paneId` the pane (both null for the single strip). The top line marks the tab in
     focus only — the one the docks and the status bar follow (tabstrip.ts); the
     tab another pane shows is lit without it. -->
<!-- The terminal's tools: ask the assistant about the selection, clear,
     search, Raw/Table. They stand at the right end of the row above the
     terminal — its own bar, or, while the connection has files open, the strip
     of the zone that shows it. Which of them there are — sessionbar.ts. -->
{#snippet sessionTools(tab: Tab, bar: ReturnType<typeof sessionBarParts>)}
  {#if bar.search || bar.viewToggle || bar.clear || bar.askAi}
    <div class="flex shrink-0 items-center gap-1 px-1.5 py-0.5">
      {#if bar.askAi}
        {@const hasSel = (termSelection[tab.sessionId] ?? 0) > 0}
        <button
          class="flex items-center rounded p-1 text-muted enabled:hover:bg-edge enabled:hover:text-text disabled:opacity-40"
          data-testid="session-bar-ask-ai"
          disabled={!hasSel}
          use:tooltip={hasSel ? t("sessionBar.askAi") : t("sessionBar.askAiNoSelection")}
          aria-label={t("sessionBar.askAi")}
          onclick={() =>
            explainWithAi(tab.sessionId, termRefs[tab.sessionId]?.selectionText?.() ?? "")}
        >
          <Icon name="aiMark" size={14} />
        </button>
      {/if}
      {#if bar.clear}
        <button
          class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-text"
          data-testid="session-bar-clear"
          use:tooltip={t("sessionBar.clear")}
          aria-label={t("sessionBar.clear")}
          onclick={() => termRefs[tab.sessionId]?.clear?.()}
        >
          <Icon name="trash" size={14} />
        </button>
      {/if}
      {#if bar.search}
        <button
          class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-text"
          data-testid="session-bar-search"
          use:tooltip={t("search.open")}
          aria-label={t("search.open")}
          onclick={() => termRefs[tab.sessionId]?.find?.()}
        >
          <Icon name="search" size={14} />
        </button>
      {/if}
      {#if bar.viewToggle}
        <ViewModeToggle
          structured={!!termStructured[tab.sessionId]}
          onSelect={(on) => termRefs[tab.sessionId]?.setViewMode?.(on)}
        />
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet stripTabs(tabs: Tab[], peers: Tab[], shownId: string | null, stripId: string, paneId: string | null)}
  <div
    data-tabstrip={stripId}
    class="tab-strip-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto"
  >
  {#each tabs as tab (tab.sessionId)}
    <!-- `inert` on the place kept for a tab held over the window from another
         one: it is a picture of a tab — nothing to click, focus or read out. -->
    <div
      data-tab={tab.sessionId}
      data-incoming={tab.sessionId === INCOMING_TAB || undefined}
      inert={tab.sessionId === INCOMING_TAB}
      animate:glide={motion()}
      role="tab"
      tabindex={(shownId ?? tabsState.activeId) === tab.sessionId ? 0 : -1}
      aria-selected={(shownId ?? tabsState.activeId) === tab.sessionId}
      onpointerdown={(e) => tabPointerDown(e, tab.sessionId)}
      onclick={() => tabClick(tab.sessionId)}
      oncontextmenu={(e) => openTabMenu(e, tab, peers)}
      onkeydown={(e) => onTabKey(e, tab.sessionId, peers)}
      data-prod={prodTabIds.has(tab.sessionId) || undefined}
      class="flex min-w-16 max-w-48 flex-1 basis-0 cursor-grab items-center gap-2 overflow-hidden border-r border-edge px-2.5 py-1.5 text-sm touch-none active:cursor-grabbing {tabsState.activeId ===
      tab.sessionId
        ? `bg-panel text-text ${activeTabStrip(prodTabIds.has(tab.sessionId), 2)}`
        : shownId === tab.sessionId
          ? 'bg-panel text-text'
          : 'text-muted hover:bg-edge'} {fileDrags.overSession === tab.sessionId
        ? 'ring-1 ring-inset ring-accent'
        : ''}"
      data-file-over={fileDrags.overSession === tab.sessionId || undefined}
      title={tab.attach ? undefined : localizedStatus(tab.status)}
      use:tooltip={attachTooltip(tab)}
    >
      <!-- Status / recording / broadcast dots grouped tightly together. -->
      <span class="flex shrink-0 items-center gap-0.5">
        <span class="h-2 w-2 rounded-full {dotClass(tab.status)}"></span>
        {#if recordingState[tab.sessionId]}
          {#if recordingPaused[tab.sessionId]}
            <Icon
              name="pause"
              size={12}
              class="text-ok"
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
            class="h-2 w-2 rounded-full bg-accent"
            use:tooltip={t("broadcast.memberDot")}
            aria-label={t("broadcast.memberDot")}
          ></span>
        {/if}
      </span>
      {#if tab.attach}
        <!-- Container/pod tab: its mark, the target's name, the host muted.
             The host yields its width first — the name is what tells two
             container tabs of one host apart. -->
        <Icon
          name={attachIcon(tab.attach.kind)}
          size={14}
          class="shrink-0 {isLive(tab.status) ? 'text-accent' : 'text-muted'}"
        />
        <span class="flex min-w-0 flex-1 items-baseline gap-1">
          <span class="min-w-0 truncate">{tab.attach.name}</span>
          <span class="min-w-0 truncate text-muted">· {tabAlias(tab)}</span>
        </span>
      {:else}
        <span class="min-w-0 flex-1 truncate">{tabAlias(tab)}</span>
      {/if}
      {#if prodTabIds.has(tab.sessionId)}
        <span class="shrink-0 rounded bg-bad/15 px-1 text-caption text-bad">prod</span>
      {/if}
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
  <!-- Open a local-shell terminal tab (same "+" as the top bar) — in this pane.
       A mouse press has already given the pane the focus; Enter on the button has
       not, so it is given here. -->
  <button
    data-testid="new-local-terminal"
    class="flex shrink-0 items-center rounded-none px-2.5 py-1.5 text-muted hover:bg-edge hover:text-text"
    use:tooltip={t("tab.openLocalTerminal")}
    aria-label={t("tab.openLocalTerminal")}
    onclick={() => {
      if (paneId) focusPane(paneId);
      openLocalTab();
    }}
  >
    <Icon name="plus" size={14} />
  </button>
  </div>
{/snippet}


<div class="flex h-screen w-screen flex-col">
  <!-- Signature-theme depth: a subtle full-window overlay above all content,
       below modals — unifies terminal + chrome without touching the renderer. -->
  <ThemeOverlay />
  <!-- Idle screensaver (Phase 0.28): full-window canvas over the terminal after
       inactivity, and the NO SIGNAL takeover on an unexpected drop. Copies the
       buffer; never writes to the PTY. -->
  <IdleOverlay
    sessionId={monitoredSessionId(activeTab)}
    tabs={tabsState.list.length}
    alias={activeTab?.alias ?? ""}
    bufferText={() => termRefs[tabsState.activeId ?? ""]?.bufferText?.() ?? ""}
    outputTick={idleOutputTick}
    noSignal={noSignalSession !== null}
    targetEl={terminalArea ?? mainArea ?? null}
    onnosignaldismiss={() => (noSignalSession = null)}
  />
  {#if showWindowChrome}
    <TitleBar
      onChangelog={() => { helpTab = "changelog"; showHelp = true; }}
      onUpdates={() => { helpTab = "updates"; showHelp = true; }}
      onSettings={() => openSettings()}
      onMonitoring={openMonitoring}
      onAbout={() => {
        helpTab = "about";
        showHelp = true;
      }}
      onHelp={() => {
        helpTab = "help";
        showHelp = true;
      }}
      onManual={() => {
        helpTab = "manual";
        showHelp = true;
      }}
    />
  {/if}
  <TopBar
    title={topTitle}
    subtitle={topSubtitle}
    connected={sessionActions.connected}
    canRecord={sessionActions.canRecord}
    recording={sessionActions.recording}
    onToggleRecording={() => runSessionAction("record")}
    onOpenRecordings={() => runSessionAction("recordings")}
    onOpenMonitoring={() => runSessionAction("monitoring")}
    onOpenSettings={() => openSettings("servertools")}
    onOpenUtilities={(utility) => openUtilities(utility ?? null)}
    canBroadcast={sessionActions.canBroadcast}
    broadcastActive={sessionActions.broadcastActive}
    onToggleBroadcast={() => runSessionAction("broadcast")}
    showNotes={sessionActions.notesFor !== null}
    hasNotes={hasNotes(notesServerTarget?.notes)}
    onOpenNotes={() => runSessionAction("notes")}
  />

  <div class="flex min-h-0 flex-1">
    <Dock
      side="left"
      sessionId={dockSessionId}
      sessions={dockSessions}
      caption={dockCaption}
      sessionKind={activeTab?.kind ?? "ssh"}
      connection={dockConn}
      stripHeight={tabBarHeight}
      panel={dockPanel}
    />

    <!-- Right: tabbed terminals -->
    <main bind:this={mainArea} class="flex min-w-0 flex-1 flex-col bg-panel">
      <!-- The single tab strip: there while the centre is one pane, so the
           local-terminal "+" is reachable even with no open sessions. Split,
           each pane carries its own strip inside the area below. -->
      {#if !paneStrips}
        <div
          bind:offsetHeight={flatBarHeight}
          role="tablist"
          tabindex={-1}
          class="flex min-h-8 min-w-0 select-none items-stretch border-b border-edge bg-panel-alt"
        >
          {@render stripTabs(
            tabsOf(
              incoming.tab
                ? previewIncoming(center, paneList[0].id, INCOMING_TAB, incoming.over)
                : previewTabs(center, paneList[0].id, tabDrag.tab, tabDrag.over),
            ),
            tabsOf(paneList[0].tabs),
            null,
            paneList[0].id,
            null,
          )}
        </div>
      {/if}

      <div class="flex min-h-0 flex-1">
        {#if tabsState.list.length > 0}
          <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            {#if bcOn}
              <!-- Broadcast toolbar: group size, the grid of members and the
                   way back from it, quick actions, exit. The two layout buttons
                   are commands of the centre's layout (v1.9), not modes of a view
                   of its own. -->
              <div class="flex shrink-0 items-center gap-2 border-b border-edge bg-panel-alt px-2 py-1 text-xs">
                <Icon name="broadcast" size={14} class="text-accent" />
                <span class="font-medium text-text">{t("broadcast.title")}</span>
                <span class="text-muted">{t("broadcast.targetCount", { count: bcTargets.length })}</span>
                <div class="mx-1 flex items-center gap-0.5 rounded bg-panel p-0.5">
                  <button
                    class="rounded p-1 text-muted enabled:hover:text-text disabled:opacity-40"
                    data-testid="broadcast-grid"
                    disabled={bcMemberTabs.length < 2}
                    onclick={() => tileSessions(bcMemberTabs.map((tab) => tab.sessionId))}
                    use:tooltip={t("broadcast.layoutGrid")}
                    aria-label={t("broadcast.layoutGrid")}
                  >
                    <Icon name="layoutGrid" size={14} />
                  </button>
                  <button
                    class="rounded p-1 text-muted enabled:hover:text-text disabled:opacity-40"
                    data-testid="broadcast-ungrid"
                    disabled={!isSplit && !tabsState.tiled}
                    onclick={untilePanes}
                    use:tooltip={t(tabsState.tiled ? "broadcast.layoutBack" : "broadcast.layoutFocus")}
                    aria-label={t(tabsState.tiled ? "broadcast.layoutBack" : "broadcast.layoutFocus")}
                  >
                    <Icon name="layoutFocus" size={14} />
                  </button>
                </div>
                <button
                  class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-text"
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
                  class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-text"
                  onclick={() => {
                    if (tabsState.activeId) removeBroadcastMember(tabsState.activeId);
                    void recFlow.syncBatchRecording();
                  }}
                  use:tooltip={t("broadcast.exit")}
                  aria-label={t("broadcast.exit")}
                >
                  <Icon name="minus" size={14} />
                </button>
              </div>
            {/if}
            <div class="flex min-h-0 min-w-0 flex-1">
            <div
              bind:this={terminalArea}
              bind:clientWidth={bcAreaWidth}
              bind:clientHeight={areaHeight}
              class="relative min-h-0 min-w-0 flex-1"
            >
            {#if paneStrips}
              <!-- The panes: each is its tab strip. The terminals are NOT inside
                   them: they follow in one flat list and are placed over the pane
                   that holds them, under its strip. -->
              {#each paneList as pane (pane.id)}
                <div
                  data-pane={pane.id}
                  data-testid="pane"
                  data-focused={pane.id === center.focus || undefined}
                  class="absolute flex flex-col"
                  style={rectStyle(placement.panes[pane.id], areaBounds)}
                  onpointerdowncapture={() => focusPane(pane.id)}
                >
                  <div
                    role="tablist"
                    tabindex={-1}
                    style="height: {tabBarHeight}px"
                    class="flex min-w-0 shrink-0 select-none items-stretch border-b border-edge bg-panel-alt"
                  >
                    {@render stripTabs(
                      tabsOf(
                        incoming.tab
                          ? previewIncoming(center, pane.id, INCOMING_TAB, incoming.over)
                          : previewTabs(center, pane.id, tabDrag.tab, tabDrag.over),
                      ),
                      tabsOf(pane.tabs),
                      pane.active,
                      pane.id,
                      pane.id,
                    )}
                  </div>
                </div>
              {/each}
              {#each placement.dividers as divider (divider.split)}
                <SplitDivider
                  {divider}
                  bounds={areaBounds}
                  onratio={(ratio) => setSplitRatio(divider.split, ratio)}
                />
              {/each}
            {/if}
            {#each tabsState.list as tab (tab.sessionId)}
              {@const bcSrv = servers.find((s) => s.id === tab.serverId)}
              {@const bar = sessionBarParts({
                connected: tab.status.startsWith("Connected"),
                smartLogs: settings.smartLogs.enabled,
                structured: !!termStructured[tab.sessionId],
                ai: aiOn && bcSrv?.noAi !== true,
              })}
              {@const ws = getWorkspace(tab.sessionId)}
              {@const views = ws.layout}
              {@const hasFiles = ws.editors.length > 0}
              {@const vb = sessionBounds(tab.sessionId)}
              {@const vp = layoutRects(views.root, vb)}
              {@const termZone = paneOf(views, TERMINAL_VIEW)}
              {@const prod = prodTabIds.has(tab.sessionId)}
              <!-- One connection, placed over its pane: its terminal and the
                   files open through it, in zones of its own (v1.11, ADR 0024).
                   A click or a keystroke inside gives that pane the focus. -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                data-pane-body={tabPane[tab.sessionId]}
                data-views-of={tab.sessionId}
                class="absolute {shownIds.has(tab.sessionId) ? '' : 'invisible'}"
                style={rectStyle(placement.panes[tabPane[tab.sessionId]], areaBounds, stripInset)}
                onpointerdowncapture={() => focusPane(tabPane[tab.sessionId])}
                onfocusin={() => focusPane(tabPane[tab.sessionId])}
              >
                {#if hasFiles}
                  <!-- Each zone's strip of views: the terminal and the files that
                       stand in it. There is none while the connection has no
                       file open — a terminal alone needs no strip. The top line
                       marks the view in focus only, as on the tabs above.
                       A view is dragged like a session's tab above: along its
                       strip, into another zone's, or onto a zone's body. While
                       one is in the air the strips draw the order the drop would
                       give — the layout itself changes on release. -->
                  {#each panes(views) as zone (zone.id)}
                    {@const shownView = zone.active}
                    <div
                      class="absolute z-10 flex select-none items-stretch border-b border-edge bg-panel-alt text-xs"
                      style={stripStyle(vp.panes[zone.id], vb, VIEW_STRIP)}
                      data-testid="view-strip"
                      data-viewstrip={zone.id}
                    >
                      <div
                        class="flex min-w-0 flex-1 items-stretch overflow-x-auto"
                        role="tablist"
                        aria-label={t("views.strip")}
                      >
                        {#each viewDrag.session === tab.sessionId ? previewTabs(views, zone.id, viewDrag.view, viewDrag.over) : zone.tabs as view (view)}
                          {@const ed = ws.editors.find((e) => e.id === view)}
                          {@const shown = shownView === view}
                          <!-- svelte-ignore a11y_no_static_element_interactions -->
                          <div
                            animate:glide={motion()}
                            class="group flex shrink-0 cursor-grab touch-none items-center border-r border-edge active:cursor-grabbing {shown &&
                            views.focus === zone.id
                              ? `bg-panel text-text ${activeTabStrip(prod, 1)}`
                              : shown
                                ? 'bg-panel text-text'
                                : 'text-muted hover:bg-edge'}"
                            data-view={view}
                            onpointerdown={(e) => viewPointerDown(e, tab.sessionId, view)}
                            oncontextmenu={(e) => openViewMenu(e, tab.sessionId, view)}
                          >
                            {#if view === TERMINAL_VIEW}
                              <button
                                role="tab"
                                aria-selected={shown}
                                class="flex cursor-[inherit] items-center gap-1.5 px-3 py-1"
                                onclick={() => viewClick(tab.sessionId, view)}
                              >
                                <Icon name="terminal" size={13} />
                                {t("workspace.terminal")}
                              </button>
                            {:else if ed}
                              <button
                                role="tab"
                                aria-selected={shown}
                                class="flex cursor-[inherit] items-center gap-1.5 py-1 pl-2"
                                title={ed.path}
                                onclick={() => viewClick(tab.sessionId, view)}
                              >
                                <Icon name="file" size={13} />
                                <span class="max-w-32 truncate">{ed.name}</span>
                                {#if isDirty(ed)}
                                  <span
                                    class="h-1.5 w-1.5 rounded-full bg-accent"
                                    data-testid="doc-unsaved"
                                    use:tooltip={t("editor.unsaved")}
                                  ></span>
                                {/if}
                              </button>
                              <button
                                data-close
                                class="rounded px-1.5 py-1 opacity-60 hover:text-danger hover:opacity-100"
                                aria-label={t("common.close")}
                                onclick={() => editors.requestClose(tab.sessionId, ed)}
                              >
                                <Icon name="close" size={12} />
                              </button>
                            {/if}
                          </div>
                        {/each}
                      </div>
                      {#if shownView === TERMINAL_VIEW}
                        {@render sessionTools(tab, bar)}
                      {/if}
                    </div>
                  {/each}
                  {#each vp.dividers as divider (divider.split)}
                    <SplitDivider
                      {divider}
                      bounds={vb}
                      onratio={(ratio) => setSessionZoneRatio(tab.sessionId, divider.split, ratio)}
                    />
                  {/each}
                {/if}
                <!-- The terminal, over the zone that holds it. -->
                <div
                  class="absolute flex flex-col {terminalShown(views) ? '' : 'invisible'}"
                  style={rectStyle(termZone ? vp.panes[termZone.id] : undefined, vb, hasFiles ? VIEW_STRIP : 0)}
                  data-testid="terminal-body"
                  data-zone-body={termZone?.id}
                  onpointerdowncapture={() => termZone && focusSessionZone(tab.sessionId, termZone.id)}
                  onfocusin={() => termZone && focusSessionZone(tab.sessionId, termZone.id)}
                >
                {#if !hasFiles && showSessionBar(bar)}
                  <!-- The terminal's own bar: its tools, at its right end. They
                       used to float over the terminal and covered full-screen
                       programs' first row (nano's title line). While the
                       connection has files open they stand in the strip of the
                       zone that shows the terminal instead. -->
                  <div
                    class="flex shrink-0 items-stretch border-b border-edge bg-panel-alt text-xs"
                    data-testid="session-bar"
                  >
                    <div class="min-w-0 flex-1"></div>
                    {@render sessionTools(tab, bar)}
                  </div>
                {/if}
                <div class="relative min-h-0 flex-1 p-1">
                <div class="absolute inset-0">
                {#if tab.waiting}
                  <!-- A tab of the previous launch whose session is not open
                       (ADR 0019): its place says so and holds the one button
                       that opens it. Nothing is connected to until it is used. -->
                  {@const wait = waitView(tab.waiting, tab)}
                  <div class="absolute inset-0 z-20 bg-panel" data-testid="tab-waiting">
                    <EmptyState icon={wait.icon} title={tabTitle(tab)} hint={t(wait.hint)}>
                      {#if wait.action}
                        <button
                          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
                          data-testid="tab-wake"
                          onclick={() => restoreFlow.wake(tab.sessionId)}
                        >
                          {t(wait.action)}
                        </button>
                      {/if}
                    </EmptyState>
                  </div>
                {:else if tab.attach && tab.status.startsWith("Disconnected")}
                  <!-- The container session ended (`exit`, or the container
                       stopped): the tab's shell ended with it, so its output stays
                       and the one way on is back into the same target. -->
                  <div
                    class="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 border-b border-edge bg-panel-alt/95 px-3 py-1.5 text-xs"
                    data-testid="attach-ended"
                  >
                    <span class="text-muted">
                      {t(tab.attach.kind === "pod" ? "tab.attachPodEnded" : "tab.attachEnded", {
                        name: tab.attach.name,
                      })}
                    </span>
                    <button
                      class="rounded bg-accent px-2 py-0.5 text-panel-alt hover:bg-accent-hover"
                      onclick={() => reconnectTabStore(tab.sessionId)}
                    >
                      {t("tab.attachReenter")}
                    </button>
                  </div>
                {:else if tab.kind === "ssh" && tab.status.startsWith("Connecting")}
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
                    detail={ev.detailKey ? t(ev.detailKey, ev.detailVars) : ev.detailText}
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
                    pasteShell={tab.attach ? "posix" : (localShellKind[tab.sessionId] ?? "posix")}
                    tint={prodTabIds.has(tab.sessionId) ? settings.prodTint : null}
                    focusOnConnect={tabsState.activeId === tab.sessionId && terminalFocused(views)}
                    adopt={tab.adopt ?? null}
                    waiting={!!tab.waiting}
                    onadopted={() => {
                      clearAdopt(tab.sessionId);
                      windowHasHadTab = true;
                    }}
                    onadoptfailed={() => windows.adoptFailed(tab.sessionId)}
                    onresize={(cols, rows) => (termDims[tab.sessionId] = { cols, rows })}
                    onactivity={() => recFlow.activity(tab.sessionId)}
                    onoutput={() => idleOutputTick++}
                    oncwd={(path) => (terminalCwd[tab.sessionId] = path)}
                    onExplain={aiOn && servers.find((s) => s.id === tab.serverId)?.noAi !== true
                      ? (sel) => explainWithAi(tab.sessionId, sel)
                      : undefined}
                    onselection={(lines) => (termSelection[tab.sessionId] = lines)}
                    onlocalshell={(kind) => (localShellKind[tab.sessionId] = kind)}
                    onviewmode={(on) => (termStructured[tab.sessionId] = on)}
                    onfilelink={fileLinksAllowed(tab)
                      ? (target) => fileLinks.clicked(tab.sessionId, target)
                      : undefined}
                    filelinkDirs={!isPanelHidden("files")}
                    onphase={(p) => (connPhase[tab.sessionId] = p)}
                    onauthprompt={(req) => setAuthPrompt(tab.sessionId, req)}
                    onstatus={(st, d) => {
                      setTabStatus(tab.sessionId, st, d);
                      // The login finished either way — no question can still be open.
                      if (st !== "connecting") clearAuthPrompt(tab.sessionId);
                      if (st === "connecting") connPhase[tab.sessionId] = "connecting";
                      if (st === "connected") idleWasConnected.add(tab.sessionId);
                      // A container/pod tab enters its target on EVERY connect (so
                      // "Enter again" is a plain reconnect); a one-shot command once.
                      const attach = findTab(tab.sessionId)?.attach;
                      // Read before the pending command is consumed below.
                      const runs = { attach: !!attach, pendingCommand: !!pendingCommand[tab.sessionId] };
                      if (st === "connected" && (attach || pendingCommand[tab.sessionId])) {
                        const argv = attach ? attach.argv : pendingCommand[tab.sessionId];
                        delete pendingCommand[tab.sessionId];
                        // SSH is always POSIX; a local tab reported its shell before
                        // it spawned (cmd.exe needs double quotes, not `'…'`).
                        const shell =
                          tab.kind === "local" ? (localShellKind[tab.sessionId] ?? "posix") : "posix";
                        const cmd = attach
                          ? renderSessionCommand(argv, shell)
                          : renderArgv(argv, shell);
                        if (!cmd) {
                          notifyError(t("page.commandUnquotable"));
                        } else {
                          // Small delay so the login shell prompt is ready first.
                          setTimeout(() => {
                            void writeToTerminal(
                              tab.sessionId,
                              new TextEncoder().encode(submitLine(cmd)),
                            ).catch(() => {});
                          }, LOGIN_PROMPT_DELAY_MS);
                        }
                      }
                      if (st === "connecting" && noSignalSession === tab.sessionId)
                        noSignalSession = null;
                      if (st === "closed") {
                        recFlow.finalizeOnClose(tab.sessionId);
                        pathSync.closed(tab.sessionId);
                        // Unexpected drop of a connected session (tab survives) →
                        // NO SIGNAL, unless auto-reconnect will bring it back.
                        const was = idleWasConnected.delete(tab.sessionId);
                        // A container tab closing is its session ending (`exit`),
                        // not a drop: no NO SIGNAL, no auto-reconnect back inside.
                        if (
                          findTab(tab.sessionId) &&
                          !attach &&
                          !settings.autoReconnect &&
                          tab.kind === "ssh" &&
                          showNoSignal({ userInitiated: false, wasConnected: was })
                        ) {
                          noSignalSession = tab.sessionId;
                        }
                      }
                      if (st === "connected") recFlow.maybeAutoRecord(tab);
                      if (st === "connected") pathSync.connected(tab, runs);
                      // Auth failures now keep the tab and show the error overlay
                      // (the user re-enters the secret via its button), so we no
                      // longer auto-close/re-prompt here.
                      if (st === "closed" && settings.autoReconnect && tab.kind === "ssh" && !attach) {
                        setTimeout(() => {
                          if (findTab(tab.sessionId)) reconnectTabStore(tab.sessionId);
                        }, 1000);
                      }
                    }}
                  />
                {/key}
                </div>
                </div>
                </div>
                <!-- The connection's files: one flat keyed list, each placed over
                     the zone that holds it — moving a file to another zone changes
                     a rectangle, never the component, so its editor keeps its undo
                     history and its place. Outside `{#key tab.gen}`: a reconnect
                     makes a new terminal, not new editors. -->
                {#each ws.editors as ed (ed.id)}
                  {@const zone = paneOf(views, ed.id)}
                  <div
                    class="absolute flex flex-col {zone?.active === ed.id ? '' : 'invisible'}"
                    style={rectStyle(zone ? vp.panes[zone.id] : undefined, vb, VIEW_STRIP)}
                    data-testid="doc-body"
                    data-doc={ed.id}
                    data-zone-body={zone?.id}
                    onpointerdowncapture={() => zone && focusSessionZone(tab.sessionId, zone.id)}
                    onfocusin={() => zone && focusSessionZone(tab.sessionId, zone.id)}
                  >
                    <!-- Clipped to its zone: the editor's own bar does not wrap,
                         and in a narrow zone it would run into the next one. -->
                    <div class="relative min-h-0 flex-1 overflow-hidden p-1">
                      <div class="absolute inset-0">
                        {#if ed.loadError}
                          <div class="p-4 text-sm text-danger">{ed.loadError}</div>
                        {:else if ed.loading}
                          <div class="p-4 text-sm text-muted">{t("editor.loading")}</div>
                        {:else}
                          <EditorTab
                            sessionId={tab.sessionId}
                            doc={ed}
                            saving={editors.savingId === ed.id}
                            onsave={() => editors.save(tab.sessionId, ed)}
                            onCheckSudo={() => editors.askSudo(tab.sessionId, ed, "check")}
                            onSaveWithSudo={() => editors.askSudo(tab.sessionId, ed, "save")}
                            onSaveCopy={() => void editors.saveCopy(ed)}
                            onDismissSaveIssue={() => setEditorSaveIssue(tab.sessionId, ed.id, "none")}
                            onLintMissing={offerLintInstall}
                          />
                        {/if}
                      </div>
                    </div>
                  </div>
                {/each}
                {#if prod}
                  <!-- Prod frame: an inert overlay ring over the whole connection
                       — its terminal and its files alike: a file of a prod server
                       is edited on prod. Never a border/padding on the terminal
                       itself — FitAddon measures that element (termfit.guard), and
                       a real border would shrink the grid. z-20 keeps it above the
                       connecting overlay and the structured log view.
                       It begins under the top row of view strips, when there is
                       one: the line that marks the view in focus runs along that
                       same top edge in the same red, and under a frame laid over
                       it nobody could tell which view that was (v1.11.3). What a
                       view shows — the file's text — is inside the frame still. -->
                  <div
                    class="pointer-events-none absolute inset-x-0 bottom-0 z-20 ring-1 ring-inset ring-bad/60"
                    style="top: {hasFiles ? VIEW_STRIP : 0}px"
                    data-testid="prod-frame"
                    aria-hidden="true"
                  ></div>
                {/if}
              </div>
            {/each}
            </div>
              {#if bcOn && bcOffScreen.length > 0}
                <!-- Members no pane shows: they receive what is sent all the
                     same, so they are named here. A click brings one on screen. -->
                <BroadcastRoster
                  rows={bcRosterRows}
                  onfocus={activateTab}
                  onremove={(id) => {
                    removeBroadcastMember(id);
                    void recFlow.syncBatchRecording();
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
        {:else}
          <div class="min-h-0 min-w-0 flex-1">
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
          </div>
        {/if}
        <!-- Split, there is no strip above the row: the right dock stands next to
             the panes' own strips and takes their height, like the left one. -->
        <Dock
          side="right"
          sessionId={dockSessionId}
          sessions={dockSessions}
          caption={dockCaption}
          sessionKind={activeTab?.kind ?? "ssh"}
          connection={dockConn}
          stripHeight={paneStrips ? tabBarHeight : 0}
          panel={dockPanel}
        />
      </div>
    </main>
  </div>

  <!-- Bottom dock: the full width of the window, above the status bar. -->
  <Dock
    side="bottom"
    sessionId={dockSessionId}
    sessions={dockSessions}
    caption={dockCaption}
    sessionKind={activeTab?.kind ?? "ssh"}
    connection={dockConn}
    panel={dockPanel}
  />

  {#if settings.showStatusBar && tabsState.activeId && monitorConnected}
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
    onAskAi={aiOn ? askAiAboutMetrics : undefined}
  />
{/if}

<!-- The label following the pointer while a tool-panel tab is dragged. -->
<DockDragGhost />
<FileDragGhost bind:this={fileGhost} />

<!-- Where a dragged terminal tab would land on a pane's body: the whole pane (it
     joins the pane) or the half a new pane would take. A tint, not a change of
     layout — the terminals keep their size until the drop. -->
{#if dropZone}
  <div
    aria-hidden="true"
    data-testid="pane-drop-zone"
    class="pointer-events-none fixed z-40 border-2 border-dashed border-accent bg-accent/25"
    style="left: {dropZone.x}px; top: {dropZone.y}px; width: {dropZone.w}px; height: {dropZone.h}px"
  ></div>
{/if}

<!-- Drag ghost for a terminal tab being moved: one of this window's — or one
     held over this window from another (ADR 0018), which keeps the pointer
     while this window draws it. -->
{#if draggingTab && windows.leavesWindow}
  <!-- The label as it is drawn next to the pointer, unseen — its size and
       colours are what the floating label over the desktop is given. -->
  <div
    bind:this={ghostProbe}
    aria-hidden="true"
    class="pointer-events-none invisible fixed left-0 top-0 flex max-w-64 items-center gap-2 rounded border border-accent bg-panel-alt px-3 py-1.5 text-sm"
  >
    <span data-part="dot" class="h-2 w-2 shrink-0 rounded-full {dotClass(draggingTab.status)}"></span>
    <span class="truncate">{tabAlias(draggingTab)}</span>
  </div>
{/if}
{#if viewDrag.view !== null && viewDrag.session !== null}
  <!-- A view of a connection in the air (v1.11.1): its label hangs from the
       pointer and stops at the edge of the connection's area — a file cannot
       be taken out of the connection it is saved through. -->
  {@const at = confinedGhost(viewDrag.x, viewDrag.y, viewDrag.area, viewGhost)}
  {@const file = getWorkspace(viewDrag.session).editors.find((e) => e.id === viewDrag.view)}
  <div
    in:fade={motion()}
    data-testid="view-drag-ghost"
    bind:offsetWidth={viewGhost.w}
    bind:offsetHeight={viewGhost.h}
    class="pointer-events-none fixed z-50 flex max-w-48 items-center gap-1.5 rounded border border-accent bg-panel-alt px-2 py-1 text-xs opacity-90 shadow-lg"
    style="left: {at.x}px; top: {at.y}px"
  >
    <Icon name={file ? "file" : "terminal"} size={13} class="shrink-0 text-muted" />
    <span class="truncate">{file ? file.name : t("workspace.terminal")}</span>
  </div>
{/if}
{#if draggingTab && !heldOverWindow && !tabDrag.floating}
  <!-- Outside the window the label cannot follow the pointer, so it waits at the
       edge the pointer left through and says what letting go will do. Over
       another window of the app there is nothing to draw here: that window
       shows the tab under the pointer. -->
  {@const ghost = ghostPlace(tabDrag, { width: viewportWidth, height: viewportHeight })}
  <div
    in:fade={motion()}
    data-testid="tab-drag-ghost"
    class="pointer-events-none fixed z-50 flex max-w-64 items-center gap-2 rounded border border-accent bg-panel-alt px-3 py-1.5 text-sm opacity-90 shadow-lg"
    style="left: {ghost.x}px; top: {ghost.y}px"
  >
    <span class="h-2 w-2 shrink-0 rounded-full {dotClass(draggingTab.status)}"></span>
    <span class="truncate">{tabAlias(draggingTab)}</span>
    {#if tabDrag.outside && windows.canOfferDetach && !floatsOutside}
      <Icon name="popOut" size={13} class="shrink-0 text-accent" />
      <span class="min-w-0 truncate text-meta text-muted" data-testid="tab-drag-outside">
        {t("ctx.moveToWindow")}
      </span>
    {/if}
  </div>
{:else if incomingTab && !incoming.landing}
  <!-- Let go of here, the label goes and the place kept in the strip stays
       until the tab itself arrives. -->
  {@const ghost = ghostPlace(
    { x: incoming.x, y: incoming.y, outside: false },
    { width: viewportWidth, height: viewportHeight },
  )}
  <div
    in:fade={motion()}
    data-testid="tab-incoming-ghost"
    class="pointer-events-none fixed z-50 flex max-w-64 items-center gap-2 rounded border border-accent bg-panel-alt px-3 py-1.5 text-sm opacity-90 shadow-lg"
    style="left: {ghost.x}px; top: {ghost.y}px"
  >
    <span class="h-2 w-2 shrink-0 rounded-full {dotClass(incomingTab.status)}"></span>
    <span class="truncate">{tabAlias(incomingTab)}</span>
  </div>
{/if}

<!-- A tab is on its way to a new window: nothing here may be clicked until it
     has settled — closing the tab now would end the session being handed over. -->
{#if windows.detaching}
  <div class="fixed inset-0 z-[60] cursor-progress" data-testid="detach-shield"></div>
{/if}

<SettingsPanel
  bind:open={showSettings}
  onImported={refresh}
  {toolsSessionId}
  {toolsReloadToken}
  onInstallTool={openToolInstall}
  initialSection={settingsSection}
/>

<UtilitiesPanel
  bind:open={showUtilities}
  initialUtility={utilitiesInitial}
  session={utilSession}
  {netServers}
  {netTabs}
  onConnectServer={connectServerById}
  onInstallTool={(tool, sid) => openToolInstallByName(tool, sid)}
  {toolsReloadToken}
  actions={sessionActions}
  onSessionAction={runSessionAction}
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
<HelpPanel bind:open={showHelp} bind:tab={helpTab} onInstall={(version) => void askToUpdate(version)} mainWindow={isMainWindow} />
<Modal open={updateFreeze} title={t("updates.preparing")} onclose={() => {}}><p class="text-xs text-muted">{t("updates.preparing")}</p></Modal>

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
  onDeleteWithServers={doDeleteFolderWithServers}
  onchanged={async () => {
    [servers, folders] = await Promise.all([listServers(), listFolders()]);
  }}
/>

<!-- Transfers (v1.12): where a copy to another session lands, and — for every
     way a transfer starts — the question about names already taken there. -->
<CopyToDialog
  open={!!copyFlow.ask}
  target={copyFlow.ask?.target ?? null}
  names={copyFlow.ask?.request.entries.map((e) => e.name) ?? []}
  bind:dir={copyFlow.dir}
  throughApp={!!copyFlow.ask && !copyFlow.ask.request.local && !copyFlow.ask.target.local}
  onconfirm={copyFlow.confirm}
  oncancel={copyFlow.cancel}
/>
<ReplaceDialog />
<LinkOpenDialog />
<FileLinkDialog ask={fileLinks.ask} onanswer={fileLinks.answer} />

<QuitDialog
  open={showQuit}
  kind={quitForUpdate ? "update" : isMainWindow ? "quit" : "window"}
  rows={showQuit ? closeRowsNow() : []}
  onconfirm={() => {
    if (quitForUpdate) { void confirmUpdate(); return; }
    if (isMainWindow) {
      void quitApp();
      return;
    }
    // This window's sessions end with it: its tabs are not to come back.
    forgetSavedTabs();
    void closeWindow();
  }}
  oncancel={() => (showQuit = false)}
/>

<!-- Drag-and-drop move confirmation (server or folder → folder / root) -->
<ConfirmDialog
  open={!!pendingMove}
  title={t("page.moveTitle")}
  confirmLabel={t("page.moveConfirm")}
  danger={false}
  onconfirm={confirmMove}
  oncancel={() => (pendingMove = null)}
>
  {#if pendingMove && pendingMoveKeys}
    {t(pendingMoveKeys.subject)} <span class="text-text">{pendingMove.label}</span>
    {t(pendingMoveKeys.dest)}
    {#if pendingMove.target}<span class="text-text">{pendingMove.target}</span>.{/if}
  {/if}
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
  {t("page.deleteServerBody1")} <span class="text-text">{serverToDelete?.alias}</span> {t("page.deleteServerBody2")}
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
    await recFlow.ensureGroupRecording();
    doBroadcast(pb.frame, pb.targets, pb.cmd);
  }}
  oncancel={() => (pendingBroadcast = null)}
>
  {t("broadcast.prodConfirmBody1")}
  <span class="text-text">{pendingBroadcast?.targets.length ?? 0}</span>
  {t("broadcast.prodConfirmBody2")}
  <span class="text-danger">{pendingProdAliases.join(", ")}</span>
  <pre
    class="mt-2 overflow-x-auto rounded border border-edge bg-panel p-2 text-meta leading-relaxed text-muted"
  >{pendingBroadcast ? pendingBroadcast.frame.replace(/\n$/, "") : ""}</pre>
</ConfirmDialog>

<!-- Path sync's question where it has no answer yet (v1.23) — shows the OSC 7
     setup command whenever the answer lets the app type it -->
<PathSyncDialog ask={pathSync.ask} onanswer={pathSync.answer} oncancel={pathSync.cancel} />

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
  {t("page.closeTabBody1")} <span class="text-text">{closeConfirmTab ? tabAlias(closeConfirmTab) : ""}</span>
  {t("page.closeTabBody2")}
  {#if closeConfirmUnsaved > 0}
    <span class="mt-1 block text-meta text-warn" data-testid="close-tab-unsaved">
      {t("page.closeTabUnsaved", { n: closeConfirmUnsaved })}
    </span>
  {/if}
</ConfirmDialog>

<!-- Tab-bar right-click menu -->
<ContextMenu menu={tabCtxMenu} onclose={() => (tabCtxMenu = null)} />

<!-- Save / Don't save / Cancel when closing an edited file -->
<UnsavedCloseDialog
  open={!!editors.closeAsk}
  name={editors.closeAsk?.doc.name ?? ""}
  canSave={!editors.closeAsk?.doc.readOnly}
  onsave={() => void editors.saveAndClose()}
  ondiscard={() => editors.discardAndClose()}
  oncancel={() => editors.cancelClose()}
/>

<!-- Sudo prompt: reopen (or re-save) a permission-denied file as root -->
<Modal open={!!editors.sudo} title={sudoPromptTitle} onclose={() => editors.cancelSudo()}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void editors.confirmSudo();
    }}
  >
    <p class="mb-2 break-all text-xs text-muted">{sudoPromptPath}</p>
    <PasswordInput
      testid="sudo-password"
      autofocus
      placeholder={t("editor.sudoPassword")}
      bind:value={editors.sudoPassword}
    />
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
        onclick={() => editors.cancelSudo()}>{t("common.cancel")}</button
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
  open={!!editors.diffSave}
  title={editors.diffSave ? t("editor.diffSaveTitle", { name: editors.diffSave.doc.name }) : ""}
  original={editors.diffSave?.doc.baseContent ?? ""}
  modified={editors.diffSave?.doc.content ?? ""}
  originalLabel={t("editor.serverVersion")}
  modifiedLabel={t("editor.yourVersion")}
  onclose={() => editors.cancelDiffSave()}
>
  <button
    class="rounded px-3 py-1 text-sm text-muted hover:text-text"
    onclick={() => editors.cancelDiffSave()}>{t("common.cancel")}</button
  >
  <button
    class="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-500"
    onclick={() => editors.confirmDiffSave()}>{t("editor.save")}</button
  >
</DiffModal>

<!-- Conflict: the file changed on the server since it was opened -->
<DiffModal
  open={!!editors.conflict}
  title={editors.conflict ? t("editor.conflictTitle", { name: editors.conflict.doc.name }) : ""}
  original={editors.conflict?.serverText ?? ""}
  modified={editors.conflict?.doc.content ?? ""}
  originalLabel={t("editor.serverNow")}
  modifiedLabel={t("editor.yourVersion")}
  onclose={() => editors.cancelConflict()}
>
  <button
    class="rounded px-3 py-1 text-sm text-muted hover:text-text"
    onclick={() => editors.cancelConflict()}>{t("common.cancel")}</button
  >
  <button
    class="rounded bg-edge px-3 py-1 text-sm hover:bg-accent hover:text-panel-alt"
    onclick={() => editors.reopenConflict()}>{t("editor.reopen")}</button
  >
  <button
    class="rounded bg-danger px-3 py-1 text-sm text-panel-alt hover:opacity-90"
    onclick={() => editors.overwriteConflict()}>{t("editor.overwrite")}</button
  >
</DiffModal>

<!-- Name/describe (or discard) a recording right after stopping it -->
<RecordingSaveDialog
  open={recFlow.saveRec !== null}
  heading={t("recordings.saveTitle")}
  defaultTitle={recFlow.saveRec?.defaultTitle ?? ""}
  onsave={recFlow.saveRecording}
  ondelete={recFlow.discardRecording}
  onclose={recFlow.closeSavePrompt}
/>

<!-- Name (or discard) a just-stopped broadcast bundle. -->
<RecordingSaveDialog
  open={recFlow.saveBatch !== null}
  heading={t("recordings.saveBroadcastTitle")}
  onsave={(title) => recFlow.saveBatchName(title)}
  ondelete={recFlow.discardBatch}
  onclose={recFlow.closeBatchPrompt}
/>

<!-- Password / passphrase prompt (owns its own state; Phase 18.4.4) -->
<SecretPrompt bind:this={secretPrompt} />

<!-- The server's own login questions (keyboard-interactive) for a tab on screen —
     the one in focus first; a background tab's wait until the user switches to it. -->
{#if authSession && authPrompts[authSession]}
  {@const sid = authSession}
  <AuthPromptDialog
    sessionId={sid}
    request={authPrompts[sid]}
    ondone={() => clearAuthPrompt(sid)}
  />
{/if}

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
