import { describe, expect, it } from "vitest";
import { quitRows } from "./quitsummary";
import { statusLabel } from "./stores/tabs.svelte";

const none = { tabs: [], transfers: [], syncBusy: 0, recordings: 0 };

describe("quitRows", () => {
  it("is empty when nothing would be cut off (the dialog still asks)", () => {
    expect(quitRows(none)).toEqual([]);
  });

  it("counts live SSH and local tabs separately, ignoring dead ones", () => {
    const rows = quitRows({
      ...none,
      tabs: [
        { kind: "ssh", status: statusLabel("connected") },
        { kind: "ssh", status: statusLabel("connecting") },
        { kind: "ssh", status: statusLabel("closed") },
        { kind: "ssh", status: statusLabel("error", "timeout") },
        { kind: "local", status: statusLabel("connected") },
      ],
    });
    expect(rows).toEqual([
      { key: "ssh", count: 2 },
      { key: "local", count: 1 },
    ]);
  });

  it("counts in-flight user transfers, not finished ones or sync-run files", () => {
    const rows = quitRows({
      ...none,
      transfers: [
        { id: "a", done: false },
        { id: "b", done: true },
        { id: "sync:x.txt", done: false },
      ],
    });
    expect(rows).toEqual([{ key: "transfers", count: 1 }]);
  });

  it("lists every kind in a fixed order", () => {
    const rows = quitRows({
      tabs: [
        { kind: "local", status: statusLabel("connected") },
        { kind: "ssh", status: statusLabel("connected") },
      ],
      transfers: [{ id: "a", done: false }],
      syncBusy: 1,
      recordings: 2,
    });
    expect(rows.map((r) => r.key)).toEqual(["ssh", "local", "transfers", "sync", "recording"]);
    expect(rows.at(-1)).toEqual({ key: "recording", count: 2 });
  });
});
