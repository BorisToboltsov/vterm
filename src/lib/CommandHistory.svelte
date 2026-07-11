<script lang="ts">
  // Ctrl+R command-history overlay (Phase 23): a reverse-search palette over the
  // current session's shell history. Presentational + keyboard-only; the parent
  // (Terminal) supplies the parsed command list and handles accept (insert into
  // the PTY line). Pure filtering lives in history.ts.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";
  import { filterCommands } from "./history";

  let {
    open = false,
    items = [],
    loading = false,
    error = null,
    server = "",
    onaccept,
    onclose,
  }: {
    open?: boolean;
    /** Recent, de-duplicated commands, newest-first. */
    items?: string[];
    loading?: boolean;
    error?: string | null;
    /** Server/host label for the header (empty for local shell tabs). */
    server?: string;
    onaccept: (command: string) => void;
    onclose: () => void;
  } = $props();

  let query = $state("");
  let selected = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  const filtered = $derived(filterCommands(items, query));

  // Reset the query/selection each time the overlay opens, and focus the field.
  $effect(() => {
    if (open) {
      query = "";
      selected = 0;
      queueMicrotask(() => inputEl?.focus());
    }
  });

  // Keep the selection in range as the filtered list changes.
  $effect(() => {
    if (selected > filtered.length - 1) selected = Math.max(0, filtered.length - 1);
  });

  // Scroll the highlighted row into view when the selection moves.
  $effect(() => {
    const row = listEl?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });

  function accept(cmd: string | undefined) {
    if (cmd == null) return;
    onaccept(cmd);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      selected = Math.min(selected + 10, filtered.length - 1);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      selected = Math.max(selected - 10, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      accept(filtered[selected]);
    }
  }
</script>

{#if open}
  <!-- z-40: above the JSON toggle (z-30) and search (z-20) so it owns the field. -->
  <div class="absolute inset-x-0 top-2 z-40 flex justify-center px-3" data-testid="command-history">
    <div class="flex max-h-[60vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-lg">
      <!-- Search field -->
      <div class="flex items-center gap-2 border-b border-edge px-3 py-2">
        <Icon name="history" size={15} class="shrink-0 text-muted" />
        <input
          bind:this={inputEl}
          bind:value={query}
          oninput={() => (selected = 0)}
          onkeydown={onKey}
          type="text"
          spellcheck="false"
          placeholder={t("history.placeholder")}
          aria-label={t("history.placeholder")}
          class="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
        />
        <span class="shrink-0 text-[11px] tabular-nums text-muted">
          {#if server}<span class="text-muted">{server}</span> · {/if}{filtered.length}/{items.length}
        </span>
        <button
          type="button"
          data-testid="command-history-close"
          onclick={onclose}
          use:tooltip={t("common.close")}
          aria-label={t("common.close")}
          class="shrink-0 rounded p-0.5 text-muted hover:text-text"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <!-- Results -->
      <div bind:this={listEl} class="min-h-0 flex-1 overflow-auto p-1">
        {#if loading}
          <p class="py-6 text-center text-xs text-muted">{t("history.loading")}</p>
        {:else if error}
          <p class="px-3 py-6 text-center text-xs text-danger">{error}</p>
        {:else if items.length === 0}
          <p class="py-6 text-center text-xs text-muted">{t("history.empty")}</p>
        {:else if filtered.length === 0}
          <p class="py-6 text-center text-xs text-muted">{t("history.noMatches")}</p>
        {:else}
          {#each filtered as cmd, i (i)}
            <button
              type="button"
              data-idx={i}
              onclick={() => accept(cmd)}
              onmousemove={() => (selected = i)}
              class="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs {i === selected
                ? 'bg-accent/20 text-text'
                : 'text-muted hover:text-text'}"
              title={cmd}
            >
              {cmd}
            </button>
          {/each}
        {/if}
      </div>

      <!-- Key hints -->
      <div class="flex flex-wrap gap-x-4 gap-y-1 border-t border-edge px-3 py-1.5 text-[11px] text-muted">
        <span><kbd class="font-mono">↑↓</kbd> {t("history.hintMove")}</span>
        <span><kbd class="font-mono">Enter</kbd> {t("history.hintInsert")}</span>
        <span><kbd class="font-mono">Esc</kbd> {t("history.hintClose")}</span>
      </div>
    </div>
  </div>
{/if}
