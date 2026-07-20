<script lang="ts">
  // Utilities → known_hosts manager (Phase 33). Lists the vterm-managed host-key
  // store and lets the user forget an entry (re-prompt on next connect). The
  // backend is a dumb list/remove executor; parsing/filtering/sorting is pure
  // logic in knownhosts.ts. Removal is guarded by ConfirmDialog. Offline (local
  // file only).
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";
  import { listKnownHosts, removeKnownHost, type KnownHostEntry } from "./api";
  import { prepareHosts, type ParsedHost } from "./knownhosts";

  let entries = $state<KnownHostEntry[]>([]);
  let search = $state("");
  let pending = $state<ParsedHost | null>(null);

  const hosts = $derived(prepareHosts(entries, search));

  async function load() {
    entries = await listKnownHosts();
  }

  async function confirmRemove() {
    if (!pending) return;
    const id = pending.id;
    pending = null;
    await removeKnownHost(id);
    await load();
  }

  onMount(load);
</script>

<div class="space-y-3 text-xs text-muted">
  <div class="flex items-center gap-2">
    <input
      data-testid="knownhosts-search"
      type="search"
      placeholder={t("util.knownHosts.search")}
      class="flex-1 rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
      bind:value={search}
    />
    <button
      type="button"
      class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
      use:tooltip={t("util.knownHosts.refresh")}
      aria-label={t("util.knownHosts.refresh")}
      onclick={load}
    >
      <Icon name="refresh" size={14} />
    </button>
    <InfoHint text={t("util.knownHosts.note")} />
  </div>

  {#if hosts.length === 0}
    <p class="py-6 text-center text-muted" data-testid="knownhosts-empty">
      {t("util.knownHosts.empty")}
    </p>
  {:else}
    <ul class="divide-y divide-edge/50" data-testid="knownhosts-list">
      {#each hosts as h (h.id)}
        <li class="flex items-center gap-2 py-1.5">
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-sm text-white">
              {h.host}{#if h.port}<span class="text-muted">:{h.port}</span>{/if}
            </p>
            <p class="truncate font-mono text-meta text-muted">{h.fingerprint}</p>
          </div>
          <CopyButton text={h.fingerprint} />
          <button
            type="button"
            data-testid={`knownhosts-remove-${h.id}`}
            class="flex items-center rounded p-1.5 text-muted hover:bg-danger/15 hover:text-danger"
            use:tooltip={t("util.knownHosts.remove")}
            aria-label={t("util.knownHosts.remove")}
            onclick={() => (pending = h)}
          >
            <Icon name="trash" size={14} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<ConfirmDialog
  open={pending !== null}
  title={t("util.knownHosts.removeTitle")}
  confirmLabel={t("util.knownHosts.remove")}
  onconfirm={confirmRemove}
  oncancel={() => (pending = null)}
>
  {t("util.knownHosts.removeBody", { host: pending?.id ?? "" })}
</ConfirmDialog>
