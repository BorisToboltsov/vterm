<script lang="ts">
  import { onDestroy, onMount } from "svelte";
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
    sftpHome,
    sftpList,
    sftpMkdir,
    sftpUpload,
    type SftpProgress,
  } from "./api";
  import type { FileEntry } from "./types";
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";
  import SyncModal from "./SyncModal.svelte";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import { transfersState } from "./stores/transfers.svelte";
  import { t } from "./i18n";

  let {
    sessionId,
    width = 384,
    collapsed = $bindable(false),
    sessionReady = false,
    animateWidth = true,
    onOpenFile,
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
    /** Open an editable file in the in-app editor (double-click). */
    onOpenFile?: (path: string, name: string) => void;
  } = $props();

  let cwd = $state("");
  let entries = $state<FileEntry[]>([]);
  let loading = $state(false);
  let error = $state("");
  let dragOver = $state(false);
  // SFTP connects on demand (button) rather than automatically on mount.
  let connected = $state(false);
  let connecting = $state(false);

  let showMkdir = $state(false);
  let mkdirName = $state("");
  let showMkfile = $state(false);
  let mkfileName = $state("");
  let confirmTarget = $state<FileEntry | null>(null);
  let showSync = $state(false);

  const unlisten: UnlistenFn[] = [];

  // Transfer progress lives in a shared store (also read by the status-bar
  // indicator); the `sftp://progress` subscription is owned by +page.svelte.
  const transferList = $derived(Object.values(transfersState.map));

  /** Open the SFTP subsystem and list the home directory (button-triggered). */
  async function connect() {
    connecting = true;
    error = "";
    let start = ".";
    try {
      start = await sftpHome(sessionId);
    } catch {
      /* fall back to "." */
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
    // Any file can be opened in the editor (binary/oversize files are rejected by
    // the backend read with a toast); directories navigate.
    if (entry.isDir) load(entry.path);
    else onOpenFile?.(entry.path, entry.name);
  }

  function goUp() {
    const parent = cwd.replace(/\/[^/]+\/?$/, "");
    load(parent === "" ? "/" : parent);
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

  async function remove(entry: FileEntry) {
    confirmTarget = null;
    try {
      await sftpDelete(sessionId, entry.path, entry.isDir);
      await refresh();
      notifySuccess(t("sftp.deleted", { name: entry.name }));
    } catch (e) {
      notifyError(String(e));
    }
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
  style="width: {collapsed ? COLLAPSED_W : width}px"
  class="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-edge bg-panel-alt {animateWidth
    ? 'transition-[width] duration-200 ease-out'
    : ''} {dragOver ? 'ring-2 ring-inset ring-accent' : ''}"
>
  {#if collapsed}
    <div class="flex w-9 flex-col items-center gap-3 py-2">
      <button
        class="rounded p-1 text-muted hover:bg-edge hover:text-white"
        title={t("sftp.expandPanel")}
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
    <div class="absolute inset-y-0 right-0 flex flex-col" style="width: {width}px">
    <!-- Toolbar -->
    <div class="flex items-center gap-1 border-b border-edge px-2 py-1.5 text-xs">
      <button
        class="rounded p-1 text-muted hover:bg-edge hover:text-white"
        title={t("sftp.collapsePanel")}
        aria-label={t("sftp.collapsePanel")}
        onclick={() => (collapsed = true)}
      >
        <Icon name="chevronRight" size={16} />
      </button>
      {#if connected}
        <button
          class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
          title={t("sftp.refresh")}
          aria-label={t("sftp.refresh")}
          onclick={refresh}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button
          class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
          title={t("sftp.newFolder")}
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
          title={t("sftp.newFile")}
          aria-label={t("sftp.newFile")}
          onclick={() => {
            showMkfile = !showMkfile;
            if (showMkfile) showMkdir = false;
          }}
        >
          <Icon name="filePlus" size={14} />
        </button>
        <button
          class="ml-auto flex items-center rounded p-1.5 text-muted hover:text-accent"
          title={t("sync.button")}
          aria-label={t("sync.button")}
          onclick={() => (showSync = true)}
        >
          <Icon name="sync" size={14} />
        </button>
        <button
          class="flex items-center rounded p-1.5 text-muted hover:text-accent"
          title={t("sftp.upload")}
          aria-label={t("sftp.upload")}
          onclick={uploadFiles}
        >
          <Icon name="upload" size={14} />
        </button>
      {:else}
        <span class="ml-1 uppercase tracking-wider text-muted">SFTP</span>
      {/if}
    </div>

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
  <div class="min-h-0 flex-1 overflow-y-auto text-sm">
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
      {#if cwd && cwd !== "/"}
        <button
          class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-edge"
          ondblclick={goUp}
          title={t("sftp.goUp")}
        >
          <Icon name="folder" size={15} class="text-muted" />
          <span class="truncate text-muted">..</span>
        </button>
      {/if}
      {#each entries as entry (entry.path)}
        <div class="group flex items-center gap-2 px-2 py-1 hover:bg-edge">
          <button
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
            ondblclick={() => open(entry)}
          >
            <Icon
              name={entry.isSymlink ? "symlink" : entry.isDir ? "folder" : "file"}
              size={15}
              class="shrink-0 text-muted"
            />
            <span class="truncate">{entry.name}</span>
            {#if !entry.isDir}
              <span class="ml-auto shrink-0 text-xs text-muted">
                {fmtSize(entry.size)}
              </span>
            {/if}
          </button>
          <div class="invisible flex shrink-0 items-center gap-1 group-hover:visible">
            {#if !entry.isDir && onOpenFile}
              <button
                class="rounded p-0.5 text-muted hover:text-accent"
                title={t("sftp.editFile")}
                aria-label={t("sftp.editFile")}
                onclick={() => onOpenFile?.(entry.path, entry.name)}
              >
                <Icon name="pencil" size={13} />
              </button>
            {/if}
            <button
              class="rounded p-0.5 text-muted hover:text-accent"
              title={entry.isDir ? t("sftp.downloadFolder") : t("sftp.download")}
              aria-label={entry.isDir ? t("sftp.downloadFolder") : t("sftp.download")}
              onclick={() => download(entry)}
            >
              <Icon name="download" size={13} />
            </button>
            <button
              class="rounded p-0.5 text-muted hover:text-danger"
              title={t("common.delete")}
              aria-label={t("common.delete")}
              onclick={() => (confirmTarget = entry)}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>
      {:else}
        <div class="px-3 py-4 text-xs text-muted">{t("sftp.emptyDir")}</div>
      {/each}
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
                  title={t("sftp.stopDownload")}
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

<!-- Delete confirmation -->
{#if confirmTarget}
  <div class="fixed inset-0 flex items-center justify-center">
    <button
      class="absolute inset-0 bg-black/50"
      aria-label={t("common.closeDialog")}
      onclick={() => (confirmTarget = null)}
    ></button>
    <div class="relative w-80 rounded-lg border border-edge bg-panel-alt p-4">
      <h2 class="mb-2 text-sm font-semibold text-danger">{t("sftp.deleteTitle")}</h2>
      <p class="mb-4 break-all text-xs text-muted">
        {confirmTarget.isDir ? t("sftp.folder") : t("sftp.file")}: {confirmTarget.path}
      </p>
      <div class="flex justify-end gap-2">
        <button
          class="rounded px-3 py-1 text-sm text-muted hover:text-white"
          onclick={() => (confirmTarget = null)}>{t("common.cancel")}</button
        >
        <button
          class="rounded bg-danger px-3 py-1 text-sm text-panel-alt hover:opacity-90"
          onclick={() => confirmTarget && remove(confirmTarget)}>{t("common.delete")}</button
        >
      </div>
    </div>
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
