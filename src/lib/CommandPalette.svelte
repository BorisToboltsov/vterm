<script lang="ts">
  // Command palette (⌘K): a top-aligned overlay with a search box and a ranked,
  // keyboard-navigable list of commands. Generic — the parent supplies the
  // `commands` (each with its own `run`); matching/ranking lives in command.ts.
  import Icon from "./Icon.svelte";
  import { filterCommands, type CommandItem } from "./command";
  import { t } from "./i18n";

  let {
    open = $bindable(false),
    commands,
  }: { open?: boolean; commands: CommandItem[] } = $props();

  let query = $state("");
  let activeIndex = $state(0);

  const filtered = $derived(filterCommands(commands, query));

  // Fresh, empty palette every time it opens.
  $effect(() => {
    if (open) {
      query = "";
      activeIndex = 0;
    }
  });

  function close() {
    open = false;
  }

  function choose(item: CommandItem) {
    open = false;
    item.run();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[activeIndex];
      if (item) choose(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function autofocus(node: HTMLInputElement) {
    node.focus();
  }
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
    <button
      class="absolute inset-0 bg-black/50"
      aria-label={t("palette.closeAria")}
      onclick={close}
    ></button>
    <div
      class="relative z-10 flex max-h-[60vh] w-[34rem] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-edge bg-panel-alt shadow-xl"
    >
      <div class="flex items-center gap-2 border-b border-edge px-3 py-2">
        <Icon name="search" size={16} class="shrink-0 text-muted" />
        <input
          use:autofocus
          bind:value={query}
          oninput={() => (activeIndex = 0)}
          onkeydown={onKey}
          data-testid="command-input"
          class="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
          placeholder={t("palette.placeholder")}
          aria-label={t("palette.ariaLabel")}
        />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label={t("palette.listAria")}>
        {#each filtered as item, i (item.id)}
          <button
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm {i ===
            activeIndex
              ? 'bg-edge'
              : 'hover:bg-edge'}"
            onclick={() => choose(item)}
            onmousemove={() => (activeIndex = i)}
          >
            <Icon name={item.icon} size={15} class="shrink-0 text-muted" />
            <span class="min-w-0 flex-1">
              <span class="block truncate">{item.title}</span>
              {#if item.subtitle}
                <span class="block truncate text-xs text-muted">{item.subtitle}</span>
              {/if}
            </span>
            <span class="shrink-0 rounded bg-panel px-1.5 py-0.5 text-caption text-muted">
              {item.group}
            </span>
          </button>
        {:else}
          <div class="px-3 py-6 text-center text-xs text-muted">{t("common.nothingFound")}</div>
        {/each}
      </div>
    </div>
  </div>
{/if}
