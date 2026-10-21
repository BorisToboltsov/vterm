<script lang="ts">
  // Utilities → access check, the answer (v1.21, ADR 0032): target:port down,
  // the servers that checked across. A cell is one server's answer; "—" — that
  // server wasn't asked. A subnet is summed per port (who opened, how many of
  // the rest did what) and opens up to every address. The model is
  // `buildMatrix` (netroute.ts); this draws it.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t, type MessageKey } from "./i18n";
  import { isIpv4, type PortStatus } from "./netcheck";
  import { buildMatrix, columnTally, subnetMisses, type MatrixColumn } from "./netroute";
  import { STATUS_KEY, methodLabel } from "./netcheckwords";
  import type { NetRun } from "./stores/netcheck.svelte";

  let { run, hostName }: { run: NetRun; hostName: (key: string) => string } = $props();

  const columns = $derived<MatrixColumn[]>(run.hosts.map((h) => ({ key: h.key, rules: h.rules, report: h.report })));
  const groups = $derived(buildMatrix(columns));
  const single = $derived(run.hosts.length === 1);
  // Subnet ports opened up to every address: `target|port`.
  let expanded = $state<Set<string>>(new Set());

  function toggle(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

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
  const REST: PortStatus[] = ["refused", "timeout", "unreachable", "dns", "error", "missing"];

  const tallyClass = (open: number, checked: number) =>
    open === checked ? "bg-ok/15 text-ok" : open === 0 ? "bg-bad/15 text-bad" : "bg-warn/20 text-warn";
  const restText = (counts: Partial<Record<PortStatus, number>>) =>
    REST.filter((s) => counts[s])
      .map((s) => `${t(STATUS_KEY[s])} ${counts[s]}`)
      .join(", ");
</script>

<div class="overflow-x-auto rounded border border-edge" data-testid="netcheck-results">
  <table class="w-full table-fixed text-xs">
    <colgroup>
      <col class={single ? "w-[38%]" : "w-[34%]"} />
      {#each run.hosts as h (h.key)}<col />{/each}
    </colgroup>
    <thead>
      <tr class="border-b border-edge bg-panel">
        <th class="px-3 py-1.5 text-left text-meta font-normal text-muted">{t("util.netcheck.colTargetPort")}</th>
        {#each run.hosts as h, c (h.key)}
          {@const sum = columnTally(columns[c])}
          <th class="px-2 py-1.5 text-left align-top font-normal" data-testid="netcheck-column">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="truncate text-text">{hostName(h.key)}</span>
              {#if h.state === "running"}
                <Icon name="refresh" size={12} class="animate-spin text-muted" />
              {:else if h.state === "done" && sum.checked > 0}
                <span class="rounded px-1.5 text-meta {tallyClass(sum.open, sum.checked)}" data-testid="netcheck-tally">
                  {t("util.netcheck.tally", { open: sum.open, total: sum.checked })}
                </span>
              {:else if h.state === "stopped"}
                <span class="rounded bg-edge px-1.5 text-meta text-muted" data-testid="netcheck-stopped">{t("util.netcheck.stopped")}</span>
              {/if}
            </div>
            <div class="truncate font-mono text-meta text-muted">
              {[h.report?.hostname !== hostName(h.key) ? h.report?.hostname : "", h.report?.method ? methodLabel(h.report.method) : ""]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {#if h.state === "error"}
              <div class="mt-0.5 whitespace-pre-wrap break-words font-mono text-meta text-bad" data-testid="netcheck-error">{h.error}</div>
            {:else if h.report && !h.report.complete && h.state === "done"}
              <div class="mt-0.5 text-meta text-warn" data-testid="netcheck-incomplete">{t("util.netcheck.incomplete")}</div>
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each groups as g (`${g.target}|${g.proto}`)}
        <tr class="border-b border-edge bg-panel/60" data-testid="netcheck-target">
          <td colspan={run.hosts.length + 1} class="px-3 py-1">
            <span class="font-mono text-text">{g.target}</span>
            {#each g.labels as label (label)}
              <span class="ml-1.5 text-accent" data-testid="netcheck-label">{label}</span>
            {/each}
            {#each [...new Set(g.resolved.filter((r) => r !== null))] as r (r)}
              {#if r === ""}
                <span class="ml-1.5 text-meta text-bad">{t("util.netcheck.noResolve")}</span>
              {:else if !isIpv4(g.target)}
                <span class="ml-1.5 font-mono text-meta text-muted">{r}</span>
              {/if}
            {/each}
            {#if g.isSubnet}
              <span class="ml-1.5 text-meta text-muted">{t("util.netcheck.subnet")}</span>
            {/if}
            <span class="ml-1.5 text-meta text-muted">/{g.proto}</span>
          </td>
        </tr>
        {#each g.rows as row (row.port)}
          {@const key = `${g.target}|${row.port}`}
          <tr class="border-b border-edge/50 last:border-0" data-testid="netcheck-row">
            <td class="px-3 py-1 align-top">
              <span class="font-mono text-text">{row.port}</span>
              {#if row.service}<span class="ml-1.5 text-meta text-muted">{row.service}</span>{/if}
            </td>
            {#each run.hosts as h, c (h.key)}
              <td class="px-2 py-1 align-top">
                {#if h.state === "running" && !h.report}
                  <span class="text-meta text-muted">{t("util.netcheck.checking")}</span>
                {:else if !h.report && (g.isSubnet ? row.subnet?.[c] : row.cells[c])}
                  <!-- Stopped or failed before answering: nothing to count. -->
                  <span class="text-meta text-muted">{h.state === "stopped" ? t("util.netcheck.stopped") : "—"}</span>
                {:else if g.isSubnet}
                  {@const sub = row.subnet?.[c] ?? null}
                  {#if !sub}
                    <span class="text-muted">—</span>
                  {:else}
                    <div class="flex flex-wrap items-center gap-1" data-testid="netcheck-subnet-cell">
                      <span class="rounded px-1.5 py-0.5 text-meta {sub.open.length ? 'bg-ok/15 text-ok' : 'bg-edge text-muted'}">
                        {t("util.netcheck.subnetOpen", { open: sub.open.length, total: sub.total })}
                      </span>
                      {#each sub.open as o (o.host)}
                        <span class="font-mono text-meta text-ok" use:tooltip={o.ms === null ? "" : t("util.netcheck.ms", { n: o.ms })}>{o.host}</span>
                      {/each}
                    </div>
                    {#if restText(sub.counts)}
                      <div class="mt-0.5 text-meta text-muted">{t("util.netcheck.subnetRest", { parts: restText(sub.counts) })}</div>
                    {/if}
                  {/if}
                {:else}
                  {@const cell = row.cells[c]}
                  {#if !cell}
                    <span class="text-muted" use:tooltip={t("util.netcheck.notAsked")}>—</span>
                  {:else}
                    <div class="flex min-w-0 flex-wrap items-center gap-x-1.5">
                      <span
                        class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta {STATUS_CLASS[cell.status]}"
                        data-testid={`netcheck-status-${cell.status}`}
                        use:tooltip={[
                          t(STATUS_HINT[cell.status]),
                          single ? "" : cell.detail,
                          cell.egress && !cell.egress.differs ? `${t("util.netcheck.egress")}: ${cell.egress.src}` : "",
                        ]
                          .filter(Boolean)
                          .join("\n")}
                      >
                        <Icon name={STATUS_ICON[cell.status]} size={11} />{t(STATUS_KEY[cell.status])}
                      </span>
                      {#if cell.ms !== null}<span class="font-mono text-meta">{t("util.netcheck.ms", { n: cell.ms })}</span>{/if}
                      {#if single && cell.detail && cell.status !== "open"}
                        <span class="min-w-0 truncate font-mono text-meta text-muted" title={cell.detail}>{cell.detail}</span>
                      {/if}
                    </div>
                    <!-- Where the packets leave from: said out loud only when a firewall
                         rule for the request's source would miss it; else in the hint. -->
                    {#if cell.egress?.differs}
                      <div
                        class="mt-0.5 flex items-center gap-1 text-meta text-warn"
                        data-testid="netcheck-egress"
                        use:tooltip={t("util.netcheck.egressDiffersShort")}
                      >
                        {t("util.netcheck.egress")}: <span class="font-mono">{cell.egress.src}</span>
                        <Icon name="alert" size={11} />
                      </div>
                    {/if}
                  {/if}
                {/if}
              </td>
            {/each}
          </tr>
          {#if g.isSubnet && row.subnet?.some((s, c) => s && run.hosts[c].report && s.open.length < s.total)}
            <tr class="border-b border-edge/50">
              <td colspan={run.hosts.length + 1} class="px-3 pb-1">
                <button
                  type="button"
                  class="flex items-center gap-1 text-meta text-muted hover:text-text"
                  data-testid="netcheck-subnet-toggle"
                  aria-expanded={expanded.has(key)}
                  onclick={() => toggle(key)}
                >
                  <Icon name={expanded.has(key) ? "chevronDown" : "chevronRight"} size={11} />
                  {expanded.has(key) ? t("util.netcheck.subnetHide") : t("util.netcheck.subnetShow")}
                </button>
                {#if expanded.has(key)}
                  {@const asked = run.hosts.map((h, c) => ({ h, c })).filter(({ h, c }) => h.report && row.subnet?.[c])}
                  <div class="mt-1 grid gap-2" style="grid-template-columns: repeat({asked.length}, minmax(0, 1fr))" data-testid="netcheck-subnet-list">
                    {#each asked as { h, c } (h.key)}
                      <div class="max-h-48 overflow-auto font-mono text-meta">
                        {#if !single}<div class="mb-0.5 font-sans text-muted">{hostName(h.key)}</div>{/if}
                        {#each subnetMisses(columns[c], g.target, row.port) as m (m.host)}
                          <div class="flex gap-2" use:tooltip={m.detail}>
                            <span class="text-text">{m.host}</span>
                            <span class="text-muted">{t(STATUS_KEY[m.status])}</span>
                          </div>
                        {/each}
                      </div>
                    {/each}
                  </div>
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      {/each}
    </tbody>
  </table>
</div>
