import { describe, expect, it } from "vitest";
import { detectIndent, indentString, languageIndent, reindent, resolveIndent } from "./indent";

describe("detectIndent", () => {
  it("reads the step, not the depth", () => {
    const py = "def f():\n    if x:\n        return 1\n    return 2\n";
    expect(detectIndent(py)).toEqual({ tabs: false, width: 4 });
    const yaml = "a:\n  b:\n    c:\n      d: 1\n  e: 2\n";
    expect(detectIndent(yaml)).toEqual({ tabs: false, width: 2 });
  });

  it("prefers tabs when most indented lines start with one", () => {
    expect(detectIndent("all:\n\tgo build\n\tgo test\n")).toEqual({ tabs: true, width: 4 });
  });

  it("says nothing about a file that does not indent", () => {
    expect(detectIndent("a=1\nb=2\n")).toBeNull();
    expect(detectIndent("")).toBeNull();
  });

  it("is not fooled by block-comment stars", () => {
    const c = "/**\n * doc\n * more\n */\nint f() {\n    return 1;\n}\n";
    expect(detectIndent(c)).toEqual({ tabs: false, width: 4 });
  });
});

describe("languageIndent and resolveIndent", () => {
  it("follows the language's custom", () => {
    expect(languageIndent("go", "main.go")).toEqual({ tabs: true, width: 4 });
    expect(languageIndent("python", "x.py")).toEqual({ tabs: false, width: 4 });
    expect(languageIndent("plain", "Makefile")).toEqual({ tabs: true, width: 4 });
    expect(languageIndent("yaml", "a.yml")).toEqual({ tabs: false, width: 2 });
  });

  it("lets .editorconfig win, then the file, then the language", () => {
    const text = "a:\n  b: 1\n";
    expect(resolveIndent(text, "yaml", "a.yml", { tabs: false, width: 4 })).toEqual({
      info: { tabs: false, width: 4 },
      source: "editorconfig",
    });
    expect(resolveIndent(text, "yaml", "a.yml", {})).toEqual({ info: { tabs: false, width: 2 }, source: "file" });
    expect(resolveIndent("", "python", "x.py", {})).toEqual({ info: { tabs: false, width: 4 }, source: "language" });
    expect(resolveIndent("", "python", "x.py", { width: 2 })).toEqual({ info: { tabs: false, width: 2 }, source: "editorconfig" });
  });

  it("gives the string of one level", () => {
    expect(indentString({ tabs: true, width: 8 })).toBe("\t");
    expect(indentString({ tabs: false, width: 3 })).toBe("   ");
  });
});

describe("reindent", () => {
  it("rewrites levels and keeps alignment below a level", () => {
    const text = "a:\n  b:\n    c: 1\n   d\n";
    expect(reindent(text, { tabs: false, width: 2 }, { tabs: false, width: 4 })).toBe("a:\n    b:\n        c: 1\n     d\n");
    expect(reindent("x\n\ty\n\t\tz\n", { tabs: true, width: 4 }, { tabs: false, width: 2 })).toBe("x\n  y\n    z\n");
  });

  it("leaves the text alone when nothing changes", () => {
    const text = "a\n  b\n";
    expect(reindent(text, { tabs: false, width: 2 }, { tabs: false, width: 2 })).toBe(text);
  });
});
