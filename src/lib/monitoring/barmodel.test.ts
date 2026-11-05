import { describe, expect, it } from "vitest";
import type { Metrics } from "../api";
import { resetSettings, settings, type StatusBarItems } from "../settings/settings.svelte";
import {
  BAR_CORE_PRIORITY,
  BAR_ORDER,
  BAR_PRIORITY,
  BAR_SECTION,
  BAR_TILES,
  barProblems,
  barVerdict,
  chipText,
  fitBar,
  shownGroups,
  tileLeft,
  usersOf,
  type BarGroup,
} from "./barmodel";
import { SECTIONS } from "./monproblems";

const m: Metrics = {
  os: "Linux",
  prettyName: "Ubuntu 24.04 LTS",
  hostname: "web01",
  user: "root",
  load1: 0.5,
  load5: 0.4,
  load15: 0.3,
  cpuPct: 42,
  memUsed: 2 * 1024 ** 3,
  memTotal: 8 * 1024 ** 3,
  diskUsed: 5 * 1024 ** 3,
  diskTotal: 100 * 1024 ** 3,
  netTxRate: 1,
  netRxRate: 2,
  diskReadRate: 3,
  diskWriteRate: 4,
  uptimeSecs: 100,
  swapUsed: 0,
  swapTotal: 0,
  users: "root alice",
  ip: "10.0.0.5",
  topProc: "node 87%",
  cpuTemp: 56,
  netConns: 42,
  kernel: "6.1.0",
  serverTime: "14:05 UTC",
  cpuCount: 4,
};

resetSettings();
// The shipping defaults, read once from a fresh settings store.
const DEFAULTS = {
  statusBarItems: { ...settings.statusBarItems },
  statusBarThresholds: JSON.parse(JSON.stringify(settings.statusBarThresholds)) as typeof settings.statusBarThresholds,
};
const all = (on: boolean): StatusBarItems =>
  Object.fromEntries(Object.keys(DEFAULTS.statusBarItems).map((k) => [k, on])) as unknown as StatusBarItems;

describe("bar order and priority", () => {
  it("names every setting once, the host before the resources", () => {
    expect([...BAR_ORDER].sort()).toEqual(Object.keys(DEFAULTS.statusBarItems).sort());
    expect(BAR_ORDER.indexOf("host")).toBeLessThan(BAR_ORDER.indexOf("cpu"));
    expect(BAR_ORDER.slice(2, 6)).toEqual(["cpu", "ram", "disk", "net"]);
  });

  it("keeps CPU, memory and disk always; the network goes last of the rest", () => {
    const core = BAR_ORDER.filter((g) => BAR_PRIORITY[g] <= BAR_CORE_PRIORITY);
    expect(core).toEqual(["cpu", "ram", "disk"]);
    const rest = BAR_ORDER.filter((g) => BAR_PRIORITY[g] > BAR_CORE_PRIORITY);
    expect(Math.min(...rest.map((g) => BAR_PRIORITY[g]))).toBe(BAR_PRIORITY.net);
  });

  it("opens a section the monitoring page has", () => {
    for (const g of BAR_ORDER) expect(SECTIONS).toContain(BAR_SECTION[g]);
    expect(BAR_SECTION.cpu).toBe("cpu");
    expect(BAR_SECTION.cpuTemp).toBe("temperature");
    expect(BAR_SECTION.topProc).toBe("processes");
  });

  it("gives a tile only to groups with a history, each with a series", () => {
    expect(Object.keys(BAR_TILES).sort()).toEqual(["cpu", "cpuTemp", "disk", "diskio", "load", "net", "ram", "swap"]);
    for (const tile of Object.values(BAR_TILES)) {
      expect(tile.lines.length).toBeGreaterThan(0);
      if (tile.mirror) expect(tile.lines).toHaveLength(2);
    }
  });
});

