// The status bar as data (v1.34): which groups it shows and in what order, which
// give way first when the bar is short, which section of the monitoring page
// each one opens, what its tile draws, and what its problems say. Pure —
// StatusBar.svelte measures and draws; the decisions are here and tested.
//
// Why an order and a priority. The bar used to put who-and-where first (OS,
// host, IP, kernel, time) and the resources after, in a row that scrolled
// sideways without a scrollbar: with a few groups on, CPU and memory slid past
// the edge and nobody could see them. Now the host comes first, the resources
// right after, and when the row is short the least needed group leaves for
// «⋯» — measured in pixels, as the top bar does — instead of going out of view.

import type { Metrics } from "../api";
import type { MessageKey } from "../i18n/messages";
import type { StatusBarItems, StatusBarThresholds } from "../settings/settings.svelte";
import { problems, type Problem, type SectionId } from "./monproblems";
import { worstLevel } from "./monhealth";
import { SERIES } from "./monpalette";
import type { ThresholdLevel } from "./thresholds";

/** A group of the bar — one per setting in `statusBarItems`. */
export type BarGroup = keyof StatusBarItems;

/** The order on the bar: the host, the resources, then the rest. */
export const BAR_ORDER: readonly BarGroup[] = [
  "os",
  "host",
  "cpu",
  "ram",
  "disk",
  "net",
  "load",
  "cpuTemp",
  "swap",
  "diskio",
  "topProc",
  "netConns",
  "users",
  "uptime",
  "ip",
  "kernel",
  "serverTime",
];

/**
 * Who gives way first when the bar is short: the higher, the sooner. CPU,
 * memory and disk (1) always stay; the network (1.5) is the last to go.
 */
export const BAR_PRIORITY: Readonly<Record<BarGroup, number>> = {
  cpu: 1,
  ram: 1,
  disk: 1,
  net: 1.5,
  load: 2,
  host: 2.5,
  os: 3,
  cpuTemp: 4,
  swap: 4,
  diskio: 4,
  topProc: 5,
  netConns: 5,
  users: 6,
  uptime: 6,
  ip: 7,
  kernel: 8,
  serverTime: 8,
};

/** Groups that never leave the bar. */
export const BAR_CORE_PRIORITY = 1;

/** The section of the monitoring page a click on a group opens. */
export const BAR_SECTION: Readonly<Record<BarGroup, SectionId>> = {
  os: "system",
  host: "system",
  cpu: "cpu",
  load: "cpu",
  cpuTemp: "temperature",
  topProc: "processes",
  ram: "memory",
  swap: "memory",
  disk: "disks",
  diskio: "disks",
  net: "network",
  netConns: "network",
  ip: "network",
  users: "system",
  uptime: "system",
  kernel: "system",
  serverTime: "system",
};

/** Users logged in, from the probe's space-separated list. */
export const usersOf = (m: Metrics): string[] => (m.users ?? "").split(/\s+/).filter(Boolean);

/**
 * The groups to draw, in bar order: the user's choice AND what the host
 * reports — a metric the host does not expose hides rather than showing a dash
 * forever. CPU, memory, swap and disk are always reported (swap is 0 when off),
 * so their setting alone decides.
 */
export function shownGroups(m: Metrics, items: StatusBarItems): BarGroup[] {
  const has: Record<BarGroup, boolean> = {
    os: true,
    host: !!(m.user || m.hostname),
    ip: !!m.ip,
    uptime: m.uptimeSecs != null,
    kernel: !!m.kernel,
    serverTime: !!m.serverTime,
    cpu: true,
    load: m.load1 != null,
    cpuTemp: m.cpuTemp != null,
    topProc: !!m.topProc,
    ram: true,
    swap: true,
    disk: true,
    diskio: m.diskReadRate != null || m.diskWriteRate != null,
    net: m.netRxRate != null || m.netTxRate != null,
    netConns: m.netConns != null,
    users: usersOf(m).length > 0,
  };
  return BAR_ORDER.filter((g) => items[g] && has[g]);
}

/** Pixels the fitting may be off by before a group leaves: a digit's width of slack. */
const FIT_SLACK = 2;

