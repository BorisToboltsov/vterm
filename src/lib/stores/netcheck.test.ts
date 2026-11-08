import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  netcheckRun: vi.fn(),
  recordAudit: vi.fn(async () => {}),
  sftpCancel: vi.fn(async () => {}),
}));
// Every session records: what a run writes into the recording is observable.
vi.mock("./recordings.svelte", () => ({ isRecording: () => true }));

const KEY = "vterm.netcheck.tables";

/** The store as a fresh launch reads it — with the Svelte runtime of that launch. */
async function launch() {
  vi.resetModules();
  const store = await import("./netcheck.svelte");
  const { flushSync } = await import("svelte");
  const { newRow } = await import("../netcheck/netcheckform");
  return { ...store, flushSync, newRow };
}

beforeEach(() => {
  localStorage.clear();
});

describe("access check tables across a restart", () => {
  it("the rules and the servers picked come back after a restart", async () => {
    const first = await launch();
    first.setRows("10.0.0.5", [first.newRow({ targets: "db.corp", ports: "5432" }, "local")]);
    first.togglePicked("10.0.0.5", "local");
    first.flushSync();
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
      rows: { "10.0.0.5": [{ source: "", targets: "db.corp", ports: "5432", proto: "tcp", via: "local" }] },
      picked: { "10.0.0.5": ["10.0.0.5", "local"] },
    });

    const next = await launch();
    expect(next.rowsOf("10.0.0.5").map((r) => [r.targets, r.ports, r.via])).toEqual([["db.corp", "5432", "local"]]);
    expect(next.pickedOf("10.0.0.5")).toEqual(["10.0.0.5", "local"]);
    // Another tab's host still starts empty, from itself.
    expect(next.rowsOf("local")).toEqual([]);
    expect(next.pickedOf("local")).toEqual(["local"]);
  });

  it("a row edited in place is kept as edited", async () => {
    const store = await launch();
    store.setRows("h", [store.newRow({ targets: "a", ports: "22" })]);
    store.flushSync();
    store.netcheckState.rows.h[0].ports = "22, 443";
    store.flushSync();
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null").rows.h[0].ports).toBe("22, 443");
  });

  it("an unreadable entry starts the tables empty", async () => {
    localStorage.setItem(KEY, "{not json");
    const store = await launch();
    expect(store.rowsOf("h")).toEqual([]);
    expect(store.pickedOf("h")).toEqual(["h"]);
  });
});

describe("what servers said of themselves", () => {
  it("is remembered by host key across a restart", async () => {
    const first = await launch();
    first.rememberFacts("10.0.0.5", { hostname: "db-01", addrs: ["10.0.0.5", "10.70.0.5"] });
    const next = await launch();
    expect(next.netcheckState.known).toEqual({ "10.0.0.5": { hostname: "db-01", addrs: ["10.0.0.5", "10.70.0.5"] } });
  });

  it("the newest answer replaces the old one and moves to the end", async () => {
    const store = await launch();
    store.rememberFacts("a", { hostname: "a1", addrs: [] });
    store.rememberFacts("b", { hostname: "b1", addrs: [] });
    store.rememberFacts("a", { hostname: "a2", addrs: ["10.0.0.1"] });
    expect(Object.keys(store.netcheckState.known)).toEqual(["b", "a"]);
    expect(store.netcheckState.known.a.hostname).toBe("a2");
  });
});

