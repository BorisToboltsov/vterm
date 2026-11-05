// The navigation of the monitoring page (v1.33): which sections a host has and
// the short value beside each. Pure.
//
// A section for hardware or software the host does not have (no GPU, no
// containers) is not offered at all — an empty page that says "none" is noise.
// Temperature stays even without sensors: there the page says why there is
// nothing to read (a Windows host, lm-sensors missing, a VM), and that is the
// answer someone opening it wants.

import type { Extras, LiveExtras, Metrics, MetricsDetail, Partition, PendingUpdates, ProcessDetail } from "../api";
import type { MessageKey } from "../i18n/messages";
import type { StatusBarThresholds } from "../settings/settings.svelte";
import type { IconName } from "../ui/icons";
import { fmtPct, fmtRate, memPct } from "./format";
import type { History } from "./monhistory";
import { SECTIONS, type Baseline, type Problem, type SectionId } from "./monproblems";
import type { ThresholdLevel } from "./thresholds";

/** Everything a section draws from — the overlay owns it and polls it. */
export interface MonView {
  sessionId: string;
  metrics: Metrics;
  detail: MetricsDetail | null;
  extras: Extras | null;
  live: LiveExtras | null;
  pending: PendingUpdates | null;
  pendingLoading: boolean;
  hist: History;
  /** The newest sample number of `hist`. */
  seq: number;
  /** Seconds between polls. */
  interval: number;
  th: StatusBarThresholds;
  problems: Problem[];
  levels: Record<SectionId, ThresholdLevel>;
  /** Delta readings need two polls; until then they are skeletons. */
  loadingDelta: boolean;
  /** Growing counters as they stood when the page opened. */
  baseline: Baseline | null;
}

/** What a question to the assistant is about. */
export type AskFocus =
  | { kind: "section"; section: SectionId }
  | { kind: "problem"; problem: Problem }
  | { kind: "process"; pid: number; comm: string; detail: ProcessDetail | null };

/** What a section can ask of the page; an absent action is not offered. */
export interface MonActions {
  go: (s: SectionId) => void;
  /** Hand the snapshot to the assistant, with what the question is about. */
  ask?: (focus: AskFocus) => void;
  /** Type a command into the session's terminal (and close the page). */
  run?: (argv: string[]) => void;
  installTool?: (name: string) => void;
  openDocker?: () => void;
}

export interface SectionData {
  metrics: Metrics | null;
  detail: MetricsDetail | null;
  extras: Extras | null;
  live: LiveExtras | null;
}

/** The live list when it has been polled, else the one read at open. */
function gpusOf(x: SectionData) {
  return x.live?.gpus ?? x.extras?.gpus ?? [];
}
function containersOf(x: SectionData) {
  return x.live?.docker ?? x.extras?.docker ?? [];
}

/** The sections this host has, in navigation order. */
export function shownSections(x: SectionData): SectionId[] {
  return SECTIONS.filter((s) => {
    if (s === "containers") return containersOf(x).length > 0;
    if (s === "gpu") return gpusOf(x).length > 0;
    return true;
  });
}

/** The partition closest to full, or null. */
export function fullestPartition(d: MetricsDetail | null): Partition | null {
  let best: Partition | null = null;
  for (const p of d?.partitions ?? []) {
    if (p.total <= 0) continue;
    if (!best || p.used / p.total > best.used / best.total) best = p;
  }
  return best;
}

/** The hottest temperature reading: a sensor, else the CPU's own. */
export function hottest(m: Metrics | null, d: MetricsDetail | null): { label: string; temp: number } | null {
  const sensors = d?.sensors ?? [];
  if (sensors.length > 0) {
    const s = sensors.reduce((a, b) => (b.temp > a.temp ? b : a));
    return { label: s.label, temp: s.temp };
  }
  return m?.cpuTemp != null ? { label: "CPU", temp: m.cpuTemp } : null;
}

/** The short value beside a section in the navigation, or null for none. */
export function navValue(id: SectionId, x: SectionData): string | null {
  const m = x.metrics;
  switch (id) {
    case "cpu":
      return m?.cpuPct != null ? fmtPct(m.cpuPct) : null;
    case "memory": {
      const v = memPct(m?.memUsed ?? null, m?.memTotal ?? null);
      return v != null ? fmtPct(v) : null;
    }
    case "disks": {
      const p = fullestPartition(x.detail);
      return p ? fmtPct((p.used / p.total) * 100) : null;
    }
    case "network":
      return m?.netRxRate != null ? fmtRate(m.netRxRate) : null;
    case "temperature": {
      const h = hottest(m, x.detail);
      return h ? `${Math.round(h.temp)}°` : null;
    }
    case "containers": {
      const n = containersOf(x).length;
      return n > 0 ? String(n) : null;
    }
    case "gpu": {
      const g = gpusOf(x);
      return g.length > 0 ? fmtPct(Math.max(...g.map((v) => v.util))) : null;
    }
    default:
      return null;
  }
}

/** Whether the GPU/containers live poll should run: only while one of them is on screen. */
export function wantsLive(section: SectionId): boolean {
  return section === "containers" || section === "gpu";
}

/** The command that lists a package manager's pending updates, or null for one we do not know. */
export function updatesArgv(manager: string): string[] | null {
  switch (manager.trim().toLowerCase()) {
    case "apt":
      return ["apt", "list", "--upgradable"];
    case "dnf":
      return ["dnf", "check-update"];
    case "yum":
      return ["yum", "check-update"];
    case "zypper":
      return ["zypper", "list-updates"];
    case "pacman":
      return ["pacman", "-Qu"];
    case "apk":
      return ["apk", "version", "-l", "<"];
    default:
      return null;
  }
}

/** The name of each section in the navigation. */
export const SECTION_LABEL: Record<SectionId, MessageKey> = {
  overview: "mon.sec.overview",
  cpu: "mon.sec.cpu",
  memory: "mon.sec.memory",
  disks: "mon.sec.disks",
  network: "mon.sec.network",
  temperature: "mon.sec.temperature",
  processes: "mon.sec.processes",
  containers: "mon.sec.containers",
  gpu: "mon.sec.gpu",
  system: "mon.sec.system",
};

/** The icon of each section. */
export const SECTION_ICON: Record<SectionId, IconName> = {
  overview: "layoutGrid",
  cpu: "cpu",
  memory: "memory",
  disks: "hardDrive",
  network: "network",
  temperature: "thermometer",
  processes: "table",
  containers: "container",
  gpu: "bolt",
  system: "server",
};
