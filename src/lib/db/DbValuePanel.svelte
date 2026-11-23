<script lang="ts">
  // The value of the selected cell beside a table's rows (ADR 0081): all of it,
  // JSON laid out without touching its text, a value the backend cut at 64 KB
  // read to its end by the row's key, the row it points at and the rows
  // pointing at it. What a database holds is text here, never markup.
  import { tooltip } from "../actions/tooltip";
  import { writeClipboard } from "../app/clipboard";
  import { t } from "../i18n";
  import type { DbKind, DbOutcome } from "../types";
  import Icon from "../ui/Icon.svelte";
  import type { TableKeys } from "./dbcatalog";
  import { followFk, followIncoming, matchWhere, rowValues, shownValue, textual, type Incoming, type TableRef } from "./dbtable";
  import type { DbTableState } from "../stores/db.svelte";

  let {
    outcome,
    cell,
    kind,
    keys,
    incoming,
    full,
    backslashEscapes,
    onfollow,
    onreadAll,
  }: {
    outcome: DbOutcome;
    cell: { row: number; col: number } | null;
    kind: DbKind;
    keys: TableKeys;
    incoming: Incoming[];
    /** The value read in full, when it was. */
    full: DbTableState["value"];
    backslashEscapes: boolean;
    onfollow: (table: TableRef, where: string) => void;
    onreadAll: (row: number, col: number) => void;
  } = $props();

  const column = $derived(cell ? (outcome.columns[cell.col] ?? null) : null);
  const raw = $derived(cell ? (outcome.rows[cell.row]?.[cell.col] ?? null) : null);
  const mine = $derived(!!full && !!cell && full.row === cell.row && full.col === cell.col);
  const text = $derived(mine && full?.text !== null && full?.text !== undefined ? full.text : raw);
  const shown = $derived(column ? shownValue(text, column.typeName) : null);
  const cut = $derived(!!cell && outcome.cut.some(([r, c]) => r === cell.row && c === cell.col) && !(mine && full?.text !== null));
  const keyValues = $derived(cell ? rowValues(outcome, cell.row, keys.primary) : null);
  const keyLine = $derived(keyValues ? matchWhere(kind, keys.primary, keyValues, backslashEscapes) : null);
  const goes = $derived(
    cell && column
      ? keys.foreign
          .filter((fk) => fk.columns.includes(column.name))
          .map((fk) => ({ fk, to: followFk(kind, outcome, cell.row, fk, backslashEscapes) }))
          .filter((x) => x.to !== null)
      : [],
  );
  const from = $derived(
    cell
      ? incoming.map((inc) => ({ inc, to: followIncoming(kind, outcome, cell.row, inc, backslashEscapes) })).filter((x) => x.to !== null)
      : [],
  );
  let copied = $state(false);

  function copy() {
    if (text === null) return;
    void writeClipboard(text).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1500);
    });
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-panel-alt text-xs" data-testid="db-value">
  {#if !cell || !column}
    <p class="p-3 text-meta text-muted">{t("db.value.pick")}</p>
  {:else}
    <div class="flex shrink-0 items-center gap-1.5 border-b border-edge px-2 py-1">
      <span class="min-w-0 truncate font-mono text-text">{column.name}</span>
      <span class="min-w-0 truncate text-caption text-muted">{column.typeName.toLowerCase()}</span>
      <button
        type="button"
        class="ml-auto rounded p-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
        disabled={text === null}
        aria-label={t("db.grid.copyValue")}
        use:tooltip={t("db.grid.copyValue")}
        onclick={copy}
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      {#if shown === null}
        <p class="p-2 font-mono italic text-muted">{t("db.value.null")}</p>
      {:else}
        <pre class="whitespace-pre-wrap break-words p-2 font-mono text-meta text-text [overflow-wrap:anywhere]" data-testid="db-value-text">{shown.text}</pre>
      {/if}
    </div>
    {#if cut || (mine && full)}
      <div class="shrink-0 space-y-1 border-t border-edge px-2 py-1 text-meta">
        {#if mine && full?.loading}
          <span class="flex items-center gap-1 text-muted"><Icon name="loader" size={11} class="animate-spin" />{t("db.value.reading")}</span>
        {:else if mine && full?.error}
          <p class="text-bad">{full.error}</p>
        {:else if mine && full?.capped}
          <p class="text-warn">{t("db.value.capped")}</p>
        {/if}
        {#if cut && !(mine && full?.loading)}
          <p class="text-warn">{t("db.value.cut")}</p>
          {#if !textual(column.typeName)}
            <p class="text-muted">{t("db.value.bytes")}</p>
          {:else if keys.primary.length === 0 || !keyLine}
            <p class="text-muted">{t("db.value.noKey")}</p>
          {:else}
            <button type="button" class="text-accent hover:underline" onclick={() => onreadAll(cell.row, cell.col)} data-testid="db-value-read">{t("db.value.readAll")}</button>
          {/if}
        {/if}
      </div>
    {/if}
    {#if keyLine || goes.length || from.length}
      <div class="max-h-[40%] shrink-0 space-y-0.5 overflow-auto border-t border-edge px-2 py-1 text-meta">
        {#if keyLine}<p class="truncate font-mono text-muted" use:tooltip={keyLine}>{t("db.value.row", { key: keyLine })}</p>{/if}
        {#each goes as g (g.fk.name)}
          <button type="button" class="flex w-full min-w-0 items-center gap-1 text-left text-accent hover:underline" onclick={() => g.to && onfollow(g.to.table, g.to.where)} data-testid="db-value-to">
            <Icon name="arrowRight" size={11} class="shrink-0" /><span class="truncate font-mono">{g.fk.ref.name}</span>
          </button>
        {/each}
        {#if from.length}
          <p class="pt-0.5 text-muted">{t("db.value.from")}</p>
          {#each from as f (`${f.inc.from.schema}.${f.inc.from.name}.${f.inc.fk.name}`)}
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-1 text-left text-accent hover:underline"
              onclick={() => f.to && onfollow(f.to.table, f.to.where)}
              data-testid="db-value-from"
            >
              <Icon name="arrowLeft" size={11} class="shrink-0" /><span class="truncate font-mono">{f.inc.from.name}.{f.inc.fk.columns.join(", ")}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  {/if}
</div>
