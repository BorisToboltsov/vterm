import { describe, expect, it } from "vitest";
import {
  buildVisibleItems,
  cursorForReturnedFolder,
  isDestExists,
  pasteTargetName,
} from "./filebrowser";
import type { FileEntry } from "./types";

const entry = (name: string, isDir = false): FileEntry => ({
  name,
  path: `/d/${name}`,
  isDir,
  isSymlink: false,
  size: 0,
  modified: 0,
  mode: 0,
  uid: null,
  gid: null,
  user: null,
  group: null,
});

describe("buildVisibleItems", () => {
  const es = [entry("a"), entry("b"), entry("c"), entry("d")];

  it("offsets entries by the .. row when there is a parent", () => {
    // rows: 0=".." 1=a 2=b … window [0,3) → .., a, b
    const items = buildVisibleItems(0, 3, true, es);
    expect(items.map((i) => i.key)).toEqual(["..", "/d/a", "/d/b"]);
    expect(items[0].entry).toBeNull();
    expect(items[1].entry).toBe(es[0]);
  });

  it("has no .. row and no offset at the root", () => {
    const items = buildVisibleItems(0, 3, false, es);
    expect(items.map((i) => i.key)).toEqual(["/d/a", "/d/b", "/d/c"]);
  });

  it("renders only the requested window", () => {
    const items = buildVisibleItems(2, 4, true, es); // rows 2=b, 3=c
    expect(items.map((i) => i.key)).toEqual(["/d/b", "/d/c"]);
  });

  it("stops at the end without emitting undefined rows", () => {
    // hasParent → 5 rows (.. + 4); window asks past the end.
    const items = buildVisibleItems(3, 8, true, es); // rows 3=c, 4=d, then nothing
    expect(items.map((i) => i.key)).toEqual(["/d/c", "/d/d"]);
    expect(items.every((i) => i.entry !== undefined)).toBe(true);
  });
});

describe("cursorForReturnedFolder", () => {
  const es = [entry("a"), entry("b"), entry("c")];

  it("lands on the folder we came from, offset by the .. row", () => {
    // came out of /d/b → index 1 in shownEntries → cursor 2 (with .. at 0)
    expect(cursorForReturnedFolder(es, "/d/b", true, 4)).toBe(2);
  });

  it("does not offset when there is no parent", () => {
    expect(cursorForReturnedFolder(es, "/d/b", false, 3)).toBe(1);
  });

  it("falls back to the first row when the folder is not visible", () => {
    expect(cursorForReturnedFolder(es, "/d/hidden", true, 4)).toBe(0);
  });

  it("is -1 when the parent listing is empty", () => {
    expect(cursorForReturnedFolder([], "/d/x", false, 0)).toBe(-1);
  });
});

describe("pasteTargetName", () => {
  it("keeps the name when moving (cut), even onto a collision", () => {
    expect(pasteTargetName("cut", "f.txt", new Set(["f.txt"]))).toBe("f.txt");
  });

  it("keeps the name when copying with no collision", () => {
    expect(pasteTargetName("copy", "f.txt", new Set(["other"]))).toBe("f.txt");
  });

  it("disambiguates a copy onto an existing name", () => {
    const out = pasteTargetName("copy", "f.txt", new Set(["f.txt"]));
    expect(out).not.toBe("f.txt");
    expect(out).toContain("f");
  });
});

describe("isDestExists", () => {
  it("recognizes the dest-exists marker", () => {
    expect(isDestExists("sftp error: dest-exists")).toBe(true);
  });
  it("is false for other errors", () => {
    expect(isDestExists("permission denied")).toBe(false);
    expect(isDestExists("")).toBe(false);
  });
});
