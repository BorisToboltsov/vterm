import { describe, expect, it } from "vitest";
import { followUpdates, gitCwd, pollsLocalCwd } from "./followcwd";

describe("followUpdates", () => {
  it("writes the terminal cwd once per change, only while following", () => {
    const seen: Record<string, string | undefined> = {};
    expect(followUpdates({ a: true }, { a: "/x" }, seen)).toEqual([["a", "/x"]]);
    // Re-run with nothing new: no write, so a file-panel move made meanwhile stands.
    expect(followUpdates({ a: true }, { a: "/x" }, seen)).toEqual([]);
    expect(followUpdates({ a: true }, { a: "/y" }, seen)).toEqual([["a", "/y"]]);
    expect(followUpdates({ a: false }, { a: "/z" }, seen)).toEqual([]);
  });

  it("jumps to the terminal when following is switched back on", () => {
    const seen: Record<string, string | undefined> = {};
    followUpdates({ a: true }, { a: "/x" }, seen);
    followUpdates({ a: false }, { a: "/x" }, seen);
    expect(followUpdates({ a: true }, { a: "/x" }, seen)).toEqual([["a", "/x"]]);
  });

  it("does not touch another session when one moves", () => {
    const seen: Record<string, string | undefined> = {};
    followUpdates({ a: true, b: true }, { a: "/a", b: "/b" }, seen);
    expect(followUpdates({ a: true, b: true }, { a: "/a", b: "/b2" }, seen)).toEqual([
      ["b", "/b2"],
    ]);
  });

  it("waits for a cwd it doesn't know yet", () => {
    expect(followUpdates({ a: true }, {}, {})).toEqual([]);
  });
});

describe("gitCwd", () => {
  it("reads the dock's shared directory while following", () => {
    expect(gitCwd(true, "/panel", "/term")).toBe("/panel");
    expect(gitCwd(true, null, "/term")).toBeNull();
  });

  it("follows the terminal alone while following is off", () => {
    expect(gitCwd(false, "/home/u", "/srv/repo")).toBe("/srv/repo");
  });

  it("never falls back to the panel's folder for an unknown terminal cwd", () => {
    expect(gitCwd(false, "/home/u", null)).toBeNull();
    expect(gitCwd(false, "/home/u", "")).toBeNull();
  });
});

describe("pollsLocalCwd", () => {
  it("polls a local tab while following or while git is on screen", () => {
    expect(pollsLocalCwd("local", true, false)).toBe(true);
    expect(pollsLocalCwd("local", false, true)).toBe(true);
    expect(pollsLocalCwd("local", false, false)).toBe(false);
  });

  it("never polls SSH or an unknown tab", () => {
    expect(pollsLocalCwd("ssh", true, true)).toBe(false);
    expect(pollsLocalCwd(undefined, true, true)).toBe(false);
  });
});
