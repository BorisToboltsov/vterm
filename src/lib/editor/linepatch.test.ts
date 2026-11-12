import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyHunks, changeView, diffLines, hunksOf, linesOf, type Op } from "./linepatch";

/** Replay an edit script: the old lines it keeps and removes give `a`, kept and added give `b`. */
const sides = (ops: Op[]) => ({
  a: ops.filter((o) => o.kind !== "+").map((o) => o.line),
  b: ops.filter((o) => o.kind !== "-").map((o) => o.line),
});

describe("the line diff", () => {
  it("is an edit from the old lines to the new ones, and the shortest one", () => {
    const ops = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
    expect(ops).not.toBeNull();
    expect(sides(ops!)).toEqual({ a: ["a", "b", "c", "d"], b: ["a", "x", "c", "d", "e"] });
    expect(ops!.filter((o) => o.kind !== "=")).toHaveLength(3);
  });

  it("holds for any two texts: replaying it gives both back", () => {
    const line = fc.constantFrom("a", "b", "c", "}", "");
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), fc.array(line, { maxLength: 30 }), (a, b) => {
        const ops = diffLines(a, b);
        expect(ops).not.toBeNull();
        expect(sides(ops!)).toEqual({ a, b });
      }),
    );
  });

  it("gives up past its limit rather than take forever", () => {
    expect(diffLines(["a", "b", "c"], ["x", "y", "z"], 2)).toBeNull();
  });
});

const NGINX = ["upstream app {", "    server 10.0.0.11:8080;", "}", "", "server {", "    listen 80;", "}", ""].join("\n");
const EDITED = NGINX.replace("    listen 80;", "    listen 80;\n    listen 443 ssl;");

describe("carrying an edit to another copy", () => {
  it("lands where it stood when the copy is the same", () => {
    const res = applyHunks(NGINX, hunksOf(NGINX, EDITED)!);
    expect(res).toEqual({ outcome: "clean", text: EDITED, fates: ["clean"] });
  });

  it("lands where its context is, when lines above it differ", () => {
    const other = NGINX.replace("    server 10.0.0.11:8080;", "    server 10.0.0.12:8080;\n    server 10.0.0.13:8080;");
    const res = applyHunks(other, hunksOf(NGINX, EDITED)!);
    expect(res.outcome).toBe("offset");
    expect(res.text).toBe(other.replace("    listen 80;", "    listen 80;\n    listen 443 ssl;"));
  });

  it("lands with part of its context when a neighbour differs, and says so", () => {
    const other = NGINX.replace("server {", "server { # api");
    const res = applyHunks(other, hunksOf(NGINX, EDITED)!);
    expect(res.outcome).toBe("fuzzy");
    expect(res.text).toContain("    listen 80;\n    listen 443 ssl;\n}");
  });

  it("adds lines added at the end to the end of a copy whose end differs", () => {
    const base = "a\nb\nc\n";
    const res = applyHunks("x\ny\nz\n", hunksOf(base, "a\nb\nc\ninclude extra;\n")!);
    expect(res).toEqual({ outcome: "fuzzy", text: "x\ny\nz\ninclude extra;\n", fates: ["edge"] });
  });

  it("does not add twice what the copy has already", () => {
    expect(applyHunks(EDITED, hunksOf(NGINX, EDITED)!).outcome).toBe("already");
    const appended = hunksOf("a\nb\nc\n", "a\nb\nc\ninclude extra;\n")!;
    expect(applyHunks("x\ny\ninclude extra;\n", appended)).toEqual({
      outcome: "already",
      text: "x\ny\ninclude extra;\n",
      fates: ["already"],
    });
  });

  it("writes nothing when one piece finds no place", () => {
    const base = Array.from({ length: 16 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const edited = base.replace("line 1\n", "LINE 1\n").replace("line 13", "LINE 13");
    const res = applyHunks(base.replace("line 13", "thirteen"), hunksOf(base, edited)!);
    expect(res).toEqual({ outcome: "conflict", text: null, fates: ["clean", "conflict"] });
  });

  it("carries a removal, and a file without a final newline", () => {
    const res = applyHunks("a\nb\nc", hunksOf("a\nb\nc", "a\nc")!);
    expect(res.text).toBe("a\nc");
  });

  it("on the same copy, always gives the edited text", () => {
    const line = fc.constantFrom("a", "b", "c", "}", "");
    fc.assert(
      fc.property(fc.array(line, { maxLength: 25 }), fc.array(line, { maxLength: 25 }), (a, b) => {
        const before = a.join("\n");
        const after = b.join("\n");
        const hunks = hunksOf(before, after)!;
        const res = applyHunks(before, hunks);
        if (before === after) expect(hunks).toEqual([]);
        else if (res.outcome !== "already") expect(res.text).toBe(after);
      }),
    );
  });
});

describe("the preview of a change", () => {
  it("shows the changed lines with a little context and folds the rest", () => {
    const before = linesOf("1\n2\n3\n4\n5\n6\n7\n8\n9").join("\n");
    const after = before.replace("2", "two").replace("8", "eight");
    expect(changeView(before, after, 1)).toEqual([
      { kind: "=", text: "1" },
      { kind: "-", text: "2" },
      { kind: "+", text: "two" },
      { kind: "=", text: "3" },
      { kind: "gap", text: "" },
      { kind: "=", text: "7" },
      { kind: "-", text: "8" },
      { kind: "+", text: "eight" },
      { kind: "=", text: "9" },
    ]);
  });
});
