import { describe, it, expect } from "vitest";
import {
  eligibleMembers,
  prodMembers,
  groupHasProd,
  frameCommand,
  pickLayout,
  gridColumns,
  FOCUS_THRESHOLD,
  type BroadcastTab,
} from "./broadcast";

const tab = (over: Partial<BroadcastTab> & { sessionId: string }): BroadcastTab => ({
  kind: "ssh",
  serverId: "srv-" + over.sessionId,
  status: "Connected",
  ...over,
});

describe("eligibleMembers", () => {
  const tabs: BroadcastTab[] = [
    tab({ sessionId: "a" }),
    tab({ sessionId: "b", status: "Connecting…" }),
    tab({ sessionId: "c", status: "Disconnected" }),
    tab({ sessionId: "d", status: "Error: auth-rejected" }),
    tab({ sessionId: "e" }),
  ];

  it("keeps only open, live members and preserves tab order", () => {
    // Requested out of order; result follows the tab list, not the request.
    expect(eligibleMembers(["e", "a", "b"], tabs)).toEqual(["a", "b", "e"]);
  });

  it("drops closed and errored members", () => {
    expect(eligibleMembers(["a", "c", "d"], tabs)).toEqual(["a"]);
  });

  it("ignores ids that are no longer open tabs", () => {
    expect(eligibleMembers(["a", "ghost"], tabs)).toEqual(["a"]);
  });

  it("is empty for an empty selection", () => {
    expect(eligibleMembers([], tabs)).toEqual([]);
  });
});

describe("prodMembers / groupHasProd", () => {
  const tabs: BroadcastTab[] = [
    tab({ sessionId: "a", serverId: "web" }),
    tab({ sessionId: "b", serverId: "db" }),
    tab({ sessionId: "l", kind: "local", serverId: "" }),
  ];
  const servers = [
    { id: "web", tags: ["staging"] },
    { id: "db", tags: ["Prod"] },
  ];

  it("flags only SSH members whose server carries a prod tag", () => {
    expect(prodMembers(["a", "b", "l"], tabs, servers)).toEqual(["b"]);
    expect(groupHasProd(["a", "b", "l"], tabs, servers)).toBe(true);
  });

  it("is false when no target is prod", () => {
    expect(prodMembers(["a", "l"], tabs, servers)).toEqual([]);
    expect(groupHasProd(["a", "l"], tabs, servers)).toBe(false);
  });

  it("treats local tabs and unknown servers as non-prod", () => {
    expect(groupHasProd(["l"], tabs, servers)).toBe(false);
    expect(groupHasProd(["a"], tabs, [])).toBe(false);
  });
});

describe("frameCommand", () => {
  // Phase 39.5: CR (what Enter actually sends), not LF — with LF the command
  // landed on the prompt of every Windows target without running.
  it("appends Enter so the command runs", () => {
    expect(frameCommand("uptime")).toBe("uptime\r");
  });

  it("does not trim user spacing", () => {
    expect(frameCommand("  ls -l ")).toBe("  ls -l \r");
  });

  it("returns null for an empty command", () => {
    expect(frameCommand("")).toBeNull();
  });
});

describe("pickLayout", () => {
  it("uses the grid up to the threshold, then focus", () => {
    expect(pickLayout(1)).toBe("grid");
    expect(pickLayout(FOCUS_THRESHOLD)).toBe("grid");
    expect(pickLayout(FOCUS_THRESHOLD + 1)).toBe("focus");
    expect(pickLayout(50)).toBe("focus");
  });
});

describe("gridColumns", () => {
  it("fits as many columns as the min tile allows", () => {
    // 1400 / 380 = 3 tiles fit.
    expect(gridColumns(1400, 6)).toBe(3);
  });

  it("never exceeds the member count", () => {
    expect(gridColumns(1400, 2)).toBe(2);
  });

  it("never exceeds the max column cap", () => {
    expect(gridColumns(4000, 20)).toBe(4);
  });

  it("keeps at least one column on a narrow container", () => {
    expect(gridColumns(200, 5)).toBe(1);
    expect(gridColumns(1400, 1)).toBe(1);
  });
});
