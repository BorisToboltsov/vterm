<script lang="ts">
  // A node's details (ADR 0054, stage 5): Overview, Describe, YAML. What it has,
  // can give and says comes from the panel's Cluster poll (`detail`); what its pods
  // ask for and what it uses now are asked here, only while Overview is on screen —
  // its pods across namespaces, `top node`.
  //
  // The content only: `K8sNodeModal` shows it as a dialog, a wide panel puts it
  // into a `SidePane` beside the list (`panelcontainer.guard`).
  import Icon from "../ui/Icon.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import { tooltip } from "../actions/tooltip";
  import { compactAge } from "../ui/age";
  import {
    describeArgs,
    getYamlArgs,
    listItems,
    podsOf,
    nodePodsArgs,
    nodeAllocated,
    topNodeArgs,
    parseTopNode,
    metricsGap,
    listFailure,
    limitTone,
    podPhaseTone,
    type K8sNode,
    type K8sPod,
    type K8sWorkloadTab,
    type MetricsGap,
    type NodeAllocated,
    type NodeDetail,
  } from "./k8s";
  import type { KubeOutput } from "../api";
  import { currentLocale, t, type MessageKey } from "../i18n";

  let {
    active = false,
    node = null,
    detail = null,
    fill = false,
    refreshSec = 5,
    tab = $bindable("overview"),
    runQuery,
  }: {
    /** On screen right now: asks and re-polls only then. */
    active?: boolean;
    node?: K8sNode | null;
    /** What the Cluster poll says of it; null — not in the answer (yet). */
    detail?: NodeDetail | null;
    fill?: boolean;
    refreshSec?: number;
    /** The view on screen — the panel's, so a dialog and the pane beside the list show the same one. */
    tab?: K8sWorkloadTab;
    runQuery: (bareArgs: string[], namespace: string, timeout?: number) => Promise<KubeOutput>;
  } = $props();

  const SECTION = "mb-1 mt-3 flex items-center gap-1.5 text-caption uppercase tracking-wider text-muted";
  const DOT: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-muted" };
  const BAR: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" };

  const ago = (ms: number): string => compactAge(ms, Date.now());
  const moment = (ms: number): string => new Date(ms).toLocaleString(currentLocale());
  const fmtCpu = (v: number | null): string => (v == null ? "—" : v >= 1000 && v % 1000 === 0 ? `${v / 1000}` : `${Math.round(v)}m`);
  function fmtMi(v: number | null): string {
    if (v == null) return "—";
    if (v >= 1024) return `${(v / 1024).toFixed(1)}Gi`;
    return `${Math.round(v)}Mi`;
  }

  // What its pods ask for and what it uses now — undefined: not answered yet.
  let pods = $state<K8sPod[] | undefined>(undefined);
  let allocated = $state<NodeAllocated | undefined>(undefined);
  let podsError = $state<string | null>(null);
  let usage = $state<ReturnType<typeof parseTopNode> | undefined>(undefined);
  let usageGap = $state.raw<MetricsGap | null>(null);
  let describeText = $state("");
  let yamlText = $state("");

  const name = $derived(node?.name ?? "");
  let shown = "";
  $effect(() => {
    if (name === shown) return;
    shown = name;
    pods = undefined;
    allocated = undefined;
    podsError = null;
    usage = undefined;
    usageGap = null;
    describeText = "";
    yamlText = "";
  });

  async function fetchOwned(n: string) {
    const [p, top] = await Promise.all([runQuery(nodePodsArgs(n), "", 20), runQuery(topNodeArgs(n), "", 20)]);
    if (n !== name) return; // another node opened meanwhile
    podsError = listFailure(p.stdout, p.stderr, p.exitCode);
    if (podsError === null) {
      const list = listItems(p.stdout);
      pods = podsOf(list);
      allocated = nodeAllocated(list);
    }
    usageGap = metricsGap(top);
    usage = parseTopNode(top.stdout, n);
  }

  $effect(() => {
    const n = name;
    if (!active || tab !== "overview" || !n) return;
    void fetchOwned(n);
    const timer = setInterval(() => void fetchOwned(n), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(timer);
  });

  async function fetchText(which: "describe" | "yaml", n: string) {
    const res = await runQuery(which === "describe" ? describeArgs("node", n) : getYamlArgs("node", n), "", 30);
    if (n !== name) return;
    const text = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
    if (which === "describe") describeText = text;
    else yamlText = text;
  }
  $effect(() => {
    const n = name;
    if (!active || !n || tab === "overview") return;
    void fetchText(tab, n);
  });

  let labelsOpen = $state(false);

  const TABS: { id: K8sWorkloadTab; label: MessageKey }[] = [
    { id: "overview", label: "k8s.overview" },
    { id: "describe", label: "k8s.describe" },
    { id: "yaml", label: "k8s.yaml" },
  ];

  /** One resource's row: what it can give, what its pods ask for and are held to, what it uses now. */
  type Row = { label: string; give: number | null; asked: number | null; held: number | null; now: number | null; f: (v: number | null) => string };
  const rows = $derived.by((): Row[] => {
    if (!detail) return [];
    const a = detail.allocatable;
    return [
      { label: t("k8s.cpu"), give: a.cpu, asked: allocated?.requests.cpu ?? null, held: allocated?.limits.cpu ?? null, now: usage?.cpu ?? null, f: fmtCpu },
      { label: t("k8s.mem"), give: a.memory, asked: allocated?.requests.memory ?? null, held: allocated?.limits.memory ?? null, now: usage?.mem ?? null, f: fmtMi },
      { label: t("k8s.pods"), give: a.pods, asked: allocated?.pods ?? null, held: null, now: null, f: (v) => (v == null ? "—" : String(v)) },
    ];
  });
  const share = (v: number | null, of: number | null) => (v == null || of == null || of <= 0 ? null : v / of);
</script>

{#if node}
  {@const n = node}
  <div class="mb-2 flex border-b border-edge text-meta">
    {#each TABS as tb (tb.id)}
      <button
        data-testid={`k8s-node-tab-${tb.id}`}
        class="border-b-2 px-3 py-1.5 {tab === tb.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
        aria-current={tab === tb.id ? "true" : undefined}
        onclick={() => (tab = tb.id)}
      >
        {t(tb.label)}
      </button>
    {/each}
  </div>

  {#if tab === "overview"}
    <div class="text-meta {fill ? 'min-h-0 flex-1 overflow-auto' : 'max-h-[60vh] overflow-auto'}" data-testid="k8s-node-overview">
      <dl class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
        <dt class="text-muted">{t("k8s.status")}</dt>
        <dd class="text-text/85">{n.status}</dd>
        <dt class="text-muted">{t("k8s.roles")}</dt>
        <dd class="text-text/85">{n.roles}</dd>
        {#if detail}
          {#each detail.addresses as a (a.type)}
            <dt class="text-muted">{a.type}</dt>
            <dd class="break-all font-mono text-text/85">{a.address}</dd>
          {/each}
          <dt class="text-muted">{t("k8s.system")}</dt>
          <dd class="break-all text-text/85">
            {[detail.info.os, detail.info.kernel, detail.info.arch].filter(Boolean).join(" · ")}
            <div class="font-mono text-caption text-muted">{[detail.info.kubelet, detail.info.runtime].filter(Boolean).join(" · ")}</div>
          </dd>
        {/if}
        <dt class="text-muted">{t("k8s.age")}</dt>
        <dd class="text-text/85">{n.age}</dd>
      </dl>

      {#if detail && detail.conditions.length > 0}
        <!-- A pressure is news when it is True: the kubelet starts evicting pods. -->
        <section data-testid="k8s-node-conditions">
          <h4 class={SECTION}>{t("k8s.conditions")}</h4>
          <ul class="space-y-0.5">
            {#each detail.conditions as c (c.type)}
              <li class="px-1" data-testid="k8s-node-condition">
                <div class="flex items-baseline gap-2">
                  <span class="h-[0.4rem] w-[0.4rem] shrink-0 rounded-full {c.healthy === true ? 'bg-ok' : c.healthy === false ? 'bg-bad' : 'bg-muted'}"></span>
                  <span class="shrink-0 text-text/85">{c.type}</span>
                  {#if c.reason}<span class="min-w-0 truncate font-mono text-caption text-muted">{c.reason}</span>{/if}
                  {#if c.since != null}<span class="ml-auto shrink-0 font-mono text-caption text-muted" use:tooltip={moment(c.since)}>{ago(c.since)}</span>{/if}
                </div>
                {#if c.message && c.healthy === false}<p class="break-words pl-3.5 text-caption text-text/85">{c.message}</p>{/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if detail}
        <!-- What its pods ask for is what the scheduler counts: a node «full» by
             requests takes no more pods, whatever it uses now. Limits over 100 % are
             an overcommit — fine until they are all taken at once. -->
        <section data-testid="k8s-node-resources">
          <h4 class={SECTION}>{t("k8s.nodeResources")}</h4>
          <div class="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1">
            {#each rows as r (r.label)}
              <span class="text-muted">{r.label}</span>
              <div class="min-w-0">
                <div class="flex flex-wrap items-baseline gap-x-2">
                  <span class="text-caption text-muted">{t("k8s.allocatable", { v: r.f(r.give) })}</span>
                </div>
                {#each [{ key: "k8s.nodeRequested", v: r.asked }, { key: "k8s.nodeLimited", v: r.held }, { key: "k8s.nodeUsing", v: r.now }] as part (part.key)}
                  {#if part.v != null}
                    {@const ratio = share(part.v, r.give)}
                    <div class="flex flex-wrap items-center gap-x-2" data-testid="k8s-node-resource">
                      <span class="w-20 shrink-0 text-caption text-muted">{t(part.key as MessageKey)}</span>
                      <span class="tabular-nums text-text/90">{r.f(part.v)}</span>
                      {#if ratio != null}
                        <span class="h-1 w-16 overflow-hidden rounded-full bg-edge"><span class="block h-full {BAR[limitTone(ratio) ?? 'ok']}" style:width="{Math.min(100, ratio * 100)}%"></span></span>
                        <span class="tabular-nums text-caption {ratio > 1 ? 'text-warn' : 'text-muted'}">{Math.round(ratio * 100)}%</span>
                      {/if}
                    </div>
                  {/if}
                {/each}
              </div>
            {/each}
          </div>
          {#if allocated && allocated.unbounded > 0}
            <p class="mt-0.5 text-caption text-muted">{t("k8s.nodeUnbounded", { n: allocated.unbounded })}</p>
          {/if}
          {#if usageGap}
            <p class="mt-0.5 text-caption text-muted" data-testid="k8s-node-usage-gap">
              {usageGap.kind === "noServer" ? t("k8s.nodeNoServer") : usageGap.kind === "notYet" ? t("k8s.resNotYet") : t("k8s.resUnread", { why: usageGap.text })}
            </p>
          {/if}
        </section>

        {#if detail.taints.length > 0 || detail.unschedulable}
          <section data-testid="k8s-node-taints">
            <h4 class={SECTION}>{t("k8s.taints")}</h4>
            {#if detail.unschedulable}<p class="text-warn">{t("k8s.nodeCordoned")}</p>{/if}
            {#each detail.taints as tn (tn)}<div class="break-all font-mono text-text/85">{tn}</div>{/each}
          </section>
        {/if}
      {/if}

      <section data-testid="k8s-node-pods">
        <h4 class={SECTION}>{t("k8s.pods")} {#if pods}<span class="tabular-nums">{pods.length}</span>{/if}</h4>
        {#if podsError !== null}
          <p class="text-muted">{t("k8s.unreadWhy", { why: podsError || "—" })}</p>
        {:else if pods === undefined}
          <p class="text-muted">…</p>
        {:else if pods.length === 0}
          <p class="text-muted">{t("k8s.noPods")}</p>
        {:else}
          <ul class="max-h-64 overflow-auto">
            {#each pods as p (`${p.namespace}/${p.name}`)}
              <li class="flex items-baseline gap-2 px-1" data-testid="k8s-node-pod">
                <span class="h-[0.4rem] w-[0.4rem] shrink-0 rounded-full {DOT[podPhaseTone(p.status)]}"></span>
                <span class="min-w-0 truncate font-mono text-text/85">{p.name}</span>
                <span class="shrink-0 text-caption text-muted">{p.namespace}</span>
                <span class="shrink-0 text-caption text-muted">{p.status}</span>
                {#if p.restarts > 0}<span class="shrink-0 tabular-nums text-caption text-warn">↻{p.restarts}</span>{/if}
                <span class="ml-auto shrink-0 font-mono text-caption text-muted">{p.age}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if detail && detail.labels.length > 0}
        <section data-testid="k8s-node-labels">
          <button type="button" class="{SECTION} w-full hover:text-text" aria-expanded={labelsOpen} onclick={() => (labelsOpen = !labelsOpen)}>
            <Icon name={labelsOpen ? "chevronDown" : "chevronRight"} size={10} />
            {t("k8s.labels")} <span class="tabular-nums">{detail.labels.length}</span>
          </button>
          {#if labelsOpen}
            <dl class="grid grid-cols-[minmax(0,auto)_1fr] gap-x-2 gap-y-0.5 font-mono">
              {#each detail.labels as l (l.key)}
                <dt class="truncate text-muted" use:tooltip={l.key}>{l.key}</dt>
                <dd class="break-all text-text/85">{l.value}</dd>
              {/each}
            </dl>
          {/if}
        </section>
      {/if}
    </div>
  {:else}
    {@const text = tab === "describe" ? describeText : yamlText}
    <div class="mb-1 flex justify-end">
      <CopyButton {text} label={t("util.copy")} testid="k8s-node-copy" />
    </div>
    <pre
      data-testid="k8s-node-text"
      class="{fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
    >{text || t("k8s.noLogs")}</pre>
  {/if}
{/if}
