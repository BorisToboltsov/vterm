<script lang="ts">
  // Local-filesystem browser docked to the right of a local-terminal tab — the
  // local counterpart of SftpPanel (Phase 12.4). No connect step or transfers:
  // the local FS is always available; files open straight in the editor.
  import { onMount } from "svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    localHome,
    localList,
    localMkdir,
    localCreateFile,
    localDelete,
  } from "./api";
  import type { FileEntry } from "./types";
  import { fileIconName } from "./fileicon";
  import { windowRange } from "./virtuallist";
  import { lsColorKey, fileTooltip } from "./lscolors";
  import { activeTerminalTheme } from "./settings.svelte";
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
    onOpenFile,
  }: {
    width?: number;
    collapsed?: boolean;
    animateWidth?: boolean;
    /** Render content-only (Phase 17.2): the shared RightDock owns collapse/tabs. */
    embedded?: boolean;
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
  const rowCount = $derived((hasParent ? 1 : 0) + entries.length);
  const win = $derived(windowRange(listScrollTop, listViewportH, ROW_H, rowCount));
  const visibleItems = $derived.by(() => {
    const items: { key: string; entry: FileEntry | null }[] = [];
    for (let i = win.start; i < win.end; i++) {
      if (hasParent && i === 0) items.push({ key: "..", entry: null });
      else {
        const e = entries[i - (hasParent ? 1 : 0)];
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
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function refresh() {
    load(cwd || ".");
  }

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
        <span class="ml-auto uppercase tracking-wider text-muted">{t("localfiles.label")}</span>
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
        bind:clientHeight={listViewportH}
        onscroll={(e) => (listScrollTop = e.currentTarget.scrollTop)}
        class="min-h-0 flex-1 overflow-y-auto text-sm"
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
                    class="flex h-7 w-full items-center gap-2 px-2 text-left hover:bg-edge"
                    ondblclick={goUp}
                    aria-label={t("sftp.goUp")} use:tooltip={t("sftp.goUp")}
                  >
                    <Icon name="folder" size={15} class="text-muted" />
                    <span class="truncate text-muted">..</span>
                  </button>
                {:else}
                  {@const entry = item.entry}
                  <div class="group flex h-7 items-center gap-2 px-2 hover:bg-edge">
                    <button
                      class="flex min-w-0 flex-1 items-center gap-2 text-left"
                      title={fileTooltip(entry)}
                      ondblclick={() => open(entry)}
                    >
                      <Icon name={fileIconName(entry)} size={15} class="shrink-0 text-muted" />
                      <span class="truncate" style={nameStyle(entry)}>{entry.name}</span>
                      {#if !entry.isDir}
                        <span class="ml-auto shrink-0 text-xs text-muted">{fmtSize(entry.size)}</span>
                      {/if}
                    </button>
                    <div class="invisible flex shrink-0 items-center gap-1 group-hover:visible">
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
          {#if entries.length === 0}
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
