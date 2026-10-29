<script lang="ts">
  // Utilities panel (Phase 33): a full-screen overlay above the working screen —
  // a left-hand nav of self-contained tools + the active tool on the right. The
  // tool list, search and default selection are pure logic (utilities.ts); this
  // component only maps over the registry and switches the active tool component.
  // Chosen over Settings sections because these are tools used alongside the
  // terminal, not preferences.
  //
  // Above the tools stand the session actions of the top bar (v1.16,
  // sessionactions.ts): a button taken off the bar is still found, explained and
  // run from here, and put back with the same pin a tool has.
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";
  import {
    UTILITIES,
    DEFAULT_UTILITY,
    utilitiesMatching,
    isUtility,
  } from "./utilities";
  import UtilKeys from "./UtilKeys.svelte";
  import UtilCodec from "./UtilCodec.svelte";
  import UtilCidr from "./UtilCidr.svelte";
  import UtilTimestamp from "./UtilTimestamp.svelte";
  import UtilCron from "./UtilCron.svelte";
  import UtilPassword from "./UtilPassword.svelte";
  import UtilJwt from "./UtilJwt.svelte";
  import UtilKnownHosts from "./UtilKnownHosts.svelte";
  import UtilTls from "./UtilTls.svelte";
  import UtilHttp from "./UtilHttp.svelte";
  import UtilNetCheck from "./UtilNetCheck.svelte";
  import UtilSessionAction from "./UtilSessionAction.svelte";
  import type { ProbeSession } from "./probe";
  import type { HostServer, HostTab } from "./netroute";
  import { tooltip } from "./actions/tooltip";
  import { utilAction, type SessionAction, type TopbarId } from "./topbaractions";
  import {
    keySession,
    SESSION_ACTION_DEFS,
    sessionActionsMatching,
    sessionActionView,
    sessionKey,
    type SessionActionState,
  } from "./sessionactions";
  import { isPinned, pinAction, unpinAction } from "./stores/topbarpins.svelte";

  let {
    open = $bindable(false),
    initialUtility = null,
    session = null,
    netServers = [],
    netTabs = [],
    onConnectServer,
    onInstallTool,
    toolsReloadToken = 0,
    actions = null,
    onSessionAction,
  }: {
    open?: boolean;
    /** Deep-link: focus this tool when the panel opens (e.g. from a shortcut). */
    initialUtility?: string | null;
    /** Active-tab context for the network tools (SSH remote / local PTY). */
    session?: ProbeSession | null;
    /** The catalog and the open tabs, for the access check's choice of servers. */
    netServers?: HostServer[];
    netTabs?: HostTab[];
    /** Open a session to a server the access check needs. */
    onConnectServer?: (serverId: string) => void;
    /** Offer a probe tool's install dialog on that session (access check on an SSH host). */
    onInstallTool?: (tool: string, sessionId?: string) => void;
    /** Bumped after a server-tool install finishes. */
    toolsReloadToken?: number;
    /**
     * What decides whether each session action can run now. Null where the
     * window is shown without a page behind it — then it lists the tools only.
     */
    actions?: SessionActionState | null;
    /** Run a session action; one that opens something closes this window first. */
    onSessionAction?: (id: SessionAction) => void;
  } = $props();

  let search = $state("");
  // A tool's id, or `session:<id>` for a session action.
  let selected = $state<string>(DEFAULT_UTILITY);
  const visible = $derived(utilitiesMatching(search));
  const visibleActions = $derived(actions ? sessionActionsMatching(search) : []);
  const active = $derived(UTILITIES.find((u) => u.id === selected) ?? UTILITIES[0]);
  // The session action on screen, when the selection is one.
  const activeAction = $derived(
    actions ? (SESSION_ACTION_DEFS.find((a) => a.id === keySession(selected)) ?? null) : null,
  );
  const actionView = $derived(activeAction && actions ? sessionActionView(activeAction.id, actions) : null);
  // What is on screen as a button of the top bar, and whether it is there (v1.16).
  const barId = $derived<TopbarId>(activeAction ? activeAction.id : utilAction(active.id));
  const onBar = $derived(isPinned(barId));
  // The header of the right pane: the session action's, or the tool's.
  const shown = $derived(activeAction ?? active);

  function runAction(id: SessionAction) {
    // What opens over the window (monitoring, the library, the notes) takes its
    // place; a switch (recording, broadcast) is flipped and its new state shown.
    if (actionView?.opens) open = false;
    onSessionAction?.(id);
  }

  // On open, honour a deep-link and reset the search. Keeping the last selection
  // otherwise would be surprising after a deep-link, so we always resolve here.
  $effect(() => {
    if (!open) return;
    search = "";
    if (initialUtility && isUtility(initialUtility)) selected = initialUtility;
  });

  // The tab the window was opened on: the access check's home while the window
  // is open. Connecting a server from the tool activates its new tab, and the
  // rules on screen must not swap to that tab's under the user's hands.
  let homeId = $state<string | null>(null);
  $effect(() => {
    if (open) homeId = untrack(() => session?.id ?? null);
  });

  // Keep the selection valid while filtering: if what is selected is filtered
  // out, fall back to the first visible row so the right pane never goes blank.
  $effect(() => {
    const keys = [...visibleActions.map((a) => sessionKey(a.id)), ...visible.map((u) => u.id)];
    if (keys.length && !keys.includes(selected)) selected = keys[0];
  });

  function close() {
    open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window onkeydown={open ? onKey : undefined} />

{#if open}
  <div class="fixed inset-0 z-40 flex items-center justify-center" data-testid="utilities-panel">
    <!-- Dims only; closing is the × or Escape (lint rule `vterm/backdrop-no-close`). -->
    <div class="absolute inset-0 bg-black/50" aria-hidden="true"></div>
    <div class="relative flex max-h-[85vh] w-[52rem] flex-col rounded-lg border border-edge bg-panel-alt">
      <div class="flex items-center justify-between border-b border-edge px-4 py-3">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-accent">
          <Icon name="wrench" size={15} />{t("util.title")}
        </h2>
        <button
          class="rounded p-0.5 text-muted hover:text-danger"
          aria-label={t("common.close")}
          onclick={close}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div class="flex min-h-0 flex-1 overflow-hidden">
        <!-- Tool nav (searchable) -->
        <nav class="flex w-52 shrink-0 flex-col border-r border-edge" aria-label={t("util.title")}>
          <div class="border-b border-edge p-2">
            <input
              data-testid="utilities-search"
              type="search"
              placeholder={t("util.searchPlaceholder")}
              class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
              bind:value={search}
            />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            {#if visible.length === 0 && visibleActions.length === 0}
              <p class="py-6 text-center text-xs text-muted">{t("util.noResults")}</p>
            {/if}
            <!-- The session actions of the top bar: still here when taken off it. -->
            {#if visibleActions.length > 0}
              <p class="px-2 pb-1 pt-0.5 text-xs uppercase tracking-wider text-muted" data-testid="utilities-group-session">
                {t("sessionact.group")}
              </p>
              {#each visibleActions as a (a.id)}
                <button
                  type="button"
                  data-testid={`utility-nav-${sessionKey(a.id)}`}
                  class="mb-1 flex w-full items-start gap-2 rounded px-2 py-1.5 text-left {selected ===
                  sessionKey(a.id)
                    ? 'bg-edge text-text'
                    : 'text-muted hover:bg-edge/50 hover:text-text'}"
                  aria-current={selected === sessionKey(a.id) ? "page" : undefined}
                  onclick={() => (selected = sessionKey(a.id))}
                >
                  <Icon name={a.icon} size={15} class="mt-0.5 shrink-0" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm">{t(a.titleKey)}</span>
                  </span>
                  {#if isPinned(a.id)}
                    <Icon name="pin" size={12} class="mt-1 shrink-0 text-accent" />
                  {/if}
                </button>
              {/each}
              {#if visible.length > 0}
                <p class="px-2 pb-1 pt-2 text-xs uppercase tracking-wider text-muted" data-testid="utilities-group-tools">
                  {t("sessionact.toolsGroup")}
                </p>
              {/if}
            {/if}
            {#each visible as u (u.id)}
              <button
                type="button"
                data-testid={`utility-nav-${u.id}`}
                class="mb-1 flex w-full items-start gap-2 rounded px-2 py-1.5 text-left {selected === u.id
                  ? 'bg-edge text-text'
                  : 'text-muted hover:bg-edge/50 hover:text-text'}"
                aria-current={selected === u.id ? "page" : undefined}
                onclick={() => (selected = u.id)}
              >
                <Icon name={u.icon} size={15} class="mt-0.5 shrink-0" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">{t(u.titleKey)}</span>
                </span>
                <!-- On the top bar: said in the list, so the bar's tools are found here. -->
                {#if isPinned(utilAction(u.id))}
                  <Icon name="pin" size={12} class="mt-1 shrink-0 text-accent" />
                {/if}
              </button>
            {/each}
          </div>
        </nav>

        <!-- Active tool -->
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="utility-pane">
          <div class="mb-4">
            <div class="flex items-center gap-2">
              <h3 class="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-text">
                <Icon name={shown.icon} size={16} class="shrink-0 text-accent" /><span class="truncate">{t(shown.titleKey)}</span>
              </h3>
              <!-- Keep this one click away: a button of its own on the top bar. -->
              <button
                type="button"
                class="flex shrink-0 items-center rounded p-1 hover:bg-edge {onBar
                  ? 'text-accent'
                  : 'text-muted hover:text-text'}"
                aria-label={onBar ? t("topbar.unpin") : t("topbar.pin")}
                aria-pressed={onBar}
                use:tooltip={onBar ? t("topbar.unpin") : t("topbar.pin")}
                data-testid="utility-pin"
                onclick={() => (onBar ? unpinAction(barId) : pinAction(barId))}
              >
                <Icon name="pin" size={14} />
              </button>
            </div>
            <p class="mt-1 text-xs text-muted">{t(shown.descKey)}</p>
          </div>

          {#if activeAction && actionView}
            <UtilSessionAction
              def={activeAction}
              view={actionView}
              notesFor={actions?.notesFor ?? null}
              pinned={onBar}
              onrun={() => runAction(activeAction.id)}
            />
          {:else if selected === "netcheck"}
            <UtilNetCheck
              {homeId}
              servers={netServers}
              tabs={netTabs}
              onConnect={onConnectServer}
              {onInstallTool}
              reloadToken={toolsReloadToken}
            />
          {:else if selected === "keys"}
            <UtilKeys />
          {:else if selected === "codec"}
            <UtilCodec />
          {:else if selected === "cidr"}
            <UtilCidr />
          {:else if selected === "timestamp"}
            <UtilTimestamp />
          {:else if selected === "cron"}
            <UtilCron />
          {:else if selected === "password"}
            <UtilPassword />
          {:else if selected === "jwt"}
            <UtilJwt />
          {:else if selected === "knownHosts"}
            <UtilKnownHosts />
          {:else if selected === "tls"}
            <UtilTls {session} />
          {:else if selected === "http"}
            <UtilHttp {session} />
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
