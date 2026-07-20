<script lang="ts">
  // Container detail modal (Phase 36, point 1). A wide, tabbed view that replaces
  // the per-row icon strip: Overview (the facts that used to sit inline on the
  // row), Logs (live-polled), and Inspect (raw JSON, fetched once). Lifecycle
  // actions (start/stop/restart/remove) and "open shell" live in the header, so a
  // container has one entry point instead of five hover icons. Presentational —
  // the orchestrator's `run`/`runQuery` execute; arg building stays pure (docker.ts).
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    startArgs,
    stopArgs,
    restartArgs,
    removeArgs,
    logsArgs,
    inspectArgs,
    containerInfoRows,
    isRunning,
    stateTone,
    type DockerContainer,
    type DockerStat,
    type DockerInfoKey,
  } from "./docker";
  import type { ContainerOutput } from "./api";
  import { t, type MessageKey } from "./i18n";

  let {
    open = false,
    container = null,
    stat,
    busy = false,
    refreshSec = 3,
    run,
    runQuery,
    onShell,
    onAsk,
    onclose,
  }: {
    open?: boolean;
    container?: DockerContainer | null;
    stat?: DockerStat;
    busy?: boolean;
    refreshSec?: number;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
    runQuery: (args: string[], timeout?: number) => Promise<ContainerOutput>;
    onShell: (c: DockerContainer) => void;
    /** Hand this container's state + logs to the assistant (Phase 41). */
    onAsk?: (context: string) => void;
    onclose: () => void;
  } = $props();

  /**
   * What the assistant is told about this container: the facts already on screen
   * plus whatever logs have been fetched. Deliberately not `inspect` — it is large
   * and mostly noise, and the logs are what explain a crash loop.
   */
  function askContext(c: DockerContainer): string {
    const facts = [
      `Container: ${c.name}`,
      `Image: ${c.image}`,
      `State: ${c.state}`,
      `Status: ${c.status}`,
      c.ports ? `Ports: ${c.ports}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return logsText.trim() ? `${facts}\n\n--- docker logs ---\n${logsText}` : facts;
  }

  type Tab = "overview" | "logs" | "inspect";
  let tab = $state<Tab>("overview");

  let logsText = $state("");
  let inspectText = $state("");

  const TONE: Record<string, string> = {
    ok: "bg-green-400",
    warn: "bg-amber-400",
    bad: "bg-red-500",
    idle: "bg-muted",
  };
  const INFO_LABEL: Record<DockerInfoKey, MessageKey> = {
    status: "docker.status",
    ports: "docker.ports",
    cpu: "docker.cpu",
    mem: "docker.mem",
    net: "docker.net",
    created: "docker.created",
  };

  const rows = $derived(container ? containerInfoRows(container, stat) : []);

  // The panel hands us a *fresh* container object on every poll (a new snapshot
  // every `refreshSec`), so the container prop changes identity constantly while
  // describing the same container. Effects must therefore key off the id, and
  // compare it themselves: an effect that merely reads the prop re-runs on every
  // poll, which snapped the user back to Overview a second after they picked
  // Logs and wiped the fetched text. `shownId` is deliberately *not* reactive —
  // it is the guard, not state. `activeId` is what the tab effects below depend
  // on, so they see only real container changes.
  let shownId: string | null = null;
  let activeId = $state<string | null>(null);

  // Reset to Overview whenever a different container opens (or the modal closes).
  $effect(() => {
    const id = open ? (container?.id ?? null) : null;
    if (id === shownId) return;
    shownId = id;
    activeId = id;
    tab = "overview";
    logsText = "";
    inspectText = "";
  });

  async function fetchLogs(id: string) {
    const res = await runQuery(logsArgs(id), 30);
    logsText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function fetchInspect(id: string) {
    const res = await runQuery(inspectArgs(id), 30);
    inspectText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }

  // Logs tab re-polls while open (like the panel's live view); inspect once.
  $effect(() => {
    const cid = activeId;
    if (!open || tab !== "logs" || !cid) return;
    void fetchLogs(cid);
    const timer = setInterval(() => void fetchLogs(cid), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    const cid = activeId;
    if (!open || tab !== "inspect" || !cid) return;
    void fetchInspect(cid);
  });

  async function act(args: string[], opts?: { destructive?: boolean; successKey?: string }) {
    const ok = await run(args, opts);
    // A successful remove leaves nothing to show — close the modal.
    if (ok && opts?.destructive && args[1] === "rm") onclose();
  }

  const TABS: { id: Tab; label: MessageKey }[] = [
    { id: "overview", label: "docker.overview" },
    { id: "logs", label: "docker.viewLogs" },
    { id: "inspect", label: "docker.inspect" },
  ];
</script>

<Modal {open} title={container?.name ?? ""} width="w-[52rem]" showClose {onclose}>
  {#if container}
    {@const c = container}
    <!-- Header: state + image + actions -->
    <div class="mb-2 flex items-center gap-2">
      <span class="h-[8px] w-[8px] shrink-0 rounded-full {TONE[stateTone(c.state)]}" use:tooltip={c.state}></span>
      <div class="min-w-0 flex-1 truncate text-[11px] text-muted">{c.image}</div>
      <div class="flex shrink-0 items-center gap-0.5 text-muted">
        {#if isRunning(c)}
          <button class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("docker.stop")} aria-label={t("docker.stop")} onclick={() => act(stopArgs([c.id]), { successKey: "docker.stopped" })}>
            <Icon name="stop" size={14} />
          </button>
        {:else}
          <button class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("docker.start")} aria-label={t("docker.start")} onclick={() => act(startArgs([c.id]), { successKey: "docker.started" })}>
            <Icon name="play" size={14} />
          </button>
        {/if}
        <button class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("docker.restart")} aria-label={t("docker.restart")} onclick={() => act(restartArgs([c.id]), { successKey: "docker.restarted" })}>
          <Icon name="refresh" size={13} />
        </button>
        <button class="rounded p-1 hover:bg-edge hover:text-white" use:tooltip={t("docker.openShell")} aria-label={t("docker.openShell")} onclick={() => onShell(c)}>
          <Icon name="terminal" size={14} />
        </button>
        {#if onAsk}
          <!-- "Ask AI" (Phase 41): the state and logs are already fetched here, so
               the question carries them instead of asking the user to copy-paste. -->
          <button
            data-testid="docker-ask-ai"
            class="rounded p-1 hover:bg-edge hover:text-white"
            use:tooltip={t("ai.ask.button")}
            aria-label={t("ai.ask.button")}
            onclick={() => onAsk?.(askContext(c))}
          >
            <Icon name="aiMark" size={14} />
          </button>
        {/if}
        <button class="rounded p-1 text-danger hover:bg-edge disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={() => act(removeArgs([c.id], isRunning(c)), { destructive: true, successKey: "docker.removed" })}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="mb-2 flex border-b border-edge text-[11px]">
      {#each TABS as tb (tb.id)}
        <button
          data-testid={`docker-detail-tab-${tb.id}`}
          class="border-b-2 px-3 py-1.5 {tab === tb.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-white'}"
          aria-current={tab === tb.id ? "true" : undefined}
          onclick={() => (tab = tb.id)}
        >
          {t(tb.label)}
        </button>
      {/each}
    </div>

    {#if tab === "overview"}
      <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-[11px]" data-testid="docker-detail-overview">
        <dt class="text-muted">{t("docker.name")}</dt>
        <dd class="break-all text-white/85">{c.name}</dd>
        <dt class="text-muted">{t("docker.image")}</dt>
        <dd class="break-all text-white/85">{c.image}</dd>
        {#if c.project}
          <dt class="text-muted">{t("docker.project")}</dt>
          <dd class="break-all text-white/85">{c.project}{#if c.service}<span class="text-muted"> · {c.service}</span>{/if}</dd>
        {/if}
        {#each rows as row (row.key)}
          <dt class="text-muted">{t(INFO_LABEL[row.key])}</dt>
          <dd class="break-all text-white/85">{row.value}</dd>
        {/each}
      </dl>
    {:else if tab === "logs"}
      <div class="mb-1 flex justify-end">
        <CopyButton text={logsText} label={t("util.copy")} testid="docker-copy-text" />
      </div>
      <pre
        data-testid="docker-text"
        class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-[11px] leading-relaxed text-white/85 select-text"
      >{logsText || t("docker.noLogs")}</pre>
    {:else}
      <div class="mb-1 flex justify-end">
        <CopyButton text={inspectText} label={t("util.copy")} testid="docker-copy-text" />
      </div>
      <pre
        data-testid="docker-text"
        class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-[11px] leading-relaxed text-white/85 select-text"
      >{inspectText || t("docker.noLogs")}</pre>
    {/if}
  {/if}
</Modal>
