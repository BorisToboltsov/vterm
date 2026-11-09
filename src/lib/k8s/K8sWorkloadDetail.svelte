<script lang="ts">
  // A workload's details (ADR 0054, stage 4): Overview, Describe, YAML. What it is
  // told, has and says comes from the panel's workloads poll (`detail`, its Jobs);
  // what it owns is asked here, only while Overview is on screen — its pods and, of
  // a Deployment, its ReplicaSets, by its selector and then by owner.
  //
  // The content only: `K8sWorkloadModal` shows it as a dialog, a wide panel puts it
  // into a `SidePane` beside the list. It owns no dialog itself — it stands inside
  // the panel's query container (`panelcontainer.guard`).
  import CopyButton from "../ui/CopyButton.svelte";
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { compactAge } from "../ui/age";
  import {
    describeArgs,
    getYamlArgs,
    listItems,
    podsOf,
    workloadPods,
    workloadPodsArgs,
    replicaSetsArgs,
    parseRevisions,
    listFailure,
    podPhaseTone,
    type K8sJob,
    type K8sPod,
    type K8sRevision,
    type K8sWorkload,
    type JobStatus,
    type WorkloadDetail,
    type K8sWorkloadTab,
  } from "./k8s";
  import type { KubeOutput } from "../api";
  import { currentLocale, t, type MessageKey } from "../i18n";

  let {
    active = false,
    workload = null,
    detail = null,
    jobs = [],
    fill = false,
    refreshSec = 5,
    tab = $bindable("overview"),
    runQuery,
    onOpenPod,
    busy = false,
    onRollback,
    onRunNow,
  }: {
    /** On screen right now: asks and re-polls only then. */
    active?: boolean;
    workload?: K8sWorkload | null;
    /** What the workloads poll says of it; null — not in the answer (yet). */
    detail?: WorkloadDetail | null;
    /** A CronJob's runs, from the same poll. */
    jobs?: readonly K8sJob[];
    fill?: boolean;
    refreshSec?: number;
    /** The view on screen — the panel's, so a dialog and the pane beside the list show the same one. */
    tab?: K8sWorkloadTab;
    runQuery: (bareArgs: string[], namespace: string, timeout?: number) => Promise<KubeOutput>;
    /** Open one of its pods in the Pods view. */
    onOpenPod: (pod: K8sPod) => void;
    /** A change is under way: the buttons that make one wait. */
    busy?: boolean;
    /** Roll the Deployment back to this revision (ADR 0061) — asked about first. */
    onRollback?: (revision: K8sRevision) => void;
    /** Make a Job of the CronJob now (ADR 0061) — asked about first. */
    onRunNow?: () => void;
  } = $props();

  const SECTION = "mb-1 mt-3 flex items-center gap-1.5 text-caption uppercase tracking-wider text-muted";
  const DOT: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-muted" };
  const JOB_TONE: Record<JobStatus, string> = { Complete: "ok", Failed: "bad", Running: "warn", Suspended: "idle", Pending: "warn" };
  const TEXT_TONE: Record<string, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", idle: "text-muted" };
  const APP_SOURCE: Record<string, MessageKey> = {
    partOf: "k8s.appFromPartOf",
    helm: "k8s.appFromHelm",
    instance: "k8s.appFromInstance",
    name: "k8s.appFromName",
  };

  const ago = (ms: number): string => compactAge(ms, Date.now());
  const moment = (ms: number): string => new Date(ms).toLocaleString(currentLocale());
  function took(sec: number): string {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    return sec % 60 ? `${m}m${sec % 60}s` : `${m}m`;
  }

  // What it owns, asked while Overview is on screen: undefined — not answered yet,
  // a string — could not be read, which is not «none».
  let pods = $state<K8sPod[] | undefined>(undefined);
  let podsError = $state<string | null>(null);
  let revisions = $state<K8sRevision[] | undefined>(undefined);
  let revisionsError = $state<string | null>(null);
  let describeText = $state("");
  let yamlText = $state("");

  // Strings, so the effects below re-run on another workload, not on every poll.
  const key = $derived(workload ? `${workload.kind}/${workload.namespace}/${workload.name}` : "");
  const selector = $derived(detail?.selector ?? "");
  const uid = $derived(detail?.uid ?? "");
  const revision = $derived(detail?.revision ?? null);

  let shownKey = "";
  $effect(() => {
    if (key === shownKey) return;
    shownKey = key;
    pods = undefined;
    podsError = null;
    revisions = undefined;
    revisionsError = null;
    describeText = "";
    yamlText = "";
  });

  async function fetchOwned(k: string, w: K8sWorkload, sel: string, ownerUid: string, rev: number | null) {
    const [p, rs] = await Promise.all([
      runQuery(workloadPodsArgs(sel), w.namespace, 20),
      w.kind === "Deployment" ? runQuery(replicaSetsArgs(sel), w.namespace, 20) : null,
    ]);
    if (k !== key) return; // another workload opened meanwhile
    podsError = listFailure(p.stdout, p.stderr, p.exitCode);
    pods = podsError === null ? workloadPods(podsOf(listItems(p.stdout)), w) : undefined;
    if (rs) {
      revisionsError = listFailure(rs.stdout, rs.stderr, rs.exitCode);
      revisions = revisionsError === null ? parseRevisions(rs.stdout, ownerUid, rev) : undefined;
    }
  }

  $effect(() => {
    const k = key;
    const sel = selector;
    const owner = uid;
    const rev = revision;
    const w = workload;
    if (!active || tab !== "overview" || !w || !sel) return;
    void fetchOwned(k, w, sel, owner, rev);
    const timer = setInterval(() => void fetchOwned(k, w, sel, owner, rev), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(timer);
  });

  async function fetchText(which: "describe" | "yaml", k: string, w: K8sWorkload) {
    const kind = w.kind.toLowerCase();
    const res = await runQuery(which === "describe" ? describeArgs(kind, w.name) : getYamlArgs(kind, w.name), w.namespace, 30);
    if (k !== key) return;
    const text = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
    if (which === "describe") describeText = text;
    else yamlText = text;
  }
  $effect(() => {
    const k = key;
    const w = workload;
    if (!active || !w || tab === "overview") return;
    void fetchText(tab, k, w);
  });

  const TABS: { id: K8sWorkloadTab; label: MessageKey }[] = [
    { id: "overview", label: "k8s.overview" },
    { id: "describe", label: "k8s.describe" },
    { id: "yaml", label: "k8s.yaml" },
  ];
</script>

{#if workload}
  {@const w = workload}
  <div class="mb-2 flex border-b border-edge text-meta">
    {#each TABS as tb (tb.id)}
      <button
        data-testid={`k8s-work-tab-${tb.id}`}
        class="border-b-2 px-3 py-1.5 {tab === tb.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
        aria-current={tab === tb.id ? "true" : undefined}
        onclick={() => (tab = tb.id)}
      >
        {t(tb.label)}
      </button>
    {/each}
  </div>

  {#if tab === "overview"}
    <div class="text-meta {fill ? 'min-h-0 flex-1 overflow-auto' : 'max-h-[60vh] overflow-auto'}" data-testid="k8s-work-overview">
      <dl class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
        <dt class="text-muted">{t("k8s.kind")}</dt>
        <dd class="text-text/85">{w.kind}</dd>
        <dt class="text-muted">{t("k8s.namespace")}</dt>
        <dd class="break-all text-text/85">{w.namespace}</dd>
        {#if detail?.app}
          {@const a = detail.app}
          <!-- What application it is part of — what its labels and Helm say (stage 6). -->
          <dt class="text-muted">{t("k8s.application")}</dt>
          <dd class="break-all text-text/85" data-testid="k8s-work-app">
            {a.app.name}<span class="text-caption text-muted">{` · ${t(APP_SOURCE[a.app.source])}`}</span>
          </dd>
          {#if a.release}
            <dt class="text-muted">{t("k8s.helmRelease")}</dt>
            <dd class="break-all font-mono text-text/85">{a.release}{#if a.chart}<span class="text-muted">{` · ${a.chart}`}</span>{/if}</dd>
          {/if}
          {#if a.version || a.component}
            <dt class="text-muted">{t("k8s.appVersion")}</dt>
            <dd class="break-all font-mono text-text/85">{[a.version, a.component].filter(Boolean).join(" · ")}</dd>
          {/if}
        {/if}
        {#if detail?.replicas}
          {@const r = detail.replicas}
          <dt class="text-muted">{t("k8s.replicas")}</dt>
          <dd class="text-text/85" data-testid="k8s-work-replicas">
            {t("k8s.replicasLine", { ready: r.ready, desired: r.desired, updated: r.updated, available: r.available })}
            {#if r.unavailable > 0}<span class="text-warn">{` · ${t("k8s.replicasUnavailable", { n: r.unavailable })}`}</span>{/if}
          </dd>
        {/if}
        {#if detail?.strategy}
          <dt class="text-muted">{t("k8s.strategy")}</dt>
          <dd class="break-all font-mono text-text/85">{detail.strategy}{#if detail.paused}<span class="text-warn">{` · ${t("k8s.paused")}`}</span>{/if}</dd>
        {/if}
        {#if detail?.revision != null}
          <dt class="text-muted">{t("k8s.revision")}</dt>
          <dd class="text-text/85">{detail.revision}{#if detail.progressDeadlineSec != null}<span class="text-muted">{` · ${t("k8s.progressDeadline", { sec: detail.progressDeadlineSec })}`}</span>{/if}</dd>
        {/if}
        {#if detail?.kind === "StatefulSet"}
          {#if detail.serviceName}
            <dt class="text-muted">{t("k8s.serviceName")}</dt>
            <dd class="break-all font-mono text-text/85">{detail.serviceName}</dd>
          {/if}
          {#if detail.currentRevision}
            <dt class="text-muted">{t("k8s.stsRevisions")}</dt>
            <dd class="break-all font-mono text-text/85">
              {detail.currentRevision}{#if detail.updateRevision && detail.updateRevision !== detail.currentRevision}<span class="text-warn">{` → ${detail.updateRevision}`}</span>{/if}
            </dd>
          {/if}
          {#if detail.claims.length > 0}
            <dt class="text-muted">{t("k8s.claims")}</dt>
            <dd class="font-mono text-text/85">
              {#each detail.claims as c (c.name)}<div>{c.name} · {c.size || "—"}{#if c.storageClass}<span class="text-muted">{` · ${c.storageClass}`}</span>{/if}</div>{/each}
            </dd>
          {/if}
        {/if}
        {#if detail?.misscheduled}
          <dt class="text-muted">{t("k8s.misscheduled")}</dt>
          <dd class="text-warn">{detail.misscheduled}</dd>
        {/if}
        {#if detail?.kind === "CronJob"}
          <dt class="text-muted">{t("k8s.schedule")}</dt>
          <dd class="font-mono text-text/85">
            {detail.schedule}{#if detail.timeZone}<span class="text-muted">{` · ${detail.timeZone}`}</span>{/if}{#if detail.suspended}<span class="text-warn">{` · ${t("k8s.suspended")}`}</span>{/if}
          </dd>
          <dt class="text-muted">{t("k8s.concurrency")}</dt>
          <dd class="font-mono text-text/85">{detail.concurrency || "—"}</dd>
          <dt class="text-muted">{t("k8s.lastSchedule")}</dt>
          <dd class="text-text/85">{#if detail.lastSchedule != null}<span use:tooltip={moment(detail.lastSchedule)}>{ago(detail.lastSchedule)}</span>{:else}<span class="text-muted">{t("k8s.never")}</span>{/if}</dd>
          <dt class="text-muted">{t("k8s.lastSuccess")}</dt>
          <dd class="text-text/85" data-testid="k8s-work-last-success">{#if detail.lastSuccess != null}<span use:tooltip={moment(detail.lastSuccess)}>{ago(detail.lastSuccess)}</span>{:else}<span class="text-warn">{t("k8s.never")}</span>{/if}</dd>
          {#if detail.activeJobs > 0}
            <dt class="text-muted">{t("k8s.activeJobs")}</dt>
            <dd class="text-text/85">{detail.activeJobs}</dd>
          {/if}
          {#if detail.keep}
            <dt class="text-muted">{t("k8s.keep")}</dt>
            <dd class="text-text/85">{t("k8s.keepLine", { ok: detail.keep.succeeded ?? 3, failed: detail.keep.failed ?? 1 })}</dd>
          {/if}
        {/if}
        {#if detail?.job}
          {@const j = detail.job}
          <dt class="text-muted">{t("k8s.status")}</dt>
          <dd class={TEXT_TONE[JOB_TONE[j.status]]}>{j.status}{#if j.reason}<span class="text-muted">{` · ${j.reason}`}</span>{/if}</dd>
          <dt class="text-muted">{t("k8s.completions")}</dt>
          <dd class="text-text/85">{t("k8s.completionsLine", { done: j.succeeded, want: j.completions ?? 1 })}{#if j.failed > 0}<span class="text-bad">{` · ${t("k8s.jobFailedPods", { n: j.failed })}`}</span>{/if}</dd>
          {#if j.durationSec != null}
            <dt class="text-muted">{t("k8s.duration")}</dt>
            <dd class="text-text/85">{took(j.durationSec)}</dd>
          {/if}
        {/if}
        {#if detail?.selector}
          <dt class="text-muted">{t("k8s.selector")}</dt>
          <dd class="break-all font-mono text-text/85">{detail.selector}</dd>
        {/if}
        {#if detail && detail.images.length > 0}
          <dt class="text-muted">{t("k8s.images")}</dt>
          <dd class="break-all font-mono text-text/85">{#each detail.images as img, i (i)}<div>{img}</div>{/each}</dd>
        {/if}
      </dl>

      {#if detail && detail.conditions.length > 0}
        <!-- What it says of itself: a rollout past its deadline says so here. -->
        <section data-testid="k8s-work-conditions">
          <h4 class={SECTION}>{t("k8s.conditions")}</h4>
          <ul class="space-y-0.5">
            {#each detail.conditions as c (c.type)}
              <li class="px-1" data-testid="k8s-work-condition">
                <div class="flex items-baseline gap-2">
                  <span class="h-[0.4rem] w-[0.4rem] shrink-0 rounded-full {c.ok === true ? 'bg-ok' : c.ok === false ? 'bg-bad' : 'bg-muted'}"></span>
                  <span class="shrink-0 text-text/85">{c.type}</span>
                  {#if c.reason}<span class="min-w-0 truncate font-mono text-caption text-muted">{c.reason}</span>{/if}
                  {#if c.since != null}<span class="ml-auto shrink-0 font-mono text-caption text-muted" use:tooltip={moment(c.since)}>{ago(c.since)}</span>{/if}
                </div>
                {#if c.message}<p class="break-words pl-3.5 text-caption {c.ok === false ? 'text-text/85' : 'text-muted'}">{c.message}</p>{/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if w.kind === "Deployment" && detail?.selector}
        <!-- Its ReplicaSets are its revisions: an old one still serving while a new
             one cannot start is a rollout stuck halfway. -->
        <section data-testid="k8s-work-revisions">
          <h4 class={SECTION}>{t("k8s.revisions")} {#if revisions}<span class="tabular-nums">{revisions.length}</span>{/if}</h4>
          {#if revisionsError !== null}
            <p class="text-muted">{t("k8s.unreadWhy", { why: revisionsError || "—" })}</p>
          {:else if revisions === undefined}
            <p class="text-muted">…</p>
          {:else}
            {#each revisions as r (r.name)}
              <div class="flex flex-wrap items-baseline gap-x-2 px-1" data-testid="k8s-work-revision">
                <span class="tabular-nums text-text/90">#{r.revision}</span>
                {#if r.current}<span class="text-caption text-accent">{t("k8s.revCurrent")}</span>{/if}
                <span class="min-w-0 break-all font-mono text-caption text-text/85">{r.images.join(", ")}</span>
                <span class="tabular-nums text-caption {r.ready < r.desired ? 'text-warn' : 'text-muted'}">{r.ready}/{r.desired}</span>
                <span class="ml-auto font-mono text-caption text-muted">{r.age}</span>
                {#if !r.current && onRollback}
                  <button
                    type="button"
                    class="shrink-0 self-center rounded p-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
                    disabled={busy}
                    use:tooltip={t("k8s.rollbackTo", { revision: r.revision })}
                    aria-label={t("k8s.rollbackTo", { revision: r.revision })}
                    onclick={() => onRollback?.(r)}
                    data-testid="k8s-work-rollback"
                  >
                    <Icon name="history" size={12} />
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
        </section>
      {/if}

      {#if w.kind === "CronJob"}
        <section data-testid="k8s-work-jobs">
          <h4 class={SECTION}>
            {t("k8s.jobs")} <span class="tabular-nums">{jobs.length}</span>
            {#if onRunNow}
              <button
                type="button"
                class="ml-auto inline-flex items-center gap-1 rounded px-1 normal-case tracking-normal text-accent hover:bg-edge disabled:opacity-40"
                disabled={busy}
                onclick={() => onRunNow?.()}
                data-testid="k8s-work-run-now"
              >
                <Icon name="play" size={11} />{t("k8s.runNow")}
              </button>
            {/if}
          </h4>
          {#if jobs.length === 0}
            <p class="text-muted">{t("k8s.noJobs")}</p>
          {:else}
            {#each jobs as j (j.name)}
              <div class="px-1" data-testid="k8s-work-job">
                <div class="flex items-baseline gap-2">
                  <span class="h-[0.4rem] w-[0.4rem] shrink-0 rounded-full {DOT[JOB_TONE[j.status]]}"></span>
                  <span class="min-w-0 truncate font-mono text-text/85">{j.name}</span>
                  <span class="shrink-0 {TEXT_TONE[JOB_TONE[j.status]]}">{j.status}</span>
                  {#if j.reason && j.status !== "Complete"}<span class="shrink-0 font-mono text-caption text-muted">{j.reason}</span>{/if}
                  {#if j.durationSec != null}<span class="shrink-0 text-caption text-muted">{took(j.durationSec)}</span>{/if}
                  <span class="ml-auto shrink-0 font-mono text-caption text-muted">{j.age}</span>
                </div>
                {#if j.message && j.status === "Failed"}<p class="break-words pl-3.5 text-caption text-muted">{j.message}</p>{/if}
              </div>
            {/each}
          {/if}
        </section>
      {/if}

      {#if detail?.selector}
        <section data-testid="k8s-work-pods">
          <h4 class={SECTION}>{t("k8s.pods")} {#if pods}<span class="tabular-nums">{pods.length}</span>{/if}</h4>
          {#if podsError !== null}
            <p class="text-muted">{t("k8s.unreadWhy", { why: podsError || "—" })}</p>
          {:else if pods === undefined}
            <p class="text-muted">…</p>
          {:else if pods.length === 0}
            <p class="text-muted">{t("k8s.noPods")}</p>
          {:else}
            {#each pods as p (p.name)}
              <button
                type="button"
                class="flex w-full items-baseline gap-2 rounded px-1 text-left hover:bg-edge/40"
                use:tooltip={t("k8s.openPod")}
                onclick={() => onOpenPod(p)}
                data-testid="k8s-work-pod"
              >
                <span class="h-[0.4rem] w-[0.4rem] shrink-0 rounded-full {DOT[podPhaseTone(p.status)]}"></span>
                <span class="min-w-0 truncate font-mono text-text/85">{p.name}</span>
                <span class="shrink-0 text-caption text-muted">{p.status}</span>
                <span class="shrink-0 tabular-nums text-caption text-muted">{p.ready}</span>
                {#if p.restarts > 0}<span class="shrink-0 tabular-nums text-caption text-warn">↻{p.restarts}</span>{/if}
                {#if p.node}<span class="min-w-0 truncate text-caption text-muted">{p.node}</span>{/if}
                <span class="ml-auto shrink-0 font-mono text-caption text-muted">{p.age}</span>
              </button>
            {/each}
          {/if}
        </section>
      {/if}
    </div>
  {:else}
    {@const text = tab === "describe" ? describeText : yamlText}
    <div class="mb-1 flex justify-end">
      <CopyButton {text} label={t("util.copy")} testid="k8s-work-copy" />
    </div>
    <pre
      data-testid="k8s-work-text"
      class="{fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
    >{text || t("k8s.noLogs")}</pre>
  {/if}
{/if}
