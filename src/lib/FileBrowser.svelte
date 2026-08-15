<script lang="ts">
  // Shared file-browser panel (Phase 44.8) — the unified body of SftpPanel and
  // LocalFilePanel, which were near-identical copies. Everything shared (selection,
  // keyboard roving focus, clipboard cut/copy/paste, drag-to-move, click-to-edit
  // path bar, mkdir/mkfile/rename forms, virtualized list, context menus) lives here
  // once; the two kinds differ only via the injected `adapter` (transport + the two
  // navigation semantics that genuinely diverge) and a few capability flags. See
  // filebrowser.ts for the contract and why this exists.
  import { onDestroy, onMount, tick, untrack, type Snippet } from "svelte";
  import { tooltip } from "./actions/tooltip";
  import { type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { pickUploadFiles } from "./api";
  import { writeClipboard } from "./clipboard";
  import { dropTargetAt, passedThreshold } from "./actions/drag";
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
  import type { GrepMatch } from "./sync";
  import type { FileEntry } from "./types";
  import { fileIconName } from "./fileicon";
  import { lsColorKey, fileTooltip } from "./lscolors";
  import { driveDisplayName, driveIcon, driveKindKey, driveUsage, driveUsedFraction } from "./drives";
  import { windowRange } from "./virtuallist";
  import { filterHiddenFiles } from "./util";
  import { activeTerminalTheme, settings } from "./settings.svelte";
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import { dockState, type FilesDockState } from "./stores/dockstate.svelte";
  import { t } from "./i18n";

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
    /** Extra footer content, e.g. the SFTP transfers list. */
    footer,
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
    footer?: Snippet;
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
  const ROW_H = 28;
  let listScrollTop = $state(0);
  let listViewportH = $state(600);
  const shownEntries = $derived(filterHiddenFiles(entries, settings.sftp.showHiddenFiles));
  const rowCount = $derived((hasParent ? 1 : 0) + shownEntries.length);
  const win = $derived(windowRange(listScrollTop, listViewportH, ROW_H, rowCount));
  const visibleItems = $derived(buildVisibleItems(win.start, win.end, hasParent, shownEntries));

  let dragOver = $state(false);

  let showMkdir = $state(false);
  let mkdirName = $state("");
  let showMkfile = $state(false);
  let mkfileName = $state("");
  let deleteTargets = $state<FileEntry[]>([]);
  let renameTarget = $state<FileEntry | null>(null);
  let renameName = $state("");

  // Content search (grep), SFTP only — gated by the adapter exposing `search`.
  let showSearch = $state(false);
  let searchQuery = $state("");
  let searchResults = $state<GrepMatch[] | null>(null);
  let searching = $state(false);
  let caseSensitive = $state(false);
  let useRegex = $state(false);

  async function runSearch() {
    const q = searchQuery.trim();
    if (!q || !adapter.search) return;
    searching = true;
    try {
      searchResults = await adapter.search(cwd || ".", q, !caseSensitive, !useRegex);
    } catch (e) {
      notifyError(String(e));
      searchResults = [];
    } finally {
      searching = false;
    }
  }

  function openMatch(m: GrepMatch) {
    const name = m.path.split("/").pop() ?? m.path;
    onOpenFile?.(joinPath(cwd, m.path), name, m.line);
  }

  const unlisten: UnlistenFn[] = [];

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
      } catch {
        /* fall back to "." */
      }
    }
    await load(start);
  }

  onMount(async () => {
    if (adapter.uploadPaths) {
      unlisten.push(
        await getCurrentWebview().onDragDropEvent((ev) => {
          // The listener is window-wide, so a panel that is merely hidden behind
          // another dock tab would otherwise swallow drops meant for nobody and
          // upload them into a directory the user cannot see.
          if (!isConnected || !visible) return;
          if (ev.payload.type === "enter" || ev.payload.type === "over") dragOver = true;
          else if (ev.payload.type === "leave") dragOver = false;
          else if (ev.payload.type === "drop") {
            dragOver = false;
            uploadPaths(ev.payload.paths);
          }
        }),
      );
    }
    // Resume where this session's panel was left off; otherwise a kind without a
    // connect step lists immediately on mount.
    const saved = sessionKey ? dockState(sessionKey).files : null;
    if (saved?.connected && saved.cwd) await restore(saved);
    else if (!requiresConnect) await loadStart();
  });

  onDestroy(() => unlisten.forEach((u) => u()));

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
  async function load(path: string) {
    loading = true;
    try {
      const next = await adapter.list(path);
      cwd = path;
      entries = next;
      error = "";
      selection = emptySelection();
      cursor = -1;
      persist();
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
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
      notifySuccess(t("sftp.folderCreated", { name }));
    } catch (e) {
      notifyError(String(e));
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
      notifySuccess(t("sftp.fileCreated", { name }));
    } catch (e) {
      notifyError(String(e));
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
    if (targets.length === 1 && !failed) notifySuccess(t("sftp.deleted", { name: lastName }));
    else if (!failed) notifySuccess(t("sftp.deleted", { name: `${targets.length}` }));
    if (failed) notifyError(failed);
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
    if (suppressNextClick) {
      suppressNextClick = false;
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
    const top = scrollForCursor(cursor, ROW_H, listViewportH, listScrollTop, 0);
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
      if (showSearch) showSearch = false;
      else if (selection.selected.size) selection = emptySelection();
    } else if (mod && (e.key === "a" || e.key === "A")) {
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
    } else if (mod && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      cutOrCopy("cut");
    } else if (mod && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      if (e.shiftKey) copyPaths();
      else cutOrCopy("copy");
    } else if (mod && (e.key === "v" || e.key === "V")) {
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
    notifySuccess(t("sftp.pathCopied", { count: paths.length }));
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
    items.push({ icon: "refresh", label: t("ctx.refresh"), onSelect: () => refresh() });
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
    if (done === 1) notifySuccess(t(okKey, { name: lastName, dest: cwd }));
    else if (done > 1) notifySuccess(t(okKeyMulti, { count: done, dest: cwd }));
    if (skipped) notifyError(t("sftp.moveSkipped", { count: skipped }));
    if (hardError) notifyError(t("sftp.moveFailed", { name: lastName, error: hardError }));
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
      notifySuccess(t("sftp.renamed", { name }));
    } catch (e) {
      const msg = String(e);
      if (isDestExists(msg)) notifyError(t("sftp.moveConflict", { name, dest: cwd }));
      else notifyError(String(e));
    }
  }

  let listEl = $state<HTMLDivElement>();
  let dragCandidate: FileEntry | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let suppressNextClick = false;
  let dragEntry = $state<FileEntry | null>(null);
  let dragX = $state(0);
  let dragY = $state(0);
  let dropDir = $state<string | null>(null);
  let moveTarget = $state<{ items: FileEntry[]; destDir: string } | null>(null);

  function startMove(e: PointerEvent, entry: FileEntry) {
    if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
    dragCandidate = entry;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
  }

  function listPointerMove(e: PointerEvent) {
    if (!dragCandidate || !listEl) return;
    if (!dragEntry) {
      if (!passedThreshold(dragStartX, dragStartY, e.clientX, e.clientY, 5)) return;
      // Dragging a row that isn't part of the selection makes it the selection.
      if (!selection.selected.has(dragCandidate.path))
        selection = { selected: new Set([dragCandidate.path]), anchor: dragCandidate.path };
      dragEntry = dragCandidate;
      listEl.setPointerCapture(e.pointerId);
      window.getSelection()?.removeAllRanges();
    }
    dragX = e.clientX;
    dragY = e.clientY;
    dropDir = dropTargetAt(e.clientX, e.clientY);
  }

  function listPointerUp(e: PointerEvent) {
    const entry = dragEntry;
    const dir = dropDir;
    if (entry) {
      try {
        listEl?.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      if (dir !== null) {
        // All selected rows live in the current dir; keep only structurally-valid moves.
        const items = entries.filter(
          (x) => selection.selected.has(x.path) && checkMove(x.path, dir).ok,
        );
        if (items.length) moveTarget = { items, destDir: dir };
      }
      suppressNextClick = true;
    }
    dragCandidate = null;
    dragEntry = null;
    dropDir = null;
  }

  /** Is `dir` the folder under the pointer, and a valid drop for the dragged row? */
  function dropOk(dir: string | null): boolean {
    return (
      dragEntry !== null && dir !== null && dropDir === dir && checkMove(dragEntry.path, dir).ok
    );
  }

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
    if (moved === 1) notifySuccess(t("sftp.moved", { name: lastName, dest: m.destDir }));
    else if (moved > 1) notifySuccess(t("sftp.movedMulti", { count: moved, dest: m.destDir }));
    if (skipped) notifyError(t("sftp.moveSkipped", { count: skipped }));
    if (hardError) notifyError(t("sftp.moveFailed", { name: lastName, error: hardError }));
  }

  async function uploadFiles() {
    if (adapter.upload) await adapter.upload(cwd);
    await refresh();
  }

  async function uploadPaths(paths: string[]) {
    if (adapter.uploadPaths) await adapter.uploadPaths(cwd, paths);
    await refresh();
  }

  /** `ls`-style colour for a file name, from the active terminal palette. */
  function nameStyle(entry: FileEntry): string {
    const key = lsColorKey(entry);
    return key ? `color:${activeTerminalTheme()[key]}` : "";
  }

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

<div
  style={embedded ? "" : `width: ${collapsed ? COLLAPSED_W : width}px`}
  class="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-panel-alt {embedded
    ? ''
    : 'border-l border-edge'} {!embedded && animateWidth
    ? 'transition-[width] duration-200 ease-out'
    : ''} {adapter.uploadPaths && dragOver ? 'ring-2 ring-inset ring-accent' : ''}"
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
    >
      <!-- Toolbar. When embedded and not yet connected (SFTP), the bar would hold only
           a redundant label — the tab already names it — so it's dropped. -->
      {#if isConnected || !embedded}
        <div class="flex items-center gap-1 border-b border-edge px-2 py-1.5 text-xs">
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
              use:tooltip={t("sftp.refresh")}
              aria-label={t("sftp.refresh")}
              onclick={refresh}
            >
              <Icon name="refresh" size={14} />
            </button>
            <button
              data-testid="{testPrefix}-toggle-hidden"
              class="flex items-center rounded p-1.5 {settings.sftp.showHiddenFiles
                ? 'bg-edge text-accent'
                : 'text-muted hover:bg-edge hover:text-text'}"
              use:tooltip={t("sftp.hiddenFiles")}
              aria-label={t("sftp.hiddenFiles")}
              aria-pressed={settings.sftp.showHiddenFiles}
              onclick={() => (settings.sftp.showHiddenFiles = !settings.sftp.showHiddenFiles)}
            >
              <Icon name="eye" size={14} />
            </button>
            <button
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
            <button
              class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
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
            {#if adapter.search}
              <button
                class="ml-auto flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-text"
                use:tooltip={t("search.contentSearch")}
                aria-label={t("search.contentSearch")}
                onclick={() => (showSearch = !showSearch)}
              >
                <Icon name="search" size={14} />
              </button>
            {/if}
            {#if onSync}
              <button
                class="flex items-center rounded p-1.5 text-muted hover:text-accent"
                use:tooltip={t("sync.button")}
                aria-label={t("sync.button")}
                onclick={() => onSync?.()}
              >
                <Icon name="sync" size={14} />
              </button>
            {/if}
            {#if adapter.upload}
              <button
                class="flex items-center rounded p-1.5 text-muted hover:text-accent"
                use:tooltip={t("sftp.upload")}
                aria-label={t("sftp.upload")}
                onclick={uploadFiles}
              >
                <Icon name="upload" size={14} />
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

        {#if showSearch && adapter.search}
          <!-- Content search (grep) under the current folder -->
          <div class="border-b border-edge px-2 py-1.5">
            <form
              class="flex gap-1"
              onsubmit={(e) => {
                e.preventDefault();
                runSearch();
              }}
            >
              <input
                class="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-text outline-none focus:border-accent"
                placeholder={t("search.contentPlaceholder")}
                bind:value={searchQuery}
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
                <input type="checkbox" bind:checked={caseSensitive} />
                {t("search.caseSensitive")}
              </label>
              <label class="flex items-center gap-1">
                <input type="checkbox" bind:checked={useRegex} />
                {t("search.regex")}
              </label>
            </div>
            {#if searchResults}
              <div class="mt-1 max-h-48 overflow-auto rounded border border-edge">
                {#each searchResults as m (m.path + ":" + m.line)}
                  <button
                    class="block w-full truncate px-2 py-1 text-left text-meta hover:bg-edge"
                    onclick={() => openMatch(m)}
                    title={m.text}
                  >
                    <span class="text-accent">{m.path}:{m.line}</span>
                    <span class="text-muted">{m.text}</span>
                  </button>
                {:else}
                  <div class="px-2 py-2 text-meta text-muted">{t("search.noResults")}</div>
                {/each}
              </div>
            {/if}
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
          onscroll={(e) => (listScrollTop = e.currentTarget.scrollTop)}
          onpointermove={listPointerMove}
          onpointerup={listPointerUp}
          onpointercancel={listPointerUp}
          onkeydown={onListKeydown}
          onclick={onBackgroundClick}
          oncontextmenu={openBackgroundMenu}
          onfocus={() => {
            if (cursor < 0 && shownEntries.length) cursor = 0;
          }}
          role="tree"
          tabindex="0"
          class="min-h-0 flex-1 overflow-y-auto text-sm outline-none {dragEntry
            ? 'select-none cursor-grabbing'
            : ''}"
        >
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
              <div style="transform: translateY({win.padTop}px);">
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
                      <div
                        data-drop={entry.isDir ? entry.path : undefined}
                        onpointerdown={(e) => startMove(e, entry)}
                        onclick={(e) => rowClick(e, entry)}
                        oncontextmenu={(e) => openRowMenu(e, entry)}
                        ondblclick={() => open(entry)}
                        role="treeitem"
                        aria-selected={selection.selected.has(entry.path)}
                        tabindex="-1"
                        class="group flex h-7 cursor-grab items-center gap-2 px-2 {dropOk(entry.path)
                          ? 'bg-accent/20 ring-1 ring-inset ring-accent'
                          : selection.selected.has(entry.path)
                            ? 'bg-accent/25'
                            : 'hover:bg-edge'} {cursorPath === entry.path
                          ? 'outline outline-1 -outline-offset-1 outline-accent/70'
                          : ''} {dragEntry && selection.selected.has(entry.path) ? 'opacity-50' : ''}"
                      >
                        <div
                          class="flex min-w-0 flex-1 items-center gap-2 text-left"
                          use:tooltip={fileTooltip(entry)}
                        >
                          <Icon name={fileIconName(entry)} size={15} class="shrink-0 text-muted" />
                          <span class="truncate" style={nameStyle(entry)}>{entry.name}</span>
                          {#if !entry.isDir}
                            <span class="ml-auto shrink-0 text-xs text-muted">{fmtSize(entry.size)}</span>
                          {/if}
                        </div>
                        <div
                          data-nodrag
                          class="invisible flex shrink-0 items-center gap-1 group-hover:visible"
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
            {#if shownEntries.length === 0}
              <div class="px-3 py-4 text-xs text-muted">{t("sftp.emptyDir")}</div>
            {/if}
          {/if}
        </div>

        {@render footer?.()}
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

<!-- Drag ghost (pointer-events-none so elementFromPoint still sees the drop row). -->
{#if dragEntry}
  <div
    class="pointer-events-none fixed z-50 flex items-center gap-1 rounded border border-accent bg-panel px-2 py-1 text-xs shadow-lg"
    style="left: {dragX + 12}px; top: {dragY + 8}px;"
  >
    <Icon name={fileIconName(dragEntry)} size={13} class="text-muted" />
    <span class="font-medium text-text">
      {selection.selected.size > 1
        ? t("sftp.dragCount", { count: selection.selected.size })
        : dragEntry.name}
    </span>
  </div>
{/if}

<ContextMenu menu={ctxMenu} onclose={() => (ctxMenu = null)} />
