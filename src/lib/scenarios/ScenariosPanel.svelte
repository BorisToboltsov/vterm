<script lang="ts">
  // The Scenarios panel (ADR 0071, 0072): the library — projects pinned from
  // the file panel or found in the folders the user added, the user's recipes
  // and playbooks («Mine», where the shipped ones are written once), the
  // folders they added — and the runs of recipes on servers of the catalog. Not
  // a panel of a session: it works with no tab open, like the server tree. An
  // item picked stands beside the list in a wide panel and in its place in a
  // narrow one; the questions (prod, delete) stand beside the panel's root,
  // never inside its container (`panelcontainer.guard`).
  import { untrack } from "svelte";
  import { wideWhen } from "../actions/panelwide.svelte";
  import { tooltip } from "../actions/tooltip";
  import { pickRecipeFiles, pickRecipeFolder, readLocalText } from "../api";
  import { isProdServer } from "../ai/aiexec";
  import { t } from "../i18n";
  import { settings } from "../settings/settings.svelte";
  import { hostEnv } from "../stores/hostenv.svelte";
  import {
    clearRecipeRuns,
    deleteRecipe,
    hostDone,
    library,
    libraryError,
    libraryLoading,
    loadLibrary,
    projectKindOf,
    recipeRuns,
    restoreShipped,
    saveRecipe,
    startRecipeRun,
    stopRecipeRun,
    type EnsureSession,
    type RecipeRunRecord,
    type RunHost,
  } from "../stores/scenarios.svelte";
  import { notifyError, notifyInfo, notifySuccess } from "../stores/toasts.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import FilterField from "../ui/FilterField.svelte";
  import GroupHeader from "../ui/GroupHeader.svelte";
  import Icon from "../ui/Icon.svelte";
  import Modal from "../ui/Modal.svelte";
  import type { OpenMenu } from "../ui/ctxmenu";
  import type { ServerProfile } from "../types";
  import { folderName, isPinned, sanitizeSources, togglePin, type ProjectBookmark } from "./bookmarks";
  import PlaybookDetail from "./PlaybookDetail.svelte";
  import { freeFileName, playbookFileName, playbookTemplate, recipeFileName, recipeTemplate } from "./recipe";
  import { itemMatches, itemName, type LibraryItem, type LibraryRecipe } from "./recipelib";
  import RecipeDetail, { type RunAsk } from "./RecipeDetail.svelte";
  import RunHosts from "./RunHosts.svelte";

  let {
    visible = true,
    servers,
    connected,
    ensureSession,
    onOpenProject,
    onEditRecipe,
    onRunPlaybook,
    onAsk,
    onNewProject,
  }: {
    visible?: boolean;
    servers: ServerProfile[];
    /** Servers whose session is open now. */
    connected: ReadonlySet<string>;
    /** The session a run uses on a server: an open one, or one the page opens. */
    ensureSession: EnsureSession;
    onOpenProject: (b: ProjectBookmark) => void;
    /** A recipe or playbook file of this computer in the editor. */
    onEditRecipe: (path: string) => void;
    /** A playbook of the library opened where it runs (a server's id, or null — this computer), its dialog open. */
    onRunPlaybook: (path: string, node: string | null, action: "check" | "run") => void;
    /** A failed server's answer to the assistant (its session). */
    onAsk?: (sessionId: string, context: string) => void;
    /** "New Ansible project" — in the folder the file panel shows. */
    onNewProject?: () => void;
  } = $props();

  // The library is read when the panel is first on screen, and on "refresh".
  let read = false;
  $effect(() => {
    if (!visible || read) return;
    read = true;
    untrack(() => {
      void hostEnv.resolve();
      void loadLibrary();
    });
  });

  let wide = $state(false);
  let query = $state("");
  type Pick = { kind: "item"; id: string } | { kind: "project"; key: string } | null;
  let pick = $state<Pick>(null);
  let collapsed = $state.raw<ReadonlySet<string>>(new Set());
  let menu = $state<OpenMenu | null>(null);

  const lib = $derived(library());
  const all = $derived([...lib.own, ...lib.sources]);
  const item = $derived.by(() => {
    const p = pick;
    return p?.kind === "item" ? (all.find((r) => r.id === p.id) ?? null) : null;
  });
  const keyOf = (b: ProjectBookmark) => `${b.serverId ?? "local"}:${b.root}`;

  /** A project of the group: pinned, or found in a folder the library reads (`source`). */
  type ProjectEntry = { b: ProjectBookmark; source: string | null };
  const projects = $derived.by<ProjectEntry[]>(() => {
    const pinned = settings.scenarioProjects.map((b) => ({ b, source: null }));
    const found = lib.projects
      .map((p) => ({ b: { kind: p.kind, root: p.root, serverId: null }, source: p.source }))
      .filter((f) => !isPinned(settings.scenarioProjects, f.b));
    return [...pinned, ...found];
  });
  const project = $derived.by(() => {
    const p = pick;
    return p?.kind === "project" ? (projects.find((e) => keyOf(e.b) === p.key) ?? null) : null;
  });
  const serverName = (id: string | null) => (id ? (servers.find((s) => s.id === id)?.alias ?? t("scenarios.project.goneServer")) : t("scenarios.project.thisComputer"));

  const matches = (r: LibraryItem) => itemMatches(r, query);
  const projectsShown = $derived(
    projects.filter((e) => !query.trim() || `${folderName(e.b.root)} ${e.b.root}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const groups = $derived.by(() => {
    const out: { key: string; label: string; icon: "script" | "folder"; items: LibraryItem[]; source?: string }[] = [];
    out.push({ key: "own", label: t("scenarios.group.own"), icon: "script", items: lib.own.filter(matches) });
    for (const dir of settings.scenarioSources) {
      out.push({ key: `src:${dir}`, label: folderName(dir), icon: "folder", items: lib.sources.filter((r) => r.dir === dir && matches(r)), source: dir });
    }
    return out;
  });
  const total = $derived(all.length + projects.length);
  const shownCount = $derived(projectsShown.length + groups.reduce((n, g) => n + g.items.length, 0));

  function toggleGroup(key: string) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed = next;
  }

  // ── Where a playbook runs ─────────────────────────────────────────────────
  /** The place picked last; a server since removed is this computer again. */
  const node = $derived(settings.playbookNode && servers.some((s) => s.id === settings.playbookNode) ? settings.playbookNode : null);

  // ── Runs ──────────────────────────────────────────────────────────────────
  const runs = $derived(recipeRuns());
  const running = $derived(runs.filter((r) => r.endedAt === null).length);
  let asking = $state<{ recipe: LibraryRecipe; ask: RunAsk; prod: string[] } | null>(null);

  function requestRun(r: LibraryRecipe, ask: RunAsk) {
    const prod = servers.filter((s) => ask.serverIds.includes(s.id) && isProdServer(s)).map((s) => s.alias);
    if (ask.mode === "apply" && prod.length) {
      asking = { recipe: r, ask, prod };
      return;
    }
    void run(r, ask);
  }

  async function run(r: LibraryRecipe, ask: RunAsk) {
    const picked = servers.filter((s) => ask.serverIds.includes(s.id)).map((server) => ({ server, prod: isProdServer(server) }));
    await startRecipeRun(
      { recipe: r, name: itemName(r), values: ask.values, servers: picked, mode: ask.mode, elevation: ask.elevation, password: ask.password },
      ensureSession,
    );
  }

  function askAi(run: RecipeRunRecord, h: RunHost) {
    if (!onAsk || !h.sessionId) return;
    onAsk(
      h.sessionId,
      [
        `Recipe: ${run.name} (${run.mode === "check" ? "check: what would change" : "apply"})`,
        `Server: ${h.alias}`,
        h.exit !== null ? `Exit code: ${h.exit}` : null,
        h.output ? `Output (last part):\n${h.output.slice(-4000)}` : h.summary ? `Error: ${h.summary}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // ── The library's files ───────────────────────────────────────────────────
  let creating = $state<"recipe" | "playbook" | null>(null);
  let newName = $state("");
  let newProblem = $state("");
  let deleting = $state<LibraryItem | null>(null);

  function startCreating(kind: "recipe" | "playbook") {
    newName = "";
    newProblem = "";
    creating = kind;
  }

  async function createItem() {
    const name = newName.trim();
    if (!name) {
      newProblem = t("scenarios.new.nameRequired");
      return;
    }
    const playbook = creating === "playbook";
    const file = freeFileName(
      playbook ? playbookFileName(name) : recipeFileName(name),
      lib.own.map((r) => r.file),
    );
    const text = playbook ? playbookTemplate(name, t("scenarios.new.description")) : recipeTemplate(name, t("scenarios.new.description"));
    try {
      const path = await saveRecipe(file, text);
      creating = null;
      pick = { kind: "item", id: path };
      onEditRecipe(path);
    } catch (e) {
      newProblem = String(e);
    }
  }

  async function copyToMine(r: LibraryItem) {
    const file = freeFileName(r.file, lib.own.map((x) => x.file));
    try {
      const path = await saveRecipe(file, r.text);
      pick = { kind: "item", id: path };
      notifySuccess(t("scenarios.recipe.copied", { file }), { source: "scenarios" });
    } catch (e) {
      notifyError(t("scenarios.recipe.copyFailed", { error: String(e) }), { source: "scenarios" });
    }
  }

  async function confirmDelete() {
    const r = deleting;
    deleting = null;
    if (!r) return;
    try {
      await deleteRecipe(r.id);
      if (pick?.kind === "item" && pick.id === r.id) pick = null;
    } catch (e) {
      notifyError(t("scenarios.recipe.deleteFailed", { error: String(e) }), { source: "scenarios" });
    }
  }

  async function addSource() {
    const dir = await pickRecipeFolder(t("scenarios.sources.pick"));
    if (!dir) return;
    settings.scenarioSources = sanitizeSources([...settings.scenarioSources, dir]);
    await loadLibrary();
  }

  function removeSource(dir: string) {
    settings.scenarioSources = settings.scenarioSources.filter((d) => d !== dir);
    void loadLibrary();
  }

  async function importFiles() {
    const paths = await pickRecipeFiles(t("scenarios.import.pick"));
    let done = 0;
    const taken = lib.own.map((r) => r.file);
    for (const p of paths) {
      try {
        const file = await readLocalText(p, 64 * 1024);
        const name = freeFileName(p.split(/[\\/]/).pop() ?? "recipe.sh", taken);
        taken.push(name);
        await saveRecipe(name, file.content);
        done++;
      } catch (e) {
        notifyError(t("scenarios.import.failed", { file: p, error: String(e) }), { source: "scenarios" });
      }
    }
    if (done) notifySuccess(t("scenarios.import.done", { count: done }), { source: "scenarios" });
  }

  /** "Add a project folder…": a folder of this computer, pinned when it is a project. */
  async function addProject() {
    const dir = await pickRecipeFolder(t("scenarios.addProject.pick"));
    if (!dir) return;
    try {
      const kind = await projectKindOf(dir);
      if (!kind) {
        notifyError(t("scenarios.addProject.notProject", { dir }), { source: "scenarios" });
        return;
      }
      const b: ProjectBookmark = { kind, root: dir, serverId: null };
      if (!isPinned(settings.scenarioProjects, b)) settings.scenarioProjects = togglePin(settings.scenarioProjects, b);
      pick = { kind: "project", key: keyOf(b) };
      notifySuccess(t("scenarios.addProject.added", { name: folderName(dir) }), { source: "scenarios" });
    } catch (e) {
      notifyError(t("scenarios.addProject.failed", { error: String(e) }), { source: "scenarios" });
    }
  }

  async function restore() {
    try {
      const count = await restoreShipped();
      if (count) notifySuccess(t("scenarios.restore.done", { count }), { source: "scenarios" });
      else notifyInfo(t("scenarios.restore.none"), { source: "scenarios" });
    } catch (e) {
      notifyError(t("scenarios.restore.failed", { error: String(e) }), { source: "scenarios" });
    }
  }

  function addMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = {
      x: r.left,
      y: r.bottom + 2,
      items: [
        { icon: "filePlus", label: t("scenarios.menu.newRecipe"), onSelect: () => startCreating("recipe") },
        { icon: "gearPlay", label: t("scenarios.menu.newPlaybook"), onSelect: () => startCreating("playbook") },
        { icon: "upload", label: t("scenarios.menu.import"), onSelect: () => void importFiles() },
        { icon: "folderPlus", label: t("scenarios.menu.addSource"), onSelect: () => void addSource() },
        { kind: "separator" as const },
        { icon: "pin", label: t("scenarios.menu.addProject"), onSelect: () => void addProject() },
        ...(onNewProject ? [{ icon: "gearPlay" as const, label: t("scenarios.menu.newProject"), onSelect: () => onNewProject?.() }] : []),
        { kind: "separator" as const },
        { icon: "listCheck", label: t("scenarios.menu.restore"), onSelect: () => void restore() },
      ],
    };
  }

  function setTab(next: "library" | "runs") {
    settings.scenarioTab = next;
  }
</script>

{#snippet itemRow(r: LibraryItem)}
  {@const name = itemName(r)}
  <button
    type="button"
    class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs hover:bg-edge/40 {pick?.kind === 'item' && pick.id === r.id ? 'bg-accent/10' : ''}"
    data-testid={r.kind === "playbook" ? "playbook-row" : "recipe-row"}
    onclick={() => (pick = { kind: "item", id: r.id })}
  >
    {#if r.kind === "playbook"}
      <Icon name="gearPlay" size={13} class="text-warn" />
    {:else}
      <Icon name="script" size={13} class={r.meta ? "text-muted" : "text-warn"} />
    {/if}
    <span class="min-w-0 flex-1 truncate text-text {name === r.file ? 'font-mono' : ''}">{name}</span>
    {#if r.kind === "recipe" && !r.meta}
      <span class="text-caption text-warn" use:tooltip={r.error ?? ""}>{t("scenarios.recipe.noHeaderShort")}</span>
    {:else if r.kind === "playbook" && !r.book}
      <span class="text-caption text-warn" use:tooltip={r.error ?? ""}>{t("scenarios.playbook.unreadableShort")}</span>
    {:else if name !== r.file}
      <span class="max-w-[45%] shrink-0 truncate font-mono text-caption text-muted">{r.file}</span>
    {/if}
  </button>
{/snippet}

{#snippet projectCard(entry: ProjectEntry)}
  {@const b = entry.b}
  <div class="space-y-2 p-3" data-testid="project-card">
    <div class="flex items-center gap-2">
      {#if !wide}
        <button type="button" class="rounded p-0.5 text-muted hover:bg-edge hover:text-text" aria-label={t("scenarios.back")} onclick={() => (pick = null)}>
          <Icon name="chevronLeft" size={14} />
        </button>
      {/if}
      <Icon name={b.kind === "ansible" ? "gearPlay" : "cube"} size={15} class={b.kind === "ansible" ? "text-warn" : "text-accent"} />
      <span class="font-mono text-sm text-text">{folderName(b.root)}</span>
      <span class="rounded bg-edge px-1.5 text-caption text-muted">{b.kind === "ansible" ? "Ansible" : "Terraform"}</span>
    </div>
    <p class="break-all font-mono text-meta text-muted">{serverName(b.serverId)}:{b.root}</p>
    {#if entry.source}<p class="text-meta text-muted">{t("scenarios.project.foundHint")}</p>{/if}
    <p class="text-meta text-muted">{t("scenarios.project.openHint")}</p>
    <div class="flex gap-2">
      <button type="button" class="flex items-center gap-1 rounded border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs text-accent" onclick={() => onOpenProject(b)}>
        <Icon name="arrowRight" size={12} />{t("scenarios.project.open")}
      </button>
      <button
        type="button"
        class="rounded border border-edge px-2.5 py-1 text-xs text-text hover:border-accent"
        onclick={() => {
          const found = entry.source !== null;
          settings.scenarioProjects = togglePin(settings.scenarioProjects, b);
          if (!found) pick = null;
        }}>{entry.source ? t("scenarios.project.pin") : t("scenarios.project.unpin")}</button
      >
    </div>
  </div>
{/snippet}

{#snippet detail()}
  {#if item?.kind === "recipe"}
    {@const recipe = item}
    <RecipeDetail
      {recipe}
      {servers}
      {connected}
      onrun={(ask) => requestRun(recipe, ask)}
      oncopy={recipe.origin === "source" ? () => void copyToMine(recipe) : undefined}
      onedit={() => onEditRecipe(recipe.id)}
      ondelete={recipe.origin === "own" ? () => (deleting = recipe) : undefined}
      onback={wide ? undefined : () => (pick = null)}
      onask={onAsk ? askAi : undefined}
    />
  {:else if item?.kind === "playbook"}
    {@const playbook = item}
    <PlaybookDetail
      {playbook}
      {servers}
      {node}
      windows={hostEnv.isWindows}
      onnode={(n) => (settings.playbookNode = n)}
      onrun={(action) => onRunPlaybook(playbook.id, node, action)}
      oncopy={playbook.origin === "source" ? () => void copyToMine(playbook) : undefined}
      onedit={() => onEditRecipe(playbook.id)}
      ondelete={playbook.origin === "own" ? () => (deleting = playbook) : undefined}
      onback={wide ? undefined : () => (pick = null)}
    />
  {:else if project}
    {@render projectCard(project)}
  {:else}
    <EmptyState icon="listCheck" title={t("scenarios.pick")} hint={t("scenarios.pickHint")} />
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col @container" use:wideWhen={(w) => (wide = w)} data-testid="scenarios-panel">
  <div class="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1" role="tablist">
    <button
      type="button"
      role="tab"
      aria-selected={settings.scenarioTab === "library"}
      class="rounded px-2 py-0.5 text-xs {settings.scenarioTab === 'library' ? 'bg-edge text-text' : 'text-muted hover:text-text'}"
      onclick={() => setTab("library")}>{t("scenarios.tab.library")}</button
    >
    <button
      type="button"
      role="tab"
      aria-selected={settings.scenarioTab === "runs"}
      class="flex items-center gap-1 rounded px-2 py-0.5 text-xs {settings.scenarioTab === 'runs' ? 'bg-edge text-text' : 'text-muted hover:text-text'}"
      data-testid="scenarios-runs-tab"
      onclick={() => setTab("runs")}
    >
      {t("scenarios.tab.runs")}
      {#if runs.length}<span class="rounded bg-panel-alt px-1 text-caption {running ? 'text-accent' : 'text-muted'}">{running || runs.length}</span>{/if}
    </button>
    <span class="ml-auto flex items-center gap-0.5">
      <button type="button" class="rounded p-1 text-muted hover:bg-edge hover:text-text" aria-label={t("scenarios.menu.add")} use:tooltip={t("scenarios.menu.add")} onclick={addMenu} data-testid="scenarios-add">
        <Icon name="plus" size={13} />
      </button>
      <button type="button" class="rounded p-1 text-muted hover:bg-edge hover:text-text" aria-label={t("scenarios.refresh")} use:tooltip={t("scenarios.refresh")} onclick={() => void loadLibrary()}>
        <Icon name="refresh" size={13} class={libraryLoading() ? "animate-spin" : ""} />
      </button>
    </span>
  </div>

  {#if settings.scenarioTab === "runs"}
    <div class="min-h-0 flex-1 overflow-y-auto" data-testid="scenarios-runs">
      {#if runs.length === 0}
        <EmptyState icon="listCheck" title={t("scenarios.runs.none")} hint={t("scenarios.runs.noneHint")} />
      {:else}
        <div class="flex justify-end px-2 pt-1">
          <button type="button" class="rounded px-1.5 text-meta text-muted hover:bg-edge hover:text-text" onclick={clearRecipeRuns}>{t("scenarios.runs.clear")}</button>
        </div>
        {#each runs as r (r.id)}
          {@const done = r.hosts.filter((h) => hostDone(h.state)).length}
          <section class="border-b border-edge px-2.5 py-1.5">
            <div class="flex items-center gap-2 text-xs">
              <span class="font-medium text-text">{r.name}</span>
              <span class="rounded px-1 text-caption {r.mode === 'check' ? 'bg-accent/15 text-accent' : 'bg-warn/15 text-warn'}">
                {r.mode === "check" ? t("scenarios.runs.check") : t("scenarios.runs.apply")}
              </span>
              <span class="text-meta text-muted">{new Date(r.startedAt).toLocaleTimeString()} · {done}/{r.hosts.length}</span>
              {#if r.endedAt === null}
                <button type="button" class="ml-auto rounded border border-edge px-1.5 text-meta text-text hover:border-danger hover:text-danger" disabled={r.stopping} onclick={() => stopRecipeRun(r.id)}>
                  {r.stopping ? t("scenarios.runs.stopping") : t("scenarios.runs.stop")}
                </button>
              {/if}
            </div>
            <RunHosts run={r} onask={onAsk ? (h) => askAi(r, h) : undefined} />
          </section>
        {/each}
      {/if}
    </div>
  {:else if !wide && pick && (item || project)}
    {@render detail()}
  {:else}
    <div class="flex min-h-0 flex-1">
      <div class="flex min-h-0 min-w-0 flex-col {wide ? 'w-[40%] max-w-sm border-r border-edge' : 'flex-1'}">
        <div class="shrink-0 px-2 py-1">
          <FilterField bind:value={query} placeholder={t("scenarios.filter")} shown={query ? shownCount : null} total={query ? total : null} testid="scenarios-filter" />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          {#if libraryError()}
            <p class="px-2.5 py-1 text-meta text-danger">{t("scenarios.libraryFailed", { error: libraryError() ?? "" })}</p>
          {/if}
          {#each lib.scan?.unreadable ?? [] as dir (dir)}
            <p class="px-2.5 py-0.5 text-meta text-warn">{t("scenarios.sources.unreadable", { dir })}</p>
          {/each}
          {#if projectsShown.length || !query}
            <GroupHeader label={t("scenarios.group.projects")} count={projectsShown.length} collapsed={collapsed.has("projects")} icon="gearPlay" ontoggle={() => toggleGroup("projects")} />
            {#if !collapsed.has("projects")}
              {#if projects.length === 0}
                <p class="px-2.5 py-1 text-meta text-muted" data-testid="projects-empty">{t("scenarios.group.projectsEmpty")}</p>
              {/if}
              {#each projectsShown as e (keyOf(e.b))}
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs hover:bg-edge/40 {pick?.kind === 'project' && pick.key === keyOf(e.b) ? 'bg-accent/10' : ''}"
                  data-testid="project-row"
                  onclick={() => (pick = { kind: "project", key: keyOf(e.b) })}
                  ondblclick={() => onOpenProject(e.b)}
                >
                  <Icon name={e.b.kind === "ansible" ? "gearPlay" : "cube"} size={13} class={e.b.kind === "ansible" ? "text-warn" : "text-accent"} />
                  <span class="min-w-0 flex-1 truncate font-mono text-text">{folderName(e.b.root)}</span>
                  <span class="truncate text-meta text-muted">{e.source ? t("scenarios.project.foundIn", { dir: folderName(e.source) }) : serverName(e.b.serverId)}</span>
                </button>
              {/each}
            {/if}
          {/if}
          {#each groups as g (g.key)}
            {#if g.items.length || g.source || (g.key === "own" && !query)}
              <GroupHeader label={g.label} count={g.items.length} collapsed={collapsed.has(g.key)} icon={g.icon} hint={g.source} ontoggle={() => toggleGroup(g.key)}>
                {#snippet actions()}
                  {#if g.source}
                    <button
                      type="button"
                      class="rounded p-0.5 text-muted hover:text-danger"
                      aria-label={t("scenarios.sources.remove")}
                      use:tooltip={t("scenarios.sources.remove")}
                      onclick={(e) => {
                        e.stopPropagation();
                        if (g.source) removeSource(g.source);
                      }}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  {/if}
                {/snippet}
              </GroupHeader>
              {#if !collapsed.has(g.key)}
                {#if g.key === "own" && g.items.length === 0}
                  <p class="px-2.5 py-1 text-meta text-muted">{t("scenarios.group.ownEmpty")}</p>
                {/if}
                {#each g.items as r (r.id)}{@render itemRow(r)}{/each}
              {/if}
            {/if}
          {/each}
          {#if lib.notPlaybooks}
            <p class="px-2.5 py-1 text-caption text-muted">{t("scenarios.notPlaybooks", { count: lib.notPlaybooks })}</p>
          {/if}
        </div>
      </div>
      {#if wide}
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">{@render detail()}</div>
      {/if}
    </div>
  {/if}
</div>

<ContextMenu {menu} onclose={() => (menu = null)} />

<ConfirmDialog
  open={asking !== null}
  title={asking ? t("scenarios.confirm.prodTitle", { recipe: itemName(asking.recipe) }) : ""}
  confirmLabel={t("scenarios.confirm.run")}
  danger
  onconfirm={() => {
    const a = asking;
    asking = null;
    if (a) void run(a.recipe, a.ask);
  }}
  oncancel={() => (asking = null)}
>
  {#if asking}
    <span class="block">{t("scenarios.confirm.prodBody", { names: asking.prod.join(", ") })}</span>
    <span class="mt-1 block text-meta text-muted">{t("scenarios.confirm.prodHint")}</span>
  {/if}
</ConfirmDialog>

<ConfirmDialog
  open={deleting !== null}
  title={deleting ? t("scenarios.confirm.deleteTitle", { file: deleting.file }) : ""}
  confirmLabel={t("scenarios.recipe.delete")}
  onconfirm={() => void confirmDelete()}
  oncancel={() => (deleting = null)}
>
  <span class="block">{t("scenarios.confirm.deleteBody")}</span>
</ConfirmDialog>

<Modal open={creating !== null} title={creating === "playbook" ? t("scenarios.newPlaybook.title") : t("scenarios.new.title")} width="w-96" showClose onclose={() => (creating = null)}>
  <form
    class="space-y-2"
    onsubmit={(e) => {
      e.preventDefault();
      void createItem();
    }}
  >
    <label class="block text-xs text-muted" for="new-recipe-name">{t("scenarios.new.name")}</label>
    <input
      id="new-recipe-name"
      class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
      bind:value={newName}
      oninput={() => (newProblem = "")}
    />
    <p class="text-meta text-muted">{creating === "playbook" ? t("scenarios.newPlaybook.hint") : t("scenarios.new.hint")}</p>
    {#if newProblem}<p class="text-meta text-danger" role="alert">{newProblem}</p>{/if}
    <div class="flex justify-end gap-2">
      <button type="button" class="rounded border border-edge px-3 py-1 text-xs text-text" onclick={() => (creating = null)}>{t("common.cancel")}</button>
      <button type="submit" class="rounded bg-accent px-3 py-1 text-xs text-panel">{t("scenarios.new.create")}</button>
    </div>
  </form>
</Modal>
