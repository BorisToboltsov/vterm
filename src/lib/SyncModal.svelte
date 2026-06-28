<script lang="ts">
  // Directory sync dialog (Phase 12.5): compare a local folder against the SFTP
  // panel's current remote folder (dry-run), then apply only the changed files.
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import { pickSaveDir, localHashTree, sftpHashTree, sftpSyncApply } from "./api";
  import {
    diffTrees,
    parseExcludes,
    applicable,
    summarize,
    type SyncAction,
    type SyncDirection,
    type SyncOp,
  } from "./sync";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import { t, type MessageKey } from "./i18n";

  let {
    open = false,
    sessionId,
    remotePath,
    onclose,
    onapplied,
  }: {
    open?: boolean;
    sessionId: string;
    remotePath: string;
    onclose?: () => void;
    onapplied?: () => void;
  } = $props();

  let localPath = $state("");
  let direction = $state<SyncDirection>("push");
  let excludeText = $state(".git\nnode_modules\n*.tfstate");
  let deleteExtraneous = $state(false);
  let comparing = $state(false);
  let applying = $state(false);
  let plan = $state<SyncAction[] | null>(null);
  let error = $state("");

  const counts = $derived(plan ? summarize(plan) : null);
  const toApply = $derived(plan ? applicable(plan) : []);

  // Re-comparing is required after changing inputs (the old plan is stale).
  function invalidate() {
    plan = null;
  }

  async function chooseLocal() {
    const dir = await pickSaveDir();
    if (dir) {
      localPath = dir;
      invalidate();
    }
  }

  async function compare() {
    if (!localPath) return;
    comparing = true;
    error = "";
    try {
      const [local, remote] = await Promise.all([
        localHashTree(localPath),
        sftpHashTree(sessionId, remotePath),
      ]);
      plan = diffTrees(local, remote, direction, parseExcludes(excludeText), deleteExtraneous);
    } catch (e) {
      error = String(e);
      plan = null;
    } finally {
      comparing = false;
    }
  }

  async function apply() {
    if (toApply.length === 0) return;
    applying = true;
    try {
      const stats = await sftpSyncApply(sessionId, localPath, remotePath, toApply);
      notifySuccess(
        t("sync.applied", {
          up: stats.uploaded,
          down: stats.downloaded,
          del: stats.deleted,
        }),
      );
      onapplied?.();
      onclose?.();
    } catch (e) {
      notifyError(String(e));
    } finally {
      applying = false;
    }
  }

  const OP_LABEL: Record<SyncOp, MessageKey> = {
    upload: "sync.opUpload",
    download: "sync.opDownload",
    deleteRemote: "sync.opDeleteRemote",
    deleteLocal: "sync.opDeleteLocal",
    conflict: "sync.opConflict",
  };

  const DIRECTIONS: [SyncDirection, MessageKey][] = [
    ["push", "sync.push"],
    ["pull", "sync.pull"],
    ["bi", "sync.bi"],
  ];

  function opClass(op: SyncOp): string {
    if (op === "conflict") return "text-warn";
    if (op === "deleteRemote" || op === "deleteLocal") return "text-danger";
    return "text-accent";
  }
</script>

<Modal {open} title={t("sync.title")} width="w-[90vw] max-w-2xl" {onclose}>
  <div class="space-y-3 text-xs">
    <!-- Folders -->
    <div class="flex items-center gap-2">
      <span class="w-16 shrink-0 text-muted">{t("sync.localFolder")}</span>
      <span class="min-w-0 flex-1 truncate text-white" title={localPath}>
        {localPath || "—"}
      </span>
      <button
        class="shrink-0 rounded bg-edge px-2 py-1 hover:bg-accent hover:text-panel-alt"
        onclick={chooseLocal}>{t("sync.choose")}</button
      >
    </div>
    <div class="flex items-center gap-2">
      <span class="w-16 shrink-0 text-muted">{t("sync.remoteFolder")}</span>
      <span class="min-w-0 flex-1 truncate text-white" title={remotePath}>{remotePath}</span>
    </div>

    <!-- Direction -->
    <div class="flex items-center gap-3">
      <span class="w-16 shrink-0 text-muted">{t("sync.direction")}</span>
      {#each DIRECTIONS as [val, key] (val)}
        <label class="flex items-center gap-1 text-muted">
          <input
            type="radio"
            name="sync-dir"
            value={val}
            checked={direction === val}
            onchange={() => {
              direction = val;
              invalidate();
            }}
          />
          {t(key)}
        </label>
      {/each}
    </div>

    <!-- Excludes -->
    <label class="block text-muted">
      {t("sync.exclude")}
      <textarea
        rows="2"
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-white outline-none focus:border-accent"
        placeholder={t("sync.excludePlaceholder")}
        bind:value={excludeText}
        oninput={invalidate}
      ></textarea>
    </label>

    <label class="flex items-center gap-2 text-muted">
      <input type="checkbox" bind:checked={deleteExtraneous} onchange={invalidate} />
      {t("sync.deleteExtraneous")}
    </label>

    {#if error}
      <p class="break-words text-danger">{error}</p>
    {/if}

    <!-- Dry-run preview -->
    {#if plan}
      {#if plan.length === 0}
        <p class="rounded border border-edge bg-panel px-3 py-2 text-muted">{t("sync.noChanges")}</p>
      {:else}
        <div class="text-muted">
          {t("sync.summary", {
            up: counts?.upload ?? 0,
            down: counts?.download ?? 0,
            del: (counts?.deleteRemote ?? 0) + (counts?.deleteLocal ?? 0),
            conflict: counts?.conflict ?? 0,
          })}
        </div>
        <div class="max-h-56 overflow-auto rounded border border-edge">
          {#each plan as a (a.path)}
            <div class="flex items-center gap-2 border-b border-edge/50 px-2 py-1 last:border-0">
              <span class="w-24 shrink-0 {opClass(a.op)}">{t(OP_LABEL[a.op])}</span>
              <span class="min-w-0 flex-1 truncate" title={a.path}>{a.path}</span>
            </div>
          {/each}
        </div>
        {#if (counts?.conflict ?? 0) > 0}
          <p class="text-[11px] text-warn">{t("sync.conflictNote")}</p>
        {/if}
      {/if}
    {/if}

    <!-- Actions -->
    <div class="flex justify-end gap-2 pt-1">
      <button class="rounded px-3 py-1 text-muted hover:text-white" onclick={() => onclose?.()}>
        {t("common.cancel")}
      </button>
      <button
        class="flex items-center gap-1 rounded bg-edge px-3 py-1 hover:bg-accent hover:text-panel-alt disabled:opacity-40"
        disabled={!localPath || comparing}
        onclick={compare}
      >
        <Icon name="sync" size={13} />
        {comparing ? t("sync.comparing") : t("sync.compare")}
      </button>
      <button
        class="rounded bg-green-600 px-3 py-1 font-medium text-white hover:bg-green-500 disabled:opacity-40"
        disabled={!plan || toApply.length === 0 || applying}
        onclick={apply}
      >
        {applying ? t("sync.applying") : t("sync.apply")}
      </button>
    </div>
  </div>
</Modal>
