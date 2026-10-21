<script lang="ts">
  // Utilities → access check, the servers a run checks from (v1.21, ADR 0032):
  // a chip per server — whether its session is up, how many connects it makes,
  // "Connect" for one that isn't — and, for the chip picked, who it is and how
  // it probes. The probe-method tiles are per server (v1.0.37): a tool that
  // isn't usable is struck through but still pickable — picking it says why and
  // offers the install.
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";
  import { effectiveMethod, PROBE_TOOLS, visibleAddrs, type MethodChoice, type NetReport, type ProbeTool } from "./netcheck";
  import type { NetHost } from "./netroute";
  import { methodLabel } from "./netcheckwords";
  import { methodFor, setMethod } from "./stores/netcheck.svelte";
  import { segmentStep } from "./segmented";

  let {
    hosts,
    selected = $bindable(""),
    identities,
    checksOf,
    hostName,
    onConnect,
    onInstallTool,
  }: {
    /** The servers on screen: the home tab's first, then those the rules name. */
    hosts: NetHost[];
    /** The key of the chip whose details and tiles are shown. */
    selected?: string;
    /** What each session's host reported, by session id. */
    identities: Record<string, NetReport>;
    checksOf: (key: string) => number;
    hostName: (key: string) => string;
    onConnect?: (serverId: string) => void;
    onInstallTool?: (tool: string, sessionId?: string) => void;
  } = $props();

  const current = $derived(hosts.find((h) => h.key === selected) ?? hosts[0] ?? null);
  const facts = $derived(current?.sessionId ? (identities[current.sessionId] ?? null) : null);
  const isLocal = $derived(current?.kind === "local");
  const tools = $derived(facts?.tools ?? {});
  const choice = $derived<MethodChoice>(!current || isLocal ? "auto" : methodFor(current.key));
  const effective = $derived(isLocal ? null : effectiveMethod(choice, tools));
  // "auto" with nothing usable → the banner; a picked tool that isn't usable →
  // the note under the tiles (and no run: it would silently do nothing).
  const noMethod = $derived(choice === "auto" && facts?.method === "none");
  const pickedUnusable = $derived(choice !== "auto" && effective === "none");
  const shownMethod = $derived(isLocal ? (facts?.method ?? null) : (effective ?? facts?.method ?? null));
  const TILES: MethodChoice[] = ["auto", ...PROBE_TOOLS];
  let tileEls: HTMLButtonElement[] = $state([]);

  function pick(m: MethodChoice) {
    if (current) setMethod(current.key, m);
  }

  function onTileKey(e: KeyboardEvent, i: number) {
    const next = segmentStep(e.key, i, TILES.length);
    if (next == null) return;
    e.preventDefault();
    pick(TILES[next]);
    tileEls[next]?.focus();
  }

  const toolDot = (tool: ProbeTool): string => {
    const st = tools[tool];
    return st === "ok" ? "bg-ok" : st ? "bg-bad" : "bg-edge";
  };
  const toolUnusable = (tool: ProbeTool): boolean => !!tools[tool] && tools[tool] !== "ok";
  const dot = (h: NetHost) => (h.live ? "bg-ok" : h.connecting ? "bg-warn" : "bg-edge");
</script>

