<script lang="ts">
  // Structured view of JSON (NDJSON) log lines: a filterable table with
  // timestamp / level / message columns plus user-chosen extra columns pulled
  // from the JSON fields, and tail-style auto-scroll. The filter row is the
  // lists' one (v1.29, ADR 0050): the field, the «Level» facet (a button with its
  // values in a wide view, a funnel in a narrow one). Parsing lives in
  // jsonlog.ts; this component is presentational. Shown as an overlay over the
  // terminal when the raw↔structured toggle is on (Terminal.svelte).
  import {
    availableFields,
    fieldValue,
    levelClass,
    normalizeTime,
    colWidth,
    resizedWidth,
    COL_WIDTHS,
    COL_EXTRA_DEFAULT,
    LOG_SCHEMA,
    type JsonLogEntry,
  } from "./jsonlog";
  import ListHeader from "../ui/ListHeader.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { filterItems, NO_FILTER, type ListFilter } from "../ui/listview";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import { wideWhen } from "../actions/panelwide.svelte";
  import { uiPx } from "../settings/settings.svelte";
  import { tooltip } from "../actions/tooltip";
  import ColumnGrip from "../ui/ColumnGrip.svelte";
  import Icon from "../ui/Icon.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import { writeClipboard } from "../app/clipboard";
  import { notifySuccess } from "../stores/toasts.svelte";
  import { t } from "../i18n";

  let {
    entries,
    onClear,
  }: { entries: JsonLogEntry[]; onClear?: () => void } = $props();

  let filter = $state<ListFilter>(NO_FILTER);
  let extraColumns = $state<string[]>([]);
  let showColumns = $state(false);
  // The view's width against the panels' one threshold: the level facet is a
  // button that says its values when wide, a funnel when narrow.
  let wide = $state(false);
  let listHeader = $state<{ contextItems(): MenuItem[] }>();
  function openListMenu(e: MouseEvent, row?: JsonLogEntry) {
    e.preventDefault();
    e.stopPropagation();
    menu = { x: e.clientX, y: e.clientY, items: [
      ...(row ? [{ icon: "copy" as const, label: t("jsonlog.copy"), onSelect: () => copyRow(row) }, { kind: "separator" as const }] : []),
      { kind: "submenu", key: "log-columns", icon: "table", label: t("jsonlog.columns"), items:
        availableFields(entries).map((field) => ({ label: field, checked: extraColumns.includes(field), onSelect: () => toggleColumn(field) })),
      },
      ...(listHeader?.contextItems() ?? []),
      { icon: "trash", label: t("jsonlog.clear"), danger: true, onSelect: () => (confirmClear = true) },
    ] };
  }
  let menu = $state<OpenMenu | null>(null);
  let confirmClear = $state(false);
  let expanded = $state(new Set<number>());
  let scroller = $state<HTMLDivElement>();
  let stick = $state(true);

  // Drag-resizable column widths, keyed by "time"/"level"/"message" and
  // "x:<field>" for user-added columns. Empty = use defaults. The grip captures
  // the column's start width on pointerdown, then sets the new width on move.
  let colWidths = $state<Record<string, number>>({});
  let resizeStartW = 0;
  const EXPAND_W = 28;
  // Visible height of the table's scroller: a column's border can be dragged
  // anywhere along it, so each header grip reaches this far down (ColumnGrip).
  let listHeight = $state(0);

  function startColResize(key: string, fallback: number) {
    resizeStartW = colWidth(colWidths, key, fallback);
  }
  function onColResize(key: string, dx: number) {
    colWidths = { ...colWidths, [key]: resizedWidth(resizeStartW, dx / uiPx(1)) };
  }
  /** Double click on a border: the column goes back to its default width. */
  function resetColWidth(key: string) {
    const { [key]: _dropped, ...rest } = colWidths;
    colWidths = rest;
  }

  const totalWidth = $derived(
    EXPAND_W +
      colWidth(colWidths, "time", COL_WIDTHS.time) +
      colWidth(colWidths, "level", COL_WIDTHS.level) +
      colWidth(colWidths, "message", COL_WIDTHS.message) +
      extraColumns.reduce((s, c) => s + colWidth(colWidths, `x:${c}`, COL_EXTRA_DEFAULT), 0),
  );

  const filtered = $derived(filterItems(entries, LOG_SCHEMA, filter));
  // Field list for the column picker — only computed while the picker is open
  // (avoids scanning every entry on each new line during a live tail).
  const fields = $derived(showColumns ? availableFields(entries) : []);

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
    filter = NO_FILTER;
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
    notifySuccess(t("jsonlog.copied"), { source: "terminal" });
  }

  function onScroll() {
    if (!scroller) return;
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
  }

  // Tail behaviour: keep the view pinned to the newest row while the user hasn't
  // scrolled up. Re-runs whenever the filtered set grows.
  $effect(() => {
    void filtered.length;
    if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
  });
</script>

