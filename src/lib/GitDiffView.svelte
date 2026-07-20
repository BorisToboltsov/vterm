<script lang="ts">
  // Read-only unified-diff viewer inside a Modal (Phase 29). Git emits unified
  // diffs directly (working-tree, staged, or a commit vs its parent); rather than
  // fetch both blob versions for a MergeView, we render the parsed hunks with
  // per-line coloring. Parsing is pure (`git.ts` parseDiff) so it stays testable.
  import Modal from "./Modal.svelte";
  import type { DiffLine } from "./git";
  import { t } from "./i18n";

  let {
    open = false,
    title,
    lines,
    onclose,
  }: {
    open?: boolean;
    title: string;
    lines: DiffLine[];
    onclose?: () => void;
  } = $props();
</script>

<Modal {open} {title} {onclose} showClose width="w-[46rem] max-w-[92vw]">
  {#if lines.length === 0}
    <p class="py-6 text-center text-xs text-muted">{t("git.diffEmpty")}</p>
  {:else}
    <div
      class="max-h-[60vh] overflow-auto rounded border border-edge bg-panel font-mono text-meta leading-relaxed"
    >
      {#each lines as line, i (i)}
        <div
          class="whitespace-pre px-2 {line.type === 'add'
            ? 'vt-diff-add'
            : line.type === 'del'
              ? 'vt-diff-del'
              : line.type === 'hunk'
                ? 'bg-edge/60 text-accent'
                : line.type === 'meta'
                  ? 'text-muted'
                  : 'text-white/80'}"
        >{line.text || " "}</div>
      {/each}
    </div>
  {/if}
</Modal>
