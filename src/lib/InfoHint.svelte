<script lang="ts">
  // Compact "ⓘ" hint (Phase 20.19): a focusable info icon whose text shows in a
  // styled tooltip on hover/focus, replacing long inline hint paragraphs so forms
  // and the settings panel stay short. The text stays on `aria-label` for screen
  // readers; `use:tooltip` is the visual layer (portalled, so no clipping).
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";

  let { text, size = 12 }: { text: string; size?: number } = $props();
</script>

<button
  type="button"
  aria-label={text}
  class="inline-flex cursor-help align-middle text-muted/60 outline-none hover:text-muted focus-visible:text-accent"
  use:tooltip={text}
>
  <Icon name="info" {size} />
</button>
