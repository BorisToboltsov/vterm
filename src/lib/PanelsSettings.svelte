<script lang="ts">
  // "Panels" settings section (v1.1): which tool panels the docks offer. A hidden
  // panel is not drawn in any dock, is not polled and is not offered by ⌘K; its
  // place in the layout is kept, so it comes back where it stood. The server tree
  // is not listed — it cannot be hidden. The rule itself lives in docklayout.ts
  // (`HIDEABLE_PANELS`), the value in `settings.hiddenPanels`.
  import { HIDEABLE_PANELS } from "./docklayout";
  import { panelLabel } from "./dockui";
  import { isPanelHidden, resetPanelLayout, setPanelHidden } from "./stores/layout.svelte";
  import { notifySuccess } from "./stores/toasts.svelte";
  import InfoHint from "./InfoHint.svelte";
  import { t } from "./i18n";
</script>

<section data-settings-section="panels">
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionPanels")}<InfoHint text={t("settings.panelsNote")} />
  </h3>
  <p class="mb-1.5 text-xs text-muted">{t("settings.panelsShow")}</p>
  <div class="grid grid-cols-2 gap-1.5">
    {#each HIDEABLE_PANELS as id (id)}
      <label class="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          data-testid={`panel-visible-${id}`}
          checked={!isPanelHidden(id)}
          onchange={(e) => setPanelHidden(id, !e.currentTarget.checked)}
        />
        {panelLabel(id)}
      </label>
    {/each}
  </div>
  <button
    type="button"
    data-testid="panels-reset-layout"
    class="mt-3 rounded border border-edge px-2.5 py-1 text-xs text-muted hover:bg-edge hover:text-text"
    onclick={() => {
      resetPanelLayout();
      // The settings window covers the docks — say that something happened.
      notifySuccess(t("settings.panelsResetDone"));
    }}
  >
    {t("palette.resetLayout")}
  </button>
</section>
