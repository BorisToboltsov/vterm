<script lang="ts">
  // Structured view of JSON (NDJSON) log lines: a filterable table with
  // timestamp / level / message columns plus user-chosen extra columns pulled
  // from the JSON fields, level-filter chips and tail-style auto-scroll. Parsing
  // lives in jsonlog.ts; this component is presentational. Shown as an overlay
  // over the terminal when the raw↔structured toggle is on (Terminal.svelte).
  import {
    applyFilters,
    availableFields,
    fieldValue,
    levelClass,
    normalizeTime,
    colWidth,
    resizedWidth,
    COL_WIDTHS,
    COL_EXTRA_DEFAULT,
    LEVEL_CATS,
    type JsonLogEntry,
    type LevelCat,
  } from "./jsonlog";
  import { resizableHandle } from "./actions/drag";
  import Icon from "./Icon.svelte";
  import EmptyState from "./EmptyState.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { writeClipboard } from "./clipboard";
  import { notifySuccess } from "./stores/toasts.svelte";
  import { t } from "./i18n";

  let { entries, onClear }: { entries: JsonLogEntry[]; onClear?: () => void } = $props();

  let query = $state("");
  let activeLevels = $state<LevelCat[]>([...LEVEL_CATS]);
  let extraColumns = $state<string[]>([]);
  let showColumns = $state(false);
  let confirmClear = $state(false);
  let expanded = $state(new Set<number>());
  let scroller = $state<HTMLDivElement>();
  let stick = $state(true);

  // Drag-resizable column widths, keyed by "time"/"level"/"message" and
  // "x:<field>" for user-added columns. Empty = use defaults. The grip captures
  // the column's start width on pointerdown, then sets the new width on move.
  let colWidths = $state<Record<string, number>>({});
  let resizingCol = $state<string | null>(null);
  let resizeStartW = 0;
  const EXPAND_W = 28;

  function startColResize(key: string, fallback: number) {
    resizingCol = key;
    resizeStartW = colWidth(colWidths, key, fallback);
  }
  function onColResize(key: string, dx: number) {
    colWidths = { ...colWidths, [key]: resizedWidth(resizeStartW, dx) };
  }
  const endColResize = () => (resizingCol = null);

  const totalWidth = $derived(
    EXPAND_W +
      colWidth(colWidths, "time", COL_WIDTHS.time) +
      colWidth(colWidths, "level", COL_WIDTHS.level) +
      colWidth(colWidths, "message", COL_WIDTHS.message) +
      extraColumns.reduce((s, c) => s + colWidth(colWidths, `x:${c}`, COL_EXTRA_DEFAULT), 0),
  );

  const filtered = $derived(applyFilters(entries, query, activeLevels));
  // Field list for the column picker — only computed while the picker is open
  // (avoids scanning every entry on each new line during a live tail).
  const fields = $derived(showColumns ? availableFields(entries) : []);

  function toggleLevel(cat: LevelCat) {
    activeLevels = activeLevels.includes(cat)
      ? activeLevels.filter((c) => c !== cat)
      : [...activeLevels, cat];
  }

  function toggleColumn(field: string) {
    extraColumns = extraColumns.includes(field)
      ? extraColumns.filter((f) => f !== field)
      : [...extraColumns, field];
  }

  // Clean slate before viewing a different log: drop accumulated rows (parent
  // owns them) and reset this view's columns/filter so the old schema is gone.
  // Guarded by a confirmation since it throws away collected data.
  function doClear() {
    confirmClear = false;
    extraColumns = [];
    query = "";
    showColumns = false;
    onClear?.();
  }

  function toggleExpand(seq: number) {
    const next = new Set(expanded);
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    expanded = next;
  }

  function copyRow(e: JsonLogEntry) {
    writeClipboard(e.format === "json" ? JSON.stringify(e.raw, null, 2) : e.source);
    notifySuccess(t("jsonlog.copied"));
  }

  function onScroll() {
    if (!scroller) return;
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
  }

  // Tail behaviour: keep the view pinned to the newest row while the user hasn't
  // scrolled up. Re-runs whenever the filtered set grows.
  $effect(() => {
    filtered.length;
    if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
  });
