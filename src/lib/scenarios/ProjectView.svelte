<script lang="ts">
  // An Ansible or Terraform project of a connection (ADR 0071): a document with
  // no text in the connection's file zone, beside its terminal. The overview is
  // read from the files through the connection's own transport and from the
  // user's `ansible`/`terraform` on the host where the project lies; a run or a
  // plan is typed into that host's terminal — the user's program in the user's
  // shell — and watched here through what it leaves in the run's folder. Not a
  // container (it owns its dialogs).
  import { untrack, type Snippet } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { isProdServer } from "../ai/aiexec";
  import { t } from "../i18n";
  import type { CdShell } from "../pathsync/cdterminal";
  import { settings } from "../settings/settings.svelte";
  import {
    ansibleWatch,
    endAnsibleWatch,
    loadAnsibleProject,
    loadTfProject,
    planApplied,
    planWatch,
    pollAnsible,
    pollPlan,
    prepareAnsibleRun,
    preparePlan,
    watchAnsibleRun,
    type AnsibleOverview,
    type TfOverview,
  } from "../stores/scenarios.svelte";
  import { notifyError } from "../stores/toasts.svelte";
  import type { EditorDoc } from "../stores/workspaces.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import Icon from "../ui/Icon.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import { singleFlight } from "../ui/poll";
  import type { ServerProfile } from "../types";
  import { CATALOG_INVENTORY_FILE, playbookLine } from "./ansibleargv";
  import AnsibleRunDialog, { type AnsibleChoice } from "./AnsibleRunDialog.svelte";
  import AnsibleRunView from "./AnsibleRunView.svelte";
  import { folderName, isPinned, togglePin } from "./bookmarks";
  import { catalogInventory, matchInventory } from "./inventory";
  import { applyArgv, destroys, initArgv, planArgv, validateArgv } from "./tfplan";
  import { autoLoaded } from "./tfproject";
  import TfPlanView from "./TfPlanView.svelte";

  let {
    sessionId,
    local,
    doc,
    servers,
    connected,
    shell,
    serverId,
    prod,
    onTypeLine,
    onTypeArgv,
    onShowTerminal,
    onOpenFile,
    onAsk,
  }: {
    sessionId: string;
    /** The project is on this computer (a local tab). */
    local: boolean;
    doc: EditorDoc;
    servers: ServerProfile[];
    connected: ReadonlySet<string>;
    /** The shell the tab runs: a playbook run is typed only into a POSIX one. */
    shell: CdShell;
    /** The server the project is on; null — this computer. */
    serverId: string | null;
    /** That server is prod. */
    prod: boolean;
    /** A POSIX line typed into this tab's terminal (the terminal is shown). */
    onTypeLine: (line: string) => void;
    /** An argv typed into this tab's terminal, rendered for its shell. */
    onTypeArgv: (argv: string[]) => void;
    onShowTerminal: () => void;
    onOpenFile: (path: string) => void;
    onAsk?: (context: string) => void;
  } = $props();

  const kind = $derived(doc.project!.kind);
  const root = $derived(doc.project!.root);
  const bookmark = $derived({ kind, root, serverId });
  const pinned = $derived(isPinned(settings.scenarioProjects, bookmark));

  let tab = $state<"overview" | "run" | "plan">("overview");
  const tabs = $derived<("overview" | "run" | "plan")[]>(kind === "ansible" ? ["overview", "run"] : ["overview", "plan"]);
  let ansible = $state.raw<AnsibleOverview | null>(null);
  let tf = $state.raw<TfOverview | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      if (kind === "ansible") ansible = await loadAnsibleProject(sessionId, local, root);
      else tf = await loadTfProject(sessionId, local, root);
    } catch (e) {
      loadError = String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void root;
    void kind;
    untrack(() => void load());
  });

  // ── Ansible ───────────────────────────────────────────────────────────────
  const watch = $derived(ansibleWatch(sessionId));
  const watchKey = $derived(watch && !watch.ended && watch.root === root ? watch.tempDir : null);
  $effect(() => {
    if (!watchKey) return;
    const tick = singleFlight(async () => {
      await pollAnsible(sessionId);
    });
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => clearInterval(id);
  });

  let dialog = $state<{ playbook?: string; check: boolean } | null>(null);
  let confirming = $state<AnsibleChoice | null>(null);
  let lastChoice = $state.raw<AnsibleChoice | null>(null);
  let prodHosts = $state.raw<ReadonlySet<string>>(new Set());
  const matched = $derived(ansible?.inventory ? matchInventory(ansible.inventory, servers) : []);

  function prodOf(choice: AnsibleChoice): string[] {
    return [
      ...matched.filter((m) => m.prod && choice.hosts.includes(m.host.name)).map((m) => m.host.name),
      ...servers.filter((s) => choice.catalog.includes(s.id) && isProdServer(s)).map((s) => s.alias),
    ];
  }

  function chosen(choice: AnsibleChoice) {
    dialog = null;
    if (!choice.check) {
      confirming = choice;
      return;
    }
    void launch(choice);
  }

  async function launch(choice: AnsibleChoice) {
    const ov = ansible;
    if (!ov) return;
    if (shell !== "posix") {
      notifyError(t("scenarios.ansible.needsPosix"), { source: "scenarios", sessionId });
      return;
    }
    const picked = servers.filter((s) => choice.catalog.includes(s.id));
    const inv = picked.length ? catalogInventory(picked, local) : null;
    let tempDir: string;
    try {
      tempDir = await prepareAnsibleRun(sessionId, inv?.text ?? null);
    } catch (e) {
      notifyError(t("scenarios.ansible.prepareFailed", { error: String(e) }), { source: "scenarios", sessionId });
      return;
    }
    const limit = choice.allHosts && !picked.length ? [] : [...choice.hosts, ...picked.map((s) => inv!.names[s.id])];
    const line = playbookLine({
      root,
      playbook: choice.playbook,
      inventories: [...(choice.hosts.length ? ov.inventories : []), ...(inv ? [`${tempDir}/${CATALOG_INVENTORY_FILE}`] : [])],
      limit,
      tags: choice.tags,
      check: choice.check,
      askBecome: choice.askBecome,
      askPass: !!inv?.asksPassword.length,
      tempDir,
    });
    if (!line) {
      notifyError(t("page.commandUnquotable"), { source: "scenarios", sessionId });
      return;
    }
    prodHosts = new Set([
      ...matched.filter((m) => m.prod).map((m) => m.host.name),
      ...picked.filter((s) => isProdServer(s)).map((s) => inv!.names[s.id]),
    ]);
    watchAnsibleRun({ sessionId, root, playbook: choice.playbook, tempDir, check: choice.check, limit });
    lastChoice = choice;
    tab = "run";
    onTypeLine(line);
  }

  // ── Terraform ─────────────────────────────────────────────────────────────
  const plan = $derived(planWatch(sessionId));
  const planKey = $derived(plan && plan.phase === "planning" && plan.root === root ? plan.planPath : null);
  $effect(() => {
    if (!planKey) return;
    const tick = singleFlight(async () => {
      await pollPlan(sessionId);
    });
    void tick();
    const id = setInterval(() => void tick(), 1500);
    return () => clearInterval(id);
  });

  let varPick = $state<string[]>([]);
  let applying = $state(false);
  const extraVarFiles = $derived(tf ? tf.varFiles.filter((f) => !autoLoaded(f)) : []);

  async function startPlan() {
    if (!tf) return;
    let planPath: string;
    try {
      planPath = await preparePlan(sessionId, root, varPick);
    } catch (e) {
      notifyError(t("scenarios.plan.prepareFailed", { error: String(e) }), { source: "scenarios", sessionId });
      return;
    }
    tab = "plan";
    onTypeArgv(planArgv(root, planPath, varPick));
  }

  function applyPlan() {
    applying = false;
    const p = plan;
    if (!p || p.phase !== "ready") return;
    onTypeArgv(applyArgv(root, p.planPath));
    planApplied(sessionId);
  }

  // ── What the view was opened for ──────────────────────────────────────────
  let handled = 0;
  $effect(() => {
    const seq = doc.project?.askSeq ?? 0;
    const ask = doc.project?.ask;
    const ready = kind === "ansible" ? !!ansible : !!tf;
    if (!ask || seq === handled || !ready) return;
    handled = seq;
    untrack(() => {
      if (ask.action === "plan" && kind === "terraform") void startPlan();
      else if (kind === "ansible") dialog = { playbook: ask.playbook, check: ask.action !== "run" };
    });
  });

  const where = $derived(serverId ? (servers.find((s) => s.id === serverId)?.alias ?? "") : t("scenarios.project.thisComputer"));
  const join = (dir: string, name: string) => `${dir}${dir.endsWith("/") ? "" : "/"}${name}`;
