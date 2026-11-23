<script lang="ts">
  // Read-only side-by-side diff inside a Modal, used both before saving (server
  // version ⇄ what we'll write) and to resolve a conflict (server-now ⇄ mine).
  // The diff itself is `DiffPanes` (v1.36): PyCharm's two panes with a ribbon
  // between them. The dialog takes most of the window — two columns of a config
  // file need the width. Action buttons come from the parent via `children`.
  import type { Snippet } from "svelte";
  import Modal from "../ui/Modal.svelte";
  import DiffPanes from "./DiffPanes.svelte";

  let {
    open = false,
    title,
    original,
    modified,
    originalLabel,
    modifiedLabel,
    onclose,
    children,
  }: {
    open?: boolean;
    title: string;
    /** Left side — what's currently on the server. */
    original: string;
    /** Right side — what we'll write. */
    modified: string;
    originalLabel: string;
    modifiedLabel: string;
    onclose?: () => void;
    children?: Snippet;
  } = $props();
</script>

<Modal {open} {title} width="w-[95vw]" {onclose}>
  <div class="h-[72vh] min-h-64">
    <DiffPanes {original} {modified} {originalLabel} {modifiedLabel} />
  </div>
  <div class="mt-4 flex justify-end gap-2">
    {@render children?.()}
  </div>
</Modal>
