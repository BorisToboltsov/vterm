<script lang="ts">
  // Compact "ⓘ" hint (Phase 20.19): a focusable info icon whose text shows in a
  // styled tooltip on hover/focus, replacing long inline hint paragraphs so forms
  // and the settings panel stay short. The text stays on `aria-label` for screen
  // readers; `use:tooltip` is the visual layer (portalled, so no clipping).
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";

  // `onclick` makes the ⓘ a deep-link (e.g. "open Settings → …"): the tooltip still
  // explains on hover, but a click navigates. Without it the icon is hover-only help.
  let {
    text,
    size = 12,
    onclick = undefined,
  }: { text: string; size?: number; onclick?: () => void } = $props();
</script>

<button
  type="button"
  aria-label={text}
  class="inline-flex align-middle text-muted/60 outline-none hover:text-muted focus-visible:text-accent {onclick
    ? 'cursor-pointer'
    : 'cursor-help'}"
  use:tooltip={text}
  {onclick}
>
  <Icon name="info" {size} />
</button>