<div role="presentation" oncontextmenu={(e) => openListMenu(e)} class="flex h-full w-full flex-col bg-panel" data-testid="jsonlog-view" use:wideWhen={(w) => (wide = w)}>
  <!-- The filter row: the field and the level facet; «Clear» and the column
       picker stand in it as the list's own buttons. -->
  <ListHeader
    bind:this={listHeader}
    items={entries}
    schema={LOG_SCHEMA}
    {filter}
    onfilter={(next) => (filter = next)}
    shown={filtered.length}
    total={entries.length}
    labels={{ facet: () => t("jsonlog.colLevel") }}
    placeholder={t("jsonlog.filter")}
    {wide}
    onmenu={(m) => (menu = m)}
    testid="jsonlog-header"
  >
      <!-- Clear accumulated rows (confirmed) — e.g. before viewing a different log -->
      <button
        type="button"
        onclick={() => (confirmClear = true)}
        class="shrink-0 rounded px-2 py-0.5 font-medium hover:text-danger"
        use:tooltip={t("jsonlog.clearHint")}
      >
        {t("jsonlog.clear")}
      </button>
      <!-- Column picker -->
      <div class="relative shrink-0">
        <button
          type="button"
          onclick={() => (showColumns = !showColumns)}
          aria-expanded={showColumns}
          use:tooltip={t("jsonlog.columns")}
          aria-label={t("jsonlog.columns")}
          class="flex items-center gap-1 rounded p-1 text-muted hover:text-accent"
        >
          <Icon name="table" size={14} />
        </button>
        {#if showColumns}
          <div
            class="absolute left-0 top-7 z-20 max-h-64 w-44 overflow-auto rounded border border-edge bg-panel-alt p-1.5 shadow-lg"
          >
            {#if fields.length === 0}
              <p class="px-1 py-0.5 text-meta text-muted">{t("jsonlog.noFields")}</p>
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
  </ListHeader>

  {#if entries.length === 0}
    <!-- `min-h-0`: the view is a layer over the terminal that nothing clips, so
         a wrapper that could not get shorter than its text spilled it over the
         bottom dock (v1.30). The empty state fits itself to what is left. -->
    <div class="min-h-0 flex-1">
      <EmptyState icon="table" title={t("jsonlog.emptyTitle")} hint={t("jsonlog.emptyHint")} />
    </div>
  {:else}
    {#snippet grip(key: string, fallback: number)}
      <!-- The column's draggable border: in the header cell, reaching down over
           the rows (shared with the dock lists). -->
      <ColumnGrip
        testid={`jsonlog-grip-${key}`}
        onstart={() => startColResize(key, fallback)}
        onresize={(dx) => onColResize(key, dx)}
        onreset={() => resetColWidth(key)}
      />
    {/snippet}
    <div
      bind:this={scroller}
      bind:clientHeight={listHeight}
      onscroll={onScroll}
      class="min-h-0 flex-1 overflow-auto"
      style={listHeight > 0 ? `--list-h: ${listHeight}px` : undefined}
    >
      <table class="table-fixed border-collapse text-xs" style="width:{uiPx(totalWidth)}px">
        <colgroup>
          <col style="width:{uiPx(EXPAND_W)}px" />
          <col style="width:{uiPx(colWidth(colWidths, 'time', COL_WIDTHS.time))}px" />
          <col style="width:{uiPx(colWidth(colWidths, 'level', COL_WIDTHS.level))}px" />
          <col style="width:{uiPx(colWidth(colWidths, 'message', COL_WIDTHS.message))}px" />
          {#each extraColumns as col}
            <col style="width:{uiPx(colWidth(colWidths, `x:${col}`, COL_EXTRA_DEFAULT))}px" />
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
              <!-- The cell itself must not clip: the grip overflows it downwards. -->
              <th class="relative px-2 py-1 text-left font-mono font-medium" title={col}>
                <span class="block truncate">{col}</span>{@render grip(`x:${col}`, COL_EXTRA_DEFAULT)}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each filtered as e (e.seq)}
            <tr oncontextmenu={(event) => openListMenu(event, e)} class="border-t border-edge/40 align-top hover:bg-edge">
              <td class="px-1 py-1">
                <button
                  type="button"
                  onclick={() => toggleExpand(e.seq)}
                  aria-expanded={expanded.has(e.seq)}
                  aria-label={t("jsonlog.details")}
                  use:tooltip={t("jsonlog.details")}
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
                    <span class="rounded bg-edge px-1.5 py-0.5 text-caption uppercase tracking-wider text-muted"
                      >{e.format}</span
                    >
                    <button
                      type="button"
                      onclick={() => copyRow(e)}
                      class="flex items-center gap-1 rounded p-0.5 text-muted hover:text-accent"
                      use:tooltip={t("jsonlog.copy")}
                      aria-label={t("jsonlog.copy")}
                    >
                      <Icon name="copy" size={13} />
                    </button>
                  </div>
                  <pre class="overflow-x-auto whitespace-pre-wrap break-all text-meta text-muted">{e.format ===
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

<ContextMenu {menu} onclose={() => (menu = null)} />

<ConfirmDialog
  open={confirmClear}
  title={t("jsonlog.clearConfirmTitle")}
  confirmLabel={t("jsonlog.clear")}
  onconfirm={doClear}
  oncancel={() => (confirmClear = false)}
>
  {t("jsonlog.clearConfirmBody")}
</ConfirmDialog>
