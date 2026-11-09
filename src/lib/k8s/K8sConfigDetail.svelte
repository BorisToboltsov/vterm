<script lang="ts">
  // A ConfigMap's or a Secret's details (v1.36, ADR 0061). A ConfigMap shows its
  // values: what looks like a secret is masked until asked for, one key at a
  // time, and nothing here is put to the AI. A Secret shows its keys and says why
  // there is no value: the app never reads one (`kube::check_args`).
  //
  // The content only: `K8sConfigModal` shows it as a dialog, a wide panel puts it
  // into a `SidePane` beside the list (`panelcontainer.guard`).
  import Icon from "../ui/Icon.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import { tooltip } from "../actions/tooltip";
  import type { K8sConfig } from "./k8s";
  import { t } from "../i18n";

  let { config = null, fill = false }: { config?: K8sConfig | null; fill?: boolean } = $props();

  const SECTION = "mb-1 mt-3 flex items-center gap-1.5 text-caption uppercase tracking-wider text-muted";

  // The keys shown in clear, for this object — another object starts masked again.
  let shown = $state<ReadonlySet<string>>(new Set());
  let shownOf = "";
  $effect(() => {
    const key = config ? `${config.kind}/${config.namespace}/${config.name}` : "";
    if (key === shownOf) return;
    shownOf = key;
    shown = new Set();
  });
  function reveal(key: string) {
    const next = new Set(shown);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    shown = next;
  }
</script>

{#if config}
  <div class="{fill ? 'h-full min-h-0 overflow-auto' : ''} p-2.5 text-xs" data-testid="k8s-config-detail">
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      <dt class="text-muted">{t("k8s.kind")}</dt>
      <dd class="text-text/85">{config.kind}</dd>
      <dt class="text-muted">{t("k8s.namespace")}</dt>
      <dd class="font-mono text-text/85">{config.namespace}</dd>
      {#if config.type}
        <dt class="text-muted">{t("k8s.secretType")}</dt>
        <dd class="break-all font-mono text-text/85">{config.type}</dd>
      {/if}
      <dt class="text-muted">{t("k8s.age")}</dt>
      <dd class="text-text/85">{config.age || "—"}</dd>
    </dl>

    <section data-testid="k8s-config-entries">
      <h4 class={SECTION}>{t("k8s.configKeys")} <span class="tabular-nums">{config.entries.length}</span></h4>
      {#if config.kind === "Secret"}
        <p class="mb-1 px-1 text-caption text-muted" data-testid="k8s-secret-note">{t("k8s.secretValuesNotRead")}</p>
      {/if}
      {#if config.entries.length === 0}
        <p class="px-1 text-muted">{t("k8s.noKeys")}</p>
      {/if}
      {#each config.entries as e (e.key)}
        <div class="border-b border-edge/40 px-1 py-1" data-testid="k8s-config-entry">
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate font-mono text-text/90">{e.key}</span>
            {#if config.kind === "ConfigMap" && e.value !== null}
              {#if e.sensitive}
                <button
                  type="button"
                  class="shrink-0 rounded p-0.5 text-muted hover:bg-edge hover:text-text"
                  use:tooltip={t(shown.has(e.key) ? "k8s.hideValue" : "k8s.showValue")}
                  aria-label={t(shown.has(e.key) ? "k8s.hideValue" : "k8s.showValue")}
                  onclick={() => reveal(e.key)}
                  data-testid="k8s-config-reveal"
                >
                  <Icon name={shown.has(e.key) ? "eyeOff" : "eye"} size={12} />
                </button>
              {/if}
              {#if !e.sensitive || shown.has(e.key)}
                <CopyButton text={e.value} label={t("util.copy")} testid="k8s-config-copy" />
              {/if}
            {/if}
          </div>
          {#if config.kind === "ConfigMap"}
            {#if e.value === null}
              <p class="text-caption text-muted">{t("k8s.binaryData")}</p>
            {:else if e.sensitive && !shown.has(e.key)}
              <p class="font-mono text-caption text-muted" data-testid="k8s-config-masked">••••••</p>
            {:else}
              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-caption text-text/85 select-text" data-testid="k8s-config-value">{e.value}</pre>
            {/if}
          {/if}
        </div>
      {/each}
    </section>
  </div>
{/if}
