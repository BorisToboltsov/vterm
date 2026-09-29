<script lang="ts" generics="V extends string">
  // Segmented control: a compact one-of-N choice drawn as joined buttons (the
  // server form's password / SSH key switch). Semantically a radio group — one
  // tab stop, arrows move the choice (segmented.ts) — so it reads the same to a
  // screen reader as the radios it replaces. Styling lives in DESIGN.md.
  import { segmentStep } from "./segmented";

  let {
    value = $bindable(),
    options,
    label,
    testid = undefined,
  }: {
    value: V;
    options: { value: V; label: string }[];
    /** Accessible name of the group (not rendered). */
    label: string;
    testid?: string;
  } = $props();

  let buttons: HTMLButtonElement[] = $state([]);

  function onkeydown(e: KeyboardEvent, i: number) {
    const next = segmentStep(e.key, i, options.length);
    if (next == null) return;
    e.preventDefault();
    value = options[next].value;
    buttons[next]?.focus();
  }
</script>

<div
  role="radiogroup"
  aria-label={label}
  data-testid={testid}
  class="inline-flex overflow-hidden rounded border border-edge text-sm"
>
  {#each options as opt, i (opt.value)}
    <button
      bind:this={buttons[i]}
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      tabindex={value === opt.value ? 0 : -1}
      class="px-3 py-1 {i > 0 ? 'border-l border-edge' : ''} {value === opt.value
        ? 'bg-accent/15 text-accent'
        : 'text-muted hover:bg-edge hover:text-text'}"
      onclick={() => (value = opt.value)}
      onkeydown={(e) => onkeydown(e, i)}
    >
      {opt.label}
    </button>
  {/each}
</div>
