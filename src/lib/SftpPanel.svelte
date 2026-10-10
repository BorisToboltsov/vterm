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
  import { baseName, isRoot } from "./fspath";
  import {
    checkUpload,
    isDestExists,
    replaceList,
    uploadItems,
    type FileBrowserAdapter,
    type ReplaceAnswer,
    type UploadCheck,
  } from "./filebrowser";
  import type { FileEntry } from "./types";
  import { notifyError } from "./stores/toasts.svelte";
  import {
    removeTransfer,
    trackTransfer,
    transfersState,
    untrackTransfer,
  } from "./stores/transfers.svelte";
  import { isCancelled } from "./sync";
  import { etaSeconds, fmtEta, isCancellableTransfer } from "./transfer";
  import { fmtBytes, fmtRate } from "./format";
  import { tooltip } from "./actions/tooltip";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import FileBrowser from "./FileBrowser.svelte";
  import SyncModal from "./SyncModal.svelte";
  import { isBusy, peekSyncJob } from "./stores/syncjob.svelte";
  import { beginUpload, endUpload } from "./stores/dockstate.svelte";
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

  /**
   * Run one transfer under a fresh id. A user's cancel is not an error: the row
   * goes away (a cancelled file never emits its final event, so nothing else would
   * clear it) and no toast is shown.
   */
  async function runTransfer(
    start: (id: string) => Promise<void>,
    explain: (error: string) => string = (error) => error,
  ) {
    const id = crypto.randomUUID();
    trackTransfer(id, sessionId);
    try {
      await start(id);
    } catch (e) {
      if (isCancelled(String(e))) removeTransfer(id);
      else notifyError(explain(String(e)));
    } finally {
      untrackTransfer(id);
    }
  }

  // The question an upload onto taken names waits on (v1.11.3). `names` null —
  // the folder could not be listed, so which names are taken is not known.
  let replaceAsk = $state<{
    dest: string;
    names: string[] | null;
    more: number;
    canSkip: boolean;
    answer: (a: ReplaceAnswer) => void;
  } | null>(null);

  function askReplace(dest: string, check: UploadCheck | null): Promise<ReplaceAnswer> {
    const listed = check ? replaceList(check.clash) : null;
    return new Promise((resolve) => {
      replaceAsk = {
        dest,
        names: listed?.names ?? null,
        more: listed?.more ?? 0,
        canSkip: !!check && check.fresh.length > 0,
        answer: (a) => {
          replaceAsk = null;
          resolve(a);
        },
      };
    });
  }

  /**
   * Upload one batch. A file that would replace one already in `destDir` is
   * asked about first — once for the batch; the folder is asked which names it
   * holds, not this panel's listing, which may be minutes old. The listing is
   * re-listed once, when the last batch into `destDir` ends — through the dock
   * store, because this panel may have been remounted (a terminal-tab switch)
   * before the upload finished.
   */
  async function uploadPaths(destDir: string, paths: string[]) {
    if (paths.length === 0) return;
    let check: UploadCheck | null;
    try {
      check = checkUpload(
        paths,
        (await sftpList(sessionId, destDir)).map((e) => e.name),
      );
    } catch {
      check = null;
    }
    // Nothing taken — nothing to ask: every name is free, and none may replace.
    const ask = check === null || check.clash.length > 0;
    const items = uploadItems(paths, check, ask ? await askReplace(destDir, check) : "skip");
    if (items.length === 0) return;
    beginUpload(sessionId, destDir);
    try {
      for (const { path, replace } of items) {
        const name = baseName(path);
        await runTransfer(
          (id) =>
            sftpUpload(sessionId, id, path, `${destDir}/${name}`.replace(/\/+/g, "/"), replace),
          // Taken since the folder was asked: refused, not replaced.
          (error) =>
            isDestExists(error) ? t("sftp.moveConflict", { name, dest: destDir }) : error,
        );
      }
    } finally {
      endUpload(sessionId, destDir);
    }
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
    // For a folder `dest` is the parent directory the tree is created under.
    const target = dest;
    await runTransfer((id) => sftpDownload(sessionId, id, entry.path, target, entry.isDir));
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
            <Icon
              name={tr.direction === "upload" ? "arrowUp" : "arrowDown"}
              size={12}
              class="shrink-0 text-accent"
            />
            <span class="min-w-0 flex-1 truncate" title={tr.name}>{tr.name}</span>
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

<!-- Upload onto names the folder already holds: replace, skip them, or cancel. -->
<ConfirmDialog
  open={!!replaceAsk}
  title={replaceAsk?.names === null ? t("sftp.replaceUncheckedTitle") : t("sftp.replaceTitle")}
  confirmLabel={replaceAsk?.names === null
    ? t("sftp.replaceUncheckedConfirm")
    : t("sftp.replaceConfirm")}
  altLabel={replaceAsk?.canSkip ? t("sftp.replaceSkip") : undefined}
  onconfirm={() => replaceAsk?.answer("replace")}
  onalt={() => replaceAsk?.answer("skip")}
  oncancel={() => replaceAsk?.answer("cancel")}
>
  {#if replaceAsk}
    {#if replaceAsk.names === null}
      {t("sftp.replaceUnchecked", { dest: replaceAsk.dest })}
    {:else if replaceAsk.names.length === 1 && replaceAsk.more === 0}
      {t("sftp.replaceOne", { name: replaceAsk.names[0], dest: replaceAsk.dest })}
    {:else}
      {t("sftp.replaceMany", {
        count: replaceAsk.names.length + replaceAsk.more,
        dest: replaceAsk.dest,
      })}
      <ul class="mt-1.5 space-y-0.5" data-testid="replace-names">
        {#each replaceAsk.names as name, i (i)}
          <li class="break-all text-text">{name}</li>
        {/each}
        {#if replaceAsk.more > 0}
          <li>{t("sftp.replaceMore", { count: replaceAsk.more })}</li>
        {/if}
      </ul>
    {/if}
  {/if}
</ConfirmDialog>

<!-- Directory sync (compares local folder ⇄ current remote folder) -->
<SyncModal
  open={showSync}
  {sessionId}
  remotePath={cwd || "."}
  onclose={() => (showSync = false)}
  onapplied={() => browser?.refresh()}
/>
