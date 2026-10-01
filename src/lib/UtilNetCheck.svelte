<script lang="ts">
  // Utilities → access check (v1.0.36): "can this host reach those ports?".
  // Rules are written like firewall requests (`src -> host:[ports]/tcp`, one per
  // line); the answer comes from the ACTIVE SESSION'S host — the server on an
  // SSH tab, this machine on a local tab — through one command (`netcheck_run`)
  // whose transport follows the session. Parsing, the remote script, verdicts
  // and the report are pure logic in netcheck.ts; this is the form + result view.
  import Icon from "./Icon.svelte";
  import CopyButton from "./CopyButton.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import InfoHint from "./InfoHint.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t, type MessageKey } from "./i18n";
  import { netcheckRun, recordAudit } from "./api";
  import { isRecording } from "./stores/recordings.svelte";
  import { probeError, type ProbeSession } from "./probe";
  import type { OpenMenu } from "./ctxmenu";
  import {
    parseRules,
    checkTargets,
    netcheckArgs,
    runBudgetSecs,
    parseNetReport,
    mergeReports,
    failedKeys,
    sourceMatch,
    egressDiffers,
    rowsFor,
    serviceName,
    tally,
    formatReport,
    reportStamp,
    historyLabel,
    visibleAddrs,
    isIpv4,
    effectiveMethod,
    PROBE_TOOLS,
    type MethodChoice,
    type ProbeTool,
    DEFAULT_TIMEOUT_SECS,
    type NetRule,
    type ReportWords,
    type NetReport,
    type NetTarget,
    type PortStatus,
    type Method,
    netcheckAudit,
    netcheckFailureAudit,
  } from "./netcheck";
  import {
    appendRuleLine,
    builderError,
    builderFilled,
    buildRuleLine,
    isDeletableLine,
    lineAtY,
    lineRange,
    removeLine,
    splitHostPort,
  } from "./netcheckform";
  import { methodFor, netcheckState, rememberRules, setMethod } from "./stores/netcheck.svelte";
  import { segmentStep } from "./segmented";

  let {
    session,
    onInstallTool,
    reloadToken = 0,
  }: {
    session: ProbeSession | null;
    /** Open the server-tools install dialog for a probe tool (SSH tabs only). */
    onInstallTool?: (tool: string) => void;
    /** Bumped after a tool install finishes → re-read the host's probe method. */
    reloadToken?: number;
  } = $props();

  let timeoutSecs = $state(DEFAULT_TIMEOUT_SECS);
  let identity = $state<NetReport | null>(null);
  let report = $state<NetReport | null>(null);
  let ranRules = $state<NetRule[]>([]);
  // When the report on screen was taken and with which timeout — the input can
  // change after the run, the report must describe the run.
  let ranAt = $state("");
  let ranTimeout = $state(DEFAULT_TIMEOUT_SECS);
  let running = $state(false);
  let error = $state("");
  let historyMenu = $state<OpenMenu | null>(null);

  const parsed = $derived(parseRules(netcheckState.draft));
  const live = $derived(!!session && session.live);
  const isLocal = $derived(session?.kind === "local");
  // History is per checking host: the same rules mean something else elsewhere.
  const historyKey = $derived(session ? (isLocal ? "local" : session.host) : "");
  const history = $derived(netcheckState.history[historyKey] ?? []);
  const facts = $derived(report ?? identity);
  const shownAddrs = $derived(facts ? visibleAddrs(facts.addrs) : []);
  // The probe method (v1.0.37): picked per checking host, "auto" by default. Only
  // an SSH host runs tools — a local tab connects natively, nothing to pick.
  const choice = $derived<MethodChoice>(isLocal ? "auto" : methodFor(historyKey));
  const tools = $derived(identity?.tools ?? {});
  const effective = $derived(isLocal ? null : effectiveMethod(choice, tools));
  // "auto" with nothing usable → the no-method banner; a picked tool that isn't
  // usable → the note under the picker (and no run: it would silently do nothing).
  const noMethod = $derived(choice === "auto" && facts?.method === "none");
  const pickedUnusable = $derived(choice !== "auto" && effective === "none");
  const canRun = $derived(
    live && parsed.rules.length > 0 && !running && !noMethod && !pickedUnusable,
  );
  const shownMethod = $derived<Method | null>(
    isLocal ? (facts?.method ?? null) : (effective ?? facts?.method ?? null),
  );
  const METHOD_TILES: MethodChoice[] = ["auto", ...PROBE_TOOLS];

  function pickMethod(m: MethodChoice) {
    setMethod(historyKey, m);
  }

  function onTileKey(e: KeyboardEvent, i: number) {
    const next = segmentStep(e.key, i, METHOD_TILES.length);
    if (next == null) return;
    e.preventDefault();
    pickMethod(METHOD_TILES[next]);
    tileEls[next]?.focus();
  }
  let tileEls: HTMLButtonElement[] = $state([]);

  const toolDot = (tool: ProbeTool): string => {
    const st = tools[tool];
    return st === "ok" ? "bg-ok" : st ? "bg-bad" : "bg-edge";
  };
  const toolUnusable = (tool: ProbeTool): boolean => !!tools[tool] && tools[tool] !== "ok";
  const retryKeys = $derived(report ? failedKeys(ranRules, report) : new Set<string>());

  const STATUS_KEY: Record<PortStatus, MessageKey> = {
    open: "util.netcheck.st.open",
    refused: "util.netcheck.st.refused",
    timeout: "util.netcheck.st.timeout",
    unreachable: "util.netcheck.st.unreachable",
    dns: "util.netcheck.st.dns",
    error: "util.netcheck.st.error",
    udp: "util.netcheck.st.udp",
    missing: "util.netcheck.st.missing",
  };
  const STATUS_HINT: Record<PortStatus, MessageKey> = {
    open: "util.netcheck.hint.open",
    refused: "util.netcheck.hint.refused",
    timeout: "util.netcheck.hint.timeout",
    unreachable: "util.netcheck.hint.unreachable",
    dns: "util.netcheck.hint.dns",
    error: "util.netcheck.hint.error",
    udp: "util.netcheck.hint.udp",
    missing: "util.netcheck.hint.missing",
  };
  const STATUS_CLASS: Record<PortStatus, string> = {
    open: "bg-ok/15 text-ok",
    refused: "bg-bad/15 text-bad",
    timeout: "bg-warn/20 text-warn",
    unreachable: "bg-bad/15 text-bad",
    dns: "bg-bad/15 text-bad",
    error: "bg-bad/15 text-bad",
    udp: "bg-edge text-muted",
    missing: "bg-edge text-muted",
  };
  const STATUS_ICON = {
    open: "check",
    refused: "close",
    timeout: "clock",
    unreachable: "close",
    dns: "alert",
    error: "alert",
    udp: "info",
    missing: "minus",
  } as const;
  // Tool names are domain terms; only the native method needs words.
  const methodLabel = (m: Method): string =>
    m === "native"
      ? t("util.netcheck.methodNative")
      : m === "bash"
        ? "bash /dev/tcp"
        : m === "none"
          ? "—"
          : m;
  const ERR_KEY: Record<string, MessageKey> = {
    syntax: "util.netcheck.err.syntax",
    host: "util.netcheck.err.host",
    unspecified: "util.netcheck.err.unspecified",
    port: "util.netcheck.err.port",
    range: "util.netcheck.err.range",
    empty: "util.netcheck.err.empty",
    tooMany: "util.netcheck.err.tooMany",
  };

  // Keyed by a primitive: `session` is re-derived as a fresh object on unrelated
  // tab-store updates, which must not wipe a result on screen.
  const liveId = $derived(session && session.live ? session.id : "");

  // A different tab (or a finished tool install) is a different host: drop the
  // old answer and read the new host's identity for the header.
  $effect(() => {
    const id = liveId;
    void reloadToken;
    report = null;
    ranRules = [];
    error = "";
    identity = null;
    if (id) void loadIdentity(id);
  });

  async function loadIdentity(id: string) {
    try {
      const out = await netcheckRun(id, netcheckArgs([]), [], DEFAULT_TIMEOUT_SECS, 15);
      if (liveId === id) identity = parseNetReport(out.stdout);
    } catch {
      /* the header just stays empty; a run reports its own error */
    }
  }

  async function probe(targets: NetTarget[]): Promise<NetReport | null> {
    if (!session) return null;
    const count = targets.reduce((n, x) => n + x.ports.length, 0);
    const out = await netcheckRun(
      session.id,
      netcheckArgs(targets, timeoutSecs, choice),
      targets,
      timeoutSecs,
      runBudgetSecs(count, timeoutSecs),
    );
    const rep = parseNetReport(out.stdout, timeoutSecs);
    if (!rep.hostname && rep.results.length === 0) {
      error = probeError(out.stdout, out.stderr, out.exitCode) || t("util.probe.noOutput");
      return null;
    }
    return rep;
  }

  /**
   * Record the run into an active session recording: the rules and the same
   * report "Copy report" gives (`netcheckAudit`), or the error — never the raw
   * line protocol. Record-only `[util]` block, like the sftp/git mirrors.
   */
  function recordRun(id: string, rules: NetRule[], retry: boolean) {
    if (!isRecording(id)) return;
    const entry =
      report && reportWords && !error
        ? netcheckAudit(rules, report, reportWords, ranAt, retry)
        : netcheckFailureAudit(rules, error || t("util.probe.noOutput"), retry);
    void recordAudit(id, entry).catch(() => {});
  }

  async function run() {
    if (!canRun || !session) return;
    const id = session.id;
    running = true;
    error = "";
    const rules = parsed.rules;
    rememberRules(historyKey, netcheckState.draft);
    try {
      const rep = await probe(checkTargets(rules));
      if (rep) {
        report = rep;
        ranRules = rules;
        ranAt = reportStamp(new Date());
        ranTimeout = timeoutSecs;
      }
    } catch (e) {
      error = String(e);
    } finally {
      running = false;
    }
    recordRun(id, rules, false);
  }

  async function retryFailed() {
    if (!report || running || retryKeys.size === 0 || !session) return;
    const id = session.id;
    running = true;
    error = "";
    try {
      const rep = await probe(checkTargets(ranRules, retryKeys));
      if (rep && report) {
        report = mergeReports(report, rep);
        ranAt = reportStamp(new Date());
      }
    } catch (e) {
      error = String(e);
    } finally {
      running = false;
    }
    recordRun(id, ranRules, true);
  }

  function onKeydown(e: KeyboardEvent) {
    // ⌘/Ctrl+Enter runs from the textarea, like a query editor.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run();
    }
  }

  // ── Rule builder (v1.0.37) ────────────────────────────────────────────────
  // Source defaults to the host's first address; `null` = not picked by hand, so
  // it follows the addresses once they load. "" = the explicit "no source".
  let sourcePick = $state<string | null>(null);
  let bTarget = $state("");
  let bPorts = $state("");
  let bProto = $state<"tcp" | "udp">("tcp");
  let targetEl = $state<HTMLInputElement | null>(null);
  const bSource = $derived(
    sourcePick !== null && (sourcePick === "" || shownAddrs.includes(sourcePick))
      ? sourcePick
      : (shownAddrs[0] ?? ""),
  );
  const bFields = $derived({ source: bSource, target: bTarget, ports: bPorts, proto: bProto });
  const bError = $derived(builderError(bFields));
  const canAdd = $derived(builderFilled(bFields) && !bError);

  function onTargetInput() {
    // `10.70.39.10:22` typed or pasted whole → spread over the two fields.
    const split = splitHostPort(bTarget);
    if (!split) return;
    bTarget = split.target;
    bPorts = split.ports;
  }

  function addRule() {
    if (!canAdd) return;
    netcheckState.draft = appendRuleLine(netcheckState.draft, buildRuleLine(bFields));
    bTarget = "";
    bPorts = "";
    targetEl?.focus();
  }

  function onBuilderKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addRule();
    }
  }

  // ── Per-line delete ───────────────────────────────────────────────────────
  // The box doesn't wrap, so a line's row is its index × line height; the trash
  // sits in a right-hand gutter over the textarea, beside the hovered line.
  let rulesEl = $state<HTMLTextAreaElement | null>(null);
  let hoverLine = $state(-1);
  let trashTop = $state(0);

  function metrics(el: HTMLTextAreaElement) {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 0;
    const top = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
    return { lh, top };
  }

  function trackLine(e: MouseEvent) {
    const el = rulesEl;
    if (!el) return;
    const { lh, top } = metrics(el);
    const y = e.clientY - el.getBoundingClientRect().top - top;
    const i = lineAtY(y, el.scrollTop, lh);
    hoverLine = isDeletableLine(netcheckState.draft, i) ? i : -1;
    trashTop = top + i * lh - el.scrollTop;
  }

  /**
   * Delete a whole line. Goes through the editor's own "delete selection" so the
   * textarea records it and ⌘/Ctrl+Z brings the line back — a draft line isn't
   * stored data, so no confirm dialog, but it must be undoable. Without that
   * command (tests, a future engine) the text is rewritten directly.
   */
  function deleteLine(index: number) {
    const el = rulesEl;
    const r = lineRange(netcheckState.draft, index);
    if (!el || !r) return;
    el.focus();
    el.setSelectionRange(r.start, r.end);
    const recorded =
      typeof document.execCommand === "function" && document.execCommand("delete");
    if (!recorded) netcheckState.draft = removeLine(netcheckState.draft, index);
    hoverLine = -1;
  }

  function openHistory(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    historyMenu = {
      x: r.left,
      y: r.bottom + 4,
      items: history.map((entry) => ({
        label: historyLabel(entry),
        icon: "history" as const,
        onSelect: () => (netcheckState.draft = entry),
      })),
    };
  }

  /** The rule's source as written, with its `(note)` — for warnings that name it. */
  const sourceText = (rule: NetRule) =>
    [rule.source, rule.sourceLabel && `(${rule.sourceLabel})`].filter(Boolean).join(" ");

  const reportWords = $derived<ReportWords | null>(
    report
      ? {
          title: t("util.netcheck.title"),
          tally: (open: number, total: number) => t("util.netcheck.reportTally", { open, total }),
          method: t("util.netcheck.reportMethod", {
            method: report.method ? methodLabel(report.method) : "—",
            n: ranTimeout,
          }),
          ms: (n: number) => t("util.netcheck.ms", { n }),
          ruleSource: (source: string) => t("util.netcheck.reportRuleSource", { source }),
          status: Object.fromEntries(
            (Object.keys(STATUS_KEY) as PortStatus[]).map((s) => [s, t(STATUS_KEY[s])]),
          ) as Record<PortStatus, string>,
          cols: {
            source: t("util.netcheck.col.source"),
            target: t("util.netcheck.col.target"),
            port: t("util.netcheck.col.port"),
            status: t("util.netcheck.col.status"),
            time: t("util.netcheck.col.time"),
            service: t("util.netcheck.col.service"),
          },
        }
      : null,
  );
  const reportText = $derived(
    report && reportWords ? formatReport(ranRules, report, reportWords, { at: ranAt }) : "",
  );
  const reportMarkdown = $derived(
    report && reportWords
      ? formatReport(ranRules, report, reportWords, { at: ranAt, format: "markdown" })
      : "",
  );
