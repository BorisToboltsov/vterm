<script lang="ts">
  // Reusable modal shell: dimmed backdrop + centered card. Controlled via `open`
  // + `onclose` (backdrop click or Escape). Content is passed as children.
  import type { Snippet } from "svelte";
  import { t } from "./i18n";

  let {
    open = false,
    title,
    titleClass = "text-accent",
    width = "w-80",
    onclose,
    children,
  }: {
    open?: boolean;
    title?: string;
    titleClass?: string;
    /** Tailwind width class for the card. */
    width?: string;
    onclose?: () => void;
    children?: Snippet;
  } = $props();

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose?.();
  }

  // Accessibility: trap Tab within the dialog, focus the first control on open,
  // and restore focus to whatever opened it on close. Runs while the card is
  // mounted (i.e. only when `open`), so `destroy` fires exactly on close.
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trap(node: HTMLElement) {
    const opener = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusable()[0] ?? node).focus();

    function onKeydown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    node.addEventListener("keydown", onKeydown);
    return {
      destroy() {
        node.removeEventListener("keydown", onKeydown);
        opener?.focus?.();
      },
    };
  }
</script>

<svelte:window onkeydown={open ? onKey : undefined} />

{#if open}
  <div class="fixed inset-0 z-40 flex items-center justify-center">
    <button
      class="absolute inset-0 bg-black/50"
      aria-label={t("common.closeDialog")}
      onclick={() => onclose?.()}
    ></button>
    <div
      use:trap
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      class="relative {width} max-h-[90vh] max-w-[95vw] overflow-auto rounded-lg border border-edge bg-panel-alt p-4 outline-none"
    >
      {#if title}
        <h2 class="mb-3 text-sm font-semibold {titleClass}">{title}</h2>
      {/if}
      {@render children?.()}
    </div>
  </div>
{/if}