/**
 * Which groups leave for «⋯» so the rest fit in `room` px. `groups` are in bar
 * order with their measured widths; each is drawn with a separator before it
 * (`sep` px), and «⋯» takes `more` px plus a separator once anything is hidden.
 * The highest priority goes first, the later of two equals before the earlier;
 * the core never goes — what still does not fit is clipped.
 */
export function fitBar(
  groups: readonly { id: BarGroup; w: number }[],
  room: number,
  sep: number,
  more: number,
): Set<BarGroup> {
  const hidden = new Set<BarGroup>();
  if (!(room > 0)) return hidden;
  const used = () =>
    groups.reduce((s, g) => (hidden.has(g.id) ? s : s + g.w + sep), 0) + (hidden.size ? more + sep : 0);
  const order = groups
    .map((g, i) => ({ id: g.id, i }))
    .filter((g) => BAR_PRIORITY[g.id] > BAR_CORE_PRIORITY)
    .sort((a, b) => BAR_PRIORITY[b.id] - BAR_PRIORITY[a.id] || b.i - a.i);
  for (const g of order) {
    if (used() <= room + FIT_SLACK) break;
    hidden.add(g.id);
  }
  return hidden;
}

/**
 * The problems the bar can see: the monitoring page's own rules
 * (`monproblems.ts`) over the basic probe — the detail the page reads (units,
 * partitions, sensors) is not polled here, so the page may name more.
 */
export function barProblems(m: Metrics | null, th: StatusBarThresholds): Problem[] {
  return problems({ metrics: m, detail: null, extras: null, pending: null, th, baseline: null });
}

/** How the host is, from its problems: the dot before the host's name. */
export const barVerdict = (ps: readonly Problem[]): ThresholdLevel => worstLevel(ps.map((p) => p.level));

/**
 * What the problems chip says: the one problem itself, or how many of each kind.
 * `null` — no chip.
 */
export function chipText(
  ps: readonly Problem[],
): { kind: "one"; problem: Problem } | { kind: "count"; crit: number; warn: number } | null {
  if (ps.length === 0) return null;
  if (ps.length === 1) return { kind: "one", problem: ps[0] };
  const crit = ps.filter((p) => p.level === "crit").length;
  return { kind: "count", crit, warn: ps.length - crit };
}

/** Below this width (rem) the chip and the transfer say only a number. */
export const BAR_ROOMY_REM = 56;

/** What a group's tile draws: its label, the history series and how. */
export interface BarTile {
  label: MessageKey;
  params?: Record<string, string>;
  lines: { key: string; color: string }[];
  /** A known ceiling (percentages); none — a round one of the window. */
  max?: number;
  /** The first series up from the middle, the second down (receive / send). */
  mirror?: boolean;
  /** The lowest automatic ceiling. */
  floor?: number;
}

/** The tile over a group, for the groups that have a history. */
export const BAR_TILES: Readonly<Partial<Record<BarGroup, BarTile>>> = {
  cpu: { label: "mon.cpu", lines: [{ key: "cpu", color: SERIES.cpu }], max: 100 },
  ram: { label: "mon.memory", lines: [{ key: "ram", color: SERIES.ram }], max: 100 },
  swap: { label: "mon.swap", lines: [{ key: "swap", color: SERIES.swap }], max: 100 },
  disk: { label: "mon.diskOf", params: { mount: "/" }, lines: [{ key: "disk", color: SERIES.read }], max: 100 },
  load: { label: "mon.loadHistory", lines: [{ key: "load1", color: SERIES.load }], floor: 1 },
  cpuTemp: { label: "mon.temperature", lines: [{ key: "cpuTemp", color: SERIES.temp }], floor: 10 },
  net: {
    label: "mon.network",
    lines: [
      { key: "netRx", color: SERIES.rx },
      { key: "netTx", color: SERIES.tx },
    ],
    mirror: true,
    floor: 1024,
  },
  diskio: {
    label: "mon.io",
    lines: [
      { key: "diskR", color: SERIES.read },
      { key: "diskW", color: SERIES.write },
    ],
    mirror: true,
    floor: 1024,
  },
};

/** Where a tile `w` px wide stands over a group starting at `left` in a bar `width` px wide. */
export function tileLeft(left: number, w: number, width: number): number {
  return Math.max(0, Math.min(left, width - w));
}
