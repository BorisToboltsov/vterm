<script lang="ts" module>
  /** What a playbook run was asked with (ADR 0071). */
  export interface AnsibleChoice {
    playbook: string;
    check: boolean;
    /** Hosts of the project's inventory picked; every one — no `--limit` of them. */
    hosts: string[];
    allHosts: boolean;
    /** Servers of the catalog added for this run, by id. */
    catalog: string[];
    tags: string[];
    askBecome: boolean;
  }
</script>

<script lang="ts">
  // The run of a playbook (ADR 0071): which playbook, a check (`--check
  // --diff`, nothing changes) or the real thing, on which hosts of the
  // project's inventory and which servers of the catalog, with which tags, and
  // the command that will be typed into the terminal. Prod among the hosts —
  // known by matching the inventory to the catalog — turns the run red; the
  // question after it is the project view's. A playbook of the library (ADR
  // 0072) has no inventory: its servers are the catalog's, picked here.
  import { isProdServer } from "../ai/aiexec";
  import { t } from "../i18n";
  import type { AnsibleOverview } from "../stores/scenarios.svelte";
  import Icon from "../ui/Icon.svelte";
  import Modal from "../ui/Modal.svelte";
  import type { ServerProfile } from "../types";
  import { playbookLine } from "./ansibleargv";
  import { catalogInventory, matchInventory } from "./inventory";
  import TargetPicker from "./TargetPicker.svelte";

  let {
    open,
    overview,
    servers,
    connected,
    local,
    library = false,
    initial,
    onrun,
    oncancel,
  }: {
    open: boolean;
    overview: AnsibleOverview;
    servers: ServerProfile[];
    connected: ReadonlySet<string>;
    /** The project is on this computer: key files and jump hosts can be passed. */
    local: boolean;
    /** A playbook of the library: no inventory of its own, the catalog's servers only. */
    library?: boolean;
    initial: { playbook?: string; check: boolean };
    onrun: (choice: AnsibleChoice) => void;
    oncancel: () => void;
  } = $props();

  // The run's folder is made when it starts; the preview names it by its pattern.
  const PREVIEW_DIR = "$TMPDIR/vterm-iac.XXXXXX";
  let playbook = $state("");
  let check = $state(true);
  let hosts = $state<string[]>([]);
  let catalog = $state<string[]>([]);
  let fromCatalog = $state(false);
  let tags = $state<string[]>([]);
  let askBecome = $state(false);
  let problem = $state("");

  // Each opening starts from what it was opened for: every host, no tags.
  let wasOpen = false;
  $effect.pre(() => {
    if (open === wasOpen) return;
    wasOpen = open;
    if (!open) return;
    playbook = initial.playbook && overview.playbooks.some((p) => p.file === initial.playbook) ? initial.playbook : (overview.playbooks[0]?.file ?? "");
    check = initial.check;
    hosts = overview.inventory?.hosts.map((h) => h.name) ?? [];
    catalog = [];
    fromCatalog = !overview.inventory?.hosts.length;
    tags = [];
    askBecome = overview.playbooks.some((p) => p.book.plays.some((pl) => pl.become));
    problem = "";
  });

  const book = $derived(overview.playbooks.find((p) => p.file === playbook)?.book ?? null);
  const matched = $derived(overview.inventory ? matchInventory(overview.inventory, servers) : []);
  const picked = $derived(servers.filter((s) => catalog.includes(s.id)));
  const prod = $derived([
    ...matched.filter((m) => m.prod && hosts.includes(m.host.name)).map((m) => m.host.name),
    ...picked.filter((s) => isProdServer(s)).map((s) => s.alias),
  ]);
  const inv = $derived(catalogInventory(picked, local));
  const allHosts = $derived(!!overview.inventory && hosts.length === overview.inventory.hosts.length);
  const preview = $derived(
    playbookLine({
      root: overview.root,
      playbook,
      inventories: [...(hosts.length ? overview.inventories : []), ...(picked.length ? [`${PREVIEW_DIR}/vterm-inventory.yml`] : [])],
      limit: allHosts && !picked.length ? [] : [...hosts, ...picked.map((s) => inv.names[s.id])],
      tags,
      check,
      askBecome,
      askPass: inv.asksPassword.length > 0,
      tempDir: PREVIEW_DIR,
    }) ?? "",
  );

  function toggleHost(name: string) {
    hosts = hosts.includes(name) ? hosts.filter((h) => h !== name) : [...hosts, name];
    problem = "";
  }

  function toggleGroup(names: string[]) {
    const all = names.every((n) => hosts.includes(n));
    hosts = all ? hosts.filter((h) => !names.includes(h)) : [...new Set([...hosts, ...names])];
    problem = "";
  }

  function submit() {
    if (!playbook) return void (problem = t("scenarios.ansible.noPlaybook"));
    if (!hosts.length && !picked.length) return void (problem = t("scenarios.ansible.noHosts"));
    onrun({ playbook, check, hosts: [...hosts], allHosts, catalog: [...catalog], tags: [...tags], askBecome });
  }
