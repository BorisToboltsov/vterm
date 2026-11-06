<script lang="ts">
  // A container's details (Phase 36, point 1): Overview (the facts that used to
  // sit inline on the row), Logs (live-polled) and Inspect (raw JSON, fetched
  // once), with the lifecycle actions (start/stop/restart/remove) and "open
  // shell" in its header — one entry point for a container instead of five hover
  // icons. Presentational — the orchestrator's `run`/`runQuery` execute; arg
  // building stays pure (docker.ts).
  //
  // The content only (v1.7): `DockerDetailModal` shows it as a dialog, a wide
  // panel puts it into a `SidePane` beside the list. It owns no dialog itself —
  // it stands inside the panel's query container (`panelcontainer.guard`).
  import Icon from "../ui/Icon.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import LogTail from "../ui/LogTail.svelte";
  import type { LogTailSize } from "../ui/loglines";
  import { tooltip } from "../actions/tooltip";
  import {
    startArgs,
    stopArgs,
    restartArgs,
    removeArgs,
    logsArgs,
    inspectArgs,
    containerInfoRows,
    containerAddress,
    dockerDate,
    isRunning,
    stateSummary,
    stateTone,
    type DockerContainer,
    type DockerFacts,
    type DockerStat,
    type DockerInfoKey,
    type DockerDetailTab,
  } from "./docker";
  import type { ContainerOutput } from "../api";
  import { t, currentLocale, type MessageKey } from "../i18n";

  let {
    active = false,
    container = null,
    stat,
    facts = undefined,
    containers = [],
    busy = false,
    refreshSec = 3,
    fill = false,
    closeOnAsk = false,
    tab = $bindable("logs"),
    run,
    runQuery,
    onShell,
    onFollowLogs = undefined,
    onAsk,
    onclose,
  }: {
    /** On screen right now: fetches and re-polls only then. */
    active?: boolean;
    container?: DockerContainer | null;
    stat?: DockerStat;
    /** What `inspect` told of it (v1.33): restarts, addresses, times; absent — not asked yet. */
    facts?: DockerFacts;
    /** Every container — whose network a `container:` one shares is named from it. */
    containers?: readonly DockerContainer[];
    busy?: boolean;
    refreshSec?: number;
    /** Take the height of the place it stands in (a pane beside a list); without
     *  it the text is bounded by the window, as a dialog needs. */
    fill?: boolean;
    /** Asking the assistant closes this — set by a dialog, which covers the chat. */
    closeOnAsk?: boolean;
    /**
     * The view on screen: Logs (where details open, v1.33), Overview or Inspect. Bound by the panel (v1.17):
     * the same details are shown by a dialog in a narrow dock and by the pane
     * beside the list in a wide one — two instances — and a panel that crosses
     * the width threshold must not throw the user from Logs back to Overview.
     * Left unbound, the component keeps it itself.
     */
    tab?: DockerDetailTab;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
    runQuery: (args: string[], timeout?: number) => Promise<ContainerOutput>;
    onShell: (c: DockerContainer) => void;
    /** Follow the log live in a terminal tab, from the last `tail` lines. */
    onFollowLogs?: (c: DockerContainer, tail: number) => void;
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

  type Tab = DockerDetailTab;

  let logsText = $state("");
  let inspectText = $state("");
  // How the log is read: followed (re-asked on every poll) or held still, and how
  // many last lines are asked for. Kept across containers: picking the next row
  // in the list is reading the next log the same way.
  let following = $state(true);
  let tail = $state<LogTailSize>(200);

  const TONE: Record<string, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
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

  // Forget what was fetched whenever a different container opens (or this closes).
  // The view stays (v1.33): with details beside the list, picking the next row
  // is reading the next container's log — a jump back to Overview on every pick
  // made the list useless for that.
  $effect(() => {
    const id = active ? (container?.id ?? null) : null;
    if (id === shownId) return;
    shownId = id;
    activeId = id;
    logsText = "";
    inspectText = "";
  });

  async function fetchLogs(id: string, lines: number) {
    const res = await runQuery(logsArgs(id, lines), 30);
    logsText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function fetchInspect(id: string) {
    const res = await runQuery(inspectArgs(id), 30);
    inspectText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }

  // Logs tab: fetched on open and on a new tail size, re-polled while followed
  // (like the panel's live view); a held log stands still. Inspect once.
  $effect(() => {
    const cid = activeId;
    const lines = tail;
    if (!active || tab !== "logs" || !cid) return;
    void fetchLogs(cid, lines);
    if (!following) return;
    const timer = setInterval(() => void fetchLogs(cid, lines), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    const cid = activeId;
    if (!active || tab !== "inspect" || !cid) return;
    void fetchInspect(cid);
  });

  async function act(args: string[], opts?: { destructive?: boolean; successKey?: string }) {
    const ok = await run(args, opts);
    // A successful remove leaves nothing to show — close the modal.
    if (ok && opts?.destructive && args[1] === "rm") onclose();
  }

  const TABS: { id: Tab; label: MessageKey }[] = [
    { id: "logs", label: "docker.viewLogs" },
    { id: "overview", label: "docker.overview" },
    { id: "inspect", label: "docker.inspect" },
  ];

  const summary = $derived(container ? stateSummary(container, facts) : null);
  const address = $derived(container ? containerAddress(container, facts, containers) : null);
</script>

{#if container}
  {@const c = container}
  <!-- Header: state + image + actions -->
  <div class="mb-2 flex items-center gap-2">
    <span class="h-[0.5rem] w-[0.5rem] shrink-0 rounded-full {TONE[stateTone(c.state)]}" use:tooltip={c.state}></span>
    <div class="min-w-0 flex-1 truncate text-meta text-muted">{c.image}</div>
    <div class="flex shrink-0 items-center gap-0.5 text-muted">
      {#if isRunning(c)}
        <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.stop")} aria-label={t("docker.stop")} onclick={() => act(stopArgs([c.id]), { successKey: "docker.stopped" })}>
          <Icon name="stop" size={14} />
        </button>
      {:else}
        <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.start")} aria-label={t("docker.start")} onclick={() => act(startArgs([c.id]), { successKey: "docker.started" })}>
          <Icon name="play" size={14} />
        </button>
      {/if}
      <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.restart")} aria-label={t("docker.restart")} onclick={() => act(restartArgs([c.id]), { successKey: "docker.restarted" })}>
        <Icon name="refresh" size={13} />
      </button>
      <button class="rounded p-1 hover:bg-edge hover:text-text" use:tooltip={t("docker.openShell")} aria-label={t("docker.openShell")} onclick={() => onShell(c)}>
        <Icon name="terminal" size={14} />
      </button>
      {#if onAsk}
        <!-- "Ask AI" (Phase 41): the state and logs are already fetched here, so
             the question carries them instead of asking the user to copy-paste.
             A dialog closes (`closeOnAsk`) — the question is typed in the chat,
             which it covers; a pane beside the list covers nothing and stays. -->
        <button
          data-testid="docker-ask-ai"
          class="rounded p-1 hover:bg-edge hover:text-text"
          use:tooltip={t("ai.ask.button")}
          aria-label={t("ai.ask.button")}
          onclick={() => {
            onAsk?.(askContext(c));
            if (closeOnAsk) onclose();
          }}
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
  <div class="mb-2 flex border-b border-edge text-meta">
    {#each TABS as tb (tb.id)}
      <button
        data-testid={`docker-detail-tab-${tb.id}`}
        class="border-b-2 px-3 py-1.5 {tab === tb.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
        aria-current={tab === tb.id ? "true" : undefined}
        onclick={() => (tab = tb.id)}
      >
        {t(tb.label)}
      </button>
    {/each}
  </div>

  {#if tab === "overview"}
    <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-meta {fill ? 'min-h-0 content-start overflow-auto' : ''}" data-testid="docker-detail-overview">
      <dt class="text-muted">{t("docker.name")}</dt>
      <dd class="break-all text-text/85">{c.name}</dd>
      <dt class="text-muted">{t("docker.image")}</dt>
      <dd class="break-all text-text/85">{c.image}</dd>
      {#if c.project}
        <dt class="text-muted">{t("docker.project")}</dt>
        <dd class="break-all text-text/85">{c.project}{#if c.service}<span class="text-muted"> · {c.service}</span>{/if}</dd>
      {/if}
      {#if summary}
        <dt class="text-muted">{t("docker.state")}</dt>
        <dd class="break-all text-text/85" data-testid="docker-detail-state">
          {summary.word}{#if summary.age}<span class="text-muted">{` · ${summary.age}`}</span>{/if}{#if facts?.restarts}<span class="text-warn">{` · ↻${facts.restarts}`}</span>{/if}
        </dd>
      {/if}
      {#each rows as row (row.key)}
        <dt class="text-muted">{t(INFO_LABEL[row.key])}</dt>
        <dd class="break-all text-text/85">{row.key === "created" ? dockerDate(row.value, currentLocale()) : row.value}</dd>
      {/each}
      {#if address}
        <dt class="text-muted">{t("docker.address")}</dt>
        <dd class="text-text/85" data-testid="docker-detail-address">
          {#if address.kind === "ip"}
            {#each address.all as a (a.network)}
              <div class="break-all"><span class="font-mono">{[a.ipv4, a.ipv6].filter(Boolean).join(" · ")}</span><span class="text-muted">{` · ${a.network}`}</span></div>
            {/each}
            <div class="text-caption text-muted">{t("docker.addressInside")}</div>
          {:else if address.kind === "host"}
            {t("docker.addressHost")}
          {:else if address.kind === "none"}
            {t("docker.addressNone")}
          {:else if address.kind === "shared"}
            {t("docker.addressShared", { name: address.with })}
          {:else if address.kind === "down"}
            <span class="text-muted">{t("docker.addressDown")}</span>
          {:else}
            <span class="text-muted">—</span>
          {/if}
        </dd>
      {/if}
    </dl>
  {:else if tab === "logs"}
    <LogTail
      text={logsText}
      bind:live={following}
      bind:tail
      {fill}
      empty={t("docker.noLogs")}
      testid="docker"
      onterminal={onFollowLogs ? () => onFollowLogs?.(c, tail) : undefined}
    />
  {:else}
    <div class="mb-1 flex justify-end">
      <CopyButton text={inspectText} label={t("util.copy")} testid="docker-copy-text" />
    </div>
    <pre
      data-testid="docker-text"
      class="{fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
    >{inspectText || t("docker.noLogs")}</pre>
  {/if}
{/if}
