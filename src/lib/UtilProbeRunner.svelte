<script lang="ts">
  // Shared runner for the network utilities (Phase 34). Owns the session gating
  // and the two transports (INVARIANTS "чистая логика в .ts" — the arg building
  // and parsing stay in the per-tool .ts): on an SSH tab it runs the probe
  // remotely via `probe_run` and hands the raw ProbeOutput to the tool's `result`
  // snippet to parse; on a local tab it writes the command into the PTY (variant
  // B) so the user's own shell runs it. A prod tab confirms noisy ops first. Each
  // tool passes its input form (`form`) and result renderer (`result`) as
  // snippets and the current argv (`args`, null while inputs are invalid).
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";
  import { probeRun, type ProbeOutput } from "./api";
  import { writeToTerminal } from "./api";
  import { submitLine } from "./terminput";
  import { toShellCommand, type ProbeSession } from "./probe";

  let {
    session,
    args,
    timeoutSecs = 20,
    confirmProd = false,
    form,
    result,
  }: {
    session: ProbeSession | null;
    args: string[] | null;
    timeoutSecs?: number;
    /** Require a confirm before running on a prod-tagged SSH tab (e.g. scans). */
    confirmProd?: boolean;
    form: Snippet;
    result: Snippet<[ProbeOutput]>;
  } = $props();

  let running = $state(false);
  let output = $state<ProbeOutput | null>(null);
  let error = $state("");
  let confirming = $state(false);

  const encoder = new TextEncoder();
  const canRun = $derived(!!session && session.live && !!args && !running);
  const isLocal = $derived(session?.kind === "local");

  async function execute() {
    if (!session || !args) return;
    output = null;
    error = "";
    // Variant B: local tab — run in the PTY, output shows in the terminal.
    if (session.kind === "local") {
      await writeToTerminal(session.id, encoder.encode(submitLine(toShellCommand(args))));
      return;
    }
    // Variant A: SSH tab — run remotely and parse the captured output. The run
    // is mirrored into the session recording as `[util] $ …` audit (like git).
    running = true;
    try {
      output = await probeRun(session.id, args, timeoutSecs);
    } catch (e) {
      error = String(e);
    } finally {
      running = false;
    }
  }

  function run() {
    if (!canRun) return;
    if (confirmProd && session?.kind === "ssh" && session.isProd) {
      confirming = true;
      return;
    }
    void execute();
  }
</script>

<div class="space-y-3 text-xs text-muted">
  {@render form()}

  <div class="flex flex-wrap items-center gap-2 pt-1">
    <button
      type="button"
      data-testid="probe-run"
      class="flex items-center gap-1.5 rounded bg-accent/20 px-3 py-1.5 text-sm text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!canRun}
      onclick={run}
    >
      <Icon name={isLocal ? "terminal" : "play"} size={14} />
      {isLocal ? t("util.probe.runInTerminal") : t("util.probe.run")}
    </button>

    {#if session && session.live}
      <span class="text-meta text-muted" data-testid="probe-target">
        {#if isLocal}
          {t("util.probe.targetLocal")}
        {:else}
          {t("util.probe.targetHost", { host: session.host })}
        {/if}
      </span>
    {:else}
      <span class="flex items-center gap-1 text-meta text-warn" data-testid="probe-nosession">
        <Icon name="alert" size={12} />{t("util.probe.needSession")}
      </span>
    {/if}

    {#if running}
      <span class="text-meta text-muted" use:tooltip={t("util.probe.running")}>
        <Icon name="refresh" size={14} class="animate-spin" />
      </span>
    {/if}
  </div>

  {#if isLocal && session?.live}
    <p class="text-meta text-muted" data-testid="probe-localnote">{t("util.probe.localNote")}</p>
  {/if}

  {#if error}
    <pre class="whitespace-pre-wrap rounded border border-danger/40 bg-danger/10 p-2 font-mono text-meta text-danger" data-testid="probe-error">{error}</pre>
  {:else if output}
    {@render result(output)}
  {/if}
</div>

<ConfirmDialog
  open={confirming}
  danger
  title={t("util.probe.confirmProdTitle")}
  confirmLabel={t("util.probe.run")}
  onconfirm={() => {
    confirming = false;
    void execute();
  }}
  oncancel={() => (confirming = false)}
>
  {t("util.probe.confirmProdBody", { host: session?.host ?? "" })}
</ConfirmDialog>
