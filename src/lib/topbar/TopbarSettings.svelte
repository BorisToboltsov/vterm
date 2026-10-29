<script lang="ts">
  // "Top bar" settings section (v1.16): which buttons stand at the right end of
  // the top bar. The same list as the bar's right-click menu, as checkboxes —
  // several can be changed without reopening a menu. Utilities and Settings are
  // listed ticked and cannot be unticked; the order is changed on the bar itself,
  // by dragging.
  // The rule lives in topbaractions.ts, the value in `settings.topbar`.
  import { BUILTIN_ACTIONS, canUnpin, utilAction, type TopbarId } from "./topbaractions";
  import { actionLabel } from "./topbarui";
  import { UTILITIES } from "../utilities/utilities";
  import { isPinned, pinAction, resetTopbar, unpinAction } from "../stores/topbarpins.svelte";
  import { notifySuccess } from "../stores/toasts.svelte";
  import InfoHint from "../ui/InfoHint.svelte";
  import { t } from "../i18n";

  const toggle = (id: TopbarId, on: boolean) => (on ? pinAction(id) : unpinAction(id));
</script>

{#snippet box(id: TopbarId)}
  <label class="flex items-center gap-2 text-xs text-muted">
    <input
      type="checkbox"
      data-testid={`topbar-pinned-${id}`}
      checked={isPinned(id)}
      disabled={!canUnpin(id)}
      onchange={(e) => toggle(id, e.currentTarget.checked)}
    />
    {actionLabel(id)}
  </label>
{/snippet}

<section data-settings-section="topbar">
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionTopbar")}<InfoHint text={t("settings.topbarNote")} />
  </h3>
  <p class="mb-1.5 text-xs text-muted">{t("settings.topbarShow")}</p>
  <div class="grid grid-cols-2 gap-1.5">
    {#each BUILTIN_ACTIONS as id (id)}
      {@render box(id)}
    {/each}
  </div>
  <!-- Where a button that was taken off is still found. -->
  <p class="mt-2 text-meta text-muted" data-testid="topbar-where">{t("settings.topbarWhere")}</p>
  <p class="mb-1.5 mt-3 text-xs text-muted">{t("topbar.tools")}</p>
  <div class="grid grid-cols-2 gap-1.5">
    {#each UTILITIES as u (u.id)}
      {@render box(utilAction(u.id))}
    {/each}
  </div>
  <button
    type="button"
    data-testid="topbar-reset"
    class="mt-3 rounded border border-edge px-2.5 py-1 text-xs text-muted hover:bg-edge hover:text-text"
    onclick={() => {
      resetTopbar();
      // The settings window covers the bar — say that something happened.
      notifySuccess(t("settings.topbarResetDone"));
    }}
  >
    {t("topbar.reset")}
  </button>
</section>
