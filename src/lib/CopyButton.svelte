<script lang="ts">
  // Small reusable "copy to clipboard" button used across the Utilities panel
  // (Phase 33). Shows a transient check after copying; disabled while empty.
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";

  let {
    text = "",
    label,
    testid,
    class: cls = "",
  }: {
    /** Text placed on the clipboard when clicked. */
    text?: string;
    /** Optional visible label (falls back to the generic "Copy"). */
    label?: string;
    testid?: string;
    class?: string;
  } = $props();

  let copied = $state(false);

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked — selectable text is the fallback */
    }
  }
</script>

<button
  type="button"
  data-testid={testid}
  class="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-muted hover:bg-edge hover:text-text disabled:opacity-40 {cls}"
  onclick={copy}
  disabled={!text}
  aria-label={label ?? t("util.copy")}
>
  <Icon name={copied ? "check" : "copy"} size={12} />
  {copied ? t("util.copied") : (label ?? t("util.copy"))}
</button>
