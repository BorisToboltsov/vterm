<script lang="ts">
  // The title of a column a list can be ordered by (v1.17): a click orders the
  // list by the column, another one turns the order round; the arrow says which
  // way it runs now. Looks like the plain title it replaces until hovered — the
  // header is not a row of buttons.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";

  let {
    label,
    sorted = null,
    onsort,
    testid,
    align = "left",
  }: {
    label: string;
    /** The list is ordered by this column, this way; null — by another one. */
    sorted?: "asc" | "desc" | null;
    onsort: () => void;
    testid?: string;
    /** Numbers are set to the right; so is their title. */
    align?: "left" | "right";
  } = $props();
</script>

<button
  type="button"
  class="flex w-full min-w-0 items-center gap-0.5 hover:text-text {sorted ? 'text-accent' : ''} {align ===
  'right'
    ? 'justify-end'
    : ''}"
  aria-pressed={sorted !== null}
  data-sorted={sorted ?? undefined}
  data-testid={testid}
  use:tooltip={t("sftp.sortBy", { column: label })}
  onclick={onsort}
>
  <span class="min-w-0 truncate">{label}</span>
  {#if sorted}
    <Icon name={sorted === "asc" ? "arrowUp" : "arrowDown"} size={11} class="shrink-0" />
  {/if}
</button>