</script>

{#snippet card(title: string, body: Snippet)}
  <section class="mt-3">
    <h3 class="mb-1 text-meta text-muted">{title}</h3>
    <div class="divide-y divide-edge/40 rounded border border-edge bg-panel-alt/40">{@render body()}</div>
  </section>
{/snippet}

<div class="flex h-full min-h-0 flex-col bg-panel" data-testid="project-view">
  <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-1.5">
    <Icon name={kind === "ansible" ? "gearPlay" : "cube"} size={16} class={kind === "ansible" ? "text-warn" : "text-accent"} />
    <span class="text-sm font-medium text-text">{kind === "ansible" ? t("scenarios.project.ansible") : t("scenarios.project.terraform")}</span>
    <span class="min-w-0 truncate font-mono text-meta text-muted" use:tooltip={root}>{where}:{root}</span>
    <span class="ml-auto flex items-center gap-1">
      <button
        type="button"
        class="rounded p-1 hover:bg-edge {pinned ? 'text-accent' : 'text-muted hover:text-text'}"
        aria-label={pinned ? t("scenarios.project.unpin") : t("scenarios.project.pin")}
        aria-pressed={pinned}
        use:tooltip={pinned ? t("scenarios.project.unpin") : t("scenarios.project.pin")}
        onclick={() => (settings.scenarioProjects = togglePin(settings.scenarioProjects, bookmark))}
      >
        <Icon name="pin" size={13} />
      </button>
      <button type="button" class="rounded p-1 text-muted hover:bg-edge hover:text-text" aria-label={t("scenarios.refresh")} use:tooltip={t("scenarios.refresh")} onclick={() => void load()}>
        <Icon name="refresh" size={13} class={loading ? "animate-spin" : ""} />
      </button>
    </span>
  </div>
  <div class="flex shrink-0 items-center gap-0.5 border-b border-edge px-2" role="tablist">
    {#each tabs as id (id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === id}
        class="border-b-2 px-2 py-1 text-xs {tab === id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'}"
        data-testid="project-tab-{id}"
        onclick={() => (tab = id)}
      >
        {t(`scenarios.project.tab.${id}` as const)}
        {#if id === "run" && watch && !watch.ended}<Icon name="loader" size={10} class="ml-1 inline animate-spin text-accent" />{/if}
      </button>
    {/each}
    <span class="ml-auto flex items-center gap-1.5 py-1">
      {#if kind === "ansible" && ansible?.playbooks.length}
        <button type="button" class="rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" data-testid="project-check" onclick={() => (dialog = { check: true })}>
          {t("scenarios.ansible.check")}
        </button>
        <button type="button" class="flex items-center gap-1 rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-meta text-accent" data-testid="project-run" onclick={() => (dialog = { check: false })}>
          <Icon name="play" size={11} />{t("scenarios.ansible.runDots")}
        </button>
      {:else if kind === "terraform" && tf}
        <button type="button" class="rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" onclick={() => onTypeArgv(validateArgv(root))}>validate</button>
        <button type="button" class="flex items-center gap-1 rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-meta text-accent" data-testid="project-plan" onclick={() => void startPlan()}>
          <Icon name="play" size={11} />{t("scenarios.plan.make")}
        </button>
      {/if}
    </span>
  </div>

  {#if tab === "run" && watch && watch.root === root}
    <AnsibleRunView
      {watch}
      {prodHosts}
      onapply={lastChoice ? () => lastChoice && (confirming = { ...lastChoice, check: false }) : undefined}
      onstop={() => endAnsibleWatch(sessionId)}
      onterminal={onShowTerminal}
      onask={onAsk}
    />
  {:else if tab === "plan" && plan && plan.root === root}
    <TfPlanView watch={plan} onapply={() => (applying = true)} onreplan={() => void startPlan()} onterminal={onShowTerminal} />
  {:else if tab !== "overview"}
    <p class="p-3 text-xs text-muted">{tab === "run" ? t("scenarios.ansible.noRunYet") : t("scenarios.plan.noPlanYet")}</p>
  {:else if loadError}
    <p class="p-3 text-xs text-danger">{t("scenarios.project.loadFailed", { error: loadError })}</p>
  {:else if loading && !ansible && !tf}
    <div class="space-y-2 p-3"><Skeleton /><Skeleton width="80%" /><Skeleton width="60%" /></div>
  {:else if kind === "ansible" && ansible}
    {@const ov = ansible}
    <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-xs">
      {#if !ov.installed}
        <p class="mt-3 rounded border border-warn/50 bg-warn/10 px-2 py-1 text-warn">{local ? t("scenarios.ansible.missingLocal") : t("scenarios.ansible.missingRemote")}</p>
      {/if}
      {#snippet books()}
        {#each ov.playbooks as p (p.file)}
          <div class="flex items-center gap-2 px-2 py-1">
            <button type="button" class="w-28 shrink-0 truncate text-left font-mono text-text hover:underline" onclick={() => onOpenFile(join(root, p.file))}>{p.file}</button>
            <span class="min-w-0 flex-1 truncate text-muted">
              {#if p.book.imports.length}{t("scenarios.ansible.imports", { files: p.book.imports.join(", ") })}{/if}
              {#each p.book.plays as pl, i (i)}
                {#if i || p.book.imports.length} · {/if}<span>hosts <span class="text-text">{pl.hosts}</span>{#if pl.roles.length} · {t("scenarios.ansible.roles")} <span class="text-text">{pl.roles.join(", ")}</span>{/if}</span>
              {/each}
              {#if p.book.tags.length} · {t("scenarios.ansible.tags")} <span class="text-accent">{p.book.tags.join(" ")}</span>{/if}
            </span>
            <button type="button" class="shrink-0 rounded border border-edge p-1 text-muted hover:border-accent hover:text-accent" aria-label={t("scenarios.ansible.runThis", { file: p.file })} use:tooltip={t("scenarios.ansible.runThis", { file: p.file })} onclick={() => (dialog = { playbook: p.file, check: true })}>
              <Icon name="play" size={11} />
            </button>
          </div>
        {/each}
        {#if ov.playbooks.length === 0}<p class="px-2 py-1 text-muted">{t("scenarios.ansible.noPlaybooks")}</p>{/if}
      {/snippet}
      {@render card(t("scenarios.ansible.playbooks"), books)}

      {#snippet hostsCard()}
        {#if ov.inventory}
          {#each ov.inventory.groups as g (g.name)}
            <div class="flex items-start gap-2 px-2 py-1">
              <span class="w-20 shrink-0 truncate font-mono text-muted">{g.name}</span>
              <span class="flex min-w-0 flex-wrap gap-1">
                {#each g.hosts as h (h)}
                  {@const m = matched.find((x) => x.host.name === h)}
                  <span class="flex items-center gap-1 rounded border px-1.5 {m?.prod ? 'border-danger/50' : m?.server ? 'border-edge' : 'border-dashed border-edge'}" use:tooltip={m?.server ? `${m.server.alias} · ${m.server.username}@${m.server.host}` : t("scenarios.ansible.notInCatalog")}>
                    <Icon name={m?.server ? "server" : "help"} size={11} class={m?.prod ? "text-danger" : m?.server ? "text-ok" : "text-muted"} />
                    <span class="font-mono text-text">{h}</span>
                    {#if m?.prod}<span class="rounded bg-danger/15 px-1 text-caption text-danger">prod</span>{/if}
                  </span>
                {/each}
              </span>
            </div>
          {/each}
          <p class="px-2 py-1 text-meta text-muted">{ov.inventorySource === "ansible" ? t("scenarios.ansible.readByAnsible") : t("scenarios.ansible.readByHand")}</p>
        {:else if ov.inventoryError}
          <p class="px-2 py-1 text-warn">{t("scenarios.ansible.inventoryFailed", { error: ov.inventoryError })}</p>
        {:else}
          <p class="px-2 py-1 text-muted">{t("scenarios.ansible.noInventoryHint")}</p>
        {/if}
      {/snippet}
      {@render card(ov.inventories.length ? t("scenarios.ansible.inventoryOf", { files: ov.inventories.map((p) => p.slice(root.length + 1) || p).join(", ") }) : t("scenarios.ansible.inventory"), hostsCard)}

      {#if ov.requirements.collections.length || ov.requirements.roles.length || ov.unreadable.length}
        {#snippet needs()}
          {#if ov.requirements.collections.length || ov.requirements.roles.length}
            <div class="flex items-center gap-2 px-2 py-1">
              <Icon name="archive" size={12} class="text-muted" />
              <span class="min-w-0 flex-1">
                {t("scenarios.ansible.requirements", { collections: ov.requirements.collections.length, roles: ov.requirements.roles.length })}
                {#if ov.missing?.length}<span class="text-warn"> · {t("scenarios.ansible.missingCollections", { names: ov.missing.join(", ") })}</span>{/if}
              </span>
              <button type="button" class="shrink-0 rounded border border-edge px-1.5 py-0.5 text-meta text-text hover:border-accent" onclick={() => onTypeArgv(["ansible-galaxy", "install", "-r", join(root, "requirements.yml")])}>
                {t("scenarios.ansible.installDeps")}
              </button>
            </div>
          {/if}
          {#if ov.unreadable.length}
            <p class="px-2 py-1 text-muted">{t("scenarios.ansible.notPlaybooks", { files: ov.unreadable.join(", ") })}</p>
          {/if}
        {/snippet}
        {@render card(t("scenarios.ansible.needs"), needs)}
      {/if}
    </div>
  {:else if kind === "terraform" && tf}
    {@const ov = tf}
    <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-xs">
      {#if !ov.installed}
        <p class="mt-3 rounded border border-warn/50 bg-warn/10 px-2 py-1 text-warn">{t("scenarios.tf.missing")}</p>
      {:else if !ov.initialized}
        <p class="mt-3 flex items-center gap-2 rounded border border-warn/50 bg-warn/10 px-2 py-1 text-warn">
          {t("scenarios.tf.notInitialized")}
          <button type="button" class="ml-auto rounded border border-edge px-1.5 py-0.5 text-meta text-text hover:border-accent" onclick={() => onTypeArgv(initArgv(root))}>terraform init</button>
        </p>
      {/if}
      {#snippet shape()}
        <div class="flex gap-2 px-2 py-1"><span class="w-28 shrink-0 text-muted">{t("scenarios.tf.state")}</span><span class="text-text">{ov.project.backend ? `backend ${ov.project.backend}` : t("scenarios.tf.localState")} — <span class="text-muted">{t("scenarios.tf.stateNotRead")}</span></span></div>
        <div class="flex gap-2 px-2 py-1">
          <span class="w-28 shrink-0 text-muted">{t("scenarios.tf.providers")}</span>
          <span class="min-w-0 font-mono text-text">
            {#each Object.entries(ov.project.providers) as [name, src] (name)}<span class="mr-2">{src || name}{#if ov.locked[src]}<span class="ml-1 text-muted">{ov.locked[src]}</span>{/if}</span>{/each}
            {#if !Object.keys(ov.project.providers).length}{#each Object.entries(ov.locked) as [addr, v] (addr)}<span class="mr-2">{addr}<span class="ml-1 text-muted">{v}</span></span>{/each}{/if}
          </span>
        </div>
        <div class="flex gap-2 px-2 py-1">
          <span class="w-28 shrink-0 text-muted">{t("scenarios.tf.resources", { count: ov.project.resources.length })}</span>
          <span class="min-w-0 font-mono text-text">{ov.project.resources.map((r) => `${r.type}.${r.name}${r.counted ? "[…]" : ""}`).join(" · ") || "—"}</span>
        </div>
        {#if ov.project.modules.length}
          <div class="flex gap-2 px-2 py-1"><span class="w-28 shrink-0 text-muted">{t("scenarios.tf.modules")}</span><span class="min-w-0 font-mono text-text">{ov.project.modules.map((m) => `${m.name}${m.source ? ` (${m.source})` : ""}`).join(" · ")}</span></div>
        {/if}
        <div class="flex gap-2 px-2 py-1">
          <span class="w-28 shrink-0 text-muted">{t("scenarios.tf.variables")}</span>
          <span class="flex min-w-0 flex-wrap gap-x-2 font-mono text-text">
            {#each ov.project.variables as v (v.name)}
              <span use:tooltip={v.description ?? ""}>{v.name}{#if v.sensitive}<span class="ml-1 rounded bg-warn/15 px-1 font-sans text-caption text-warn">sensitive</span>{:else if v.default !== null}<span class="text-muted">={v.default}</span>{:else}<span class="ml-1 font-sans text-warn">{t("scenarios.tf.noDefault")}</span>{/if}</span>
            {/each}
            {#if !ov.project.variables.length}—{/if}
          </span>
        </div>
        {#if ov.project.outputs.length}
          <div class="flex gap-2 px-2 py-1"><span class="w-28 shrink-0 text-muted">{t("scenarios.tf.outputs")}</span><span class="min-w-0 font-mono text-text">{ov.project.outputs.map((o) => o.name).join(" · ")}</span></div>
        {/if}
      {/snippet}
      {@render card(t("scenarios.tf.shape"), shape)}
      {#snippet values()}
        {#each ov.varFiles as f (f)}
          <label class="flex items-center gap-2 px-2 py-1">
            {#if autoLoaded(f)}
              <input type="checkbox" checked disabled />
            {:else}
              <input type="checkbox" checked={varPick.includes(f)} onchange={() => (varPick = varPick.includes(f) ? varPick.filter((x) => x !== f) : [...varPick, f])} />
            {/if}
            <span class="font-mono text-text">{f}</span>
            {#if autoLoaded(f)}<span class="text-meta text-muted">{t("scenarios.tf.autoLoaded")}</span>{/if}
          </label>
        {/each}
        {#if !ov.varFiles.length}<p class="px-2 py-1 text-muted">{t("scenarios.tf.noValues")}</p>{/if}
      {/snippet}
      {@render card(t("scenarios.tf.values"), values)}
      {#if extraVarFiles.length && !varPick.length}<p class="mt-1 text-meta text-muted">{t("scenarios.tf.pickValues")}</p>{/if}
    </div>
  {/if}
</div>

{#if ansible}
  <AnsibleRunDialog
    open={dialog !== null}
    overview={ansible}
    {servers}
    {connected}
    {local}
    initial={dialog ?? { check: true }}
    onrun={chosen}
    oncancel={() => (dialog = null)}
  />
{/if}

<ConfirmDialog
  open={confirming !== null}
  title={t("scenarios.ansible.confirmTitle", { playbook: confirming?.playbook ?? "" })}
  confirmLabel={t("scenarios.ansible.goApply")}
  danger={!!confirming && (prodOf(confirming).length > 0 || prod)}
  onconfirm={() => {
    const c = confirming;
    confirming = null;
    if (c) void launch(c);
  }}
  oncancel={() => (confirming = null)}
>
  {#if confirming}
    <span class="block">{t("scenarios.ansible.confirmBody")}</span>
    {#if prodOf(confirming).length}
      <span class="mt-1 block text-meta text-danger">{t("scenarios.ansible.prodApply", { names: prodOf(confirming).join(", ") })}</span>
    {/if}
  {/if}
</ConfirmDialog>

<ConfirmDialog
  open={applying}
  title={t("scenarios.plan.confirmTitle", { project: folderName(root) })}
  confirmLabel={t("scenarios.plan.apply")}
  danger={!!plan?.plan && (destroys(plan.plan) || prod)}
  onconfirm={applyPlan}
  oncancel={() => (applying = false)}
>
  {#if plan?.plan}
    <span class="block">{t("scenarios.plan.confirmBody", { ...plan.plan.counts })}</span>
    {#if destroys(plan.plan)}<span class="mt-1 block text-meta text-danger">{t("scenarios.plan.confirmDestroy")}</span>{/if}
    {#if prod}<span class="mt-1 block text-meta text-danger">{t("scenarios.plan.confirmProd")}</span>{/if}
  {/if}
</ConfirmDialog>
