import { describe, expect, it } from "vitest";
import { ancestorChain, flattenTree, treeKey, type TreeChildren } from "./remotetree";

const dirs = (...paths: string[]) => paths.map((p) => ({ path: p, name: p.split("/").pop()! }));

describe("ancestorChain", () => {
  it("opens every folder from the root down", () => {
    expect(ancestorChain("/srv/app/web")).toEqual(["/", "/srv", "/srv/app", "/srv/app/web"]);
    expect(ancestorChain("/")).toEqual(["/"]);
    expect(ancestorChain("/srv/app/")).toEqual(["/", "/srv", "/srv/app"]);
  });
});

describe("flattenTree", () => {
  const children: TreeChildren = {
    "/": dirs("/etc", "/srv"),
    "/srv": dirs("/srv/app"),
    "/srv/app": [],
    "/etc": "loading",
  };

  it("descends only into expanded folders, with depth", () => {
    const rows = flattenTree(children, new Set(["/", "/srv"]));
    expect(rows.map((r) => [r.path, r.depth])).toEqual([
      ["/", 0],
      ["/etc", 1],
      ["/srv", 1],
      ["/srv/app", 2],
    ]);
  });

  it("marks listed-empty folders as leaves, and loading / failed ones", () => {
    const rows = flattenTree({ ...children, "/srv/app": [] }, new Set(["/", "/srv"]));
    expect(rows.find((r) => r.path === "/srv/app")?.leaf).toBe(true);
    expect(rows.find((r) => r.path === "/etc")?.loading).toBe(true);
    // Not yet listed is not a leaf — it may well have children.
    expect(rows.find((r) => r.path === "/etc")?.leaf).toBe(false);
    const failed = flattenTree({ "/": { error: "denied" } }, new Set(["/"]));
    expect(failed[0].error).toBe("denied");
  });
});

describe("treeKey", () => {
  const rows = flattenTree(
    { "/": dirs("/etc", "/srv"), "/srv": dirs("/srv/app"), "/srv/app": [] },
    new Set(["/", "/srv"]),
  );

  it("moves with the arrows and jumps with Home/End", () => {
    expect(treeKey(rows, "/etc", "ArrowDown")).toEqual({ select: "/srv" });
    expect(treeKey(rows, "/etc", "ArrowUp")).toEqual({ select: "/" });
    expect(treeKey(rows, "/", "ArrowUp")).toBeNull();
    expect(treeKey(rows, "/etc", "End")).toEqual({ select: "/srv/app" });
    expect(treeKey(rows, "/srv", "Home")).toEqual({ select: "/" });
  });

  it("opens, steps in, closes and steps out", () => {
    expect(treeKey(rows, "/etc", "ArrowRight")).toEqual({ expand: "/etc" });
    expect(treeKey(rows, "/srv", "ArrowRight")).toEqual({ select: "/srv/app" });
    expect(treeKey(rows, "/srv/app", "ArrowRight")).toBeNull(); // leaf
    expect(treeKey(rows, "/srv", "ArrowLeft")).toEqual({ collapse: "/srv" });
    expect(treeKey(rows, "/srv/app", "ArrowLeft")).toEqual({ select: "/srv" });
    expect(treeKey(rows, "/", "ArrowLeft")).toEqual({ collapse: "/" });
  });

  it("picks with Enter and recovers a lost selection", () => {
    expect(treeKey(rows, "/srv", "Enter")).toEqual({ pick: "/srv" });
    expect(treeKey(rows, "/gone", "ArrowDown")).toEqual({ select: "/" });
  });
});
