<script lang="ts">
  // Friendly empty/onboarding state: a soft icon badge, a title, an optional
  // hint, and an optional slot for call-to-action buttons. Presentational —
  // reused for the empty server list and the no-session terminal area.
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";

  let {
    icon,
    title,
    hint,
    children,
  }: {
    icon: IconName;
    title: string;
    hint?: string;
    children?: Snippet;
  } = $props();
</script>

<div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
  <div
    class="flex h-14 w-14 items-center justify-center rounded-full border border-edge bg-panel-alt text-muted"
  >
    <Icon name={icon} size={26} />
  </div>
  <div class="space-y-1">
    <p class="text-sm font-medium text-text">{title}</p>
    {#if hint}
      <p class="mx-auto max-w-xs text-xs leading-relaxed text-muted">{hint}</p>
    {/if}
  </div>
  {#if children}
    <div class="flex flex-wrap items-center justify-center gap-2">
      {@render children()}
    </div>
  {/if}
</div>
