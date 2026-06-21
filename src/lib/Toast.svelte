<script lang="ts">
  // Non-blocking toast container (bottom-right). Reads the global toasts store
  // and renders each entry per the design system; auto-dismiss is owned by the
  // store, the × button dismisses manually.
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
  import { dismissToast, toastsState, type ToastKind } from "./stores/toasts.svelte";

  const ICON: Record<ToastKind, IconName> = {
    error: "alert",
    success: "check",
    info: "info",
  };
  // Accent border + matching icon colour; message text stays fully readable.
  const TONE: Record<ToastKind, string> = {
    error: "border-danger text-danger",
    success: "border-green-600 text-green-500",
    info: "border-accent text-accent",
  };
</script>

<div
  data-testid="toasts"
  class="pointer-events-none fixed bottom-3 right-3 z-50 flex w-80 max-w-[90vw] flex-col gap-2"
>
  {#each toastsState.list as t (t.id)}
    <div
      role="status"
      class="pointer-events-auto flex items-start gap-2 rounded-lg border bg-panel-alt px-3 py-2 text-xs shadow-lg {TONE[
        t.kind
      ]}"
    >
      <Icon name={ICON[t.kind]} size={15} class="mt-0.5 shrink-0" />
      <span class="min-w-0 flex-1 break-words text-text">{t.message}</span>
      <button
        class="flex shrink-0 items-center text-muted hover:text-white"
        aria-label="Dismiss"
        onclick={() => dismissToast(t.id)}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  {/each}
</div>
