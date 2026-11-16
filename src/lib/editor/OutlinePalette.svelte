<script lang="ts">
  // `⌘⇧O` in the editor (ADR 0076): the file's symbols — plays and tasks,
  // resources, functions, headings, `server {}` — filtered as you type, Enter
  // jumps. A list over the code, not a dialog: Esc or a click outside closes it.
  import { onMount } from "svelte";
  import Icon from "../ui/Icon.svelte";
  import FilterField from "../ui/FilterField.svelte";
  import { t } from "../i18n";
  import type { IconName } from "../ui/icons";
  import type { OutlineSym, SymKind } from "./outline";

  let { syms, onpick, onclose }: { syms: OutlineSym[]; onpick: (line: number) => void; onclose: () => void } = $props();

  let query = $state("");
  let active = $state(0);
  let root: HTMLDivElement | undefined;

  const ICON: Record<SymKind, IconName> = {
    play: "play",
    task: "listCheck",
    key: "braces",
    document: "kubernetes",
    service: "container",
    job: "gearPlay",
    resource: "cube",
    function: "code",
    class: "hierarchy",
    type: "hierarchy",
    heading: "hash",
    block: "braces",
    stage: "layoutGrid",
    section: "hash",
    target: "play",
  };

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? syms.filter((s) => s.name.toLowerCase().includes(q)) : syms;
  });

  $effect(() => {
    void query;
    active = 0;
  });

  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, shown.length - 1);
      root?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      root?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && shown[active]) {
      e.preventDefault();
      onpick(shown[active].line);
    }
  }

  onMount(() => {
    const away = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) onclose();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  });
</script>

<div
  bind:this={root}
  class="absolute left-1/2 top-2 z-30 flex max-h-[60%] w-[min(28rem,90%)] -translate-x-1/2 flex-col overflow-hidden rounded border border-edge bg-panel-alt shadow-lg"
  data-testid="editor-outline"
  role="listbox"
  aria-label={t("editor.outline.title")}
>
  <div class="p-1.5">
    <FilterField bind:value={query} placeholder={t("editor.outline.search")} onkeydown={keydown} />
  </div>
  <div class="min-h-0 flex-1 overflow-auto pb-1">
    {#each shown as s, i (s.line + ":" + s.name)}
      <button
        type="button"
        data-i={i}
        role="option"
        aria-selected={i === active}
        class="flex w-full items-center gap-2 py-1 pr-3 text-left text-xs {i === active ? 'bg-edge text-text' : 'text-muted hover:bg-edge hover:text-text'}"
        style:padding-left="{0.75 + s.depth * 0.9}rem"
        onclick={() => onpick(s.line)}
      >
        <Icon name={ICON[s.kind]} size={12} class="shrink-0 text-accent" />
        <span class="flex-1 truncate">{s.name}</span>
        <span class="tabular-nums text-caption text-muted">{s.line}</span>
      </button>
    {:else}
      <div class="px-3 py-2 text-xs text-muted">{t("editor.outline.empty")}</div>
    {/each}
  </div>
</div>
