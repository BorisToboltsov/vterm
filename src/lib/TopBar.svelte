<script lang="ts">
  // Application top bar: brand, "Add server" action, and the active connection
  // status. Pure presentational — all behaviour is delegated via callbacks.
  import Icon from "./Icon.svelte";

  let { status, onAdd }: { status: string; onAdd: () => void } = $props();
</script>

<header class="flex items-center gap-2 border-b border-edge bg-panel-alt px-3 py-2">
  <span class="mr-2 font-semibold tracking-wide text-accent">vterm</span>
  <button
    data-testid="add-server"
    class="flex shrink-0 items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
    title="Add server"
    aria-label="Add server"
    onclick={onAdd}
  >
    <Icon name="plus" size={14} />
  </button>
  <span class="ml-auto text-xs text-muted">{status}</span>
</header>
