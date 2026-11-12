import { describe, expect, it } from "vitest";
import type { TextFile } from "../types";
import { editTally, patchHost, pickedAtFirst, readFailure, writable, type HostEdit } from "./groupedit";
import { hunksOf } from "./linepatch";

const file = (content: string): TextFile => ({
  content,
  eol: "lf",
  size: content.length,
  mode: null,
  mtime: null,
  sha256: "sha",
  readOnly: false,
  encoding: "utf-8",
});

const BASE = "a\nb\nc\nd\ne\n";
const EDITED = "a\nb\nC\nd\ne\n";
const hunks = hunksOf(BASE, EDITED)!;

describe("a member's file under the group's edit", () => {
  it("tells a missing file from one it may not read and from other failures", () => {
    expect(readFailure("No such file")).toEqual({ kind: "missing" });
    expect(readFailure("Permission denied")).toEqual({ kind: "denied" });
    expect(readFailure("binary file")).toEqual({ kind: "failed", error: "binary file" });
  });

  it("is ticked at first only where the edit landed exactly or moved", () => {
    const clean = patchHost(file(BASE), hunks, false);
    expect(clean).toMatchObject({ kind: "patched", outcome: "clean", text: EDITED });
    expect(pickedAtFirst(clean)).toBe(true);
    const fuzzy = patchHost(file("a\nB\nc\nd\nE\n"), hunks, false);
    expect(fuzzy).toMatchObject({ outcome: "fuzzy" });
    expect(writable(fuzzy)).toBe(true);
    expect(pickedAtFirst(fuzzy)).toBe(false);
  });

  it("has nothing to write where the edit is already there or found no place", () => {
    expect(writable(patchHost(file(EDITED), hunks, false))).toBe(false);
    expect(writable(patchHost(file("x\ny\n"), hunks, false))).toBe(false);
    expect(writable({ kind: "missing" })).toBe(false);
  });

  it("counts what will be written, what is there already and what is left", () => {
    const hosts: HostEdit[] = [
      patchHost(file(BASE), hunks, false),
      patchHost(file(EDITED), hunks, false),
      { kind: "denied" },
      patchHost(file(BASE), hunks, false),
    ];
    expect(editTally(hosts, (i) => i !== 3)).toEqual({ write: 1, already: 1, left: 2 });
  });
});
