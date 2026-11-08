import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ netcheckRun: vi.fn(), recordAudit: vi.fn(), sftpCancel: vi.fn() }));

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
