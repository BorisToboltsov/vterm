import { describe, expect, it } from "vitest";
import { followUpdates } from "./followcwd";

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
