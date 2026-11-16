<script lang="ts">
  // The project strip above the listing (ADR 0077): what the folder is, its
  // branch and facts, and the commands of its kind — one click types one into
  // the connection's terminal. It draws no menu or dialog of its own: it stands
  // in the panel's `@container` (panelcontainer.guard), so the panel opens them.
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import type { MenuItem } from "../ui/ctxmenu";
  import type { ListingGit } from "../git/gitlisting";
  import { KIND_ICON, KIND_LABEL, type ManifestFacts, type ProjectInfo, type Tone } from "./projectmap";
  import { asks, type ProjectAction, type ProjectTask } from "./projectactions";

  let {
    info,
    facts,
    git,
    actions,
    tasks,
    tasksFile,
    prod,
    last,
    pinned = null,
    testid,
    onrun,
    ontask,
    onopen,
    onpin,
    onmenu,
  }: {
    info: ProjectInfo;
    facts: ManifestFacts | null;
    git: ListingGit | null;
    actions: ProjectAction[];
    tasks: ProjectTask[];
    tasksFile: string | null;
    prod: boolean;
    /** The last action run in this folder — the repeat button. */
    last: ProjectAction | ProjectTask | null;
    /** Pinned to the Scenarios panel; null — the kind is not pinnable. */
    pinned?: boolean | null;
    testid: string;
    onrun: (a: ProjectAction) => void;
    ontask: (task: ProjectTask) => void;
    /** The kind's label clicked (Ansible, Terraform: the project in «Scenarios»). */
    onopen?: () => void;
    onpin?: () => void;
    /** Open a menu at a point (the panel draws it, outside its container). */
    onmenu: (x: number, y: number, items: MenuItem[]) => void;
  } = $props();

  const TONE: Record<Exclude<Tone, null>, string> = {
    accent: "text-accent",
    ok: "text-ok",
    warn: "text-warn",
    muted: "text-muted",
    violet: "text-rail-2",
  };

  const strip = $derived(actions.filter((a) => a.strip));
  const more = $derived(actions.filter((a) => !a.strip));
  const kindIcon = $derived(KIND_ICON[info.kind]);
  const title = $derived(
    facts?.name ? `${KIND_LABEL[info.kind]} · ${facts.name}${facts.version ? ` ${facts.version}` : ""}` : KIND_LABEL[info.kind],
  );
  const factLine = $derived((facts?.facts ?? info.markers).join(" · "));

  const askHint = (a: { ask: ProjectAction["ask"] }) =>
    a.ask === "always" ? t("project.asksAlways") : a.ask === "prod" ? t("project.asksOnProd") : undefined;

  function menuAt(e: MouseEvent, items: MenuItem[]) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onmenu(r.left, r.bottom + 4, items);
  }

  function openMore(e: MouseEvent) {
    menuAt(
      e,
      more.map((a) => ({
        label: t(a.label),
        danger: a.ask === "always",
        hint: asks(a, prod) ? t("project.asks") : undefined,
        onSelect: () => onrun(a),
      })),
    );
  }

  function openTasks(e: MouseEvent) {
    menuAt(e, [
      ...tasks.map((task) => ({ label: task.name, hint: prod ? t("project.asks") : undefined, onSelect: () => ontask(task) })),
    ]);
  }

  const lastLabel = $derived(last ? ("label" in last ? t(last.label) : last.name) : "");
</script>

<div class="mx-2 mt-1 rounded border border-accent/35 bg-accent/5 px-2 py-1 text-xs" data-testid={testid}>
  <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
    {#if onopen}
      <button
        type="button"
        class="mr-auto flex min-w-0 items-center gap-1 font-medium text-text hover:underline"
        use:tooltip={t("project.markers", { markers: info.markers.join(", ") })}
        onclick={onopen}
      >
        <Icon name={kindIcon.icon} size={13} class={kindIcon.tone ? TONE[kindIcon.tone] : "text-muted"} />
        <span class="truncate">{title}</span>
        <Icon name="chevronRight" size={11} class="text-muted" />
      </button>
    {:else}
      <span class="mr-auto flex min-w-0 items-center gap-1 font-medium text-text" use:tooltip={t("project.markers", { markers: info.markers.join(", ") })}>
        <Icon name={kindIcon.icon} size={13} class={kindIcon.tone ? TONE[kindIcon.tone] : "text-muted"} />
        <span class="truncate">{title}</span>
      </span>
    {/if}
    {#each strip as a (a.id)}
      <button
        type="button"
        class="flex items-center gap-1 rounded border px-1.5 py-0.5 text-meta {a.primary
          ? 'border-accent/50 bg-accent/10 text-accent'
          : 'border-edge text-text hover:border-accent'}"
        data-testid="{testid}-act-{a.id}"
        use:tooltip={askHint(a)}
        onclick={() => onrun(a)}
      >
        {#if a.primary}<Icon name="play" size={10} />{/if}{t(a.label)}
      </button>
    {/each}
    {#if tasks.length > 0}
      <button
        type="button"
        class="flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-meta text-text hover:border-accent"
        data-testid="{testid}-tasks"
        use:tooltip={t("project.tasksFrom", { file: tasksFile ?? "" })}
        onclick={openTasks}
      ><Icon name="listCheck" size={11} />{t(tasksFile === "package.json" ? "project.scripts" : "project.tasks")}<Icon name="chevronDown" size={10} /></button>
    {/if}
    {#if more.length > 0}
      <button
        type="button"
        class="rounded border border-edge px-1 py-0.5 text-muted hover:border-accent hover:text-text"
        aria-label={t("project.more")}
        use:tooltip={t("project.more")}
        data-testid="{testid}-more"
        onclick={openMore}
      ><Icon name="chevronDown" size={11} /></button>
    {/if}
    {#if last}
      <button
        type="button"
        class="flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-meta text-muted hover:border-accent hover:text-text"
        data-testid="{testid}-repeat"
        use:tooltip={t("project.repeat")}
        onclick={() => (last && "label" in last ? onrun(last) : last && ontask(last))}
      ><Icon name="redo" size={10} />{lastLabel}</button>
    {/if}
    {#if pinned !== null && onpin}
      <button
        type="button"
        class="rounded p-0.5 hover:bg-edge {pinned ? 'text-accent' : 'text-muted hover:text-text'}"
        aria-pressed={pinned}
        aria-label={pinned ? t("scenarios.project.unpin") : t("scenarios.project.pin")}
        use:tooltip={pinned ? t("scenarios.project.unpin") : t("scenarios.project.pin")}
        onclick={onpin}
      ><Icon name="pin" size={12} /></button>
    {/if}
  </div>
  <div class="mt-0.5 flex min-w-0 items-center gap-1.5 pl-[1.15rem] text-meta text-muted">
    {#if git}
      <Icon name="gitBranch" size={11} class="shrink-0" />
      <span class="shrink-0 text-text" data-testid="{testid}-branch">{git.branch ?? t("project.detached")}</span>
      {#if git.ahead}<span class="shrink-0">↑{git.ahead}</span>{/if}
      {#if git.behind}<span class="shrink-0">↓{git.behind}</span>{/if}
      {#if git.changed}<span class="shrink-0 text-warn">{t("project.changed", { n: git.changed })}</span>{/if}
      <span class="shrink-0">·</span>
    {/if}
    <span class="truncate">{factLine}</span>
  </div>
</div>
