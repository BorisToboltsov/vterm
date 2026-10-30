<script lang="ts">
  // The row above the file list that says whom the files are under when that is not
  // who the terminal is, or not the login user (v1.26, ADR 0047). It only draws:
  // what it says is `fileUserRow`, what its buttons do is the panel's.
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import Icon from "../ui/Icon.svelte";
  import type { FileUserRow } from "./fileuser";

  let {
    row,
    onopenas,
    onback,
  }: {
    row: FileUserRow;
    onopenas: (user: string) => void;
    onback: () => void;
  } = $props();

  const said = $derived(
    [
      t("fileuser.files", { user: row.files }),
      ...(row.shell ? [t("fileuser.terminal", { user: row.shell })] : []),
      ...(row.hidden ? [t("fileuser.terminalHidden")] : []),
    ].join(" · "),
  );
</script>

<div
  class="flex min-w-0 items-center gap-1.5 border-b border-edge px-2 py-1 text-xs text-warn"
  data-testid="sftp-fileuser"
>
  <Icon name="terminal" size={12} class="shrink-0" />
  <!-- A long name must not push out the words: the text and the button give way
       in turn, and the tooltip keeps what they cut. -->
  <span
    class="min-w-[35%] flex-1 truncate"
    data-testid="sftp-fileuser-text"
    use:tooltip={row.hidden ? t("fileuser.hiddenHint") : said}
  >
    {said}
  </span>
  {#if row.openAs}
    {@const user = row.openAs}
    <button
      type="button"
      class="min-w-0 truncate rounded px-1.5 py-0.5 text-accent hover:bg-edge"
      data-testid="sftp-fileuser-open"
      use:tooltip={t("fileuser.openAs", { user })}
      onclick={() => onopenas(user)}
    >
      {t("fileuser.openAs", { user })}
    </button>
  {/if}
  {#if row.back}
    <button
      type="button"
      class="shrink-0 rounded px-1.5 py-0.5 text-accent hover:bg-edge"
      data-testid="sftp-fileuser-back"
      onclick={onback}
    >
      {t("fileuser.back", { user: row.back })}
    </button>
  {/if}
</div>
