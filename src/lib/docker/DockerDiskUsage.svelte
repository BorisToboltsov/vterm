<script lang="ts">
  // What docker takes on the disk (v1.33, stage 2): images, containers, volumes
  // and build cache, with how many are in use and what a prune would free — by
  // docker's own count (`docker system df`), printed as docker prints it. Read
  // when the view opens and after a removal, not on every poll. Presentational.
  import { tooltip } from "../actions/tooltip";
  import type { DiskKind, DiskRow } from "./docker";
  import { t, type MessageKey } from "../i18n";

  let {
    rows,
  }: {
    /** undefined — being asked; null — docker's answer could not be read. */
    rows: DiskRow[] | null | undefined;
  } = $props();

  const LABEL: Record<DiskKind, MessageKey> = {
    images: "docker.diskImages",
    containers: "docker.diskContainers",
    volumes: "docker.diskVolumes",
    cache: "docker.diskCache",
  };
  /** Nothing to free — docker writes zero in its own unit. */
  const nothing = (s: string): boolean => /^0(\.0+)?\s*[kMGT]?B$/i.test(s.trim()) || s.trim() === "";
</script>

<div class="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-edge px-2.5 py-1.5 text-meta" data-testid="docker-disk">
  {#if rows === undefined}
    <span class="text-muted">{t("docker.diskReading")}</span>
  {:else if rows === null || rows.length === 0}
    <span class="text-muted" data-testid="docker-disk-unread">{t("docker.diskUnread")}</span>
  {:else}
    {#each rows as r (r.kind)}
      <div class="flex min-w-0 items-baseline gap-1.5" data-testid="docker-disk-{r.kind}">
        <span class="text-muted">{t(LABEL[r.kind])}</span>
        <span class="tabular-nums text-text/90">{r.size || "—"}</span>
        {#if r.total != null && r.active != null}
          <span class="text-caption tabular-nums text-muted" use:tooltip={t("docker.diskActiveHint")}>{t("docker.diskActive", { active: r.active, total: r.total })}</span>
        {/if}
        {#if !nothing(r.reclaimable)}
          <span class="text-caption tabular-nums text-warn" use:tooltip={t("docker.diskReclaimHint")}>
            {r.reclaimablePct != null
              ? t("docker.diskReclaimPct", { size: r.reclaimable, pct: r.reclaimablePct })
              : t("docker.diskReclaim", { size: r.reclaimable })}
          </span>
        {/if}
      </div>
    {/each}
  {/if}
</div>
