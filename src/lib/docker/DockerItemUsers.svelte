<script lang="ts">
  // The containers that use an image or a volume (v1.33, stage 4): a name per
  // row with its state dot, a click opens that container's details. Asked of
  // docker by filter, never guessed from names (`dockeritems.ts`).
  import { stateTone } from "./docker";
  import type { UserContainer } from "./dockeritems";
  import { t } from "../i18n";

  let {
    users,
    onopen,
    testid,
  }: {
    /** undefined — being asked; null — the answer could not be read. */
    users: UserContainer[] | null | undefined;
    onopen: (id: string) => void;
    testid: string;
  } = $props();

  const TONE: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-muted" };
</script>

<div data-testid={testid}>
  {#if users === undefined}
    <p class="text-muted">…</p>
  {:else if users === null}
    <p class="text-muted">{t("docker.itemUsersUnread")}</p>
  {:else if users.length === 0}
    <p class="text-muted">{t("docker.itemNoUsers")}</p>
  {:else}
    {#each users as u (u.id)}
      <button type="button" class="flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-edge/30" onclick={() => onopen(u.id)}>
        <span class="h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full {TONE[stateTone(u.state)]}"></span>
        <span class="min-w-0 truncate text-text/90">{u.name}</span>
        <span class="shrink-0 text-caption text-muted">{u.state}</span>
      </button>
    {/each}
  {/if}
</div>
