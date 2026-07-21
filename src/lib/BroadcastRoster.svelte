<script lang="ts">
  // Roster for the broadcast focus layout (Phase 22): a compact, scrollable list
  // of the group's non-focused members so 10+ servers stay usable without tiling
  // 10 unreadable terminals. Rows are status-only (no xterm) → cheap to render.
  // Clicking a row brings that host into the big focused pane.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";

  export interface RosterRow {
    sessionId: string;
    alias: string;
    /** `user@host:port` for SSH, or a short label for local. */
    host: string;
    /** Already-localized status label. */
    status: string;
    /** Tailwind status-dot class (see tabs store `dotClass`). */
    dot: string;
    isProd: boolean;
    /** The currently focused member (shown in the big pane) — highlighted here. */
    active: boolean;
  }

  let {
    rows,
    onfocus,
    onremove,
  }: {
    rows: RosterRow[];
    onfocus: (sessionId: string) => void;
    onremove: (sessionId: string) => void;
  } = $props();
</script>

<div class="flex w-64 shrink-0 flex-col overflow-hidden rounded border border-edge bg-panel">
  <div class="shrink-0 border-b border-edge px-3 py-1.5 text-xs text-muted">
    {t("broadcast.roster")} · {rows.length}
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#each rows as row (row.sessionId)}
      <div
        class="group flex items-center gap-2 border-b border-edge/60 px-2.5 py-1.5 {row.active
          ? 'bg-accent/15'
          : row.isProd
            ? 'bg-danger/10'
            : ''}"
      >
        <button
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          onclick={() => onfocus(row.sessionId)}
          use:tooltip={t("broadcast.focusRow")}
        >
          <span class="h-2 w-2 shrink-0 rounded-full {row.dot}"></span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="truncate font-mono text-xs text-text">{row.alias}</span>
              {#if row.isProd}
                <span class="shrink-0 rounded bg-danger/30 px-1 text-caption text-danger">prod</span>
              {/if}
            </span>
            <span class="block truncate text-meta text-muted">{row.status}</span>
          </span>
        </button>
        <button
          class="shrink-0 rounded p-0.5 text-muted opacity-0 hover:text-danger group-hover:opacity-100"
          aria-label={t("broadcast.removeFromGroup")}
          onclick={() => onremove(row.sessionId)}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    {/each}
  </div>
</div>
