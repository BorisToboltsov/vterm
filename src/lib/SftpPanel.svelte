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
    sftpGrep,
    sftpHome,
    sftpList,
    sftpMkdir,
    sftpRename,
    sftpCopy,
  } from "./api";
  import { parentDir } from "./filemove";
  import { isRoot, joinPath, parentOf } from "./fspath";
  import type { FileBrowserAdapter } from "./filebrowser";
  import type { FileEntry } from "./types";
  import { notifyError } from "./stores/toasts.svelte";
  import { transfersOf, transfersState } from "./stores/transfers.svelte";
  import { DISK, startTransfer } from "./transferflow";
  import { etaSeconds, fmtEta, isCancellableTransfer, type TransferRow } from "./transfer";
  import { fmtBytes, fmtRate } from "./format";
  import { tooltip } from "./actions/tooltip";
  import FileBrowser from "./FileBrowser.svelte";
  import SyncModal from "./SyncModal.svelte";
  import { isBusy, peekSyncJob } from "./stores/syncjob.svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
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

  /** This session's server, as a side of a transfer. */
  const here = $derived({ session: sessionId, local: false, label: "" });

  // Uploads and downloads are jobs of the backend (v1.12): this panel asks for
  // one and waits for nothing — it may be remounted, or its tab given to another
  // window, before the job ends. The list below, the re-listing of the folder a
  // job wrote into and what to say when one fails all come from the events the
  // backend sends (`stores/transfers`).

  /** Upload local files into `destDir`. A name already there is asked about first. */
  async function uploadPaths(destDir: string, paths: string[]) {
    await startTransfer({
      src: DISK,
      dst: here,
      sources: paths.map((path) => ({ path, isDir: false })),
      destDir,
    });
  }

  async function download(entry: FileEntry) {
    let dest: string | null;
    try {
      dest = entry.isDir ? await pickSaveDir() : await pickSavePath(entry.name);
    } catch (e) {
      notifyError(String(e));
      return;
    }
    if (!dest) return;
    // A file: the system's dialog named it, and asked if it was there already.
    // A folder: `dest` is the folder the tree is created in.
    const to = entry.isDir ? joinPath(dest, entry.name) : dest;
    await startTransfer({
      src: here,
      dst: DISK,
      sources: [{ path: entry.path, isDir: entry.isDir, to }],
      destDir: entry.isDir ? dest : parentOf(dest),
      agreed: true,
    });
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
    download,
    search: (dir, q, caseInsensitive, fixed) => sftpGrep(sessionId, dir, q, caseInsensitive, fixed),
  };

  let browser = $state<ReturnType<typeof FileBrowser>>();
  let showSync = $state(false);

  // This session's transfers — and the files of a sync run, which name no session.
  const transferList = $derived(transfersOf(sessionId));
  function pct(tr: TransferRow): number {
    return tr.total > 0 ? Math.round((tr.transferred / tr.total) * 100) : 0;
  }
  const ARROW: Record<TransferRow["direction"], IconName> = {
    upload: "arrowUp",
    download: "arrowDown",
    copy: "arrowRight",
  };
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
  syncActive={isBusy(peekSyncJob(sessionId))}
  {footer}
/>

{#snippet footer()}
  {#if transferList.length > 0}
    <div class="border-t border-edge px-2 py-1">
      {#each transferList as tr (tr.id)}
        {@const rate = transfersState.rates[tr.id] ?? null}
        <div class="group py-0.5 text-xs">
          <div class="flex items-center gap-1.5 text-muted">
            <Icon name={ARROW[tr.direction]} size={12} class="shrink-0 text-accent" />
            <span class="min-w-0 flex-1 truncate" title={tr.name}>{tr.name}</span>
            {#if tr.fileCount}
              <!-- A job of several files: which one this is. -->
              <span class="shrink-0 tabular-nums" data-testid="transfer-files">
                {Math.min((tr.fileIndex ?? 0) + 1, tr.fileCount)}/{tr.fileCount}
              </span>
            {/if}
            <span class="shrink-0 text-accent">{pct(tr)}%</span>
            {#if isCancellableTransfer(tr)}
              <!-- Always visible, like the sync window's Stop: a hover-only
                   control on a long download is one the user never finds. -->
              <button
                data-testid="transfer-cancel"
                class="inline-flex shrink-0 items-center rounded p-0.5 text-danger hover:bg-danger hover:text-white"
                use:tooltip={t("sftp.cancelTransfer")}
                aria-label={t("sftp.cancelTransfer")}
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
              {fmtBytes(tr.transferred)} / {fmtBytes(tr.total)}
              {#if rate != null}
                · {fmtRate(rate)}
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