describe("shownGroups", () => {
  it("shows what is switched on and reported, in bar order", () => {
    expect(shownGroups(m, all(true))).toEqual(BAR_ORDER);
    expect(shownGroups(m, DEFAULTS.statusBarItems)).toEqual(["os", "cpu", "ram", "disk", "net"]);
  });

  it("hides what the host does not report, but not the always-reported four", () => {
    const sparse: Metrics = {
      ...m,
      user: "",
      hostname: "",
      ip: "",
      uptimeSecs: null,
      kernel: "",
      serverTime: "",
      load1: null,
      cpuTemp: null,
      topProc: "",
      diskReadRate: null,
      diskWriteRate: null,
      netRxRate: null,
      netTxRate: null,
      netConns: null,
      users: "",
      cpuPct: null,
      swapTotal: null,
    };
    expect(shownGroups(sparse, all(true))).toEqual(["os", "cpu", "ram", "disk", "swap"]);
  });

  it("reads the users list", () => {
    expect(usersOf(m)).toEqual(["root", "alice"]);
    expect(usersOf({ ...m, users: "  " })).toEqual([]);
  });
});

describe("fitBar", () => {
  const row = (ids: BarGroup[], w = 50) => ids.map((id) => ({ id, w }));

  it("hides nothing when everything fits, or before the row is measured", () => {
    expect(fitBar(row(["cpu", "ram", "disk"]), 200, 8, 30).size).toBe(0);
    expect(fitBar(row(["cpu", "ram", "disk", "ip"]), 0, 8, 30).size).toBe(0);
  });

  it("drops the highest priority first, the later of equals first, and leaves room for «⋯»", () => {
    const groups = row(["os", "cpu", "ram", "disk", "net", "load", "uptime", "users", "kernel"]);
    // 9 × (50 + 8) = 522; at 400 the kernel and both of the 6s go, then «⋯» needs room too.
    const hidden = fitBar(groups, 400, 8, 30);
    expect([...hidden]).toEqual(["kernel", "users", "uptime"]);
    // The narrower the room, the further down the list.
    expect([...fitBar(groups, 300, 8, 30)]).toEqual(["kernel", "users", "uptime", "os", "load"]);
  });

  it("never drops the core: what still does not fit is clipped", () => {
    const hidden = fitBar(row(["cpu", "ram", "disk", "net", "ip"]), 60, 8, 30);
    expect([...hidden].sort()).toEqual(["ip", "net"]);
  });

  it("allows a digit's width of slack, so a value's last pixel does not toggle a group", () => {
    const groups = row(["cpu", "ram", "ip"]); // 3 × 58 = 174
    expect(fitBar(groups, 173, 8, 30).size).toBe(0);
    expect(fitBar(groups, 170, 8, 30).has("ip")).toBe(true);
  });
});

describe("problems, verdict, chip", () => {
  const th = DEFAULTS.statusBarThresholds;

  it("finds nothing on a calm host", () => {
    const ps = barProblems(m, th);
    expect(ps).toEqual([]);
    expect(barVerdict(ps)).toBe("ok");
    expect(chipText(ps)).toBeNull();
  });

  it("files the root disk from the basic probe, and tells one problem by itself", () => {
    const ps = barProblems({ ...m, diskUsed: 90 * 1024 ** 3 }, th);
    expect(ps.map((p) => p.id)).toEqual(["disk:/"]);
    expect(ps[0]).toMatchObject({ level: "warn", section: "disks", key: "mon.p.disk", params: { mount: "/", pct: 90 } });
    expect(barVerdict(ps)).toBe("warn");
    expect(chipText(ps)).toEqual({ kind: "one", problem: ps[0] });
  });

  it("counts several by kind, the worst setting the verdict", () => {
    const ps = barProblems({ ...m, cpuPct: 99, memUsed: 7 * 1024 ** 3, load1: 6 }, th);
    expect(barVerdict(ps)).toBe("crit");
    const chip = chipText(ps);
    expect(chip).toMatchObject({ kind: "count" });
    if (chip?.kind === "count") expect(chip.crit + chip.warn).toBe(ps.length);
  });

  it("knows nothing without a reading", () => {
    expect(barProblems(null, th)).toEqual([]);
  });
});

describe("tileLeft", () => {
  it("stands over the group, but never past either edge", () => {
    expect(tileLeft(100, 240, 1000)).toBe(100);
    expect(tileLeft(900, 240, 1000)).toBe(760);
    expect(tileLeft(-5, 240, 1000)).toBe(0);
    expect(tileLeft(10, 240, 200)).toBe(0);
  });
});
