import { describe, it, expect } from "vitest";
import { metricsSnapshot, problemText } from "./aimetrics";
import type { Extras, Metrics, MetricsDetail } from "../api/session";
import type { Problem } from "../monitoring/monproblems";

const GIB = 1024 ** 3;

function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    os: "Linux",
    prettyName: "Debian GNU/Linux 12",
    hostname: "web1",
    user: "root",
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    cpuPct: 42.4,
    memUsed: 4 * GIB,
    memTotal: 8 * GIB,
    diskUsed: 45 * GIB,
    diskTotal: 50 * GIB,
    netRxRate: null,
    netTxRate: null,
    diskReadRate: null,
    diskWriteRate: null,
    uptimeSecs: 7200,
    swapUsed: null,
    swapTotal: null,
    users: "root",
    ip: "10.0.0.5",
    topProc: "node 87%",
    cpuTemp: null,
    netConns: 120,
    kernel: "6.1.0",
    serverTime: "14:05 UTC",
    cpuCount: 4,
    ...over,
  };
}

describe("metricsSnapshot", () => {
  it("renders the headline figures a model needs", () => {
    const s = metricsSnapshot(metrics());
    expect(s).toContain("Host: web1");
    expect(s).toContain("OS: Debian GNU/Linux 12");
    expect(s).toContain("Load average: 0.5 0.4 0.3");
    expect(s).toContain("CPU: 42%");
    expect(s).toContain("Memory: 4.0 GiB / 8.0 GiB (50%)");
    expect(s).toContain("Root filesystem: 45.0 GiB / 50.0 GiB (90%)");
    expect(s).toContain("Top process: node 87%");
  });

  it("omits what the host could not report instead of writing zero", () => {
    // "Swap: 0" would tell the model there is no swap pressure; saying nothing
    // lets it ask. Same rule the UI follows for unavailable metrics.
    const s = metricsSnapshot(metrics({ swapUsed: null, swapTotal: null, cpuTemp: null }));
    expect(s).not.toMatch(/^Swap:/m);
    expect(s).not.toMatch(/CPU temperature/);
  });

  it("omits load average entirely when the host has no such concept", () => {
    const s = metricsSnapshot(metrics({ load1: null, load5: null, load15: null }));
    expect(s).not.toMatch(/Load average/);
  });

  it("adds PSI and busy filesystems from the detail probe", () => {
    const detail = {
      psiCpu: { avg10: 1.5, avg60: 2.25, avg300: 3 },
      psiMem: null,
      psiIo: null,
      partitions: [
        { mount: "/", fstype: "ext4", used: 9 * GIB, total: 10 * GIB, inodesUsed: null, inodesTotal: null },
        { mount: "/boot", fstype: "ext4", used: 1 * GIB, total: 10 * GIB, inodesUsed: null, inodesTotal: null },
      ],
      topProcs: [
        { pid: 1, user: "root", cpu: 87.2, mem: 3, comm: "node" },
        { pid: 2, user: "root", cpu: 12, mem: 1, comm: "postgres" },
      ],
    } as unknown as MetricsDetail;

    const s = metricsSnapshot(metrics(), detail);
    expect(s).toContain("PSI cpu (10s/60s/300s): 1.5 / 2.3 / 3.0");
    // Only the filesystem actually under pressure — a dozen idle mounts would
    // bury the one that matters.
    expect(s).toContain("Filesystem /:");
    expect(s).not.toContain("Filesystem /boot");
    expect(s).toContain("Top CPU processes: node 87%, postgres 12%");
  });

  it("works with no detail loaded yet", () => {
    expect(metricsSnapshot(metrics(), null)).toContain("Host: web1");
    expect(metricsSnapshot(metrics(), undefined)).toContain("Host: web1");
  });

  it("skips blank string fields", () => {
    const s = metricsSnapshot(metrics({ topProc: "", users: "   ", kernel: "" }));
    expect(s).not.toMatch(/Top process/);
    expect(s).not.toMatch(/Logged in/);
    expect(s).not.toMatch(/Kernel/);
  });

  it("leads with what the question is about and lists the problems in English", () => {
    const disk: Problem = {
      id: "disk:/",
      level: "warn",
      section: "disks",
      key: "mon.p.disk",
      params: { mount: "/", pct: 87, used: "418 GiB", total: "480 GiB" },
    };
    const failed: Problem = { id: "failed", level: "crit", section: "system", key: "mon.p.failed", params: { n: 1 }, note: "nginx.service" };
    const s = metricsSnapshot(metrics(), null, { problems: [failed, disk], focus: { kind: "problem", problem: disk } });
    expect(s.split("\n")[0]).toBe("Question about: / is 87% full (418 GiB of 480 GiB)");
    expect(s).toContain("Needs attention:\n- [crit] Failed systemd units: 1 (nginx.service)\n- [warn] / is 87% full");
    expect(problemText(failed)).toBe("Failed systemd units: 1 (nginx.service)");
  });

  it("carries a process's details when the question is about it", () => {
    const s = metricsSnapshot(metrics(), null, {
      focus: {
        kind: "process",
        pid: 7,
        comm: "pg",
        detail: { pid: 7, user: "pg", state: "disk", elapsedSecs: 600, threads: 3, rss: 2 * GIB, cmdline: "postgres -D /data", fds: null },
      },
    });
    expect(s).toContain("Question about: process pg (pid 7)");
    expect(s).toContain("Process command line: postgres -D /data");
    expect(s).toContain("Process age: 10 min");
    expect(s).toContain("Process resident memory: 2.0 GiB");
  });

  it("reports OOM kills only when the kernel log was read", () => {
    const x = (o: Partial<Extras>) => ({ oomKills: null, oomVictims: [], ...o }) as Extras;
    expect(metricsSnapshot(metrics(), null, { extras: x({}) })).not.toContain("OOM");
    expect(metricsSnapshot(metrics(), null, { extras: x({ oomKills: 2, oomVictims: [{ pid: 1, name: "java", at: null, bootSecs: 5 }] }) })).toContain(
      "OOM kills this boot: 2 (java)",
    );
  });
});
