<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { tooltip } from "./actions/tooltip";
  import { type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import {
    pickSaveDir,
    pickSavePath,
    pickUploadFiles,
    sftpCancel,
    sftpCreateFile,
    sftpDelete,
    sftpDownload,
    sftpGrep,
    sftpHome,
    sftpList,
    sftpMkdir,
    sftpRename,
    sftpCopy,
    sftpUpload,
    type SftpProgress,
  } from "./api";
  import { writeClipboard } from "./clipboard";
  import { dropTargetAt, passedThreshold } from "./actions/drag";
  import { checkMove, parentDir, uniqueCopyName } from "./filemove";
  import { clickSelect, emptySelection, type SelectionState } from "./multiselect";
  import { nextCursor, scrollForCursor } from "./filekeys";
  import type { GrepMatch } from "./sync";
  import type { FileEntry } from "./types";
  import { fileIconName } from "./fileicon";
  import { lsColorKey, fileTooltip } from "./lscolors";
  import { windowRange } from "./virtuallist";
  import { filterHiddenFiles } from "./util";
  import { activeTerminalTheme, settings } from "./settings.svelte";
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";
  import SyncModal from "./SyncModal.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import { transfersState } from "./stores/transfers.svelte";
  import { t } from "./i18n";

  let {
    sessionId,
    width = 384,
    collapsed = $bindable(false),
    sessionReady = false,
    animateWidth = true,
    embedded = false,
    terminalCwd = null,
    followTerminal = false,
    onToggleFollowTerminal,
    onOpenFile,
    onUserNavigate,
  }: {
    sessionId: string;
    /** Panel width in px (controlled by the parent's resize handle). */
    width?: number;
    /** Collapsed to a thin strip; bindable so the strip's button can expand. */
    collapsed?: boolean;
    /** Whether the terminal session is connected (enables the Connect button). */
    sessionReady?: boolean;
    /** Animate width changes (collapse). Disabled while the user drags-resizes. */
    animateWidth?: boolean;
    /** Render content-only (Phase 17.2): the shared RightDock owns collapse/tabs. */
    embedded?: boolean;
    /** Latest terminal cwd (OSC 7); the panel follows it while `followTerminal` is on. */
    terminalCwd?: string | null;
    /** Follow the terminal's cwd — per-tab toggle (state owned by the page). */
    followTerminal?: boolean;
    onToggleFollowTerminal?: () => void;
    /** Open a file in the in-app editor (optionally jumping to a line, e.g. grep). */
    onOpenFile?: (path: string, name: string, gotoLine?: number) => void;
    /**
     * The user navigated to a folder in the panel (not via following the terminal).
     * With follow-terminal on this cds the terminal too — two-way OSC 7 sync.
     */
    onUserNavigate?: (path: string) => void;
  } = $props();

  /** Mirror a user-initiated folder change into the terminal when following. */
  function syncTerminalCwd(path: string) {
    if (followTerminal) onUserNavigate?.(path);
  }

  let cwd = $state("");
  let entries = $state<FileEntry[]>([]);
  let loading = $state(false);

  // Virtualized listing (Phase 18.7): only the visible window of rows is rendered,
  // so a directory with tens of thousands of entries doesn't freeze the UI. Rows
  // are a fixed `h-7` (28px); the ".." parent-nav is item 0 of the unified list.
  const ROW_H = 28;
  let listScrollTop = $state(0);
  let listViewportH = $state(600);
  const hasParent = $derived(!!cwd && cwd !== "/");
  // Dotfiles are hidden unless the toolbar eye toggle (settings.sftp.showHiddenFiles)
  // is on. Filtering the derived listing keeps the raw `entries` intact.
  const shownEntries = $derived(filterHiddenFiles(entries, settings.sftp.showHiddenFiles));
  const rowCount = $derived((hasParent ? 1 : 0) + shownEntries.length);
  const win = $derived(windowRange(listScrollTop, listViewportH, ROW_H, rowCount));
  const visibleItems = $derived.by(() => {
    const items: { key: string; entry: FileEntry | null }[] = [];
    for (let i = win.start; i < win.end; i++) {
      if (hasParent && i === 0) items.push({ key: "..", entry: null });
      else {
        const e = shownEntries[i - (hasParent ? 1 : 0)];
        items.push({ key: e.path, entry: e });
      }
    }
    return items;
  });
  let error = $state("");
  let dragOver = $state(false);
  // SFTP connects on demand (button) rather than automatically on mount.
  let connected = $state(false);
  let connecting = $state(false);

  let showMkdir = $state(false);
  let mkdirName = $state("");
  let showMkfile = $state(false);
  let mkfileName = $state("");
  let deleteTargets = $state<FileEntry[]>([]);
  let renameTarget = $state<FileEntry | null>(null);
  let renameName = $state("");
  let showSync = $state(false);
  // Content search (grep over SSH).
  let showSearch = $state(false);
  let searchQuery = $state("");
  let searchResults = $state<GrepMatch[] | null>(null);
  let searching = $state(false);
  let caseSensitive = $state(false);
  let useRegex = $state(false);

  async function runSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    searching = true;
    try {
      searchResults = await sftpGrep(sessionId, cwd || ".", q, !caseSensitive, !useRegex);
    } catch (e) {
      notifyError(String(e));
      searchResults = [];
    } finally {
      searching = false;
    }
  }

  function openMatch(m: GrepMatch) {
    const name = m.path.split("/").pop() ?? m.path;
    onOpenFile?.(join(cwd, m.path), name, m.line);
  }

  const unlisten: UnlistenFn[] = [];

  // Transfer progress lives in a shared store (also read by the status-bar
  // indicator); the `sftp://progress` subscription is owned by +page.svelte.
  const transferList = $derived(Object.values(transfersState.map));

  /** Open the SFTP subsystem and list the home directory (button-triggered). */
  async function connect() {
    connecting = true;
    error = "";
    // When following the terminal and its cwd is known, open there directly instead
    // of home — avoids a home→cwd flash right after connecting.
    let start = followTerminal && terminalCwd ? terminalCwd : ".";
    if (!(followTerminal && terminalCwd)) {
      try {
        start = await sftpHome(sessionId);
      } catch {
        /* fall back to "." */
      }
    }
    await load(start);
    connecting = false;
    connected = error === "";
  }

  onMount(async () => {
    unlisten.push(
      await getCurrentWebview().onDragDropEvent((ev) => {
        if (!connected) return;
        if (ev.payload.type === "enter" || ev.payload.type === "over") {
          dragOver = true;
        } else if (ev.payload.type === "leave") {
          dragOver = false;
        } else if (ev.payload.type === "drop") {
          dragOver = false;
          uploadPaths(ev.payload.paths);
        }
      }),
    );
  });

  onDestroy(() => unlisten.forEach((u) => u()));

  /**
   * List `path` and, only if it succeeds, make it the current directory.
   * On failure (e.g. permission denied) the current listing is kept and the
   * error is shown as a banner — so the user is never stuck in a dir they
   * couldn't actually enter.
   */
  async function load(path: string) {
    loading = true;
    try {
      const next = await sftpList(sessionId, path);
      cwd = path;
      entries = next;
      error = "";
      selection = emptySelection();
      cursor = -1;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function refresh() {
    load(cwd || ".");
  }

  // Follow the terminal: when the toggle is on and a new terminal cwd arrives (OSC 7),
  // navigate there. Deps are followTerminal/terminalCwd/connected only — `cwd` is read
  // untracked so the user's own SFTP navigation isn't snapped back, and a successful
  // load (which sets `cwd`) doesn't re-trigger this effect.
  $effect(() => {
    if (!followTerminal || !terminalCwd || !connected) return;
    untrack(() => {
      if (terminalCwd !== cwd) load(terminalCwd);
    });
  });

  function open(entry: FileEntry) {
    // Any file can be opened in the editor (binary/oversize files are rejected by
    // the backend read with a toast); directories navigate.
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

  /** Go up a level. After navigating, keep focus on the list and put the cursor
   *  on the folder we just came out of (so arrow keys continue from there). */
  async function goUp() {
    if (!hasParent) return;
    const fromPath = cwd;
    const parent = parentDir(cwd);
    await load(parent);
    syncTerminalCwd(parent);
    await tick();
    const idx = shownEntries.findIndex((e) => e.path === fromPath);
    cursor = idx >= 0 ? (hasParent ? idx + 1 : idx) : rowCount ? 0 : -1;
    listEl?.focus();
    ensureCursorVisible();
  }

  async function createFolder() {
    const name = mkdirName.trim();
    if (!name) return;
    try {
      await sftpMkdir(sessionId, join(cwd, name));
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
    if (!name) return;
    try {
      await sftpCreateFile(sessionId, join(cwd, name));
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
        await sftpDelete(sessionId, entry.path, entry.isDir);
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

  // ── Drag-to-move within the panel ──────────────────────────────────────────
  // Pointer-drag (native DnD is unreliable in WKWebView) a row onto a folder row
  // or the ".." entry to move it there. Drop targets carry `data-drop={dir}`;
  // validation + destination path come from filemove.ts. Always confirmed before
  // the actual rename; the backend refuses to clobber an existing name.
  // OS-style multi-select: plain click = one, Ctrl/Cmd = toggle, Shift = range.
  // Dragging any selected row moves the whole selection; the pure reducer lives in
  // multiselect.ts. Selection is cleared whenever the listing reloads.
  let selection = $state<SelectionState>(emptySelection());
  // Keyboard cursor (roving focus) and the file clipboard (cut/copy → paste).
  // The cursor indexes the full visible list, including the ".." row at index 0
  // when present (so it can be navigated to and Enter'd to go up a level).
  let cursor = $state(-1);
  let clipboard = $state<{ mode: "copy" | "cut"; items: { path: string; name: string }[] } | null>(
    null,
  );
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
      // Plain arrow moves the cursor frame only — selection is left untouched.
      // Shift+arrow extends a selection range: anchored at the last Space/anchor,
      // or at the row we started from if there's no anchor yet.
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

  async function paste() {
    const cb = clipboard;
    if (!cb) return;
    // Copying onto an existing name duplicates it as "… copy" (Finder-style)
    // rather than skipping; moving still refuses to clobber.
    const taken = new Set(entries.map((e) => e.name));
    let done = 0;
    let skipped = 0;
    let hardError = "";
    let lastName = "";
    for (const item of cb.items) {
      const name = cb.mode === "copy" && taken.has(item.name)
        ? uniqueCopyName(item.name, taken)
        : item.name;
      const dest = join(cwd, name);
      try {
        if (cb.mode === "cut") await sftpRename(sessionId, item.path, dest);
        else await sftpCopy(sessionId, item.path, dest);
        taken.add(name);
        done += 1;
        lastName = name;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("dest-exists")) skipped += 1;
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
      await sftpRename(sessionId, target.path, join(cwd, name));
      await refresh();
      notifySuccess(t("sftp.renamed", { name }));
    } catch (e) {
      const msg = String(e);
      if (msg.includes("dest-exists"))
        notifyError(t("sftp.moveConflict", { name, dest: cwd }));
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
  const parentPath = $derived(hasParent ? parentDir(cwd) : null);

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
        await sftpRename(sessionId, entry.path, join(m.destDir, entry.name));
        moved += 1;
        lastName = entry.name;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("dest-exists")) skipped += 1;
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
    await uploadPaths(await pickUploadFiles());
  }

  async function uploadPaths(paths: string[]) {
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() ?? p;
      try {
        await sftpUpload(sessionId, crypto.randomUUID(), p, join(cwd, name));
      } catch (e) {
        notifyError(String(e));
      }
    }
    await refresh();
  }

  async function download(entry: FileEntry) {
    try {
      if (entry.isDir) {
        const parent = await pickSaveDir();
        if (!parent) return;
        await sftpDownload(sessionId, crypto.randomUUID(), entry.path, parent, true);
      } else {
        const dest = await pickSavePath(entry.name);
        if (!dest) return;
        await sftpDownload(sessionId, crypto.randomUUID(), entry.path, dest, false);
      }
    } catch (e) {
      notifyError(String(e));
    }
  }

  function join(dir: string, name: string): string {
    return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
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

  function pct(t: SftpProgress): number {
    return t.total > 0 ? Math.round((t.transferred / t.total) * 100) : 0;
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
    : ''} {dragOver ? 'ring-2 ring-inset ring-accent' : ''}"
>
  {#if !embedded && collapsed}
    <div class="flex w-9 flex-col items-center gap-3 py-2">
      <button
        class="rounded p-1 text-muted hover:bg-edge hover:text-white"
        use:tooltip={t("sftp.expandPanel")}
        aria-label={t("sftp.expandPanel")}
        onclick={() => (collapsed = false)}
      >
        <Icon name="chevronLeft" size={16} />
      </button>
      <span
        class="text-[10px] uppercase tracking-wider text-muted [writing-mode:vertical-rl]"
      >
        SFTP
      </span>
    </div>
  {:else}
    <!-- Inner content is absolutely pinned to the panel's fixed right edge at the
         full expanded width. The panel is docked right, so during expansion its
         *left* border is what moves; an absolutely-positioned child is reliably
         clipped by the `overflow-hidden` root every frame in WebKit (unlike an
         oversized static flex child, which flickered past the left edge over the
         terminal). The content stays visually stationary and the moving left border
         simply reveals it (clip) — content and border stay perfectly in sync. -->
    <div
      class={embedded ? "flex h-full min-h-0 flex-col" : "absolute inset-y-0 right-0 flex flex-col"}
      style={embedded ? "" : `width: ${width}px`}
    >
    <!-- Toolbar. When embedded (RightDock owns the tab) and not yet connected the
         bar would hold only a redundant "SFTP" label — the tab already names it — so
         it's dropped entirely; the Connect action sits straight under the tab. -->
    {#if connected || !embedded}
    <div class="flex items-center gap-1 border-b border-edge px-2 py-1.5 text-xs">
      {#if !embedded}
        <button
          class="rounded p-1 text-muted hover:bg-edge hover:text-white"
          use:tooltip={t("sftp.collapsePanel")}
          aria-label={t("sftp.collapsePanel")}
          onclick={() => (collapsed = true)}
        >
          <Icon name="chevronRight" size={16} />
        </button>
      {/if}
      {#if connected}
        <button
          class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
          use:tooltip={t("sftp.refresh")}
          aria-label={t("sftp.refresh")}
          onclick={refresh}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button
          data-testid="sftp-toggle-hidden"
          class="flex items-center rounded p-1.5 {settings.sftp.showHiddenFiles
            ? 'bg-edge text-accent'
            : 'text-muted hover:bg-edge hover:text-white'}"
          use:tooltip={t("sftp.hiddenFiles")}
          aria-label={t("sftp.hiddenFiles")}
          aria-pressed={settings.sftp.showHiddenFiles}
          onclick={() => (settings.sftp.showHiddenFiles = !settings.sftp.showHiddenFiles)}
        >
          <Icon name="eye" size={14} />
        </button>
        <button
          data-testid="sftp-follow-terminal"
          class="flex items-center rounded p-1.5 {followTerminal
            ? 'bg-edge text-accent'
            : 'text-muted hover:bg-edge hover:text-white'}"
          use:tooltip={t("sftp.followTerminal")}
          aria-label={t("sftp.followTerminal")}
          aria-pressed={followTerminal}
          onclick={() => onToggleFollowTerminal?.()}
        >
          <Icon name="terminal" size={14} />
        </button>
        <button
          class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
          use:tooltip={t("sftp.newFolder")}
          aria-label={t("sftp.newFolder")}
          onclick={() => {
            showMkdir = !showMkdir;
            if (showMkdir) showMkfile = false;
          }}
        >
          <Icon name="folderPlus" size={14} />
        </button>
        <button
          data-testid="sftp-new-file"
          class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
          use:tooltip={t("sftp.newFile")}
          aria-label={t("sftp.newFile")}
          onclick={() => {
            showMkfile = !showMkfile;
            if (showMkfile) showMkdir = false;
          }}
        >
          <Icon name="filePlus" size={14} />
        </button>
        <button
          class="ml-auto flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
          use:tooltip={t("search.contentSearch")}
          aria-label={t("search.contentSearch")}
          onclick={() => (showSearch = !showSearch)}
        >
          <Icon name="search" size={14} />
        </button>
        <button
          class="flex items-center rounded p-1.5 text-muted hover:text-accent"
          use:tooltip={t("sync.button")}
          aria-label={t("sync.button")}
          onclick={() => (showSync = true)}
        >
          <Icon name="sync" size={14} />
        </button>
        <button
          class="flex items-center rounded p-1.5 text-muted hover:text-accent"
          use:tooltip={t("sftp.upload")}
          aria-label={t("sftp.upload")}
          onclick={uploadFiles}
        >
          <Icon name="upload" size={14} />
        </button>
      {:else}
        <span class="ml-1 uppercase tracking-wider text-muted">SFTP</span>
      {/if}
    </div>
    {/if}

  {#if !connected}
    <!-- Not yet connected: offer an explicit SFTP connect action -->
    <div
      class="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-xs"
    >
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
  <!-- Current path -->
  <div class="truncate border-b border-edge px-2 py-1 text-xs text-muted" title={cwd}>
    {cwd || "/"}
  </div>

  {#if showSearch}
    <!-- Content search (grep over SSH) under the current folder -->
    <div class="border-b border-edge px-2 py-1.5">
      <form
        class="flex gap-1"
        onsubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <input
          class="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-white outline-none focus:border-accent"
          placeholder={t("search.contentPlaceholder")}
          bind:value={searchQuery}
        />
        <button class="shrink-0 rounded bg-accent px-2 py-1 text-xs text-panel-alt" disabled={searching}>
          {searching ? t("search.searching") : t("search.go")}
        </button>
      </form>
      <div class="mt-1 flex gap-3 text-[11px] text-muted">
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
              class="block w-full truncate px-2 py-1 text-left text-[11px] hover:bg-edge"
              onclick={() => openMatch(m)}
              title={m.text}
            >
              <span class="text-accent">{m.path}:{m.line}</span>
              <span class="text-muted">{m.text}</span>
            </button>
          {:else}
            <div class="px-2 py-2 text-[11px] text-muted">{t("search.noResults")}</div>
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
        class="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-white outline-none focus:border-accent"
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
        class="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-white outline-none focus:border-accent"
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
        class="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-white outline-none focus:border-accent"
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
        class="flex shrink-0 items-center hover:text-white"
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
      <!-- Skeleton rows while the directory listing loads. -->
      <div data-testid="sftp-skeleton" class="py-1">
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
                aria-label={t("sftp.goUp")} use:tooltip={t("sftp.goUp")}
              >
                <Icon name="folder" size={15} class="text-muted" />
                <span class="truncate text-muted">..</span>
              </button>
            {:else}
              {@const entry = item.entry}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- Keyboard is handled at the focusable tree container (roving focus).
                   The row itself is not a <button> so Space toggles selection (via
                   the container handler) instead of activating a button. -->
              <div
                data-drop={entry.isDir ? entry.path : undefined}
                onpointerdown={(e) => startMove(e, entry)}
                onclick={(e) => rowClick(e, entry)}
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
                    <span class="ml-auto shrink-0 text-xs text-muted">
                      {fmtSize(entry.size)}
                    </span>
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
                  <button
                    class="rounded p-0.5 text-muted hover:text-accent"
                    use:tooltip={entry.isDir ? t("sftp.downloadFolder") : t("sftp.download")}
                    aria-label={entry.isDir ? t("sftp.downloadFolder") : t("sftp.download")}
                    onclick={() => download(entry)}
                  >
                    <Icon name="download" size={13} />
                  </button>
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
          {/each}
        </div>
      </div>
      {#if shownEntries.length === 0}
        <div class="px-3 py-4 text-xs text-muted">{t("sftp.emptyDir")}</div>
      {/if}
    {/if}
  </div>

  <!-- Transfers -->
  {#if transferList.length > 0}
    <div class="border-t border-edge px-2 py-1">
      {#each transferList as tr (tr.id)}
        <div class="group py-0.5 text-xs">
          <div class="flex items-center justify-between gap-2 text-muted">
            <span class="truncate">
              {tr.direction === "upload" ? "↑" : "↓"}
              {tr.name}{#if tr.isFolder}&nbsp;({tr.transferred}/{tr.total}){/if}
            </span>
            <div class="flex shrink-0 items-center gap-1">
              <span>{pct(tr)}%</span>
              {#if tr.isFolder && !tr.done}
                <button
                  class="hidden items-center rounded p-0.5 text-danger hover:bg-danger hover:text-white group-hover:inline-flex"
                  use:tooltip={t("sftp.stopDownload")}
                  aria-label={t("sftp.stopDownload")}
                  onclick={() => sftpCancel(tr.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              {/if}
            </div>
          </div>
          <div class="mt-0.5 h-1 rounded bg-edge">
            <div class="h-1 rounded bg-accent" style="width: {pct(tr)}%"></div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
  {/if}
    </div>
  {/if}
</div>

<!-- Delete confirmation (shared ConfirmDialog: gets the modal's z-40 + focus trap;
     a hand-rolled fixed overlay was unclickable once SftpPanel became embedded). -->
<ConfirmDialog
  open={deleteTargets.length > 0}
  title={t("sftp.deleteTitle")}
  confirmLabel={t("common.delete")}
  danger
  onconfirm={() => removeMany(deleteTargets)}
  oncancel={() => (deleteTargets = [])}
>
  {#if deleteTargets.length === 1}
    {deleteTargets[0].isDir ? t("sftp.folder") : t("sftp.file")}: <span class="break-all text-white"
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
    <span class="font-medium text-white">
      {selection.selected.size > 1 ? t("sftp.dragCount", { count: selection.selected.size }) : dragEntry.name}
    </span>
  </div>
{/if}

<!-- Directory sync (compares local folder ⇄ current remote folder) -->
<SyncModal
  open={showSync}
  {sessionId}
  remotePath={cwd || "."}
  onclose={() => (showSync = false)}
  onapplied={refresh}
/>
