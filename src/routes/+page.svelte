<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { tooltip } from "$lib/actions/tooltip";
  import { fade } from "svelte/transition";
  import { motion } from "$lib/motion";
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
    sftpReadText,
    sftpWriteText,
    isBackupFailedError,
    isFileChangedError,
    isPermissionError,
    readLocalText,
    writeLocalText,
    localCwd,
    takePendingOpens,
    pickOpenFile,
    writeToTerminal,
    serverToolsStatus,
    nginxConfigFiles,
    takeStoreWarnings,
    OPEN_FILE_EVENT,
    disconnect,
    listenHere,
    closeWindow,
    reportWindowSummary,
    otherWindowsSummary,
    broadcastSettings,
    announceServersDeleted,
    detachBegin,
    detachAbort,
    detachCommit,
    takeHandoff,
    declineHandoff,
    announceWindow,
    dragOver,
    dragDrop,
    dragEnd,
    CATALOG_EVENT,
    DRAG_EVENT,
    HANDOFF_EVENT,
    SERVERS_DELETED_EVENT,
    SETTINGS_EVENT,
    WINDOW_CLOSE_EVENT,
    WINDOWS_EVENT,
    type ServersDeleted,
    type SettingsBroadcast,
  } from "$lib/api";
  import {
    isMainWindow,
    otherWindows,
    windowLabel,
    windowTarget,
    type WindowEntry,
  } from "$lib/appwindow";
  import {
    DETACH_BLOCK_MESSAGE,
    WINDOW_ROWS,
    detachBlocker,
    detachErrorKey,
    detachOffered,
    ghostPlace,
    moveOffered,
    parsePacket,
    type DetachState,
    type TermSnapshot,
  } from "$lib/tabhandoff";
  import { packTab, unpackTab } from "$lib/stores/tabpacket";
  import { chatBusy } from "$lib/aiask";
  import type { ServerProfile } from "$lib/types";
  import { storeWarningMessage } from "$lib/storewarn";
  import { sessionBarParts, showSessionBar } from "$lib/sessionbar";
  import ViewModeToggle from "$lib/ViewModeToggle.svelte";
  import { moveConfirmKeys, nameOf, serversInSubtree, type MoveRequest } from "$lib/tree";
  import {
    isPanelHidden,
    layout,
    movePanel,
    resetPanelLayout,
    revealPanel,
    setDockCollapsed,
    setPanelHidden,
    toggleDock,
  } from "$lib/stores/layout.svelte";
  import { dockOf, isPanelShown, PANEL_IDS, type PanelId } from "$lib/docklayout";
  import { glide } from "$lib/actions/drag";
  import { moveLabel, moveTargets, panelLabel } from "$lib/dockui";
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
    type NewTabAction,
    type Tab,
  } from "$lib/stores/tabs.svelte";
  import {
    canSplit,
    layoutRects,
    neighbourPane,
    orderedTabs,
    paneOf,
    panes,
    previewFlat,
    previewIncoming,
    previewIncomingFlat,
    previewTabs,
    shownTabs,
    type Edge,
    type Pane,
  } from "$lib/splitlayout";
  import {
    onScreenSessions,
    pendingAuthSession,
    recordingPauses,
    rectStyle,
  } from "$lib/centerview";
  import {
    beginTabDrag,
    consumeTabDragClick,
    onTabDraggedOutside,
    tabDrag,
    type ScreenPoint,
  } from "$lib/stores/tabdrag.svelte";
  import {
    INCOMING_TAB,
    applyDragMessage,
    describeTab,
    incoming,
    incomingAsTab,
    parseDragMessage,
    takeIncomingDrop,
  } from "$lib/stores/tabincoming.svelte";
  import SplitDivider from "$lib/SplitDivider.svelte";
  import { handleClipboardShortcut } from "$lib/actions/clipboardKeys";
  import TerminalView from "$lib/Terminal.svelte";
  import ConnectingOverlay from "$lib/ConnectingOverlay.svelte";
  import type { ConnPhase } from "$lib/connphase";
  import { sshErrorView } from "$lib/ssherror";
  import { showNoSignal } from "$lib/connlost";
  import Dock from "$lib/Dock.svelte";
  import DockPanel from "$lib/DockPanel.svelte";
  import DockDragGhost from "$lib/DockDragGhost.svelte";
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
  import { removeChat, getChat, askAbout, peekChat } from "$lib/stores/aichat.svelte";
  import { peekDockState, removeDockState, setDockCwd } from "$lib/stores/dockstate.svelte";
  import { followUpdates, pollsLocalCwd } from "$lib/followcwd";
  import { aiReady } from "$lib/ai";
  import SettingsPanel from "$lib/SettingsPanel.svelte";
  import UtilitiesPanel from "$lib/UtilitiesPanel.svelte";
  import ServerFormModal from "$lib/ServerFormModal.svelte";
  import NotesModal from "$lib/NotesModal.svelte";
  import { hasNotes, notesTarget } from "$lib/notes";
  import FolderModals from "$lib/FolderModals.svelte";
  import SecretPrompt from "$lib/SecretPrompt.svelte";
  import AuthPromptDialog from "$lib/AuthPromptDialog.svelte";
  import { authPrompts, clearAuthPrompt, setAuthPrompt } from "$lib/stores/authprompt.svelte";
  import HelpPanel from "$lib/HelpPanel.svelte";
  import ThemeOverlay from "$lib/ThemeOverlay.svelte";
  import IdleOverlay from "$lib/IdleOverlay.svelte";
  import StatusBar from "$lib/StatusBar.svelte";
  import MonitoringOverlay from "$lib/MonitoringOverlay.svelte";
  import TopBar from "$lib/TopBar.svelte";
  import TitleBar from "$lib/TitleBar.svelte";
  import { hostEnv } from "$lib/stores/hostenv.svelte";
  import ServerTree from "$lib/ServerTree.svelte";
  import Modal from "$lib/Modal.svelte";
  import PasswordInput from "$lib/PasswordInput.svelte";
  import ConfirmDialog from "$lib/ConfirmDialog.svelte";
  import UnsavedCloseDialog from "$lib/UnsavedCloseDialog.svelte";
  import { activeTabStrip } from "$lib/tabstrip";
  import QuitDialog from "$lib/QuitDialog.svelte";
  import { mergeQuitRows, quitRows, type QuitRow } from "$lib/quitsummary";
  import ContextMenu from "$lib/ContextMenu.svelte";
  import type { MenuAction, MenuItem, OpenMenu } from "$lib/ctxmenu";
  import { needsShellSetup, OSC7_SETUP, osc7SetupDisplay } from "$lib/shellintegration";
  import { cdCommand, type CdShell } from "$lib/cdterminal";
  import { renderArgv, renderSessionCommand } from "$lib/termcmd";
  import { attachIcon, attachRows, attachTitle, type AttachTarget } from "$lib/tabattach";
  import { submitLine } from "$lib/terminput";
  import {
    isNewTabChord,
    isPaletteChord,
    isSplitDownChord,
    isSplitRightChord,
    paneStepChord,
  } from "$lib/appshortcuts";
  import Icon from "$lib/Icon.svelte";
  import Toast from "$lib/Toast.svelte";
  import EmptyState from "$lib/EmptyState.svelte";
  import CommandPalette from "$lib/CommandPalette.svelte";
  import RecordingsPanel from "$lib/RecordingsPanel.svelte";
  import type { CommandItem } from "$lib/command";
  import { notifyError, notifySuccess, notifyInfo } from "$lib/stores/toasts.svelte";
  import { applyProgress, sessionTransfers, transfersState } from "$lib/stores/transfers.svelte";
  import { applySyncProgress } from "$lib/stores/syncrun.svelte";
  import { applyScanProgress, isBusy, peekSyncJob, removeSyncJob } from "$lib/stores/syncjob.svelte";
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
  import { activeChromePanel, applyImportedSettings, settings } from "$lib/settings.svelte";
  import { t } from "$lib/i18n";
  import {
    setMenuLanguage,
    armCloseGuard,
    quitApp,
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
  import type { PromptVars } from "$lib/aicore";
  import { isProdServer } from "$lib/aiexec";
  import type { ProbeSession } from "$lib/probe";
  import { getVersion } from "@tauri-apps/api/app";
  import RecordingSaveDialog from "$lib/RecordingSaveDialog.svelte";
  import { dockConnection, localizedStatus } from "$lib/stores/tabs.svelte";
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
    });
  }
  let helpTab = $state<"help" | "about" | "manual">("help");
  // Custom window chrome replaces the OS title bar + menu on Windows/Linux; macOS
  // keeps its native decorations, so the TitleBar is never mounted there. Empty
  // `os` (pre-resolve) also renders nothing, so macOS never flashes a custom bar.
  const showWindowChrome = $derived(hostEnv.os !== "" && hostEnv.os !== "macos");
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
      find?: () => void;
      focus?: () => void;
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

  // Current SSH connection phase per session, driving the connecting overlay.
  const connPhase = $state<Record<string, ConnPhase>>({});
  // Latest terminal cwd (OSC 7) per session, and whether the file panel should
  // follow it — both **per tab** (each session keeps its own toggle).
  const terminalCwd = $state<Record<string, string>>({});
  const followTerminal = $state<Record<string, boolean>>({});
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
  // Sessions where we've already typed the OSC 7 shell-integration snippet, and the
  // session awaiting the user's confirmation before we type it.
  const shellIntegrated = $state<Record<string, boolean>>({});
  let pendingFollowSession = $state<string | null>(null);

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
  // Every tab in strip order, pane by pane — "tab order" for whatever lists tabs
  // in a row (the broadcast grid, the single strip).
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
    orderedTabList.filter((tab) => isBroadcastMember(tab.sessionId)),
  );
  // Live members that would actually receive a sent command.
  const bcTargets = $derived(eligibleMembers(broadcastState.members, orderedTabList));
  const bcLayout = $derived(effectiveLayout(bcTargets.length));
  // The focused member (focus layout) is simply the active tab.
  const bcFocusId = $derived(tabsState.activeId);
  const bcHasProd = $derived(groupHasProd(bcTargets, tabsState.list, servers));
  // Every open SSH tab whose server is production — its tab gets a red top strip
  // + `prod` chip and its terminal a red frame (grid tiles: a red border), so
  // "am I typing into prod" is answered wherever the eye is.
  const prodTabIds = $derived(
    new Set(prodMembers(tabsState.list.map((tab) => tab.sessionId), tabsState.list, servers)),
  );
  const bcCols = $derived(gridColumns(bcAreaWidth || 1200, bcMemberTabs.length));
  // Roster rows (focus layout): the full group, including the focused member
  // (marked `active`), so the whole list stays visible in the sidebar.
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
        active: tab.sessionId === bcFocusId,
      };
    }),
  );

  // Height of the centre area (its width is `bcAreaWidth`, measured for the grid too).
  let areaHeight = $state(0);
  const areaBounds = $derived({ width: bcAreaWidth, height: areaHeight });
  const placement = $derived(layoutRects(center.root, areaBounds));
  // Each pane carries its own tab strip only while there is more than one pane.
  // Unsplit — and in broadcast mode, which lays the members out itself — there is
  // a single strip above the area, exactly as before splits existed.
  const paneStrips = $derived(isSplit && !bcOn);
  const stripInset = $derived(paneStrips ? tabBarHeight : 0);
  // The sessions whose terminals are on screen: one per pane, or the broadcast
  // view's own set. A recording runs only while its tab is on screen, a server's
  // login question waits until its tab is, and the docks keep the panels of
  // these sessions mounted so that moving the focus between panes is cheap.
  const onScreenIds = $derived(
    new Set(
      onScreenSessions({
        shown: [...shownIds],
        active: tabsState.activeId,
        broadcast: bcOn,
        grid: bcLayout === "grid",
        members: bcMemberTabs.map((tab) => tab.sessionId),
      }),
    ),
  );
  const dockSessions = $derived([...shownIds]);
  // Whose panel the docks show — said only while there are panes to tell apart.
  const dockCaption = $derived(paneStrips && activeTab ? tabTitle(activeTab) : null);
  const authSession = $derived(
    pendingAuthSession([...onScreenIds], tabsState.activeId, (id) => !!authPrompts[id]),
  );

  /** Give a pane the focus and put the keyboard in the terminal it shows. */
  function focusPaneAndTerminal(pane: Pane) {
    focusPane(pane.id);
    if (pane.active) termRefs[pane.active]?.focus?.();
  }

  /** Whether the focused pane can be split at `edge`: it holds a tab and has the room. */
  const canSplitFocused = (edge: Edge): boolean =>
    !bcOn && activeTab !== null && canSplit(placement.panes[center.focus], edge);

  /**
   * A new terminal in a new pane at `edge` of the focused one: the tab ⌘T would
   * open, split off the moment it exists — so there is never an empty pane on
   * screen, and a cancelled password prompt changes nothing.
   */
  function splitWithNewTerminal(edge: Edge) {
    if (!canSplitFocused(edge)) {
      if (activeTab && !bcOn) notifyInfo(t("split.noRoom"));
      return;
    }
    const anchor = center.focus;
    openNewTab(newTabAction(activeTab), (sid) => splitTabOff(sid, anchor, edge));
  }

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
    const live = new Set(eligibleMembers(broadcastState.members, orderedTabList));
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
      handleTerminalActivity(id);
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
    await toggleRecordingFor(tab);
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
  // One idle countdown per recording that is on screen.
  const recordIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // The on-screen recordings already resumed — guards against clobbering an idle
  // pause when the effect re-runs for an unrelated reason.
  let resumedTabs = new Set<string>();

  function clearRecordIdleTimer(sessionId: string) {
    clearTimeout(recordIdleTimers.get(sessionId));
    recordIdleTimers.delete(sessionId);
  }

  /** Pause/resume a recording: update the tab indicator + tell the backend (only on change). */
  function applyPause(sessionId: string, paused: boolean) {
    if (isRecordingPaused(sessionId) === paused) return;
    setRecordingPausedState(sessionId, paused);
    setRecordingPaused(sessionId, paused).catch(() => {});
  }

  /** (Re)arm the idle countdown that pauses a recording tab on screen. */
  function armRecordIdleTimer(sessionId: string) {
    clearRecordIdleTimer(sessionId);
    const secs = settings.recordIdlePauseSecs;
    if (secs <= 0 || !isRecording(sessionId)) return;
    recordIdleTimers.set(
      sessionId,
      setTimeout(() => applyPause(sessionId, true), secs * 1000),
    );
  }

  /** Keystroke in a terminal on screen → resume (if idle-paused) and re-arm its idle timer. */
  function handleTerminalActivity(sessionId: string) {
    if (!onScreenIds.has(sessionId) || !isRecording(sessionId)) return;
    applyPause(sessionId, false); // backend also auto-resumes on input
    armRecordIdleTimer(sessionId);
  }

  // A recording runs only while its tab is on screen — one tab per pane, every
  // member of the broadcast grid (centerview.ts). The others are paused; a tab
  // that comes back on screen resumes with a fresh idle countdown.
  $effect(() => {
    const { pause, watch } = recordingPauses(Object.keys(recordingState), [...onScreenIds]);
    for (const id of pause) applyPause(id, true);
    for (const id of watch) {
      if (resumedTabs.has(id)) continue;
      applyPause(id, false);
      armRecordIdleTimer(id);
    }
    for (const id of [...recordIdleTimers.keys()]) {
      if (!watch.includes(id)) clearRecordIdleTimer(id);
    }
    resumedTabs = new Set(watch);
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
  const PANE_KEYWORDS =
    "split pane terminal side by side layout сплит разделить область рядом терминал раскладка";
  const paneCommands = $derived.by((): CommandItem[] => {
    if (bcOn) return [];
    const group = t("palette.groupActions");
    const out: CommandItem[] = [];
    const add = (id: string, title: string, icon: CommandItem["icon"], run: () => void) =>
      out.push({ id, title, icon, group, keywords: PANE_KEYWORDS, run });
    const tab = activeTab;
    const pane = tab ? paneOf(center, tab.sessionId) : null;
    if (canSplitFocused("right")) {
      add("pane:new-right", t("palette.splitRight"), "splitRight", () => splitWithNewTerminal("right"));
    }
    if (canSplitFocused("bottom")) {
      add("pane:new-down", t("palette.splitDown"), "splitDown", () => splitWithNewTerminal("bottom"));
    }
    if (tab && pane && pane.tabs.length > 1) {
      if (canSplitFocused("right")) {
        add("pane:tab-right", t("palette.moveTabRight"), "splitRight", () =>
          splitTabOff(tab.sessionId, pane.id, "right"),
        );
      }
      if (canSplitFocused("bottom")) {
        add("pane:tab-down", t("palette.moveTabDown"), "splitDown", () =>
          splitTabOff(tab.sessionId, pane.id, "bottom"),
        );
      }
    }
    if (isSplit) {
      if (tab && pane) {
        add("pane:tab-next", t("palette.moveTabNextPane"), "arrowRight", () =>
          moveTabTo(tab.sessionId, neighbourPane(center, pane.id, 1).id),
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
    if (tab && tab.status.startsWith("Connected")) {
      // Another window that is already open — the main one first: the way back.
      for (const w of windowTargets) {
        out.push({
          id: `window:move:${w.label}`,
          title: t("palette.moveTabTo", { target: windowTargetName(w) }),
          icon: "popOut",
          group,
          keywords: "window move return back main окно перенести вернуть обратно главное другое",
          run: () => void detachTab(tab.sessionId, { window: w.label }),
        });
      }
      if (canOfferDetach) {
        out.push({
          id: "window:detach",
          title: t("palette.moveTabToWindow"),
          icon: "popOut",
          group,
          keywords: "window detach pop out tear off monitor окно отдельное вынести второй монитор",
          run: () => void detachTab(tab.sessionId),
        });
      }
    }
    return out;
  });

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
    if (e.defaultPrevented || bcOn) return;
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
    refresh();
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
      listen<unknown>(WINDOWS_EVENT, (e) => {
        appWindows = otherWindows(e.payload, windowLabel);
      }),
      // A tab of another window held over this one: it is drawn here.
      listenHere<unknown>(DRAG_EVENT, (e) => {
        const msg = parseDragMessage(e.payload);
        if (msg) applyDragMessage(msg);
      }),
      listenHere(HANDOFF_EVENT, () => void receiveTab()),
    ])
      .then((us) => {
        unlisteners.push(...us);
        takesTabs = true;
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
      void adoptHandoff();
    }
    // Global Cmd/Ctrl + V/C/X/A for every text input (capture phase, so it works
    // even inside modals and before any field-local handler). See clipboardKeys.ts.
    document.addEventListener("keydown", handleClipboardShortcut, true);
    return () => {
      unlisteners.forEach((u) => u());
      onTabDraggedOutside(null);
      document.removeEventListener("keydown", handleClipboardShortcut, true);
    };
  });

  // ── Windows (ADR 0017) ─────────────────────────────────────────────────────
  // The question this window is asked before it goes: the main one about
  // quitting the app, any other one about closing itself.
  const CLOSE_ASKED_EVENT = isMainWindow ? "menu://quit" : WINDOW_CLOSE_EVENT;

  /** Open the close confirmation with what would be cut off. */
  async function askToClose() {
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

  /** The tab being handed to a new window; the page takes no input meanwhile. */
  let detaching = $state<string | null>(null);
  // The window's size — where the label of a tab dragged out of it is pinned.
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);

  function detachStateOf(tab: Tab): DetachState {
    const sid = tab.sessionId;
    const ws = getWorkspace(sid);
    const chat = peekChat(sid);
    return {
      mainWindow: isMainWindow,
      tabs: tabsState.list.length,
      broadcast: bcOn,
      connected: tab.status.startsWith("Connected"),
      syncBusy: isBusy(peekSyncJob(sid)),
      // Running transfers, and upload batches between two of their files.
      transfers: sessionTransfers(sid) + Object.keys(peekDockState(sid)?.uploads ?? {}).length,
      chatBusy: !!chat && chatBusy(chat),
      editorBusy: ws.editors.some((ed) => ed.loading || ed.id === savingEditorId),
    };
  }

  /** Whether "move to a new window" is offered for tabs here at all. */
  const canOfferDetach = $derived(
    detachOffered({ mainWindow: isMainWindow, tabs: tabsState.list.length, broadcast: bcOn }),
  );

  // ── Tabs between open windows (ADR 0018) ───────────────────────────────────
  // The app's other windows that take tabs, as the backend lists them.
  let appWindows = $state<WindowEntry[]>([]);
  // This window listens for the offer of a tab (set in onMount, never unset).
  let takesTabs = $state(false);
  /** The windows a tab of this one can be moved to right now. */
  const windowTargets = $derived(
    moveOffered({ broadcast: bcOn }, appWindows.length) ? appWindows : [],
  );
  const windowTargetName = (w: WindowEntry): string => {
    const name = windowTarget(w);
    return t(name.key, name.params);
  };
  // What the other windows show of this one: the tab its focused pane shows and
  // how many it has. Told again as either changes — and only then: both are
  // plain values, so a tab merely changing its status tells nobody anything.
  const windowTitle = $derived(activeTab ? tabTitle(activeTab) : "");
  const windowTabs = $derived(tabsState.list.length);
  $effect(() => {
    if (!takesTabs) return;
    void announceWindow(windowTitle, windowTabs).catch(() => {});
  });

  // A tab dragged outside the window moves to another one — the third way in,
  // next to the tab menu and the palette: onto a window of the app, into it;
  // anywhere else, into a window of its own. Where neither is offered, leaving
  // the window with a tab is not a drop target at all. While it is held over
  // another window, that window draws it: this one only says where it is.
  $effect(() => {
    const offered = canOfferDetach || windowTargets.length > 0;
    const toWindows = windowTargets.length > 0;
    onTabDraggedOutside(
      offered
        ? {
            release: (sessionId, at) => void dropOutside(sessionId, at),
            over: toWindows ? tellDragOver : undefined,
            left: toWindows ? () => void dragEnd().catch(() => {}) : undefined,
          }
        : null,
    );
  });
  /** The tab in the air is over another window of the app, which draws it. */
  const heldOverWindow = $derived(windowTargets.some((w) => w.label === tabDrag.window));
  // The edge of a pane a drop would make a new pane at: of a tab of this
  // window, or of one held over it from another.
  const dropZone = $derived(tabDrag.zone ?? incoming.zone);

  /**
   * A tab of this window is held outside it: say so, and learn which window of
   * the app it is over. A tab that cannot go anywhere right now is shown to
   * nobody — letting go of it says why.
   */
  async function tellDragOver(sessionId: string): Promise<string | null> {
    const tab = findTab(sessionId);
    if (!tab || detachBlocker(detachStateOf(tab), true)) return null;
    return dragOver(describeTab(tab));
  }

  /** A tab was let go of outside this window, at `at` on the screen. */
  async function dropOutside(sessionId: string, at: ScreenPoint) {
    const tab = findTab(sessionId);
    if (!tab) return;
    // What keeps a tab from every other window keeps it here: said now.
    const block = detachBlocker(detachStateOf(tab), true);
    if (block) {
      void dragEnd().catch(() => {});
      notifyInfo(t(DETACH_BLOCK_MESSAGE[block]));
      return;
    }
    // Asked now, not taken from where the tab was last drawn: the release is
    // the gesture. The window it was dropped on keeps its place from here on.
    const under = windowTargets.length > 0 ? await dragDrop(describeTab(tab)).catch(() => null) : null;
    if (under && windowTargets.some((w) => w.label === under)) {
      // If the tab does not get there after all, that window is told.
      if (!(await detachTab(sessionId, { window: under }))) void dragEnd().catch(() => {});
      return;
    }
    if (under) void dragEnd().catch(() => {});
    if (canOfferDetach) void detachTab(sessionId, { at });
  }

  /**
   * Move a tab to another window: the open one `to.window`, or — without it — a
   * new one, opened at `to.at` when the tab was dropped there (the menu and the
   * palette give no place).
   *
   * The session's output is held first, so the terminal's snapshot is exact;
   * the tab leaves this window only once the other has taken it over. Until
   * then any failure leaves everything as it was. Resolves true when it went.
   */
  async function detachTab(
    sessionId: string,
    to: { window?: string; at?: ScreenPoint } = {},
  ): Promise<boolean> {
    const tab = findTab(sessionId);
    if (!tab || detaching) return false;
    const toOpenWindow = to.window !== undefined;
    const block = detachBlocker(detachStateOf(tab), toOpenWindow);
    if (block) {
      notifyInfo(t(DETACH_BLOCK_MESSAGE[block]));
      return false;
    }
    detaching = sessionId;
    let held = false;
    try {
      const sent = await detachBegin(sessionId);
      held = true;
      const terminal = (await termRefs[sessionId]?.snapshot?.(sent)) ?? null;
      const packet =
        terminal &&
        packTab(sessionId, terminal, {
          terminalCwd: terminalCwd[sessionId] ?? null,
          followTerminal: followTerminal[sessionId] ?? false,
          followSeen: followSeen[sessionId] ?? null,
          localShell: localShellKind[sessionId] ?? null,
          shellIntegrated: shellIntegrated[sessionId] ?? false,
        });
      if (!packet) throw new Error("handoff-failed: no snapshot");
      await detachCommit(sessionId, packet, {
        ...to.at,
        target: to.window,
        background: activeChromePanel(),
      });
      held = false;
      // The other window owns the session now: drop the tab here, keep the
      // session. (A secondary window left with no tab closes behind it.)
      closeTabFully(sessionId, true);
      return true;
    } catch (e) {
      // Give the held output back (a no-op if the backend already rolled back).
      if (held) await detachAbort(sessionId).catch(() => {});
      notifyError(t(detachErrorKey(e, toOpenWindow)));
      return false;
    } finally {
      detaching = null;
    }
  }

  /** A secondary window, on load: take over the tab it was opened for. */
  async function adoptHandoff() {
    // Nothing to show (the handoff was rolled back): a window with no tab goes.
    if (!(await takeTab())) void closeWindow().catch(() => {});
  }

  /**
   * A window that is already open, offered a tab: take it — or say at once that
   * it cannot, so the window giving the tab up is not left to its timeout.
   * Nothing here closes this window: it has tabs of its own.
   */
  async function receiveTab() {
    if (!(await takeTab())) void declineHandoff().catch(() => {});
  }

  /**
   * A tab this window was taking did not arrive: it stays with the window that
   * was giving it up, which is told so now. This window's copy of its state
   * goes without ending the session — it was never ours.
   */
  function adoptFailed(sessionId: string) {
    void declineHandoff(sessionId).catch(() => {});
    closeTabFully(sessionId, true);
    // A window opened for this tab has nothing else to show and goes. One that
    // was already open keeps its tabs — closing it would end their sessions.
    if (!isMainWindow && tabsState.list.length === 0) void closeWindow().catch(() => {});
  }

  /**
   * Put the tab being handed to this window into its stores; false when there
   * is none to take. Its terminal then replays the snapshot and takes the
   * session over (`Terminal.svelte`, `adopt`).
   */
  async function takeTab(): Promise<boolean> {
    const packet = parsePacket(await takeHandoff().catch(() => null));
    if (!packet) return false;
    const sid = packet.tab.sessionId;
    const page = packet.page;
    if (page.terminalCwd) terminalCwd[sid] = page.terminalCwd;
    if (page.followTerminal) followTerminal[sid] = true;
    if (page.followSeen) followSeen[sid] = page.followSeen;
    if (page.localShell) localShellKind[sid] = page.localShell;
    if (page.shellIntegrated) shellIntegrated[sid] = true;
    // It arrives connected — a later drop of it is a real one (NO SIGNAL).
    idleWasConnected.add(sid);
    // Dropped here, it takes the place this window kept for it; sent by a
    // command, it goes where a new tab goes.
    unpackTab(packet, takeIncomingDrop());
    return true;
  }

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
    if (tab && isLive(tab.status)) closeConfirmId = sessionId;
    else closeTabFully(sessionId);
  }

  /**
   * The one way a tab goes away. A session id keys state in four places besides
   * the tab list, and closing the row alone leaks all of it — the workspace holds
   * open editors' file contents, the chat holds the conversation plus terminal
   * context, and a leftover broadcast member is a *dead* session in the send set,
   * which is a correctness bug rather than just memory.
   *
   * Every close path routes here (close button, bulk close, server deletion,
   * failed re-auth); `closeTabStore` is called nowhere else, enforced by
   * [tabteardown.guard.test.ts](../lib/tabteardown.guard.test.ts). Adding
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
    removeSyncJob(sessionId); // also stops a compare/run still going on
    // Flags only — a recording handed over with its tab keeps running; left set,
    // this window would go on pausing it as "not on screen here".
    clearRecording(sessionId);
    clearRecordIdleTimer(sessionId);
    batchRecMembers.delete(sessionId);
    delete followSeen[sessionId];
    delete followTerminal[sessionId];
    delete terminalCwd[sessionId];
    delete localShellKind[sessionId];
    delete shellIntegrated[sessionId];
    delete pendingCommand[sessionId];
    delete connPhase[sessionId];
    delete termDims[sessionId];
    idleWasConnected.delete(sessionId);
    nginxConfigCache.delete(sessionId);
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
  function closeOtherTabs(keep: string, peers: Tab[]) {
    for (const tab of peers) {
      if (tab.sessionId !== keep) closeTabFully(tab.sessionId);
    }
  }

  function closeTabsToRight(sessionId: string, peers: Tab[]) {
    const idx = peers.findIndex((t) => t.sessionId === sessionId);
    if (idx < 0) return;
    for (const tab of peers.slice(idx + 1)) closeTabFully(tab.sessionId);
  }

  function openTabMenu(e: MouseEvent, tab: Tab, peers: Tab[]) {
    e.preventDefault();
    const idx = peers.findIndex((tt) => tt.sessionId === tab.sessionId);
    const hasOthers = peers.length > 1;
    const hasRight = idx >= 0 && idx < peers.length - 1;
    const items: MenuItem[] = [
      { icon: "close", label: t("ctx.closeTab"), onSelect: () => requestCloseTab(tab.sessionId) },
      {
        icon: "close",
        label: t("ctx.closeOthers"),
        disabled: !hasOthers,
        onSelect: () => closeOtherTabs(tab.sessionId, peers),
      },
      {
        icon: "arrowRight",
        label: t("ctx.closeRight"),
        disabled: !hasRight,
        onSelect: () => closeTabsToRight(tab.sessionId, peers),
      },
    ];
    // Panes: the tab into a new one beside or below its own, or into the next
    // one — the twins of dragging it there. Not in broadcast mode, which lays
    // the terminals out itself.
    const pane = paneOf(center, tab.sessionId);
    if (pane && !bcOn) {
      const rect = placement.panes[pane.id];
      const alone = pane.tabs.length < 2;
      items.push({ kind: "separator" });
      items.push({
        icon: "splitRight",
        label: t("ctx.splitRight"),
        disabled: alone || !canSplit(rect, "right"),
        onSelect: () => splitTabOff(tab.sessionId, pane.id, "right"),
      });
      items.push({
        icon: "splitDown",
        label: t("ctx.splitDown"),
        disabled: alone || !canSplit(rect, "bottom"),
        onSelect: () => splitTabOff(tab.sessionId, pane.id, "bottom"),
      });
      if (isSplit) {
        items.push({
          icon: "arrowRight",
          label: t("ctx.moveToNextPane"),
          onSelect: () => moveTabTo(tab.sessionId, neighbourPane(center, pane.id, 1).id),
        });
      }
    }
    // Another window — the twin of dropping the tab outside this one: one that
    // is already open (the main one first — the way back), or one of its own.
    // Why the tab cannot go right now (a transfer, an answer still streaming) is
    // said when it is asked for; a tab that is not connected has no session to
    // take along.
    const connected = tab.status.startsWith("Connected");
    const toWindows: MenuAction[] = windowTargets.map((w) => ({
      icon: "popOut",
      label: windowTargetName(w),
      disabled: !connected,
      onSelect: () => void detachTab(tab.sessionId, { window: w.label }),
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
    if (canOfferDetach) {
      items.push({
        icon: "popOut",
        label: t("ctx.moveToWindow"),
        disabled: !connected,
        onSelect: () => void detachTab(tab.sessionId),
      });
    }
    if (tab.kind === "ssh") {
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
        onSelect: () => void toggleRecordingFor(tab),
      });
    }
    tabCtxMenu = { x: e.clientX, y: e.clientY, items };
  }

  // ── Config editor (Phase 12) ────────────────────────────────────────────────
  let savingEditorId = $state<string | null>(null);
  let closeEditorConfirm = $state<{ sid: string; doc: EditorDoc } | null>(null);
  // Pre-save diff confirmation (settings-gated) and conflict resolution.
  // `closeAfter`: the save came from the close-with-changes dialog — close the
  // file once the write lands (and only then: a failed save keeps it open).
  let diffSave = $state<{ sid: string; doc: EditorDoc; closeAfter?: boolean } | null>(null);
  let conflict = $state<{ sid: string; doc: EditorDoc; serverText: string } | null>(null);

  /** Configured editor open-size limit, in bytes. */
  const editorMaxBytes = () => settings.sftp.maxOpenMb * 1024 * 1024;

  // Sudo prompt: reopen a permission-denied file as root, or retry a save as root.
  let sudoPrompt = $state<
    | { kind: "open"; sid: string; path: string; name: string; gotoLine?: number }
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

  /** Open a remote file of session `sid` in the in-app editor (from its SFTP panel). */
  async function openFileInEditor(
    sid: string,
    path: string,
    name: string,
    opts: { gotoLine?: number; sudo?: boolean; sudoPassword?: string; gitBase?: string } = {},
  ) {
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
        sudoPrompt = { kind: "open", sid, path, name, gotoLine: opts.gotoLine };
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
      void openFileInEditor(p.sid, p.path, p.name, {
        gotoLine: p.gotoLine,
        sudo: true,
        sudoPassword: pw,
      });
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
  function openGitDiff(sid: string, absPath: string, gitBase: string) {
    if (findTab(sid)?.kind === "ssh") {
      void openFileInEditor(sid, absPath, absPath.split("/").pop() ?? absPath, { gitBase });
    } else {
      void openLocalFileInEditor(sid, absPath, { gitBase });
    }
  }

  /** Append a pattern to the repo's .gitignore (git panel "Ignore" action). */
  async function appendGitignore(sid: string, gitignorePath: string, pattern: string) {
    const ssh = findTab(sid)?.kind === "ssh";
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
   * Toggle "follow terminal" for a session. Turning it off is immediate.
   * Turning it on: if the shell already reports its cwd (OSC 7 seen) or we've already
   * set it up this session, just enable; otherwise open a confirm dialog before typing
   * the shell-integration snippet (session-only, nothing saved on the server).
   */
  function toggleFollowTerminal(id: string) {
    if (followTerminal[id]) {
      followTerminal[id] = false;
      return;
    }
    enablePathSync(id);
  }

  /**
   * Turn path sync on for a session — the one dock-wide switch, whether
   * it was flipped in SFTP, in Git's toolbar or by Git's "Enable path sync" button
   * (one label, one action: a file panel connected afterwards opens in the
   * terminal's folder, already following). Whether the shell still needs the OSC 7
   * snippet is pure logic — a local tab never does, since its cwd comes from the OS
   * (Phase 39.3). See needsShellSetup.
   */
  function enablePathSync(id: string) {
    if (followTerminal[id]) return;
    if (!needsShellSetup(findTab(id)?.kind, !!terminalCwd[id], !!shellIntegrated[id])) {
      followTerminal[id] = true;
      return;
    }
    pendingFollowSession = id;
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
    if (!pollsLocalCwd(findTab(id)?.kind, !!followTerminal[id], gitShown)) return;
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
    const writes = followUpdates(followTerminal, terminalCwd, followSeen);
    untrack(() => writes.forEach(([id, cwd]) => setDockCwd(id, cwd)));
  });

  /** User confirmed: type the OSC 7 setup into the shell and enable following. */
  function confirmFollowSetup() {
    const id = pendingFollowSession;
    pendingFollowSession = null;
    if (!id) return;
    writeToTerminal(id, new TextEncoder().encode(submitLine(OSC7_SETUP))).catch(() => {});
    shellIntegrated[id] = true;
    followTerminal[id] = true;
  }

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
    setActiveView(sid, TERMINAL_VIEW);
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

  /**
   * Actually write to the server. `expectedSha` null = force overwrite (conflict).
   * Resolves `true` only when the file was written.
   */
  async function doWriteEditor(
    sid: string,
    doc: EditorDoc,
    expectedSha: string | null,
  ): Promise<boolean> {
    if (savingEditorId) return false;
    savingEditorId = doc.id;
    try {
      const before = doc.baseContent;
      const res =
        doc.source === "local"
          ? await writeLocalText(doc.path, doc.content, doc.eol, expectedSha, doc.encoding)
          : await sftpWriteText(sid, doc.path, doc.content, doc.eol, expectedSha, {
              sudo: doc.sudo,
              sudoPassword: doc.sudoPassword,
              backup: settings.editor.backupOnSave,
              // Write the file back in the encoding it was opened in (textenc.rs).
              encoding: doc.encoding,
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
      return true;
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
        // Deliberately ahead of the backup check: when it is the `.bak` copy that
        // was refused for want of access, saving as root is the actual remedy
        // (the sudo path makes the copy with `cp -p`), so keep that route open.
        sudoPasswordInput = "";
        sudoPrompt = { kind: "save", sid, doc };
      } else if (isBackupFailedError(e)) {
        // The save was abandoned with the file untouched — say that plainly, or
        // the user reads it as "save failed" and cannot tell what state the
        // server is in. The cause is carried along; the way out is in the hint.
        notifyError(t("editor.backupFailed", { name: doc.name, detail: String(e) }));
      } else {
        notifyError(String(e));
      }
      return false;
    } finally {
      savingEditorId = null;
    }
  }

  async function confirmDiffSave() {
    const s = diffSave;
    diffSave = null;
    if (!s) return;
    const ok = await doWriteEditor(s.sid, s.doc, s.doc.baseSha256);
    if (ok && s.closeAfter) closeEditorStore(s.sid, s.doc.id);
  }

  /** "Save" in the close-with-changes dialog: write, then close on success. */
  async function saveAndCloseEditor() {
    const c = closeEditorConfirm;
    closeEditorConfirm = null;
    if (!c) return;
    if (settings.editor.diffBeforeSave) {
      diffSave = { sid: c.sid, doc: c.doc, closeAfter: true };
      return;
    }
    if (await doWriteEditor(c.sid, c.doc, c.doc.baseSha256)) closeEditorStore(c.sid, c.doc.id);
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
      void openFileInEditor(c.sid, c.doc.path, c.doc.name, {
        sudo: c.doc.sudo,
        sudoPassword: c.doc.sudoPassword,
      });
  }

  /** Close an editor sub-tab, confirming first when it has unsaved changes. */
  function requestCloseEditor(sid: string, doc: EditorDoc) {
    if (isDirty(doc)) closeEditorConfirm = { sid, doc };
    else closeEditorStore(sid, doc.id);
  }

  // Roving keyboard navigation across the tabs of one strip (a11y): arrows/Home/End
  // move focus and selection; Enter/Space activate the focused tab.
  function onTabKey(event: KeyboardEvent, sessionId: string, peers: Tab[]) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateTab(sessionId);
      return;
    }
    const i = peers.findIndex((t) => t.sessionId === sessionId);
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
        followTerminal={followTerminal[tab.sessionId] ?? false}
        onToggleFollowTerminal={() => toggleFollowTerminal(tab.sessionId)}
        onEnablePathSync={needsShellSetup(
          tab.kind,
          !!terminalCwd[tab.sessionId],
          !!shellIntegrated[tab.sessionId],
        )
          ? () => enablePathSync(tab.sessionId)
          : undefined}
        getAiContext={() => gatherAiContext(tab.sessionId)}
        aiSelectionLines={termSelection[tab.sessionId] ?? 0}
        aiRecording={!!recordingState[tab.sessionId]}
        aiProd={isProdServer(srv)}
        aiNoAi={srv?.noAi === true}
        onOpenFile={(path, name, gotoLine) =>
          openFileInEditor(tab.sessionId, path, name, { gotoLine })}
        onOpenLocalFile={(path) => openLocalFileInEditor(tab.sessionId, path)}
        onOpenGitDiff={(absPath, gitBase) => openGitDiff(tab.sessionId, absPath, gitBase)}
        onIgnoreGitignore={(path, pattern) => appendGitignore(tab.sessionId, path, pattern)}
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
{#snippet stripTabs(tabs: Tab[], peers: Tab[], shownId: string | null, paneId: string | null)}
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
      class="flex max-w-48 cursor-grab items-center gap-2 border-r border-edge px-3 py-1.5 text-sm touch-none active:cursor-grabbing {tabsState.activeId ===
      tab.sessionId
        ? `bg-panel text-text ${activeTabStrip(prodTabIds.has(tab.sessionId), 2)}`
        : shownId === tab.sessionId
          ? 'bg-panel text-text'
          : 'text-muted hover:bg-edge'}"
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
        <span class="flex min-w-0 items-baseline gap-1">
          <span class="max-w-full shrink-0 truncate">{tab.attach.name}</span>
          <span class="min-w-0 truncate text-muted">· {tabAlias(tab)}</span>
        </span>
      {:else}
        <span class="truncate">{tabAlias(tab)}</span>
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
    alias={activeTab?.alias ?? ""}
    bufferText={() => termRefs[tabsState.activeId ?? ""]?.bufferText?.() ?? ""}
    outputTick={idleOutputTick}
    noSignal={noSignalSession !== null}
    targetEl={terminalArea ?? mainArea ?? null}
    onnosignaldismiss={() => (noSignalSession = null)}
  />
  {#if showWindowChrome}
    <TitleBar
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
    connected={monitorConnected}
    canRecord={bcOn ? bcTargets.length > 0 : !!(activeTab && isLive(activeTab.status))}
    recording={bcOn ? !!broadcastBatch : !!(activeTab && isRecording(activeTab.sessionId))}
    onToggleRecording={toggleRecording}
    onOpenRecordings={() => (showRecordings = true)}
    onOpenMonitoring={openMonitoring}
    onOpenSettings={() => openSettings("servertools")}
    onOpenUtilities={() => openUtilities()}
    canBroadcast={!!tabsState.activeId}
    broadcastActive={bcOn}
    onToggleBroadcast={toggleActiveBroadcast}
    showNotes={!!notesServerTarget}
    hasNotes={hasNotes(notesServerTarget?.notes)}
    onOpenNotes={() => (notesServer = notesServerTarget)}
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
      <!-- The single tab strip: always there while the centre is one pane, so the
           local-terminal "+" is reachable even with no open sessions, and in
           broadcast mode, which lays its members out itself. Split, each pane
           carries its own strip inside the area below. -->
      {#if !paneStrips}
        <div
          data-tabstrip={isSplit ? "*" : paneList[0].id}
          bind:offsetHeight={flatBarHeight}
          role="tablist"
          tabindex={-1}
          class="flex min-h-8 select-none items-stretch border-b border-edge bg-panel-alt"
        >
          {@render stripTabs(
            tabsOf(
              incoming.tab
                ? isSplit
                  ? previewIncomingFlat(center, INCOMING_TAB, incoming.over)
                  : previewIncoming(center, paneList[0].id, INCOMING_TAB, incoming.over)
                : isSplit
                  ? previewFlat(center, tabDrag.tab, tabDrag.over)
                  : previewTabs(center, paneList[0].id, tabDrag.tab, tabDrag.over),
            ),
            orderedTabList,
            null,
            null,
          )}
        </div>
      {/if}

      <div class="flex min-h-0 flex-1">
        {#if tabsState.list.length > 0}
          <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            {#if bcOn}
              <!-- Broadcast toolbar: group size, layout, quick actions, exit. -->
              <div class="flex shrink-0 items-center gap-2 border-b border-edge bg-panel-alt px-2 py-1 text-xs">
                <Icon name="broadcast" size={14} class="text-accent" />
                <span class="font-medium text-text">{t("broadcast.title")}</span>
                <span class="text-muted">{t("broadcast.targetCount", { count: bcTargets.length })}</span>
                <div class="mx-1 flex items-center gap-0.5 rounded bg-panel p-0.5">
                  <button
                    class="rounded p-1 {bcLayout === 'grid' ? 'bg-edge text-text' : 'text-muted hover:text-text'}"
                    onclick={() => (broadcastState.layoutMode = "grid")}
                    use:tooltip={t("broadcast.layoutGrid")}
                    aria-label={t("broadcast.layoutGrid")}
                  >
                    <Icon name="layoutGrid" size={14} />
                  </button>
                  <button
                    class="rounded p-1 {bcLayout === 'focus' ? 'bg-edge text-text' : 'text-muted hover:text-text'}"
                    onclick={() => (broadcastState.layoutMode = "focus")}
                    use:tooltip={t("broadcast.layoutFocus")}
                    aria-label={t("broadcast.layoutFocus")}
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
              bind:clientHeight={areaHeight}
              class={bcOn
                ? bcLayout === "grid"
                  ? "grid min-h-0 min-w-0 flex-1 gap-1 overflow-y-auto p-1"
                  : "flex min-h-0 min-w-0 flex-1 gap-1 p-1"
                : "relative min-h-0 min-w-0 flex-1"}
              style={bcOn && bcLayout === "grid"
                ? `grid-template-columns: repeat(${bcCols}, minmax(0, 1fr)); grid-auto-rows: minmax(220px, 1fr);`
                : ""}
            >
            {#if paneStrips}
              <!-- The panes: each is its tab strip. The terminals are NOT inside
                   them: they follow in one flat list and are placed over the pane
                   that holds them, under its strip. -->
              {#each paneList as pane (pane.id)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  data-pane={pane.id}
                  data-testid="pane"
                  data-focused={pane.id === center.focus || undefined}
                  class="absolute flex flex-col"
                  style={rectStyle(placement.panes[pane.id], areaBounds)}
                  onpointerdowncapture={() => focusPane(pane.id)}
                >
                  <div
                    data-tabstrip={pane.id}
                    role="tablist"
                    tabindex={-1}
                    style="height: {tabBarHeight}px"
                    class="flex shrink-0 select-none items-stretch border-b border-edge bg-panel-alt"
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
              {@const ws = getWorkspace(tab.sessionId)}
              {@const bcTile = bcOn && (bcLayout === "grid" ? isBroadcastMember(tab.sessionId) : tab.sessionId === bcFocusId)}
              {@const bcSrv = servers.find((s) => s.id === tab.serverId)}
              {@const bar = sessionBarParts({
                editors: ws.editors.length,
                onTerminal: ws.active === TERMINAL_VIEW,
                connected: tab.status.startsWith("Connected"),
                smartLogs: settings.smartLogs.enabled,
                structured: !!termStructured[tab.sessionId],
                broadcast: bcOn,
                ai: aiOn && bcSrv?.noAi !== true,
              })}
              <!-- One terminal (with its editors), placed over its pane. A click or a
                   keystroke inside gives that pane the focus — not in broadcast
                   mode, where the tiles are not panes. -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                data-pane-body={bcOn ? undefined : tabPane[tab.sessionId]}
                class={bcOn && !bcTile
                  ? "hidden"
                  : bcTile
                    ? `relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded border ${bcLayout === "grid" ? "" : "flex-1"} ${prodTabIds.has(tab.sessionId) ? "border-bad/60" : "border-edge"}`
                    : `absolute flex flex-col ${shownIds.has(tab.sessionId) ? "" : "invisible"}`}
                style={bcOn
                  ? undefined
                  : rectStyle(placement.panes[tabPane[tab.sessionId]], areaBounds, stripInset)}
                onpointerdowncapture={() => {
                  if (!bcOn) focusPane(tabPane[tab.sessionId]);
                }}
                onfocusin={() => {
                  if (!bcOn) focusPane(tabPane[tab.sessionId]);
                }}
              >
                {#if bcTile}
                  <div class="flex shrink-0 items-center gap-2 border-b border-edge bg-panel-alt px-2 py-1 font-mono text-meta">
                    <span class="h-2 w-2 shrink-0 rounded-full {dotClass(tab.status)}"></span>
                    <span class="shrink-0 truncate text-text">{tabTitle(tab)}</span>
                    <span class="min-w-0 flex-1 truncate text-muted">
                      {bcSrv ? `${bcSrv.username}@${bcSrv.host}:${bcSrv.port}` : ""}
                    </span>
                    {#if prodTabIds.has(tab.sessionId)}
                      <span class="shrink-0 rounded bg-bad/15 px-1 text-caption text-bad">prod</span>
                    {/if}
                  </div>
                {/if}
                {#if showSessionBar(bar)}
                  <!-- Session bar: workspace sub-tabs (terminal + open editors, Phase 12)
                       on the left, terminal tools on the right. The tools used to
                       float over the terminal and covered full-screen programs'
                       first row (nano's title line). Visibility — sessionbar.ts. -->
                  <div
                    class="flex shrink-0 items-stretch border-b border-edge bg-panel-alt text-xs"
                    data-testid="session-bar"
                  >
                  <div class="flex min-w-0 flex-1 items-stretch overflow-x-auto">
                  {#if bar.subtabs}
                    <button
                      class="flex shrink-0 items-center gap-1.5 border-r border-edge px-3 py-1 {ws.active ===
                      TERMINAL_VIEW
                        ? `bg-panel text-text ${activeTabStrip(prodTabIds.has(tab.sessionId), 1)}`
                        : 'text-muted hover:bg-edge hover:text-text'}"
                      onclick={() => setActiveView(tab.sessionId, TERMINAL_VIEW)}
                    >
                      <Icon name="terminal" size={13} />
                      {t("workspace.terminal")}
                    </button>
                    {#each ws.editors as ed (ed.id)}
                      <div
                        class="group flex shrink-0 items-center border-r border-edge {ws.active === ed.id
                          ? `bg-panel text-text ${activeTabStrip(prodTabIds.has(tab.sessionId), 1)}`
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
                  {/if}
                  </div>
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
                  </div>
                {/if}
                <div class="relative min-h-0 flex-1 p-1">
                <div class="absolute inset-0 {ws.active === TERMINAL_VIEW || bcOn ? '' : 'invisible'}">
                {#if tab.attach && tab.status.startsWith("Disconnected")}
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
                    tint={prodTabIds.has(tab.sessionId) ? settings.prodTint : null}
                    focusOnConnect={tabsState.activeId === tab.sessionId}
                    adopt={tab.adopt ?? null}
                    onadopted={() => {
                      clearAdopt(tab.sessionId);
                      windowHasHadTab = true;
                    }}
                    onadoptfailed={() => adoptFailed(tab.sessionId)}
                    onresize={(cols, rows) => (termDims[tab.sessionId] = { cols, rows })}
                    onactivity={() => handleTerminalActivity(tab.sessionId)}
                    onoutput={() => idleOutputTick++}
                    oncwd={(path) => (terminalCwd[tab.sessionId] = path)}
                    onExplain={aiOn && servers.find((s) => s.id === tab.serverId)?.noAi !== true
                      ? (sel) => explainWithAi(tab.sessionId, sel)
                      : undefined}
                    onselection={(lines) => (termSelection[tab.sessionId] = lines)}
                    onlocalshell={(kind) => (localShellKind[tab.sessionId] = kind)}
                    onviewmode={(on) => (termStructured[tab.sessionId] = on)}
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
                          }, 500);
                        }
                      }
                      if (st === "connecting" && noSignalSession === tab.sessionId)
                        noSignalSession = null;
                      if (st === "closed") {
                        finalizeRecordingOnClose(tab.sessionId);
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
                      if (st === "connected") maybeAutoRecord(tab);
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
                {#if !bcTile && prodTabIds.has(tab.sessionId)}
                  <!-- Prod frame: an inert overlay ring, never a border/padding on the
                       terminal itself — FitAddon measures that element (termfit.guard),
                       and a real border would shrink the grid. z-20 keeps it above
                       the connecting overlay and the structured log view. -->
                  <div
                    class="pointer-events-none absolute inset-0 z-20 ring-1 ring-inset ring-bad/60"
                    data-testid="prod-frame"
                    aria-hidden="true"
                  ></div>
                {/if}
              </div>
            {/each}
              {#if bcOn && bcLayout === "focus" && bcMemberTabs.length > 0}
                <BroadcastRoster
                  rows={bcRosterRows}
                  onfocus={activateTab}
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
{#if draggingTab && !heldOverWindow}
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
    {#if tabDrag.outside && canOfferDetach}
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
{#if detaching}
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
  onInstallTool={(tool) => openToolInstallByName(tool)}
  {toolsReloadToken}
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
  onDeleteWithServers={doDeleteFolderWithServers}
  onchanged={async () => {
    [servers, folders] = await Promise.all([listServers(), listFolders()]);
  }}
/>

<QuitDialog
  open={showQuit}
  kind={isMainWindow ? "quit" : "window"}
  rows={showQuit ? closeRowsNow() : []}
  onconfirm={() => void (isMainWindow ? quitApp() : closeWindow())}
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
    await ensureGroupRecording();
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
    class="overflow-x-auto rounded border border-edge bg-panel p-2 text-meta leading-relaxed text-muted"
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
  {t("page.closeTabBody1")} <span class="text-text">{closeConfirmTab ? tabAlias(closeConfirmTab) : ""}</span>
  {t("page.closeTabBody2")}
</ConfirmDialog>

<!-- Tab-bar right-click menu -->
<ContextMenu menu={tabCtxMenu} onclose={() => (tabCtxMenu = null)} />

<!-- Save / Don't save / Cancel when closing an edited file -->
<UnsavedCloseDialog
  open={!!closeEditorConfirm}
  name={closeEditorConfirm?.doc.name ?? ""}
  canSave={!closeEditorConfirm?.doc.readOnly}
  onsave={() => void saveAndCloseEditor()}
  ondiscard={() => {
    if (closeEditorConfirm) closeEditorStore(closeEditorConfirm.sid, closeEditorConfirm.doc.id);
    closeEditorConfirm = null;
  }}
  oncancel={() => (closeEditorConfirm = null)}
/>

<!-- Sudo prompt: reopen (or re-save) a permission-denied file as root -->
<Modal open={!!sudoPrompt} title={sudoPromptTitle} onclose={() => (sudoPrompt = null)}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      confirmSudo();
    }}
  >
    <p class="mb-2 break-all text-xs text-muted">{sudoPromptPath}</p>
    <PasswordInput
      testid="sudo-password"
      autofocus
      placeholder={t("editor.sudoPassword")}
      bind:value={sudoPasswordInput}
    />
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
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
    class="rounded px-3 py-1 text-sm text-muted hover:text-text"
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
    class="rounded px-3 py-1 text-sm text-muted hover:text-text"
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
