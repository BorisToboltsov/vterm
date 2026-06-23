<script lang="ts">
  // Application top bar: brand and the active connection status. Pure
  // presentational. The "Add server" action lives in the server tree toolbar.

  let { status }: { status: string } = $props();
</script>

<header class="flex items-center gap-2 border-b border-edge bg-panel-alt px-3 py-2">
  <span class="mr-2 font-semibold tracking-wide text-accent">vterm</span>
  <span class="ml-auto text-xs text-muted">{status}</span>
</header>
