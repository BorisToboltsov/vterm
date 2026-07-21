<script lang="ts">
  // Directory sync dialog (Phase 12.5): compare a local folder against the SFTP
  // panel's current remote folder (dry-run), then apply only the changed files.
  import Modal from "./Modal.svelte";
  import { tooltip } from "./actions/tooltip";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
  import { pickSaveDir, localHashTree, sftpHashTree, sftpSyncApply, sftpCancel } from "./api";
  import {
    diffTrees,
    parseExcludes,
    applicable,
    summarize,
    syncTransferId,
    syncRowStatus,
    syncRowPct,
    syncRunSummary,
    type SyncAction,
    type SyncDirection,
    type SyncOp,
    type SyncRunPhase,
    type SyncRowStatus,
  } from "./sync";
  import { syncRunState, clearSyncRun } from "./stores/syncrun.svelte";
  import { notifyError, notifySuccess, notifyInfo } from "./stores/toasts.svelte";
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
  // Run state (Phase 39.8): the plan list doubles as the progress list, so the
  // dialog no longer looks frozen while the right dock fills up.
  let phase = $state<SyncRunPhase>("idle");
  let runId = $state("");
  let stopping = $state(false);

  const counts = $derived(plan ? summarize(plan) : null);
  const toApply = $derived(plan ? applicable(plan) : []);
  const runProgress = $derived(
    plan ? syncRunSummary(plan, syncRunState.map) : { filesDone: 0, filesTotal: 0, pct: 0 },
  );

  // Re-comparing is required after changing inputs (the old plan is stale).
  function invalidate() {
    plan = null;
    phase = "idle";
    clearSyncRun();
  }

  function rowProgress(path: string) {
    return syncRunState.map[syncTransferId(path)];
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
    stopping = false;
    phase = "running";
    runId = `sync-run-${crypto.randomUUID()}`;
    clearSyncRun();
    try {
      const stats = await sftpSyncApply(sessionId, runId, localPath, remotePath, toApply);
      onapplied?.();
      if (stats.stopped) {
        // Stay open: the ticked rows ARE the report of what got through, and the
        // plan is stale afterwards — closing would hide both.
        phase = "stopped";
        notifyInfo(
          t("sync.stoppedToast", {
            done: stats.uploaded + stats.downloaded + stats.deleted,
            total: toApply.length,
          }),
        );
        return;
      }
      phase = "done";
      notifySuccess(
        t("sync.applied", {
          up: stats.uploaded,
          down: stats.downloaded,
          del: stats.deleted,
        }),
      );
      onclose?.();
    } catch (e) {
      phase = "stopped";
      notifyError(String(e));
    } finally {
      applying = false;
      stopping = false;
    }
  }

  /** Ask the backend to stop after the file currently in flight. */
  function stop() {
    if (!runId) return;
    stopping = true;
    sftpCancel(runId);
  }

  const ROW_STATUS_LABEL: Record<Exclude<SyncRowStatus, "done" | "running">, MessageKey> = {
    pending: "sync.rowPending",
    notRun: "sync.rowNotRun",
    skipped: "sync.rowSkipped",
  };

  const OP_LABEL: Record<SyncOp, MessageKey> = {
    upload: "sync.opUpload",
    download: "sync.opDownload",
    deleteRemote: "sync.opDeleteRemote",
    deleteLocal: "sync.opDeleteLocal",
    conflict: "sync.opConflict",
  };

  const DIRECTIONS: { val: SyncDirection; short: MessageKey; full: MessageKey; icon: IconName }[] = [
    { val: "push", short: "sync.pushShort", full: "sync.push", icon: "upload" },
    { val: "pull", short: "sync.pullShort", full: "sync.pull", icon: "download" },
    { val: "bi", short: "sync.biShort", full: "sync.bi", icon: "arrowsUpDown" },
  ];

  /** Arrow shown between the Local and Remote cards, reflecting the direction. */
  const betweenIcon: IconName = $derived(
    direction === "push" ? "arrowRight" : direction === "pull" ? "arrowLeft" : "arrowsLeftRight",
  );

  function opClass(op: SyncOp): string {
    if (op === "conflict") return "text-warn";
    if (op === "deleteRemote" || op === "deleteLocal") return "text-danger";
    return "text-accent";
  }
</script>