</script>

<Modal {open} title={t("scenarios.ansible.runTitle")} width="w-[38rem]" showClose onclose={oncancel}>
  <div class="space-y-3 text-xs" data-testid="ansible-run-dialog">
    <div class="flex flex-wrap items-center gap-2">
      <select class="rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-text" aria-label={t("scenarios.ansible.playbook")} bind:value={playbook}>
        {#each overview.playbooks as p (p.file)}<option value={p.file}>{p.file}</option>{/each}
      </select>
      <div class="flex overflow-hidden rounded border border-edge" role="radiogroup" aria-label={t("scenarios.ansible.mode")}>
        <button type="button" role="radio" aria-checked={check} class="px-2.5 py-1 {check ? 'bg-accent/15 text-text' : 'text-muted'}" onclick={() => (check = true)}>
          {t("scenarios.ansible.check")} <span class="font-mono text-meta text-muted">--check --diff</span>
        </button>
        <button type="button" role="radio" aria-checked={!check} class="px-2.5 py-1 {!check ? 'bg-accent/15 text-text' : 'text-muted'}" onclick={() => (check = false)}>
          {t("scenarios.ansible.apply")}
        </button>
      </div>
    </div>

    {#if library}
      <section data-testid="ansible-library-targets">
        <h3 class="mb-1 text-meta text-muted">{t("scenarios.ansible.catalogTitle", { count: catalog.length })}</h3>
        <TargetPicker {servers} bind:selected={catalog} {connected} hideStatus testid="ansible-catalog-picker" />
        <p class="mt-1 text-meta text-muted">{local ? t("scenarios.ansible.catalogLocal") : t("scenarios.ansible.catalogRemote")}</p>
        {#if inv.asksPassword.length}<p class="text-meta text-warn">{t("scenarios.ansible.asksPassword")}</p>{/if}
      </section>
    {:else}
    <section>
      <h3 class="mb-1 flex items-center gap-2 text-meta text-muted">
        {#if overview.inventories.length}
          {t("scenarios.ansible.hostsOf")} <span class="font-mono text-text">{overview.inventories.map((p) => p.slice(overview.root.length + 1) || p).join(", ")}</span>
        {:else}
          {t("scenarios.ansible.noInventory")}
        {/if}
      </h3>
      {#if overview.inventory}
        <div class="grid grid-cols-[6rem_1fr] items-start gap-x-2 gap-y-1">
          {#each overview.inventory.groups as g (g.name)}
            <button type="button" class="truncate text-left font-mono text-muted hover:text-text" onclick={() => toggleGroup(g.hosts)}>{g.name}</button>
            <div class="flex flex-wrap gap-1">
              {#each g.hosts as h (h)}
                {@const m = matched.find((x) => x.host.name === h)}
                <label class="flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 {hosts.includes(h) ? 'border-accent/50' : 'border-edge'}">
                  <input type="checkbox" checked={hosts.includes(h)} onchange={() => toggleHost(h)} />
                  <span class="font-mono text-text">{h}</span>
                  {#if m?.prod}<span class="rounded bg-danger/15 px-1 text-caption text-danger">prod</span>{/if}
                  {#if !m?.server}<span class="text-caption text-muted">{t("scenarios.ansible.notInCatalog")}</span>{/if}
                </label>
              {/each}
            </div>
          {/each}
        </div>
      {:else if overview.inventoryError}
        <p class="text-meta text-warn">{t("scenarios.ansible.inventoryFailed", { error: overview.inventoryError })}</p>
      {/if}
      <button type="button" class="mt-1.5 flex items-center gap-1 text-meta text-accent hover:underline" onclick={() => (fromCatalog = !fromCatalog)}>
        <Icon name={fromCatalog ? "chevronDown" : "chevronRight"} size={11} />{t("scenarios.ansible.fromCatalog", { count: catalog.length })}
      </button>
      {#if fromCatalog}
        <div class="mt-1">
          <TargetPicker {servers} bind:selected={catalog} {connected} hideStatus testid="ansible-catalog-picker" />
          <p class="mt-1 text-meta text-muted">{local ? t("scenarios.ansible.catalogLocal") : t("scenarios.ansible.catalogRemote")}</p>
          {#if inv.asksPassword.length}<p class="text-meta text-warn">{t("scenarios.ansible.asksPassword")}</p>{/if}
        </div>
      {/if}
    </section>
    {/if}

    {#if book?.tags.length}
      <section>
        <h3 class="mb-1 text-meta text-muted">{t("scenarios.ansible.tags")}</h3>
        <div class="flex flex-wrap gap-1">
          <button type="button" class="rounded border px-1.5 py-0.5 {tags.length === 0 ? 'border-accent/60 text-accent' : 'border-edge text-text'}" onclick={() => (tags = [])}>{t("scenarios.ansible.allTasks")}</button>
          {#each book.tags as tag (tag)}
            <button
              type="button"
              class="rounded border px-1.5 py-0.5 font-mono {tags.includes(tag) ? 'border-accent/60 text-accent' : 'border-edge text-text'}"
              onclick={() => (tags = tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag])}>{tag}</button
            >
          {/each}
        </div>
      </section>
    {/if}

    <section class="grid grid-cols-[8rem_1fr] gap-x-2 gap-y-1">
      <span class="text-muted">{t("scenarios.ansible.where")}</span>
      {#if library}
        <span class="text-text">{local ? t("scenarios.ansible.whereThis") : t("scenarios.ansible.whereServer")} · {overview.version ?? "ansible"}</span>
      {:else}
        <span class="text-text">{local ? t("scenarios.ansible.whereLocal") : t("scenarios.ansible.whereRemote")} · {overview.version ?? "ansible"}</span>
      {/if}
      <span class="text-muted">{t("scenarios.ansible.becomeLabel")}</span>
      <label class="flex items-center gap-1.5 text-text"><input type="checkbox" bind:checked={askBecome} />{t("scenarios.ansible.become")}</label>
      <span class="text-muted">{t("scenarios.ansible.hostKeys")}</span>
      <span class="text-text">{t("scenarios.ansible.hostKeysText")}</span>
    </section>

    <div class="break-all rounded border border-edge bg-panel-alt px-2 py-1.5 font-mono text-meta text-muted" data-testid="ansible-command"><span class="text-ok">$</span> {preview}</div>

    {#if prod.length && !check}
      <div class="flex items-center gap-1.5 rounded border border-danger/50 bg-danger/10 px-2 py-1 text-danger" role="alert">
        <Icon name="alert" size={13} />{t("scenarios.ansible.prodApply", { names: prod.join(", ") })}
      </div>
    {:else if prod.length}
      <div class="flex items-center gap-1.5 text-muted"><Icon name="shield" size={13} class="text-ok" />{t("scenarios.ansible.prodCheck")}</div>
    {/if}

    <div class="flex items-center justify-end gap-2">
      {#if problem}<span class="mr-auto text-meta text-danger" role="alert">{problem}</span>{/if}
      <button type="button" class="rounded border border-edge px-3 py-1 text-text" onclick={oncancel}>{t("common.cancel")}</button>
      <button
        type="button"
        class="flex items-center gap-1 rounded border px-3 py-1 {prod.length && !check ? 'border-danger/60 bg-danger/10 text-danger' : 'border-accent/50 bg-accent/10 text-accent'}"
        data-testid="ansible-run-go"
        onclick={submit}
      >
        <Icon name="play" size={12} />{check ? t("scenarios.ansible.goCheck") : t("scenarios.ansible.goApply")}
      </button>
    </div>
  </div>
</Modal>
