import { describe, expect, it } from "vitest";
import {
  FORMATTERS,
  changedLines,
  fixerFor,
  formatArgv,
  formatJson,
  formatOrder,
  formatResult,
  formatWhitespace,
  formattersFor,
  minimalChange,
  runBuiltin,
  type FormatTarget,
} from "./format";

const T: FormatTarget = { name: "app.py", path: "/srv/app/app.py", indent: { tabs: false, width: 4 } };

describe("chains", () => {
  it("offers the project's tools first and whitespace last", () => {
    expect(formattersFor("python").map((f) => f.id)).toEqual(["ruff", "black", "whitespace"]);
    expect(formattersFor("hcl").map((f) => f.id)).toEqual(["terraform", "tofu", "whitespace"]);
    expect(formattersFor("ansible").map((f) => f.id)).toEqual(["yamlfmt", "prettier", "whitespace"]);
    expect(formattersFor("nginx").map((f) => f.id)).toEqual(["whitespace"]);
  });

  it("never offers ansible-lint --fix as formatting — it is the fixer", () => {
    for (const kind of ["ansible", "yaml", "python"] as const) {
      expect(formattersFor(kind).some((f) => f.fixer)).toBe(false);
    }
    expect(fixerFor("ansible")?.id).toBe("ansible-lint");
    expect(fixerFor("yaml")).toBeNull();
  });

  it("puts the picked tool first when it is still on the list", () => {
    expect(formatOrder("python", "black").map((f) => f.id)).toEqual(["black", "ruff", "whitespace"]);
    expect(formatOrder("python", "gofmt").map((f) => f.id)).toEqual(["ruff", "black", "whitespace"]);
  });

  it("builds stdin argv for each tool", () => {
    const by = (id: string) => FORMATTERS.find((f) => f.id === id)!;
    expect(formatArgv(by("ruff"), T)).toEqual(["ruff", "format", "--stdin-filename", "app.py", "-"]);
    expect(formatArgv(by("terraform"), T)).toEqual(["terraform", "fmt", "-"]);
    expect(formatArgv(by("rustfmt"), { ...T, edition: "2024" })).toEqual(["rustfmt", "--emit", "stdout", "--edition", "2024"]);
    expect(formatArgv(by("rustfmt"), { ...T, edition: "2077" })).toEqual(["rustfmt", "--emit", "stdout", "--edition", "2021"]);
    expect(formatArgv(by("prettier"), T)).toEqual(["prettier", "--stdin-filepath", "/srv/app/app.py"]);
    expect(formatArgv(by("clang-format"), T)).toEqual(["clang-format", "--assume-filename=app.py"]);
    expect(formatArgv(by("json"), T)).toBeNull();
  });
});

describe("formatWhitespace", () => {
  it("drops trailing spaces, evens the indent, ends with one newline", () => {
    expect(formatWhitespace("a:   \n\tb: 1\n\n\n", { indent: { tabs: false, width: 2 } })).toBe("a:\n  b: 1\n");
    expect(formatWhitespace("x\n    y", { indent: { tabs: true, width: 4 } })).toBe("x\n\ty\n");
    expect(formatWhitespace("x", { indent: { tabs: false, width: 2 }, finalNewline: false })).toBe("x");
    expect(formatWhitespace("", { indent: { tabs: false, width: 2 } })).toBe("");
  });
});

describe("formatJson", () => {
  it("lays JSON out with the file's indent, values and key order verbatim", () => {
    const src = '{"b":1,"a":[1,2,{"x":12345678901234567890}],"2":"y","1":true,"e":{},"f":[]}';
    expect(formatJson(src, { indent: { tabs: false, width: 2 } })).toBe(
      '{\n  "b": 1,\n  "a": [\n    1,\n    2,\n    {\n      "x": 12345678901234567890\n    }\n  ],\n  "2": "y",\n  "1": true,\n  "e": {},\n  "f": []\n}\n',
    );
  });

  it("keeps escapes inside strings and refuses what is not JSON", () => {
    expect(formatJson('["a\\"b,c"]', { indent: { tabs: true, width: 4 }, finalNewline: false })).toBe('[\n\t"a\\"b,c"\n]');
    expect(() => formatJson("{a:1}", { indent: T.indent })).toThrow();
    expect(() => formatJson("[1,]", { indent: T.indent })).toThrow();
    expect(() => formatJson("[1] 2", { indent: T.indent })).toThrow();
    expect(() => formatJson('"open', { indent: T.indent })).toThrow();
  });

  it("is what runBuiltin runs for json", () => {
    expect(runBuiltin("json", "[1]", T)).toBe("[\n    1\n]\n");
    expect(runBuiltin("whitespace", "a  ", T)).toBe("a\n");
  });
});

describe("changes", () => {
  it("counts the lines that differ", () => {
    expect(changedLines("a\nb\nc", "a\nb\nc")).toBe(0);
    expect(changedLines("a\nb\nc", "a\nB\nc")).toBe(1);
    expect(changedLines("a\nb\nc", "a\nb\nx\nc")).toBe(1);
    expect(changedLines("import os,sys\nx", "import os\nimport sys\nx")).toBe(2);
  });

  it("finds the one change that turns a text into another", () => {
    expect(minimalChange("abc", "abc")).toBeNull();
    expect(minimalChange("a = 1\nb=2\n", "a = 1\nb = 2\n")).toEqual({ from: 7, to: 8, insert: " = " });
  });

  it("reads a run: output, an error, or the fixer's file", () => {
    const f = FORMATTERS.find((x) => x.id === "ruff")!;
    expect(formatResult(f, { found: true, stdout: "x\n", stderr: "", code: 0 })).toEqual({ text: "x\n" });
    expect(formatResult(f, { found: true, stdout: "", stderr: "error: cannot parse\nline 3", code: 2 })).toEqual({
      error: "error: cannot parse\nline 3",
    });
    const fix = FORMATTERS.find((x) => x.id === "ansible-lint")!;
    expect(formatResult(fix, { found: true, stdout: "- hosts: all\n", stderr: "2 violations", code: 2 })).toEqual({ text: "- hosts: all\n" });
  });
});
