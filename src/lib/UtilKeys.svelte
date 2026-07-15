<script lang="ts">
  // Utilities → SSH key generator (Phase 33). The key-generation flow lives
  // entirely in KeyGenModal; this pane is just its home inside the Utilities panel
  // (moved out of Settings). The server-form "Generate…" shortcut still opens
  // KeyGenModal directly, so both entry points share one implementation.
  import Icon from "./Icon.svelte";
  import KeyGenModal from "./KeyGenModal.svelte";
  import { t } from "./i18n";

  let genOpen = $state(false);
</script>

<button
  type="button"
  data-testid="keygen-open"
  class="flex items-center gap-2 rounded bg-edge px-3 py-1.5 text-sm hover:bg-accent hover:text-panel-alt"
  onclick={() => (genOpen = true)}
>
  <Icon name="key" size={14} />{t("settings.keysGenerate")}
</button>

<KeyGenModal bind:open={genOpen} />
