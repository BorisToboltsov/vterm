<script lang="ts">
  // A statement's plan (ADR 0080): its steps as a tree, each with its rows, its
  // own time and its share of the whole; what deserves a look is said in words,
  // and an index worth considering is offered as text for the editor — never run.
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import type { DbKind } from "../types";
  import Icon from "../ui/Icon.svelte";
  import type { DbPlanState } from "../stores/db.svelte";
  import DbResultGrid from "./DbResultGrid.svelte";
  import { flatten, indexAdvice, share, type PlanNode, type PlanWarn } from "./dbplan";

  let {
    state,
    kind,
    oninsert,
    onask,
  }: {
    state: DbPlanState;
    kind: DbKind;
    /** Put text into the console's editor (a suggested index). */
    oninsert: (text: string) => void;
    onask?: (context: string) => void;
  } = $props();

  const steps = $derived(state.plan ? flatten(state.plan.root) : []);
  const fmt = (n: number | null) => (n === null ? "—" : Math.round(n).toLocaleString());
  const ms = (n: number | null) => (n === null ? "" : n >= 100 ? `${Math.round(n)} ${t("db.ms")}` : `${n.toFixed(n >= 10 ? 1 : 2)} ${t("db.ms")}`);

  function rowsOf(n: PlanNode): string {
    if (n.actualRows !== null && n.estRows !== null) return t("db.plan.rowsOf", { actual: fmt(n.actualRows), est: fmt(n.estRows) });
    return fmt(n.actualRows ?? n.estRows);
  }

  function warnText(w: PlanWarn, n: PlanNode): string {
    switch (w.kind) {
      case "seqScan":
        return t("db.plan.warn.seqScan", {
          table: w.relation?.name ?? n.label,
          share: Math.round(100 * share(n, state.plan!.root)),
          removed: w.removed !== undefined ? fmt(w.removed) : "—",
        });
      case "misestimate":
        return t("db.plan.warn.misestimate", { est: fmt(w.estimate ?? null), actual: fmt(w.actual ?? null) });
      case "sortDisk":
        return t("db.plan.warn.sortDisk");
      case "hashDisk":
        return t("db.plan.warn.hashDisk");
    }
  }

  function planText(): string {
    return steps.map(({ node, depth }) => `${"  ".repeat(depth)}${node.label}${node.detail ? ` [${node.detail}]` : ""} rows=${rowsOf(node)} ${ms(node.selfMs)}`).join("\n");
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="db-plan">
  <div class="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1 text-meta text-muted">
    {#if state.plan}
      {#if state.plan.analyzed}
        <span>{t("db.plan.ran", { ms: ms(state.plan.executionMs ?? state.plan.root.totalMs) })}</span>
        {#if state.plan.planningMs !== null}<span>· {t("db.plan.planning", { ms: ms(state.plan.planningMs) })}</span>{/if}
      {:else}
        <span>{t("db.plan.estimate")}</span>
      {/if}
    {:else if state.raw}
      <span>{t("db.plan.raw")}</span>
    {/if}
    <span class="ml-auto"></span>
    {#if onask && state.plan}
      <button type="button" class="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-edge hover:text-text" onclick={() => onask?.(planText())}>
        <Icon name="aiMark" size={12} />{t("db.plan.ask")}
      </button>
    {/if}
  </div>
  <div class="min-h-0 flex-1 overflow-auto">
    {#if state.error}
      <p class="p-3 text-xs text-bad">{state.error === "unreadable" ? t("db.plan.unreadable") : state.error}</p>
    {:else if state.raw}
      <DbResultGrid outcome={state.raw} />
    {:else if state.plan}
      {@const root = state.plan.root}
      {#each steps as { node, depth }, i (i)}
        {@const s = share(node, root)}
        <div class="flex items-center gap-2 px-2 py-0.5 text-xs {node.warn ? 'bg-warn/10' : ''}" data-testid="plan-step">
          <span class="min-w-0 flex-1 truncate" style="padding-left: {depth * 0.9}rem">
            {#if depth > 0}<span class="text-muted">└ </span>{/if}<span class={node.warn ? "text-warn" : "text-text"}>{node.label}</span>
            {#if node.detail}<span class="ml-1 font-mono text-meta text-muted" use:tooltip={node.detail}>{node.detail}</span>{/if}
          </span>
          <span class="w-36 shrink-0 text-right font-mono text-meta text-muted">{rowsOf(node)}</span>
          <span class="w-16 shrink-0 text-right font-mono text-meta">{ms(node.selfMs)}</span>
          <span class="h-1.5 w-24 shrink-0 overflow-hidden rounded bg-edge">
            <span class="block h-full rounded {node.warn ? 'bg-warn' : 'bg-accent'}" style="width: {Math.max(2, Math.round(100 * s))}%"></span>
          </span>
        </div>
      {/each}
      {#each steps.filter((s) => s.node.warn) as { node }, i (i)}
        {@const w = node.warn!}
        {@const advice = w.kind === "seqScan" ? indexAdvice(kind, w, state.indexes[w.relation?.name ?? ""] ?? null) : null}
        <div class="m-2 rounded border border-warn/40 bg-warn/5 px-3 py-2 text-xs" data-testid="plan-warning">
          <div class="flex items-center gap-1.5 text-warn"><Icon name="alert" size={13} />{warnText(w, node)}</div>
          {#if advice}
            {#if advice.exists}
              <p class="mt-1 text-muted">{t("db.plan.indexExists", { column: w.columns?.[0] ?? "" })}</p>
            {:else if advice.ddl}
              <p class="mt-1 text-muted">{state.indexes[w.relation?.name ?? ""] ? t("db.plan.noIndexChecked") : t("db.plan.noIndex")}</p>
              <div class="mt-1 flex items-center gap-2">
                <code class="min-w-0 flex-1 truncate font-mono text-meta text-text">{advice.ddl}</code>
                <button type="button" class="shrink-0 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" onclick={() => oninsert(advice.ddl ?? "")}>
                  {t("db.plan.insert")}
                </button>
              </div>
            {/if}
          {:else if w.kind === "misestimate"}
            <p class="mt-1 text-muted">{t("db.plan.misestimateHint")}</p>
          {:else}
            <p class="mt-1 text-muted">{t("db.plan.memoryHint")}</p>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>
