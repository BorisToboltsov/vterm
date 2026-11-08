<script lang="ts">
  // Command palette (⌘K): a top-aligned overlay with a search box and a ranked,
  // keyboard-navigable list of commands. Generic — the parent supplies the
  // `commands` (each with its own `run`); matching/ranking lives in command.ts.
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { filterCommands, type CommandItem } from "./command";
  import { t } from "../i18n";

  let {
    open = $bindable(false),
    commands,
    pin,
  }: {
    open?: boolean;
    commands: CommandItem[];
    /**
     * Putting a command on the top bar (v1.35): which ones can stand there,
     * which do, and the toggle. Absent — the palette offers no pin.
     */
    pin?: { can: (id: string) => boolean; pinned: (id: string) => boolean; toggle: (item: CommandItem) => void };
  } = $props();

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
      // Shift+Enter keeps the command on the top bar instead of running it.
      if (item && e.shiftKey && pin?.can(item.id)) pin.toggle(item);
      else if (item) choose(item);
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
    <!-- eslint-disable-next-line vterm/backdrop-no-close -- a transient popup that holds nothing worth losing dismisses on an outside click -->
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
          {@const pinnable = !!pin?.can(item.id)}
          {@const pinned = pinnable && !!pin?.pinned(item.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="group flex w-full items-center text-sm {i === activeIndex ? 'bg-edge' : 'hover:bg-edge'}"
            onmousemove={() => (activeIndex = i)}
          >
            <button
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              class="flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 text-left {pinnable ? 'pr-1' : 'pr-3'}"
              onclick={() => choose(item)}
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
            {#if pinnable}
              <!-- The command onto the top bar (v1.35): its pin shows on the row in
                   focus and wherever it is already there. -->
              <button
                type="button"
                class="mr-2 flex shrink-0 items-center rounded p-1 hover:bg-panel {pinned
                  ? 'text-accent'
                  : 'text-muted opacity-0 group-hover:opacity-100 hover:text-text'} {i === activeIndex ? 'opacity-100' : ''}"
                aria-label={pinned ? t("palette.unpin") : t("palette.pin")}
                aria-pressed={pinned}
                use:tooltip={pinned ? t("palette.unpin") : t("palette.pin")}
                data-testid="command-pin"
                onclick={() => pin?.toggle(item)}
              >
                <Icon name="pin" size={13} />
              </button>
            {/if}
          </div>
        {:else}
          <div class="px-3 py-6 text-center text-xs text-muted">{t("common.nothingFound")}</div>
        {/each}
      </div>
      {#if pin}
        <div class="border-t border-edge px-3 py-1 text-caption text-muted" data-testid="command-pin-hint">
          {t("palette.pinHint")}
        </div>
      {/if}
    </div>
  </div>
{/if}
