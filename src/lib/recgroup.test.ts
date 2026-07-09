import { describe, it, expect } from "vitest";
import { groupRecordings, type RecGroupEntry } from "./recgroup";
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
