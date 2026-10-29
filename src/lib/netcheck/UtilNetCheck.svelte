<script lang="ts">
  // Utilities → access check (v1.0.36; requests, several servers, subnets and a
  // stop — v1.21, ADR 0032; picked servers and this computer's tools — v1.22,
  // ADR 0033): "can those hosts reach those ports?". A request is pasted as it
  // came and read into a table of rules (NetCheckRuleTable); each rule runs from
  // the server its source names (netroute.ts) — from the servers picked in the
  // chips when it names none (the tab the tool was opened on, until others are
  // picked) — over that server's session, through one command (`netcheck_run`)
  // whose transport follows the session. The answer is target:port × server
  // (NetCheckMatrix). Rules, picks and the last run live in the store per home
  // host: another tab shows its own.
  import { untrack } from "svelte";
  import Icon from "../ui/Icon.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import NetCheckHosts from "./NetCheckHosts.svelte";
  import NetCheckRuleTable from "./NetCheckRuleTable.svelte";
  import NetCheckMatrix from "./NetCheckMatrix.svelte";
  import { t } from "../i18n";
  import { netcheckRun } from "../api";
  import {
    BATCH,
    DEFAULT_TIMEOUT_SECS,
    MAX_CHECKS,
    checkCount,
    effectiveMethod,
    failedKeys,
    formatReports,
    netcheckArgs,
    parseNetReport,
    visibleAddrs,
    type NetReport,
  } from "./netcheck";
  import {
    buildHosts,
    LOCAL_KEY,
    planRun,
    routeRow,
    type HostFacts,
    type HostPlan,
    type HostServer,
    type HostTab,
    type NetHost,
  } from "./netroute";
  import { rowRules, rowsText } from "./netcheckform";
  import { reportWords } from "./netcheckwords";
  import {
    isRunning,
    methodFor,
    pickedOf,
    retryRun,
    rowsOf,
    runOf,
    startRun,
    stopRun,
    togglePicked,
  } from "../stores/netcheck.svelte";

  let {
    homeId = null,
    servers = [],
    tabs = [],
    onConnect,
    onInstallTool,
    reloadToken = 0,
  }: {
    /** The session of the tab the tool was opened on. */
    homeId?: string | null;
    servers?: HostServer[];
    tabs?: HostTab[];
    /** Open a session to a server a rule needs. */
    onConnect?: (serverId: string) => void;
    /** Open the server-tools install dialog for a probe tool on that session. */
    onInstallTool?: (tool: string, sessionId?: string) => void;
    /** Bumped after a tool install finishes → re-read the hosts' probe methods. */
    reloadToken?: number;
  } = $props();

  const hosts = $derived(buildHosts(servers, tabs, homeId));
  const home = $derived(hosts.find((h) => !!homeId && h.sessionId === homeId) ?? null);
  const homeKey = $derived(home?.key ?? "");

  /** A host's name as the tool shows it. */
  function hostName(key: string): string {
    if (key === LOCAL_KEY) return t("util.netcheck.thisMachine");
    return hosts.find((h) => h.key === key)?.name || key;
  }

  // ── Who the sessions are (the identity probe) ───────────────────────────
  // Hostname, addresses and probe tools, by session id: the chip tooltips, the
  // method tiles, and matching a rule's source to a multi-homed server.
  let identities = $state<Record<string, NetReport>>({});
  let asked = new Set<string>();
  let seenToken = -1;
  const facts = $derived<Record<string, HostFacts>>(
    Object.fromEntries(
      Object.entries(identities).map(([sid, r]) => [sid, { hostname: r.hostname, addrs: visibleAddrs(r.addrs) }]),
    ),
  );

  async function loadIdentity(sid: string) {
    if (asked.has(sid)) return;
    asked.add(sid);
    try {
      const out = await netcheckRun(sid, netcheckArgs([]), [], DEFAULT_TIMEOUT_SECS, 15, `netcheck-id:${sid}:${Date.now()}`);
      identities[sid] = parseNetReport(out.stdout);
    } catch {
      /* the chip just shows no details; a run reports its own error */
    }
  }

  // ── Rules, routes and the plan ───────────────────────────────────────────
  const rows = $derived(rowsOf(homeKey));
  // Where rules without a source go: the picked chips.
  const picked = $derived(pickedOf(homeKey));
  const parsed = $derived(rows.map((row) => ({ row, ...rowRules(row) })));
  const planRows = $derived(parsed.filter((p) => !p.error).map((p) => ({ rules: p.rules, via: p.row.via })));
  const plan = $derived(homeKey ? planRun(planRows, hosts, facts, picked) : null);
  const routes = $derived(
    parsed.map((p) => (p.error ? null : routeRow({ rules: p.rules, via: p.row.via }, hosts, facts, picked))),
  );
  const badRows = $derived(parsed.filter((p) => p.error && (p.row.targets.trim() || p.row.ports.trim())).length);
  const allPlans = $derived<HostPlan[]>(plan ? [...plan.ready, ...plan.overCap, ...plan.waiting] : []);

  // Probe who a session is only where it matters: the home tab, the picked
  // servers, the servers the run will use, and — while a source matches no
  // server — every live session, since its address may be a second one of a
  // server already open.
  const wanted = $derived.by(() => {
    const ids = new Set<string>();
    if (home?.live && home.sessionId) ids.add(home.sessionId);
    for (const h of hosts) if (h.live && h.sessionId && picked.includes(h.key)) ids.add(h.sessionId);
    for (const p of plan?.ready ?? []) if (p.host.sessionId) ids.add(p.host.sessionId);
    if (routes.some((r) => r?.how === "fallback")) {
      for (const h of hosts) if (h.live && h.sessionId) ids.add(h.sessionId);
    }
    return [...ids];
  });
  $effect(() => {
    const token = reloadToken;
    const ids = wanted;
    untrack(() => {
      // A finished tool install changes what a host can probe with: ask again.
      if (token !== seenToken) {
        seenToken = token;
        identities = {};
        asked = new Set();
      }
      for (const sid of ids) void loadIdentity(sid);
    });
  });

  // The chips: the home tab's server first, then every other with an open tab
  // (one per address), picked or with a part in the run.
  const inPlan = $derived(new Set(allPlans.map((p) => p.host.key)));
  const chips = $derived(
    [home, ...hosts.filter((h) => h.key !== home?.key)].filter(
      (h): h is NetHost => !!h && (h.hasTab || picked.includes(h.key) || inPlan.has(h.key)),
    ),
  );
  // A method row for every server that checks something.
  const methodHosts = $derived(chips.filter((h) => picked.includes(h.key) || inPlan.has(h.key)));
  const checksOf = (key: string) => allPlans.find((p) => p.host.key === key)?.checks ?? 0;

  // A server whose chosen probe can't run blocks the run, by name.
  const noMethodOn = $derived(
    (plan?.ready ?? [])
      .filter((p) => {
        if (!p.host.sessionId) return false;
        const id = identities[p.host.sessionId];
        return !!id && effectiveMethod(methodFor(p.host.key), id.tools, p.host.kind === "local") === "none";
      })
      .map((p) => hostName(p.host.key)),
  );

  // ── Running ──────────────────────────────────────────────────────────────
  let timeoutSecs = $state(DEFAULT_TIMEOUT_SECS);
  const run = $derived(runOf(homeKey));
  const running = $derived(isRunning(run));
  const totalChecks = $derived((plan?.ready ?? []).reduce((n, p) => n + p.checks, 0));
  const canRun = $derived(
    !!plan &&
      plan.ready.length > 0 &&
      plan.overCap.length === 0 &&
      plan.unrouted === 0 &&
      noMethodOn.length === 0 &&
      !running,
  );
  // Sweeping a subnet is asked first, on any server; a production one says so.
  const subnetPlans = $derived((plan?.ready ?? []).filter((p) => p.subnet));
  let confirming = $state(false);

  function requestRun() {
    if (!canRun) return;
    if (subnetPlans.length > 0) confirming = true;
    else void go();
  }

  async function go() {
    confirming = false;
    if (!canRun || !plan) return;
    await startRun(homeKey, plan.ready, timeoutSecs, rowsText(rows));
  }

  // Seconds since the run started, and the most it can take — every batch may
  // wait out the timeout.
  let started = $state(0);
  let now = $state(0);
  $effect(() => {
    if (!running) return;
    started = Date.now();
    now = started;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const longest = $derived(
    Math.max(0, ...(run?.hosts ?? []).map((h) => Math.ceil(checkCount(h.rules) / BATCH) * (run?.timeout ?? 0))),
  );

  // What "Retry failed" would check again: what didn't open, and every check of
  // a server that answered nothing.
  const retryCount = $derived(
    !run || running
      ? 0
      : run.hosts.reduce((n, h) => n + (h.report ? failedKeys(h.rules, h.report).size : checkCount(h.rules)), 0),
  );

  const reportParts = $derived(
    (run?.hosts ?? [])
      .filter((h) => h.report)
      .map((h) => ({ rules: h.rules, rep: h.report!, words: reportWords(h.report!.method, run?.timeout ?? timeoutSecs) })),
  );
  const reportText = $derived(run && reportParts.length ? formatReports(reportParts, { at: run.at }) : "");
  const reportMarkdown = $derived(
    run && reportParts.length ? formatReports(reportParts, { at: run.at, format: "markdown" }) : "",
  );
</script>

<div class="space-y-3 text-xs text-muted" data-testid="netcheck">
  {#if !home}
    <div class="flex items-center gap-2 rounded border border-edge bg-panel px-3 py-2">
      <span class="flex items-center gap-1 text-meta text-warn" data-testid="netcheck-nosession">
        <Icon name="alert" size={12} />{t("util.probe.needSession")}
      </span>
    </div>
  {:else}
    <NetCheckHosts
      hosts={chips}
      {picked}
      {methodHosts}
      {identities}
      {checksOf}
      {hostName}
      onToggle={(key) => togglePicked(homeKey, key)}
      {onConnect}
      {onInstallTool}
    />

    <NetCheckRuleTable {homeKey} {hosts} {picked} errors={parsed.map((p) => p.error)} {routes} {hostName} />

    <!-- What keeps the run from starting, or part of it from running — by name. -->
    {#each plan?.overCap ?? [] as p (p.host.key)}
      <p class="flex items-center gap-1 text-meta text-bad" data-testid="netcheck-overcap">
        <Icon name="alert" size={12} />{t("util.netcheck.overCap", { host: hostName(p.host.key), n: p.checks, max: MAX_CHECKS })}
      </p>
    {/each}
    {#if plan?.unrouted}
      <p class="flex items-center gap-1 text-meta text-warn" data-testid="netcheck-pick-none">
        <Icon name="alert" size={12} />{t("util.netcheck.pickNone")}
      </p>
    {/if}
    {#if noMethodOn.length}
      <p class="flex items-center gap-1 text-meta text-warn" data-testid="netcheck-nomethod-on">
        <Icon name="wrench" size={12} />{t("util.netcheck.noMethodOn", { hosts: noMethodOn.join(", ") })}
      </p>
    {/if}
    {#if plan?.waiting.length}
      <p class="flex items-center gap-1 text-meta text-warn" data-testid="netcheck-waiting">
        <Icon name="plug" size={12} />{t("util.netcheck.waiting", { hosts: plan.waiting.map((p) => hostName(p.host.key)).join(", ") })}
      </p>
    {/if}
    {#if badRows}
      <p class="flex items-center gap-1 text-meta text-muted">
        <Icon name="info" size={12} />{t("util.netcheck.rowsSkipped", { n: badRows })}
      </p>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      {#if running}
        <button
          type="button"
          data-testid="netcheck-stop"
          class="flex items-center gap-1.5 rounded bg-danger/15 px-3 py-1.5 text-sm text-danger hover:bg-danger/25"
          onclick={() => stopRun(homeKey)}
        >
          <Icon name="stop" size={14} />{t("util.netcheck.stop")}
        </button>
        <span class="flex items-center gap-1 text-meta text-muted" data-testid="netcheck-running">
          <Icon name="refresh" size={12} class="animate-spin" />
          {t("util.netcheck.elapsed", { n: Math.round((now - started) / 1000), max: longest })}
        </span>
      {:else}
        <button
          type="button"
          data-testid="netcheck-run"
          class="flex items-center gap-1.5 rounded bg-accent/20 px-3 py-1.5 text-sm text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canRun}
          onclick={requestRun}
        >
          <Icon name="play" size={14} />
          {plan && plan.ready.length > 0
            ? t("util.netcheck.runPlan", { checks: totalChecks, hosts: plan.ready.length })
            : t("util.netcheck.run")}
        </button>
      {/if}
      <label class="flex items-center gap-1">
        {t("util.netcheck.timeout")}
        <input
          type="number"
          min="1"
          max="30"
          class="w-14 rounded border border-edge bg-panel px-1.5 py-1 font-mono text-text outline-none focus:border-accent"
          disabled={running}
          bind:value={timeoutSecs}
        />
        {t("util.netcheck.sec")}
      </label>
    </div>

    {#if run}
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2 text-meta" data-testid="netcheck-run-head">
          <span class="text-muted">{t("util.netcheck.ranAt", { at: run.at, n: run.timeout })}</span>
        </div>
        <NetCheckMatrix {run} {hostName} />
        {#if !running}
          <div class="flex flex-wrap items-center gap-2">
            {#if reportText}
              <CopyButton text={reportText} label={t("util.netcheck.copyReport")} testid="netcheck-copy" />
              <CopyButton text={reportMarkdown} label={t("util.netcheck.copyMarkdown")} testid="netcheck-copy-md" />
            {/if}
            {#if retryCount > 0}
              <button
                type="button"
                data-testid="netcheck-retry"
                class="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-muted hover:bg-edge hover:text-text"
                onclick={() => void retryRun(homeKey)}
              >
                <Icon name="refresh" size={12} />{t("util.netcheck.retry", { n: retryCount })}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<ConfirmDialog
  open={confirming}
  danger={subnetPlans.some((p) => p.host.isProd)}
  title={t("util.netcheck.confirmSubnetTitle")}
  confirmLabel={t("util.netcheck.run")}
  onconfirm={() => void go()}
  oncancel={() => (confirming = false)}
>
  <p>{t("util.netcheck.confirmSubnetBody")}</p>
  <ul class="mt-2 space-y-0.5" data-testid="netcheck-confirm-hosts">
    {#each subnetPlans as p (p.host.key)}
      <li class="font-mono text-text">{t("util.netcheck.confirmSubnetHost", { host: hostName(p.host.key), n: p.checks })}</li>
    {/each}
  </ul>
  {#each subnetPlans.filter((p) => p.host.isProd) as p (p.host.key)}
    <p class="mt-2 text-bad" data-testid="netcheck-confirm-prod">{t("util.netcheck.confirmProd", { host: hostName(p.host.key) })}</p>
  {/each}
</ConfirmDialog>
