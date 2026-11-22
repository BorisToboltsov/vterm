<script lang="ts">
  // An answer as a grid (ADR 0080): a window of its rows (up to ten thousand),
  // columns as wide as their name or early values, numbers to the right, NULL
  // as a word. Where the answer is one table's rows with its key, a cell edits
  // on double-click and a row is marked for deletion — nothing reaches the
  // database until the changes are applied (DbConsole).
  import { tick, untrack } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { chordLetter } from "../app/appshortcuts";
  import { writeClipboard } from "../app/clipboard";
  import { t } from "../i18n";
  import { uiPx } from "../settings/settings.svelte";
  import type { DbOutcome } from "../types";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import { windowRange } from "../ui/virtuallist";
  import type { Edits } from "./dbedit";
  import { cellLine, columnChars, rowLine } from "./dbgrid";

  let {
    outcome,
    edits = null,
    canEdit = null,
    canDelete = null,
    onedit,
    ondelete,
    onwantEdit,
  }: {
    outcome: DbOutcome;
    edits?: Edits | null;
    /** Whether a cell may be edited; null — not known yet (asked with `onwantEdit`). */
    canEdit?: ((row: number, col: number) => boolean) | null;
    /** Whether a row may be marked for deletion: its key is whole. */
    canDelete?: ((row: number) => boolean) | null;
    onedit?: (row: number, col: number, value: string | null) => void;
    ondelete?: (row: number) => void;
    /** A cell was asked to edit while editability is not known. */
    onwantEdit?: (row: number, col: number) => void;
  } = $props();

  const ROW_H = $derived(uiPx(24));
  let scrollTop = $state(0);
  let viewportH = $state(0);
  let scroller: HTMLDivElement | undefined = $state();
  let selected = $state<{ row: number; col: number } | null>(null);
  let editing = $state<{ row: number; col: number; value: string; touched: boolean; lines: boolean } | null>(null);
  /** Asked to edit before editability was known: edited once it is. */
  let wanted: { row: number; col: number } | null = null;
  let menu = $state<OpenMenu | null>(null);

  // The characters, and the cell's own padding and border beside them.
  const widths = $derived(outcome.columns.map((_, c) => `calc(${columnChars(outcome, c) + 1}ch + 1.125rem)`));
  const win = $derived(windowRange(scrollTop, viewportH, ROW_H, outcome.rows.length));
  const rows = $derived(outcome.rows.slice(win.start, win.end).map((cells, i) => ({ index: win.start + i, cells })));
  const cutSet = $derived(new Set(outcome.cut.map(([r, c]) => `${r}:${c}`)));

  const shown = (row: number, col: number): string | null => {
    const set = edits?.set[row];
    return set && col in set ? set[col] : outcome.rows[row][col];
  };
  const changed = (row: number, col: number): boolean => !!edits?.set[row] && col in edits.set[row];
  const deleted = (row: number): boolean => !!edits?.deleted.includes(row);

  // Another answer: nothing of the last one is selected or edited.
  $effect.pre(() => {
    void outcome;
    untrack(() => {
      selected = null;
      editing = null;
      menu = null;
      wanted = null;
    });
  });

  $effect(() => {
    if (!canEdit) return;
    untrack(() => {
      const cell = wanted;
      wanted = null;
      if (cell) void startEdit(cell.row, cell.col);
    });
  });

  async function startEdit(row: number, col: number) {
    if (!canEdit) {
      wanted = { row, col };
      onwantEdit?.(row, col);
      return;
    }
    if (!canEdit(row, col) || deleted(row)) return;
    const value = shown(row, col) ?? "";
    editing = { row, col, value, touched: false, lines: /[\r\n]/.test(value) };
    await tick();
    const box = scroller?.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-cell-input]");
    box?.focus({ preventScroll: true });
    box?.select();
  }

  function commit() {
    if (!editing) return;
    // Untouched is unchanged: a NULL is not an empty string.
    if (editing.touched) onedit?.(editing.row, editing.col, editing.value);
    editing = null;
  }

  function editKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editing = null;
    }
  }

  function cellMenu(e: MouseEvent, row: number, col: number) {
    e.preventDefault();
    selected = { row, col };
    const value = shown(row, col);
    const may = canEdit?.(row, col) ?? false;
    if (!canEdit) onwantEdit?.(row, col);
    const items: MenuItem[] = [
      { icon: "copy", label: t("db.grid.copyValue"), disabled: value === null, onSelect: () => void writeClipboard(value ?? "") },
      { icon: "copy", label: t("db.grid.copyRow"), onSelect: () => void writeClipboard(rowLine(outcome.rows[row].map((_, c) => shown(row, c)))) },
      { icon: "copy", label: t("db.grid.copyColumn"), onSelect: () => void writeClipboard(outcome.columns[col].name) },
    ];
    const mayDelete = canDelete?.(row) ?? false;
    if (onedit && (canEdit === null || may || mayDelete)) {
      items.push(
        { kind: "separator" },
        { icon: "pencil", label: t("db.grid.edit"), disabled: canEdit !== null && !may, onSelect: () => void startEdit(row, col) },
        { icon: "circleOff", label: t("db.grid.setNull"), disabled: !may || value === null, onSelect: () => onedit?.(row, col, null) },
        {
          icon: deleted(row) ? "redo" : "trash",
          label: deleted(row) ? t("db.grid.restoreRow") : t("db.grid.deleteRow"),
          danger: !deleted(row),
          disabled: !mayDelete,
          onSelect: () => ondelete?.(row),
        },
      );
    }
    menu = { x: e.clientX, y: e.clientY, items };
  }

  function onkey(e: KeyboardEvent) {
    if (editing || !selected) return;
    const { row, col } = selected;
    const move = (r: number, c: number) => {
      selected = { row: Math.max(0, Math.min(outcome.rows.length - 1, r)), col: Math.max(0, Math.min(outcome.columns.length - 1, c)) };
      e.preventDefault();
    };
    if (e.key === "ArrowDown") move(row + 1, col);
    else if (e.key === "ArrowUp") move(row - 1, col);
    else if (e.key === "ArrowRight") move(row, col + 1);
    else if (e.key === "ArrowLeft") move(row, col - 1);
    else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      void startEdit(row, col);
    } else if ((e.metaKey || e.ctrlKey) && chordLetter(e) === "c") {
      e.preventDefault();
      void writeClipboard(shown(row, col) ?? "");
    }
  }