</script>

<div class="flex h-full w-full flex-col bg-panel" data-testid="jsonlog-view">
  <!-- Left padding clears the corner raw↔structured toggle button (Terminal.svelte). -->
  <div class="flex flex-wrap items-center gap-2 border-b border-edge bg-panel-alt py-1.5 pl-10 pr-2">
    <Icon name="search" size={14} class="text-muted" />
    <input
      bind:value={query}
      type="text"
      spellcheck="false"
      placeholder={t("jsonlog.filter")}
      aria-label={t("jsonlog.filter")}
      class="min-w-24 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
    />
    <!-- Clear accumulated rows (confirmed) — e.g. before viewing a different log -->
    <button
      type="button"
      onclick={() => (confirmClear = true)}
      class="rounded px-2 py-0.5 text-xs font-medium text-muted hover:text-danger"
    >
      {t("jsonlog.clear")}
    </button>
    <span class="h-4 w-px bg-edge"></span>
    <!-- Level filter chips -->
    <div class="flex items-center gap-1">
      {#each LEVEL_CATS as cat}
        <button
          type="button"
          onclick={() => toggleLevel(cat)}
          aria-pressed={activeLevels.includes(cat)}
          aria-label={t("jsonlog.toggleLevel", { level: cat })}
          title={t("jsonlog.toggleLevel", { level: cat })}
          class="rounded px-1.5 py-0.5 text-[11px] font-medium {activeLevels.includes(cat)
            ? `bg-edge ${levelClass(cat)}`
            : 'text-muted/50 hover:text-muted'}">{cat}</button
        >
      {/each}
    </div>
    <!-- Column picker -->
    <div class="relative">
      <button
        type="button"
        onclick={() => (showColumns = !showColumns)}
        aria-expanded={showColumns}
        title={t("jsonlog.columns")}
        aria-label={t("jsonlog.columns")}
        class="flex items-center gap-1 rounded p-1 text-muted hover:text-accent"
      >
        <Icon name="table" size={14} />
      </button>
      {#if showColumns}
        <div
          class="absolute right-0 top-7 z-20 max-h-64 w-44 overflow-auto rounded border border-edge bg-panel-alt p-1.5 shadow-lg"
        >
          {#if fields.length === 0}
            <p class="px-1 py-0.5 text-[11px] text-muted">{t("jsonlog.noFields")}</p>
          {:else}
            {#each fields as field}
              <label class="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted hover:bg-edge">
                <input
                  type="checkbox"
                  checked={extraColumns.includes(field)}
                  onchange={() => toggleColumn(field)}
                />
                <span class="truncate font-mono">{field}</span>
              </label>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
    <span class="shrink-0 text-xs tabular-nums text-muted">{filtered.length}</span>
  </div>

  {#if entries.length === 0}
    <div class="flex flex-1 items-center justify-center p-4">
      <EmptyState icon="table" title={t("jsonlog.emptyTitle")} hint={t("jsonlog.emptyHint")} />
    </div>
  {:else}
    {#snippet grip(key: string, fallback: number)}
      <!-- Drag-to-resize gutter on the column's right edge. Mouse-only, so it is
           hidden from the a11y tree (kept out of the column header's name). -->
      <div
        aria-hidden="true"
        title={t("jsonlog.resizeColumn")}
        class="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-accent {resizingCol ===
        key
          ? 'bg-accent'
          : ''}"
        use:resizableHandle={{
          onStart: () => startColResize(key, fallback),
          onResize: (dx) => onColResize(key, dx),
          onEnd: endColResize,
        }}
      ></div>
    {/snippet}
    <div bind:this={scroller} onscroll={onScroll} class="min-h-0 flex-1 overflow-auto">
      <table class="table-fixed border-collapse text-xs" style="width:{totalWidth}px">
        <colgroup>
          <col style="width:{EXPAND_W}px" />
          <col style="width:{colWidth(colWidths, 'time', COL_WIDTHS.time)}px" />
          <col style="width:{colWidth(colWidths, 'level', COL_WIDTHS.level)}px" />
          <col style="width:{colWidth(colWidths, 'message', COL_WIDTHS.message)}px" />
          {#each extraColumns as col}
            <col style="width:{colWidth(colWidths, `x:${col}`, COL_EXTRA_DEFAULT)}px" />
          {/each}
        </colgroup>
        <thead class="sticky top-0 z-10 bg-panel-alt text-muted">
          <tr>
            <th class="px-1 py-1"></th>
            <th class="relative px-2 py-1 text-left font-medium">
              {t("jsonlog.colTime")}{@render grip("time", COL_WIDTHS.time)}
            </th>
            <th class="relative px-2 py-1 text-left font-medium">
              {t("jsonlog.colLevel")}{@render grip("level", COL_WIDTHS.level)}
            </th>
            <th class="relative px-2 py-1 text-left font-medium">
              {t("jsonlog.colMessage")}{@render grip("message", COL_WIDTHS.message)}
            </th>
            {#each extraColumns as col}
              <th class="relative truncate px-2 py-1 text-left font-mono font-medium" title={col}>
                {col}{@render grip(`x:${col}`, COL_EXTRA_DEFAULT)}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each filtered as e (e.seq)}
            <tr class="border-t border-edge/40 align-top hover:bg-edge">
              <td class="px-1 py-1">
                <button
                  type="button"
                  onclick={() => toggleExpand(e.seq)}
                  aria-expanded={expanded.has(e.seq)}
                  aria-label={t("jsonlog.details")}
                  title={t("jsonlog.details")}
                  class="rounded p-0.5 text-muted hover:text-accent"
                >
                  <Icon name={expanded.has(e.seq) ? "chevronDown" : "chevronRight"} size={12} />
                </button>
              </td>
              <td class="truncate px-2 py-1 tabular-nums text-muted" title={e.ts ?? ""}>
                {normalizeTime(e.ts)}
              </td>
              <td class="truncate px-2 py-1 font-medium {levelClass(e.level)}">
                {e.level ?? ""}
              </td>
              <td class="break-words px-2 py-1 text-text">{e.message ?? ""}</td>
              {#each extraColumns as col}
                <td class="break-words px-2 py-1 font-mono text-muted">{fieldValue(e.raw, col)}</td>
              {/each}
            </tr>
            {#if expanded.has(e.seq)}
              <tr class="bg-panel-alt">
                <td colspan={4 + extraColumns.length} class="px-2 py-1.5">
                  <div class="mb-1 flex items-center gap-2">
                    <span class="rounded bg-edge px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                      >{e.format}</span
                    >
                    <button
                      type="button"
                      onclick={() => copyRow(e)}
                      class="flex items-center gap-1 rounded p-0.5 text-muted hover:text-accent"
                      title={t("jsonlog.copy")}
                      aria-label={t("jsonlog.copy")}
                    >
                      <Icon name="copy" size={13} />
                    </button>
                  </div>
                  <pre class="overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-muted">{e.format ===
                    "json"
                      ? JSON.stringify(e.raw, null, 2)
                      : e.source}</pre>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
      {#if filtered.length === 0}
        <p class="px-3 py-4 text-center text-xs text-muted">{t("jsonlog.noMatches")}</p>
      {/if}
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirmClear}
  title={t("jsonlog.clearConfirmTitle")}
  confirmLabel={t("jsonlog.clear")}
  onconfirm={doClear}
  oncancel={() => (confirmClear = false)}
>
  {t("jsonlog.clearConfirmBody")}
</ConfirmDialog>
