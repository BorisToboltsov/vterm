import { describe, expect, it } from "vitest";
import { baseName, checkMove, joinPath, parentDir } from "./filemove";

describe("parentDir", () => {
  it("returns the containing directory", () => {
    expect(parentDir("/a/b/c.txt")).toBe("/a/b");
    expect(parentDir("/a")).toBe("/");
    expect(parentDir("/a/")).toBe("/");
    expect(parentDir("/")).toBe("/");
    expect(parentDir("bare")).toBe("");
  });
});

describe("baseName", () => {
  it("returns the final segment", () => {
    expect(baseName("/a/b/c.txt")).toBe("c.txt");
    expect(baseName("/a/dir/")).toBe("dir");
    expect(baseName("file")).toBe("file");
  });
});

describe("joinPath", () => {
  it("keeps exactly one slash", () => {
    expect(joinPath("/a/b", "c")).toBe("/a/b/c");
    expect(joinPath("/", "c")).toBe("/c");
    expect(joinPath("/a/", "c")).toBe("/a/c");
  });
});

describe("checkMove", () => {
  it("moves a file into a sibling folder", () => {
    expect(checkMove("/home/u/note.txt", "/home/u/docs")).toEqual({
      ok: true,
      dest: "/home/u/docs/note.txt",
    });
  });

  it("moves a folder into a sibling folder", () => {
    expect(checkMove("/home/u/proj", "/home/u/archive")).toEqual({
      ok: true,
      dest: "/home/u/archive/proj",
    });
  });

  it("moves up into the parent (drop on '..')", () => {
    expect(checkMove("/home/u/docs/note.txt", "/home/u")).toEqual({
      ok: true,
      dest: "/home/u/note.txt",
    });
  });

  it("rejects dropping an item onto itself", () => {
    expect(checkMove("/home/u/proj", "/home/u/proj")).toEqual({
      ok: false,
      reason: "self",
    });
  });

  it("rejects moving a folder into its own descendant", () => {
    expect(checkMove("/home/u/proj", "/home/u/proj/sub")).toEqual({
      ok: false,
      reason: "into-descendant",
    });
  });

  it("does not treat a sibling with a shared name prefix as a descendant", () => {
    // "/a/proj2" starts with "/a/proj" as a string but is NOT inside "/a/proj".
    expect(checkMove("/a/proj", "/a/proj2")).toEqual({
      ok: true,
      dest: "/a/proj2/proj",
    });
  });

  it("reports a no-op when the item is already in the target directory", () => {
    expect(checkMove("/home/u/note.txt", "/home/u")).toEqual({
      ok: false,
      reason: "noop",
    });
  });

  it("normalizes trailing slashes on both inputs", () => {
    expect(checkMove("/home/u/proj/", "/home/u/archive/")).toEqual({
      ok: true,
      dest: "/home/u/archive/proj",
    });
  });
});