</script>

<div
  class="h-full min-h-0 overflow-auto font-mono text-xs outline-none [overflow-anchor:none]"
  bind:this={scroller}
  bind:clientHeight={viewportH}
  onscroll={(e) => (scrollTop = (e.currentTarget as HTMLElement).scrollTop - ROW_H)}
  onkeydown={onkey}
  tabindex="0"
  role="grid"
  aria-rowcount={outcome.rows.length}
  data-testid="db-grid"
>
  <div class="min-w-max">
    <div class="sticky top-0 z-10 flex h-6 border-b border-edge bg-panel-alt text-muted" role="row">
      <div class="w-10 shrink-0 border-r border-edge px-1 text-right text-caption leading-6">#</div>
      {#each outcome.columns as c, i (i)}
        <div
          class="shrink-0 truncate border-r border-edge px-2 leading-6 {c.numeric ? 'text-right' : ''}"
          style="width: {widths[i]}"
          role="columnheader"
          use:tooltip={`${c.name} · ${c.typeName}`}
        >
          {c.name}{#if c.key}<span class="ml-1 text-warn">●</span>{/if}
        </div>
      {/each}
    </div>
    <div style="height: {win.totalHeight}px; position: relative;">
      <div style="transform: translateY({win.padTop}px);">
        {#each rows as { index, cells } (index)}
          <div class="flex h-6 border-b border-edge/40 {deleted(index) ? 'bg-bad/10 text-muted line-through' : ''}" role="row" data-row={index}>
            <div class="w-10 shrink-0 border-r border-edge/60 px-1 text-right text-caption leading-6 text-muted">{index + 1}</div>
            {#each cells as _cell, col (col)}
              {@const v = shown(index, col)}
              {@const isSel = selected?.row === index && selected?.col === col}
              <div
                class="shrink-0 {editing?.row === index && editing.col === col ? 'relative' : 'truncate'} border-r border-edge/40 px-2 leading-6 {outcome.columns[col].numeric ? 'text-right' : ''} {changed(index, col)
                  ? 'bg-accent/15'
                  : ''} {isSel ? 'outline outline-1 -outline-offset-1 outline-accent' : ''} {v === null ? 'italic text-muted' : 'text-text'}"
                style="width: {widths[col]}"
                role="gridcell"
                tabindex="-1"
                onclick={() => (selected = { row: index, col })}
                ondblclick={() => void startEdit(index, col)}
                oncontextmenu={(e) => cellMenu(e, index, col)}
                onkeydown={() => {}}
              >
                {#if editing?.row === index && editing.col === col}
                  {#if editing.lines}
                    <!-- An input would drop the value's line breaks. -->
                    <textarea
                      data-cell-input
                      rows="5"
                      class="absolute left-0 top-0 z-20 w-full min-w-40 resize-none rounded-sm border border-accent bg-panel px-1 text-xs text-text outline-none"
                      bind:value={editing.value}
                      oninput={() => editing && (editing.touched = true)}
                      onkeydown={editKey}
                      onblur={commit}
                    ></textarea>
                  {:else}
                    <input
                      data-cell-input
                      class="h-5 w-full rounded-sm border border-accent bg-panel px-1 text-xs text-text outline-none"
                      bind:value={editing.value}
                      oninput={() => editing && (editing.touched = true)}
                      onkeydown={editKey}
                      onblur={commit}
                    />
                  {/if}
                {:else}
                  {cellLine(v)}{#if cutSet.has(`${index}:${col}`)}<span class="ml-1 text-warn" use:tooltip={t("db.grid.cut")}>⋯</span>{/if}
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>
<ContextMenu {menu} onclose={() => (menu = null)} />
