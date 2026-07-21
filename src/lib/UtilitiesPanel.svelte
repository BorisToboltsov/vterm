<script lang="ts">
  // Utilities panel (Phase 33): a full-screen overlay above the working screen —
  // a left-hand nav of self-contained tools + the active tool on the right. The
  // tool list, search and default selection are pure logic (utilities.ts); this
  // component only maps over the registry and switches the active tool component.
  // Chosen over Settings sections because these are tools used alongside the
  // terminal, not preferences.
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
  import type { ProbeSession } from "./probe";

  let {
    open = $bindable(false),
    initialUtility = null,
    session = null,
  }: {
    open?: boolean;
    /** Deep-link: focus this tool when the panel opens (e.g. from a shortcut). */
    initialUtility?: string | null;
    /** Active-tab context for the network tools (SSH remote / local PTY). */
    session?: ProbeSession | null;
  } = $props();

  let search = $state("");
  let selected = $state<string>(DEFAULT_UTILITY);
  const visible = $derived(utilitiesMatching(search));
  const active = $derived(UTILITIES.find((u) => u.id === selected) ?? UTILITIES[0]);

  // On open, honour a deep-link and reset the search. Keeping the last selection
  // otherwise would be surprising after a deep-link, so we always resolve here.
  $effect(() => {
    if (!open) return;
    search = "";
    if (initialUtility && isUtility(initialUtility)) selected = initialUtility;
  });

  // Keep the selection valid while filtering: if the current tool is filtered out,
  // fall back to the first visible one so the right pane never goes blank.
  $effect(() => {
    if (visible.length && !visible.some((u) => u.id === selected)) {
      selected = visible[0].id;
    }
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
    <button class="absolute inset-0 bg-black/50" aria-label={t("common.close")} onclick={close}
    ></button>
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
            {#if visible.length === 0}
              <p class="py-6 text-center text-xs text-muted">{t("util.noResults")}</p>
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
              </button>
            {/each}
          </div>
        </nav>

        <!-- Active tool -->
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="utility-pane">
          <div class="mb-4">
            <h3 class="flex items-center gap-2 text-sm font-semibold text-text">
              <Icon name={active.icon} size={16} class="text-accent" />{t(active.titleKey)}
            </h3>
            <p class="mt-1 text-xs text-muted">{t(active.descKey)}</p>
          </div>

          {#if selected === "keys"}
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
