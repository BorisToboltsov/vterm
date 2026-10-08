<script lang="ts">
  // The pane a wide tool panel opens beside its list (v1.7): logs, inspect, the
  // details of a container or a pod — what a narrow dock has to open as a dialog
  // because it has no room. Not a dialog: it covers nothing and traps no focus,
  // and the list next to it stays live, so another row can be picked while it is
  // open. Title, a close button, the content below. The line between it and
  // the list is the panel's divider (`PanelDivider`), not a border of its own.
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";

  let {
    title,
    onclose,
    testid,
    children,
  }: {
    title: string;
    onclose?: () => void;
    testid?: string;
    children?: Snippet;
  } = $props();
</script>

<section
  class="flex h-full min-h-0 min-w-0 flex-col"
  aria-label={title}
  data-testid={testid}
>
  <div class="flex items-center gap-1.5 border-b border-edge px-2.5 py-1">
    <span class="min-w-0 flex-1 truncate font-medium text-text/90">{title}</span>
    {#if onclose}
      <button
        class="flex shrink-0 items-center rounded p-1 text-muted hover:bg-edge hover:text-text"
        aria-label={t("common.close")}
        use:tooltip={t("common.close")}
        data-testid="side-pane-close"
        onclick={() => onclose?.()}
      >
        <Icon name="close" size={14} />
      </button>
    {/if}
  </div>
  <div class="flex min-h-0 flex-1 flex-col p-2.5">
    {@render children?.()}
  </div>
</section>
