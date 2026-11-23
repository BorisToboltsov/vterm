<script lang="ts">
  // A table of a database as a document of the connection (ADR 0081): its rows
  // with the server's filter and sort, read on as the list is scrolled to its
  // end, the selected value
  // beside them, its structure and its DDL. It reads on the database's browse
  // connection, shared with the tree and the tab's other tables, and only
  // reads: a change of rows goes through the edits — shown as SQL and applied
  // in one transaction, as in the console.
  import { untrack } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { writeClipboard } from "../app/clipboard";
  import { t } from "../i18n";
  import {
    applyDbEdits,
    cancelDb,
    catalogOf,
    connectDb,
    countTable,
    dbDoc,
    discardDbEdits,
    editDbCell,
    exactCount,
    forgetFullValue,
    pendingCount,
    pendingStatements,
    prepareEdit,
    readFullValue,
    readMoreTable,
    readTable,
    showTableTab,
    tableConn,
    toggleDbRowDelete,
    type DbTableState,
  } from "../stores/db.svelte";
  import { settings, uiPx } from "../settings/settings.svelte";
  import type { EditorDoc } from "../stores/workspaces.svelte";
  import type { DbProfile } from "../types";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import Icon from "../ui/Icon.svelte";
  import { completionNames } from "./dbcatalog";
  import { cellEditable, rowEditable } from "./dbedit";
  import { failureText } from "./dberror";
  import DbResultGrid from "./DbResultGrid.svelte";
  import DbStatus from "./DbStatus.svelte";
  import DbTableStructure from "./DbTableStructure.svelte";
  import { fkOfColumn, followFk, incomingOf, keysOf, moreRows, nextSort, orderByOf, pageSql, rowsText, sortOf, TABLE_ROWS_MAX, tableKey, type TableRef } from "./dbtable";
  import DbValuePanel from "./DbValuePanel.svelte";
  import SqlEditor from "./SqlEditor.svelte";

  let {
    doc,
    profile,
    serverName,
    onopen,
    onconsole,
  }: {
    doc: EditorDoc;
    profile: DbProfile | null;
    serverName: string;
    /** Open another table of the database, with a filter (a key followed). */
    onopen: (table: TableRef, where: string) => void;
    /** Put a statement into the database's console. */
    onconsole: (sql: string) => void;
  } = $props();

  const d = $derived(dbDoc(doc.id));
  const tb = $derived(d?.table ?? null);
  const kind = $derived(doc.db!.kind);
  const browse = $derived(tableConn(doc.id));
  const conn = $derived(browse?.conn ?? null);
  const catalog = $derived(d ? (catalogOf(d.place, d.dbId)?.catalog ?? null) : null);
  const keys = $derived(tb ? keysOf(catalog, tb.ref) : { primary: [], foreign: [] });
  const incoming = $derived(tb ? incomingOf(catalog, tb.ref) : []);
  const names = $derived(catalog ? completionNames(catalog) : {});
  const pending = $derived(d ? pendingCount(doc.id) : 0);
  const prod = $derived(conn?.prod ?? false);
  const out = $derived(d?.result?.outcome ?? null);
  const rows = $derived(settings.dbPageRows);
  const estimate = $derived(tb && catalog ? (catalog.tables.find((x) => x.schema === tb.ref.schema && x.name === tb.ref.name)?.rows ?? null) : null);
  const exact = $derived(tb && d ? exactCount(d.place, d.dbId, tb.ref) : null);

  let width = $state(0);
  // The value beside the rows while both fit; a narrow document keeps the rows.
  const wide = $derived(width >= uiPx(640));
  let where = $state("");
  let orderBy = $state("");
  let cell = $state<{ row: number; col: number } | null>(null);
  let showSql = $state(false);
  let applying = $state(false);
  let discarding = $state<{ resolve: (yes: boolean) => void } | null>(null);

  // What the rows show is what the fields say: a sort by a header, a key followed.
  // Strings, not the table's state: a refused filter stays in its field to be fixed.
  const appliedWhere = $derived(tb?.where ?? "");
  const appliedOrder = $derived(tb?.orderBy ?? "");
  $effect(() => {
    const w = appliedWhere;
    const o = appliedOrder;
    untrack(() => {
      where = w;
      orderBy = o;
    });
  });

  // Another answer — known by its columns: nothing of the last one is selected.
  // Rows read on below keep the selection, as they keep the edits.
  const answer = $derived(out?.columns ?? null);
  $effect(() => {
    void answer;
    untrack(() => (cell = null));
  });

  function mayDiscard(): Promise<boolean> {
    if (pendingCount(doc.id) === 0) return Promise.resolve(true);
    return new Promise((resolve) => (discarding = { resolve }));
  }

  function answerDiscard(yes: boolean) {
    if (yes) discardDbEdits(doc.id);
    discarding?.resolve(yes);
    discarding = null;
  }

  async function read(next: Partial<Pick<DbTableState, "where" | "orderBy">>, extent: "page" | "shown" = "page") {
    if (!d || d.running || !(await mayDiscard())) return;
    await readTable(doc.id, next, extent);
  }

  const apply = () => void read({ where, orderBy });

  /** The list reached its end: the next rows, while there are more — no question, nothing pending is lost. */
  function more() {
    if (tb?.hasNext && !tb.more?.running && !tb.more?.changed) void readMoreTable(doc.id);
  }

  function sortBy(col: number) {
    const name = out?.columns[col]?.name;
    if (!name || !tb) return;
    const next = nextSort(sortOf(tb.orderBy, kind), name);
    void read({ where: tb.where, orderBy: next ? orderByOf(next, kind) : "" });
  }

  const sort = $derived.by(() => {
    const s = tb ? sortOf(tb.orderBy, kind) : null;
    const col = s && out ? out.columns.findIndex((c) => c.name === s.column) : -1;
    return s && col >= 0 ? { col, dir: s.dir } : null;
  });

  const marks = (col: number): "pk" | "fk" | null => {
    const name = out?.columns[col]?.name ?? "";
    return keys.primary.includes(name) ? "pk" : fkOfColumn(keys, name) ? "fk" : null;
  };

  function follow(row: number, col: number) {
    const fk = out ? fkOfColumn(keys, out.columns[col].name) : null;
    const to = fk && out ? followFk(kind, out, row, fk, d?.backslashEscapes) : null;
    if (to) onopen(to.table, to.where);
  }

  function selectCell(c: { row: number; col: number } | null) {
    cell = c;
    if (tb?.value && (!c || tb.value.row !== c.row || tb.value.col !== c.col)) forgetFullValue(doc.id);
  }

  function reread() {
    if (!tb) return;
    if (tb.tab === "data") void read({}, "shown");
    else showTableTab(doc.id, tb.tab === "structure" ? "structure" : "ddl");
  }

  const canEdit = $derived.by(() => {
    const target = d?.edit.target;
    if (!target || typeof target === "string" || !out) return null;
    return (row: number, col: number) => cellEditable(out, target, row, col);
  });
  const canDelete = $derived.by(() => {
    const target = d?.edit.target;
    if (!target || typeof target === "string" || !out) return null;
    return (row: number) => rowEditable(out, target, row);
  });
  const notEditable = $derived(typeof d?.edit.target === "string" ? d.edit.target : null);
  const loaded = $derived(out?.rows.length ?? 0);
