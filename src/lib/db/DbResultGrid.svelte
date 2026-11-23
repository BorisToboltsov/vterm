<script lang="ts">
  // An answer as a grid (ADR 0080): a window of its rows (up to ten thousand),
  // columns as wide as their name or early values, numbers to the right, NULL
  // as a word. Where the answer is one table's rows with its key, a cell edits
  // on double-click and a row is marked for deletion — nothing reaches the
  // database until the changes are applied (DbConsole). A table document
  // (ADR 0081) adds a sort by the header (the server's), the key marks, the
  // way along a foreign key and its rows read on at the end of the list.
  // Where the answer cannot be edited and says why (`refusal`), the menu shows
  // its edits off with the reason, and an edit asked for says it above the rows.
  import { tick, untrack } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { chordLetter } from "../app/appshortcuts";
  import { writeClipboard } from "../app/clipboard";
  import { t } from "../i18n";
  import { uiPx } from "../settings/settings.svelte";
  import type { DbOutcome } from "../types";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import Icon from "../ui/Icon.svelte";
  import { nearEnd, windowRange } from "../ui/virtuallist";
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
    sort = null,
    onsort,
    marks,
    link,
    onlink,
    onselect,
    onend,
    refusal = null,
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
    /** The column the rows are sorted by (by the server), and how. */
    sort?: { col: number; dir: "ASC" | "DESC" } | null;
    /** A header was clicked: sort by it — the caller asks the server. */
    onsort?: (col: number) => void;
    /** A column of the table's primary key, or of a foreign key. */
    marks?: (col: number) => "pk" | "fk" | null;
    /** Whether a cell leads somewhere (a foreign key's value). */
    link?: (row: number, col: number) => boolean;
    onlink?: (row: number, col: number) => void;
    /** The cell selected, or none (another answer). */
    onselect?: (cell: { row: number; col: number } | null) => void;
    /** The rows on screen came near the end of those read: read more of them. */
    onend?: () => void;
    /** Why the answer's cells are not edited, once known; null — they may be, or it is not known yet. */
    refusal?: string | null;
  } = $props();

  const ROW_H = $derived(uiPx(24));
  let scrollTop = $state(0);
  let viewportH = $state(0);
  let scroller: HTMLDivElement | undefined = $state();
  let selected = $state<{ row: number; col: number } | null>(null);
  let editing = $state<{ row: number; col: number; value: string; touched: boolean; lines: boolean } | null>(null);
  /** Asked to edit before editability was known: edited once it is. */
  let wanted: { row: number; col: number } | null = null;
  /** An edit was asked of an answer that cannot be edited: the reason is said above the rows. */
  let told = $state(false);
  let menu = $state<OpenMenu | null>(null);

  // The characters, and the cell's own padding and border beside them.
  const widths = $derived(outcome.columns.map((_, c) => `calc(${columnChars(outcome, c) + 1}ch + 1.125rem)`));
  const win = $derived(windowRange(scrollTop, viewportH, ROW_H, outcome.rows.length));
  const rows = $derived(outcome.rows.slice(win.start, win.end).map((cells, i) => ({ index: win.start + i, cells })));
  const cutSet = $derived(new Set(outcome.cut.map(([r, c]) => `${r}:${c}`)));
  // A screen of rows before the end: what is read on arrives before the user reaches it.
  const near = $derived(nearEnd(win, outcome.rows.length, viewportH, Math.ceil(viewportH / ROW_H)));
  // The answer by its columns: rows read on keep them, another answer brings its own.
  const columns = $derived(outcome.columns);

  const shown = (row: number, col: number): string | null => {
    const set = edits?.set[row];
    return set && col in set ? set[col] : outcome.rows[row][col];
  };
  const changed = (row: number, col: number): boolean => !!edits?.set[row] && col in edits.set[row];
  const deleted = (row: number): boolean => !!edits?.deleted.includes(row);

  // Another answer: nothing of the last one is selected or edited. More rows of
  // the same answer keep both — the rows before them did not move.
  $effect.pre(() => {
    void columns;
    untrack(() => {
      selected = null;
      editing = null;
      menu = null;
      wanted = null;
      told = false;
    });
  });

  $effect(() => {
    const cell = selected;
    untrack(() => onselect?.(cell ? { ...cell } : null));
  });

  // Near the end — and again with each read that left it near (a short page in
  // a tall view): the caller reads on while there is more and nothing reads.
  $effect(() => {
    void outcome.rows.length;
    if (near) untrack(() => onend?.());
  });

  $effect(() => {
    if (!canEdit) return;
    untrack(() => {
      const cell = wanted;
      wanted = null;
      if (cell) void startEdit(cell.row, cell.col);
    });
  });

  // The answer to an edit asked before it was known came back "no": said, not swallowed.
  $effect(() => {
    if (!refusal) return;
    untrack(() => {
      if (wanted) told = true;
      wanted = null;
    });
  });

  async function startEdit(row: number, col: number) {
    if (!canEdit) {
      // Known not to be editable: said above the rows — and asked again, as a
      // look at the table that failed is taken again.
      if (refusal) told = true;
      else wanted = { row, col };
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
    if (onedit && (refusal || canEdit === null || may || mayDelete)) {
      items.push(
        { kind: "separator" },
        { icon: "pencil", label: t("db.grid.edit"), disabled: !!refusal || (canEdit !== null && !may), onSelect: () => void startEdit(row, col) },
        { icon: "circleOff", label: t("db.grid.setNull"), disabled: !may || value === null, onSelect: () => onedit?.(row, col, null) },
        {
          icon: deleted(row) ? "redo" : "trash",
          label: deleted(row) ? t("db.grid.restoreRow") : t("db.grid.deleteRow"),
          danger: !deleted(row) && !refusal,
          disabled: !mayDelete,
          onSelect: () => ondelete?.(row),
        },
      );
      // Off, and why — the reason under the actions it turns off.
      if (refusal) items.push({ kind: "note", text: refusal });
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

<div class="flex h-full min-h-0 flex-col">
  {#if told && refusal}
    <p class="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1 text-xs text-warn" data-testid="db-edit-refused">
      <Icon name="info" size={12} class="shrink-0" /><span class="min-w-0 flex-1">{refusal}</span>
      <button type="button" class="shrink-0 rounded p-0.5 text-muted hover:bg-edge hover:text-text" aria-label={t("common.close")} onclick={() => (told = false)}>
        <Icon name="close" size={12} />
      </button>
    </p>
  {/if}
  <div
    class="min-h-0 flex-1 overflow-auto font-mono text-xs outline-none [overflow-anchor:none]"
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
          {@const mark = marks?.(i) ?? (c.key ? "pk" : null)}
          <div
            class="shrink-0 truncate border-r border-edge px-2 leading-6 {c.numeric ? 'text-right' : ''}"
            style="width: {widths[i]}"
            role="columnheader"
            aria-sort={sort?.col === i ? (sort.dir === "ASC" ? "ascending" : "descending") : undefined}
            use:tooltip={`${c.name} · ${c.typeName}`}
          >
            {#if onsort}
              <button type="button" class="w-full truncate {c.numeric ? 'text-right' : 'text-left'} hover:text-text" onclick={() => onsort?.(i)} data-testid="db-sort">
                {c.name}{#if mark === "pk"}<span class="ml-1 text-warn">●</span>{:else if mark === "fk"}<Icon name="arrowRight" size={10} class="ml-1 inline text-accent" />{/if}{#if sort?.col === i}<Icon
                    name={sort.dir === "ASC" ? "arrowUp" : "arrowDown"}
                    size={11}
                    class="ml-1 inline text-accent"
                  />{/if}
              </button>
            {:else}
              {c.name}{#if mark === "pk"}<span class="ml-1 text-warn">●</span>{:else if mark === "fk"}<Icon name="arrowRight" size={10} class="ml-1 inline text-accent" />{/if}
            {/if}
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
                    {cellLine(v)}{#if cutSet.has(`${index}:${col}`)}<span class="ml-1 text-warn" use:tooltip={t("db.grid.cut")}>⋯</span>{/if}{#if v !== null && link?.(index, col)}<button
                        type="button"
                        class="ml-1 rounded px-0.5 text-accent hover:bg-accent/15"
                        aria-label={t("db.grid.follow")}
                        use:tooltip={t("db.grid.follow")}
                        onclick={(e) => {
                          e.stopPropagation();
                          onlink?.(index, col);
                        }}
                        ondblclick={(e) => e.stopPropagation()}
                        data-testid="db-follow"><Icon name="arrowRight" size={10} class="inline" /></button
                      >{/if}
                  {/if}
                </div>
              {/each}
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>
<ContextMenu {menu} onclose={() => (menu = null)} />
