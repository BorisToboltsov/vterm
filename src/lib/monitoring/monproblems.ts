// What needs attention on a host (v1.33): the "Needs attention" list of the
// monitoring overview, and the level of every section in the navigation. Pure.
//
// One list, one rule per problem. A section's dot is the worst problem filed
// under it, so the dot and the list can never disagree; the overview's verdict
// is the worst of all. Numeric rules read the user's thresholds
// (`settings.statusBarThresholds`) through `thresholdLevel`, as the status bar
// does; facts with no threshold (a failed unit, an OOM kill, a SMART verdict)
// have a fixed level. Counters that only grow since boot (interface errors,
// throttling) are a problem only when they grew while the page was open — a
// drop counted months ago is history, not a problem now.

import type { Extras, Metrics, MetricsDetail, PendingUpdates } from "../api";
import type { MessageKey } from "../i18n/messages";
import type { StatusBarThresholds } from "../settings/settings.svelte";
import { fmtBytes, isUnlimitedLimit, memPct } from "./format";
import { loadCoreLevel, sensorLevel, worstLevel } from "./monhealth";
import { thresholdLevel, type ThresholdLevel } from "./thresholds";

/** The sections of the monitoring page, in navigation order. */
export const SECTIONS = [
  "overview",
  "cpu",
  "memory",
  "disks",
  "network",
  "temperature",
  "processes",
  "containers",
  "gpu",
  "system",
] as const;
export type SectionId = (typeof SECTIONS)[number];

export interface Problem {
  /** Stable per problem (a partition, an interface): keys the row. */
  id: string;
  level: "warn" | "crit";
  section: SectionId;
  key: MessageKey;
  params: Record<string, string | number>;
  /** Names from the host under the title (failed units, OOM victims) — data, not UI text. */
  note?: string;
}

/** Counters read at the first poll after the page opened, to tell new events from old. */
export interface Baseline {
  /** Errors + drops per interface. */
  ifaceBad: Readonly<Record<string, number>>;
  throttle: number | null;
}

export interface ProblemInput {
  metrics: Metrics | null;
  detail: MetricsDetail | null;
  extras: Extras | null;
  pending: PendingUpdates | null;
  th: StatusBarThresholds;
  baseline: Baseline | null;
}

/** The baseline of `d`'s growing counters. */
export function baselineOf(d: MetricsDetail): Baseline {
  const ifaceBad: Record<string, number> = {};
  for (const n of d.netIfaces) ifaceBad[n.name] = n.rxErrs + n.rxDrop + n.txErrs + n.txDrop;
  return { ifaceBad, throttle: d.throttleCount };
}

const RANK = { crit: 0, warn: 1 } as const;
const ORDER = new Map<SectionId, number>(SECTIONS.map((s, i) => [s, i]));
const round = (v: number) => Math.round(v);

