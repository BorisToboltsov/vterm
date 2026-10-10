import { describe, expect, it } from "vitest";
import {
  buildVisibleItems,
  checkUpload,
  cursorForReturnedFolder,
  isDestExists,
  pasteTargetName,
  replaceList,
  uploadItems,
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

describe("upload onto taken names", () => {
  const paths = ["/Users/me/a.conf", "C:\\work\\b.conf", "/tmp/c.conf"];

  it("splits a batch by the names the folder already holds", () => {
    expect(checkUpload(paths, ["b.conf", "zzz"])).toEqual({
      fresh: ["/Users/me/a.conf", "/tmp/c.conf"],
      clash: ["C:\\work\\b.conf"],
    });
    expect(checkUpload(paths, [])).toEqual({ fresh: paths, clash: [] });
  });

  it("compares names exactly — the server is case-sensitive", () => {
    expect(checkUpload(["/l/Readme.md"], ["README.md"]).clash).toEqual([]);
    expect(checkUpload(["/l/README.md"], ["README.md"]).clash).toEqual(["/l/README.md"]);
  });

  it("uploads nothing on cancel", () => {
    expect(uploadItems(paths, checkUpload(paths, ["b.conf"]), "cancel")).toEqual([]);
    expect(uploadItems(paths, null, "cancel")).toEqual([]);
  });

  it("skips the taken names and never lets a free one replace", () => {
    expect(uploadItems(paths, checkUpload(paths, ["b.conf"]), "skip")).toEqual([
      { path: "/Users/me/a.conf", replace: false },
      { path: "/tmp/c.conf", replace: false },
    ]);
  });

  it("lets only the asked-about names replace, in the order given", () => {
    expect(uploadItems(paths, checkUpload(paths, ["b.conf"]), "replace")).toEqual([
      { path: "/Users/me/a.conf", replace: false },
      { path: "C:\\work\\b.conf", replace: true },
      { path: "/tmp/c.conf", replace: false },
    ]);
  });

  it("an unread folder uploads only on an explicit yes — and then may replace", () => {
    expect(uploadItems(paths, null, "skip")).toEqual([]);
    expect(uploadItems(paths, null, "replace")).toEqual(
      paths.map((path) => ({ path, replace: true })),
    );
  });

  it("lists the first names and counts the rest", () => {
    const clash = Array.from({ length: 8 }, (_, i) => `/l/f${i}.txt`);
    expect(replaceList(clash)).toEqual({
      names: ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"],
      more: 3,
    });
    expect(replaceList(["/l/one.txt"])).toEqual({ names: ["one.txt"], more: 0 });
  });

  it("names a file once when two of the batch share its name", () => {
    expect(replaceList(["/a/x.txt", "/b/x.txt", "/a/y.txt"])).toEqual({
      names: ["x.txt", "y.txt"],
      more: 0,
    });
  });
});
