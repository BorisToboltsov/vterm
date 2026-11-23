<script lang="ts">
  // The Databases panel (ADR 0080, 0081): the databases of this computer and of
  // the servers of the catalog, each with its schema — read by itself on the
  // database's browse connection once a tab of its place is connected, never
  // by opening one. Not a panel of a session — it works with no tab open, like
  // the server tree; opening a console, the activity or a table opens (and
  // connects) the place's tab. Its questions, its form and the password stand
  // beside the panel's root, never inside its container (`panelcontainer.guard`).
  import { tooltip } from "../actions/tooltip";
  import { isProdServer } from "../ai/aiexec";
  import { t } from "../i18n";
  import { untrack } from "svelte";
  import { writeClipboard } from "../app/clipboard";
  import {
    browseDoc,
    browseId,
    browseWork,
    catalogOf,
    closeBrowse,
    connectDb,
    countRows,
    dbAsk,
    exactCount,
    loadLocalDbs,
    localDbs,
    openBrowse,
    openDocOf,
    profilesOf,
    saveDbProfiles,
    loadCatalog,
    tookDbAsk,
  } from "../stores/db.svelte";
  import { notifyError } from "../stores/toasts.svelte";
  import { dbFailure } from "./dberror";
  import type { DbProfile, ServerProfile } from "../types";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import EmptyState from "../ui/EmptyState.svelte";
  import FilterField from "../ui/FilterField.svelte";
  import Icon from "../ui/Icon.svelte";
  import Modal from "../ui/Modal.svelte";
  import { firstRowsSql, schemasOf, type CatTable, type Catalog } from "./dbcatalog";
  import { failureText } from "./dberror";
  import DbForm from "./DbForm.svelte";
  import DbStatus from "./DbStatus.svelte";
  import { newProfile, profileAddress, profileTitle } from "./dbprofile";
  import { fkOfColumn, keysOf, rowsText, type TableRef } from "./dbtable";

  let {
    servers,
    connected,
    sessionFor,
    onConnect,
    onOpen,
    onTable,
    onConsoleSql,
    onTerminal,
  }: {
    servers: ServerProfile[];
    /** Servers whose session is open now. */
    connected: ReadonlySet<string>;
    /** The connected tab of a place whose session reads the database's schema; null — none is connected. */
    sessionFor: (place: string | null, dbId: string) => string | null;
    /** Connect a place's tab (opening one when there is none). */
    onConnect: (place: string | null) => void;
    /** Open a database's console or its activity, in the place's tab. */
    onOpen: (place: string | null, db: DbProfile, view: "console" | "activity") => void;
    /** Open a table of a database, on one of its views. */
    onTable: (place: string | null, db: DbProfile, table: TableRef, tab: "data" | "structure") => void;
    /** Put a statement into the database's console. */
    onConsoleSql: (place: string | null, db: DbProfile, sql: string) => void;
    /** The user's own client for it, typed into the place's terminal. */
    onTerminal: (place: string | null, db: DbProfile) => void;
  } = $props();

  /** The rows of a schema drawn before "more": a schema may hold thousands. */
  const STEP = 500;
  let filter = $state("");
  let drawn = $state<Record<string, number>>({});
  let open = $state<Record<string, boolean>>({});
  let menu = $state<OpenMenu | null>(null);
  let form = $state<{ place: string | null; profile: DbProfile; editing: boolean } | null>(null);
  let deleting = $state<{ place: string | null; db: DbProfile } | null>(null);
  let disconnecting = $state<{ sessionId: string; db: DbProfile } | null>(null);
  let password = $state<{ browse: string; db: DbProfile } | null>(null);
  let counting = $state<Record<string, boolean>>({});

  $effect(() => {
    void loadLocalDbs();
  });

  // An open database reads its schema by itself once its place has a connected
  // tab — once: a connection disconnected or failed opens again only when asked.
  $effect(() => {
    for (const pl of places) {
      for (const db of pl.dbs) {
        if (!open[key(pl.place, db.id)]) continue;
        const sid = sessionFor(pl.place, db.id);
        if (sid) untrack(() => browseDoc(sid, db.id) ?? openBrowse(sid, pl.place, db.id, db.kind));
      }
    }
  });

  // The password was taken: its window goes.
  $effect(() => {
    const p = password;
    if (p && browseDoc(...splitBrowse(p.browse))?.status === "ready") untrack(() => (password = null));
  });

  /** A browse connection's id back to its tab and database. */
  function splitBrowse(id: string): [string, string] {
    const rest = id.slice("browse:".length);
    const at = rest.lastIndexOf(":");
    return [rest.slice(0, at), rest.slice(at + 1)];
  }

  // A new connection asked for from outside the panel (⌘K, a container of the Docker panel).
  $effect(() => {
    if (dbAsk.seq === 0) return;
    const place = dbAsk.place;
    const start = dbAsk.profile;
    untrack(() => {
      tookDbAsk();
      form = { place, profile: start ? { ...start } : newProfile("postgres", crypto.randomUUID()), editing: false };
    });
  });

  const key = (place: string | null, id: string) => `${place ?? "local"}/${id}`;
  const matches = (db: DbProfile) => {
    const q = filter.trim().toLowerCase();
    return !q || [db.name, db.database, db.host, db.user].some((v) => v.toLowerCase().includes(q));
  };

  /** The places with databases, this computer first, servers by name. */
  const places = $derived.by(() => {
    const out: { place: string | null; label: string; prod: boolean; reachable: boolean; dbs: DbProfile[] }[] = [];
    const here = localDbs().filter(matches);
    if (here.length) out.push({ place: null, label: t("db.here"), prod: false, reachable: true, dbs: here });
    for (const s of [...servers].sort((a, b) => a.alias.localeCompare(b.alias))) {
      const dbs = s.databases.filter(matches);
      if (dbs.length) out.push({ place: s.id, label: s.alias, prod: isProdServer(s), reachable: connected.has(s.id), dbs });
    }
    return out;
  });
  const total = $derived(localDbs().length + servers.reduce((n, s) => n + s.databases.length, 0));

  function add(place: string | null) {
    form = { place, profile: newProfile("postgres", crypto.randomUUID()), editing: false };
  }

  function addMenu(e: MouseEvent) {
    const items: MenuItem[] = [
      { icon: "osUnknown", label: t("db.here"), onSelect: () => add(null) },
      { kind: "separator" },
      ...[...servers].sort((a, b) => a.alias.localeCompare(b.alias)).map((s) => ({ icon: "server" as const, label: s.alias, onSelect: () => add(s.id) })),
    ];
    menu = { x: e.clientX, y: e.clientY, items };
  }

  function dbMenu(e: MouseEvent, place: string | null, db: DbProfile) {
    e.preventDefault();
    const sid = sessionFor(place, db.id);
    const browsing = sid ? browseDoc(sid, db.id) : null;
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { icon: "code", label: t("db.panel.console"), onSelect: () => onOpen(place, db, "console") },
        { icon: "activity", label: t("db.panel.activity"), onSelect: () => onOpen(place, db, "activity") },
        { icon: "terminal", label: t("db.openClient"), onSelect: () => onTerminal(place, db) },
        ...(sid && browsing
          ? [{ icon: "plug" as const, label: t("db.panel.disconnect"), onSelect: () => disconnectBrowse(sid, db) }]
          : []),
        { kind: "separator" },
        { icon: "pencil", label: t("db.panel.edit"), onSelect: () => (form = { place, profile: { ...db }, editing: true }) },
        { icon: "trash", label: t("db.panel.delete"), danger: true, onSelect: () => (deleting = { place, db }) },
      ],
    };
  }

  /** "Disconnect": asked first when a table of it holds work. */
  function disconnectBrowse(sessionId: string, db: DbProfile) {
    if (browseWork(sessionId, db.id)) disconnecting = { sessionId, db };
    else closeBrowse(sessionId, db.id);
  }

  function tableMenu(e: MouseEvent, place: string | null, db: DbProfile, tb: CatTable) {
    e.preventDefault();
    const ref = { schema: tb.schema, name: tb.name };
    const sid = sessionFor(place, db.id);
    const k = `${key(place, db.id)}#${tb.schema}.${tb.name}`;
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { icon: "table", label: t("db.panel.openData"), hint: t("db.panel.openDataHint"), onSelect: () => onTable(place, db, ref, "data") },
        { icon: "listCheck", label: t("db.panel.structure"), onSelect: () => onTable(place, db, ref, "structure") },
        { icon: "code", label: t("db.panel.toConsole"), onSelect: () => onConsoleSql(place, db, `${firstRowsSql(db.kind, ref)};`) },
        {
          icon: "hash",
          label: t("db.panel.countRows"),
          disabled: !sid || !browseDoc(sid, db.id)?.conn || counting[k],
          onSelect: () => {
            if (!sid) return;
            counting[k] = true;
            void countRows(browseId(sid, db.id), ref).finally(() => (counting[k] = false));
          },
        },
        { kind: "separator" },
        { icon: "copy", label: t("db.panel.copyName"), onSelect: () => void writeClipboard(`${tb.schema}.${tb.name}`) },
      ],
    };
  }

  async function remove() {
    const d = deleting;
    deleting = null;
    if (!d) return;
    try {
      await saveDbProfiles(
        d.place,
        profilesOf(d.place, servers).filter((x) => x.id !== d.db.id),
      );
    } catch (e) {
      notifyError(t("db.form.saveFailed", { error: failureText(dbFailure(e)) }), { source: "db" });
    }
  }

  const tableIcon = (tb: CatTable) => (tb.kind === "view" || tb.kind === "matview" ? "eye" : "table");
