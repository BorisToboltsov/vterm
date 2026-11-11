<script lang="ts">
  // Non-blocking toast container (bottom-right). Reads the global toasts store
  // and renders each entry per the design system; auto-dismiss is owned by the
  // store, the × button dismisses manually.
  //
  // No more than `MAX_TOASTS` stand at once (ADR 0062): a burst of errors
  // used to stack up the whole height of the window and take the clicks of
  // everything under it. The rest wait under one line that opens the journal,
  // where every message is kept anyway; the same message said again counts up
  // on its toast (`×14`) instead of standing a second one.
  import { fly, fade } from "svelte/transition";
  import { flip } from "svelte/animate";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
  import { motion, MOTION_BASE } from "./motion";
  import { clearToasts, dismissToast, toastsState, type Toast, type ToastKind } from "../stores/toasts.svelte";
  import { openJournal } from "../stores/journal.svelte";
  import { fitToasts, JOURNAL_ICON } from "../notifications/journal";
  import { t } from "../i18n";

  const ICON: Record<ToastKind, IconName> = {
    error: "alert",
    success: "check",
    info: "info",
  };
  // Accent border + matching icon colour; message text stays fully readable.
  const TONE: Record<ToastKind, string> = {
    error: "border-danger text-danger",
    success: "border-ok text-ok",
    info: "border-accent text-accent",
  };

  const fit = $derived(fitToasts(toastsState.list));

  /** What the toast is about: its server and the part of the app that said it. */
  function aboutOf(toast: Toast): string {
    return [toast.server, toast.source ? t(`journal.source.${toast.source}`) : null].filter(Boolean).join(" · ");
  }
</script>

<div
  data-testid="toasts"
  class="pointer-events-none fixed bottom-3 right-3 z-50 flex max-h-[calc(100dvh-1.5rem)] w-80 max-w-[90vw] flex-col gap-2 overflow-hidden"
>
  {#each fit.shown as toast (toast.id)}
    {@const about = aboutOf(toast)}
    <!-- Unlike the modal, a toast *should* animate out: nothing here traps focus or
         covers the app, and a toast vanishing while the rest of the stack jumps up
         to fill the gap is the jarring case. `flip` moves the survivors. -->
    <div
      role="status"
      class="pointer-events-auto flex items-start gap-2 rounded-lg border bg-panel-alt px-3 py-2 text-xs shadow-lg {TONE[
        toast.kind
      ]}"
      in:fly={{ ...motion(MOTION_BASE), y: 10 }}
      out:fade={motion()}
      animate:flip={motion()}
    >
      <Icon name={ICON[toast.kind]} size={15} class="mt-0.5 shrink-0" />
      <span class="min-w-0 flex-1">
        <span class="line-clamp-4 break-words text-text">{toast.message}</span>
        {#if about}<span class="block truncate text-meta text-muted" data-testid="toast-about">{about}</span>{/if}
      </span>
      {#if toast.count > 1}
        <span
          class="shrink-0 rounded border border-current px-1 text-meta tabular-nums"
          data-testid="toast-count">×{toast.count}</span
        >
      {/if}
      <button
        class="flex shrink-0 items-center text-muted hover:text-text"
        aria-label={t("common.dismiss")}
        onclick={() => dismissToast(toast.id)}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  {/each}
  {#if fit.hidden > 0}
    <div
      class="pointer-events-auto flex items-center gap-2 rounded-lg border border-edge bg-panel-alt px-3 py-1.5 text-meta text-muted shadow-lg"
      data-testid="toasts-more"
      in:fade={motion()}
    >
      <Icon name={JOURNAL_ICON} size={13} class="shrink-0" />
      <span class="min-w-0 flex-1 truncate">{t("toast.more", { n: fit.hidden })}</span>
      <button
        type="button"
        class="shrink-0 rounded px-1 text-accent hover:bg-edge"
        data-testid="toasts-open-journal"
        onclick={() => void openJournal()}>{t("toast.openJournal")}</button
      >
      <button
        type="button"
        class="shrink-0 rounded px-1 text-accent hover:bg-edge"
        data-testid="toasts-hide-all"
        onclick={clearToasts}>{t("toast.hideAll")}</button
      >
    </div>
  {/if}
</div>
