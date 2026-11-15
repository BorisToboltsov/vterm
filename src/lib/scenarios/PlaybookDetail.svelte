<script lang="ts">
  // One playbook of the library (ADR 0072): what its plays do — on which hosts,
  // with which roles, as root or not, which tags, what it asks — where Ansible
  // runs it (this computer, or a server of the catalog with Ansible), and its
  // code. "Check…" and "Run…" open it beside the terminal of that place, where
  // the servers of the catalog and the tags are picked and the run is watched.
  // Stands inside the panel's container: no dialog of its own.
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import Icon from "../ui/Icon.svelte";
  import type { ServerProfile } from "../types";
  import type { LibraryPlaybook } from "./recipelib";

  let {
    playbook,
    servers,
    node,
    windows,
    onnode,
    onrun,
    oncopy,
    onedit,
    ondelete,
    onback,
  }: {
    playbook: LibraryPlaybook;
    servers: ServerProfile[];
    /** Where it runs: a server's id, or null — this computer. */
    node: string | null;
    /** The app runs on Windows: Ansible does not run here itself. */
    windows: boolean;
    onnode: (node: string | null) => void;
    onrun: (action: "check" | "run") => void;
    /** Copy into "Mine" (a source's playbook). */
    oncopy?: () => void;
    /** Open the file in the editor. */
    onedit?: () => void;
    /** Delete it (the app's own folder only). */
    ondelete?: () => void;
    /** Back to the list (a narrow panel). */
    onback?: () => void;
  } = $props();

  let tab = $state<"about" | "code">("about");
  let seen = "";
  $effect.pre(() => {
    if (playbook.id === seen) return;
    seen = playbook.id;
    tab = "about";
  });

  const book = $derived(playbook.book);
  const prompts = $derived(book ? [...new Set(book.plays.flatMap((p) => p.prompts))] : []);
  const here = $derived(node === null);
  const lines = $derived(playbook.text.replace(/\r\n?/g, "\n").split("\n"));
  const nodeValue = $derived(node ?? "");
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="playbook-detail">
  <div class="shrink-0 border-b border-edge px-3 pb-0 pt-2">
    <div class="flex items-center gap-2">
      {#if onback}
        <button type="button" class="rounded p-0.5 text-muted hover:bg-edge hover:text-text" aria-label={t("scenarios.back")} onclick={onback}>
          <Icon name="chevronLeft" size={14} />
        </button>
      {/if}
      <Icon name="gearPlay" size={15} class="text-warn" />
      <span class="min-w-0 truncate text-sm font-medium text-text">{playbook.name}</span>
      <span class="rounded bg-warn/15 px-1.5 text-caption text-warn">Ansible</span>
      <span class="rounded bg-edge px-1.5 text-caption text-muted">
        {playbook.origin === "own" ? t("scenarios.origin.own") : t("scenarios.origin.source")}
      </span>
    </div>
    {#if playbook.description}<p class="mt-1 text-meta text-muted">{playbook.description}</p>{/if}
    <div class="mt-1.5 flex items-center gap-0.5" role="tablist">
      {#each [["about", t("scenarios.project.tab.overview")], ["code", `${t("scenarios.recipe.tabCode")} · ${playbook.file}`]] as [id, label] (id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === id}
          class="border-b-2 px-2 py-1 text-xs {tab === id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'}"
          onclick={() => (tab = id as "about" | "code")}>{label}</button
        >
      {/each}
      <span class="ml-auto flex items-center gap-1 pb-1">
        {#if oncopy}
          <button type="button" class="rounded border border-edge px-1.5 py-0.5 text-meta text-text hover:border-accent" onclick={oncopy}>{t("scenarios.recipe.copy")}</button>
        {/if}
        {#if onedit}
          <button type="button" class="rounded p-1 text-muted hover:bg-edge hover:text-text" aria-label={t("scenarios.recipe.edit")} use:tooltip={t("scenarios.recipe.edit")} onclick={onedit}>
            <Icon name="pencil" size={13} />
          </button>
        {/if}
        {#if ondelete}
          <button type="button" class="rounded p-1 text-muted hover:bg-edge hover:text-danger" aria-label={t("scenarios.recipe.delete")} use:tooltip={t("scenarios.recipe.delete")} onclick={ondelete}>
            <Icon name="trash" size={13} />
          </button>
        {/if}
      </span>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if tab === "code"}
      <pre class="px-0 py-1.5 font-mono text-meta leading-relaxed" data-testid="playbook-code">{#each lines as l, i (i)}<span class="flex"><span class="w-8 shrink-0 select-none pr-2 text-right text-muted/60">{i + 1}</span><span class="whitespace-pre {/^\s*#/.test(l) ? 'text-muted' : 'text-text'}">{l}</span></span>{/each}</pre>
    {:else if !book}
      <p class="p-3 text-xs text-warn">{t("scenarios.playbook.unreadable", { error: playbook.error ?? "" })}</p>
    {:else}
      <div class="space-y-3 p-3 text-xs">
        <section>
          <h3 class="mb-1 text-meta text-muted">{t("scenarios.playbook.plays")}</h3>
          <div class="divide-y divide-edge/40 rounded border border-edge bg-panel-alt/40">
            {#if book.imports.length}
              <p class="px-2 py-1 text-muted">{t("scenarios.ansible.imports", { files: book.imports.join(", ") })}</p>
            {/if}
            {#each book.plays as pl, i (i)}
              <div class="flex flex-wrap items-baseline gap-x-2 px-2 py-1">
                <span class="text-text">{pl.name}</span>
                <span class="text-muted">hosts <span class="font-mono text-text">{pl.hosts}</span></span>
                {#if pl.roles.length}<span class="text-muted">{t("scenarios.ansible.roles")} <span class="font-mono text-text">{pl.roles.join(", ")}</span></span>{/if}
                {#if pl.become}<span class="rounded bg-warn/15 px-1 text-caption text-warn">{t("scenarios.playbook.become")}</span>{/if}
              </div>
            {/each}
          </div>
        </section>
        {#if book.tags.length}
          <p class="text-muted">{t("scenarios.ansible.tags")}: <span class="font-mono text-accent">{book.tags.join(" ")}</span></p>
        {/if}
        {#if prompts.length}
          <p class="text-muted">{t("scenarios.playbook.prompts", { names: prompts.join(", ") })}</p>
        {/if}

        <section class="space-y-1">
          <label class="flex flex-wrap items-center gap-2">
            <span class="text-meta text-muted">{t("scenarios.ansible.where")}</span>
            <select
              class="rounded border border-edge bg-panel px-1.5 py-0.5 text-xs text-text"
              data-testid="playbook-node"
              value={nodeValue}
              onchange={(e) => onnode((e.currentTarget as HTMLSelectElement).value || null)}
            >
              <option value="">{t("scenarios.ansible.whereThis")}</option>
              {#each servers as s (s.id)}<option value={s.id}>{s.alias}</option>{/each}
            </select>
          </label>
          {#if here && windows}
            <p class="text-meta text-warn">{t("scenarios.playbook.windows")}</p>
          {:else}
            <p class="text-meta text-muted">{t("scenarios.playbook.whereHint")}{#if !here} {t("scenarios.playbook.carryHint")}{/if}</p>
          {/if}
        </section>

        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="rounded border border-edge px-2.5 py-1 text-xs text-text hover:border-accent" data-testid="playbook-check" onclick={() => onrun("check")}>
            {t("scenarios.playbook.check")}
          </button>
          <button
            type="button"
            class="flex items-center gap-1 rounded border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs text-accent"
            data-testid="playbook-run"
            onclick={() => onrun("run")}
          >
            <Icon name="play" size={12} />{t("scenarios.ansible.runDots")}
          </button>
        </div>
        <p class="text-meta text-muted">{t("scenarios.playbook.runHint")}</p>
      </div>
    {/if}
  </div>
</div>
