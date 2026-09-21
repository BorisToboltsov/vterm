<script lang="ts">
  // Directory sync dialog (Phase 12.5): compare a local folder against a remote
  // folder (dry-run), then apply only the changed files.
  //
  // v1.0.25: the dialog is a VIEW of the session's sync job (stores/syncjob) — the
  // form, the plan and the compare/run in flight live there, so "Run in the
  // background" can close the dialog without losing them, and the SFTP panel's
  // remount on a terminal-tab switch doesn't either. The remote folder is seeded
  // from the panel only when there is no plan and nothing running; after that it
  // changes only by picking it here. Big plans are rendered virtualized.
  import Modal from "./Modal.svelte";
  import SyncRemotePicker from "./SyncRemotePicker.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { tooltip } from "./actions/tooltip";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
  import { pickSaveDir } from "./api";
  import {
    applicable,
    summarize,
    syncTransferId,
    syncRowStatus,
    syncRowPct,
    emptyPlanReason,
    wipesTarget,
    syncBlockReasons,
    planFolders,
    filterPlan,
    matchesFilter,
    type PlanFacts,
    type PlanFilter,
    type EmptyPlanReason,
    type SyncDirection,
    type SyncOp,
    type SyncRowStatus,
  } from "./sync";
  import { windowRange } from "./virtuallist";
  import { syncRunState } from "./stores/syncrun.svelte";
  import {
    syncJob,
    syncRunOwner,
    invalidate as invalidateJob,
    compare as compareJob,
    apply as applyJob,
    stopCompare,
    stopRun,
    otherRunHolds,
  } from "./stores/syncjob.svelte";
  import { t, type MessageKey } from "./i18n";
  import { untrack } from "svelte";

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

  // The session is fixed for this component's life (the panel remounts per tab).
  const job = untrack(() => syncJob(sessionId));

  let picking = $state(false);
  let confirmStop = $state(false);
  let filter = $state<PlanFilter>("all");
  let folder = $state<string | null>(null);
  let foldersOpen = $state(false);

  const busy = $derived(job.comparing || job.applying);

  function invalidate() {
    invalidateJob(job);
    filter = "all";
    folder = null;
  }

  // On open: tell the job it is being watched, and seed the remote folder from the
  // panel unless a plan or a run already belongs to another folder — moving the
  // panel (follow-terminal) must not retarget work compared against a different one.
  let wasOpen = false;
  $effect(() => {
    const isOpen = open;
    untrack(() => {
      job.dialogOpen = isOpen;
      if (isOpen && !wasOpen) {
        picking = false;
        if (job.phase === "done") job.phase = "idle";
        if (!job.plan && !busy && remotePath !== job.remote) {
          job.remote = remotePath;
          invalidate();
        }
      }
    });
    wasOpen = isOpen;
  });

  // A clean run finished while the dialog was up: close it (the toast reports).
  $effect(() => {
    if (open && job.phase === "done") {
      untrack(() => {
        job.phase = "idle";
        onclose?.();
      });
    }
  });

  const plan = $derived(job.plan);
  const counts = $derived(plan ? summarize(plan) : null);
  const toApply = $derived(plan ? applicable(plan) : []);
  // O(1): running totals kept by the progress store (see syncrun.svelte.ts).
  const runProgress = $derived({
    filesDone: syncRunState.done,
    filesTotal: toApply.length,
    pct: toApply.length === 0 ? 0 : Math.round((syncRunState.weight / toApply.length) * 100),
  });
  const ownsRun = $derived(syncRunOwner.sessionId === sessionId);

  async function chooseLocal() {
    const dir = await pickSaveDir();
    if (dir && dir !== job.localPath) {
      job.localPath = dir;
      invalidate();
    }
  }

  function pickRemote(path: string) {
    picking = false;
    if (path !== job.remote) {
      job.remote = path;
      invalidate();
    }
  }

  function compare() {
    filter = "all";
    folder = null;
    void compareJob(sessionId);
  }

  function apply() {
    void applyJob(sessionId, onapplied);
  }

  /** Cancel / × / Escape / backdrop: ask before abandoning work in flight. */
  function requestClose() {
    if (busy) confirmStop = true;
    else onclose?.();
  }

  function confirmStopAndClose() {
    confirmStop = false;
    if (job.comparing) stopCompare(job);
    // A run stops after the file in flight (a cut copy would leave a truncated
    // file); its toast still reports how far it got once the window is gone.
    if (job.applying) stopRun(job);
    onclose?.();
  }

  /** Keep working with the dialog closed; progress stays in the status bar / panel. */
  function background() {
    onclose?.();
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
      return t(job.direction === "push" ? "sync.onlyRemote" : "sync.onlyLocal", { n: f.extraneous });
    return t(EMPTY_PLAN_TEXT[reason], { n: reason === "allExcluded" ? f.excluded : f.localFiles });
  }

  const wipe = $derived(job.facts ? wipesTarget(job.facts, job.direction, job.deleteExtraneous) : null);
  const blocked = $derived(
    syncBlockReasons({
      localPath: job.localPath,
      remotePath: job.remote,
      hasPlan: !!plan,
      applicableCount: toApply.length,
      conflictCount: counts?.conflict ?? 0,
      phase: job.phase,
      busy,
      otherRunning: otherRunHolds(sessionId),
    }),
  );
  // An empty plan already explains itself in the box above, so no second line.
  const blockReason = $derived(
    busy ? null : (blocked.compare ?? (plan && plan.length === 0 ? null : blocked.apply)),
  );

  // ── the plan list: filter, folder overview, virtualized rows ────────────────
  const FILTERS: { val: PlanFilter; label: MessageKey }[] = [
    { val: "all", label: "sync.filterAll" },
    { val: "upload", label: "sync.filterUpload" },
    { val: "download", label: "sync.filterDownload" },
    { val: "delete", label: "sync.filterDelete" },
    { val: "conflict", label: "sync.filterConflict" },
  ];
  function filterCount(f: PlanFilter): number {
    if (!counts) return 0;
    if (f === "all") return plan?.length ?? 0;
    if (f === "delete") return counts.deleteRemote + counts.deleteLocal;
    return counts[f];
  }
  const folders = $derived(plan ? planFolders(plan) : []);
  const rows = $derived(plan ? filterPlan(plan, filter, folder) : []);

  const ROW_H = 28;
  let scrollTop = $state(0);
  let viewportH = $state(224);
  // `h-56` is 224 px; the fallback covers the first frame (and jsdom) before
  // the element has been measured, where 0 would mean "render everything".
  const win = $derived(windowRange(scrollTop, viewportH || 224, ROW_H, rows.length));
  let listEl = $state<HTMLElement | null>(null);
  // A new filter or plan starts at the top.
  $effect(() => {
    void rows;
    untrack(() => {
      scrollTop = 0;
      if (listEl) listEl.scrollTop = 0;
    });
  });

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
    job.direction === "push" ? "arrowRight" : job.direction === "pull" ? "arrowLeft" : "arrowsLeftRight",
  );

  function opClass(op: SyncOp): string {
    if (op === "conflict") return "text-warn";
    if (op === "deleteRemote" || op === "deleteLocal") return "text-danger";
    return "text-accent";
  }
