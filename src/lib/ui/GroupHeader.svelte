<script lang="ts">
  // The header of a group in a list (v1.29, ADR 0050) — the one header for a
  // compose stack, a pod's owner, a day of recordings, a stage of Git changes:
  // a chevron that folds it, the group's icon, its name and how many it holds;
  // to the right, room for a rollup (what a stack costs) and the group's own
  // actions. The group without a key (standalone containers, recordings with no
  // server) is named by a micro-label and comes last — `listview.ts` puts it
  // there. Presentational — the caller owns which groups are folded.
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import type { IconName } from "./icons";

  let {
    label,
    count,
    collapsed,
    ontoggle,
    icon = undefined,
    rest = false,
    kind = undefined,
    hint = undefined,
    testid = "group-header",
    summary,
    actions,
  }: {
    label: string;
    count: number;
    collapsed: boolean;
    ontoggle: () => void;
    icon?: IconName;
    /** The group without a key: a micro-label, no icon. */
    rest?: boolean;
    /** What the group is, as a micro-label at the right (a workload's kind). */
    kind?: string;
    /** A tooltip over the name (a compose stack's working directory). */
    hint?: string;
    testid?: string;
    summary?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5" data-testid={testid}>
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
    aria-expanded={!collapsed}
    data-testid="{testid}-toggle"
    onclick={ontoggle}
  >
    <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} class="shrink-0 text-muted" />
    {#if rest}
      <span class="min-w-0 truncate text-caption uppercase tracking-wider text-muted">{label}</span>
    {:else}
      {#if icon}<Icon name={icon} size={13} class="shrink-0 text-accent" />{/if}
      {#if hint}
        <span class="min-w-0 truncate font-medium text-text/85" use:tooltip={hint}>{label}</span>
      {:else}
        <span class="min-w-0 truncate font-medium text-text/85">{label}</span>
      {/if}
    {/if}
    <span class="shrink-0 text-caption tabular-nums text-muted" data-testid="{testid}-count">{count}</span>
  </button>
  {#if kind}<span class="shrink-0 text-caption uppercase tracking-wider text-muted">{kind}</span>{/if}
  {@render summary?.()}
  {@render actions?.()}
</div>
