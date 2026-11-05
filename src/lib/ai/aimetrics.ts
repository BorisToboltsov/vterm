// A plain-text snapshot of host metrics for the AI assistant (Phase 41).
//
// The monitoring overlay already polls everything here; this only reshapes it
// into something a model can read. Pure and DOM-free so it is unit-tested, and so
// the "ask about this host" button stays a thin call site.
//
// Fields the host could not report arrive as `null` (see the metrics contract in
// INVARIANTS) and are **omitted** rather than written as zero — the same rule the
// UI follows. A model told "swap: 0" would reason about a host with no swap
// pressure; a model not told about swap at all will ask.

import type { Extras, Metrics, MetricsDetail } from "../api/session";
import { resolve } from "../i18n/translate";
import type { Problem, SectionId } from "../monitoring/monproblems";
import type { AskFocus } from "../monitoring/monsections";

function pct(used: number | null, total: number | null): string | null {
  if (used === null || total === null || total <= 0) return null;
  return `${Math.round((used / total) * 100)}%`;
}

function gib(n: number | null): string | null {
  return n === null ? null : `${(n / 1024 ** 3).toFixed(1)} GiB`;
}

function pair(used: number | null, total: number | null): string | null {
  const u = gib(used);
  const t = gib(total);
  const p = pct(used, total);
  return u && t ? `${u} / ${t}${p ? ` (${p})` : ""}` : null;
}

function line(label: string, value: string | null | undefined): string | null {
  const v = (value ?? "").toString().trim();
  return v ? `${label}: ${v}` : null;
}

/**
 * Render metrics (and the richer detail, when loaded) as a labelled text block.
 *
 * Deliberately not JSON: this rides in the consent preview, where a human has to
 * read it and decide, and the same text is what the model sees.
 */
export function metricsSnapshot(
  m: Metrics,
  d?: MetricsDetail | null,
  more: { extras?: Extras | null; problems?: readonly Problem[]; focus?: AskFocus | null } = {},
): string {
  const rows: (string | null)[] = [
    ...focusRows(more.focus ?? null),
    line("Host", m.hostname),
    line("OS", m.prettyName || m.os),
    line("Kernel", m.kernel),
    line("Uptime", m.uptimeSecs === null ? null : `${Math.floor(m.uptimeSecs / 3600)} h`),
    line(
      "Load average",
      m.load1 === null ? null : [m.load1, m.load5, m.load15].map((x) => x ?? "?").join(" "),
    ),
    line("CPU", m.cpuPct === null ? null : `${Math.round(m.cpuPct)}%`),
    line("CPU temperature", m.cpuTemp === null ? null : `${Math.round(m.cpuTemp)} °C`),
    line("Memory", pair(m.memUsed, m.memTotal)),
    line("Swap", pair(m.swapUsed, m.swapTotal)),
    line("Root filesystem", pair(m.diskUsed, m.diskTotal)),
    line("Top process", m.topProc),
    line("TCP connections", m.netConns === null ? null : String(m.netConns)),
    line("Logged in", m.users),
  ];

  if (d) {
    if (d.psiCpu) rows.push(line("PSI cpu (10s/60s/300s)", psi(d.psiCpu)));
    if (d.psiMem) rows.push(line("PSI memory (10s/60s/300s)", psi(d.psiMem)));
    if (d.psiIo) rows.push(line("PSI io (10s/60s/300s)", psi(d.psiIo)));

    // Only filesystems worth worrying about — a dozen loop mounts at 0% would
    // bury the one that is full.
    const tight = (d.partitions ?? []).filter((p) => p.total > 0 && p.used / p.total >= 0.8);
    for (const p of tight) {
      rows.push(line(`Filesystem ${p.mount}`, pair(p.used, p.total)));
    }

    const procs = (d.topProcs ?? []).slice(0, 5).map((p) => `${p.comm} ${Math.round(p.cpu)}%`);
    if (procs.length) rows.push(line("Top CPU processes", procs.join(", ")));

    if (d.failedUnitNames?.length) rows.push(line("Failed systemd units", d.failedUnitNames.join(", ")));
    if (d.swapInRate != null || d.swapOutRate != null) {
      rows.push(line("Swap traffic (in/out, bytes/s)", `${d.swapInRate ?? "?"} / ${d.swapOutRate ?? "?"}`));
    }
  }

  const x = more.extras;
  if (x?.oomKills != null) {
    const victims = [...new Set(x.oomVictims.map((v) => v.name).filter(Boolean))];
    rows.push(line("OOM kills this boot", `${x.oomKills}${victims.length ? ` (${victims.join(", ")})` : ""}`));
  }

  const ps = more.problems ?? [];
  if (ps.length) {
    rows.push("Needs attention:");
    for (const p of ps) rows.push(`- [${p.level}] ${problemText(p)}`);
  }

  return rows.filter((r): r is string => r !== null).join("\n");
}

/** A problem as the model reads it: English, whatever the interface language. */
export function problemText(p: Problem): string {
  return `${resolve("en", p.key, p.params)}${p.note ? ` (${p.note})` : ""}`;
}

const SECTION_EN: Record<SectionId, string> = {
  overview: "the overall state of this host",
  cpu: "CPU",
  memory: "memory",
  disks: "disks and filesystems",
  network: "network",
  temperature: "temperatures",
  processes: "processes",
  containers: "Docker containers",
  gpu: "GPUs",
  system: "the system: failed units, updates, logins",
};

/** What the question is about, first in the snapshot. */
function focusRows(f: AskFocus | null): (string | null)[] {
  if (!f) return [];
  if (f.kind === "section") return [line("Question about", SECTION_EN[f.section])];
  if (f.kind === "problem") return [line("Question about", problemText(f.problem))];
  const p = f.detail;
  return [
    line("Question about", `process ${f.comm} (pid ${f.pid})`),
    line("Process command line", p?.cmdline),
    line("Process state", p?.state),
    line("Process age", p?.elapsedSecs == null ? null : `${Math.floor(p.elapsedSecs / 60)} min`),
    line("Process threads", p?.threads == null ? null : String(p.threads)),
    line("Process resident memory", gib(p?.rss ?? null)),
  ];
}

function psi(p: { avg10: number; avg60: number; avg300: number }): string {
  return `${p.avg10.toFixed(1)} / ${p.avg60.toFixed(1)} / ${p.avg300.toFixed(1)}`;
}