<div data-testid="netcheck-from">
  <div class="mb-1 flex items-center gap-1.5">
    <span>{t("util.netcheck.checkFrom")}</span>
    <InfoHint text={t("util.netcheck.fromHint")} />
  </div>
  <div class="flex flex-wrap gap-1.5" data-testid="netcheck-hosts">
    {#each hosts as h (h.key)}
      {@const on = current?.key === h.key}
      <div class="flex items-center rounded border {on ? 'border-accent' : 'border-edge'} bg-panel" data-testid="netcheck-host">
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 py-1 text-text hover:bg-edge/60"
          aria-pressed={on}
          onclick={() => (selected = h.key)}
        >
          <span class="h-1.5 w-1.5 shrink-0 rounded-full {dot(h)}"></span>
          <span>{hostName(h.key)}</span>
          {#if h.address && h.address !== h.name}<span class="font-mono text-meta text-muted">{h.address}</span>{/if}
          {#if h.isProd}<span class="text-caption uppercase tracking-wider text-bad">prod</span>{/if}
          {#if checksOf(h.key) > 0}
            <span class="rounded bg-edge px-1 font-mono text-meta text-muted" use:tooltip={t("util.netcheck.checksN", { n: checksOf(h.key) })}>
              {checksOf(h.key)}
            </span>
          {/if}
        </button>
        {#if !h.live}
          {#if h.connecting}
            <span class="pr-2 text-meta text-warn">{t("util.netcheck.hostConnecting")}</span>
          {:else if h.serverId && onConnect}
            <button
              type="button"
              class="mr-1 rounded px-1.5 py-0.5 text-meta text-accent hover:bg-accent/15"
              data-testid="netcheck-connect"
              onclick={() => onConnect(h.serverId!)}
            >
              {t("util.netcheck.connect")}
            </button>
          {:else}
            <span class="pr-2 text-meta text-warn">{t("util.netcheck.hostOffline")}</span>
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  {#if current?.live}
    <div class="mt-1 flex flex-wrap items-baseline gap-x-2 text-meta">
      <span class="font-mono text-text" data-testid="netcheck-hostname">{facts?.hostname || hostName(current.key)}</span>
      <span class="truncate font-mono text-muted" data-testid="netcheck-addrs">{facts ? visibleAddrs(facts.addrs).join(", ") : ""}</span>
      {#if shownMethod && shownMethod !== "none"}
        <span class="text-muted" data-testid="netcheck-method">· {t("util.netcheck.method", { method: methodLabel(shownMethod) })}</span>
      {/if}
    </div>
  {/if}

  {#if current?.live && noMethod}
    <div class="mt-2 flex items-center gap-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-warn" data-testid="netcheck-nomethod">
      <Icon name="wrench" size={14} class="shrink-0" />
      <span class="flex-1">{t("util.netcheck.noMethod")}</span>
      {#if !isLocal && onInstallTool}
        <button
          type="button"
          class="rounded bg-edge px-2 py-1 text-text hover:bg-accent hover:text-panel-alt"
          data-testid="netcheck-install-telnet"
          onclick={() => onInstallTool("telnet", current?.sessionId ?? undefined)}
        >
          {t("util.netcheck.installTelnet")}
        </button>
      {/if}
    </div>
  {/if}

  <!-- Tiles wrap 5 → 3+2 → 2+2+1 as the panel narrows (container queries). -->
  {#if current?.live && !isLocal}
    <div class="mt-2 @container" data-testid="netcheck-methods">
      <div class="mb-1 flex items-center gap-1.5">
        <span>{t("util.netcheck.methodOn", { host: hostName(current.key) })}</span>
        <InfoHint text={t("util.netcheck.methodsHint")} />
      </div>
      <div
        role="radiogroup"
        aria-label={t("util.netcheck.methodTitle")}
        class="grid grid-cols-2 gap-1 @min-[16rem]:grid-cols-3 @min-[26rem]:grid-cols-5"
      >
        {#each TILES as m, i (m)}
          {@const sel = choice === m}
          {@const bad = m !== "auto" && toolUnusable(m)}
          <button
            bind:this={tileEls[i]}
            type="button"
            role="radio"
            aria-checked={sel}
            tabindex={sel ? 0 : -1}
            data-testid={`netcheck-method-${m}`}
            class="flex min-w-0 items-center justify-center gap-1.5 rounded border px-2 py-1 font-mono {sel
              ? 'border-accent bg-accent/15 text-accent'
              : 'border-edge text-text hover:bg-edge'}"
            use:tooltip={m === "auto" && effective && effective !== "none"
              ? t("util.netcheck.methodAutoNow", { method: methodLabel(effective) })
              : ""}
            onclick={() => pick(m)}
            onkeydown={(e) => onTileKey(e, i)}
          >
            {#if m !== "auto"}
              <span class="h-1.5 w-1.5 shrink-0 rounded-full {toolDot(m)}"></span>
            {/if}
            <span class="truncate {bad ? 'line-through' : ''} {bad && !sel ? 'text-muted' : ''}">
              {m === "auto" ? t("util.netcheck.methodAuto") : m}
            </span>
          </button>
        {/each}
      </div>
      {#if pickedUnusable && choice !== "auto"}
        <div class="mt-1.5 flex flex-wrap items-center gap-2 text-meta text-warn" data-testid="netcheck-method-missing">
          <Icon name="alert" size={12} class="shrink-0" />
          <span class="min-w-0 flex-1">
            {tools[choice] === "notimeout"
              ? t("util.netcheck.toolNoTimeout", { tool: choice })
              : t("util.netcheck.toolMissing", { tool: choice })}
          </span>
          {#if tools[choice] === "missing" && choice !== "bash" && onInstallTool}
            <button
              type="button"
              class="rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt"
              data-testid="netcheck-method-install"
              onclick={() => onInstallTool(choice, current?.sessionId ?? undefined)}
            >
              {t("util.netcheck.installTool", { tool: choice })}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