<Modal {open} title={t("sync.title")} width="w-[90vw] max-w-2xl" showClose {onclose}>
  <div class="space-y-3 text-xs">
    <!-- Folders as two cards with a direction-aware arrow between them -->
    <div class="flex items-stretch gap-2">
      <div class="min-w-0 flex-1 rounded border border-edge bg-panel p-2">
        <div class="text-meta text-muted">{t("sync.localFolder")}</div>
        <div class="mt-1 flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-text" title={localPath}>{localPath || "—"}</span>
          <button
            class="shrink-0 rounded bg-edge px-2 py-0.5 hover:bg-accent hover:text-panel-alt"
            onclick={chooseLocal}>{t("sync.choose")}</button
          >
        </div>
      </div>
      <div class="flex shrink-0 items-center text-accent" use:tooltip={t(DIRECTIONS.find((d) => d.val === direction)?.full ?? "sync.push")}>
        <Icon name={betweenIcon} size={20} />
      </div>
      <div class="min-w-0 flex-1 rounded border border-edge bg-panel p-2">
        <div class="text-meta text-muted">{t("sync.remoteFolder")}</div>
        <div class="mt-1 truncate text-text" title={remotePath}>{remotePath}</div>
      </div>
    </div>

    <!-- Direction as a segmented control -->
    <div class="flex justify-center">
      <div class="flex overflow-hidden rounded border border-edge">
        {#each DIRECTIONS as d (d.val)}
          <button
            type="button"
            class="flex items-center gap-1 border-r border-edge px-3 py-1 last:border-r-0 {direction ===
            d.val
              ? 'bg-edge text-accent'
              : 'text-muted hover:text-text'}"
            aria-pressed={direction === d.val}
            aria-label={t(d.full)} use:tooltip={t(d.full)}
            onclick={() => {
              direction = d.val;
              invalidate();
            }}
          >
            <Icon name={d.icon} size={13} />
            {t(d.short)}
          </button>
        {/each}
      </div>
    </div>

    <!-- Excludes -->
    <label class="block text-muted">
      {t("sync.exclude")}
      <textarea
        rows="4"
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-text outline-none focus:border-accent"
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
        {#if phase === "idle"}
          <div class="text-muted">
            {t("sync.summary", {
              up: counts?.upload ?? 0,
              down: counts?.download ?? 0,
              del: (counts?.deleteRemote ?? 0) + (counts?.deleteLocal ?? 0),
              conflict: counts?.conflict ?? 0,
            })}
          </div>
        {:else if phase === "running"}
          <!-- Run header: the same numbers the right dock shows, without leaving the dialog. -->
          <div>
            <div class="flex items-center justify-between gap-2 text-muted">
              <span
                >{t("sync.runProgress", {
                  done: runProgress.filesDone,
                  total: runProgress.filesTotal,
                })}</span
              >
              <span class="text-accent">{runProgress.pct}%</span>
            </div>
            <div class="mt-1 h-1 rounded bg-edge">
              <div class="h-1 rounded bg-accent" style="width: {runProgress.pct}%"></div>
            </div>
          </div>
        {:else if phase === "stopped"}
          <p class="rounded border border-warn bg-panel px-3 py-2 text-warn">
            {t("sync.stoppedNote", {
              done: runProgress.filesDone,
              total: runProgress.filesTotal,
            })}
          </p>
        {/if}
        <div class="max-h-56 overflow-auto rounded border border-edge">
          {#each plan as a (a.path)}
            {@const prog = rowProgress(a.path)}
            {@const status = syncRowStatus(a.op, prog, phase)}
            <div
              class="border-b border-edge/50 px-2 py-1 last:border-0 {status === 'pending' ||
              status === 'notRun'
                ? 'opacity-50'
                : ''}"
            >
              <div class="flex items-center gap-2">
                <span class="w-24 shrink-0 {opClass(a.op)}">{t(OP_LABEL[a.op])}</span>
                <span class="min-w-0 flex-1 truncate" title={a.path}>{a.path}</span>
                {#if status === "done"}
                  <span class="shrink-0 text-ok" aria-label={t("sync.rowDone")}>
                    <Icon name="check" size={13} />
                  </span>
                {:else if status === "running"}
                  <span class="shrink-0 text-accent">{syncRowPct(prog)}%</span>
                {:else if phase !== "idle" || status === "skipped"}
                  <span class="shrink-0 text-meta text-muted">{t(ROW_STATUS_LABEL[status])}</span>
                {/if}
              </div>
              {#if status === "running"}
                <div class="mt-1 h-0.5 rounded bg-edge">
                  <div class="h-0.5 rounded bg-accent" style="width: {syncRowPct(prog)}%"></div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
        {#if (counts?.conflict ?? 0) > 0}
          <p class="text-meta text-warn">{t("sync.conflictNote")}</p>
        {/if}
      {/if}
    {/if}

    <!-- Actions -->
    <div class="flex justify-end gap-2 pt-1">
      {#if applying}
        <button
          class="flex items-center gap-1 rounded border border-danger px-3 py-1 text-danger hover:bg-danger hover:text-white disabled:opacity-40"
          disabled={stopping}
          onclick={stop}
        >
          <Icon name="close" size={13} />
          {stopping ? t("sync.stopping") : t("sync.stop")}
        </button>
      {:else}
        <button class="rounded px-3 py-1 text-muted hover:text-text" onclick={() => onclose?.()}>
          {t("common.cancel")}
        </button>
      {/if}
      <button
        class="flex items-center gap-1 rounded bg-edge px-3 py-1 hover:bg-accent hover:text-panel-alt disabled:opacity-40"
        disabled={!localPath || comparing || applying}
        onclick={compare}
      >
        <Icon name="sync" size={13} />
        {comparing ? t("sync.comparing") : phase === "stopped" ? t("sync.compareAgain") : t("sync.compare")}
      </button>
      <button
        class="rounded bg-green-600 px-3 py-1 font-medium text-white hover:bg-green-500 disabled:opacity-40"
        disabled={!plan || toApply.length === 0 || applying || phase === "stopped"}
        onclick={apply}
      >
        {applying ? t("sync.applying") : t("sync.apply")}
      </button>
    </div>
  </div>
</Modal>
