<script lang="ts">
  // Directory sync dialog (Phase 12.5): compare a local folder against a remote
  // folder (dry-run), then apply only the changed files. The remote folder starts
  // as the SFTP panel's current one and is then the dialog's own (v1.0.24): it can
  // be re-picked here, and it does not jump when the panel follows the terminal.
  import Modal from "./Modal.svelte";
  import SyncRemotePicker from "./SyncRemotePicker.svelte";
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
    planFacts,
    emptyPlanReason,
    wipesTarget,
    syncBlockReasons,
    syncErrorView,
    type PlanFacts,
    type EmptyPlanReason,
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
  // The dialog's own remote folder, seeded from the panel on every open.
  let remote = $state("");
  let picking = $state(false);
  let facts = $state<PlanFacts | null>(null);
  let skipped = $state({ local: 0, remote: 0 });
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

  // Seed from the panel when the dialog opens; a changed folder makes the old plan
  // stale. While open, the panel moving (follow-terminal) must NOT retarget a
  // compared plan — Apply would run it against a folder it was never compared to.
  let wasOpen = false;
  $effect(() => {
    const isOpen = open;
    if (isOpen && !wasOpen) {
      picking = false;
      if (remotePath !== remote) {
        remote = remotePath;
        invalidate();
      }
    }
    wasOpen = isOpen;
  });

  const counts = $derived(plan ? summarize(plan) : null);
  const toApply = $derived(plan ? applicable(plan) : []);
  const runProgress = $derived(
    plan ? syncRunSummary(plan, syncRunState.map) : { filesDone: 0, filesTotal: 0, pct: 0 },
  );

  // Re-comparing is required after changing inputs (the old plan is stale).
  function invalidate() {
    plan = null;
    facts = null;
    error = "";
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

  function pickRemote(path: string) {
    picking = false;
    if (path !== remote) {
      remote = path;
      invalidate();
    }
  }

  async function compare() {
    if (!localPath || !remote) return;
    comparing = true;
    error = "";
    try {
      const [local, rem] = await Promise.all([
        localHashTree(localPath),
        sftpHashTree(sessionId, remote),
      ]);
      const excludes = parseExcludes(excludeText);
      plan = diffTrees(local.entries, rem.entries, direction, excludes, deleteExtraneous);
      facts = planFacts(local.entries, rem.entries, direction, excludes);
      skipped = { local: local.skipped, remote: rem.skipped };
      phase = "idle";
    } catch (e) {
      error = errorText(String(e));
      plan = null;
      facts = null;
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
      const stats = await sftpSyncApply(sessionId, runId, localPath, remote, toApply);
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

  /** A hashing failure in words — never shown as an empty folder (see sync.rs). */
  function errorText(err: string): string {
    const v = syncErrorView(err);
    if (v.key === "sync.errDirUnreadable") return t(v.key, { path: v.path });
    if (v.key) return t(v.key);
    return v.raw;
  }

  const EMPTY_PLAN_TEXT: Record<Exclude<EmptyPlanReason, "onlyExtraneous">, MessageKey> = {
    bothEmpty: "sync.emptyBoth",
    allExcluded: "sync.allExcluded",
    identical: "sync.identical",
  };

  /** The line under an empty plan: why it is empty, with the numbers. */
  function emptyPlanText(f: PlanFacts): string {
    const reason = emptyPlanReason(f);
    if (reason === "onlyExtraneous")
      return t(direction === "push" ? "sync.onlyRemote" : "sync.onlyLocal", { n: f.extraneous });
    return t(EMPTY_PLAN_TEXT[reason], { n: reason === "allExcluded" ? f.excluded : f.localFiles });
  }

  const wipe = $derived(facts ? wipesTarget(facts, direction, deleteExtraneous) : null);
  const blocked = $derived(
    syncBlockReasons({
      localPath,
      remotePath: remote,
      hasPlan: !!plan,
      applicableCount: toApply.length,
      conflictCount: counts?.conflict ?? 0,
      phase,
      busy: comparing || applying,
    }),
  );
  // One reason line beside the buttons: Compare's if it is blocked, else Apply's.
  // An empty plan already explains itself in the box above, so no second line.
  const blockReason = $derived(
    comparing || applying
      ? null
      : (blocked.compare ?? (plan && plan.length === 0 ? null : blocked.apply)),
  );

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
            class="shrink-0 rounded bg-edge px-2 py-0.5 hover:bg-accent hover:text-panel-alt disabled:opacity-40"
            aria-label={t("sync.chooseLocal")}
            disabled={applying}
            onclick={chooseLocal}>{t("sync.choose")}</button
          >
        </div>
      </div>
      <div class="flex shrink-0 items-center text-accent" use:tooltip={t(DIRECTIONS.find((d) => d.val === direction)?.full ?? "sync.push")}>
        <Icon name={betweenIcon} size={20} />
      </div>
      <div class="min-w-0 flex-1 rounded border border-edge bg-panel p-2">
        <div class="text-meta text-muted">{t("sync.remoteFolder")}</div>
        <div class="mt-1 flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-text" title={remote}>{remote || "—"}</span>
          <button
            class="shrink-0 rounded bg-edge px-2 py-0.5 hover:bg-accent hover:text-panel-alt disabled:opacity-40"
            aria-label={t("sync.chooseRemote")}
            disabled={applying}
            onclick={() => (picking = !picking)}>{t("sync.choose")}</button
          >
        </div>
      </div>
    </div>

    {#if picking}
      <SyncRemotePicker
        {sessionId}
        start={remote}
        onpick={pickRemote}
        oncancel={() => (picking = false)}
      />
    {/if}

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

    <!-- Unreadable items are missing from the plan — say so, whatever the plan is. -->
    {#if plan && (skipped.local > 0 || skipped.remote > 0)}
      <p class="rounded border border-warn bg-panel px-3 py-2 text-warn" data-testid="sync-skipped">
        {#if skipped.local > 0}{t("sync.skippedLocal", { n: skipped.local })}{/if}
        {#if skipped.remote > 0}{t("sync.skippedRemote", { n: skipped.remote })}{/if}
      </p>
    {/if}

    <!-- Dry-run preview -->
    {#if plan}
      {#if plan.length === 0}
        <p class="rounded border border-edge bg-panel px-3 py-2 text-muted" data-testid="sync-empty">
          {facts ? emptyPlanText(facts) : t("sync.identical", { n: 0 })}
        </p>
      {:else}
        {#if wipe && phase === "idle"}
          <p class="rounded border border-danger bg-panel px-3 py-2 text-danger" data-testid="sync-wipe">
            {t(wipe === "local" ? "sync.wipeLocalEmpty" : "sync.wipeRemoteEmpty", {
              n: wipe === "local" ? (facts?.remoteFiles ?? 0) : (facts?.localFiles ?? 0),
            })}
          </p>
        {/if}
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

    <!-- Actions, with the reason a disabled one can't run yet -->
    <div class="flex items-center justify-end gap-2 pt-1">
      {#if blockReason}
        <span class="mr-auto text-meta text-muted" data-testid="sync-block-reason">{t(blockReason)}</span>
      {/if}
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
        disabled={!!blocked.compare || comparing || applying}
        onclick={compare}
      >
        <Icon name="sync" size={13} />
        {comparing ? t("sync.comparing") : phase === "stopped" ? t("sync.compareAgain") : t("sync.compare")}
      </button>
      <button
        class="rounded bg-green-600 px-3 py-1 font-medium text-white hover:bg-green-500 disabled:opacity-40"
        disabled={!!blocked.apply || applying}
        onclick={apply}
      >
        {applying ? t("sync.applying") : t("sync.apply")}
      </button>
    </div>
  </div>
</Modal>
