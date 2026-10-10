<script lang="ts">
  // The one "replace these files?" dialog of a window (v1.11.3; shared by every
  // way a transfer starts since v1.12). It shows the question at the head of the
  // queue (`stores/replaceask`): replace, skip the taken names, or cancel.
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { answerReplace, currentReplaceQuestion } from "./stores/replaceask.svelte";
  import { t } from "./i18n";

  const ask = $derived(currentReplaceQuestion());
</script>

<ConfirmDialog
  open={!!ask}
  title={ask?.names === null ? t("sftp.replaceUncheckedTitle") : t("sftp.replaceTitle")}
  confirmLabel={ask?.names === null ? t("sftp.replaceUncheckedConfirm") : t("sftp.replaceConfirm")}
  altLabel={ask?.canSkip ? t("sftp.replaceSkip") : undefined}
  onconfirm={() => answerReplace("replace")}
  onalt={() => answerReplace("skip")}
  oncancel={() => answerReplace("cancel")}
>
  {#if ask}
    {#if ask.names === null}
      {t("sftp.replaceUnchecked", { dest: ask.dest })}
    {:else if ask.names.length === 1 && ask.more === 0}
      {t("sftp.replaceOne", { name: ask.names[0], dest: ask.dest })}
    {:else}
      {t("sftp.replaceMany", { count: ask.names.length + ask.more, dest: ask.dest })}
      <ul class="mt-1.5 space-y-0.5" data-testid="replace-names">
        {#each ask.names as name, i (i)}
          <li class="break-all text-text">{name}</li>
        {/each}
        {#if ask.more > 0}
          <li>{t("sftp.replaceMore", { count: ask.more })}</li>
        {/if}
      </ul>
    {/if}
  {/if}
</ConfirmDialog>
