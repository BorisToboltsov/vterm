<script lang="ts">
  // Settings → Journal (ADR 0062): the journal itself — the same list its
  // button opens — with the button's place on the top bar (a pin, as a tool of
  // the Utilities window has), whether the journal outlives the app and for how
  // long, and the way to clear it. Taken off the bar, the button does not take
  // the journal with it: it is here, and in ⌘K. What the switches mean for the
  // disk is the backend's (`journal.rs`), told by the main window.
  //
  // Two layers in one place (ADR 0063): «Messages» — what was said to the user —
  // and «Diagnostics» — what the app did, the same kind of list over the
  // backend's file. The bell's popover shows the messages alone.
  import Icon from "../ui/Icon.svelte";
  import InfoHint from "../ui/InfoHint.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import { tooltip } from "../actions/tooltip";
  import { settings } from "../settings/settings.svelte";
  import { clearJournal, journalState } from "../stores/journal.svelte";
  import { isPinned, pinAction, unpinAction } from "../stores/topbarpins.svelte";
  import { JOURNAL_DAYS, JOURNAL_ICON, JOURNAL_MAX_ENTRIES } from "./journal";
  import JournalList from "./JournalList.svelte";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import DiagSettings from "../diag/DiagSettings.svelte";
  import DiagList from "../diag/DiagList.svelte";
  import { t } from "../i18n";

  let { here }: { here: string } = $props();

  let asking = $state(false);
  let layer = $state<"messages" | "diagnostics">("messages");
  const onBar = $derived(isPinned("journal"));
</script>

<section data-testid="settings-journal">
  <div class="mb-2 flex items-center gap-2">
    <h3 class="flex-1 text-xs uppercase tracking-wider text-muted">{t("settings.sectionJournal")}</h3>
    <!-- The journal's button on the top bar, a click away — or not: the journal stays here either way. -->
    <button
      type="button"
      class="flex shrink-0 items-center rounded p-1 hover:bg-edge {onBar ? 'text-accent' : 'text-muted hover:text-text'}"
      aria-label={onBar ? t("topbar.unpin") : t("topbar.pin")}
      aria-pressed={onBar}
      use:tooltip={onBar ? t("topbar.unpin") : t("topbar.pin")}
      data-testid="journal-pin"
      onclick={() => (onBar ? unpinAction("journal") : pinAction("journal"))}
    >
      <Icon name="pin" size={14} />
    </button>
  </div>
  <p class="mb-3 flex items-center gap-1.5 text-meta text-muted" data-testid="journal-pin-state">
    <Icon name={JOURNAL_ICON} size={12} class="shrink-0" />
    {onBar ? t("settings.journalOnBar") : t("settings.journalOffBar")}
  </p>

  <div class="mb-3 flex items-center gap-1.5">
    <SegmentedControl
      bind:value={layer}
      label={t("journal.layer")}
      testid="journal-layer"
      options={[
        { value: "messages", label: t("journal.layer.messages") },
        { value: "diagnostics", label: t("journal.layer.diagnostics") },
      ]}
    />
    {#if layer === "diagnostics"}<InfoHint text={t("diag.hint")} />{/if}
  </div>

  {#if layer === "diagnostics"}
    <DiagSettings />
    <div class="mt-4 flex h-[26rem] flex-col overflow-hidden rounded border border-edge bg-panel-alt text-xs text-text">
      <DiagList {here} testid="settings-diag-list" />
    </div>
  {:else}
  <label class="flex items-center gap-2 text-xs text-muted">
    <input type="checkbox" data-testid="journal-keep" bind:checked={settings.journalKeep} />
    {t("settings.journalKeep")}<InfoHint text={t("settings.journalKeepHint")} />
  </label>
  <label class="mt-3 block text-xs text-muted">
    {t("settings.journalDays")}
    <select
      data-testid="journal-days"
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
      bind:value={settings.journalDays}
      disabled={!settings.journalKeep}
    >
      {#each JOURNAL_DAYS as days (days)}
        <option value={days}>{t(`settings.journalAge.${days}`)}</option>
      {/each}
    </select>
  </label>
  <p class="mt-1 text-meta text-muted">{t("settings.journalCap", { n: JOURNAL_MAX_ENTRIES })}</p>
  <div class="mt-3 flex items-center gap-2">
    <button
      type="button"
      class="rounded border border-danger px-2.5 py-1 text-xs text-danger hover:bg-danger/15 disabled:opacity-40"
      data-testid="journal-clear"
      disabled={journalState.summary.total === 0}
      onclick={() => (asking = true)}>{t("settings.journalClear")}</button
    >
    <span class="text-meta text-muted">{t("settings.journalSize", { n: journalState.summary.total })}</span>
  </div>

  <!-- The journal itself: the list its button opens. -->
  <div class="mt-4 flex h-[26rem] flex-col overflow-hidden rounded border border-edge bg-panel-alt text-xs text-text">
    <JournalList {here} testid="settings-journal-list" />
  </div>
  {/if}
</section>

<ConfirmDialog
  open={asking}
  title={t("journal.confirmTitle")}
  confirmLabel={t("journal.clear")}
  onconfirm={() => {
    asking = false;
    void clearJournal().catch(() => {});
  }}
  oncancel={() => (asking = false)}
>
  {t("journal.confirmAll", { n: journalState.summary.total })}
</ConfirmDialog>