</script>

{#snippet columns(c: Catalog, tb: CatTable)}
  {@const keys = keysOf(c, { schema: tb.schema, name: tb.name })}
  {#each c.columns[`${tb.schema}.${tb.name}`] ?? [] as col (col.name)}
    {@const fk = fkOfColumn(keys, col.name)}
    <div class="flex items-center gap-1.5 py-0.5 pl-[4.5rem] pr-2 text-xs" data-testid="db-column-row">
      {#if keys.primary.includes(col.name)}
        <Icon name="key" size={11} class="shrink-0 text-warn" />
      {:else if fk}
        <Icon name="arrowRight" size={11} class="shrink-0 text-accent" />
      {:else}
        <Icon name="circle" size={6} class="mx-[2.5px] shrink-0 text-muted" />
      {/if}
      <span class="min-w-0 truncate text-text">{col.name}</span>
      <span class="ml-auto min-w-0 truncate text-caption text-muted">{col.type.toLowerCase()}{fk ? ` → ${fk.ref.name}` : ""}{col.nullable ? " · null" : ""}</span>
    </div>
  {/each}
{/snippet}

{#snippet schema(place: string | null, db: DbProfile)}
  {@const sid = sessionFor(place, db.id)}
  {@const browse = sid ? browseDoc(sid, db.id) : null}
  {@const docId = openDocOf(place, db.id)}
  {@const cat = catalogOf(place, db.id)}
  {#if !cat?.catalog}
    {#if !sid}
      <div class="flex items-center gap-2 py-1 pl-8 pr-2 text-meta text-muted" data-testid="db-place-off">
        <Icon name="plug" size={12} class="shrink-0" />
        <span class="min-w-0 flex-1">{place === null ? t("db.panel.localOff") : t("db.panel.serverOff")}</span>
        <button type="button" class="shrink-0 text-accent hover:underline" onclick={() => onConnect(place)}>{place === null ? t("db.panel.openLocal") : t("db.panel.connectPlace")}</button>
      </div>
    {:else if browse?.status === "password"}
      <div class="flex items-center gap-2 py-1 pl-8 pr-2 text-meta text-muted" data-testid="db-needs-password">
        <Icon name="lock" size={12} class="shrink-0 text-warn" />
        <span class="min-w-0 flex-1">{t("db.panel.needsPassword")}</span>
        <button type="button" class="shrink-0 text-accent hover:underline" onclick={() => (password = { browse: browseId(sid, db.id), db })}>{t("db.panel.enterPassword")}</button>
      </div>
    {:else if browse && (browse.status === "failed" || browse.status === "closed")}
      <div class="flex items-center gap-2 py-1 pl-8 pr-2 text-meta" data-testid="db-browse-failed">
        <span class="min-w-0 flex-1 {browse.status === 'closed' ? 'text-warn' : 'text-bad'}">{browse.failure ? failureText(browse.failure) : t("db.err.closed")}</span>
        <button type="button" class="shrink-0 text-accent hover:underline" onclick={() => void connectDb(browseId(sid, db.id))}>{t("db.panel.retry")}</button>
      </div>
    {:else if cat?.error}
      <div class="py-1 pl-8 pr-2 text-meta text-bad">{cat.error}</div>
    {:else}
      <div class="flex items-center gap-2 py-1 pl-8 text-meta text-muted">
        <Icon name="loader" size={12} class="animate-spin" />{browse?.conn ? t("db.panel.reading") : t("db.panel.connecting")}
      </div>
    {/if}
  {:else}
    {@const c = cat.catalog}
    {#each schemasOf(c) as sch (sch)}
      {@const k = `${key(place, db.id)}#${sch}`}
      {@const tables = c.tables.filter((x) => x.schema === sch)}
      {@const most = drawn[k] ?? STEP}
      {@const routines = c.routines.filter((x) => x.schema === sch)}
      <button type="button" class="flex w-full items-center gap-1 py-0.5 pl-7 pr-2 text-left text-xs hover:bg-edge/40" onclick={() => (open[k] = !open[k])}>
        <Icon name={open[k] ? "chevronDown" : "chevronRight"} size={11} class="text-muted" />
        <Icon name="folder" size={12} class="text-muted" />
        <span class="min-w-0 flex-1 truncate text-text">{sch}</span>
        <span class="text-caption text-muted">{tables.length}</span>
      </button>
      {#if open[k]}
        {#each tables.slice(0, most) as tb (tb.name)}
          {@const tk = `${k}.${tb.name}`}
          {@const counted = exactCount(place, db.id, { schema: tb.schema, name: tb.name })}
          <div
            class="group flex w-full items-center gap-1 py-0.5 pl-10 pr-2 text-left text-xs hover:bg-edge/40"
            ondblclick={() => onTable(place, db, { schema: tb.schema, name: tb.name }, "data")}
            oncontextmenu={(e) => tableMenu(e, place, db, tb)}
            role="treeitem"
            aria-selected="false"
            aria-expanded={!!open[tk]}
            tabindex="-1"
            use:tooltip={t("db.panel.openDataTip")}
            data-testid="db-table-row"
          >
            <button type="button" class="rounded p-0.5 text-muted hover:text-text" aria-label={t("db.panel.toggleTable")} onclick={() => (open[tk] = !open[tk])} ondblclick={(e) => e.stopPropagation()}>
              <Icon name={open[tk] ? "chevronDown" : "chevronRight"} size={11} />
            </button>
            <Icon name={tableIcon(tb)} size={12} class="shrink-0 text-muted" />
            <span class="min-w-0 flex-1 truncate text-text">{tb.name}</span>
            {#if counting[`${key(place, db.id)}#${tb.schema}.${tb.name}`]}
              <Icon name="loader" size={11} class="animate-spin text-muted" />
            {:else if counted !== null}
              <span class="text-caption text-text" use:tooltip={t("db.panel.exact")}>{counted.toLocaleString()}</span>
            {:else}
              <span class="text-caption text-muted" use:tooltip={t("db.panel.estimate")}>{rowsText(tb.rows)}</span>
            {/if}
            <button
              type="button"
              class="invisible rounded p-0.5 text-muted hover:text-accent group-hover:visible"
              aria-label={t("db.panel.more")}
              onclick={(e) => tableMenu(e, place, db, tb)}
              ondblclick={(e) => e.stopPropagation()}
            >
              <Icon name="dots" size={12} />
            </button>
          </div>
          {#if open[tk]}{@render columns(c, tb)}{/if}
        {/each}
        {#each routines.slice(0, most) as r, i (i)}
          <div class="flex items-center gap-1.5 py-0.5 pl-14 pr-2 text-xs">
            <Icon name="braces" size={12} class="text-muted" />
            <span class="min-w-0 flex-1 truncate text-muted">{r.name}({r.args})</span>
          </div>
        {/each}
        {#if tables.length > most || routines.length > most}
          <button type="button" class="py-0.5 pl-12 text-meta text-accent hover:underline" onclick={() => (drawn[k] = most + STEP)}>
            {t("db.panel.showMore", { n: Math.max(tables.length, routines.length) - most })}
          </button>
        {/if}
      {/if}
    {/each}
    {#if c.cut}<p class="py-0.5 pl-8 pr-2 text-meta text-warn">{t("db.panel.catalogCut")}</p>{/if}
    {#if docId}
      <button type="button" class="py-0.5 pl-8 text-meta text-muted hover:text-text" onclick={() => void loadCatalog(place, db.id, docId)}>{t("db.panel.reread")}</button>
    {:else if sid && !browse}
      <button type="button" class="py-0.5 pl-8 text-meta text-muted hover:text-text" onclick={() => openBrowse(sid, place, db.id, db.kind)}>{t("db.panel.reread")}</button>
    {/if}
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col @container" data-testid="db-panel">
  <div class="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
    <FilterField bind:value={filter} placeholder={t("db.panel.filter")} class="min-w-0 flex-1" shown={null} total={null} />
    <button type="button" class="rounded p-1 text-muted hover:bg-edge hover:text-text" aria-label={t("db.panel.add")} use:tooltip={t("db.panel.add")} onclick={addMenu} data-testid="db-add">
      <Icon name="plus" size={13} />
    </button>
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if total === 0}
      <EmptyState icon="database" title={t("db.panel.emptyTitle")} hint={t("db.panel.emptyHint")}>
        <button type="button" class="mt-2 rounded border border-edge px-2.5 py-1 text-xs text-text hover:border-accent" onclick={addMenu}>{t("db.panel.add")}</button>
      </EmptyState>
    {:else}
      {#each places as pl (pl.place ?? "local")}
        <div class="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-caption uppercase tracking-wider text-muted">
          <Icon name={pl.place === null ? "osUnknown" : "server"} size={12} />
          <span class="min-w-0 truncate normal-case tracking-normal text-meta text-text">{pl.label}</span>
          {#if pl.prod}<span class="rounded border border-bad/50 px-1 text-bad">prod</span>{/if}
          {#if pl.place !== null}<span class="h-1.5 w-1.5 rounded-full {pl.reachable ? 'bg-ok' : 'bg-muted'}" use:tooltip={pl.reachable ? t("db.panel.connected") : t("db.panel.notConnected")}></span>{/if}
        </div>
        {#each pl.dbs as db (db.id)}
          {@const k = key(pl.place, db.id)}
          {@const live = openDocOf(pl.place, db.id) !== null}
          <div class="group flex items-center gap-1 px-2 py-0.5 text-xs hover:bg-edge/40" data-testid="db-row" oncontextmenu={(e) => dbMenu(e, pl.place, db)} role="treeitem" aria-selected="false" tabindex="-1">
            <button type="button" class="rounded p-0.5 text-muted hover:text-text" aria-label={t("db.panel.toggle")} onclick={() => (open[k] = !open[k])}>
              <Icon name={open[k] ? "chevronDown" : "chevronRight"} size={11} />
            </button>
            <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 text-left" ondblclick={() => onOpen(pl.place, db, "console")} onclick={() => (open[k] = !open[k])}>
              <Icon name={db.container ? "container" : "database"} size={13} class={db.kind === "postgres" ? "text-accent" : "text-warn"} />
              <span class="min-w-0 truncate text-text">{profileTitle(db)}</span>
              {#if pl.prod || db.readOnly}<span class="shrink-0 rounded border border-warn/40 px-1 text-caption text-warn">RO</span>{/if}
              {#if live}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" use:tooltip={t("db.panel.open")} data-testid="db-live"></span>{/if}
              <span class="hidden min-w-0 flex-1 basis-0 truncate text-right text-meta text-muted @[16rem]:inline">{profileAddress(db)}</span>
            </button>
            <button type="button" class="invisible rounded p-0.5 text-muted hover:text-accent group-hover:visible" aria-label={t("db.panel.console")} use:tooltip={t("db.panel.console")} onclick={() => onOpen(pl.place, db, "console")}>
              <Icon name="play" size={12} />
            </button>
            <button type="button" class="invisible rounded p-0.5 text-muted hover:text-accent group-hover:visible" aria-label={t("db.panel.more")} onclick={(e) => dbMenu(e, pl.place, db)}>
              <Icon name="dots" size={13} />
            </button>
          </div>
          {#if open[k]}{@render schema(pl.place, db)}{/if}
        {/each}
      {/each}
      {#if places.length === 0}<p class="px-3 py-2 text-meta text-muted">{t("db.panel.noMatch")}</p>{/if}
    {/if}
  </div>
</div>

<ContextMenu {menu} onclose={() => (menu = null)} />
<Modal open={password !== null} title={password ? t("db.panel.passwordTitle", { name: profileTitle(password.db) }) : ""} width="w-[28rem]" showClose onclose={() => (password = null)}>
  {#if password}<DbStatus docId={password.browse} profile={password.db} />{/if}
</Modal>
<ConfirmDialog
  open={disconnecting !== null}
  title={t("db.panel.disconnectTitle", { name: disconnecting ? profileTitle(disconnecting.db) : "" })}
  confirmLabel={t("db.panel.disconnect")}
  danger
  onconfirm={() => {
    const d = disconnecting;
    disconnecting = null;
    if (d) closeBrowse(d.sessionId, d.db.id);
  }}
  oncancel={() => (disconnecting = null)}
>
  <p class="text-xs text-muted">{t("db.panel.disconnectBody")}</p>
</ConfirmDialog>
<DbForm open={form !== null} {servers} initial={form} onclose={() => (form = null)} />
<ConfirmDialog
  open={deleting !== null}
  title={t("db.panel.deleteTitle", { name: deleting ? profileTitle(deleting.db) : "" })}
  confirmLabel={t("db.panel.delete")}
  onconfirm={() => void remove()}
  oncancel={() => (deleting = null)}
>
  <p class="text-xs text-muted">{t("db.panel.deleteBody")}</p>
</ConfirmDialog>
