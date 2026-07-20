<script lang="ts">
  // Non-blocking toast container (bottom-right). Reads the global toasts store
  // and renders each entry per the design system; auto-dismiss is owned by the
  // store, the × button dismisses manually.
  import { fly, fade } from "svelte/transition";
  import { flip } from "svelte/animate";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
  import { motion, MOTION_BASE } from "./motion";
  import { dismissToast, toastsState, type ToastKind } from "./stores/toasts.svelte";
  import { t } from "./i18n";

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
</script>

<div
  data-testid="toasts"
  class="pointer-events-none fixed bottom-3 right-3 z-50 flex w-80 max-w-[90vw] flex-col gap-2"
>
  {#each toastsState.list as toast (toast.id)}
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
      <span class="min-w-0 flex-1 break-words text-text">{toast.message}</span>
      <button
        class="flex shrink-0 items-center text-muted hover:text-white"
        aria-label={t("common.dismiss")}
        onclick={() => dismissToast(toast.id)}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  {/each}
</div>
