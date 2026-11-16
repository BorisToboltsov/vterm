<script lang="ts">
  // Shared file-browser panel (Phase 44.8) — the unified body of SftpPanel and
  // LocalFilePanel, which were near-identical copies. Everything shared (selection,
  // keyboard roving focus, clipboard cut/copy/paste, drag-to-move, click-to-edit
  // path bar, mkdir/mkfile/rename forms, virtualized list, context menus) lives here
  // once; the two kinds differ only via the injected `adapter` (transport + the two
  // navigation semantics that genuinely diverge) and a few capability flags. See
  // filebrowser.ts for the contract and why this exists.
  import { swallow, swallowed } from "../api/diag";
  import { onDestroy, onMount, tick, untrack, type Snippet } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { writeClipboard } from "../app/clipboard";
  import { beginFileDrag, consumeFileDragClick, fileDrag } from "../stores/filedrag.svelte";
  import { chordLetter } from "../app/appshortcuts";
  import { checkMove } from "./filemove";
  import { joinPath, normalizeInputPath } from "./fspath";
  import { clickSelect, emptySelection, type SelectionState } from "./multiselect";
  import { nextCursor, scrollForCursor } from "./filekeys";
  import {
    buildVisibleItems,
    cursorForReturnedFolder,
    isDestExists,
    pasteTargetName,
    type FileBrowserAdapter,
  } from "./filebrowser";
  import { GREP_LIMIT, type GrepMatch } from "../sync/sync";
  import { moreLimit } from "./grepview";
  import GrepResults from "./GrepResults.svelte";
  import SidePane from "../ui/SidePane.svelte";
  import PanelDivider from "../ui/PanelDivider.svelte";
  import { fitsBeside } from "../layout/panelsplit";
  import { partWidth } from "../stores/panelsplit.svelte";
  import type { FileEntry } from "../types";
  import { lsColorKey, fileTooltip, formatMode, formatModified, ownerLabel } from "./lscolors";
  import ColumnHead from "../ui/ColumnHead.svelte";
  import SortTitle from "../ui/SortTitle.svelte";
  import {
    FILE_ORDER,
    FILE_SCHEMA,
    nextSort,
    sortEntries,
    type FileSort,
    type SortKey,
  } from "./filesort";
  import ListHeader from "../ui/ListHeader.svelte";
  import FilteredEmpty from "../ui/FilteredEmpty.svelte";
  import { listMenuText } from "../ui/listtext";
  import { filterItems, filterSummary, isFiltered, viewMenu, NO_FILTER, NO_GROUPS, type ListFilter } from "../ui/listview";
  import { listOrder, setListOrder } from "../stores/listview.svelte";
  import { wideWhen } from "../actions/panelwide.svelte";
  import { aside, createRowGlide } from "../actions/fluidglide";
  import { MOTION_BASE, motion } from "../ui/motion";
  import { columnVars } from "../ui/colwidths";
  import { columns } from "../stores/colwidths.svelte";
  import { driveDisplayName, driveIcon, driveKindKey, driveUsage, driveUsedFraction } from "./drives";
  import { windowRange } from "../ui/virtuallist";
  import { filterHiddenFiles } from "../ui/util";
  import { activeTerminalTheme, settings, uiPx } from "../settings/settings.svelte";
  import Icon from "../ui/Icon.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { menuActions, type MenuItem, type OpenMenu } from "../ui/ctxmenu";
  import { notifyError, notifySuccess } from "../stores/toasts.svelte";
  import {
    dirRevision,
    dockState,
    fileSearch,
    type FileSearchState,
    listFilter,
    setListFilter,
    pendingFilesDir,
    setDockCwd,
    takeFilesDir,
    type FilesDockState,
  } from "../stores/dockstate.svelte";
  import {
    copyTargetList,
    pendingMoveRequest,
    requestCopy,
    setFileSelection,
    takeMoveRequest,
  } from "../stores/filecopy.svelte";
  import { targetsFrom } from "./copyto";
  import { MARK_DOT, type Mark } from "./groupupload";
  import { t } from "../i18n";
  import { holdsPipelines, isPipelineDir, pipelineKindOf } from "../pipeline/pipefiles";
  import { projectSigns, type ProjectKind } from "../scenarios/project";
  import ProjectStrip from "./ProjectStrip.svelte";
  import {
    isGenerated,
    manifestFacts,
    packageManager,
    projectOf,
    roleOf,
    rowLook,
    type ManifestFacts,
    type ProjectKind as MapKind,
    type Role,
    type Tone,
  } from "./projectmap";
  import {
    asks,
    helmInstallArgv,
    projectActions,
    projectTasks,
    rowActions,
    type ProjectAction,
    type ProjectCommand,
    type ProjectTask,
  } from "./projectactions";
  import { markTone, type ListingGit } from "../git/gitlisting";

  let {
    adapter,
    width = 384,
    collapsed = $bindable(false),
    animateWidth = true,
    embedded = false,
    terminalCwd = null,
    followTerminal = false,
    onToggleFollowTerminal,
    onOpenFile,
    onPipelines,
    onProject,
    projectPinned,
    onPinProject,
    onUserNavigate,
    // Kind-specific behaviour ----------------------------------------------------
    /** Require an explicit Connect action before listing (SFTP); local FS is instant. */
    requiresConnect = false,
    /** Terminal session is connected — enables the Connect button (SFTP only). */
    sessionReady = false,
    /** Render synthetic drive rows at the Windows "This PC" level (local only). */
    drives = false,
    /** Strip/label text, per kind. */
    stripLabel,
    expandLabel,
    collapseLabel,
    /** Shown in the path bar for a non-mutable (synthetic) cwd, e.g. "This PC". */
    syntheticLabel = "",
    /** Prefix for `data-testid`s so E2E can target each kind ("sftp"/"localfiles"). */
    testPrefix,
    /**
     * The panel's dock tab is the one on screen. False means the panel is still
     * mounted but hidden behind another dock tab (v1.0.14): it must not react
     * to window-level file drops, and it re-lists when it comes back into view.
     */
    visible = true,
    /**
     * Session id under which this panel's place is remembered across a remount
     * (`stores/dockstate`), or null to keep nothing. Restoring means an SFTP panel
     * comes back connected and in the same directory instead of offering Connect
     * again — the channel behind it was never closed.
     */
    sessionKey = null,
    /** Open the directory-sync dialog (SFTP only; the wrapper owns the modal). */
    onSync,
    /** A sync compare/run for this session is going on (possibly in the background). */
    syncActive = false,
    /** A row above the listing, while connected: whom the SFTP files are under. */
    banner,
    /** Extra footer content, e.g. the SFTP transfers list. */
    footer,
    footerCount = 0,
    rowMark,
    prod = false,
    kubeContext = null,
    onProjectCommand,
    onOpenPanel,
  }: {
    adapter: FileBrowserAdapter;
    width?: number;
    collapsed?: boolean;
    animateWidth?: boolean;
    embedded?: boolean;
    terminalCwd?: string | null;
    followTerminal?: boolean;
    onToggleFollowTerminal?: () => void;
    /**
     * Open a file in the editor. FileBrowser always passes the entry name; the
     * local wrapper's `(path) => void` ignores it (fewer params is assignable).
     */
    onOpenFile?: (path: string, name: string, gotoLine?: number) => void;
    /** Show the pipelines of files and folders (ADR 0068): one file on its schema, the rest on a map. */
    onPipelines?: (targets: { path: string; isDir: boolean }[]) => void;
    /** The folder shown is an Ansible or Terraform project (ADR 0071): its overview, a check, a run, a plan. */
    onProject?: (kind: ProjectKind, root: string, action: "open" | "check" | "run" | "plan") => void;
    /** Whether that project is pinned to the Scenarios panel. */
    projectPinned?: (kind: ProjectKind, root: string) => boolean;
    onPinProject?: (kind: ProjectKind, root: string) => void;
    onUserNavigate?: (path: string) => void;
    requiresConnect?: boolean;
    sessionReady?: boolean;
    drives?: boolean;
    stripLabel: string;
    expandLabel: string;
    collapseLabel: string;
    syntheticLabel?: string;
    testPrefix: string;
    visible?: boolean;
    sessionKey?: string | null;
    onSync?: () => void;
    syncActive?: boolean;
    banner?: Snippet;
    footer?: Snippet;
    /**
     * How many things the footer lists right now (transfers). Zero — the footer
     * draws nothing; the panel has to know, because in a wide panel the footer
     * stands beside the listing and the column for it exists only while it has
     * something to show.
     */
    footerCount?: number;
    /**
     * The folder compared with the synchronous-input group's (ADR 0064): how
     * each other server's copy of a row compares — dots beside its name. Null —
     * no comparison for this folder.
     */
    rowMark?: (entry: FileEntry) => { label: string; mark: Mark }[] | null;
    /** The connection is a prod server: the strip's commands that change things ask in red (ADR 0077). */
    prod?: boolean;
    /** The k8s panel's context for this connection — kubectl and helm are told it. */
    kubeContext?: string | null;
    /** Type a project's command into the connection's terminal, in `root` (ADR 0077). */
    onProjectCommand?: (root: string, cmd: ProjectCommand, label: string) => void;
    /** «Open in Docker / k8s» from the strip. */
    onOpenPanel?: (panel: "docker" | "k8s") => void;
  } = $props();

  let cwd = $state("");
  let entries = $state<FileEntry[]>([]);
  let loading = $state(false);
  let error = $state("");

  // Connect state — only meaningful when `requiresConnect`. A local panel is always
  // "connected", so `isConnected` collapses to true there.
  let connected = $state(false);
  let connecting = $state(false);
  const isConnected = $derived(!requiresConnect || connected);

  // Editable path bar (Phase 39.2): click the path to type/paste one.
  let editingPath = $state(false);
  let pathDraft = $state("");
  let pathInputEl = $state<HTMLInputElement | null>(null);
  /** Home, remembered on connect/mount so `~` can be expanded on input. */
  let homePath = $state("");

  // Navigation semantics come from the adapter (POSIX vs the Windows drives level).
  const hasParent = $derived(adapter.hasParent(cwd));
  const mutable = $derived(adapter.mutable(cwd));
  // The folder shown, as a project of Ansible or Terraform (ADR 0071) — by its names.
  const project = $derived(onProject && mutable ? projectSigns(entries) : null);
  // Where ".." leads, and whether it is a legal drop target (never the synthetic
  // drives level, which has no filesystem to move anything into).
  const parentPath = $derived.by(() => {
    const p = adapter.parentForUp(cwd);
    return p !== null && adapter.mutable(p) ? p : null;
  });

  function beginEditPath() {
    // A synthetic (non-mutable) cwd has no real path to pre-fill.
    pathDraft = mutable ? cwd : "";
    editingPath = true;
    tick().then(() => {
      pathInputEl?.focus();
      pathInputEl?.select();
    });
  }

  function commitPath() {
    const next = normalizeInputPath(pathDraft, homePath);
    editingPath = false;
    if (!next || next === cwd) return;
    load(next);
    // A typed path is a user-initiated move, so it mirrors into the terminal like a
    // click does (the OSC 7 follow contract).
    syncTerminalCwd(next);
  }

  /** Mirror a user-initiated folder change into the terminal when following. */
  function syncTerminalCwd(path: string) {
    if (followTerminal && adapter.mirrorsToTerminal(path)) onUserNavigate?.(path);
  }

  // Virtualized listing (Phase 18.7): only the visible window of fixed-height
  // (`h-7`, 28px) rows is rendered so huge directories don't freeze the UI. Item 0
  // is the ".." parent-nav when not at the top.
  const ROW_H = $derived(uiPx(28));
  let listScrollTop = $state(0);
  // True while the list is moving (and ~150 ms after). Rows stop taking the
  // pointer meanwhile: WebView2 (Chromium) re-evaluates hover only once a scroll
  // settles, so the row under a resting cursor stayed lit and rode along with
  // the content — read as "the mouse grabbed a file" mid-fling.
  let listScrolling = $state(false);
  let scrollIdle: ReturnType<typeof setTimeout> | undefined;
  function onListScroll(e: Event) {
    listScrollTop = (e.currentTarget as HTMLElement).scrollTop;
    listScrolling = true;
    clearTimeout(scrollIdle);
    scrollIdle = setTimeout(() => (listScrolling = false), 150);
  }
  let listViewportH = $state(600);
  // The wide layout (v1.7): in a wide container the listing is a table — name,
  // size, permissions, owner, modified — under a sticky header. It is the same
  // markup laid out by `@wide:` variants, so nothing here knows which one is
  // on screen; the header's height is measured (0 while it is not drawn)
  // because it covers the top of the scroller and the cursor must not hide
  // under it.
  const COLS = { "--c-name": "files.name", "--c-owner": "files.owner" } as const;
  // A table cell in a wide container: the rule on its right and the row's
  // vertical padding (6 + 16 + 6 = the 28px row), as in the other dock tables.
  const CELL = "@wide:border-r @wide:border-edge/40 @wide:py-1.5 @wide:leading-4";
  let headH = $state(0);
  // The order (v1.17): one for the app, by a column of the table. The level of
  // drives is not a folder's listing and keeps the order it came in.
  const fileOrder = $derived(listOrder("files", FILE_SCHEMA, FILE_ORDER));
  const sortNow = $derived(fileOrder.sort as FileSort);
  // The name filter of the folder on screen (v1.29, ADR 0050): the session's,
  // so it survives the dock being rebuilt; a new folder starts unfiltered. The
  // level of drives has no filter row.
  let localFilter = $state<ListFilter>(NO_FILTER);
  const nameFilter = $derived(sessionKey ? listFilter(sessionKey, "files") : localFilter);
  function setNameFilter(next: ListFilter) {
    if (sessionKey) setListFilter(sessionKey, "files", next);
    else localFilter = next;
  }
  // What the folder is as a project and what each entry is to it (ADR 0077).
  const projInfo = $derived(mutable ? projectOf(cwd, entries) : null);
  const projKind = $derived<MapKind | null>(projInfo?.kind ?? null);
  const roles = $derived(new Map<string, Role>(entries.map((e) => [e.path, roleOf(projKind, e)])));
  const visibleEntries = $derived(
    filterHiddenFiles(entries, settings.sftp.showHiddenFiles).filter(
      (e) => !(settings.sftp.hideGenerated && isGenerated(roles.get(e.path) ?? "plain")),
    ),
  );
  const hiddenGenerated = $derived(
    settings.sftp.hideGenerated ? entries.filter((e) => isGenerated(roles.get(e.path) ?? "plain")).length : 0,
  );
  const shownEntries = $derived(
    mutable ? sortEntries(filterItems(visibleEntries, FILE_SCHEMA, nameFilter), sortNow) : visibleEntries,
  );
  // A narrow list is ordered from its own header (v1.20): name and size — the
  // two columns it shows — by a click, as in the table, the rest from a menu.
  // The menu is lit while the order is by a column the list does not show, so
  // a listing not by name or size still says it is ordered otherwise.
  const hiddenSortKey = $derived(sortNow.key === "name" || sortNow.key === "size" ? null : sortNow.key);
  // The SFTP toolbar has more actions than a 240px dock can hold. Measure the
  // actual bar (also when embedded) and keep Upload visible in its compact form.
  let toolbarWidth = $state(0);
  const compactToolbar = $derived(!!adapter.upload && toolbarWidth > 0 && toolbarWidth < 320);
  let toolbarEl: HTMLElement | null = null;
  function measureToolbar(node: HTMLElement) {
    toolbarEl = node;
    const observer = new ResizeObserver(() => (toolbarWidth = node.clientWidth));
    observer.observe(node);
    toolbarWidth = node.clientWidth;
    return { destroy: () => observer.disconnect() };
  }
  // The buttons a compact bar folds away fly into «⋯» and back out of it; the
  // rest glide to their places.
  const toolbarGlide = createRowGlide(() => toolbarEl, { more: "more" });
  $effect.pre(() => {
    void compactToolbar;
    untrack(() => toolbarGlide.snapshot());
  });
  $effect(() => {
    void compactToolbar;
    untrack(() => toolbarGlide.play());
  });
  const COLUMN_LABEL: Record<SortKey, () => string> = {
    name: () => t("sftp.colName"),
    size: () => t("sftp.colSize"),
    mode: () => t("sftp.colMode"),
    owner: () => t("sftp.colOwner"),
    modified: () => t("sftp.colModified"),
  };
  const sortedBy = (key: SortKey) => (sortNow.key === key ? sortNow.dir : null);
  const rowCount = $derived((hasParent ? 1 : 0) + shownEntries.length);
  const win = $derived(windowRange(listScrollTop, listViewportH, ROW_H, rowCount));
  const visibleItems = $derived(buildVisibleItems(win.start, win.end, hasParent, shownEntries));


  let showMkdir = $state(false);
  let mkdirName = $state("");
  let showMkfile = $state(false);
  let mkfileName = $state("");
  let deleteTargets = $state<FileEntry[]>([]);
  let renameTarget = $state<FileEntry | null>(null);
  let renameName = $state("");

  // Content search (grep), SFTP only — gated by the adapter exposing `search`.
  // The question and the answer on screen are the session's (v1.34, `dockstate`):
  // a terminal-tab switch rebuilds the panel, and a search that took a minute
  // was gone with it. Without a session the panel keeps its own.
  const ownSearch = $state<FileSearchState>({
    open: false,
    query: "",
    caseSensitive: false,
    regex: false,
    outcome: null,
    searched: { query: "", caseSensitive: false, regex: false, dir: "", limit: 0 },
  });
  const search = untrack(() => (sessionKey ? fileSearch(sessionKey) : ownSearch));
  let searching = $state(false);

  /** Ask `grep`: the field as typed (a new search), or the search on screen again with a higher `limit` («show more»). */
  async function runSearch(limit?: number) {
    if (!adapter.search) return;
    const asked =
      limit === undefined
        ? { query: search.query.trim(), caseSensitive: search.caseSensitive, regex: search.regex, dir: cwd || ".", limit: GREP_LIMIT }
        : { ...search.searched, limit };
    if (!asked.query) return;
    searching = true;
    try {
      search.outcome = await adapter.search(asked.dir, asked.query, !asked.caseSensitive, !asked.regex, asked.limit);
    } catch (e) {
      notifyError(String(e), { source: "files", sessionId: sessionKey });
      // The call itself failed: that is a search that did not run.
      search.outcome = { matches: [], truncated: false, failed: true };
    } finally {
      search.searched = asked;
      searching = false;
    }
  }

  // The wide layout (v1.17): what a narrow panel stacks over and under the
  // listing — the content search and the footer (transfers) — stands in a
  // column beside it, so the listing keeps its height. Beside only in a wide
  // panel, and only while the row holds two parts (`fitsBeside`); the panel
  // measures itself, since its query container is the listing, not its root.
  let wide = $state(false);
  let rowWidth = $state(0);
  const beside = $derived(wide && fitsBeside(rowWidth));
  const searchOpen = $derived(search.open && !!adapter.search);
  // The column of the transfers stays once a transfer opened it (v1.35), until
  // it is closed by hand: one that left with the last transfer gave the listing
  // its width back, and the next transfer took it again. A narrowed panel lets
  // it go — under the listing the footer is only there while it lists something.
  let footerKept = $state(false);
  $effect(() => {
    if (!beside) footerKept = false;
    else if (footerCount > 0) footerKept = true;
  });
  const footerShown = $derived(!!footer && (footerCount > 0 || footerKept));
  const sideOpen = $derived(beside && (searchOpen || footerShown));

  function openMatch(m: GrepMatch) {
    const name = m.path.split("/").pop() ?? m.path;
    // From the folder the search ran in: the panel may have moved on since.
    onOpenFile?.(joinPath(search.searched.dir || cwd, m.path), name, m.line);
  }

  /** Open the transport and list the starting directory (SFTP connect button). */
  async function connect() {
    connecting = true;
    error = "";
    await loadStart();
    connecting = false;
    connected = error === "";
    persist();
  }

  /**
   * Remember where this panel sits, so a remount (switching terminal tabs) resumes
   * here instead of asking for a connect it never lost. Only a connected panel is
   * worth remembering — see `restore`.
   */
  function persist() {
    if (!sessionKey) return;
    dockState(sessionKey).files = isConnected
      ? { connected: true, cwd, home: homePath }
      : null;
  }

  /**
   * Resume from `saved`. A failure here means the remembered directory is gone (or
   * the session is), so the panel falls back to its normal empty start rather than
   * sitting in a directory it could not read: the local kind re-lists home, the
   * SFTP kind returns to the Connect button with the error shown.
   */
  async function restore(saved: FilesDockState) {
    homePath = saved.home;
    connecting = requiresConnect;
    await load(saved.cwd);
    connecting = false;
    connected = error === "";
    if (connected) persist();
    else if (sessionKey) dockState(sessionKey).files = null;
    if (!connected && !requiresConnect) await loadStart();
  }

  /** Initial listing: the terminal's cwd when following, else home, else ".". */
  async function loadStart() {
    let start = followTerminal && terminalCwd ? terminalCwd : ".";
    if (!(followTerminal && terminalCwd)) {
      try {
        start = await adapter.home();
        homePath = start;
      } catch (e) {
        /* fall back to "." */
        swallowed("files", "the home folder was not found: the panel opens elsewhere", e);
      }
    }
    await load(start);
  }

  // Set once mounted: a folder asked for before then is taken on mount.
  let started = false;
  onMount(async () => {
    started = true;
    // A folder clicked in terminal output (v1.24) — it is why the panel opened.
    const asked = sessionKey ? takeFilesDir(sessionKey) : null;
    if (asked) {
      await openDir(asked);
      return;
    }
    // Resume where this session's panel was left off; otherwise a kind without a
    // connect step lists immediately on mount.
    const saved = sessionKey ? dockState(sessionKey).files : null;
    if (saved?.connected && saved.cwd) await restore(saved);
    else if (!requiresConnect) await loadStart();
  });

  onDestroy(() => {
    clearTimeout(scrollIdle);
  });

  // A folder asked for while the panel is already up.
  $effect(() => {
    const asked = pendingFilesDir(sessionKey);
    if (!asked || !started || !sessionKey) return;
    const key = sessionKey;
    untrack(() => {
      const dir = takeFilesDir(key);
      if (dir) void openDir(dir);
    });
  });

  /**
   * Open `path` because something outside asked (a folder clicked in terminal
   * output). An SFTP panel not connected yet connects straight to it — the
   * click is the user's go-ahead, as the Connect button would be. It is a user's
   * move like any other, so the terminal goes there too — once the folder opened:
   * a `cd` typed into a shell over a folder that refused would be a stray line.
   */
  async function openDir(path: string) {
    if (isConnected) {
      await load(path);
    } else {
      connecting = true;
      error = "";
      await load(path);
      connecting = false;
      connected = error === "";
      persist();
      if (connected && !homePath) {
        adapter
          .home()
          .then((home) => (homePath = home))
          .catch(swallow("files", "the home folder was not found: the panel opens elsewhere"));
      }
    }
    if (cwd === path && error === "") syncTerminalCwd(path);
  }

  // Re-list when the pane comes back into view. It stayed mounted while hidden, so
  // nothing refreshed it — and a listing that silently ages is the one thing the
  // old destroy-on-switch behaviour got right.
  let wasVisible = untrack(() => visible);
  $effect(() => {
    const back = visible && !wasVisible;
    wasVisible = visible;
    if (!back) return;
    untrack(() => {
      if (isConnected && cwd) refresh();
    });
  });

  /**
   * List `path` and, only if it succeeds, make it the current directory. On failure
   * the current listing is kept and the error is shown as a banner, so the user is
   * never stuck in a dir they couldn't enter.
   */
  // Only the newest listing may land: two in flight (a re-list after an upload and
  // a click, say) can answer out of order, and the older answer would put back a
  // folder without the file that was just uploaded.
  let loadSeq = 0;
  async function load(path: string) {
    const seq = ++loadSeq;
    loading = true;
    try {
      const next = await adapter.list(path);
      if (seq !== loadSeq) return;
      if (path !== cwd && isFiltered(nameFilter)) setNameFilter(NO_FILTER);
      cwd = path;
      entries = next;
      error = "";
      selection = emptySelection();
      cursor = -1;
      persist();
      // Publish the folder to the rest of the dock (git reads it). Any successful
      // listing counts — a click, a typed path, or following the terminal — but not
      // a synthetic level like "This PC", which is no directory git could run in,
      // nor the "." placeholder listed before home resolved.
      if (sessionKey && path !== "." && adapter.mirrorsToTerminal(path)) {
        setDockCwd(sessionKey, path);
      }
    } catch (e) {
      if (seq === loadSeq) error = String(e);
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  // Exported so a wrapper that owns an out-of-band mutation (SFTP's SyncModal)
  // can refresh the listing FileBrowser holds. Internal callers use it too.
  export function refresh() {
    load(cwd || ".");
  }

  // Follow the terminal: when the toggle is on and a new terminal cwd (OSC 7)
  // arrives, navigate there. `cwd` is read untracked so the user's own navigation
  // isn't snapped back and a successful load doesn't re-trigger this effect.
  $effect(() => {
    if (!followTerminal || !terminalCwd || !isConnected) return;
    untrack(() => {
      if (terminalCwd !== cwd) load(terminalCwd);
    });
  });

  function open(entry: FileEntry) {
    if (entry.isDir) {
      load(entry.path);
      syncTerminalCwd(entry.path);
    } else onOpenFile?.(entry.path, entry.name);
  }

  /** Enter a folder from the keyboard, keeping focus on the list for arrow keys. */
  async function enterDir(entry: FileEntry) {
    await load(entry.path);
    syncTerminalCwd(entry.path);
    await tick();
    cursor = rowCount ? 0 : -1;
    listEl?.focus();
    ensureCursorVisible();
  }

  /** Go up a level, landing the cursor on the folder we came out of. */
  async function goUp() {
    // Capture the target BEFORE loading: it derives from `cwd`, which the load moves.
    const target = adapter.parentForUp(cwd);
    if (target === null) return;
    const fromPath = cwd;
    await load(target);
    syncTerminalCwd(target);
    await tick();
    cursor = cursorForReturnedFolder(shownEntries, fromPath, hasParent, rowCount);
    listEl?.focus();
    ensureCursorVisible();
  }

  async function createFolder() {
    const name = mkdirName.trim();
    if (!name || !mutable) return;
    try {
      await adapter.mkdir(joinPath(cwd, name));
      mkdirName = "";
      showMkdir = false;
      await refresh();
      notifySuccess(t("sftp.folderCreated", { name }), { source: "files", sessionId: sessionKey });
    } catch (e) {
      notifyError(String(e), { source: "files", sessionId: sessionKey });
    }
  }

  async function createFile() {
    const name = mkfileName.trim();
    if (!name || !mutable) return;
    try {
      await adapter.createFile(joinPath(cwd, name));
      mkfileName = "";
      showMkfile = false;
      await refresh();
      notifySuccess(t("sftp.fileCreated", { name }), { source: "files", sessionId: sessionKey });
    } catch (e) {
      notifyError(String(e), { source: "files", sessionId: sessionKey });
    }
  }

  async function removeMany(targets: FileEntry[]) {
    deleteTargets = [];
    let lastName = "";
    let failed = "";
    for (const entry of targets) {
      try {
        await adapter.remove(entry.path, entry.isDir);
        lastName = entry.name;
      } catch (e) {
        failed = String(e);
      }
    }
    await refresh();
    if (targets.length === 1 && !failed) notifySuccess(t("sftp.deleted", { name: lastName }), { source: "files", sessionId: sessionKey });
    else if (!failed) notifySuccess(t("sftp.deleted", { name: `${targets.length}` }), { source: "files", sessionId: sessionKey });
    if (failed) notifyError(failed, { source: "files", sessionId: sessionKey });
  }

  // ── Multi-select + drag-to-move ────────────────────────────────────────────
  // OS-style: plain click = one, Ctrl/Cmd = toggle, Shift = range (multiselect.ts).
  // Dragging any selected row moves the whole selection. Selection clears on reload.
  let selection = $state<SelectionState>(emptySelection());
  // Keyboard cursor (roving focus) indexes the full visible list, including the ".."
  // row at index 0 when present. The file clipboard drives cut/copy → paste.
  let cursor = $state(-1);
  let clipboard = $state<{ mode: "copy" | "cut"; items: { path: string; name: string }[] } | null>(
    null,
  );
  let ctxMenu = $state<OpenMenu | null>(null);
  let listHeader = $state<ListHeader<FileEntry>>();
  const listLabels = { sort: (id: string) => COLUMN_LABEL[id as SortKey]() };
  const viewExtra = $derived([
    {
      label: t("sftp.hiddenFiles"),
      checked: settings.sftp.showHiddenFiles,
      onSelect: toggleHiddenFiles,
    },
    {
      label: t("project.hideGenerated"),
      checked: settings.sftp.hideGenerated,
      onSelect: () => (settings.sftp.hideGenerated = !settings.sftp.hideGenerated),
    },
  ]);

  // ── The project view of the folder (ADR 0077) ──────────────────────────────
  // Its manifest's facts and its tasks, read once per folder; its Git status,
  // read while the panel is on screen — one read in flight, again on reload.
  let projFacts = $state<ManifestFacts | null>(null);
  let projTasks = $state<ProjectTask[]>([]);
  let gitInfo = $state<ListingGit | null>(null);
  let gitFor = "";
  let gitBusy = false;
  let gitAgain = false;
  const lastAction = new Map<string, ProjectAction | ProjectTask>();
  let lastShown = $state<ProjectAction | ProjectTask | null>(null);
  let projAsk = $state<{ action: ProjectAction; helm: boolean } | null>(null);
  let helmForm = $state({ release: "", namespace: "default", values: null as string | null });

  const manager = $derived(projKind ? packageManager(projKind, entries) : null);
  const projActs = $derived(
    projKind
      ? projectActions(projKind, {
          manager,
          initialised: entries.some((e) => e.isDir && e.name === ".terraform"),
          kubeContext,
          goMain: entries.some((e) => !e.isDir && e.name === "main.go"),
          playbook: entries.find((e) => !e.isDir && /^(site|playbook)\.ya?ml$/i.test(e.name))?.name ?? null,
          inventory: entries.find((e) => /^(inventory|inventories|hosts)(\.(ini|ya?ml))?$/i.test(e.name))?.name ?? null,
          folder: baseNameOf(cwd),
        })
      : [],
  );

  function baseNameOf(p: string): string {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }

  $effect(() => {
    const info = projInfo;
    const dir = cwd;
    projFacts = null;
    projTasks = [];
    lastShown = lastAction.get(dir) ?? null;
    if (!info || !adapter.readText) return;
    const read = adapter.readText;
    const at = (name: string) => joinPath(dir, name);
    if (info.manifest) {
      const m = info.manifest;
      void read(at(m))
        .then((text) => {
          if (cwd === dir && projInfo?.kind === info.kind) projFacts = manifestFacts(info.kind, m, text);
        })
        .catch(swallow("files", "the project's manifest was not read: the strip shows its name only"));
    }
    if (info.tasksFile) {
      const f = info.tasksFile;
      void read(at(f))
        .then((text) => {
          if (cwd === dir) projTasks = projectTasks(f, text, manager);
        })
        .catch(swallow("files", "the project's task file was not read: its tasks are not offered"));
    }
  });

  async function readGit(dir: string) {
    if (!adapter.gitStatus) return;
    if (gitBusy) {
      gitAgain = true;
      return;
    }
    gitBusy = true;
    try {
      const g = await adapter.gitStatus(dir);
      if (cwd === dir) gitInfo = g;
    } catch (e) {
      if (cwd === dir) gitInfo = null;
      swallowed("files", "the folder's Git status was not read: the listing shows no Git marks", e);
    } finally {
      gitBusy = false;
      if (gitAgain) {
        gitAgain = false;
        void readGit(cwd);
      }
    }
  }

  // Asked when the folder or its listing changes, and only while on screen.
  $effect(() => {
    void entries;
    const dir = cwd;
    if (!visible || !mutable || !dir || !adapter.gitStatus) return;
    if (gitFor !== dir) gitInfo = null;
    gitFor = dir;
    void untrack(() => readGit(dir));
  });

  function runProject(a: ProjectAction) {
    const kind = projInfo?.kind;
    if (!kind) return;
    if (a.opens === "scenarios-check" || a.opens === "scenarios-run" || a.opens === "scenarios-plan") {
      const signs = projectSigns(entries);
      if (signs) onProject?.(signs.kind, cwd, a.opens === "scenarios-check" ? "check" : a.opens === "scenarios-run" ? "run" : "plan");
      return;
    }
    if (a.opens === "docker" || a.opens === "k8s") {
      onOpenPanel?.(a.opens);
      return;
    }
    if (kind === "helm" && a.id === "install") {
      helmForm = { release: projFacts?.name ?? baseNameOf(cwd), namespace: "default", values: null };
      projAsk = { action: a, helm: true };
      return;
    }
    if (asks(a, prod)) {
      projAsk = { action: a, helm: false };
      return;
    }
    send(a);
  }

  function send(a: ProjectAction | ProjectTask, cmd?: ProjectCommand) {
    const c = cmd ?? ("argv" in a && !("label" in a) ? { argv: a.argv } : (a as ProjectAction).cmd);
    onProjectCommand?.(cwd, c, "label" in a ? t(a.label) : a.name);
    lastAction.set(cwd, a);
    lastShown = a;
  }

  function runTask(task: ProjectTask) {
    if (prod) {
      projAsk = { action: { id: `task:${task.name}`, label: "project.tasks", cmd: { argv: task.argv }, ask: "prod" }, helm: false };
      return;
    }
    send(task);
  }

  const helmArgv = $derived(projAsk?.helm ? helmInstallArgv(helmForm, kubeContext) : null);
  const valuesFiles = $derived(entries.filter((e) => !e.isDir && /^values.*\.ya?ml$/i.test(e.name)).map((e) => e.name));

  function confirmProject() {
    const ask = projAsk;
    projAsk = null;
    if (!ask) return;
    if (ask.helm) {
      if (helmArgv) send(ask.action, { argv: helmArgv });
      return;
    }
    send(ask.action);
  }

  function askText(a: ProjectAction): string {
    if ("argv" in a.cmd) return a.cmd.argv.join(" ");
    return a.cmd.line.posix ?? Object.values(a.cmd.line)[0] ?? "";
  }

  const TONE: Record<Exclude<Tone, null>, string> = {
    accent: "text-accent",
    ok: "text-ok",
    warn: "text-warn",
    muted: "text-muted",
    violet: "text-rail-2",
  };
  const GIT_TONE = { warn: "text-warn", ok: "text-ok", bad: "text-bad" } as const;

  function toggleHiddenFiles() {
    const held = cursorEntry?.path;
    settings.sftp.showHiddenFiles = !settings.sftp.showHiddenFiles;
    if (held === undefined) return;
    const at = shownEntries.findIndex((entry) => entry.path === held);
    cursor = at < 0 ? -1 : (hasParent ? 1 : 0) + at;
  }

  // The row and empty-area menus expose the header's controls and state.
  // Flatten its sort group: ContextMenu has one level of inline expansion.
  function panelMenu(): MenuItem[] {
    const items: MenuItem[] = [];
    if (mutable) {
      items.push({
        kind: "submenu", key: "view", icon: "eye", label: t("list.view"),
        items: menuActions(viewMenu(FILE_SCHEMA, fileOrder, listMenuText(listLabels), {
          order: (o) => orderBy(o.sort as FileSort),
        }, viewExtra)),
      });
      items.push({
        kind: "submenu", key: "search", icon: "search", label: t("sftp.menuSearch"),
        items: [
          { label: t("sftp.searchName"), onSelect: () => listHeader?.focusFilter() },
          ...(adapter.search ? [{ label: t("search.contentSearch"), onSelect: () => (search.open = true) }] : []),
        ],
      });
    }
    items.push({
      kind: "submenu", key: "folder", icon: "folder", label: t("sftp.menuFolder"),
      items: [
        { label: t("ctx.refresh"), onSelect: refresh },
        ...(onToggleFollowTerminal ? [{
          label: t("sftp.followTerminalMenu"), checked: followTerminal, onSelect: onToggleFollowTerminal,
        }] : []),
        ...(onSync ? [{ label: syncActive ? t("sync.runningButton") : t("sftp.syncFiles"), onSelect: onSync }] : []),
      ],
    });
    return items;
  }

  /**
   * Order the listing by `next`. The row under the keyboard cursor stays under
   * it: the cursor is an index, and the same index is another file after a sort.
   */
  function orderBy(next: FileSort) {
    const held = cursorEntry?.path ?? null;
    setListOrder("files", { sort: next, group: NO_GROUPS });
    if (held === null) return;
    const at = shownEntries.findIndex((x) => x.path === held);
    if (at >= 0) cursor = (hasParent ? 1 : 0) + at;
  }
  /** A click on a column title: that column, or the same one the other way round. */
  function orderByColumn(key: SortKey) {
    orderBy(nextSort(sortNow, key));
  }
  function openToolbarMenu(e: MouseEvent) {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [];
    items.push({
      icon: "folderPlus",
      label: t("sftp.newFolder"),
      disabled: !mutable,
      onSelect: () => {
        showMkdir = true;
        showMkfile = false;
      },
    });
    items.push({
      icon: "filePlus",
      label: t("sftp.newFile"),
      disabled: !mutable,
      onSelect: () => {
        showMkfile = true;
        showMkdir = false;
      },
    });
    if (onSync) {
      items.push({
        icon: "sync",
        label: syncActive ? t("sync.runningButton") : t("sync.button"),
        onSelect: onSync,
      });
    }
    ctxMenu = { x: box.right, y: box.bottom + 2, items };
  }
  const cursorOnParent = $derived(hasParent && cursor === 0);
  const cursorEntry = $derived.by(() =>
    cursor < 0 || cursorOnParent ? null : (shownEntries[hasParent ? cursor - 1 : cursor] ?? null),
  );
  const cursorPath = $derived(cursorEntry?.path ?? null);

  function selectedEntries(): FileEntry[] {
    return entries.filter((e) => selection.selected.has(e.path));
  }

  function rowClick(e: MouseEvent, entry: FileEntry) {
    if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
    if (consumeFileDragClick()) {
      return;
    }
    cursor = (hasParent ? 1 : 0) + shownEntries.findIndex((x) => x.path === entry.path);
    selection = clickSelect(
      selection,
      entry.path,
      { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey },
      shownEntries.map((x) => x.path),
    );
  }

  // A click on empty space in the list (not on a row or button) clears selection.
  function onBackgroundClick(e: MouseEvent) {
    const el = e.target as HTMLElement;
    if (!el.closest('[role="treeitem"]') && !el.closest("button") && selection.selected.size)
      selection = emptySelection();
  }

  function ensureCursorVisible() {
    if (cursor < 0 || !listEl) return;
    // Cursor is already an absolute row index (".." included), so no header offset.
    // The sticky column header covers the top of the scroller: the rows have
    // that much less to be seen in.
    const top = scrollForCursor(cursor, ROW_H, listViewportH - headH, listScrollTop, 0);
    if (top !== listScrollTop) {
      listEl.scrollTop = top;
      listScrollTop = top;
    }
  }

  // All keyboard interaction is driven from the focusable list container, so the
  // individual rows don't each need key handlers (roving focus at the tree level).
  function onListKeydown(e: KeyboardEvent) {
    const order = shownEntries.map((x) => x.path);
    const pageRows = Math.max(1, Math.floor(listViewportH / ROW_H));
    const nav = nextCursor(e.key, cursor, rowCount, pageRows);
    if (nav !== null) {
      e.preventDefault();
      const prev = cursor;
      cursor = nav;
      // Plain arrow moves the cursor frame only; Shift+arrow extends a range.
      if (e.shiftKey && !(hasParent && cursor === 0)) {
        const path = shownEntries[hasParent ? cursor - 1 : cursor].path;
        let sel = selection;
        if (!sel.anchor && prev >= 0 && !(hasParent && prev === 0)) {
          const start = shownEntries[hasParent ? prev - 1 : prev].path;
          sel = { selected: new Set([start]), anchor: start };
        }
        selection = clickSelect(sel, path, { toggle: false, range: true }, order);
      }
      ensureCursorVisible();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    // Letters via chordLetter: raw e.key is "ф"/"с"/"м" on the Russian layout.
    if (e.key === "Enter" || e.key === "ArrowRight") {
      if (cursorOnParent) {
        e.preventDefault();
        goUp();
      } else if (cursorEntry) {
        e.preventDefault();
        if (cursorEntry.isDir) enterDir(cursorEntry);
        else open(cursorEntry);
      }
    } else if (e.key === "ArrowLeft") {
      if (hasParent) {
        e.preventDefault();
        goUp();
      }
    } else if (e.key === " ") {
      if (cursorEntry) {
        e.preventDefault();
        selection = clickSelect(selection, cursorEntry.path, { toggle: true, range: false }, order);
      }
    } else if (e.key === "Escape") {
      if (search.open) search.open = false;
      else if (selection.selected.size) selection = emptySelection();
    } else if (mod && chordLetter(e) === "a") {
      e.preventDefault();
      selection = { selected: new Set(order), anchor: selection.anchor };
    } else if (e.key === "Delete" || e.key === "Backspace") {
      const items = selectedEntries();
      if (items.length) {
        e.preventDefault();
        deleteTargets = items;
      }
    } else if (e.key === "F2") {
      if (cursorEntry) {
        e.preventDefault();
        startRename(cursorEntry);
      }
    } else if (mod && chordLetter(e) === "x") {
      e.preventDefault();
      cutOrCopy("cut");
    } else if (mod && chordLetter(e) === "c") {
      e.preventDefault();
      if (e.shiftKey) copyPaths();
      else cutOrCopy("copy");
    } else if (mod && chordLetter(e) === "v") {
      e.preventDefault();
      paste();
    }
  }

  function cutOrCopy(mode: "cut" | "copy") {
    const items = selectedEntries().map((e) => ({ path: e.path, name: e.name }));
    if (items.length) clipboard = { mode, items };
  }

  async function copyPaths() {
    const paths = selectedEntries().map((e) => e.path);
    if (!paths.length) return;
    await writeClipboard(paths.join("\n"));
    notifySuccess(t("sftp.pathCopied", { count: paths.length }), { source: "files", sessionId: sessionKey });
  }

  // ── Right-click menus ───────────────────────────────────────────────────────
  // Surface actions that already exist as toolbar buttons / shortcuts. A right-click
  // on a row outside the current selection first selects just that row.
  function openRowMenu(e: MouseEvent, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    if (!selection.selected.has(entry.path)) {
      selection = { selected: new Set([entry.path]), anchor: entry.path };
      cursor = (hasParent ? 1 : 0) + shownEntries.findIndex((x) => x.path === entry.path);
    }
    const sel = selectedEntries();
    const multi = sel.length > 1;
    const items: MenuItem[] = [];
    // A unit of systemd, a site of nginx (ADR 0077): what is done to it, first.
    const own = !multi && projKind && onProjectCommand ? rowActions(projKind, cwd, entry) : [];
    for (const a of own) {
      items.push({
        icon: a.ask === "always" ? "alert" : "terminal",
        label: t(a.label),
        danger: a.ask === "always",
        hint: asks(a, prod) ? t("project.asks") : undefined,
        onSelect: () => (asks(a, prod) ? (projAsk = { action: { ...a, label: a.label }, helm: false }) : send(a)),
      });
    }
    if (own.length > 0) items.push({ kind: "separator" });
    if (!multi) {
      items.push({
        icon: entry.isDir ? "folder" : "file",
        label: t("ctx.open"),
        onSelect: () => (entry.isDir ? enterDir(entry) : open(entry)),
      });
      if (entry.isDir && onUserNavigate) {
        items.push({
          icon: "terminal",
          label: t("ctx.cdHere"),
          onSelect: () => onUserNavigate?.(entry.path),
        });
      }
      if (!entry.isDir && adapter.download) {
        items.push({ icon: "download", label: t("ctx.download"), onSelect: () => adapter.download?.(entry) });
      }
    }
    // Pipelines (ADR 0068): a pipeline file, a workflows folder, or several of them.
    const asPipelines = sel.filter((e) => (e.isDir ? isPipelineDir(e.path) : pipelineKindOf(e.path) !== null));
    if (onPipelines && asPipelines.length === sel.length && sel.length > 0) {
      const one = !multi && !entry.isDir;
      items.push({
        icon: "hierarchy",
        label: one ? t("ctx.pipelineSchema") : t("ctx.pipelinesSchema"),
        onSelect: () => onPipelines?.(sel.map((e) => ({ path: e.path, isDir: e.isDir }))),
      });
    }
    // Copy to another open session (v1.12): its server, or — a local tab —
    // this machine. Offered only where there is somewhere to copy to.
    const targets = sessionKey ? targetsFrom(copyTargetList(), sessionKey) : [];
    if (sessionKey && targets.length > 0) {
      const from = sessionKey;
      items.push({
        kind: "submenu",
        key: "copyTo",
        icon: "arrowRight",
        label: t("ctx.copyTo"),
        items: targets.map((target) => ({
          icon: target.local ? "terminal" : "server",
          label: target.title,
          onSelect: () =>
            requestCopy({ from, local: !!adapter.local, to: target.sessionId, entries: sel }),
        })),
      });
    }
    if (!multi) {
      items.push({ kind: "separator" });
      items.push({ icon: "pencil", label: t("ctx.rename"), onSelect: () => startRename(entry) });
    }
    items.push({ icon: "arrowsUpDown", label: t("ctx.cut"), onSelect: () => cutOrCopy("cut") });
    items.push({ icon: "copy", label: t("ctx.copy"), onSelect: () => cutOrCopy("copy") });
    if (clipboard) {
      items.push({ icon: "paperclip", label: t("ctx.paste"), onSelect: () => paste() });
    }
    items.push({ icon: "copy", label: t("ctx.copyPath"), onSelect: () => copyPaths() });
    if (!multi) {
      items.push({
        icon: "copy",
        label: t("ctx.copyName"),
        onSelect: () => void writeClipboard(entry.name),
      });
    }
    items.push({ kind: "separator" });
    items.push({
      icon: "trash",
      danger: true,
      label: multi ? t("ctx.deleteN", { count: sel.length }) : t("ctx.delete"),
      onSelect: () => (deleteTargets = sel),
    });
    items.push({ kind: "separator" }, ...panelMenu());
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }

  function openBackgroundMenu(e: MouseEvent) {
    // Rows handle their own menu; only the empty listing area lands here. Nothing
    // can be created/pasted at a non-mutable (synthetic) level.
    if ((e.target as HTMLElement).closest('[role="treeitem"]')) return;
    e.preventDefault();
    const items: MenuItem[] = [];
    if (mutable) {
      items.push({
        icon: "folderPlus",
        label: t("ctx.newFolder"),
        onSelect: () => {
          mkdirName = "";
          showMkdir = true;
        },
      });
      items.push({
        icon: "filePlus",
        label: t("ctx.newFile"),
        onSelect: () => {
          mkfileName = "";
          showMkfile = true;
        },
      });
      if (adapter.upload) {
        items.push({ icon: "upload", label: t("ctx.uploadHere"), onSelect: () => uploadFiles() });
      }
      if (clipboard) {
        items.push({ icon: "paperclip", label: t("ctx.paste"), onSelect: () => paste() });
      }
      items.push({ kind: "separator" });
    }
    // The folder shown holds pipelines — a repository, a `.github`, a workflows folder.
    if (onPipelines && (isPipelineDir(cwd) || holdsPipelines(entries.map((x) => x.name)))) {
      items.push({
        icon: "hierarchy",
        label: t("ctx.pipelinesSchema"),
        onSelect: () => onPipelines?.([{ path: cwd, isDir: true }]),
      });
      items.push({ kind: "separator" });
    }
    items.push(...panelMenu());
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }

  async function paste() {
    const cb = clipboard;
    if (!cb || !mutable) return;
    // Copying onto an existing name duplicates it as "… copy" (Finder-style) rather
    // than skipping; moving still refuses to clobber.
    const taken = new Set(entries.map((e) => e.name));
    let done = 0;
    let skipped = 0;
    let hardError = "";
    let lastName = "";
    for (const item of cb.items) {
      const name = pasteTargetName(cb.mode, item.name, taken);
      const dest = joinPath(cwd, name);
      try {
        if (cb.mode === "cut") await adapter.rename(item.path, dest);
        else await adapter.copy(item.path, dest);
        taken.add(name);
        done += 1;
        lastName = name;
      } catch (e) {
        const msg = String(e);
        if (isDestExists(msg)) skipped += 1;
        else hardError = msg;
      }
    }
    await refresh();
    if (cb.mode === "cut") clipboard = null; // sources moved away
    const okKey = cb.mode === "cut" ? "sftp.moved" : "sftp.copied";
    const okKeyMulti = cb.mode === "cut" ? "sftp.movedMulti" : "sftp.copiedMulti";
    if (done === 1) notifySuccess(t(okKey, { name: lastName, dest: cwd }), { source: "files", sessionId: sessionKey });
    else if (done > 1) notifySuccess(t(okKeyMulti, { count: done, dest: cwd }), { source: "files", sessionId: sessionKey });
    if (skipped) notifyError(t("sftp.moveSkipped", { count: skipped }), { source: "files", sessionId: sessionKey });
    if (hardError) notifyError(t("sftp.moveFailed", { name: lastName, error: hardError }), { source: "files", sessionId: sessionKey });
  }

  function startRename(entry: FileEntry) {
    renameTarget = entry;
    renameName = entry.name;
  }

  async function commitRename() {
    const target = renameTarget;
    const name = renameName.trim();
    if (!target || !name || name === target.name) {
      renameTarget = null;
      return;
    }
    renameTarget = null;
    try {
      await adapter.rename(target.path, joinPath(cwd, name));
      await refresh();
      notifySuccess(t("sftp.renamed", { name }), { source: "files", sessionId: sessionKey });
    } catch (e) {
      const msg = String(e);
      if (isDestExists(msg)) notifyError(t("sftp.moveConflict", { name, dest: cwd }), { source: "files", sessionId: sessionKey });
      else notifyError(String(e), { source: "files", sessionId: sessionKey });
    }
  }

  let listEl = $state<HTMLDivElement>();
  let moveTarget = $state<{ items: FileEntry[]; destDir: string } | null>(null);

  // ── Dragging rows (v1.13) ───────────────────────────────────────────────────
  // The panel says what is picked up and marks what can be dropped on; the drag
  // itself is the store's (`stores/filedrag`). This panel is destroyed whenever
  // its tab stops being on screen — and files held over another tab put that
  // tab on screen: a drag kept here would end the moment it reached somewhere.

  /** What this panel answers to in a drag: its session, or itself when it has none. */
  const panelKey = $derived(sessionKey ?? `panel:${testPrefix}`);
  /** Rows of this panel are in the air. */
  const carrying = $derived(
    fileDrag.files !== null && !fileDrag.guest && fileDrag.files.from === panelKey,
  );

  function startMove(e: PointerEvent, entry: FileEntry) {
    if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
    beginFileDrag(e, () => {
      // Dragging a row that isn't part of the selection makes it the selection.
      if (!selection.selected.has(entry.path)) {
        selection = { selected: new Set([entry.path]), anchor: entry.path };
      }
      return {
        from: panelKey,
        local: !!adapter.local,
        label: "",
        entries: selectedEntries().map(({ path, name, isDir }) => ({ path, name, isDir })),
      };
    });
  }

  // Rows of this panel were let go of over one of its own folders: the move it
  // always did, asked about first. All selected rows live in the current dir;
  // only the structurally valid moves are kept.
  $effect(() => {
    const asked = pendingMoveRequest();
    if (!asked || asked.session !== panelKey) return;
    untrack(() => {
      const request = takeMoveRequest();
      if (!request) return;
      const paths = new Set(request.paths);
      const items = entries.filter(
        (x) => paths.has(x.path) && checkMove(x.path, request.dir).ok,
      );
      if (items.length) moveTarget = { items, destDir: request.dir };
    });
  });

  /** Is `dir` the folder the files in the air would be dropped into? */
  function dropOk(dir: string | null): boolean {
    const over = fileDrag.over;
    return (
      dir !== null &&
      fileDrag.files !== null &&
      over?.kind === "folder" &&
      over.session === panelKey &&
      over.dir === dir
    );
  }

  /** The files in the air would land in this panel as a whole — its folder, or just "here". */
  const panelTargeted = $derived.by(() => {
    const over = fileDrag.over;
    if (fileDrag.files === null || !over || over.session !== panelKey) return false;
    return over.kind === "session" || over.dir === cwd;
  });

  async function doMove() {
    const m = moveTarget;
    moveTarget = null;
    if (!m) return;
    let moved = 0;
    let skipped = 0;
    let hardError = "";
    let lastName = "";
    for (const entry of m.items) {
      const chk = checkMove(entry.path, m.destDir);
      if (!chk.ok) continue;
      try {
        await adapter.rename(entry.path, joinPath(m.destDir, entry.name));
        moved += 1;
        lastName = entry.name;
      } catch (e) {
        const msg = String(e);
        if (isDestExists(msg)) skipped += 1;
        else hardError = msg;
      }
    }
    await refresh();
    if (moved === 1) notifySuccess(t("sftp.moved", { name: lastName, dest: m.destDir }), { source: "files", sessionId: sessionKey });
    else if (moved > 1) notifySuccess(t("sftp.movedMulti", { count: moved, dest: m.destDir }), { source: "files", sessionId: sessionKey });
    if (skipped) notifyError(t("sftp.moveSkipped", { count: skipped }), { source: "files", sessionId: sessionKey });
    if (hardError) notifyError(t("sftp.moveFailed", { name: lastName, error: hardError }), { source: "files", sessionId: sessionKey });
  }

  // No refresh here: the adapter reports the batch to the dock store, and the
  // revision effect below re-lists — also in a panel remounted mid-upload.
  async function uploadFiles() {
    if (adapter.upload) await adapter.upload(cwd);
  }


  // Re-list when an upload batch into the shown folder has ended (dockstate
  // `dirRev`). Only a bump of the SAME folder counts: navigating elsewhere reads
  // that folder's revision too, which must not trigger a second listing. A hidden
  // panel waits — it re-lists on coming back into view.
  let seenRev = { dir: "", rev: 0 };
  $effect(() => {
    if (!sessionKey) return;
    const dir = cwd;
    const rev = dirRevision(sessionKey, dir);
    untrack(() => {
      const bumped = dir === seenRev.dir && rev > seenRev.rev;
      seenRev = { dir, rev };
      if (bumped && visible && isConnected) refresh();
    });
  });

  // What is selected here, for a copy started from the command palette (v1.12).
  // Only a panel on screen says so; hidden or gone, it takes its word back.
  $effect(() => {
    if (!sessionKey) return;
    const key = sessionKey;
    const picked = visible && isConnected ? selectedEntries() : [];
    setFileSelection(key, picked.length > 0 ? { local: !!adapter.local, entries: picked } : null);
    return () => setFileSelection(key, null);
  });

  /** `ls`-style colour for a file name, from the active terminal palette. */
  function nameStyle(entry: FileEntry): string {
    const key = lsColorKey(entry);
    return key ? `color:${activeTerminalTheme()[key]}` : "";
  }

  /** What a comparison mark says, beside the server's name (ADR 0064). */
  const MARK_LABEL = {
    same: "groupUpload.markSame",
    differs: "groupUpload.markDiffers",
    absent: "groupUpload.markAbsent",
    unknown: "groupUpload.markUnknown",
  } as const satisfies Record<Mark, string>;

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  /** Width of the collapsed strip (matches the w-9 = 36px rail). */
  const COLLAPSED_W = 36;
</script>

<!-- The content search: the field, its two switches and the results. One content
     for the two places it stands in — under the path bar of a narrow panel, in
     the pane beside the listing of a wide one (`fill`: take the pane's height). -->
{#snippet searchBox(fill: boolean)}
  <div class="flex flex-col {fill ? 'min-h-0 flex-1' : ''}">
    <form
      class="flex gap-1"
      onsubmit={(e) => {
        e.preventDefault();
        void runSearch();
      }}
    >
      <!-- eslint-disable-next-line vterm/filter-field -- a search of the files' contents (grep on the host), not a filter of the listing -->
      <input
        class="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-text outline-none focus:border-accent"
        placeholder={t("search.contentPlaceholder")}
        data-testid="{testPrefix}-search-input"
        bind:value={search.query}
      />
      <button
        class="shrink-0 rounded bg-accent px-2 py-1 text-xs text-panel-alt"
        disabled={searching}
      >
        {searching ? t("search.searching") : t("search.go")}
      </button>
    </form>
    <div class="mt-1 flex gap-3 text-meta text-muted">
      <label class="flex items-center gap-1">
        <input type="checkbox" bind:checked={search.caseSensitive} />
        {t("search.caseSensitive")}
      </label>
      <label class="flex items-center gap-1">
        <input type="checkbox" bind:checked={search.regex} />
        {t("search.regex")}
      </label>
    </div>
    {#if search.outcome}
      {@const more = moreLimit(search.outcome, search.searched.limit)}
      <div class="mt-1 flex flex-col {fill ? 'min-h-0 flex-1' : ''}">
        <GrepResults
          outcome={search.outcome}
          query={search.searched.query}
          caseSensitive={search.searched.caseSensitive}
          regex={search.searched.regex}
          limit={Math.max(search.searched.limit, GREP_LIMIT)}
          {fill}
          onopen={openMatch}
          onmore={more === null ? undefined : () => void runSearch(more)}
          moreBusy={searching}
        />
      </div>
    {/if}
  </div>
{/snippet}

<div
  style={embedded ? "" : `width: ${collapsed ? uiPx(COLLAPSED_W) : width}px`}
  class="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-panel-alt {embedded
    ? ''
    : 'border-l border-edge'} {!embedded && animateWidth
    ? 'transition-[width] duration-200 ease-out'
    : ''} {panelTargeted ? 'ring-2 ring-inset ring-accent' : ''}"
  data-file-panel={panelKey}
>
  {#if !embedded && collapsed}
    <div class="flex w-9 flex-col items-center gap-3 py-2">
      <button
        class="rounded p-1 text-muted hover:bg-edge hover:text-text"
        use:tooltip={expandLabel}
        aria-label={expandLabel}
        onclick={() => (collapsed = false)}
      >
        <Icon name="chevronLeft" size={16} />
      </button>
      <span class="text-caption uppercase tracking-wider text-muted [writing-mode:vertical-rl]">
        {stripLabel}
      </span>
    </div>
  {:else}
    <!-- Inner content is absolutely pinned to the panel's fixed right edge at the
         full expanded width, so during a width animation the moving left border
         reveals it (clip) rather than the content sliding (WebKit clips an absolute
         child reliably every frame; an oversized static flex child flickered). -->
    <div
      class={embedded ? "flex h-full min-h-0 flex-col" : "absolute inset-y-0 right-0 flex flex-col"}
      style={embedded ? "" : `width: ${width}px`}
      use:wideWhen={(w) => (wide = w)}
      data-wide={wide}
    >
      <!-- Toolbar. When embedded and not yet connected (SFTP), the bar would hold only
           a redundant label — the tab already names it — so it's dropped. -->
      {#if isConnected || !embedded}
        <div
          class="flex items-center gap-1 border-b border-edge px-2 py-1.5 text-xs"
          use:measureToolbar
          data-testid="{testPrefix}-toolbar"
        >
          {#if !embedded}
            <button
              class="rounded p-1 text-muted hover:bg-edge hover:text-text"
              use:tooltip={collapseLabel}
              aria-label={collapseLabel}
              onclick={() => (collapsed = true)}
            >
              <Icon name="chevronRight" size={16} />
            </button>
          {/if}
          {#if isConnected}
            <button
              class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-text"
              data-row-key="refresh"
              use:tooltip={t("sftp.refresh")}
              aria-label={t("sftp.refresh")}
              onclick={refresh}
            >
              <Icon name="refresh" size={14} />
            </button>
            <button
              data-row-key="follow"
              data-testid="{testPrefix}-follow-terminal"
              class="flex items-center rounded p-1.5 {followTerminal
                ? 'bg-edge text-accent'
                : 'text-muted hover:bg-edge hover:text-text'}"
              use:tooltip={t("sftp.followTerminal")}
              aria-label={t("sftp.followTerminal")}
              aria-pressed={followTerminal}
              onclick={() => onToggleFollowTerminal?.()}
            >
              <Icon name="terminal" size={14} />
            </button>
            {#if !compactToolbar}
              <button
                class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
                data-row-key="newFolder"
                use:tooltip={t("sftp.newFolder")}
                aria-label={t("sftp.newFolder")}
                disabled={!mutable}
                onclick={() => {
                  showMkdir = !showMkdir;
                  if (showMkdir) showMkfile = false;
                }}
              >
                <Icon name="folderPlus" size={14} />
              </button>
              <button
                data-row-key="newFile"
                data-testid="{testPrefix}-new-file"
                class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
                use:tooltip={t("sftp.newFile")}
                aria-label={t("sftp.newFile")}
                disabled={!mutable}
                onclick={() => {
                  showMkfile = !showMkfile;
                  if (showMkfile) showMkdir = false;
                }}
              >
                <Icon name="filePlus" size={14} />
              </button>
            {/if}
            {#if adapter.search}
              <button
                class="ml-auto flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-text"
                data-row-key="search"
                use:tooltip={t("search.contentSearch")}
                aria-label={t("search.contentSearch")}
                onclick={() => (search.open = !search.open)}
              >
                <Icon name="search" size={14} />
              </button>
            {/if}
            {#if onSync && !compactToolbar}
              <!-- A compare or run going on in the background shows here: the
                   button reopens its dialog. -->
              <button
                data-row-key="sync"
                data-testid="{testPrefix}-sync"
                class="flex items-center rounded p-1.5 hover:text-accent {syncActive
                  ? 'text-accent'
                  : 'text-muted'}"
                use:tooltip={syncActive ? t("sync.runningButton") : t("sync.button")}
                aria-label={syncActive ? t("sync.runningButton") : t("sync.button")}
                onclick={() => onSync?.()}
              >
                <Icon name="sync" size={14} class={syncActive ? "animate-spin" : ""} />
              </button>
            {/if}
            {#if adapter.upload}
              <button
                class="flex items-center rounded p-1.5 text-muted hover:text-accent"
                data-row-key="upload"
                use:tooltip={t("sftp.upload")}
                aria-label={t("sftp.upload")}
                onclick={uploadFiles}
              >
                <Icon name="upload" size={14} />
              </button>
            {/if}
            {#if compactToolbar}
              <button
                data-row-key="more"
                data-testid="{testPrefix}-toolbar-more"
                class="flex shrink-0 items-center rounded p-1.5 text-muted hover:bg-edge hover:text-text"
                use:tooltip={t("topbar.more")}
                aria-label={t("topbar.more")}
                aria-haspopup="menu"
                onclick={openToolbarMenu}
              >
                <Icon name="dots" size={14} strokeWidth={3} />
              </button>
            {/if}
            {#if !adapter.search && !embedded}
              <!-- No search button to take ml-auto, so the strip label anchors right. -->
              <span class="ml-auto uppercase tracking-wider text-muted">{stripLabel}</span>
            {/if}
          {:else}
            <span class="ml-1 uppercase tracking-wider text-muted">{stripLabel}</span>
          {/if}
        </div>
      {/if}

      {#if requiresConnect && !connected}
        <!-- Not yet connected: offer an explicit Connect action (SFTP). -->
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-xs">
          <button
            class="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-40"
            disabled={!sessionReady || connecting}
            onclick={connect}
          >
            {connecting ? t("sftp.connecting") : t("common.connect")}
          </button>
          <p class="text-muted">
            {sessionReady ? t("sftp.openForSession") : t("sftp.connectFirst")}
          </p>
          {#if error}
            <p class="break-words text-danger">{error}</p>
          {/if}
        </div>
      {:else}
        {@render banner?.()}
        {#if projInfo}
          <!-- The folder is a project (ADR 0071, 0077): what it is, its branch and
               facts, and the commands of its kind — one click from the folder. -->
          <ProjectStrip
            info={projInfo}
            facts={projFacts}
            git={gitInfo}
            actions={onProjectCommand || onProject ? projActs.filter((a) => (a.opens?.startsWith("scenarios") ? !!onProject && !!project : a.opens ? !!onOpenPanel : !!onProjectCommand)) : []}
            tasks={onProjectCommand ? projTasks : []}
            tasksFile={projInfo.tasksFile}
            {prod}
            last={lastShown}
            pinned={project && onPinProject ? (projectPinned?.(project.kind, cwd) ?? false) : null}
            testid="{testPrefix}-project"
            onrun={runProject}
            ontask={runTask}
            onopen={project && onProject ? () => onProject?.(project.kind, cwd, "open") : undefined}
            onpin={project && onPinProject ? () => onPinProject?.(project.kind, cwd) : undefined}
            onmenu={(x, y, items) => (ctxMenu = { x, y, items })}
          />
        {/if}
        {#if hiddenGenerated > 0}
          <button
            type="button"
            class="mx-2 mt-1 flex items-center gap-1 text-meta text-muted hover:text-text"
            data-testid="{testPrefix}-generated-hidden"
            onclick={() => (settings.sftp.hideGenerated = false)}
          ><Icon name="folderOff" size={11} />{t("project.generatedHidden", { n: hiddenGenerated })}</button>
        {/if}
        {#if mutable}
          <!-- The filter row: the name in this folder and «View» with the order
               and hidden files. Context menus reuse these controls and state. -->
          <ListHeader
            bind:this={listHeader}
            items={visibleEntries}
            schema={FILE_SCHEMA}
            filter={nameFilter}
            onfilter={setNameFilter}
            order={fileOrder}
            onorder={(o) => orderBy(o.sort as FileSort)}
            shown={shownEntries.length}
            total={visibleEntries.length}
            labels={listLabels}
            placeholder={t("sftp.filterName")}
            {wide}
            onmenu={(m) => (ctxMenu = m)}
            extra={viewExtra}
            testid="{testPrefix}-header"
          />
        {/if}
        <!-- The listing's column and — in a wide panel — the column beside it. -->
        <div class="relative flex min-h-0 flex-1" bind:clientWidth={rowWidth} data-testid="{testPrefix}-row">
        <div
          class="flex min-h-0 min-w-0 flex-col {sideOpen ? 'shrink-0' : 'flex-1'}"
          style:width={sideOpen ? partWidth("files", rowWidth) : null}
          data-morph
          data-testid="{testPrefix}-main"
        >
        <!-- Current path, click-to-edit (Phase 39.2). A synthetic (non-mutable) cwd
             shows its label rather than its sentinel. -->
        {#if editingPath}
          <input
            bind:this={pathInputEl}
            bind:value={pathDraft}
            data-testid="path-input"
            class="w-full border-b border-edge bg-transparent px-2 py-1 text-xs text-text outline-none focus:border-accent"
            placeholder={t("path.placeholder")}
            aria-label={t("path.placeholder")}
            spellcheck="false"
            autocomplete="off"
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPath();
              } else if (e.key === "Escape") {
                e.preventDefault();
                editingPath = false;
              }
              // Arrow/Home/End must reach the input, not the list's roving focus.
              e.stopPropagation();
            }}
            onblur={() => (editingPath = false)}
          />
        {:else}
          <button
            class="w-full truncate border-b border-edge px-2 py-1 text-left text-xs text-muted hover:text-text"
            title={mutable ? cwd : syntheticLabel}
            aria-label={t("path.edit")}
            data-testid="path-bar"
            onclick={beginEditPath}
          >
            {mutable ? cwd : syntheticLabel}
          </button>
        {/if}

        {#if searchOpen && !beside}
          <!-- Content search (grep) under the current folder -->
          <div class="border-b border-edge px-2 py-1.5" data-testid="{testPrefix}-search-inline">
            {@render searchBox(false)}
          </div>
        {/if}

        {#if showMkdir}
          <form
            class="flex gap-1 border-b border-edge px-2 py-1"
            onsubmit={(e) => {
              e.preventDefault();
              createFolder();
            }}
          >
            <input
              class="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-text outline-none focus:border-accent"
              placeholder={t("sftp.folderNamePlaceholder")}
              bind:value={mkdirName}
            />
            <button class="rounded bg-accent px-2 py-1 text-xs text-panel-alt">{t("common.ok")}</button>
          </form>
        {/if}

        {#if showMkfile}
          <form
            class="flex gap-1 border-b border-edge px-2 py-1"
            onsubmit={(e) => {
              e.preventDefault();
              createFile();
            }}
          >
            <input
              class="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-text outline-none focus:border-accent"
              placeholder={t("sftp.fileNamePlaceholder")}
              bind:value={mkfileName}
            />
            <button class="rounded bg-accent px-2 py-1 text-xs text-panel-alt">{t("common.ok")}</button>
          </form>
        {/if}

        {#if renameTarget}
          <!-- svelte-ignore a11y_autofocus -->
          <form
            class="flex gap-1 border-b border-edge px-2 py-1"
            onsubmit={(e) => {
              e.preventDefault();
              commitRename();
            }}
          >
            <input
              autofocus
              class="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-text outline-none focus:border-accent"
              placeholder={t("sftp.renamePlaceholder")}
              bind:value={renameName}
              onkeydown={(e) => e.key === "Escape" && (renameTarget = null)}
            />
            <button class="rounded bg-accent px-2 py-1 text-xs text-panel-alt">{t("common.rename")}</button>
          </form>
        {/if}

        <!-- Error banner (non-blocking: the listing stays visible) -->
        {#if error}
          <div
            class="flex items-start gap-2 border-b border-edge bg-danger/10 px-2 py-1 text-xs text-danger"
          >
            <span class="min-w-0 flex-1 break-words">{error}</span>
            <button
              class="flex shrink-0 items-center hover:text-text"
              aria-label={t("common.dismiss")}
              onclick={() => (error = "")}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        {/if}

        <!-- Listing -->
        <div
          bind:this={listEl}
          bind:clientHeight={listViewportH}
          onscroll={onListScroll}
          onkeydown={onListKeydown}
          onclick={onBackgroundClick}
          oncontextmenu={openBackgroundMenu}
          onfocus={() => {
            if (cursor < 0 && shownEntries.length) cursor = 0;
          }}
          role="tree"
          tabindex="0"
          data-testid="{testPrefix}-list"
          data-file-cwd={isConnected && mutable ? cwd : undefined}
          class="@container min-h-0 flex-1 overflow-y-auto text-sm outline-none [overflow-anchor:none] {carrying
            ? 'cursor-grabbing'
            : ''}"
          style="{columnVars(columns.widths, COLS)}; --list-h: {listViewportH}px"
        >
          <!-- Column titles. Wide: the table's columns; the header repeats a
               row's structure cell for cell (widths, paddings, the actions
               box), so its borders stand over the rows' borders and it shrinks
               as they do. Narrow: the two columns the list shows, over the name
               and the size, and the order menu over the actions box. One
               header, so one measured height for the cursor to stay clear of. -->
          {#if !loading && mutable}
            <div
              bind:offsetHeight={headH}
              class="sticky top-0 z-10 flex items-stretch gap-2 border-b border-edge bg-panel-alt px-2 text-meta font-medium text-muted"
              data-testid="{testPrefix}-columns"
            >
              <div class="flex min-w-0 flex-1 items-center gap-2 py-1 @wide:hidden" data-testid="{testPrefix}-sorthead">
                <span class="min-w-0 flex-1">
                  <SortTitle
                    label={t("sftp.colName")}
                    sorted={sortedBy("name")}
                    onsort={() => orderByColumn("name")}
                    testid="{testPrefix}-sorthead-name"
                  />
                </span>
                <span class="shrink-0">
                  <SortTitle
                    label={t("sftp.colSize")}
                    sorted={sortedBy("size")}
                    onsort={() => orderByColumn("size")}
                    testid="{testPrefix}-sorthead-size"
                    align="right"
                  />
                </span>
              </div>
              <!-- Over the actions box: the order, while it is by a column the
                   narrow list does not show — the «View» menu changes it. -->
              <div class="flex w-16 shrink-0 items-center justify-end @wide:hidden">
                {#if hiddenSortKey}
                  <span
                    data-testid="{testPrefix}-sort"
                    class="flex items-center gap-0.5 px-1 py-0.5 text-accent"
                    use:tooltip={`${t("sftp.sort")}: ${COLUMN_LABEL[sortNow.key]()}, ${t(sortNow.dir === "asc" ? "list.asc" : "list.desc")}`}
                  >
                    <Icon name={sortNow.dir === "asc" ? "arrowUp" : "arrowDown"} size={11} />
                    <span class="max-w-12 truncate">{COLUMN_LABEL[sortNow.key]()}</span>
                  </span>
                {/if}
              </div>
              <div class="hidden min-w-0 flex-1 items-stretch @wide:flex" data-testid="{testPrefix}-tablehead">
                <ColumnHead
                  col="files.name"
                  label={t("sftp.colName")}
                  class="w-[var(--c-name)] pr-2"
                  sorted={sortedBy("name")}
                  onsort={() => orderByColumn("name")}
                />
                <span class="w-[5.5rem] min-w-0 border-r border-edge px-2 py-1">
                  <SortTitle
                    label={t("sftp.colSize")}
                    sorted={sortedBy("size")}
                    onsort={() => orderByColumn("size")}
                    testid="column-sort-files.size"
                    align="right"
                  />
                </span>
                <span class="w-[6.5rem] min-w-0 border-r border-edge px-2 py-1">
                  <SortTitle
                    label={t("sftp.colMode")}
                    sorted={sortedBy("mode")}
                    onsort={() => orderByColumn("mode")}
                    testid="column-sort-files.mode"
                  />
                </span>
                <ColumnHead
                  col="files.owner"
                  label={t("sftp.colOwner")}
                  class="w-[var(--c-owner)] px-2"
                  sorted={sortedBy("owner")}
                  onsort={() => orderByColumn("owner")}
                />
                <span class="w-[9rem] min-w-0 px-2 py-1">
                  <SortTitle
                    label={t("sftp.colModified")}
                    sorted={sortedBy("modified")}
                    onsort={() => orderByColumn("modified")}
                    testid="column-sort-files.modified"
                  />
                </span>
              </div>
              <span class="hidden w-16 shrink-0 @wide:block"></span>
            </div>
          {/if}
          {#if loading}
            <div data-testid="{testPrefix}-skeleton" class="py-1">
              {#each Array(7) as _, i (i)}
                <div class="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton width="15px" height="15px" class="shrink-0" />
                  <Skeleton width="{45 + ((i * 17) % 40)}%" height="0.7rem" />
                </div>
              {/each}
            </div>
          {:else}
            <!-- Virtual window: total height sizes the scrollbar, the inner block is
                 translated to the first visible row (Phase 18.7). -->
            <div style="height: {win.totalHeight}px; position: relative;">
              <!-- `overflow-anchor: none` on the scroller: rows above the view are
                   swapped as it scrolls, and Chromium's scroll anchoring (WebView2;
                   WebKit has none) "corrected" scrollTop for each swap — the list
                   jerked under a touchpad fling on Windows only. -->
              <div
                style="transform: translateY({win.padTop}px);"
                class={listScrolling ? "pointer-events-none" : ""}
              >
                {#each visibleItems as item (item.key)}
                  {#if item.entry === null}
                    <button
                      data-drop={parentPath ?? undefined}
                      onclick={() => (cursor = 0)}
                      class="flex h-7 w-full items-center gap-2 px-2 text-left {dropOk(parentPath)
                        ? 'bg-accent/20 ring-1 ring-inset ring-accent'
                        : 'hover:bg-edge'} {cursorOnParent
                        ? 'outline outline-1 -outline-offset-1 outline-accent/70'
                        : ''}"
                      ondblclick={goUp}
                      aria-label={t("sftp.goUp")}
                      use:tooltip={t("sftp.goUp")}
                    >
                      <Icon name="folder" size={15} class="text-muted" />
                      <span class="truncate text-muted">..</span>
                    </button>
                  {:else}
                    {@const entry = item.entry}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- Keyboard is handled at the focusable tree container (roving focus).
                         The row itself is not a <button> so Space toggles selection via
                         the container handler instead of activating a button. -->
                    {#if drives && entry.drive}
                      <!-- Synthetic drive row of the "This PC" level (Phase 39.1):
                           navigable, but not draggable, droppable or deletable. -->
                      {@const d = entry.drive}
                      {@const used = driveUsedFraction(d)}
                      {@const usage = driveUsage(d)}
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <div
                        onclick={(e) => rowClick(e, entry)}
                        ondblclick={() => open(entry)}
                        role="treeitem"
                        aria-selected={selection.selected.has(entry.path)}
                        tabindex="-1"
                        class="flex h-7 cursor-pointer items-center gap-2 px-2 {selection.selected.has(
                          entry.path,
                        )
                          ? 'bg-accent/25'
                          : 'hover:bg-edge'} {cursorPath === entry.path
                          ? 'outline outline-1 -outline-offset-1 outline-accent/70'
                          : ''}"
                      >
                        <Icon name={driveIcon(d)} size={15} class="shrink-0 text-muted" />
                        <span class="truncate">{driveDisplayName(entry.name, d)}</span>
                        {#if usage}
                          <!-- Capacity bar + "X free of Y", like Explorer. -->
                          <span
                            class="ml-auto h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-edge"
                            aria-hidden="true"
                          >
                            <span
                              class="block h-full rounded-full {used != null && used > 0.9
                                ? 'bg-danger'
                                : 'bg-accent'}"
                              style="width: {Math.round((used ?? 0) * 100)}%"
                            ></span>
                          </span>
                          <span class="shrink-0 text-xs text-muted">
                            {t("drive.freeOf", {
                              free: fmtSize(usage.free),
                              total: fmtSize(usage.total),
                            })}
                          </span>
                        {:else}
                          <!-- Not probed (network/optical) or unreadable: name the kind
                               rather than render "0 B free of 0 B". -->
                          <span class="ml-auto shrink-0 text-xs text-muted">{t(driveKindKey(d))}</span>
                        {/if}
                      </div>
                    {:else}
                      {@const look = rowLook(entry, roles.get(entry.path) ?? "plain", projKind)}
                      {@const gmark = gitInfo?.marks.get(entry.name)}
                      {@const ignored = gitInfo?.ignored.has(entry.name) ?? false}
                      <div
                        data-drop={entry.isDir ? entry.path : undefined}
                        onpointerdown={(e) => startMove(e, entry)}
                        onclick={(e) => rowClick(e, entry)}
                        oncontextmenu={(e) => openRowMenu(e, entry)}
                        ondblclick={() => open(entry)}
                        role="treeitem"
                        aria-selected={selection.selected.has(entry.path)}
                        tabindex="-1"
                        class="group flex h-7 cursor-grab items-center gap-2 px-2 @wide:items-stretch {dropOk(entry.path)
                          ? 'bg-accent/20 ring-1 ring-inset ring-accent'
                          : selection.selected.has(entry.path)
                            ? 'bg-accent/25'
                            : 'hover:bg-edge'} {cursorPath === entry.path
                          ? 'outline outline-1 -outline-offset-1 outline-accent/70'
                          : ''} {carrying && selection.selected.has(entry.path) ? 'opacity-50' : ''}"
                      >
                        <!-- Narrow: name, and a file's size at the right edge.
                             Wide: the same cells stand as table columns, joined
                             by permissions, owner and the modified time — what
                             the tooltip holds in a narrow dock. A folder has no
                             size to show: its cell stays, empty. -->
                        <div
                          class="flex min-w-0 flex-1 items-center gap-2 text-left @wide:items-stretch @wide:gap-0"
                          use:tooltip={fileTooltip(entry)}
                        >
                          <div class="flex min-w-0 flex-1 items-center gap-2 @wide:w-[var(--c-name)] @wide:flex-initial @wide:border-r @wide:border-edge/40 @wide:pr-2">
                            <Icon
                              name={look.icon}
                              size={15}
                              class="shrink-0 {look.tone ? TONE[look.tone] : 'text-muted'} {look.dim || ignored ? 'opacity-50' : ''}"
                            />
                            <span
                              class="truncate {look.strong ? 'font-medium' : ''} {look.warnName ? 'text-warn' : ''} {look.dim || ignored ? 'opacity-50' : ''}"
                              style={look.warnName ? "" : nameStyle(entry)}
                            >{entry.name}</span>
                            {#if look.after === "entry"}
                              <Icon name="play" size={9} class="shrink-0 text-accent" />
                            {:else if look.after === "link"}
                              <Icon name="symlink" size={11} class="shrink-0 text-ok" />
                            {/if}
                            {#if look.dim}
                              <span class="shrink-0 rounded border border-edge px-1 text-caption text-muted" data-testid="{testPrefix}-generated">{t("project.generated")}</span>
                            {/if}
                            {#if gmark}
                              <span
                                class="ml-auto shrink-0 font-mono text-caption {GIT_TONE[markTone(gmark)]}"
                                data-testid="{testPrefix}-git-mark"
                                use:tooltip={t(`project.git.${gmark === "•" ? "inside" : gmark}`)}
                              >{gmark}</span>
                            {/if}
                            {#if rowMark}
                              {@const marks = rowMark(entry)}
                              {#if marks}
                                <span
                                  class="ml-auto flex shrink-0 items-center gap-0.5 pl-1"
                                  data-testid="{testPrefix}-group-marks"
                                  use:tooltip={marks.map((m) => `${m.label}: ${t(MARK_LABEL[m.mark])}`).join("\n")}
                                >
                                  {#each marks as m, i (i)}
                                    <span class="size-1.5 rounded-full {MARK_DOT[m.mark]}" data-mark={m.mark}></span>
                                  {/each}
                                </span>
                              {/if}
                            {/if}
                          </div>
                          <span
                            class="ml-auto shrink-0 truncate text-xs text-muted @wide:ml-0 @wide:block @wide:w-[5.5rem] @wide:shrink @wide:px-2 @wide:text-right @wide:tabular-nums {entry.isDir ? 'hidden' : ''} {CELL}"
                            data-testid="{testPrefix}-col-size"
                          >{entry.isDir ? "" : fmtSize(entry.size)}</span>
                          <span class="hidden truncate font-mono text-xs text-muted @wide:block @wide:w-[6.5rem] @wide:px-2 {CELL}" data-testid="{testPrefix}-col-mode">{formatMode(entry.mode, entry.isDir, entry.isSymlink, entry.attrs)}</span>
                          <span class="hidden truncate text-xs text-muted @wide:block @wide:w-[var(--c-owner)] @wide:px-2 {CELL}" data-testid="{testPrefix}-col-owner">{ownerLabel(entry)}</span>
                          <span class="hidden truncate text-xs tabular-nums text-muted @wide:block @wide:w-[9rem] @wide:px-2 @wide:py-1.5 @wide:leading-4" data-testid="{testPrefix}-col-modified">{formatModified(entry.modified)}</span>
                        </div>
                        <div
                          data-nodrag
                          class="invisible flex w-16 shrink-0 items-center justify-end gap-1 group-hover:visible"
                        >
                          {#if !entry.isDir && onOpenFile}
                            <button
                              class="rounded p-0.5 text-muted hover:text-accent"
                              use:tooltip={t("sftp.editFile")}
                              aria-label={t("sftp.editFile")}
                              onclick={() => onOpenFile?.(entry.path, entry.name)}
                            >
                              <Icon name="pencil" size={13} />
                            </button>
                          {/if}
                          {#if adapter.download}
                            <button
                              class="rounded p-0.5 text-muted hover:text-accent"
                              use:tooltip={entry.isDir ? t("sftp.downloadFolder") : t("sftp.download")}
                              aria-label={entry.isDir ? t("sftp.downloadFolder") : t("sftp.download")}
                              onclick={() => adapter.download?.(entry)}
                            >
                              <Icon name="download" size={13} />
                            </button>
                          {/if}
                          <button
                            class="rounded p-0.5 text-muted hover:text-danger"
                            use:tooltip={t("common.delete")}
                            aria-label={t("common.delete")}
                            onclick={() => (deleteTargets = [entry])}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        </div>
                      </div>
                    {/if}
                  {/if}
                {/each}
              </div>
            </div>
            {#if shownEntries.length === 0 && isFiltered(nameFilter)}
              <FilteredEmpty
                summary={filterSummary(FILE_SCHEMA, nameFilter, listMenuText({}))}
                onreset={() => setNameFilter(NO_FILTER)}
                testid="{testPrefix}-filtered-empty"
              />
            {:else if shownEntries.length === 0}
              <div class="px-3 py-4 text-xs text-muted">{t("sftp.emptyDir")}</div>
            {/if}
          {/if}
        </div>

        {#if !beside}{@render footer?.()}{/if}
        </div>
        {#if sideOpen}
          <!-- The border between the listing and what stands beside it is dragged
               (`PanelDivider`); the share is the store's, one for every session. -->
          <PanelDivider split="files" width={rowWidth} />
          <div class="flex min-h-0 min-w-0 flex-1 flex-col text-xs" data-testid="{testPrefix}-side" in:aside={motion(MOTION_BASE)} out:aside={motion(MOTION_BASE)}>
            {#if searchOpen}
              <div class="min-h-0 flex-1">
                <SidePane
                  title={t("search.contentSearch")}
                  onclose={() => (search.open = false)}
                  testid="{testPrefix}-side-search"
                >
                  {@render searchBox(true)}
                </SidePane>
              </div>
            {/if}
            {#if footerShown}
              <!-- The footer (transfers): all of the column while nothing else is
                   in it, the lower part of it under the search. Closed by hand,
                   and only once nothing is under way. -->
              <div
                class="{searchOpen ? 'max-h-[45%] shrink-0' : 'min-h-0 flex-1'} flex flex-col"
                data-testid="{testPrefix}-side-footer"
              >
                <SidePane
                  title={t("sftp.transfersTitle")}
                  onclose={footerCount === 0 ? () => (footerKept = false) : undefined}
                  testid="{testPrefix}-side-transfers"
                >
                  {#if footerCount > 0}
                    <div class="min-h-0 overflow-auto">{@render footer?.()}</div>
                  {:else}
                    <p class="text-caption text-muted" data-testid="{testPrefix}-no-transfers">
                      {t("sftp.noTransfers")}
                    </p>
                  {/if}
                </SidePane>
              </div>
            {/if}
          </div>
        {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- Delete confirmation (shared ConfirmDialog: modal z-40 + focus trap). -->
<ConfirmDialog
  open={deleteTargets.length > 0}
  title={t("sftp.deleteTitle")}
  confirmLabel={t("common.delete")}
  danger
  onconfirm={() => removeMany(deleteTargets)}
  oncancel={() => (deleteTargets = [])}
>
  {#if deleteTargets.length === 1}
    {deleteTargets[0].isDir ? t("sftp.folder") : t("sftp.file")}: <span class="break-all text-text"
      >{deleteTargets[0].path}</span
    >
  {:else if deleteTargets.length > 1}
    {t("sftp.deleteMulti", { count: deleteTargets.length })}
  {/if}
</ConfirmDialog>

<!-- Move confirmation (drag-to-move within the panel). -->
<ConfirmDialog
  open={!!moveTarget}
  title={t("sftp.moveTitle")}
  confirmLabel={t("sftp.moveConfirm")}
  onconfirm={doMove}
  oncancel={() => (moveTarget = null)}
>
  {#if moveTarget}
    {moveTarget.items.length === 1
      ? t("sftp.moveBody", { name: moveTarget.items[0].name, dest: moveTarget.destDir })
      : t("sftp.moveBodyMulti", { count: moveTarget.items.length, dest: moveTarget.destDir })}
  {/if}
</ConfirmDialog>

<!-- A project's command that changes things (ADR 0077): said in full before it is typed. -->
<ConfirmDialog
  open={!!projAsk}
  title={projAsk?.helm ? t("project.helmTitle") : t("project.askTitle", { what: projAsk ? t(projAsk.action.label) : "" })}
  confirmLabel={t("project.toTerminal")}
  danger={prod || projAsk?.action.ask === "always"}
  onconfirm={confirmProject}
  oncancel={() => (projAsk = null)}
>
  {#if projAsk}
    {#if projAsk.helm}
      <div class="mb-3 grid grid-cols-[6rem_1fr] items-center gap-x-2 gap-y-1.5" data-testid="{testPrefix}-helm-form">
        <label for="{testPrefix}-helm-release">{t("project.helmRelease")}</label>
        <input id="{testPrefix}-helm-release" class="rounded border border-edge bg-panel px-2 py-1 text-text" bind:value={helmForm.release} />
        <label for="{testPrefix}-helm-ns">{t("project.helmNamespace")}</label>
        <input id="{testPrefix}-helm-ns" class="rounded border border-edge bg-panel px-2 py-1 text-text" bind:value={helmForm.namespace} />
        <label for="{testPrefix}-helm-values">{t("project.helmValues")}</label>
        <select id="{testPrefix}-helm-values" class="rounded border border-edge bg-panel px-2 py-1 text-text" bind:value={helmForm.values}>
          <option value={null}>{t("project.helmNoValues")}</option>
          {#each valuesFiles as v (v)}<option value={v}>{v}</option>{/each}
        </select>
      </div>
    {/if}
    <div class="break-all rounded border border-edge bg-panel-alt px-2 py-1.5 font-mono text-text" data-testid="{testPrefix}-ask-command">
      {projAsk.helm ? (helmArgv ? helmArgv.join(" ") : t("project.helmInvalid")) : askText(projAsk.action)}
    </div>
    <p class="mt-2">{t("project.askFolder", { dir: cwd })}{#if kubeContext && (projKind === "kustomize" || projKind === "k8s" || projKind === "helm")} · {t("project.askContext", { context: kubeContext })}{/if}</p>
    {#if prod}<p class="mt-2 text-bad">{t("project.askProd")}</p>{/if}
  {/if}
</ConfirmDialog>

<ContextMenu menu={ctxMenu} onclose={() => (ctxMenu = null)} />
