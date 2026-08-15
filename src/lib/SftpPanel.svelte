<script lang="ts">
  // SFTP file browser — a thin wrapper over the shared <FileBrowser> (Phase 44.8).
  // It supplies the SFTP transport + POSIX navigation as an adapter, the SFTP-only
  // features (upload/download/grep/sync) and the transfers footer; everything else
  // (selection, keyboard, drag-move, path bar, list, menus) lives in FileBrowser.
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
  import { parentDir } from "./filemove";
  import { isRoot } from "./fspath";
  import type { FileBrowserAdapter } from "./filebrowser";
  import type { FileEntry } from "./types";
  import { notifyError } from "./stores/toasts.svelte";
  import { transfersState } from "./stores/transfers.svelte";
  import { etaSeconds, fmtEta } from "./transfer";
  import { fmtBytes, fmtRate } from "./format";
  import { tooltip } from "./actions/tooltip";
  import FileBrowser from "./FileBrowser.svelte";
  import SyncModal from "./SyncModal.svelte";
  import Icon from "./Icon.svelte";
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
    visible = true,
    onToggleFollowTerminal,
    onOpenFile,
    onUserNavigate,
  }: {
    sessionId: string;
    width?: number;
    collapsed?: boolean;
    sessionReady?: boolean;
    animateWidth?: boolean;
    embedded?: boolean;
    terminalCwd?: string | null;
    followTerminal?: boolean;
    /** The dock is showing this tab (false = mounted but hidden behind another). */
    visible?: boolean;
    onToggleFollowTerminal?: () => void;
    onOpenFile?: (path: string, name: string, gotoLine?: number) => void;
    onUserNavigate?: (path: string) => void;
  } = $props();

  // The current directory the transfers/sync operate against; kept in sync via the
  // adapter's list (which FileBrowser calls). SyncModal needs the remote path.
  let cwd = $state(".");

  async function uploadPaths(destDir: string, paths: string[]) {
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() ?? p;
      try {
        await sftpUpload(sessionId, crypto.randomUUID(), p, `${destDir}/${name}`.replace(/\/+/g, "/"));
      } catch (e) {
        notifyError(String(e));
      }
    }
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

  // Transport + POSIX navigation, plus the SFTP-only capabilities. The `list`
  // records `cwd` so SyncModal and the drop-upload target follow the folder.
  const adapter: FileBrowserAdapter = {
    list: async (p) => {
      const entries = await sftpList(sessionId, p);
      cwd = p;
      return entries;
    },
    mkdir: (p) => sftpMkdir(sessionId, p),
    createFile: (p) => sftpCreateFile(sessionId, p),
    remove: (p, isDir) => sftpDelete(sessionId, p, isDir),
    rename: (from, to) => sftpRename(sessionId, from, to),
    copy: (from, to) => sftpCopy(sessionId, from, to),
    home: () => sftpHome(sessionId),
    hasParent: (dir) => !isRoot(dir),
    parentForUp: (dir) => (isRoot(dir) ? null : parentDir(dir)),
    mutable: () => true,
    mirrorsToTerminal: () => true,
    /** Toolbar "Upload": pick files, then upload them into `destDir`. */
    upload: async (destDir) => uploadPaths(destDir, await pickUploadFiles()),
    uploadPaths,
    download,
    search: (dir, q, caseInsensitive, fixed) => sftpGrep(sessionId, dir, q, caseInsensitive, fixed),
  };

  let browser = $state<ReturnType<typeof FileBrowser>>();
  let showSync = $state(false);

  const transferList = $derived(Object.values(transfersState.map));
  function pct(tr: SftpProgress): number {
    return tr.total > 0 ? Math.round((tr.transferred / tr.total) * 100) : 0;
  }
</script>

<FileBrowser
  bind:this={browser}
  {adapter}
  {width}
  bind:collapsed
  {animateWidth}
  {embedded}
  {terminalCwd}
  {followTerminal}
  {visible}
  sessionKey={sessionId}
  {onToggleFollowTerminal}
  {onOpenFile}
  {onUserNavigate}
  requiresConnect
  {sessionReady}
  stripLabel="SFTP"
  expandLabel={t("sftp.expandPanel")}
  collapseLabel={t("sftp.collapsePanel")}
  testPrefix="sftp"
  onSync={() => (showSync = true)}
  {footer}
/>

{#snippet footer()}
  {#if transferList.length > 0}
    <div class="border-t border-edge px-2 py-1">
      {#each transferList as tr (tr.id)}
        {@const rate = transfersState.rates[tr.id] ?? null}
        <div class="group py-0.5 text-xs">
          <div class="flex items-center gap-1.5 text-muted">
            <Icon
              name={tr.direction === "upload" ? "arrowUp" : "arrowDown"}
              size={12}
              class="shrink-0 text-accent"
            />
            <span class="min-w-0 flex-1 truncate" title={tr.name}>{tr.name}</span>
            <span class="shrink-0 text-accent">{pct(tr)}%</span>
            {#if tr.isFolder && !tr.done}
              <button
                class="hidden shrink-0 items-center rounded p-0.5 text-danger hover:bg-danger hover:text-white group-hover:inline-flex"
                use:tooltip={t("sftp.stopDownload")}
                aria-label={t("sftp.stopDownload")}
                onclick={() => sftpCancel(tr.id)}
              >
                <Icon name="close" size={12} />
              </button>
            {/if}
          </div>
          <div class="mt-0.5 h-1 rounded bg-edge">
            <div class="h-1 rounded bg-accent" style="width: {pct(tr)}%"></div>
          </div>
          <!-- Size/speed and ETA. Both stay absent rather than showing a made-up
               zero while the window is still filling (see transfer.ts). -->
          <div class="mt-0.5 flex items-center justify-between gap-2 text-caption text-muted">
            <span class="min-w-0 truncate">
              {#if tr.isFolder}
                {tr.transferred}/{tr.total}
              {:else}
                {fmtBytes(tr.transferred)} / {fmtBytes(tr.total)}
              {/if}
              {#if rate != null}
                · {tr.isFolder ? t("sftp.filesPerSec", { n: rate.toFixed(1) }) : fmtRate(rate)}
              {:else if !tr.done}
                · {t("sftp.rateUnknown")}
              {/if}
            </span>
            {#if !tr.done}
              {@const eta = etaSeconds(tr.transferred, tr.total, rate)}
              {#if eta != null}
                <span class="shrink-0 tabular-nums">{t("sftp.eta", { time: fmtEta(eta) })}</span>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

<!-- Directory sync (compares local folder ⇄ current remote folder) -->
<SyncModal
  open={showSync}
  {sessionId}
  remotePath={cwd || "."}
  onclose={() => (showSync = false)}
  onapplied={() => browser?.refresh()}
/>
