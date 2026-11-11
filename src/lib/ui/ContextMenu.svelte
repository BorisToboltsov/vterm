<script lang="ts">
  // Shared right-click menu shell. Renders an `OpenMenu` (position + declarative
  // items) from any surface; the contract lives in [ctxmenu.ts](./ctxmenu.ts).
  // Backdrop swallows the next click/right-click to close; Esc closes. Explicit
  // z-index (backdrop z-40 / menu z-50) per the overlay invariant.
  import Icon from "./Icon.svelte";
  import { t } from "../i18n";
  import { clampMenuPosition, isAction, menuPathOpen, toggleMenuPath, type MenuAction, type MenuItem, type OpenMenu } from "./ctxmenu";

  let { menu, onclose }: { menu: OpenMenu | null; onclose: () => void } = $props();

  let width = $state(0);
  let height = $state(0);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  const pos = $derived(clampMenuPosition(menu?.x ?? 0, menu?.y ?? 0, width, height, viewportWidth, viewportHeight));
  let expanded = $state<string[]>([]);

  // Dimensions update after expansion and on viewport resize as well as opening.
  // A fresh menu always starts collapsed, even when it replaces another one.
  $effect(() => {
    if (menu) expanded = [];
  });

  function pick(action: MenuAction) {
    if (action.disabled) return;
    // Close first so an action that opens its own dialog isn't dismissed by the
    // backdrop teardown, then run it.
    onclose();
    action.onSelect();
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} onkeydown={(e) => menu && e.key === "Escape" && onclose()} />

<!-- The tick column of a switch row: kept whether the row is on or off, so a
     checklist's labels line up. A row that is not a switch has none. -->
{#snippet tick(action: MenuAction)}
  {#if action.checked !== undefined}
    <span class="flex w-3.5 shrink-0 justify-center" data-checked={action.checked}>
      {#if action.checked}<Icon name="check" size={13} />{/if}
    </span>
  {/if}
{/snippet}

<!-- The figure at the right of a row (how many items a facet value keeps). -->
{#snippet hint(action: MenuAction)}
  {#if action.hint !== undefined}
    <span class="shrink-0 text-caption tabular-nums text-muted">{action.hint}</span>
  {/if}
{/snippet}

{#snippet rows(items: MenuItem[], path: string[])}
  {#each items as item, i (i)}
    {#if item.kind === "separator"}
      <div class="my-1 border-t border-edge/60"></div>
    {:else if item.kind === "submenu"}
      {@const next = [...path, item.key]}
      {@const opened = menuPathOpen(expanded, next)}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-2 py-1 text-left text-muted hover:bg-edge hover:text-text"
        style:padding-left={`${0.5 + path.length * 1.5}rem`}
        role="menuitem"
        aria-expanded={opened}
        onclick={() => (expanded = toggleMenuPath(expanded, next))}
      >
        {#if item.icon}<Icon name={item.icon} size={13} />{/if}
        <span class="flex-1 truncate">{item.label}</span>
        <Icon name={opened ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      {#if opened}{@render rows(item.items, next)}{/if}
    {:else if isAction(item)}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-edge hover:text-text disabled:pointer-events-none disabled:opacity-40 {item.danger ? 'text-danger' : 'text-muted'}"
        style:padding-left={`${0.5 + path.length * 1.5}rem`}
        role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={item.checked}
        disabled={item.disabled}
        onclick={() => pick(item)}
      >
        {#if item.checked !== undefined}
          {@render tick(item)}
        {:else if path.length === 0 && item.icon}
          <Icon name={item.icon} size={13} />
        {/if}
        <span class="flex-1 truncate">{item.label}</span>
        {@render hint(item)}
      </button>
    {/if}
  {/each}
{/snippet}

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
    bind:offsetWidth={width}
    bind:offsetHeight={height}
    class="fixed z-50 max-h-[calc(100dvh-0.5rem)] min-w-52 max-w-72 overflow-y-auto rounded-md border border-edge bg-panel py-1 text-xs shadow-lg"
    style="left:{pos.x}px; top:{pos.y}px"
    role="menu"
  >
    {@render rows(menu.items, [])}
  </div>
{/if}
