<script lang="ts">
  // A playbook run as Ansible reports it (ADR 0071): each play's tasks down,
  // its hosts across, every cell what the task did there — filled by the events
  // vterm's collector writes while the run goes on in the terminal. The recap
  // under it; a cell picked shows its message and its diff; a failure can go to
  // the assistant (masking and consent as always). Ansible's own output stays in
  // the terminal: nothing here replaces it.
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import type { AnsibleWatch } from "../stores/scenarios.svelte";
  import Icon from "../ui/Icon.svelte";
  import { findTask, firstFailure, hostFailed, hostRecap, runEnded, runHosts } from "./ansibleevents";
  import { cellLook } from "./scenariotext";

  let {
    watch,
    prodHosts,
    onapply,
    onstop,
    onterminal,
    onask,
  }: {
    watch: AnsibleWatch;
    /** Hosts known to be prod (matched to the catalog). */
    prodHosts: ReadonlySet<string>;
    /** After a check: the same run for real. */
    onapply?: () => void;
    /** Stop watching (Ansible was interrupted in the terminal). */
    onstop: () => void;
    onterminal: () => void;
    onask?: (context: string) => void;
  } = $props();

  const run = $derived(watch.run);
  const ended = $derived(runEnded(run));
  const hosts = $derived(runHosts(run));
  let pick = $state<{ task: string; host: string } | null>(null);
  const auto = $derived(ended ? firstFailure(run) : null);
  const shown = $derived(pick ?? auto);
  const cell = $derived(shown ? (run.cells[shown.task]?.[shown.host] ?? null) : null);
  const failedHosts = $derived(hosts.filter((h) => hostFailed(hostRecap(run, h))));

  let now = $state(Date.now());
  $effect(() => {
    if (ended || watch.ended) return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  // An ended run is timed by Ansible's own events; a running one by the clock.
  const secs = $derived(
    Math.max(0, Math.round(ended && run.lastAt !== null && run.startedAt !== null ? run.lastAt - run.startedAt : (now - watch.startedAt) / 1000)),
  );
  const clock = $derived(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`);

  function ask() {
    if (!shown || !cell || !onask) return;
    const found = findTask(run, shown.task);
    onask(
      [
        `Ansible playbook: ${run.file || watch.playbook}${watch.check ? " (check mode, --check --diff)" : ""}`,
        found ? `Play: ${found.play.name}` : null,
        found ? `Task: ${found.task.name}${found.task.role ? ` (role ${found.task.role})` : ""}` : null,
        `Host: ${shown.host} — ${cell.status}`,
        cell.msg ? `Message: ${cell.msg}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="ansible-run-view">
  <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-1.5 text-xs">
    <span class="font-mono font-medium text-text">{watch.playbook}</span>
    <span class="rounded px-1.5 text-caption {watch.check ? 'bg-accent/15 text-accent' : 'bg-warn/15 text-warn'}">
      {watch.check ? t("scenarios.ansible.check") : t("scenarios.ansible.apply")}
    </span>
    <span
      class="rounded px-1.5 text-caption {ended
        ? failedHosts.length
          ? 'bg-bad/15 text-bad'
          : 'bg-ok/15 text-ok'
        : watch.ended
          ? 'bg-edge text-muted'
          : 'bg-accent/15 text-accent'}"
      data-testid="ansible-run-state"
    >
      {ended ? (failedHosts.length ? t("scenarios.ansible.endedFailed") : t("scenarios.ansible.ended")) : watch.ended ? t("scenarios.ansible.unwatched") : t("scenarios.ansible.going")} · {clock}
    </span>
    {#if watch.limit.length}<span class="truncate text-meta text-muted">{watch.limit.join(",")}</span>{/if}
    <span class="ml-auto flex items-center gap-1.5">
      <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" onclick={onterminal}>
        <Icon name="terminal" size={12} />{t("scenarios.ansible.terminal")}
      </button>
      {#if !ended && !watch.ended}
        <button type="button" class="rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" use:tooltip={t("scenarios.ansible.unwatchHint")} onclick={onstop}>
          {t("scenarios.ansible.unwatch")}
        </button>
      {:else if ended && watch.check && onapply}
        <button
          type="button"
          class="rounded border px-2 py-0.5 text-meta {[...prodHosts].some((h) => hosts.includes(h)) ? 'border-danger/60 bg-danger/10 text-danger' : 'border-accent/50 bg-accent/10 text-accent'}"
          data-testid="ansible-apply"
          onclick={onapply}>{t("scenarios.ansible.applyAfterCheck")}</button
        >
      {/if}
    </span>
  </div>

  {#if watch.error}<p class="px-3 py-1 text-meta text-warn">{t("scenarios.ansible.readFailed", { error: watch.error })}</p>{/if}

  <div class="min-h-0 flex-1 overflow-auto">
    {#if run.plays.length === 0}
      <p class="px-3 py-3 text-xs text-muted">{watch.ended ? t("scenarios.ansible.noEvents") : t("scenarios.ansible.waiting")}</p>
    {/if}
    {#each run.plays as play (play.id)}
      <table class="w-full table-fixed border-collapse text-xs">
        <thead>
          <tr class="bg-panel-alt">
            <th class="px-3 py-1 text-left font-normal text-muted">{t("scenarios.ansible.play")} · <span class="text-text">{play.name}</span></th>
            {#each play.hosts as h (h)}
              <th class="w-24 truncate px-1 py-1 text-center font-mono text-meta font-normal {prodHosts.has(h) ? 'text-danger' : 'text-muted'}" use:tooltip={h}>{h}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each play.tasks as task (task.id)}
            <tr class="border-t border-edge/40">
              <td class="truncate px-3 py-0.5 {task.handler ? 'text-muted' : 'text-text'}" use:tooltip={task.name}>
                {task.handler ? `${t("scenarios.ansible.handler")} · ` : ""}{task.name || "—"}
              </td>
              {#each play.hosts as h (h)}
                {@const c = run.cells[task.id]?.[h]}
                <td class="px-1 py-0.5 text-center">
                  {#if c}
                    {@const look = cellLook(c.status, watch.check, c.ignored)}
                    <button
                      type="button"
                      class="w-full rounded px-1 text-meta {look.cls} {shown?.task === task.id && shown.host === h ? 'outline outline-1 outline-current' : ''}"
                      data-testid="ansible-cell"
                      onclick={() => (pick = { task: task.id, host: h })}>{look.text}</button
                    >
                  {:else}
                    <span class="block h-4 rounded border border-dashed border-edge/60"></span>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {/each}
  </div>

  {#if hosts.length}
    <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-0.5 border-t border-edge bg-panel-alt px-3 py-1 text-meta" data-testid="ansible-recap">
      <span class="text-muted">{t("scenarios.ansible.recap")}</span>
      {#each hosts as h (h)}
        {@const r = hostRecap(run, h)}
        <span class="flex items-center gap-1.5 whitespace-nowrap">
          <span class="font-mono {prodHosts.has(h) ? 'text-danger' : 'text-text'}">{h}</span>
          <span class="text-ok">ok {r.ok}</span>
          <span class="text-warn">{watch.check ? t("scenarios.cell.wouldChange") : t("scenarios.cell.changed")} {r.changed}</span>
          {#if r.failures}<span class="text-bad">{t("scenarios.cell.failed")} {r.failures}</span>{/if}
          {#if r.unreachable}<span class="text-bad">{t("scenarios.cell.unreachable")} {r.unreachable}</span>{/if}
        </span>
      {/each}
    </div>
  {/if}

  <div class="max-h-[40%] min-h-[4.5rem] shrink-0 overflow-auto border-t border-edge px-3 py-1.5 text-xs" data-testid="ansible-cell-detail">
    {#if shown && cell}
      {@const found = findTask(run, shown.task)}
      <div class="flex items-center gap-2">
        <span class="font-medium text-text">{found?.task.name ?? ""}</span>
        <span class="font-mono text-muted">· {shown.host}</span>
        <span class="rounded px-1 text-caption {cellLook(cell.status, watch.check, cell.ignored).cls}">{cellLook(cell.status, watch.check, cell.ignored).text}</span>
        {#if (cell.status === "failed" || cell.status === "unreachable") && onask}
          <button type="button" class="ml-auto flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-meta text-text hover:border-accent" onclick={ask}>
            <Icon name="aiMark" size={11} />{t("scenarios.run.askAi")}
          </button>
        {/if}
      </div>
      {#if cell.msg}<pre class="mt-1 whitespace-pre-wrap font-mono text-meta {cell.status === 'failed' && !cell.ignored ? 'text-bad' : 'text-muted'}">{cell.msg}</pre>{/if}
      {#if cell.diff}
        <pre class="mt-1 font-mono text-meta leading-relaxed">{#each cell.diff.split("\n") as l, i (i)}<span class="block {l.startsWith('+') && !l.startsWith('+++') ? 'text-ok' : l.startsWith('-') && !l.startsWith('---') ? 'text-bad' : 'text-muted'}">{l}</span>{/each}</pre>
      {/if}
      {#if !cell.msg && !cell.diff}<p class="mt-1 text-meta text-muted">{t("scenarios.ansible.nothingSaid")}</p>{/if}
    {:else}
      <p class="text-muted">{t("scenarios.ansible.pickCell")}</p>
    {/if}
  </div>
</div>
