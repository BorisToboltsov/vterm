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
    onclose: () => void;
  } = $props();

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

  // Reset to Overview and pick a sensible default container whenever a different
  // pod opens (multi-container pods need `-c` for logs/exec — default to the first).
  $effect(() => {
    void pod?.name;
    if (open && pod) {
      tab = "overview";
      logsText = "";
      describeText = "";
      yamlText = "";
      container = pod.containers.length > 1 ? pod.containers[0] : null;
    }
  });

  async function fetchLogs() {
    if (!pod) return;
    const res = await runQuery(logsArgs(pod.name, container), pod.namespace, 30);
    logsText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function fetchDescribe() {
    if (!pod) return;
    const res = await runQuery(describeArgs("pod", pod.name), pod.namespace, 30);
    describeText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function fetchYaml() {
    if (!pod) return;
    const res = await runQuery(getYamlArgs("pod", pod.name), pod.namespace, 30);
    yamlText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }

  // Logs tab re-polls while open (like the panel's live view); describe/yaml once.
  $effect(() => {
    if (!open || tab !== "logs" || !pod) return;
    void container; // refetch when the container selection changes
    void fetchLogs();
    const id = setInterval(() => void fetchLogs(), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(id);
  });
  $effect(() => {
    if (!open || tab !== "describe" || !pod) return;
    void fetchDescribe();
  });
  $effect(() => {
    if (!open || tab !== "yaml" || !pod) return;
    void fetchYaml();
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
