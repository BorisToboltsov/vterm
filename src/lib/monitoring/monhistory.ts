// What the monitoring page remembers between polls (v1.33). Pure: the overlay
// owns one History, appends every poll's readings, and each section draws from
// it. Everything here is built from probes that already run — per thread, per
// interface, per device, per sensor, per process — so a chart per item costs no
// extra request to the host.
//
// A series that got no reading this poll gets a gap, never a repeated or zero
// value: a process that dropped out of the top six was not measured, and the
// chart says so by breaking the line.

import type { Extras, LiveExtras, Metrics, MetricsDetail } from "../api";
import { HISTORY, type Sample } from "./chartgeom";
import { memPct } from "./format";
import { historyPids } from "./proclist";

export type History = Readonly<Record<string, readonly Sample[]>>;

/**
 * `h` with one poll's `readings` appended at sample number `seq`. Every series
 * keeps `keep` samples — one more than the window, so the point sliding out at
 * the left still draws. A series with no reading this poll gets a gap; one with
 * no known value left is dropped.
 */
export function pushReadings(
  h: History,
  seq: number,
  readings: Readonly<Record<string, number | null>>,
  keep = HISTORY + 1,
): History {
  const out: Record<string, Sample[]> = {};
  const keys = new Set([...Object.keys(h), ...Object.keys(readings)]);
  for (const k of keys) {
    const v = readings[k];
    const next = [...(h[k] ?? []), { s: seq, v: v == null || !Number.isFinite(v) ? null : v }];
    const kept = next.slice(-keep);
    if (kept.some((x) => x.v != null)) out[k] = kept;
  }
  return out;
}

/** The series `key`, or an empty one. */
export function series(h: History, key: string): readonly Sample[] {
  return h[key] ?? [];
}

/** The newest known value of `key`, or null. */
export function latest(h: History, key: string): number | null {
  const s = h[key];
  for (let i = (s?.length ?? 0) - 1; i >= 0; i--) {
    const v = s![i].v;
    if (v != null) return v;
  }
  return null;
}

/** The highest known value of `key` in the window and its sample number, or null. */
export function peak(h: History, key: string): { v: number; s: number } | null {
  let best: { v: number; s: number } | null = null;
  for (const x of h[key] ?? []) {
    if (x.v != null && (!best || x.v > best.v)) best = { v: x.v, s: x.s };
  }
  return best;
}

/** Keys of `h` starting with `prefix` (a family of series: `core.`, `if.`, …). */
export function keysOf(h: History, prefix: string): string[] {
  return Object.keys(h).filter((k) => k.startsWith(prefix));
}

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : null);

/**
 * One poll's readings, by series key. Keys: `cpu`, `ram`, `swap`, `load1|5|15`,
 * `netRx|Tx`, `diskR|W`, `psiCpu|Mem|Io`, `brk.<part>`, `mem.used|cache|free`,
 * `swapIn|Out`, `core.<n>`, `if.<name>.rx|tx|bad`, `dev.<name>.r|w|util`,
 * `temp.<label>`, `proc.<pid>.cpu|mem`, `gpu.<n>.util|mem|temp|power`,
 * `ctr.<name>.cpu|mem`.
 */
export function readingsOf(
  m: Metrics | null,
  d: MetricsDetail | null,
  live: Pick<LiveExtras, "gpus" | "docker"> | Pick<Extras, "gpus" | "docker"> | null = null,
): Record<string, number | null> {
  const r: Record<string, number | null> = {};
  if (m) {
    r.cpu = m.cpuPct;
    r.ram = memPct(m.memUsed, m.memTotal);
    r.swap = m.swapTotal ? memPct(m.swapUsed, m.swapTotal) : null;
    r.load1 = m.load1;
    r.load5 = m.load5;
    r.load15 = m.load15;
    r.netRx = m.netRxRate;
    r.netTx = m.netTxRate;
    r.diskR = m.diskReadRate;
    r.diskW = m.diskWriteRate;
    r.cpuTemp = m.cpuTemp;
  }
  if (d) {
    r.psiCpu = d.psiCpu?.avg10 ?? null;
    r.psiMem = d.psiMem?.avg10 ?? null;
    r.psiIo = d.psiIo?.avg10 ?? null;
    const b = d.cpuBreakdown;
    r["brk.user"] = b?.user ?? null;
    r["brk.system"] = b?.system ?? null;
    r["brk.iowait"] = b?.iowait ?? null;
    r["brk.steal"] = b?.steal ?? null;
    if (d.memTotal != null && d.memFree != null && m?.memUsed != null) {
      const cache = (d.memCached ?? 0) + (d.memBuffers ?? 0);
      r["mem.used"] = m.memUsed;
      r["mem.cache"] = cache;
      r["mem.free"] = d.memFree;
    }
    r.swapIn = d.swapInRate;
    r.swapOut = d.swapOutRate;
    d.perCpu.forEach((v, i) => (r[`core.${i}`] = v));
    for (const n of d.netIfaces) {
      r[`if.${n.name}.rx`] = n.rxRate;
      r[`if.${n.name}.tx`] = n.txRate;
      r[`if.${n.name}.bad`] = n.rxErrs + n.rxDrop + n.txErrs + n.txDrop;
    }
    for (const dv of d.diskDevs) {
      r[`dev.${dv.name}.r`] = dv.readRate;
      r[`dev.${dv.name}.w`] = dv.writeRate;
      r[`dev.${dv.name}.util`] = dv.utilPct;
    }
    for (const s of d.sensors) r[`temp.${s.label}`] = s.temp;
    for (const p of [...d.topProcs, ...d.topMemProcs]) {
      r[`proc.${p.pid}.cpu`] = p.cpu;
      r[`proc.${p.pid}.mem`] = p.mem;
    }
    // The full list (Processes on screen): a line each for the busiest by CPU and
    // by memory — thousands of series a poll would be all copying.
    const keep = historyPids(d.processes ?? []);
    for (const p of d.processes ?? []) {
      if (!keep.has(p.pid)) continue;
      r[`proc.${p.pid}.cpu`] = p.cpu;
      r[`proc.${p.pid}.mem`] = p.mem;
    }
    for (const p of d.partitions) r[`fs.${p.mount}`] = pct(p.used, p.total);
  }
  for (const [i, g] of (live?.gpus ?? []).entries()) {
    r[`gpu.${i}.util`] = g.util;
    r[`gpu.${i}.mem`] = g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : null;
    r[`gpu.${i}.temp`] = g.temp;
    r[`gpu.${i}.power`] = g.powerDraw;
  }
  for (const c of live?.docker ?? []) {
    r[`ctr.${c.name}.cpu`] = c.cpu;
    r[`ctr.${c.name}.mem`] = c.memUsed;
  }
  return r;
}
