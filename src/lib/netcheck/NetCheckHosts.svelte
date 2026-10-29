<script lang="ts">
  // Utilities → access check, the servers a run checks from (v1.21, ADR 0032;
  // picking — v1.22, ADR 0033). A chip per server with an open tab (one per
  // address; every local tab is "this computer") plus any server the rules
  // route to: whether its session is up, how many connects it makes, "Connect"
  // for one that isn't. A click picks or unpicks it — the picked servers check
  // the rules without a source. Under the chips, one probe-method row per server
  // that checks something (v1.0.37): tiles, where a tool that isn't usable is
  // struck through but still pickable — picking it says why and, on a server,
  // offers the install. This computer has the same row: "vterm" is the app's own
  // connect, the tools are the user's.
  import Icon from "../ui/Icon.svelte";
  import InfoHint from "../ui/InfoHint.svelte";
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import {
    effectiveMethod,
    PROBE_TOOLS,
    visibleAddrs,
    type Method,
    type MethodChoice,
    type NetReport,
    type ProbeTool,
  } from "./netcheck";
  import type { NetHost } from "./netroute";
  import { methodLabel } from "./netcheckwords";
  import { methodFor, setMethod } from "../stores/netcheck.svelte";
  import { segmentStep } from "../ui/segmented";

  let {
    hosts,
    picked,
    methodHosts,
    identities,
    checksOf,
    hostName,
    onToggle,
    onConnect,
    onInstallTool,
  }: {
    /** The chips: the home tab's server first, then every other with a tab or a part in the run. */
    hosts: NetHost[];
    /** Host keys picked to check rules without a source. */
    picked: string[];
    /** The servers that check something — a method row each. */
    methodHosts: NetHost[];
    /** What each session's host reported, by session id. */
    identities: Record<string, NetReport>;
    checksOf: (key: string) => number;
    hostName: (key: string) => string;
    onToggle: (key: string) => void;
    onConnect?: (serverId: string) => void;
    onInstallTool?: (tool: string, sessionId?: string) => void;
  } = $props();

  const TILES: MethodChoice[] = ["auto", ...PROBE_TOOLS];

  /** What a method row shows for one server. */
  function rowState(h: NetHost) {
    const facts = h.sessionId ? (identities[h.sessionId] ?? null) : null;
    const local = h.kind === "local";
    const tools = facts?.tools ?? {};
    const choice = methodFor(h.key);
    const effective = effectiveMethod(choice, tools, local);
    return {
      facts,
      local,
      tools,
      choice,
      effective,
      // "auto" with nothing usable on a server → the banner; a picked tool that
      // isn't usable → the note under the tiles (and no run: it would silently
      // do nothing).
      noMethod: !local && choice === "auto" && facts?.method === "none",
      pickedUnusable: choice !== "auto" && effective === "none",
    };
  }

  /** Who a server turned out to be, for the tooltips: hostname and addresses. */
  function who(h: NetHost): string {
    const facts = h.sessionId ? identities[h.sessionId] : undefined;
    if (!facts) return "";
    return [facts.hostname, visibleAddrs(facts.addrs).join(", ")].filter(Boolean).join(" · ");
  }

  function onTileKey(e: KeyboardEvent, key: string, i: number) {
    const next = segmentStep(e.key, i, TILES.length);
    if (next == null) return;
    e.preventDefault();
    setMethod(key, TILES[next]);
    ((e.currentTarget as HTMLElement).parentElement?.children[next] as HTMLElement | undefined)?.focus();
  }

  function tileLabel(m: MethodChoice, local: boolean): string {
    if (m !== "auto") return m;
    return local ? t("util.netcheck.methodBuiltin") : t("util.netcheck.methodAuto");
  }

  function tileHint(m: MethodChoice, local: boolean, effective: Method | null): string {
    if (m !== "auto") return "";
    if (local) return t("util.netcheck.methodNative");
    return effective && effective !== "none" ? t("util.netcheck.methodAutoNow", { method: methodLabel(effective) }) : "";
  }

  function unusableNote(tool: ProbeTool, state: string | undefined, local: boolean): string {
    if (state === "unsupported") return t("util.netcheck.toolUnsupported");
    if (state === "notimeout") return t("util.netcheck.toolNoTimeout", { tool });
    return local ? t("util.netcheck.toolMissingHere", { tool }) : t("util.netcheck.toolMissing", { tool });
  }

  const toolDot = (tools: Partial<Record<ProbeTool, string>>, tool: ProbeTool): string => {
    const st = tools[tool];
    return st === "ok" ? "bg-ok" : st ? "bg-bad" : "bg-edge";
  };
  const dot = (h: NetHost) => (h.live ? "bg-ok" : h.connecting ? "bg-warn" : "bg-edge");
</script>

