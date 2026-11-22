<script lang="ts">
  // The Databases panel (ADR 0080): the databases of this computer and of the
  // servers of the catalog, each with its schema once a console of it is open.
  // Not a panel of a session — it works with no tab open, like the server tree;
  // opening a console or the activity opens (and connects) the place's tab.
  // Its questions (delete) and its form stand beside the panel's root, never
  // inside its container (`panelcontainer.guard`).
  import { tooltip } from "../actions/tooltip";
  import { isProdServer } from "../ai/aiexec";
  import { t } from "../i18n";
  import { untrack } from "svelte";
  import { catalogOf, dbAsk, loadLocalDbs, localDbs, openDocOf, profilesOf, saveDbProfiles, loadCatalog, tookDbAsk } from "../stores/db.svelte";
  import { notifyError } from "../stores/toasts.svelte";
  import { dbFailure, failureText } from "./dberror";
  import type { DbProfile, ServerProfile } from "../types";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import EmptyState from "../ui/EmptyState.svelte";
  import FilterField from "../ui/FilterField.svelte";
  import Icon from "../ui/Icon.svelte";
  import { firstRowsSql, schemasOf, type CatTable } from "./dbcatalog";
  import DbForm from "./DbForm.svelte";
  import { newProfile, profileAddress, profileTitle } from "./dbprofile";

  let {
    servers,
    connected,
    onOpen,
    onTerminal,
  }: {
    servers: ServerProfile[];
    /** Servers whose session is open now. */
    connected: ReadonlySet<string>;
    /** Open a database's console (with `sql` to start with) or its activity, in the place's tab. */
    onOpen: (place: string | null, db: DbProfile, view: "console" | "activity", sql?: string) => void;
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

  $effect(() => {
    void loadLocalDbs();
  });

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
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { icon: "code", label: t("db.panel.console"), onSelect: () => onOpen(place, db, "console") },
        { icon: "activity", label: t("db.panel.activity"), onSelect: () => onOpen(place, db, "activity") },
        { icon: "terminal", label: t("db.openClient"), onSelect: () => onTerminal(place, db) },
        { kind: "separator" },
        { icon: "pencil", label: t("db.panel.edit"), onSelect: () => (form = { place, profile: { ...db }, editing: true }) },
        { icon: "trash", label: t("db.panel.delete"), danger: true, onSelect: () => (deleting = { place, db }) },
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
  const rows = (n: number | null) => (n === null ? "" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n));
</script>

{#snippet schema(place: string | null, db: DbProfile)}
  {@const docId = openDocOf(place, db.id)}
  {@const cat = catalogOf(place, db.id)}
  {#if !docId && !cat?.catalog}
    <div class="flex items-center gap-2 py-1 pl-8 pr-2 text-meta text-muted">
      <span class="min-w-0 flex-1">{t("db.panel.schemaNeedsConsole")}</span>
      <button type="button" class="shrink-0 text-accent hover:underline" onclick={() => onOpen(place, db, "console")}>{t("db.panel.console")}</button>
    </div>
  {:else if cat?.loading && !cat.catalog}
    <div class="flex items-center gap-2 py-1 pl-8 text-meta text-muted"><Icon name="loader" size={12} class="animate-spin" />{t("db.panel.reading")}</div>
  {:else if cat?.error && !cat.catalog}
    <div class="py-1 pl-8 pr-2 text-meta text-bad">{cat.error}</div>
  {:else if cat?.catalog}
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
          <button
            type="button"
            class="flex w-full items-center gap-1.5 py-0.5 pl-12 pr-2 text-left text-xs hover:bg-edge/40"
            ondblclick={() => onOpen(place, db, "console", firstRowsSql(db.kind, tb))}
            use:tooltip={t("db.panel.firstRows")}
            data-testid="db-table-row"
          >
            <Icon name={tableIcon(tb)} size={12} class="text-muted" />
            <span class="min-w-0 flex-1 truncate text-text">{tb.name}</span>
            <span class="text-caption text-muted">{rows(tb.rows)}</span>
          </button>
        {/each}
        {#each routines.slice(0, most) as r, i (i)}
          <div class="flex items-center gap-1.5 py-0.5 pl-12 pr-2 text-xs">
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
              {#if live}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" use:tooltip={t("db.panel.open")}></span>{/if}
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
