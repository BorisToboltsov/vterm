<script lang="ts">
  // Read-only side-by-side diff (CodeMirror MergeView) inside a Modal. Used both
  // before saving (server version ⇄ what we'll write) and to resolve a conflict
  // (server-now ⇄ mine). Action buttons come from the parent via `children`.
  import type { Snippet } from "svelte";
  import { MergeView } from "@codemirror/merge";
  import { EditorState } from "@codemirror/state";
  import { EditorView, lineNumbers } from "@codemirror/view";
  import { editorTheme } from "./cmtheme";
  import { cspNonceExtension } from "./cspnonce";
  import { activeTerminalTheme } from "./settings.svelte";
  import Modal from "./Modal.svelte";

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

  let host: HTMLDivElement | undefined = $state();
  let mv: MergeView | undefined;

  // (Re)build the MergeView whenever the dialog opens or its content changes; tear
  // it down on close. The host only exists while the Modal renders its children.
  $effect(() => {
    void open;
    void original;
    void modified;
    mv?.destroy();
    mv = undefined;
    if (!open || !host) return;
    const ro = [
      // Let CodeMirror's runtime style element pass the packaged-build CSP (cspnonce.ts).
      cspNonceExtension(),
      lineNumbers(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      editorTheme(activeTerminalTheme()),
    ];
    mv = new MergeView({
      a: { doc: original, extensions: ro },
      b: { doc: modified, extensions: ro },
      parent: host,
      gutter: true,
      highlightChanges: true,
    });
    return () => {
      mv?.destroy();
      mv = undefined;
    };
  });
</script>

<Modal {open} {title} width="w-[90vw] max-w-5xl" {onclose}>
  <div class="mb-2 flex gap-2 text-xs text-muted">
    <span class="flex-1 truncate">{originalLabel}</span>
    <span class="flex-1 truncate">{modifiedLabel}</span>
  </div>
  <div
    bind:this={host}
    class="max-h-[60vh] overflow-auto rounded border border-edge text-sm [&_.cm-mergeView]:h-full"
  ></div>
  <div class="mt-4 flex justify-end gap-2">
    {@render children?.()}
  </div>
</Modal>
