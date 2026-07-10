import { describe, it, expect } from "vitest";
import {
  groupRecordings,
  sectionRecordings,
  type RecEntry,
  type RecGroupEntry,
} from "./recgroup";
import type { RecordingMeta } from "./types";

const rec = (over: Partial<RecordingMeta> & { path: string }): RecordingMeta => ({
  title: over.path,
  description: "",
  server: "",
  width: 80,
  height: 24,
  timestamp: 0,
  size: 0,
  ...over,
});

describe("groupRecordings", () => {
  it("keeps recordings without a batch as single entries", () => {
    const items = [rec({ path: "a" }), rec({ path: "b" })];
    const out = groupRecordings(items);
    expect(out.every((e) => e.kind === "single")).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("collapses recordings sharing a batchId into one group at the first member", () => {
    const items = [
      rec({ path: "solo", timestamp: 50 }),
      rec({ path: "b1", batchId: "batch", timestamp: 100 }),
      rec({ path: "b2", batchId: "batch", timestamp: 90 }),
    ];
    const out = groupRecordings(items);
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("single");
    expect(out[1].kind).toBe("group");
    const group = out[1] as RecGroupEntry;
    expect(group.items.map((r) => r.path)).toEqual(["b1", "b2"]);
    // Timestamp is the earliest member's (for sorting the bundle).
    expect(group.timestamp).toBe(90);
  });

  it("shows a lone batch member as a group too", () => {
    const out = groupRecordings([rec({ path: "only", batchId: "b" })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("group");
    expect((out[0] as RecGroupEntry).items).toHaveLength(1);
  });

  it("carries the bundle label from whichever member has it", () => {
    const items = [
      rec({ path: "b1", batchId: "b" }),
      rec({ path: "b2", batchId: "b", batchLabel: "Nightly deploy" }),
    ];
    const out = groupRecordings(items);
    expect((out[0] as RecGroupEntry).label).toBe("Nightly deploy");
  });

  it("leaves the label undefined for an unnamed bundle", () => {
    const out = groupRecordings([rec({ path: "b1", batchId: "b" })]);
    expect((out[0] as RecGroupEntry).label).toBeUndefined();
  });

  it("keeps separate batches separate", () => {
    const items = [
      rec({ path: "x1", batchId: "x" }),
      rec({ path: "y1", batchId: "y" }),
      rec({ path: "x2", batchId: "x" }),
    ];
    const out = groupRecordings(items);
    expect(out).toHaveLength(2);
    expect((out[0] as RecGroupEntry).batchId).toBe("x");
    expect((out[0] as RecGroupEntry).items.map((r) => r.path)).toEqual(["x1", "x2"]);
    expect((out[1] as RecGroupEntry).batchId).toBe("y");
  });
});

describe("sectionRecordings", () => {
  const single = (over: Partial<RecordingMeta> & { path: string }): RecEntry => ({
    kind: "single",
    rec: rec(over),
  });
  // Local-noon epoch (seconds) N days before 2026-07-11 — dayStart differences
  // land on exact calendar days regardless of the test runner's timezone.
  const noon = (daysAgo: number): number =>
    new Date(2026, 6, 11 - daysAgo, 12, 0, 0).getTime() / 1000;
  const now = noon(0);

  it("returns one flat `all` section for mode none, summing bundle members", () => {
    const entries = groupRecordings([
      rec({ path: "a" }),
      rec({ path: "b1", batchId: "b" }),
      rec({ path: "b2", batchId: "b" }),
    ]);
    const out = sectionRecordings(entries, "none", now);
    expect(out).toHaveLength(1);
    expect(out[0].bucket).toBe("all");
    expect(out[0].entries).toBe(entries);
    expect(out[0].count).toBe(3);
  });

  it("groups singles by server, in first-appearance order", () => {
    const entries = [
      single({ path: "a", server: "web-01" }),
      single({ path: "b", server: "db-01" }),
      single({ path: "c", server: "web-01" }),
    ];
    const out = sectionRecordings(entries, "server", now);
    expect(out.map((s) => s.label)).toEqual(["web-01", "db-01"]);
    expect(out[0].bucket).toBe("server");
    expect(out[0].count).toBe(2);
    expect(out[0].entries.map((e) => (e.kind === "single" ? e.rec.path : ""))).toEqual(["a", "c"]);
  });

  it("puts server-less singles in a noServer section and bundles in a broadcast one", () => {
    const entries = groupRecordings([
      rec({ path: "local", server: "" }),
      rec({ path: "b1", batchId: "b", server: "web-01" }),
      rec({ path: "b2", batchId: "b", server: "db-01" }),
    ]);
    const out = sectionRecordings(entries, "server", now);
    expect(out.map((s) => s.bucket)).toEqual(["noServer", "broadcast"]);
    // The whole bundle counts as its two members, never split across servers.
    expect(out[1].count).toBe(2);
  });

  it("buckets entries by relative date", () => {
    const entries = [
      single({ path: "t", server: "x", timestamp: noon(0) }),
      single({ path: "y", timestamp: noon(1) }),
      single({ path: "w", timestamp: noon(3) }),
      single({ path: "m", timestamp: noon(10) }),
      single({ path: "o", timestamp: noon(40) }),
      single({ path: "u", timestamp: 0 }),
    ];
    const out = sectionRecordings(entries, "date", now);
    expect(out.map((s) => s.bucket)).toEqual([
      "today",
      "yesterday",
      "week",
      "month",
      "older",
      "unknownDate",
    ]);
    expect(out.every((s) => s.count === 1)).toBe(true);
  });

  it("keeps a date bucket's members together across scattered input", () => {
    const entries = [
      single({ path: "a", timestamp: noon(0) }),
      single({ path: "b", timestamp: noon(40) }),
      single({ path: "c", timestamp: noon(0) }),
    ];
    const out = sectionRecordings(entries, "date", now);
    expect(out.map((s) => s.bucket)).toEqual(["today", "older"]);
    expect(out[0].entries.map((e) => (e.kind === "single" ? e.rec.path : ""))).toEqual(["a", "c"]);
  });
});