</script>

<!-- Not a query container: a `fixed` menu of the grid inside one would stand in the wrong place (panelcontainer.guard). -->
<div class="flex h-full min-h-0 flex-col bg-panel" bind:clientWidth={width} data-testid="db-table">
  <div class="flex shrink-0 flex-wrap items-center gap-1 whitespace-nowrap border-b border-edge px-2 py-1 text-xs">
    <div class="inline-flex overflow-hidden rounded border border-edge" role="tablist">
      {#each [["data", t("db.table.data")], ["structure", t("db.table.structure")], ["ddl", "DDL"]] as [id, label] (id)}
        <button
          type="button"
          role="tab"
          aria-selected={tb?.tab === id}
          class="border-l border-edge px-2.5 py-0.5 first:border-l-0 {tb?.tab === id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-edge hover:text-text'}"
          onclick={() => showTableTab(doc.id, id as DbTableState["tab"])}
          data-testid="db-table-tab-{id}">{label}</button
        >
      {/each}
    </div>
    <span class="ml-1 min-w-0 truncate font-mono text-meta text-muted">{tb ? tableKey(tb.ref) : ""}</span>
    {#if conn?.readOnly}
      <span class="flex items-center gap-1 rounded border border-warn/40 px-1.5 text-meta text-warn" use:tooltip={prod ? t("db.readOnlyProd") : t("db.readOnlyProfile")}>
        <Icon name="lock" size={11} />{t("db.readOnly")}
      </span>
    {/if}
    <span class="ml-auto min-w-0 flex-1 basis-16 truncate text-right text-meta text-muted">{serverName}</span>
    {#if d?.running}
      <button type="button" class="flex items-center gap-1 rounded border border-danger/50 px-2 py-0.5 text-danger" onclick={() => void cancelDb(doc.id)} data-testid="db-table-stop">
        <Icon name="stop" size={12} />{t("db.stop")}
      </button>
    {/if}
    <button
      type="button"
      class="rounded p-1 text-muted enabled:hover:bg-edge enabled:hover:text-text disabled:opacity-40"
      disabled={!conn || !!d?.running}
      aria-label={t("db.table.refresh")}
      use:tooltip={t("db.table.refresh")}
      onclick={reread}
    >
      <Icon name="refresh" size={13} />
    </button>
    <button
      type="button"
      class="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
      use:tooltip={t("db.table.toConsoleHint")}
      onclick={() => tb && onconsole(pageSql(kind, tb.ref, tb.where, tb.orderBy, 0, Math.max(rows, loaded), false))}
      data-testid="db-table-console"
    >
      <Icon name="code" size={13} />{t("db.table.toConsole")}
    </button>
  </div>

  {#if d?.via && !browse}
    <!-- Its browse connection was disconnected: the table asks to connect it again. -->
    <span class="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2 text-xs text-warn">
      <Icon name="plug" size={13} />{t("db.table.disconnected")}
      <button type="button" class="rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt" onclick={() => void connectDb(doc.id)} data-testid="db-table-reconnect">{t("db.reconnect")}</button>
    </span>
  {:else if d?.via && browse?.status !== "ready"}
    <DbStatus docId={d.via} {profile} />
  {:else if d?.failure}
    <p class="shrink-0 border-b border-edge px-3 py-1.5 text-xs text-warn">{failureText(d.failure)}</p>
  {/if}

  {#if tb?.tab === "structure"}
    <div class="min-h-0 flex-1">
      <DbTableStructure structure={tb.structure?.data ?? null} loading={tb.structure?.loading ?? true} error={tb.structure?.error ?? null} onopen={(table) => onopen(table, "")} />
    </div>
  {:else if tb?.tab === "ddl"}
    <div class="flex min-h-0 flex-1 flex-col" data-testid="db-ddl">
      {#if tb.ddl?.loading || !tb.ddl}
        <p class="flex items-center gap-2 p-3 text-xs text-muted"><Icon name="loader" size={13} class="animate-spin" />{t("db.table.ddlReading")}</p>
      {:else if tb.ddl.error}
        <p class="p-3 text-xs text-bad">{tb.ddl.error}</p>
      {:else if tb.ddl.text === null}
        <p class="p-3 text-xs text-muted">{t("db.table.ddlNone")}</p>
      {:else}
        {@const text = tb.ddl.text}
        <div class="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1 text-meta text-muted">
          <Icon name="info" size={12} class="shrink-0" />
          <span class="min-w-0 flex-1">{tb.ddl.how === "server" ? t("db.table.ddlServer") : t("db.table.ddlAssembled")}</span>
          <button type="button" class="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-edge hover:text-text" onclick={() => void writeClipboard(text)}>
            <Icon name="copy" size={12} />{t("db.table.copy")}
          </button>
        </div>
        <pre class="min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-meta text-text">{text}</pre>
      {/if}
    </div>
  {:else if tb}
    <div class="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1 text-meta text-muted">
      <span class="shrink-0 font-mono">WHERE</span>
      <div class="min-w-0 flex-[1.4]">
        <SqlEditor
          single
          value={where}
          {kind}
          {names}
          defaultSchema={tb.ref.schema}
          defaultTable={tb.ref.name}
          placeholder={t("db.table.wherePlaceholder")}
          onchange={(text) => (where = text)}
          onrun={() => {}}
          onrunAll={() => {}}
          onsubmit={apply}
        />
      </div>
      <span class="shrink-0 font-mono">ORDER BY</span>
      <div class="min-w-0 flex-1">
        <SqlEditor
          single
          value={orderBy}
          {kind}
          {names}
          defaultSchema={tb.ref.schema}
          defaultTable={tb.ref.name}
          placeholder={t("db.table.orderPlaceholder")}
          onchange={(text) => (orderBy = text)}
          onrun={() => {}}
          onrunAll={() => {}}
          onsubmit={apply}
        />
      </div>
      <button
        type="button"
        class="h-[1.375rem] shrink-0 rounded border border-edge px-2 text-text enabled:hover:border-accent disabled:opacity-40"
        disabled={!conn || !!d?.running}
        onclick={apply}
        data-testid="db-table-apply">{t("db.table.applyFilter")}</button
      >
    </div>
    {#if tb.refusal}
      <p class="shrink-0 border-b border-edge px-3 py-1 text-xs text-warn" data-testid="db-table-refusal">{t(`db.table.refusal.${tb.refusal}`)}</p>
    {/if}

    <div class="flex min-h-0 flex-1">
      <div class="min-w-0 flex-1">
        {#if d?.running && !out}
          <div class="flex h-full items-center justify-center gap-2 text-xs text-muted"><Icon name="loader" size={14} class="animate-spin" />{t("db.table.reading")}</div>
        {:else if out?.error}
          <div class="space-y-1 p-3 text-xs" data-testid="db-error">
            <p class="text-bad">{out.error.message}</p>
            {#if out.error.detail}<p class="text-muted">{out.error.detail}</p>{/if}
            {#if out.error.hint}<p class="text-muted">{t("db.hint", { hint: out.error.hint })}</p>{/if}
            <p class="font-mono text-meta text-muted">{out.error.code}</p>
          </div>
        {:else if out}
          <DbResultGrid
            outcome={out}
            edits={d?.edit.edits ?? null}
            {canEdit}
            {canDelete}
            {sort}
            onsort={sortBy}
            {marks}
            link={(_row, col) => marks(col) === "fk"}
            onlink={follow}
            onselect={selectCell}
            onend={more}
            onedit={(r, c, v) => editDbCell(doc.id, r, c, v)}
            ondelete={(r) => toggleDbRowDelete(doc.id, r)}
            onwantEdit={() => void prepareEdit(doc.id)}
            refusal={notEditable ? t(`db.edit.not.${notEditable}`) : null}
          />
        {/if}
      </div>
      {#if out && !out.error && wide}
        <div class="w-64 shrink-0 border-l border-edge">
          <DbValuePanel
            outcome={out}
            {cell}
            {kind}
            {keys}
            {incoming}
            full={tb.value}
            backslashEscapes={d?.backslashEscapes ?? false}
            onfollow={onopen}
            onreadAll={(row, col) => void readFullValue(doc.id, row, col, keys.primary)}
          />
        </div>
      {/if}
    </div>

    {#if showSql && pending > 0}
      <div class="max-h-40 shrink-0 overflow-auto border-t border-edge bg-panel-alt">
        <pre class="p-2 font-mono text-meta text-text" data-testid="db-table-sql">{pendingStatements(doc.id).join(";\n")};</pre>
        {#if d?.edit.error}<p class="px-2 pb-1 text-xs text-bad">{d.edit.error}</p>{/if}
      </div>
    {/if}
    <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge bg-panel-alt px-2 py-1 text-meta text-muted">
      <span class="text-text" data-testid="db-table-range">{loaded ? t("db.table.range", { from: 1, to: loaded }) : t("db.table.noRows")}</span>
      {#if tb.more?.running}
        <span class="flex items-center gap-1" data-testid="db-table-more-reading"><Icon name="loader" size={11} class="animate-spin" />{t("db.table.reading")}</span>
      {:else if tb.more?.changed}
        <span class="text-warn" data-testid="db-table-more-changed">{t("db.table.moreChanged")}</span>
      {:else if tb.hasNext && moreRows(loaded, rows) === 0}
        <span class="text-warn" use:tooltip={t("db.table.cappedHint")} data-testid="db-table-capped">{t("db.table.capped", { n: TABLE_ROWS_MAX.toLocaleString() })}</span>
      {:else if tb.hasNext}
        {#if tb.more?.error}<span class="min-w-0 truncate text-bad" use:tooltip={tb.more.error}>{tb.more.error}</span>{/if}
        <button
          type="button"
          class="text-accent enabled:hover:underline disabled:opacity-40"
          disabled={!conn}
          use:tooltip={t("db.table.moreHint", { n: moreRows(loaded, rows) })}
          onclick={more}
          data-testid="db-table-more">{t("db.table.more", { n: moreRows(loaded, rows) })}</button
        >
      {/if}
      {#if tb.count?.running}
        <span class="flex items-center gap-1"><Icon name="loader" size={11} class="animate-spin" />{t("db.table.counting")}</span>
      {:else if tb.count && tb.count.where === tb.where && tb.count.n !== null}
        <span class="text-text" data-testid="db-table-count">{tb.where.trim() ? t("db.table.exactFiltered", { n: tb.count.n.toLocaleString() }) : t("db.table.exact", { n: tb.count.n.toLocaleString() })}</span>
      {:else}
        {#if !tb.where.trim() && exact !== null}
          <span class="text-text">{t("db.table.exact", { n: exact.toLocaleString() })}</span>
        {:else if !tb.where.trim() && estimate !== null}
          <span use:tooltip={t("db.panel.estimate")}>{t("db.table.estimate", { n: rowsText(estimate) })}</span>
        {/if}
        {#if tb.count?.error}<span class="text-bad">{tb.count.error}</span>{/if}
        <button
          type="button"
          class="text-accent enabled:hover:underline disabled:opacity-40"
          disabled={!conn || !!d?.running}
          use:tooltip={t("db.table.countHint")}
          onclick={() => void countTable(doc.id)}
          data-testid="db-table-count-run">{tb.where.trim() ? t("db.table.countFiltered") : t("db.table.count")}</button
        >
      {/if}
      {#if notEditable && out && !out.error}<span class="truncate">{t(`db.edit.not.${notEditable}`)}</span>{/if}
      {#if pending > 0}
        <span class="ml-auto text-warn">{t("db.table.edits", { n: pending })}</span>
        <button type="button" class="rounded px-1 hover:bg-edge hover:text-text {showSql ? 'text-accent' : ''}" onclick={() => (showSql = !showSql)} data-testid="db-table-show-sql">SQL</button>
        <button type="button" class="rounded border border-edge px-2 py-0.5 text-text hover:border-accent" onclick={() => discardDbEdits(doc.id)}>{t("db.edit.discard")}</button>
        <button
          type="button"
          class="rounded border px-2 py-0.5 {prod || conn?.readOnly ? 'border-danger/60 text-danger' : 'border-accent/60 text-accent'} disabled:opacity-40"
          disabled={!conn || !!d?.running || !!d?.edit.applying}
          onclick={() => (applying = true)}
          data-testid="db-table-apply-edits">{t("db.edit.apply")}</button
        >
      {/if}
    </div>
  {/if}
</div>

<ConfirmDialog
  open={discarding !== null}
  title={t("db.edit.dropTitle", { n: pending })}
  confirmLabel={t("db.table.dropRead")}
  danger
  onconfirm={() => answerDiscard(true)}
  oncancel={() => answerDiscard(false)}
>
  <p class="text-xs text-muted">{t("db.edit.dropBody")}</p>
</ConfirmDialog>

<ConfirmDialog
  open={applying}
  title={t("db.edit.confirmTitle", { n: pendingStatements(doc.id).length })}
  confirmLabel={t("db.edit.apply")}
  danger={prod || !!conn?.readOnly}
  onconfirm={() => {
    applying = false;
    void applyDbEdits(doc.id, !!conn?.readOnly);
  }}
  oncancel={() => (applying = false)}
>
  <pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-panel-alt p-2 font-mono text-meta text-text">{pendingStatements(doc.id).join(";\n")};</pre>
  <p class="mt-2 text-xs text-muted">{t("db.edit.confirmBody")}</p>
  {#if prod}<p class="mt-2 text-xs text-danger">{t("db.ask.prod", { server: serverName })}</p>{/if}
</ConfirmDialog>