describe("wait for open (ADR 0056)", () => {
  /** The store with a run from one server whose ports answer as `open()` says. */
  async function withRun(ports: number[], open: (port: number) => boolean) {
    const store = await launch();
    const api = await import("../api");
    const { parseRules } = await import("../netcheck/netcheck");
    const run = vi.mocked(api.netcheckRun);
    run.mockReset();
    run.mockImplementation(async (_sid, _args, targets) => {
      const lines = ["H\tsrv", "M\tnative"];
      for (const t of targets) for (const p of t.ports) lines.push(`N\t${t.host}\t${p}\t${open(p) ? "open" : "timeout"}\t5\t`);
      return { stdout: `${lines.join("\n")}\nE\n`, stderr: "", exitCode: 0 };
    });
    const rules = parseRules(`10.0.0.9:[${ports.join(",")}]`).rules;
    const host = {
      key: "10.0.0.5",
      name: "app",
      kind: "ssh" as const,
      serverId: "a",
      address: "10.0.0.5",
      sessionId: "s1",
      live: true,
      connecting: false,
      isProd: false,
      hasTab: true,
    };
    await store.startRun("10.0.0.5", [{ host, rules, checks: ports.length, subnet: false }], 3, "x");
    return { store, run };
  }

  it("checks again only what did not open, every few seconds, until it opens", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const { store, run } = await withRun([22, 443], (p) => p === 22 || up);
      const audit = vi.mocked((await import("../api")).recordAudit);
      audit.mockClear();
      expect(store.retryChecks(store.runOf("10.0.0.5"))).toBe(1);
      const done = store.startWaiting("10.0.0.5");
      expect(store.waitOf("10.0.0.5")?.attempts).toBe(0);
      await vi.advanceTimersByTimeAsync(store.WAIT_EVERY_SECS * 1000 + 300);
      expect(store.waitOf("10.0.0.5")?.attempts).toBe(1);
      // The attempt asked for the one port that had not opened.
      expect(run.mock.calls.at(-1)?.[2]).toEqual([{ host: "10.0.0.9", ports: [443] }]);
      // Nothing opened: nothing goes into the recording.
      expect(audit).not.toHaveBeenCalled();
      up = true;
      await vi.advanceTimersByTimeAsync(store.WAIT_EVERY_SECS * 1000 + 300);
      await done;
      expect(store.waitOf("10.0.0.5")).toBeNull();
      expect(store.retryChecks(store.runOf("10.0.0.5"))).toBe(0);
      expect(run).toHaveBeenCalledTimes(3);
      // The attempt that opened it is recorded, once.
      expect(audit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when asked, and gives up after its time", async () => {
    vi.useFakeTimers();
    try {
      const { store, run } = await withRun([443], () => false);
      const stopped = store.startWaiting("10.0.0.5");
      store.stopWaiting("10.0.0.5");
      await vi.advanceTimersByTimeAsync(store.WAIT_EVERY_SECS * 3000);
      await stopped;
      expect(run).toHaveBeenCalledTimes(1);

      const expired = store.startWaiting("10.0.0.5");
      await vi.advanceTimersByTimeAsync(store.WAIT_FOR_SECS * 1000 + store.WAIT_EVERY_SECS * 1000);
      await expired;
      expect(store.waitOf("10.0.0.5")).toBeNull();
      // One attempt per interval, none past the limit.
      const attempts = run.mock.calls.length - 1;
      expect(attempts).toBeLessThanOrEqual(store.WAIT_FOR_SECS / store.WAIT_EVERY_SECS);
      expect(attempts).toBeGreaterThan(store.WAIT_FOR_SECS / store.WAIT_EVERY_SECS - 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start with nothing to wait for, or too much", async () => {
    const all = await withRun([22], () => true);
    await all.store.startWaiting("10.0.0.5");
    expect(all.store.waitOf("10.0.0.5")).toBeNull();
    const ports = Array.from({ length: 65 }, (_, i) => 1000 + i);
    const many = await withRun(ports, () => false);
    await many.store.startWaiting("10.0.0.5");
    expect(many.store.waitOf("10.0.0.5")).toBeNull();
  });

  it("a new run ends the wait for the old one's answer", async () => {
    vi.useFakeTimers();
    try {
      const { store, run } = await withRun([443], () => false);
      const waiting = store.startWaiting("10.0.0.5");
      const { parseRules } = await import("../netcheck/netcheck");
      const host = store.runOf("10.0.0.5")!.hosts[0];
      await store.startRun(
        "10.0.0.5",
        [{ host: { key: host.key, name: host.name, kind: host.kind, serverId: "a", address: host.key, sessionId: "s1", live: true, connecting: false, isProd: false, hasTab: true }, rules: parseRules("10.0.0.9:80").rules, checks: 1, subnet: false }],
        3,
        "y",
      );
      await vi.advanceTimersByTimeAsync(store.WAIT_EVERY_SECS * 3000);
      await waiting;
      expect(store.waitOf("10.0.0.5")).toBeNull();
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
