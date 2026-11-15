<script lang="ts">
  // A Terraform plan (ADR 0071): `terraform plan` saved it in the run's folder
  // while the user watched the terminal; read with `terraform show -json`, it
  // stands here by module — what is created, changed, replaced, destroyed, and
  // for a change which attributes. A value Terraform marks sensitive is never
  // shown. "Apply" applies exactly this saved plan, after the view's question.
  import { t } from "../i18n";
  import type { PlanWatch } from "../stores/scenarios.svelte";
  import Icon from "../ui/Icon.svelte";
  import { changeLook } from "./scenariotext";
  import { byModule, destroys, type ValueMask } from "./tfplan";

  let {
    watch,
    onapply,
    onreplan,
    onterminal,
  }: {
    watch: PlanWatch;
    onapply: () => void;
    onreplan: () => void;
    onterminal: () => void;
  } = $props();

  const plan = $derived(watch.plan);
  let open = $state<string | null>(null);
  const masked = (m: ValueMask): string => (m === "sensitive" ? t("scenarios.plan.sensitive") : m === "unknown" ? t("scenarios.plan.unknown") : "");
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="tf-plan-view">
  <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-1.5 text-xs">
    <span class="font-medium text-text">{t("scenarios.plan.title")}</span>
    {#if watch.varFiles.length}<span class="font-mono text-meta text-muted">{watch.varFiles.join(", ")}</span>{/if}
    {#if plan}
      <span class="text-ok">+{plan.counts.create}</span>
      <span class="text-warn">~{plan.counts.update}</span>
      <span class="text-bad">±{plan.counts.replace}</span>
      <span class="text-bad">−{plan.counts.delete}</span>
    {/if}
    <span class="ml-auto flex items-center gap-1.5">
      <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" onclick={onterminal}>
        <Icon name="terminal" size={12} />{t("scenarios.ansible.terminal")}
      </button>
      {#if watch.phase === "ready" && plan}
        <button
          type="button"
          class="rounded border px-2 py-0.5 text-meta {destroys(plan) ? 'border-danger/60 bg-danger/10 text-danger' : 'border-accent/50 bg-accent/10 text-accent'}"
          data-testid="tf-apply"
          onclick={onapply}>{t("scenarios.plan.apply")}</button
        >
      {/if}
      {#if watch.phase === "failed" || watch.phase === "applied" || watch.phase === "ready"}
        <button type="button" class="rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" onclick={onreplan}>{t("scenarios.plan.again")}</button>
      {/if}
    </span>
  </div>

  <div class="min-h-0 flex-1 overflow-auto px-3 py-2 text-xs">
    {#if watch.phase === "planning"}
      <p class="flex items-center gap-2 text-muted"><Icon name="loader" size={13} class="animate-spin text-accent" />{t("scenarios.plan.planning")}</p>
    {:else if watch.phase === "reading"}
      <p class="flex items-center gap-2 text-muted"><Icon name="loader" size={13} class="animate-spin text-accent" />{t("scenarios.plan.reading")}</p>
    {:else if watch.phase === "failed"}
      <p class="text-bad">{t("scenarios.plan.failed", { error: watch.error ?? "" })}</p>
    {:else if plan}
      {#if watch.phase === "applied"}
        <p class="mb-2 rounded border border-edge bg-panel-alt px-2 py-1 text-muted">{t("scenarios.plan.applied")}</p>
      {/if}
      {#if plan.changes.length === 0}
        <p class="text-muted">{t("scenarios.plan.noChanges")}</p>
      {/if}
      {#each byModule(plan) as g (g.module ?? "")}
        <h3 class="mb-1 mt-2 text-meta text-muted">{g.module ?? t("scenarios.plan.root")}</h3>
        <div class="rounded border border-edge">
          {#each g.changes as c (c.address)}
            {@const look = changeLook(c.kind)}
            <div class="border-t border-edge/40 first:border-t-0">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-edge/30"
                disabled={!c.attrs.length}
                onclick={() => (open = open === c.address ? null : c.address)}
              >
                <span class="w-3 font-mono {look.cls}">{look.sign}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-text">{c.address}</span>
                {#if c.replacing.length}<span class="truncate text-meta text-bad">{t("scenarios.plan.forcedBy", { attrs: c.replacing.join(", ") })}</span>{/if}
                <span class="shrink-0 text-meta text-muted">{look.text}</span>
              </button>
              {#if open === c.address}
                <div class="space-y-0.5 px-7 pb-1.5">
                  {#each c.attrs as a (a.path)}
                    <div class="flex gap-2 font-mono text-meta">
                      <span class="w-32 shrink-0 truncate text-muted">{a.path}</span>
                      <span class="min-w-0 truncate {a.beforeMask ? 'italic text-muted' : 'text-bad'}">{a.beforeMask ? masked(a.beforeMask) : a.before || "—"}</span>
                      <span class="text-muted">→</span>
                      <span class="min-w-0 truncate {a.afterMask ? 'italic text-muted' : 'text-ok'}">{a.afterMask ? masked(a.afterMask) : a.after || "—"}{a.partlyUnknown ? ` ${t("scenarios.plan.partly")}` : ""}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
      {#if plan.outputs.length}
        <h3 class="mb-1 mt-3 text-meta text-muted">{t("scenarios.plan.outputs")}</h3>
        {#each plan.outputs as o (o.name)}
          {@const look = changeLook(o.kind)}
          <div class="flex items-center gap-2 font-mono text-meta">
            <span class="w-3 {look.cls}">{look.sign}</span><span class="text-text">{o.name}</span>
            {#if o.sensitive}<span class="rounded bg-warn/15 px-1 text-caption text-warn">sensitive</span>{/if}
          </div>
        {/each}
      {/if}
    {/if}
  </div>
</div>
