<script lang="ts" module>
  import type { Elevation } from "../api";
  import type { RecipeMode } from "./recipe";

  /** What a run of the recipe was asked with. */
  export interface RunAsk {
    values: Record<string, string>;
    serverIds: string[];
    mode: RecipeMode;
    elevation: Elevation;
    password: string | null;
  }
</script>

<script lang="ts">
  // One recipe (ADR 0071): what it does, its parameters, the servers of the
  // catalog to run it on, who it runs as, and its code. "Check" asks each
  // server what would change and changes nothing; "Run" checks first when the
  // recipe can, and skips a server where all is already so. The questions
  // (prod, deleting) are the panel's: this stands inside its container.
  import { tooltip } from "../actions/tooltip";
  import { isProdServer } from "../ai/aiexec";
  import { t } from "../i18n";
  import { recipeRuns, type RecipeRunRecord, type RunHost } from "../stores/scenarios.svelte";
  import Icon from "../ui/Icon.svelte";
  import PasswordInput from "../ui/PasswordInput.svelte";
  import type { ServerProfile } from "../types";
  import { valuesProblem } from "./recipe";
  import { itemDescription, itemName, type LibraryRecipe } from "./recipelib";
  import RunHosts from "./RunHosts.svelte";
  import TargetPicker from "./TargetPicker.svelte";

  let {
    recipe,
    servers,
    connected,
    onrun,
    oncopy,
    onedit,
    ondelete,
    onback,
    onask,
  }: {
    recipe: LibraryRecipe;
    servers: ServerProfile[];
    connected: ReadonlySet<string>;
    onrun: (ask: RunAsk) => void;
    /** Copy into "Mine" (a source's recipe). */
    oncopy?: () => void;
    /** Open the file in the editor (the user's recipes). */
    onedit?: () => void;
    /** Delete it (the app's own folder only). */
    ondelete?: () => void;
    /** Back to the list (a narrow panel). */
    onback?: () => void;
    onask?: (run: RecipeRunRecord, host: RunHost) => void;
  } = $props();

  const meta = $derived(recipe.meta);
  let tab = $state<"run" | "code">("run");
  let values = $state<Record<string, string>>({});
  let picked = $state<string[]>([]);
  let elevation = $state<Elevation>("user");
  let password = $state("");
  let problem = $state("");

  // A new recipe starts from its defaults; the servers picked stay.
  let seen = "";
  $effect.pre(() => {
    if (recipe.id === seen) return;
    seen = recipe.id;
    values = Object.fromEntries((recipe.meta?.params ?? []).map((p) => [p.name, p.default]));
    elevation = recipe.meta?.sudo ? "sudo" : "user";
    password = "";
    problem = "";
    tab = "run";
  });

  const last = $derived(recipeRuns().find((r) => r.recipeId === recipe.id) ?? null);
  const prodPicked = $derived(servers.filter((s) => picked.includes(s.id) && isProdServer(s)));

  function go(mode: RecipeMode) {
    if (!meta) return;
    const bad = valuesProblem(meta, values);
    if (bad) {
      const p = meta.params.find((x) => x.name === bad.param)!;
      problem = t(bad.why === "required" ? "scenarios.recipe.required" : "scenarios.recipe.newline", { name: p.label });
      return;
    }
    if (picked.length === 0) {
      problem = t("scenarios.recipe.noServers");
      return;
    }
    problem = "";
    onrun({ values: { ...values }, serverIds: [...picked], mode, elevation, password: elevation === "sudoPassword" && password ? password : null });
  }

  const lines = $derived(recipe.text.replace(/\r\n?/g, "\n").split("\n"));
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="recipe-detail">
  <div class="shrink-0 border-b border-edge px-3 pb-0 pt-2">
    <div class="flex items-center gap-2">
      {#if onback}
        <button type="button" class="rounded p-0.5 text-muted hover:bg-edge hover:text-text" aria-label={t("scenarios.back")} onclick={onback}>
          <Icon name="chevronLeft" size={14} />
        </button>
      {/if}
      <Icon name="script" size={15} class="text-accent" />
      <span class="min-w-0 truncate text-sm font-medium text-text">{itemName(recipe)}</span>
      <span class="rounded bg-edge px-1.5 text-caption text-muted">
        {recipe.origin === "own" ? t("scenarios.origin.own") : t("scenarios.origin.source")}
      </span>
      {#if meta?.sudo}<span class="rounded bg-warn/15 px-1.5 text-caption text-warn">sudo</span>{/if}
    </div>
    {#if itemDescription(recipe) || meta?.os.length}
      <p class="mt-1 text-meta text-muted">
        {itemDescription(recipe)}{#if meta?.os.length}<span> · {meta.os.join(", ")}</span>{/if}
      </p>
    {/if}
    <div class="mt-1.5 flex items-center gap-0.5" role="tablist">
      {#each [["run", t("scenarios.recipe.tabRun")], ["code", `${t("scenarios.recipe.tabCode")} · ${recipe.file}`]] as [id, label] (id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === id}
          class="border-b-2 px-2 py-1 text-xs {tab === id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'}"
          onclick={() => (tab = id as "run" | "code")}>{label}</button
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
      <pre class="px-0 py-1.5 font-mono text-meta leading-relaxed" data-testid="recipe-code">{#each lines as l, i (i)}<span class="flex"><span class="w-8 shrink-0 select-none pr-2 text-right text-muted/60">{i + 1}</span><span class="whitespace-pre {/^\s*#/.test(l) ? 'text-muted' : 'text-text'}">{l}</span></span>{/each}</pre>
    {:else if !meta}
      <p class="p-3 text-xs text-warn">{t("scenarios.recipe.noHeader", { error: recipe.error ?? "" })}</p>
    {:else}
      <div class="space-y-3 p-3">
        {#if meta.params.length}
          <section>
            <h3 class="mb-1 text-meta text-muted">{t("scenarios.recipe.params")}</h3>
            <div class="grid grid-cols-[minmax(0,12rem)_1fr] items-center gap-x-3 gap-y-1.5">
              {#each meta.params as p (p.name)}
                {@const text = { label: p.label, hint: p.hint }}
                <label for="rp-{p.name}" class="truncate text-xs text-text" use:tooltip={p.name}>{text.label}{p.required ? " *" : ""}</label>
                {#if p.type === "bool"}
                  <input id="rp-{p.name}" type="checkbox" class="justify-self-start" checked={values[p.name] === "true"} onchange={(e) => (values[p.name] = String((e.currentTarget as HTMLInputElement).checked))} />
                {:else if p.type === "secret"}
                  <PasswordInput bind:value={values[p.name]} placeholder={text.hint} inputClass="w-full max-w-xs rounded border border-edge bg-panel px-2 py-0.5 font-mono text-xs text-text outline-none focus:border-accent" />
                {:else}
                  <input
                    id="rp-{p.name}"
                    class="w-full max-w-xs rounded border border-edge bg-panel px-2 py-0.5 font-mono text-xs text-text outline-none focus:border-accent"
                    placeholder={text.hint}
                    bind:value={values[p.name]}
                    oninput={() => (problem = "")}
                  />
                {/if}
              {/each}
            </div>
          </section>
        {/if}

        <section>
          <h3 class="mb-1 flex items-center gap-2 text-meta text-muted">
            {t("scenarios.recipe.servers", { count: picked.length })}
            <span class="ml-auto">{t("scenarios.recipe.viaVterm")}</span>
          </h3>
          <TargetPicker {servers} bind:selected={picked} {connected} />
        </section>

        <section class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text">
          <span class="text-meta text-muted">{t("scenarios.recipe.runAs")}</span>
          {#each [["user", t("scenarios.recipe.asUser")], ["sudo", t("scenarios.recipe.asSudo")], ["sudoPassword", t("scenarios.recipe.asSudoPassword")]] as [id, label] (id)}
            <label class="flex items-center gap-1"><input type="radio" name="elev-{recipe.id}" value={id} bind:group={elevation} />{label}</label>
          {/each}
          {#if elevation === "sudoPassword"}
            <PasswordInput bind:value={password} placeholder={t("sudo.passwordOptional")} class="w-72" inputClass="w-full rounded border border-edge bg-panel px-2 py-0.5 text-xs text-text outline-none focus:border-accent" />
          {/if}
        </section>

        {#if prodPicked.length}
          <div class="flex items-center gap-1.5 rounded border border-danger/50 bg-danger/10 px-2 py-1 text-xs text-danger">
            <Icon name="alert" size={13} />{t("scenarios.recipe.prodPicked", { names: prodPicked.map((s) => s.alias).join(", ") })}
          </div>
        {/if}

        <div class="flex flex-wrap items-center gap-2">
          {#if meta.check}
            <button type="button" class="rounded border border-edge px-2.5 py-1 text-xs text-text hover:border-accent" data-testid="recipe-check" onclick={() => go("check")}>
              {t("scenarios.recipe.check")}
            </button>
          {/if}
          <button
            type="button"
            class="flex items-center gap-1 rounded border px-2.5 py-1 text-xs {prodPicked.length ? 'border-danger/60 bg-danger/10 text-danger' : 'border-accent/50 bg-accent/10 text-accent'}"
            data-testid="recipe-run"
            onclick={() => go("apply")}
          >
            <Icon name="play" size={12} />{t("scenarios.recipe.run", { count: picked.length })}
          </button>
          {#if problem}<span class="text-meta text-danger" role="alert">{problem}</span>{/if}
          {#if !problem && meta.check}<span class="text-meta text-muted">{t("scenarios.recipe.checkHint")}</span>{/if}
        </div>

        {#if last}
          <section>
            <h3 class="mb-1 text-meta text-muted">
              {last.mode === "check" ? t("scenarios.recipe.lastCheck") : t("scenarios.recipe.lastRun")}
            </h3>
            <RunHosts run={last} onask={onask ? (h) => onask?.(last, h) : undefined} />
          </section>
        {/if}
      </div>
    {/if}
  </div>
</div>
