<script lang="ts">
  // The tab that follows the pointer while a tool-panel tab is dragged between
  // docks (v1.1). One instance for the whole window — the drag is app-wide state
  // (stores/dockdrag.svelte.ts), not a dock's own.
  //
  // It is a copy of the tab that was picked up — same size, same look — because
  // the real one stays in its strip as the slot the other tabs make room for. It
  // hangs from the point it was grabbed at, and on release glides into that slot
  // before the real tab takes over.
  import { fade } from "svelte/transition";
  import { motion } from "./motion";
  import { panelLabel } from "./dockui";
  import { dockDrag } from "./stores/dockdrag.svelte";
</script>

<!-- pointer-events-none so the hit test still sees the dock underneath. -->
{#if dockDrag.panel}
  <div
    in:fade={motion()}
    data-testid="dock-drag-ghost"
    data-settling={dockDrag.settling || undefined}
    class="pointer-events-none fixed z-50 flex items-center justify-center overflow-hidden rounded-sm border border-accent bg-panel-alt shadow-lg {dockDrag.vertical
      ? 'text-meta uppercase tracking-wider text-text [writing-mode:vertical-rl]'
      : 'text-xs text-accent'} {dockDrag.settling ? 'vt-dock-settle' : ''}"
    style="left: {dockDrag.x}px; top: {dockDrag.y}px; width: {dockDrag.width}px; height: {dockDrag.height}px"
  >
    <span class="truncate">{panelLabel(dockDrag.panel)}</span>
  </div>
{/if}

<style>
  /* The glide into the slot. A CSS transition, so the reduced-motion guard in
     app.css covers it; the store does not start it at all when motion is off. */
  .vt-dock-settle {
    transition:
      left var(--motion-fast) ease-out,
      top var(--motion-fast) ease-out;
  }
</style>
