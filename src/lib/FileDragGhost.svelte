<script lang="ts">
  // The label that follows the pointer while files are dragged (v1.13): one
  // file's name, or how many. One instance for the whole window — the drag is
  // app-wide state (`stores/filedrag`), not a panel's: the panel a drag began in
  // is gone as soon as the files are held over another tab.
  //
  // Files the system drags in from the desktop carry the system's own picture;
  // nothing is drawn for them here. Over another window of the app that window
  // draws them, and over the desktop the floating label does — this one stays
  // in the page, unseen, only to be measured (`look`).
  import Icon from "./Icon.svelte";
  import { fileIconName } from "./fileicon";
  import { fileDrag } from "./stores/filedrag.svelte";
  import { t } from "./i18n";

  let label = $state<HTMLElement>();

  const files = $derived(fileDrag.files);
  /** Drawn by this page: its own files inside the window, or another window's held here. */
  const mine = $derived(
    files !== null && files.from !== null && !fileDrag.outside && fileDrag.window === null,
  );
  const title = $derived(
    files === null
      ? ""
      : files.entries.length === 1
        ? files.entries[0].name
        : t("sftp.dragCount", { count: files.entries.length }),
  );

  /** How the label looks, for the window that draws it over the desktop. */
  export function look() {
    if (!label) return null;
    const box = label.getBoundingClientRect();
    const style = getComputedStyle(label);
    return {
      title,
      bg: style.backgroundColor,
      fg: style.color,
      accent: style.borderTopColor,
      // No status dot: this is a file, not a session.
      dot: style.backgroundColor,
      w: Math.ceil(box.width),
      h: Math.ceil(box.height),
    };
  }
</script>

<!-- pointer-events-none so the hit test still sees what is under the files. -->
{#if files !== null && files.from !== null}
  <div
    bind:this={label}
    data-testid="file-drag-ghost"
    class="pointer-events-none fixed z-50 flex items-center gap-1 rounded border border-accent bg-panel px-2 py-1 text-xs text-text shadow-lg {mine
      ? ''
      : 'invisible'}"
    style="left: {fileDrag.x + 12}px; top: {fileDrag.y + 8}px;"
  >
    <Icon
      name={fileIconName({ ...files.entries[0], isSymlink: false })}
      size={13}
      class="text-muted"
    />
    <span class="font-medium">{title}</span>
  </div>
{/if}
