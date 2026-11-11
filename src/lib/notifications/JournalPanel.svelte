<script lang="ts">
  // The journal of notifications under the bell of the top bar (ADR 0062): a
  // popover, not a dialog — it does not darken the app, and a press anywhere
  // else or Esc puts it away. The list is `JournalList`, the same one Settings →
  // Journal shows; the journal itself is the backend's, one for all the windows.
  import { onMount, tick } from "svelte";
  import { fade } from "svelte/transition";
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { motion } from "../ui/motion";
  import { t } from "../i18n";
  import { closeJournal } from "../stores/journal.svelte";
  import JournalList from "./JournalList.svelte";

  let {
    anchor,
    here,
    onsettings,
  }: {
    /** The bell: the panel stands under it, and a press on it is not "elsewhere". */
    anchor: HTMLElement | null;
    /** This window's label — a message said here does not name its window. */
    here: string;
    /** The Journal section of Settings: how long the journal is kept, the bell itself. */
    onsettings: () => void;
  } = $props();

  let panel: HTMLDivElement | undefined = $state();
  let busy = $state(false);
  let place = $state({ top: 0, right: 0 });

  function measure() {
    const box = anchor?.getBoundingClientRect();
    place = box
      ? { top: box.bottom + 4, right: Math.max(8, window.innerWidth - box.right) }
      : { top: 40, right: 8 };
  }

  /** A press anywhere but the panel or the bell puts it away — not while its menu or question is up. */
  function onPointerDown(e: PointerEvent) {
    if (busy) return;
    const target = e.target as Node | null;
    if (target && (panel?.contains(target) || anchor?.contains(target))) return;
    closeJournal();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || busy) return;
    e.preventDefault();
    e.stopPropagation();
    closeJournal();
    // Put away from the keyboard, the keyboard goes back to the bell; a press
    // elsewhere keeps the focus where it went.
    anchor?.focus();
  }

  onMount(() => {
    measure();
    void tick().then(() => panel?.focus());
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", measure);
    };
  });
</script>

<div
  bind:this={panel}
  role="dialog"
  aria-label={t("journal.title")}
  tabindex="-1"
  data-testid="journal-panel"
  class="fixed z-40 flex max-h-[min(70vh,40rem)] w-[28rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-edge bg-panel-alt text-xs text-text shadow-lg outline-none"
  style="top: {place.top}px; right: {place.right}px"
  onkeydown={onKeydown}
  transition:fade={motion()}
>
  <div class="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
    <span class="text-sm font-medium">{t("journal.title")}</span>
    <span class="flex-1"></span>
    <button
      type="button"
      class="flex rounded p-1 text-muted hover:bg-edge hover:text-text"
      aria-label={t("journal.settings")}
      use:tooltip={t("journal.settings")}
      data-testid="journal-settings"
      onclick={onsettings}
    >
      <Icon name="settings" size={14} />
    </button>
  </div>
  <JournalList {here} onbusy={(b) => (busy = b)} floor="min-h-56" />
</div>
