import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_ORDER, builtinId, builtinRecipes, recipeMatches, userRecipes } from "./recipelib";
import { recipeScript } from "./recipe";

describe("the built-in recipes", () => {
  const all = builtinRecipes();

  it("are all there, in order, and every one reads as a recipe", () => {
    expect(all.map((r) => r.file)).toEqual(BUILTIN_ORDER.map((n) => `${n}.sh`));
    for (const r of all) {
      expect(r.error, r.file).toBeNull();
      expect(r.meta?.name, r.file).toBeTruthy();
      expect(builtinId(r)).toBe(r.file.replace(/\.sh$/, ""));
    }
  });

  it("each checks before it applies, ends on the line that picks the mode, and needs root", () => {
    for (const r of all) {
      expect(r.meta?.check, r.file).toBe(true);
      expect(r.meta?.sudo, r.file).toBe(true);
      expect(r.text, r.file).toMatch(/^check\(\) \{/m);
      expect(r.text, r.file).toMatch(/^apply\(\) \{/m);
      expect(r.text.trimEnd().split("\n").pop(), r.file).toBe('case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac');
    }
  });

  // The shell itself reads every recipe — with its parameters exported, as a server would get it.
  it.skipIf(process.platform === "win32")("are valid sh, as a server runs them", () => {
    const dir = mkdtempSync(join(tmpdir(), "vterm-recipes-"));
    try {
      for (const r of all) {
        const file = join(dir, r.file);
        writeFileSync(file, recipeScript(r.text, r.meta!, {}, "check"));
        expect(() => execFileSync("sh", ["-n", file]), r.file).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the user's recipes", () => {
  it("are the app's own folder's or a source's, with or without a header", () => {
    const scan = {
      dir: "/data/scripts",
      files: [
        { path: "/data/scripts/a.sh", dir: "/data/scripts", name: "a.sh", text: "# vterm:\n#   name: A\n" },
        { path: "/repo/b.sh", dir: "/repo", name: "b.sh", text: "echo plain\n" },
      ],
    };
    const [a, b] = userRecipes(scan);
    expect([a.origin, a.id, a.meta?.name]).toEqual(["own", "/data/scripts/a.sh", "A"]);
    expect([b.origin, b.meta, b.error]).toEqual(["source", null, "no # vterm: header"]);
    expect(builtinId(a)).toBeNull();
  });

  it("are found by name, description or file", () => {
    const [r] = builtinRecipes();
    expect(recipeMatches(r, "Docker ставит", "движок", "")).toBe(true);
    expect(recipeMatches(r, "Docker ставит", "движок", "ДВИЖ")).toBe(true);
    expect(recipeMatches(r, "x", "y", "install-docker")).toBe(true);
    expect(recipeMatches(r, "x", "y", "nginx")).toBe(false);
  });
});
