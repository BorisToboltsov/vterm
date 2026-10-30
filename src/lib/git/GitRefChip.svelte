<script lang="ts">
  // One label on a commit: a branch, a remote branch or a tag, in the colour of the
  // commit's line. `flat` drops the fill, for a row where the label follows the text
  // and only has to be found; a fill is for where it stands on its own.
  import Icon from "../ui/Icon.svelte";
  import type { IconName } from "../ui/icons";
  import type { RefLabel } from "./gitrefs";

  let {
    label,
    color = 0,
    flat = false,
  }: {
    label: RefLabel;
    /** The commit's line (`--color-rail-N`). */
    color?: number;
    flat?: boolean;
  } = $props();

  const GLYPHS: Record<RefLabel["kind"], IconName> = {
    head: "gitBranch",
    local: "gitBranch",
    remote: "cloud",
    tag: "tag",
  };
</script>

<span
  class="ref {label.kind} {flat ? 'flat' : ''} text-caption"
  style:--c={`var(--color-rail-${color})`}
  data-testid="git-ref"
  data-kind={label.kind}
>
  <Icon name={GLYPHS[label.kind]} size={9} />
  <span class="min-w-0 truncate">{label.name}</span>
  {#if label.synced}<span data-testid="git-ref-synced" class="flex shrink-0"><Icon name="cloud" size={9} /></span>{/if}
</span>

<style>
  .ref {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    max-width: 100%;
    height: 16px;
    padding: 0 4px;
    border-radius: 3px;
    flex-shrink: 1;
  }
  .local {
    background: color-mix(in srgb, var(--c) 18%, transparent);
    color: color-mix(in srgb, var(--c) 72%, var(--color-text));
  }
  .head {
    background: var(--c);
    color: var(--color-panel-alt);
    font-weight: 600;
  }
  .remote {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 45%, transparent);
    color: color-mix(in srgb, var(--c) 60%, var(--color-muted));
  }
  .tag {
    box-shadow: inset 0 0 0 1px var(--color-edge);
    color: var(--color-muted);
  }
  .flat {
    background: none;
    box-shadow: none;
    padding: 0 2px;
    /* A row is read for its subject: a long remote name must not take it over. */
    max-width: 11rem;
  }
  .flat.local,
  .flat.head {
    color: color-mix(in srgb, var(--c) 78%, var(--color-text));
  }
</style>
