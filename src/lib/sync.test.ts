import { describe, expect, it } from "vitest";
import {
  compileExclude,
  parseExcludes,
  diffTrees,
  applicable,
  summarize,
  type HashEntry,
} from "./sync";

const h = (path: string, sha256: string): HashEntry => ({ path, sha256 });

describe("compileExclude", () => {
  it("matches a bare name against any path segment", () => {
    const ex = compileExclude([".git"]);
    expect(ex(".git")).toBe(true);
    expect(ex("a/.git/config")).toBe(true);
    expect(ex("src/app.ts")).toBe(false);
  });

  it("supports glob wildcards on a segment", () => {
    const ex = compileExclude(["*.tfstate"]);
    expect(ex("terraform.tfstate")).toBe(true);
    expect(ex("env/prod.tfstate")).toBe(true);
    expect(ex("main.tf")).toBe(false);
  });

  it("matches a path-anchored pattern and everything under it", () => {
    const ex = compileExclude(["build/dist"]);
    expect(ex("build/dist")).toBe(true);
    expect(ex("build/dist/app.js")).toBe(true);
    expect(ex("build/other")).toBe(false);
  });

  it("ignores blank patterns (empty list excludes nothing)", () => {
    const ex = compileExclude(["", "   "]);
    expect(ex("anything")).toBe(false);
  });
});

describe("parseExcludes", () => {
  it("splits on newlines and commas, trimming blanks", () => {
    expect(parseExcludes(".git, *.log\nnode_modules\n\n")).toEqual([
      ".git",
      "*.log",
      "node_modules",
    ]);
  });
});

describe("diffTrees", () => {
  const local = [h("same.txt", "aa"), h("changed.txt", "L1"), h("only-local.txt", "x")];
  const remote = [h("same.txt", "aa"), h("changed.txt", "R1"), h("only-remote.txt", "y")];

  it("push: upload new + changed; identical skipped; extraneous only with the flag", () => {
    const plan = diffTrees(local, remote, "push", [], false);
    expect(plan).toEqual([
      { path: "changed.txt", op: "upload", reason: "changed" },
      { path: "only-local.txt", op: "upload", reason: "new" },
    ]);
    const withDel = diffTrees(local, remote, "push", [], true);
    expect(withDel).toContainEqual({ path: "only-remote.txt", op: "deleteRemote", reason: "removed" });
  });

  it("pull: download new + changed; extraneous local deleted only with the flag", () => {
    const plan = diffTrees(local, remote, "pull", [], false);
    expect(plan).toEqual([
      { path: "changed.txt", op: "download", reason: "changed" },
      { path: "only-remote.txt", op: "download", reason: "new" },
    ]);
    const withDel = diffTrees(local, remote, "pull", [], true);
    expect(withDel).toContainEqual({ path: "only-local.txt", op: "deleteLocal", reason: "removed" });
  });

  it("bi: adds missing on both sides, flags content differences as conflicts", () => {
    const plan = diffTrees(local, remote, "bi", [], false);
    expect(plan).toEqual([
      { path: "changed.txt", op: "conflict", reason: "conflict" },
      { path: "only-local.txt", op: "upload", reason: "new" },
      { path: "only-remote.txt", op: "download", reason: "new" },
    ]);
  });

  it("honours exclude patterns on both sides", () => {
    const l = [h(".git/cfg", "1"), h("keep.txt", "2")];
    const r = [h("keep.txt", "3")];
    const plan = diffTrees(l, r, "push", [".git"], false);
    expect(plan).toEqual([{ path: "keep.txt", op: "upload", reason: "changed" }]);
  });
});

describe("applicable / summarize", () => {
  it("drops conflicts from the apply set", () => {
    const plan = diffTrees(
      [h("a", "1"), h("b", "2")],
      [h("a", "9"), h("b", "8")],
      "bi",
      [],
      false,
    );
    expect(applicable(plan)).toHaveLength(0); // both are conflicts
  });

  it("counts ops", () => {
    const s = summarize([
      { path: "a", op: "upload", reason: "new" },
      { path: "b", op: "upload", reason: "changed" },
      { path: "c", op: "conflict", reason: "conflict" },
    ]);
    expect(s.upload).toBe(2);
    expect(s.conflict).toBe(1);
    expect(s.download).toBe(0);
  });
});
