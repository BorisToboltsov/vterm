import { describe, expect, it } from "vitest";
import { editorconfigDir, editorconfigPaths, globRegex, parseEditorConfig, resolveEditorConfig } from "./editorconfig";

describe("editorconfigPaths", () => {
  it("walks up from the file's folder", () => {
    expect(editorconfigPaths("/srv/app/src/main.py")).toEqual([
      "/srv/app/src/.editorconfig",
      "/srv/app/.editorconfig",
      "/srv/.editorconfig",
      "/.editorconfig",
    ]);
  });

  it("keeps a Windows path's separators and stops at the drive", () => {
    expect(editorconfigPaths("C:\\work\\app\\x.ts")).toEqual([
      "C:\\work\\app\\.editorconfig",
      "C:\\work\\.editorconfig",
      "C:\\.editorconfig",
    ]);
  });

  it("gives the folder of a found file", () => {
    expect(editorconfigDir("/srv/app/.editorconfig")).toBe("/srv/app");
    expect(editorconfigDir("/.editorconfig")).toBe("/");
  });
});

describe("globRegex", () => {
  const m = (glob: string, path: string) => globRegex(glob).test(path);
  it("matches a name in any folder when the glob has no slash", () => {
    expect(m("*.py", "a.py")).toBe(true);
    expect(m("*.py", "src/pkg/a.py")).toBe(true);
    expect(m("*.py", "a.pyc")).toBe(false);
    expect(m("Makefile", "sub/Makefile")).toBe(true);
  });

  it("anchors a glob with a slash to the file's folder", () => {
    expect(m("src/*.ts", "src/a.ts")).toBe(true);
    expect(m("src/*.ts", "src/x/a.ts")).toBe(false);
    expect(m("src/**.ts", "src/x/a.ts")).toBe(true);
    expect(m("/lib/**/*.js", "lib/a/b/c.js")).toBe(true);
  });

  it("knows braces, ranges, classes and ?", () => {
    expect(m("*.{yml,yaml}", "a.yaml")).toBe(true);
    expect(m("*.{yml,yaml}", "a.json")).toBe(false);
    expect(m("file{1..3}.txt", "file2.txt")).toBe(true);
    expect(m("file{1..3}.txt", "file4.txt")).toBe(false);
    expect(m("[ab].c", "a.c")).toBe(true);
    expect(m("[!ab].c", "a.c")).toBe(false);
    expect(m("?.c", "x.c")).toBe(true);
  });

  it("escapes what a regular expression would read", () => {
    expect(m("a+b.(x)", "a+b.(x)")).toBe(true);
    expect(m("a+b.(x)", "aab.(x)")).toBe(false);
  });
});

describe("resolveEditorConfig", () => {
  const root = parseEditorConfig(
    "root = true\n\n[*]\nindent_style = space\nindent_size = 2\ntrim_trailing_whitespace = true\n\n[*.py]\nindent_size = 4\n\n[Makefile]\nindent_style = tab\n",
  );
  const sub = parseEditorConfig("[*.py]\nindent_size = 8\ninsert_final_newline = false\n");

  it("lets the nearer file override and stops at root", () => {
    const outer = parseEditorConfig("[*]\nindent_style = tab\n");
    const props = resolveEditorConfig("/srv/app/legacy/x.py", [
      { dir: "/srv/app/legacy", parsed: sub },
      { dir: "/srv/app", parsed: root },
      { dir: "/srv", parsed: outer },
    ]);
    expect(props).toEqual({ tabs: false, width: 8, trimTrailing: true, finalNewline: false });
  });

  it("reads tab style and size = tab", () => {
    expect(resolveEditorConfig("/srv/app/Makefile", [{ dir: "/srv/app", parsed: root }])).toMatchObject({ tabs: true, width: 2 });
    const tw = parseEditorConfig("[*.go]\nindent_style = tab\nindent_size = tab\ntab_width = 8\n");
    expect(resolveEditorConfig("/x/main.go", [{ dir: "/x", parsed: tw }])).toEqual({ tabs: true, width: 8 });
  });

  it("ignores comments, junk and out-of-range sizes", () => {
    const p = parseEditorConfig("# c\n; c\n[*]\nnonsense\nindent_size = 99\nend_of_line = crlf\n");
    expect(resolveEditorConfig("/a/b", [{ dir: "/a", parsed: p }])).toEqual({ eol: "crlf" });
  });

  it("works on Windows paths", () => {
    expect(resolveEditorConfig("C:\\w\\a.py", [{ dir: "C:\\w", parsed: root }])).toMatchObject({ width: 4 });
  });
});
