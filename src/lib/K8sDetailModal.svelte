<script lang="ts">
  // Pod detail modal (Phase 37). A wide, tabbed view: Overview (identity + status
  // + live metrics), Logs (live-polled, with a container picker for multi-container
  // pods), Describe and YAML (read-only, fetched once). Header carries the two
  // pod-level actions — open shell, delete. Presentational — the orchestrator's
  // `run`/`runQuery` execute; arg building stays pure (k8s.ts). Mirrors
  // DockerDetailModal.
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    logsArgs,
    describeArgs,
    getYamlArgs,
    deleteArgs,
    podPhaseTone,
    type K8sPod,
    type K8sPodMetrics,
  } from "./k8s";
  import type { KubeOutput } from "./api";
  import { t, type MessageKey } from "./i18n";

  let {
    open = false,
    pod = null,
    metrics,
    busy = false,
    refreshSec = 5,
    run,
    runQuery,
    openShell,
    onAsk,
    onclose,
  }: {
    open?: boolean;
    pod?: K8sPod | null;
    metrics?: K8sPodMetrics;
    busy?: boolean;
    refreshSec?: number;
    run: (
      bareArgs: string[],
      namespace: string,
      opts?: { successKey?: string },
    ) => Promise<boolean>;
    runQuery: (bareArgs: string[], namespace: string, timeout?: number) => Promise<KubeOutput>;
    openShell: (pod: K8sPod, container: string | null) => void;
    /** Hand this pod's state + logs to the assistant (Phase 41). */
    onAsk?: (context: string) => void;
    onclose: () => void;
  } = $props();

  /**
   * What the assistant is told about this pod: the facts on screen plus whatever
   * logs are loaded. `describe` is skipped — it is long, and the interesting part
   * of it (recent events) is usually echoed by the status and the logs.
   */
  function askContext(p: K8sPod): string {
    const facts = [
      `Pod: ${p.name}`,
      `Namespace: ${p.namespace}`,
      `Status: ${p.status}`,
      `Ready: ${p.ready}`,
      `Restarts: ${p.restarts}`,
      p.node ? `Node: ${p.node}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return logsText.trim() ? `${facts}\n\n--- kubectl logs ---\n${logsText}` : facts;
  }

  type Tab = "overview" | "logs" | "describe" | "yaml";
  let tab = $state<Tab>("overview");
  let container = $state<string | null>(null);

  let logsText = $state("");
  let describeText = $state("");
  let yamlText = $state("");

  const TONE: Record<string, string> = {
    ok: "bg-green-400",
    warn: "bg-amber-400",
    bad: "bg-red-500",
    idle: "bg-muted",
  };

  // The panel hands us a *fresh* pod object on every poll, so the prop changes
  // identity while describing the same pod. An effect that merely reads it re-runs
  // on every poll and yanks the user off Logs back to Overview, so identity is
  // compared here explicitly. `shownKey` is the guard (deliberately non-reactive);
  // `target` is what the tab effects below depend on, so they see only real changes.
  // Mirrors DockerDetailModal.
  let shownKey: string | null = null;
  let target = $state<{ name: string; namespace: string } | null>(null);

  // Reset to Overview and pick a sensible default container whenever a different
  // pod opens (multi-container pods need `-c` for logs/exec — default to the first).
  $effect(() => {
    const p = open ? pod : null;
    const key = p ? `${p.namespace}/${p.name}` : null;
    if (key === shownKey) return;
    shownKey = key;
    target = p ? { name: p.name, namespace: p.namespace } : null;
    tab = "overview";
    logsText = "";
    describeText = "";
    yamlText = "";
    container = p && p.containers.length > 1 ? p.containers[0] : null;
  });

  async function fetchLogs(name: string, ns: string, c: string | null) {
    const res = await runQuery(logsArgs(name, c), ns, 30);
    logsText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function fetchDescribe(name: string, ns: string) {
    const res = await runQuery(describeArgs("pod", name), ns, 30);
    describeText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function fetchYaml(name: string, ns: string) {
    const res = await runQuery(getYamlArgs("pod", name), ns, 30);
    yamlText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }

  // Logs tab re-polls while open (like the panel's live view); describe/yaml once.
  $effect(() => {
    const p = target;
    const c = container; // refetch when the container selection changes
    if (!open || tab !== "logs" || !p) return;
    void fetchLogs(p.name, p.namespace, c);
    const id = setInterval(() => void fetchLogs(p.name, p.namespace, c), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(id);
  });
  $effect(() => {
    const p = target;
    if (!open || tab !== "describe" || !p) return;
    void fetchDescribe(p.name, p.namespace);
  });
  $effect(() => {
    const p = target;
    if (!open || tab !== "yaml" || !p) return;
    void fetchYaml(p.name, p.namespace);
  });

  async function remove() {
    if (!pod) return;
    const ok = await run(deleteArgs("pod", pod.name), pod.namespace, { successKey: "k8s.deleted" });
    if (ok) onclose();
  }

  const TABS: { id: Tab; label: MessageKey }[] = [
    { id: "overview", label: "k8s.overview" },
    { id: "logs", label: "k8s.viewLogs" },
    { id: "describe", label: "k8s.describe" },
    { id: "yaml", label: "k8s.yaml" },
  ];
</script>

<Modal {open} title={pod?.name ?? ""} width="w-[52rem]" showClose {onclose}>
  {#if pod}
    {@const p = pod}
    <!-- Header: status + namespace + actions -->
    <div class="mb-2 flex items-center gap-2">
      <span class="h-[8px] w-[8px] shrink-0 rounded-full {TONE[podPhaseTone(p.status)]}" use:tooltip={p.status}></span>
      <div class="min-w-0 flex-1 truncate text-[11px] text-muted">{p.namespace} · {p.status}</div>
      <div class="flex shrink-0 items-center gap-0.5 text-muted">
        {#if onAsk}
          <!-- "Ask AI" (Phase 41): state, events and logs are already loaded here. -->
          <button
            data-testid="k8s-ask-ai"
            class="rounded p-1 hover:bg-edge hover:text-white"
            use:tooltip={t("ai.ask.button")}
            aria-label={t("ai.ask.button")}
            onclick={() => onAsk?.(askContext(p))}
          >
            <Icon name="aiMark" size={14} />
          </button>
        {/if}
        <button class="rounded p-1 hover:bg-edge hover:text-white" use:tooltip={t("k8s.openShell")} aria-label={t("k8s.openShell")} onclick={() => openShell(p, container)}>
          <Icon name="terminal" size={14} />
        </button>
        <button class="rounded p-1 text-danger hover:bg-edge disabled:opacity-40" disabled={busy} use:tooltip={t("k8s.delete")} aria-label={t("k8s.delete")} onclick={remove}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="mb-2 flex border-b border-edge text-[11px]">
      {#each TABS as tb (tb.id)}
        <button
          data-testid={`k8s-detail-tab-${tb.id}`}
          class="border-b-2 px-3 py-1.5 {tab === tb.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-white'}"
          aria-current={tab === tb.id ? "true" : undefined}
          onclick={() => (tab = tb.id)}
        >
          {t(tb.label)}
        </button>
      {/each}
    </div>

    {#if tab === "overview"}
      <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-[11px]" data-testid="k8s-detail-overview">
        <dt class="text-muted">{t("k8s.name")}</dt>
        <dd class="break-all text-white/85">{p.name}</dd>
        <dt class="text-muted">{t("k8s.namespace")}</dt>
        <dd class="break-all text-white/85">{p.namespace}</dd>
        <dt class="text-muted">{t("k8s.status")}</dt>
        <dd class="break-all text-white/85">{p.status}</dd>
        <dt class="text-muted">{t("k8s.ready")}</dt>
        <dd class="text-white/85">{p.ready}</dd>
        <dt class="text-muted">{t("k8s.restarts")}</dt>
        <dd class="text-white/85">{p.restarts}</dd>
        {#if p.node}
          <dt class="text-muted">{t("k8s.node")}</dt>
          <dd class="break-all text-white/85">{p.node}</dd>
        {/if}
        <dt class="text-muted">{t("k8s.age")}</dt>
        <dd class="text-white/85">{p.age}</dd>
        {#if metrics}
          <dt class="text-muted">{t("k8s.cpu")}</dt>
          <dd class="text-white/85">{metrics.cpu}</dd>
          <dt class="text-muted">{t("k8s.mem")}</dt>
          <dd class="text-white/85">{metrics.mem}</dd>
        {/if}
      </dl>
    {:else if tab === "logs"}
      <div class="mb-1 flex items-center justify-between gap-2">
        {#if p.containers.length > 1}
          <label class="flex items-center gap-1 text-[11px] text-muted">
            {t("k8s.container")}
            <select
              class="rounded border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-white outline-none focus:border-accent"
              bind:value={container}
            >
              {#each p.containers as c (c)}
                <option value={c}>{c}</option>
              {/each}
            </select>
          </label>
        {:else}
          <span></span>
        {/if}
        <CopyButton text={logsText} label={t("util.copy")} testid="k8s-copy-text" />
      </div>
      <pre
        data-testid="k8s-text"
        class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-[11px] leading-relaxed text-white/85 select-text"
      >{logsText || t("k8s.noLogs")}</pre>
    {:else if tab === "describe"}
      <div class="mb-1 flex justify-end">
        <CopyButton text={describeText} label={t("util.copy")} testid="k8s-copy-text" />
      </div>
      <pre
        data-testid="k8s-text"
        class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-[11px] leading-relaxed text-white/85 select-text"
      >{describeText || t("k8s.noLogs")}</pre>
    {:else}
      <div class="mb-1 flex justify-end">
        <CopyButton text={yamlText} label={t("util.copy")} testid="k8s-copy-text" />
      </div>
      <pre
        data-testid="k8s-text"
        class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-[11px] leading-relaxed text-white/85 select-text"
      >{yamlText || t("k8s.noLogs")}</pre>
    {/if}
  {/if}
</Modal>
