<script lang="ts">
  // Shared runner for the network utilities (Phase 34). Owns the session gating
  // and the transports (INVARIANTS "чистая логика в .ts" — the arg building and
  // parsing stay in the per-tool .ts). "Run" captures the output and hands it to
  // the tool's `result` snippet to parse: on an SSH tab via `probe_run` on the
  // server, on a local tab by spawning the user's own curl/openssl here as a
  // chain of steps (ADR 0014). A local tab also offers "Run in terminal": the
  // tool's command, rendered for the shell that tab runs, typed into its PTY. A
  // prod tab confirms noisy ops first. Each tool passes its input form (`form`)
  // and result renderer (`result`) as snippets, the current argv (`args`, null
  // while inputs are invalid) and, where they differ, the local `steps` and the
  // `terminalCommand`. A captured run is recorded into an active session
  // recording as a `[util]` block built by the tool's `audit` from the PARSED
  // result, secrets masked (the sftp/git mirror shape, record-only). "Run in
  // terminal" needs no audit: the typed command and its output are the
  // recording's own input/output.
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";
  import { probeRun, recordAudit, type ProbeOutput } from "./api";
  import { isRecording } from "./stores/recordings.svelte";
  import { writeToTerminal } from "./api";
  import { submitLine } from "./terminput";
  import { stepFailed, type AuditEntry, type ProbeSession, type ProbeSteps } from "./probe";

  let {
    session,
    args,
    steps = null,
    terminalCommand = null,
    timeoutSecs = 20,
    confirmProd = false,
    audit = null,
    form,
    result,
  }: {
    session: ProbeSession | null;
    /** The probe as one argv — what an SSH tab runs (and a local one, if no `steps`). */
    args: string[] | null;
    /** The probe as piped argv steps for a local tab (no shell); defaults to `[args]`. */
    steps?: ProbeSteps | null;
    /** The line typed into a local tab's terminal; null = can't be expressed there. */
    terminalCommand?: string | null;
    timeoutSecs?: number;
    /** Require a confirm before running on a prod-tagged SSH tab (e.g. scans). */
    confirmProd?: boolean;
    /** The run as the recording shows it, from its output (frozen inputs). */
    audit?: ((out: ProbeOutput) => AuditEntry) | null;
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
  const canType = $derived(canRun && isLocal && !!terminalCommand);
  // The tool a local run needs, for the "not installed here" hint.
  const program = $derived((steps ?? (args ? [args] : []))[0]?.[0] ?? "");
  const missingLocally = $derived(
    isLocal && !!output && output.exitCode === 127 && !output.stdout.trim(),
  );

  /** Local run: feed each step's stdout to the next; stop at the first failure. */
  async function runSteps(id: string, chain: ProbeSteps): Promise<ProbeOutput> {
    let out: ProbeOutput | null = null;
    for (const [i, argv] of chain.entries()) {
      out = await probeRun(id, argv, timeoutSecs, out ? out.stdout : null);
      if (i < chain.length - 1 && stepFailed(out)) break;
    }
    return out!;
  }

  async function execute() {
    if (!session || !args) return;
    // Frozen at the click: the form may change while the probe runs.
    const id = session.id;
    const auditOf = audit;
    output = null;
    error = "";
    running = true;
    try {
      output =
        session.kind === "local"
          ? await runSteps(id, steps ?? [args])
          : await probeRun(id, args, timeoutSecs);
    } catch (e) {
      error = String(e);
    } finally {
      running = false;
    }
    if (auditOf && isRecording(id)) {
      const out = output ?? { stdout: "", stderr: error, exitCode: 1 };
      void recordAudit(id, auditOf(out)).catch(() => {});
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

  /** Local tab: type the command into its terminal; the output appears there. */
  async function typeIntoTerminal() {
    if (!canType || !session || !terminalCommand) return;
    output = null;
    error = "";
    await writeToTerminal(session.id, encoder.encode(submitLine(terminalCommand)));
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
      <Icon name="play" size={14} />
      {t("util.probe.run")}
    </button>
    {#if isLocal}
      <button
        type="button"
        data-testid="probe-terminal"
        class="flex items-center gap-1.5 rounded px-3 py-1.5 text-sm text-muted hover:bg-edge hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canType}
        onclick={() => void typeIntoTerminal()}
        use:tooltip={canRun && !terminalCommand
          ? t("util.probe.terminalUnavailable")
          : t("util.probe.runInTerminalHint")}
      >
        <Icon name="terminal" size={14} />
        {t("util.probe.runInTerminal")}
      </button>
    {/if}

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

  {#if missingLocally}
    <p class="flex items-center gap-1 text-meta text-warn" data-testid="probe-missing">
      <Icon name="alert" size={12} />{t("util.probe.toolMissing", { tool: program })}
    </p>
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
