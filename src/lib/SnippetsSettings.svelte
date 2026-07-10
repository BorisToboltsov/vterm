<script lang="ts">
  // Editor snippets/templates settings section (Phase 12.8): a collapsible,
  // language-filterable list of user-editable snippets with add/reset/delete.
  // Extracted from SettingsPanel.svelte in Phase 18.5; owns its delete-confirm
  // dialog and reads/writes the settings store directly.
  import { settings } from "./settings.svelte";
  import { tooltip } from "./actions/tooltip";
  import { defaultSnippets, newSnippet, SNIPPET_LANGS, type Snippet } from "./snippets";
  import type { EditorLangKind } from "./editorlang";
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import DisclosureRow from "./DisclosureRow.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { t } from "./i18n";
  import { slide } from "svelte/transition";

  let snippetDeleteId = $state<string | null>(null);
  let snippetResetOpen = $state(false);
  let snippetsOpen = $state(false);
  let snippetLangFilter = $state("");
  const filteredSnippets = $derived(
    snippetLangFilter
      ? settings.snippets.filter((s) => (s.lang ?? "") === snippetLangFilter)
      : settings.snippets,
  );

  function addSnippet() {
    settings.snippets = [...settings.snippets, newSnippet()];
    snippetLangFilter = ""; // ensure the freshly added (language-less) snippet is visible
  }
  function removeSnippet(id: string) {
    settings.snippets = settings.snippets.filter((s) => s.id !== id);
    snippetDeleteId = null;
  }
  function resetSnippets() {
    settings.snippets = defaultSnippets();
    snippetResetOpen = false;
  }
  function setSnippetLang(snippet: Snippet, value: string) {
    snippet.lang = (value || null) as EditorLangKind | null;
  }
</script>

<!-- Editor snippets/templates (Phase 12.8) — user-editable -->
<section>
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionSnippets")}<InfoHint text={t("settings.snippetsNote")} />
  </h3>
  <DisclosureRow
    variant="list"
    bind:open={snippetsOpen}
    testid="snippets-toggle"
    label={t("settings.snippetsToggle")}
    count={settings.snippets.length}
  />
  {#if snippetsOpen}
    <div class="mt-2 space-y-2" transition:slide>
      <label class="flex items-center gap-2 text-[11px] text-muted">
        {t("settings.snippetFilterLang")}
        <select
          data-testid="snippet-lang-filter"
          class="rounded border border-edge bg-panel px-1 py-1 text-xs text-white outline-none focus:border-accent"
          bind:value={snippetLangFilter}
        >
          <option value="">{t("settings.snippetAllLangs")}</option>
          {#each SNIPPET_LANGS as o (o.label)}
            {#if o.lang}
              <option value={o.lang}>{o.label}</option>
            {/if}
          {/each}
        </select>
      </label>
      <div class="space-y-2">
        {#each filteredSnippets as snippet (snippet.id)}
          <div class="rounded border border-edge p-2">
            <div class="flex items-center gap-2">
              <input
                class="min-w-0 flex-1 rounded border border-edge bg-panel px-2 py-1 text-xs text-white outline-none focus:border-accent"
                placeholder={t("settings.snippetName")}
                bind:value={snippet.name}
              />
              <select
                class="shrink-0 rounded border border-edge bg-panel px-1 py-1 text-xs text-white outline-none focus:border-accent"
                value={snippet.lang ?? ""}
                onchange={(e) => setSnippetLang(snippet, e.currentTarget.value)}
              >
                {#each SNIPPET_LANGS as o (o.label)}
                  <option value={o.lang ?? ""}>{o.label}</option>
                {/each}
              </select>
              <button
                class="shrink-0 rounded p-1 text-muted hover:text-danger"
                use:tooltip={t("common.delete")}
                aria-label={t("common.delete")}
                onclick={() => (snippetDeleteId = snippet.id)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
            <textarea
              rows="4"
              spellcheck="false"
              class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-[11px] text-white outline-none focus:border-accent"
              bind:value={snippet.body}
            ></textarea>
          </div>
        {/each}
      </div>
      <div class="flex gap-2">
        <button
          class="flex items-center gap-1 rounded bg-edge px-2 py-1 text-xs hover:bg-accent hover:text-panel-alt"
          onclick={addSnippet}
        >
          <Icon name="filePlus" size={13} />
          {t("settings.addSnippet")}
        </button>
        <button
          class="rounded px-2 py-1 text-xs text-muted hover:text-white"
          onclick={() => (snippetResetOpen = true)}
        >
          {t("settings.resetSnippets")}
        </button>
      </div>
    </div>
  {/if}
</section>

<ConfirmDialog
  open={!!snippetDeleteId}
  title={t("settings.snippetDeleteTitle")}
  confirmLabel={t("common.delete")}
  danger
  onconfirm={() => snippetDeleteId && removeSnippet(snippetDeleteId)}
  oncancel={() => (snippetDeleteId = null)}
>
  {t("settings.snippetDeleteBody")}
</ConfirmDialog>

<ConfirmDialog
  open={snippetResetOpen}
  title={t("settings.snippetResetTitle")}
  confirmLabel={t("settings.resetSnippets")}
  danger
  onconfirm={resetSnippets}
  oncancel={() => (snippetResetOpen = false)}
>
  {t("settings.snippetResetBody")}
</ConfirmDialog>