</script>

<Modal {open} title={t("sync.title")} width="w-[90vw] max-w-2xl" showClose onclose={requestClose}>
  <div class="space-y-3 text-xs">
    <!-- Folders as two cards with a direction-aware arrow between them -->
    <div class="flex items-stretch gap-2">
      <div class="min-w-0 flex-1 rounded border border-edge bg-panel p-2">
        <div class="text-meta text-muted">{t("sync.localFolder")}</div>
        <div class="mt-1 flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-text" title={job.localPath}>{job.localPath || "—"}</span>
          <button
            class="shrink-0 rounded bg-edge px-2 py-0.5 hover:bg-accent hover:text-panel-alt disabled:opacity-40"
            aria-label={t("sync.chooseLocal")}
            disabled={busy}
            onclick={chooseLocal}>{t("sync.choose")}</button
          >
        </div>
      </div>
      <div class="flex shrink-0 items-center text-accent" use:tooltip={t(DIRECTIONS.find((d) => d.val === job.direction)?.full ?? "sync.push")}>
        <Icon name={betweenIcon} size={20} />
      </div>
      <div class="min-w-0 flex-1 rounded border border-edge bg-panel p-2">
        <div class="text-meta text-muted">{t("sync.remoteFolder")}</div>
        <div class="mt-1 flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-text" title={job.remote}>{job.remote || "—"}</span>
          <button
            class="shrink-0 rounded bg-edge px-2 py-0.5 hover:bg-accent hover:text-panel-alt disabled:opacity-40"
            aria-label={t("sync.chooseRemote")}
            disabled={busy}
            onclick={() => (picking = true)}>{t("sync.choose")}</button
          >
        </div>
      </div>
    </div>

    <!-- Direction as a segmented control -->
    <div class="flex justify-center">
      <div class="flex overflow-hidden rounded border border-edge">
        {#each DIRECTIONS as d (d.val)}
          <button
            type="button"
            class="flex items-center gap-1 border-r border-edge px-3 py-1 last:border-r-0 disabled:opacity-40 {job.direction ===
            d.val
              ? 'bg-edge text-accent'
              : 'text-muted hover:text-text'}"
            aria-pressed={job.direction === d.val}
            aria-label={t(d.full)} use:tooltip={t(d.full)}
            disabled={busy}
            onclick={() => {
              job.direction = d.val;
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
        disabled={busy}
        bind:value={job.excludeText}
        oninput={invalidate}
      ></textarea>
    </label>

    <label class="flex items-center gap-2 text-muted">
      <input type="checkbox" disabled={busy} bind:checked={job.deleteExtraneous} onchange={invalidate} />
      {t("sync.deleteExtraneous")}
    </label>

    {#if job.error}
      <p class="break-words text-danger">{job.error}</p>
    {/if}

    <!-- Compare in flight: honest counters, no percentage — the total isn't known. -->
    {#if job.comparing}
      <div class="rounded border border-edge bg-panel px-3 py-2 text-muted" data-testid="sync-scan">
        {t("sync.scanProgress", { local: job.scan.local, remote: job.scan.remote })}
      </div>
    {/if}

    <!-- Unreadable items are missing from the plan — say so, whatever the plan is. -->
    {#if plan && (job.skipped.local > 0 || job.skipped.remote > 0)}
      <p class="rounded border border-warn bg-panel px-3 py-2 text-warn" data-testid="sync-skipped">
        {#if job.skipped.local > 0}{t("sync.skippedLocal", { n: job.skipped.local })}{/if}
        {#if job.skipped.remote > 0}{t("sync.skippedRemote", { n: job.skipped.remote })}{/if}
      </p>
    {/if}

    <!-- Dry-run preview -->
    {#if plan}
      {#if plan.length === 0}
        <p class="rounded border border-edge bg-panel px-3 py-2 text-muted" data-testid="sync-empty">
          {job.facts ? emptyPlanText(job.facts) : t("sync.identical", { n: 0 })}
        </p>
      {:else}
        {#if wipe && job.phase === "idle"}
          <p class="rounded border border-danger bg-panel px-3 py-2 text-danger" data-testid="sync-wipe">
            {t(wipe === "local" ? "sync.wipeLocalEmpty" : "sync.wipeRemoteEmpty", {
              n: wipe === "local" ? (job.facts?.remoteFiles ?? 0) : (job.facts?.localFiles ?? 0),
            })}
          </p>
        {/if}
        {#if job.phase === "running" && ownsRun}
          <!-- Run header: O(1) totals from the progress store. -->
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
        {:else if job.phase === "stopped"}
          <p class="rounded border border-warn bg-panel px-3 py-2 text-warn">
            {t("sync.stoppedNote", {
              done: runProgress.filesDone,
              total: runProgress.filesTotal,
            })}
          </p>
        {/if}

        <!-- Filter by what happens to a file; counts double as the summary. -->
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex overflow-hidden rounded border border-edge" role="group" aria-label={t("sync.filterLabel")}>
            {#each FILTERS as f (f.val)}
              {@const n = filterCount(f.val)}
              {#if f.val === "all" || n > 0}
                <button
                  type="button"
                  class="border-r border-edge px-2 py-0.5 last:border-r-0 {filter === f.val
                    ? 'bg-edge text-accent'
                    : 'text-muted hover:text-text'}"
                  aria-pressed={filter === f.val}
                  onclick={() => (filter = f.val)}
                >
                  {t(f.label)} <span class="text-muted">{n}</span>
                </button>
              {/if}
            {/each}
          </div>
          {#if folders.length > 1}
            <button
              type="button"
              class="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text"
              aria-expanded={foldersOpen}
              onclick={() => (foldersOpen = !foldersOpen)}
            >
              <Icon name={foldersOpen ? "chevronDown" : "chevronRight"} size={12} />
              {t("sync.foldersToggle", { n: folders.length })}
            </button>
          {/if}
          {#if folder !== null}
            <span class="flex items-center gap-1 rounded bg-edge px-1.5 py-0.5 text-text">
              <Icon name="folder" size={12} class="text-accent" />
              {folder || t("sync.rootFolder")}
              <button
                type="button"
                class="text-muted hover:text-text"
                aria-label={t("sync.clearFolder")}
                onclick={() => (folder = null)}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          {/if}
        </div>

        {#if foldersOpen && folders.length > 1}
          <!-- Where the changes are: top-level folders, biggest first; click to narrow. -->
          <div class="max-h-32 overflow-auto rounded border border-edge" data-testid="sync-folders">
            {#each folders as f (f.folder)}
              <button
                type="button"
                class="flex h-7 w-full items-center gap-2 px-2 text-left hover:bg-edge {folder === f.folder
                  ? 'bg-edge'
                  : ''}"
                onclick={() => (folder = folder === f.folder ? null : f.folder)}
              >
                <Icon name="folder" size={13} class="text-muted" />
                <span class="min-w-0 flex-1 truncate text-text">{f.folder || t("sync.rootFolder")}</span>
                {#if f.counts.upload}<span class="text-accent">↑{f.counts.upload}</span>{/if}
                {#if f.counts.download}<span class="text-accent">↓{f.counts.download}</span>{/if}
                {#if f.counts.deleteRemote + f.counts.deleteLocal}<span class="text-danger"
                    >✕{f.counts.deleteRemote + f.counts.deleteLocal}</span
                  >{/if}
                {#if f.counts.conflict}<span class="text-warn">⚠{f.counts.conflict}</span>{/if}
              </button>
            {/each}
          </div>
        {/if}

        <!-- Virtualized: only the visible window of fixed-height rows is in the DOM,
             so a plan of tens of thousands of files doesn't freeze the dialog. -->
        <div
          bind:this={listEl}
          bind:clientHeight={viewportH}
          class="relative h-56 overflow-auto rounded border border-edge"
          data-testid="sync-plan"
          onscroll={(e) => (scrollTop = (e.currentTarget as HTMLElement).scrollTop)}
        >
          {#if rows.length === 0}
            <p class="px-3 py-2 text-muted">{t("sync.filterEmpty")}</p>
          {:else}
            <div style="height: {win.totalHeight}px" class="relative">
              <div class="absolute inset-x-0" style="top: {win.padTop}px">
                {#each rows.slice(win.start, win.end) as a (a.path)}
                  {@const prog = ownsRun ? syncRunState.map[syncTransferId(a.path)] : undefined}
                  {@const status = syncRowStatus(a.op, prog, job.phase)}
                  <div
                    class="relative flex h-7 items-center gap-2 border-b border-edge/50 px-2 {status === 'pending' ||
                    status === 'notRun'
                      ? 'opacity-50'
                      : ''}"
                  >
                    <span class="w-24 shrink-0 {opClass(a.op)}">{t(OP_LABEL[a.op])}</span>
                    <span class="min-w-0 flex-1 truncate" title={a.path}>{a.path}</span>
                    {#if status === "done"}
                      <span class="shrink-0 text-ok" aria-label={t("sync.rowDone")}>
                        <Icon name="check" size={13} />
                      </span>
                    {:else if status === "running"}
                      <span class="shrink-0 text-accent">{syncRowPct(prog)}%</span>
                    {:else if job.phase !== "idle" || status === "skipped"}
                      <span class="shrink-0 text-meta text-muted">{t(ROW_STATUS_LABEL[status])}</span>
                    {/if}
                    {#if status === "running"}
                      <div class="absolute inset-x-2 bottom-0 h-0.5 rounded bg-edge">
                        <div class="h-0.5 rounded bg-accent" style="width: {syncRowPct(prog)}%"></div>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
        {#if (counts?.conflict ?? 0) > 0 && matchesFilter("conflict", filter)}
          <p class="text-meta text-warn">{t("sync.conflictNote")}</p>
        {/if}
      {/if}
    {/if}

    <!-- Actions, with the reason a disabled one can't run yet -->
    <div class="flex items-center justify-end gap-2 pt-1">
      {#if blockReason}
        <span class="mr-auto text-meta text-muted" data-testid="sync-block-reason">{t(blockReason)}</span>
      {/if}
      {#if busy}
        <button
          class="mr-auto flex items-center gap-1 rounded px-3 py-1 text-muted hover:bg-edge hover:text-text"
          use:tooltip={t("sync.backgroundHint")}
          onclick={background}
        >
          <Icon name="minus" size={13} />
          {t("sync.background")}
        </button>
      {/if}
      {#if job.applying}
        <button
          class="flex items-center gap-1 rounded border border-danger px-3 py-1 text-danger hover:bg-danger hover:text-white disabled:opacity-40"
          disabled={job.stopping}
          onclick={() => stopRun(job)}
        >
          <Icon name="close" size={13} />
          {job.stopping ? t("sync.stopping") : t("sync.stop")}
        </button>
      {:else}
        <button class="rounded px-3 py-1 text-muted hover:text-text" onclick={requestClose}>
          {t("common.cancel")}
        </button>
      {/if}
      <button
        class="flex items-center gap-1 rounded bg-edge px-3 py-1 hover:bg-accent hover:text-panel-alt disabled:opacity-40"
        disabled={!!blocked.compare || busy}
        onclick={compare}
      >
        <Icon name="sync" size={13} />
        {job.comparing
          ? t("sync.comparing")
          : job.phase === "stopped"
            ? t("sync.compareAgain")
            : t("sync.compare")}
      </button>
      <button
        class="rounded bg-green-600 px-3 py-1 font-medium text-white hover:bg-green-500 disabled:opacity-40"
        disabled={!!blocked.apply || busy}
        onclick={apply}
      >
        {job.applying ? t("sync.applying") : t("sync.apply")}
      </button>
    </div>
  </div>
</Modal>

<!-- Siblings of the dialog, not children: the card animates with a transform, and a
     `fixed` descendant of a transformed element is positioned against it. -->
{#if picking}
  <SyncRemotePicker
    {sessionId}
    start={job.remote}
    onpick={pickRemote}
    oncancel={() => (picking = false)}
  />
{/if}

<ConfirmDialog
  open={confirmStop}
  title={t(job.applying ? "sync.stopRunTitle" : "sync.stopCompareTitle")}
  confirmLabel={t("sync.stopConfirm")}
  onconfirm={confirmStopAndClose}
  oncancel={() => (confirmStop = false)}
>
  {t(job.applying ? "sync.stopRunBody" : "sync.stopCompareBody")}
</ConfirmDialog>