/** Everything that needs attention, the critical first, then in section order. */
export function problems(i: ProblemInput): Problem[] {
  const { metrics: m, detail: d, extras: x, pending: u, th, baseline } = i;
  const out: Problem[] = [];
  const add = (
    level: ThresholdLevel,
    id: string,
    section: SectionId,
    key: MessageKey,
    params: Record<string, string | number> = {},
    note?: string,
  ) => {
    if (level !== "ok") out.push({ id, level, section, key, params, ...(note ? { note } : {}) });
  };

  // CPU
  if (m?.cpuPct != null) add(thresholdLevel(m.cpuPct, th.cpu), "cpu", "cpu", "mon.p.cpu", { pct: round(m.cpuPct) });
  const threads = d?.perCpu.length || m?.cpuCount || 0;
  if (m?.load1 != null && threads > 0) {
    const perCore = m.load1 / threads;
    const level = worstLevel([thresholdLevel(m.load1, th.load), loadCoreLevel(perCore)]);
    add(level, "load", "cpu", "mon.p.load", { load: m.load1.toFixed(2), n: threads });
  }
  if (d?.throttleCount != null && baseline?.throttle != null && d.throttleCount > baseline.throttle) {
    add("warn", "throttle", "cpu", "mon.p.throttle", { n: d.throttleCount - baseline.throttle });
  }

  // Memory
  const ram = memPct(m?.memUsed ?? null, m?.memTotal ?? null);
  if (ram != null) add(thresholdLevel(ram, th.ram), "ram", "memory", "mon.p.ram", { pct: ram });
  const swap = m?.swapTotal ? memPct(m.swapUsed, m.swapTotal) : null;
  if (swap != null) add(thresholdLevel(swap, th.swap), "swap", "memory", "mon.p.swap", { pct: swap });
  if ((x?.oomKills ?? 0) > 0) {
    const names = [...new Set(x!.oomVictims.map((v) => v.name).filter(Boolean))];
    add("crit", "oom", "memory", "mon.p.oom", { n: x!.oomKills! }, names.slice(-3).join(", "));
  }

  // Disks
  for (const p of d?.partitions ?? []) {
    if (p.total > 0) {
      const used = (p.used / p.total) * 100;
      add(thresholdLevel(used, th.disk), `disk:${p.mount}`, "disks", "mon.p.disk", {
        mount: p.mount,
        pct: round(used),
        used: fmtBytes(p.used),
        total: fmtBytes(p.total),
      });
    }
    if (p.inodesUsed != null && p.inodesTotal) {
      const used = (p.inodesUsed / p.inodesTotal) * 100;
      add(thresholdLevel(used, th.inodes), `inodes:${p.mount}`, "disks", "mon.p.inodes", {
        mount: p.mount,
        pct: round(used),
      });
    }
  }
  if (d?.fileNrUsed != null && d.fileNrMax && !isUnlimitedLimit(d.fileNrMax)) {
    const used = (d.fileNrUsed / d.fileNrMax) * 100;
    add(thresholdLevel(used, th.fd), "fd", "disks", "mon.p.fd", { pct: round(used) });
  }
  for (const s of x?.smart ?? []) {
    if (s.health && s.health !== "PASSED") {
      add("crit", `smart:${s.device}`, "disks", "mon.p.smart", { dev: s.device, health: s.health });
    }
  }

  // Network: errors and drops that grew while the page was open.
  for (const n of d?.netIfaces ?? []) {
    const now = n.rxErrs + n.rxDrop + n.txErrs + n.txDrop;
    const was = baseline?.ifaceBad[n.name];
    if (was != null && now > was) add("warn", `net:${n.name}`, "network", "mon.p.netBad", { iface: n.name, n: now - was });
  }

  // Temperature: the hottest offender, by its own limits first.
  const sensors = d?.sensors ?? [];
  if (sensors.length > 0) {
    const worst = sensors
      .map((s) => ({ s, level: sensorLevel(s, th.cpuTemp) }))
      .filter((v) => v.level !== "ok")
      .sort((a, b) => (a.level === b.level ? b.s.temp - a.s.temp : a.level === "crit" ? -1 : 1))[0];
    if (worst) add(worst.level, "temp", "temperature", "mon.p.temp", { label: worst.s.label, temp: round(worst.s.temp) });
  } else if (m?.cpuTemp != null) {
    add(thresholdLevel(m.cpuTemp, th.cpuTemp), "temp", "temperature", "mon.p.temp", { label: "CPU", temp: round(m.cpuTemp) });
  }

  // System
  if ((d?.failedUnits ?? 0) > 0) {
    add("crit", "failed", "system", "mon.p.failed", { n: d!.failedUnits! }, d!.failedUnitNames.slice(0, 3).join(", "));
  }
  if (d?.timeSynced === false) add("warn", "timesync", "system", "mon.p.timeSync");
  if ((u?.security ?? 0) > 0) add("warn", "security", "system", "mon.p.security", { n: u!.security! });
  if (u?.rebootRequired) add("warn", "reboot", "system", "mon.p.reboot");

  return out.sort(
    (a, b) => RANK[a.level] - RANK[b.level] || ORDER.get(a.section)! - ORDER.get(b.section)!,
  );
}

/** Each section's level — the worst problem filed under it; the overview's is the worst of all. */
export function sectionLevels(ps: readonly Problem[]): Record<SectionId, ThresholdLevel> {
  const out = Object.fromEntries(SECTIONS.map((s) => [s, "ok"])) as Record<SectionId, ThresholdLevel>;
  for (const p of ps) {
    out[p.section] = worstLevel([out[p.section], p.level]);
    out.overview = worstLevel([out.overview, p.level]);
  }
  return out;
}