</script>

<div class="space-y-3 text-xs text-muted" data-testid="netcheck">
  <!-- Who is checking: the session host's name, addresses and probe method. -->
  <div class="flex items-center gap-2 rounded border border-edge bg-panel px-3 py-2">
    <Icon name={isLocal ? "terminal" : "server"} size={15} class="shrink-0 text-accent" />
    <div class="min-w-0 flex-1">
      {#if live}
        <div class="flex flex-wrap items-baseline gap-x-2">
          <span class="text-meta text-muted">{t("util.netcheck.from")}</span>
          <span class="font-mono text-sm text-text" data-testid="netcheck-hostname">
            {facts?.hostname || session?.host || "—"}
          </span>
          <span class="truncate font-mono text-meta text-muted" data-testid="netcheck-addrs">
            {shownAddrs.join(", ")}
          </span>
        </div>
        {#if shownMethod && shownMethod !== "none"}
          <div class="text-meta text-muted" data-testid="netcheck-method">
            {t("util.netcheck.method", { method: methodLabel(shownMethod) })}
          </div>
        {/if}
      {:else}
        <span class="flex items-center gap-1 text-meta text-warn" data-testid="netcheck-nosession">
          <Icon name="alert" size={12} />{t("util.probe.needSession")}
        </span>
      {/if}
    </div>
    {#if live}
      <span class="text-caption uppercase tracking-wider text-muted">{isLocal ? t("util.netcheck.local") : "SSH"}</span>
    {/if}
  </div>

  {#if live && noMethod}
    <div class="flex items-center gap-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-warn" data-testid="netcheck-nomethod">
      <Icon name="wrench" size={14} class="shrink-0" />
      <span class="flex-1">{t("util.netcheck.noMethod")}</span>
      {#if !isLocal && onInstallTool}
        <button
          type="button"
          class="rounded bg-edge px-2 py-1 text-text hover:bg-accent hover:text-panel-alt"
          data-testid="netcheck-install-telnet"
          onclick={() => onInstallTool("telnet")}
        >
          {t("util.netcheck.installTelnet")}
        </button>
      {/if}
    </div>
  {/if}

  <!-- Probe method (SSH only): tiles that wrap 5 → 3+2 → 2+2+1 as the panel
       narrows (container queries). A tool that isn't usable is struck through but
       still pickable — picking it says why and offers the install. -->
  {#if live && !isLocal}
    <div class="@container" data-testid="netcheck-methods">
      <div class="mb-1 flex items-center gap-1.5">
        <span>{t("util.netcheck.methodTitle")}</span>
        <InfoHint text={t("util.netcheck.methodsHint")} />
      </div>
      <div
        role="radiogroup"
        aria-label={t("util.netcheck.methodTitle")}
        class="grid grid-cols-2 gap-1 @min-[16rem]:grid-cols-3 @min-[26rem]:grid-cols-5"
      >
        {#each METHOD_TILES as m, i (m)}
          {@const sel = choice === m}
          {@const bad = m !== "auto" && toolUnusable(m)}
          <button
            bind:this={tileEls[i]}
            type="button"
            role="radio"
            aria-checked={sel}
            tabindex={sel ? 0 : -1}
            data-testid={`netcheck-method-${m}`}
            class="flex min-w-0 items-center justify-center gap-1.5 rounded border px-2 py-1 font-mono {sel
              ? 'border-accent bg-accent/15 text-accent'
              : 'border-edge text-text hover:bg-edge'}"
            use:tooltip={m === "auto" && effective && effective !== "none"
              ? t("util.netcheck.methodAutoNow", { method: methodLabel(effective) })
              : ""}
            onclick={() => pickMethod(m)}
            onkeydown={(e) => onTileKey(e, i)}
          >
            {#if m !== "auto"}
              <span class="h-1.5 w-1.5 shrink-0 rounded-full {toolDot(m)}"></span>
            {/if}
            <span class="truncate {bad ? 'line-through' : ''} {bad && !sel ? 'text-muted' : ''}">
              {m === "auto" ? t("util.netcheck.methodAuto") : m}
            </span>
          </button>
        {/each}
      </div>
      {#if pickedUnusable && choice !== "auto"}
        <div class="mt-1.5 flex flex-wrap items-center gap-2 text-meta text-warn" data-testid="netcheck-method-missing">
          <Icon name="alert" size={12} class="shrink-0" />
          <span class="min-w-0 flex-1">
            {tools[choice] === "notimeout"
              ? t("util.netcheck.toolNoTimeout", { tool: choice })
              : t("util.netcheck.toolMissing", { tool: choice })}
          </span>
          {#if tools[choice] === "missing" && choice !== "bash" && onInstallTool}
            <button
              type="button"
              class="rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt"
              data-testid="netcheck-method-install"
              onclick={() => onInstallTool(choice)}
            >
              {t("util.netcheck.installTool", { tool: choice })}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Rules -->
  <div>
    <div class="mb-1 flex items-center gap-1.5">
      <span>{t("util.netcheck.rules")}</span>
      <InfoHint text={t("util.netcheck.rulesHint")} />
      <span class="flex-1"></span>
      {#if history.length}
        <button
          type="button"
          class="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-muted hover:bg-edge hover:text-text"
          data-testid="netcheck-history"
          onclick={openHistory}
        >
          <Icon name="history" size={12} />{t("util.netcheck.recent")}
        </button>
      {/if}
    </div>
    <!-- Builder: one rule from fields with grey hints; Add/Enter appends it as a
         line below. The box stays plain text for pasting whole requests. -->
    <div class="mb-2 flex flex-wrap items-center gap-1.5" data-testid="netcheck-builder">
      <select
        class="rounded border border-edge bg-panel px-1.5 py-1 font-mono text-text outline-none focus:border-accent"
        data-testid="netcheck-b-source"
        aria-label={t("util.netcheck.builderSource")}
        value={bSource}
        onchange={(e) => (sourcePick = (e.currentTarget as HTMLSelectElement).value)}
      >
        {#each shownAddrs as a (a)}
          <option value={a}>{a}</option>
        {/each}
        <option value="">{t("util.netcheck.builderNoSource")}</option>
      </select>
      <span class="text-text">→</span>
      <input
        bind:this={targetEl}
        class="w-36 min-w-0 rounded border border-edge bg-panel px-1.5 py-1 font-mono text-text outline-none placeholder:text-muted focus:border-accent"
        data-testid="netcheck-b-target"
        aria-label={t("util.netcheck.builderTarget")}
        placeholder="0.0.0.0"
        spellcheck="false"
        bind:value={bTarget}
        oninput={onTargetInput}
        onkeydown={onBuilderKey}
      />
      <span class="text-text">:</span>
      <input
        class="w-24 min-w-0 rounded border border-edge bg-panel px-1.5 py-1 font-mono text-text outline-none placeholder:text-muted focus:border-accent"
        data-testid="netcheck-b-ports"
        aria-label={t("util.netcheck.builderPorts")}
        placeholder="22, 443"
        spellcheck="false"
        bind:value={bPorts}
        onkeydown={onBuilderKey}
      />
      <select
        class="rounded border border-edge bg-panel px-1.5 py-1 font-mono text-text outline-none focus:border-accent"
        data-testid="netcheck-b-proto"
        aria-label={t("util.netcheck.builderProto")}
        bind:value={bProto}
      >
        <option value="tcp">tcp</option>
        <option value="udp">udp</option>
      </select>
      <button
        type="button"
        class="flex items-center gap-1 rounded bg-edge px-2 py-1 text-text hover:bg-accent hover:text-panel-alt disabled:opacity-40"
        data-testid="netcheck-b-add"
        disabled={!canAdd}
        onclick={addRule}
      >
        <Icon name="plus" size={12} />{t("util.netcheck.builderAdd")}
      </button>
    </div>
    {#if bError}
      <p class="-mt-1 mb-2 flex items-center gap-1 text-meta text-bad" data-testid="netcheck-b-error">
        <Icon name="alert" size={12} />
        {t(ERR_KEY[bError.code], { token: bError.token })}
      </p>
    {/if}
    <div
      class="relative"
      role="presentation"
      onmousemove={trackLine}
      onmouseleave={() => (hoverLine = -1)}
    >
      <!-- wrap="off": one text line = one row of fixed height, so the trash in the
           gutter lines up with its line (lineAtY). pr-8 keeps text off the gutter. -->
      <textarea
        bind:this={rulesEl}
        data-testid="netcheck-rules"
        rows="4"
        wrap="off"
        spellcheck="false"
        class="w-full resize-y rounded border border-edge bg-panel py-1.5 pl-2 pr-8 font-mono text-sm leading-6 text-text outline-none focus:border-accent"
        placeholder="10.64.48.180 -> 10.70.39.10:[22, 80, 443]/tcp"
        bind:value={netcheckState.draft}
        onkeydown={onKeydown}
        onscroll={() => (hoverLine = -1)}
      ></textarea>
      {#if hoverLine >= 0}
        <button
          type="button"
          class="absolute right-1.5 flex h-6 items-center rounded px-1 text-muted hover:text-danger"
          style="top: {trashTop}px"
          data-testid="netcheck-delete-line"
          use:tooltip={t("util.netcheck.deleteLine")}
          aria-label={t("util.netcheck.deleteLine")}
          onclick={() => deleteLine(hoverLine)}
        >
          <Icon name="trash" size={13} />
        </button>
      {/if}
    </div>
    {#each parsed.errors as err (err.line)}
      <p class="mt-0.5 flex items-center gap-1 text-meta text-bad" data-testid="netcheck-parse-error">
        <Icon name="alert" size={12} />
        {t("util.netcheck.lineN", { n: err.line })}: {t(ERR_KEY[err.code], { token: err.token })}
      </p>
    {/each}
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <button
      type="button"
      data-testid="netcheck-run"
      class="flex items-center gap-1.5 rounded bg-accent/20 px-3 py-1.5 text-sm text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!canRun}
      onclick={run}
    >
      <Icon name="play" size={14} />{t("util.netcheck.run")}
    </button>
    <label class="flex items-center gap-1">
      {t("util.netcheck.timeout")}
      <input
        type="number"
        min="1"
        max="30"
        class="w-14 rounded border border-edge bg-panel px-1.5 py-1 font-mono text-text outline-none focus:border-accent"
        bind:value={timeoutSecs}
      />
      {t("util.netcheck.sec")}
    </label>
    {#if running}
      <span class="text-meta text-muted" use:tooltip={t("util.probe.running")}>
        <Icon name="refresh" size={14} class="animate-spin" />
      </span>
    {/if}
  </div>

  <!-- Source mismatches: the check runs from HERE whatever the rule says. -->
  {#if facts}
    {#each parsed.rules as rule (rule.line)}
      {@const m = sourceMatch(rule.source, facts)}
      {#if m === "foreign"}
        <div class="flex gap-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-warn" data-testid="netcheck-source-warn">
          <Icon name="alert" size={14} class="mt-0.5 shrink-0" />
          <span>
            {t("util.netcheck.sourceForeign", {
              n: rule.line,
              source: sourceText(rule),
              addrs: shownAddrs.join(", ") || "—",
            })}
          </span>
        </div>
      {:else if m === "unknown"}
        <p class="flex items-center gap-1 text-meta text-muted">
          <Icon name="info" size={12} />{t("util.netcheck.sourceUnknown", { n: rule.line })}
        </p>
      {/if}
    {/each}
  {/if}

  {#if error}
    <pre class="whitespace-pre-wrap rounded border border-danger/40 bg-danger/10 p-2 font-mono text-meta text-danger" data-testid="netcheck-error">{error}</pre>
  {/if}

  {#if report}
    {#if !report.complete}
      <p class="flex items-center gap-1 text-meta text-warn" data-testid="netcheck-incomplete">
        <Icon name="alert" size={12} />{t("util.netcheck.incomplete")}
      </p>
    {/if}

    <div class="space-y-3" data-testid="netcheck-results">
      {#each ranRules as rule (rule.line)}
        {#each rule.targets as host (host)}
          {@const rows = rowsFor(rule, host, report)}
          {@const sum = tally(rows)}
          {@const resolved = report.resolved[host]}
          {@const src = report.routeSrc[host]}
          <div class="rounded border border-edge" data-testid="netcheck-target">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-edge bg-panel px-3 py-1.5">
              <span class="font-mono text-sm text-text">{host}</span>
              {#if rule.label}
                <span class="text-sm text-accent" data-testid="netcheck-label">{rule.label}</span>
              {/if}
              {#if !isIpv4(host) && resolved}
                <span class="font-mono text-meta text-muted">{resolved}</span>
              {:else if resolved === ""}
                <span class="text-meta text-bad">{t("util.netcheck.noResolve")}</span>
              {/if}
              <span class="text-meta text-muted">/{rule.proto}</span>
              {#if src}
                <span
                  class="flex items-center gap-1 text-meta {egressDiffers(rule.source, host, report) ? 'text-warn' : 'text-muted'}"
                  data-testid="netcheck-egress"
                  use:tooltip={t("util.netcheck.egressHint")}
                >
                  {t("util.netcheck.egress")}: <span class="font-mono">{src}</span>
                  {#if egressDiffers(rule.source, host, report)}
                    <Icon name="alert" size={12} />
                  {:else if rule.source === src}
                    <Icon name="check" size={12} class="text-ok" />
                  {/if}
                </span>
              {/if}
              <span class="flex-1"></span>
              {#if sum.checked > 0}
                <span
                  class="rounded px-2 py-0.5 text-meta {sum.open === sum.checked ? 'bg-ok/15 text-ok' : sum.open === 0 ? 'bg-bad/15 text-bad' : 'bg-warn/20 text-warn'}"
                  data-testid="netcheck-tally"
                >
                  {t("util.netcheck.tally", { open: sum.open, total: sum.checked })}
                </span>
              {/if}
            </div>
            {#if egressDiffers(rule.source, host, report)}
              <p class="border-b border-edge px-3 py-1 text-meta text-warn">
                {t("util.netcheck.egressDiffers", { source: sourceText(rule), src: src ?? "" })}
              </p>
            {/if}
            <table class="w-full">
              <tbody>
                {#each rows as r (r.port)}
                  <tr class="border-b border-edge/50 last:border-0" data-testid="netcheck-row">
                    <td class="w-16 py-1 pl-3 font-mono text-text">{r.port}</td>
                    <td class="w-32 py-1">
                      <span
                        class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta {STATUS_CLASS[r.status]}"
                        data-testid={`netcheck-status-${r.status}`}
                        use:tooltip={t(STATUS_HINT[r.status])}
                      >
                        <Icon name={STATUS_ICON[r.status]} size={11} />{t(STATUS_KEY[r.status])}
                      </span>
                    </td>
                    <td class="w-20 py-1 font-mono text-meta">
                      {r.ms === null ? "" : t("util.netcheck.ms", { n: r.ms })}
                    </td>
                    <td class="max-w-0 py-1 pr-3 text-meta">
                      <div class="flex min-w-0 items-center gap-2">
                        {#if serviceName(r.port)}
                          <span class="shrink-0 text-muted">{serviceName(r.port)}</span>
                        {/if}
                        {#if r.detail && r.status !== "open"}
                          <span class="min-w-0 truncate font-mono text-muted" title={r.detail}>{r.detail}</span>
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/each}
      {/each}
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <CopyButton text={reportText} label={t("util.netcheck.copyReport")} testid="netcheck-copy" />
      <CopyButton
        text={reportMarkdown}
        label={t("util.netcheck.copyMarkdown")}
        testid="netcheck-copy-md"
      />
      {#if retryKeys.size > 0}
        <button
          type="button"
          data-testid="netcheck-retry"
          class="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-muted hover:bg-edge hover:text-text disabled:opacity-40"
          disabled={running}
          onclick={retryFailed}
        >
          <Icon name="refresh" size={12} />{t("util.netcheck.retry", { n: retryKeys.size })}
        </button>
      {/if}
    </div>
  {/if}
</div>

<ContextMenu menu={historyMenu} onclose={() => (historyMenu = null)} />
