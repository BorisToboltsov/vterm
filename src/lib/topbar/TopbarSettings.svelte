<script lang="ts">
  // "Top bar" settings section (v1.16): which buttons stand at the right end of
  // the top bar. The same list as the bar's right-click menu, as checkboxes —
  // several can be changed without reopening a menu. Utilities and Settings are
  // listed ticked and cannot be unticked; the order is changed on the bar itself,
  // by dragging — and here, button by button (v1.35), which reaches the buttons
  // under «⋯» too: the bar does not drag what it does not draw.
  // The rule lives in topbaractions.ts, the value in `settings.topbar`.
  import { actionCommand, BUILTIN_ACTIONS, canUnpin, utilAction, type TopbarId } from "./topbaractions";
  import { actionIcon, actionLabel } from "./topbarui";
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { UTILITIES } from "../utilities/utilities";
  import { isPinned, moveAction, pinAction, resetTopbar, unpinAction } from "../stores/topbarpins.svelte";
  import { settings } from "../settings/settings.svelte";
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
  <!-- The order of the bar, left to right: what the bar draws, and what is under «⋯». -->
  <p class="mb-1.5 mt-3 text-xs text-muted">{t("settings.topbarOrder")}</p>
  <ol class="space-y-0.5" data-testid="topbar-order">
    {#each settings.topbar as id, i (id)}
      <li class="flex items-center gap-1.5 text-xs text-muted" data-testid={`topbar-order-${id}`}>
        <Icon name={actionIcon(id, settings.topbarCommands)} size={13} class="shrink-0" />
        <span class="min-w-0 flex-1 truncate">{actionLabel(id, settings.topbarCommands)}</span>
        <button
          type="button"
          class="rounded p-0.5 hover:bg-edge hover:text-text disabled:opacity-30"
          aria-label={t("settings.topbarLeft")}
          use:tooltip={t("settings.topbarLeft")}
          disabled={i === 0}
          data-testid={`topbar-left-${id}`}
          onclick={() => moveAction(id, i - 1)}
        >
          <Icon name="chevronLeft" size={13} />
        </button>
        <button
          type="button"
          class="rounded p-0.5 hover:bg-edge hover:text-text disabled:opacity-30"
          aria-label={t("settings.topbarRight")}
          use:tooltip={t("settings.topbarRight")}
          disabled={i === settings.topbar.length - 1}
          data-testid={`topbar-right-${id}`}
          onclick={() => moveAction(id, i + 2)}
        >
          <Icon name="chevronRight" size={13} />
        </button>
        {#if actionCommand(id) !== null}
          <!-- A ⌘K command (v1.35) has no box above to untick: it is taken off here. -->
          <button
            type="button"
            class="rounded p-0.5 hover:bg-edge hover:text-danger"
            aria-label={t("topbar.unpin")}
            use:tooltip={t("topbar.unpin")}
            data-testid={`topbar-remove-${id}`}
            onclick={() => unpinAction(id)}
          >
            <Icon name="close" size={13} />
          </button>
        {/if}
      </li>
    {/each}
  </ol>
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