<div data-testid="netcheck-from">
  <div class="mb-1 flex items-center gap-1.5">
    <span>{t("util.netcheck.checkFrom")}</span>
    <InfoHint text={t("util.netcheck.fromHint")} />
  </div>
  <div class="flex flex-wrap gap-1.5" data-testid="netcheck-hosts">
    {#each hosts as h (h.key)}
      {@const on = picked.includes(h.key)}
      <div
        class="flex items-center rounded border {on ? 'border-accent bg-accent/10' : 'border-edge bg-panel'}"
        data-testid="netcheck-host"
      >
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 py-1 text-text hover:bg-edge/60"
          aria-pressed={on}
          data-testid="netcheck-pick"
          use:tooltip={who(h)}
          onclick={() => onToggle(h.key)}
        >
          {#if on}<Icon name="check" size={12} class="text-accent" />{/if}
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
  <p class="mt-1 text-meta text-muted">{t("util.netcheck.pickCaption")}</p>

  <!-- A row per server: the name beside its tiles where there's room, above
       them where there isn't; tiles wrap 5 → 3+2 → 2+2+1 (container queries). -->
  {#if methodHosts.length}
    <div class="mt-2 @container" data-testid="netcheck-methods">
      <div class="mb-1 flex items-center gap-1.5">
        <span>{t("util.netcheck.methodTitle")}</span>
        <InfoHint text={t("util.netcheck.methodsHint")} />
      </div>
      <div class="space-y-1.5">
        {#each methodHosts as h (h.key)}
          {@const st = rowState(h)}
          <div data-testid="netcheck-method-row" data-host={h.key}>
            <div class="grid grid-cols-1 gap-1 @min-[32rem]:grid-cols-[7rem_minmax(0,1fr)] @min-[32rem]:items-center">
              <span class="truncate text-text" data-testid="netcheck-hostname" use:tooltip={who(h)}>{hostName(h.key)}</span>
              {#if h.live}
                <div
                  role="radiogroup"
                  aria-label={`${t("util.netcheck.methodTitle")} · ${hostName(h.key)}`}
                  class="grid grid-cols-2 gap-1 @min-[16rem]:grid-cols-3 @min-[26rem]:grid-cols-5"
                >
                  {#each TILES as m, i (m)}
                    {@const sel = st.choice === m}
                    {@const bad = m !== "auto" && !!st.tools[m] && st.tools[m] !== "ok"}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={sel}
                      tabindex={sel ? 0 : -1}
                      data-testid={`netcheck-method-${m}`}
                      class="flex min-w-0 items-center justify-center gap-1.5 rounded border px-2 py-1 font-mono {sel
                        ? 'border-accent bg-accent/15 text-accent'
                        : 'border-edge text-text hover:bg-edge'}"
                      use:tooltip={tileHint(m, st.local, st.effective)}
                      onclick={() => setMethod(h.key, m)}
                      onkeydown={(e) => onTileKey(e, h.key, i)}
                    >
                      {#if m !== "auto"}
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full {toolDot(st.tools, m)}"></span>
                      {/if}
                      <span class="truncate {bad ? 'line-through' : ''} {bad && !sel ? 'text-muted' : ''}">
                        {tileLabel(m, st.local)}
                      </span>
                    </button>
                  {/each}
                </div>
              {:else}
                <span class="text-meta text-warn" data-testid="netcheck-method-offline">{t("util.netcheck.methodNeedsSession")}</span>
              {/if}
            </div>

            {#if h.live && st.noMethod}
              <div class="mt-1.5 flex items-center gap-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-warn" data-testid="netcheck-nomethod">
                <Icon name="wrench" size={14} class="shrink-0" />
                <span class="flex-1">{t("util.netcheck.noMethod")}</span>
                {#if onInstallTool}
                  <button
                    type="button"
                    class="rounded bg-edge px-2 py-1 text-text hover:bg-accent hover:text-panel-alt"
                    data-testid="netcheck-install-telnet"
                    onclick={() => onInstallTool("telnet", h.sessionId ?? undefined)}
                  >
                    {t("util.netcheck.installTelnet")}
                  </button>
                {/if}
              </div>
            {/if}
            {#if h.live && st.pickedUnusable && st.choice !== "auto"}
              {@const tool = st.choice}
              <div class="mt-1.5 flex flex-wrap items-center gap-2 text-meta text-warn" data-testid="netcheck-method-missing">
                <Icon name="alert" size={12} class="shrink-0" />
                <span class="min-w-0 flex-1">{unusableNote(tool, st.tools[tool], st.local)}</span>
                {#if !st.local && st.tools[tool] === "missing" && tool !== "bash" && onInstallTool}
                  <button
                    type="button"
                    class="rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt"
                    data-testid="netcheck-method-install"
                    onclick={() => onInstallTool(tool, h.sessionId ?? undefined)}
                  >
                    {t("util.netcheck.installTool", { tool })}
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
