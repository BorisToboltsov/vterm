<script lang="ts">
  // Local-filesystem browser docked to the right of a local-terminal tab — the
  // local counterpart of SftpPanel (Phase 12.4). No connect step or transfers:
  // the local FS is always available; files open straight in the editor.
  import { onMount, untrack } from "svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    localHome,
    localList,
    localMkdir,
    localCreateFile,
    localDelete,
    localRename,
  } from "./api";
  import { dropTargetAt, passedThreshold } from "./actions/drag";
  import { checkMove } from "./filemove";
  import { clickSelect, emptySelection, type SelectionState } from "./multiselect";
  import type { FileEntry } from "./types";
  import { fileIconName } from "./fileicon";
  import { windowRange } from "./virtuallist";
  import { filterHiddenFiles } from "./util";
  import { lsColorKey, fileTooltip } from "./lscolors";
  import { activeTerminalTheme, settings } from "./settings.svelte";
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import { t } from "./i18n";

  let {
    width = 384,
    collapsed = $bindable(false),
    animateWidth = true,
    embedded = false,
    terminalCwd = null,
    followTerminal = false,
    onToggleFollowTerminal,
    onOpenFile,
  }: {
    width?: number;
    collapsed?: boolean;
    animateWidth?: boolean;
    /** Render content-only (Phase 17.2): the shared RightDock owns collapse/tabs. */
    embedded?: boolean;
    /** Latest terminal cwd (OSC 7); the panel follows it while `followTerminal` is on. */
    terminalCwd?: string | null;
    /** Follow the local terminal's cwd — per-tab toggle (state owned by the page). */
    followTerminal?: boolean;
    onToggleFollowTerminal?: () => void;
    onOpenFile?: (path: string) => void;
  } = $props();

  let cwd = $state("");
  let entries = $state<FileEntry[]>([]);

  // Virtualized listing (Phase 18.7): render only the visible window of fixed-height
  // (`h-7`, 28px) rows so huge directories don't freeze the UI. Item 0 is the ".."
  // parent-nav when not at the root.
  const ROW_H = 28;
  let listScrollTop = $state(0);
  let listViewportH = $state(600);
  const hasParent = $derived(!!cwd && cwd !== "/");
  // Dotfiles are hidden unless the toolbar eye toggle is on. The preference is
  // shared with the SFTP panel (settings.sftp.showHiddenFiles); raw `entries` kept.
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
  let loading = $state(false);
  let error = $state("");

  let showMkdir = $state(false);
  let mkdirName = $state("");
  let showMkfile = $state(false);
  let mkfileName = $state("");
  let confirmTarget = $state<FileEntry | null>(null);

  onMount(async () => {
    // When following the terminal and a cwd is already known (e.g. re-mount after a
    // tab switch), land there instead of home — avoids a home→cwd flash.
    if (followTerminal && terminalCwd) {
      await load(terminalCwd);
      return;
    }
    let start = ".";
    try {
      start = await localHome();
    } catch {
      /* fall back to "." */
    }
    await load(start);
  });

  /** Native path separator for `path` (handles both `/` and `\`). */
  function sep(path: string): string {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
  }

  function join(dir: string, name: string): string {
    const s = sep(dir);
    return dir.endsWith(s) ? `${dir}${name}` : `${dir}${s}${name}`;
  }

  /** Parent directory of `path` (stays at the root when already there). */
  function parentOf(path: string): string {
    const s = sep(path);
    const trimmed = path.replace(/[\\/]+$/, "");
    const i = trimmed.lastIndexOf(s);
    if (i <= 0) return s; // root
    // Keep the drive root on Windows (e.g. "C:\").
    return /^[A-Za-z]:$/.test(trimmed.slice(0, i)) ? trimmed.slice(0, i) + s : trimmed.slice(0, i);
  }

  async function load(path: string) {
    loading = true;
    try {
      const next = await localList(path);
      cwd = path;
      entries = next;
      error = "";
      selection = emptySelection();
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function refresh() {
    load(cwd || ".");
  }

  // Follow the local terminal: navigate when a new terminal cwd (OSC 7) arrives and
  // the toggle is on. `cwd` is read untracked so manual navigation isn't snapped back
  // and a successful load doesn't re-trigger the effect (deps: followTerminal/terminalCwd).
  $effect(() => {
    if (!followTerminal || !terminalCwd) return;
    untrack(() => {
      if (terminalCwd !== cwd) load(terminalCwd);
    });
  });

  function open(entry: FileEntry) {
    if (entry.isDir) load(entry.path);
    else onOpenFile?.(entry.path);
  }

  function goUp() {
    if (cwd) load(parentOf(cwd));
  }

  async function createFolder() {
    const name = mkdirName.trim();
    if (!name) return;
    try {
      await localMkdir(join(cwd, name));
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
      await localCreateFile(join(cwd, name));
      mkfileName = "";
      showMkfile = false;
      await refresh();
      notifySuccess(t("sftp.fileCreated", { name }));
    } catch (e) {
      notifyError(String(e));
    }
  }

  async function remove(entry: FileEntry) {
    confirmTarget = null;
    try {
      await localDelete(entry.path, entry.isDir);
      await refresh();
      notifySuccess(t("sftp.deleted", { name: entry.name }));
    } catch (e) {
      notifyError(String(e));
    }
  }

  // ── Drag-to-move within the panel ──────────────────────────────────────────
  // Pointer-drag a row onto a folder row or ".." to move it there (native DnD is
  // unreliable in WKWebView). Validation reuses filemove.ts; paths are normalized
  // to POSIX for the check only, while the destination is built with the native
  // separator so Windows '\' paths keep working. Always confirmed; the backend
  // refuses to clobber an existing name.
  const toPosix = (p: string) => p.replace(/\\/g, "/");

  // OS-style multi-select: plain click = one, Ctrl/Cmd = toggle, Shift = range.
  // Dragging any selected row moves the whole selection (multiselect.ts). Cleared
  // whenever the listing reloads.
  let selection = $state<SelectionState>(emptySelection());

  function rowClick(e: MouseEvent, entry: FileEntry) {
    if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    selection = clickSelect(
      selection,
      entry.path,
      { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey },
      shownEntries.map((x) => x.path),
    );
  }

  function rowKeydown(e: KeyboardEvent, entry: FileEntry) {
    if (e.key === "Enter") {
      e.preventDefault();
      open(entry);
    } else if (e.key === " ") {
      e.preventDefault();
      selection = clickSelect(
        selection,
        entry.path,
        { toggle: true, range: false },
        shownEntries.map((x) => x.path),
      );
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
  const parentPath = $derived(hasParent ? parentOf(cwd) : null);

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
        const items = entries.filter(
          (x) => selection.selected.has(x.path) && checkMove(toPosix(x.path), toPosix(dir)).ok,
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
      dragEntry !== null &&
      dir !== null &&
      dropDir === dir &&
      checkMove(toPosix(dragEntry.path), toPosix(dir)).ok
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
      if (!checkMove(toPosix(entry.path), toPosix(m.destDir)).ok) continue;
      try {
        await localRename(entry.path, join(m.destDir, entry.name));
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

  const COLLAPSED_W = 36;
</script>

<div
  style={embedded ? "" : `width: ${collapsed ? COLLAPSED_W : width}px`}
  class="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-panel-alt {embedded
    ? ''
    : 'border-l border-edge'} {!embedded && animateWidth
    ? 'transition-[width] duration-200 ease-out'
    : ''}"
>
  {#if !embedded && collapsed}
    <div class="flex w-9 flex-col items-center gap-3 py-2">
      <button
        class="rounded p-1 text-muted hover:bg-edge hover:text-white"
        use:tooltip={t("localfiles.expandPanel")}
        aria-label={t("localfiles.expandPanel")}
        onclick={() => (collapsed = false)}
      >
        <Icon name="chevronLeft" size={16} />
      </button>
      <span class="text-[10px] uppercase tracking-wider text-muted [writing-mode:vertical-rl]">
        {t("localfiles.label")}
      </span>
    </div>
  {:else}
    <div
      class={embedded ? "flex h-full min-h-0 flex-col" : "absolute inset-y-0 right-0 flex flex-col"}
      style={embedded ? "" : `width: ${width}px`}
    >
      <!-- Toolbar -->
      <div class="flex items-center gap-1 border-b border-edge px-2 py-1.5 text-xs">
        {#if !embedded}
          <button
            class="rounded p-1 text-muted hover:bg-edge hover:text-white"
            use:tooltip={t("localfiles.collapsePanel")}
            aria-label={t("localfiles.collapsePanel")}
            onclick={() => (collapsed = true)}
          >
            <Icon name="chevronRight" size={16} />
          </button>
        {/if}
        <button
          class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
          use:tooltip={t("sftp.refresh")}
          aria-label={t("sftp.refresh")}
          onclick={refresh}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button
          data-testid="localfiles-toggle-hidden"
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
          data-testid="localfiles-follow-terminal"
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
        {#if !embedded}
          <!-- The RightDock tab already names this panel; skip the duplicate label. -->
          <span class="ml-auto uppercase tracking-wider text-muted">{t("localfiles.label")}</span>
        {/if}
      </div>

      <!-- Current path -->
      <div class="truncate border-b border-edge px-2 py-1 text-xs text-muted" title={cwd}>
        {cwd || "/"}
      </div>

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

      {#if error}
        <div class="flex items-start gap-2 border-b border-edge bg-danger/10 px-2 py-1 text-xs text-danger">
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
        role="tree"
        tabindex="-1"
        class="min-h-0 flex-1 overflow-y-auto text-sm {dragEntry ? 'select-none cursor-grabbing' : ''}"
      >
        {#if loading}
          <div class="py-1">
            {#each Array(7) as _, i (i)}
              <div class="flex items-center gap-2 px-2 py-1.5">
                <Skeleton width="15px" height="15px" class="shrink-0" />
                <Skeleton width="{45 + ((i * 17) % 40)}%" height="0.7rem" />
              </div>
            {/each}
          </div>
        {:else}
          <!-- Virtual window (Phase 18.7): only the visible slice is rendered. -->
          <div style="height: {win.totalHeight}px; position: relative;">
            <div style="transform: translateY({win.padTop}px);">
              {#each visibleItems as item (item.key)}
                {#if item.entry === null}
                  <button
                    data-drop={parentPath ?? undefined}
                    class="flex h-7 w-full items-center gap-2 px-2 text-left {dropOk(parentPath)
                      ? 'bg-accent/20 ring-1 ring-inset ring-accent'
                      : 'hover:bg-edge'}"
                    ondblclick={goUp}
                    aria-label={t("sftp.goUp")} use:tooltip={t("sftp.goUp")}
                  >
                    <Icon name="folder" size={15} class="text-muted" />
                    <span class="truncate text-muted">..</span>
                  </button>
                {:else}
                  {@const entry = item.entry}
                  <div
                    data-drop={entry.isDir ? entry.path : undefined}
                    onpointerdown={(e) => startMove(e, entry)}
                    onclick={(e) => rowClick(e, entry)}
                    onkeydown={(e) => rowKeydown(e, entry)}
                    role="treeitem"
                    aria-selected={selection.selected.has(entry.path)}
                    tabindex="-1"
                    class="group flex h-7 cursor-grab items-center gap-2 px-2 {dropOk(entry.path)
                      ? 'bg-accent/20 ring-1 ring-inset ring-accent'
                      : selection.selected.has(entry.path)
                        ? 'bg-accent/25'
                        : 'hover:bg-edge'} {dragEntry && selection.selected.has(entry.path)
                      ? 'opacity-50'
                      : ''}"
                  >
                    <button
                      class="flex min-w-0 flex-1 items-center gap-2 text-left"
                      use:tooltip={fileTooltip(entry)}
                      ondblclick={() => open(entry)}
                    >
                      <Icon name={fileIconName(entry)} size={15} class="shrink-0 text-muted" />
                      <span class="truncate" style={nameStyle(entry)}>{entry.name}</span>
                      {#if !entry.isDir}
                        <span class="ml-auto shrink-0 text-xs text-muted">{fmtSize(entry.size)}</span>
                      {/if}
                    </button>
                    <div
                      data-nodrag
                      class="invisible flex shrink-0 items-center gap-1 group-hover:visible"
                    >
                      {#if !entry.isDir && onOpenFile}
                        <button
                          class="rounded p-0.5 text-muted hover:text-accent"
                          use:tooltip={t("sftp.editFile")}
                          aria-label={t("sftp.editFile")}
                          onclick={() => onOpenFile?.(entry.path)}
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                      {/if}
                      <button
                        class="rounded p-0.5 text-muted hover:text-danger"
                        use:tooltip={t("common.delete")}
                        aria-label={t("common.delete")}
                        onclick={() => (confirmTarget = entry)}
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
    </div>
  {/if}
</div>

<ConfirmDialog
  open={!!confirmTarget}
  title={t("sftp.deleteTitle")}
  confirmLabel={t("common.delete")}
  danger
  onconfirm={() => confirmTarget && remove(confirmTarget)}
  oncancel={() => (confirmTarget = null)}
>
  {confirmTarget?.isDir ? t("sftp.folder") : t("sftp.file")}: <span class="break-all text-white"
    >{confirmTarget?.path}</span
  >
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
