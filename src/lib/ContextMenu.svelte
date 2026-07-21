<script lang="ts">
  // Shared right-click menu shell. Renders an `OpenMenu` (position + declarative
  // items) from any surface; the contract lives in [ctxmenu.ts](./ctxmenu.ts).
  // Backdrop swallows the next click/right-click to close; Esc closes. Explicit
  // z-index (backdrop z-40 / menu z-50) per the overlay invariant.
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";
  import { clampMenuPosition, isAction, type MenuAction, type OpenMenu } from "./ctxmenu";

  let { menu, onclose }: { menu: OpenMenu | null; onclose: () => void } = $props();

  let el = $state<HTMLDivElement | undefined>();
  let pos = $state({ x: 0, y: 0 });
  let expanded = $state<string | null>(null);

  // Position at the requested point, then clamp once the real size is known
  // (this effect runs after the DOM updates, so `el` is measured). Reset any
  // expanded submenu whenever a fresh menu opens.
  $effect(() => {
    if (!menu) {
      expanded = null;
      return;
    }
    const { x, y } = menu;
    pos = { x, y };
    if (el) {
      pos = clampMenuPosition(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight);
    }
  });

  function pick(action: MenuAction) {
    if (action.disabled) return;
    // Close first so an action that opens its own dialog isn't dismissed by the
    // backdrop teardown, then run it.
    onclose();
    action.onSelect();
  }
</script>

<svelte:window onkeydown={(e) => menu && e.key === "Escape" && onclose()} />

{#if menu}
  <button
    type="button"
    aria-label={t("common.closeDialog")}
    class="fixed inset-0 z-40 cursor-default"
    onclick={onclose}
    oncontextmenu={(e) => {
      e.preventDefault();
      onclose();
    }}
  ></button>
  <div
    bind:this={el}
    class="fixed z-50 min-w-52 max-w-72 rounded-md border border-edge bg-panel py-1 text-xs shadow-lg"
    style="left:{pos.x}px; top:{pos.y}px"
    role="menu"
  >
    {#each menu.items as item, i (i)}
      {#if item.kind === "separator"}
        <div class="my-1 border-t border-edge/60"></div>
      {:else if item.kind === "submenu"}
        <button
          type="button"
          class="flex w-full items-center gap-2 px-2 py-1 text-left text-muted hover:bg-edge hover:text-text"
          role="menuitem"
          onclick={() => (expanded = expanded === item.key ? null : item.key)}
        >
          {#if item.icon}<Icon name={item.icon} size={13} />{/if}
          <span class="flex-1 truncate">{item.label}</span>
          <Icon name={expanded === item.key ? "chevronDown" : "chevronRight"} size={12} />
        </button>
        {#if expanded === item.key}
          {#each item.items as sub, j (j)}
            <button
              type="button"
              class="flex w-full items-center gap-2 py-1 pl-8 pr-2 text-left hover:bg-edge hover:text-text {sub.danger
                ? 'text-danger'
                : 'text-muted'}"
              role="menuitem"
              onclick={() => pick(sub)}
            >
              <span class="flex-1 truncate">{sub.label}</span>
            </button>
          {/each}
        {/if}
      {:else if isAction(item)}
        <button
          type="button"
          class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-edge hover:text-text disabled:pointer-events-none disabled:opacity-40 {item.danger
            ? 'text-danger'
            : 'text-muted'}"
          role="menuitem"
          disabled={item.disabled}
          onclick={() => pick(item)}
        >
          {#if item.icon}<Icon name={item.icon} size={13} />{/if}
          <span class="flex-1 truncate">{item.label}</span>
        </button>
      {/if}
    {/each}
  </div>
{/if}
