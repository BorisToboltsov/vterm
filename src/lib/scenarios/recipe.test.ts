import { describe, expect, it } from "vitest";
import {
  asRecipe,
  checkVerdict,
  freeFileName,
  headerValue,
  parseRecipe,
  playbookFileName,
  playbookTemplate,
  recipeFileName,
  recipeScript,
  recipeTemplate,
  shQuote,
  summaryLine,
  valuesProblem,
} from "./recipe";

const RECIPE = `#!/bin/sh
# Installs things.
# vterm:
#   name: "Install, then start"
#   description: A thing
#   os: [debian, Ubuntu]
#   sudo: yes
#   check: true
#   future: kept
#   params:
#     USER_NAME: { label: "Name, full", default: deploy, required: true, hint: who }
#     FLAG: { label: Flag, type: bool, default: true }
#     TOKEN: { label: Token, type: secret, default: leaked }
#     PLAIN:
set -eu
echo "$USER_NAME"
`;

describe("a recipe's header", () => {
  it("reads every key, the parameters in order, and ignores what it does not know", () => {
    const r = parseRecipe(RECIPE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toMatchObject({ name: "Install, then start", description: "A thing", os: ["debian", "ubuntu"], sudo: true, check: true });
    expect(r.meta.params.map((p) => [p.name, p.label, p.type, p.default, p.required, p.hint])).toEqual([
      ["USER_NAME", "Name, full", "text", "deploy", true, "who"],
      ["FLAG", "Flag", "bool", "true", false, ""],
      // A secret never has a default: a value written into a file is no secret.
      ["TOKEN", "Token", "secret", "", false, ""],
      ["PLAIN", "PLAIN", "text", "", false, ""],
    ]);
  });

  it("a script without a header, or with a broken one, is not a recipe", () => {
    expect(parseRecipe("#!/bin/sh\necho hi\n")).toEqual({ ok: false, error: "no # vterm: header" });
    expect(parseRecipe("echo first\n# vterm:\n#   name: x\n").ok).toBe(false);
    expect(parseRecipe("# vterm:\n#   description: no name\n")).toEqual({ ok: false, error: "the header has no name" });
    expect(parseRecipe("# vterm:\n#   name: x\n#   params:\n#     lower: {}\n").ok).toBe(false);
    expect(parseRecipe("# vterm:\n#   name: x\n#   params:\n#     PATH: {}\n").ok).toBe(false);
    expect(parseRecipe("# vterm:\n#   name: x\n#   params:\n#     A: {}\n#     A: {}\n").ok).toBe(false);
    expect(parseRecipe("# vterm:\n#   name: x\n#   params:\n#     A: label\n").ok).toBe(false);
    expect(parseRecipe("# vterm:\n#   name: x\n#   just words\n").ok).toBe(false);
    expect(parseRecipe("# vterm:\n").ok).toBe(false);
  });

  it("reads CRLF files and a header after blank lines", () => {
    const r = parseRecipe("\r\n# vterm:\r\n#   name: crlf\r\n#   os: linux\r\n");
    expect(r.ok && r.meta.name).toBe("crlf");
    expect(r.ok && r.meta.os).toEqual(["linux"]);
  });
});

describe("what a server runs", () => {
  it("exports the values quoted for the shell, then the recipe as it is", () => {
    const r = parseRecipe(RECIPE);
    if (!r.ok) throw new Error(r.error);
    const script = recipeScript(RECIPE, r.meta, { USER_NAME: "o'neil; rm -rf /", FLAG: "false", TOKEN: "s3" }, "check");
    expect(script.split("\n").slice(0, 7)).toEqual([
      "# vterm: the parameters of this run",
      "export VTERM_MODE='check'",
      "export DEBIAN_FRONTEND='noninteractive'",
      `export USER_NAME='o'\\''neil; rm -rf /'`,
      "export FLAG='false'",
      "export TOKEN='s3'",
      "export PLAIN=''",
    ]);
    expect(script.endsWith(RECIPE)).toBe(true);
    // A switch is only ever true or false.
    expect(recipeScript(RECIPE, r.meta, { FLAG: "yes; id" }, "apply")).toContain("export FLAG='false'");
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it("refuses an empty required value and a secret with a line break", () => {
    const r = parseRecipe(RECIPE);
    if (!r.ok) throw new Error(r.error);
    expect(valuesProblem(r.meta, { USER_NAME: "  " })).toEqual({ param: "USER_NAME", why: "required" });
    expect(valuesProblem(r.meta, { TOKEN: "a\nb" })).toEqual({ param: "TOKEN", why: "newline" });
    expect(valuesProblem(r.meta, {})).toBeNull();
  });

  it("reads a check's exit and the line that tells the answer", () => {
    expect([0, 1, 2, 127, -1].map(checkVerdict)).toEqual(["same", "change", "error", "error", "error"]);
    expect(summaryLine("first\n\x1b[32mlast\x1b[0m\n\n", "err")).toBe("last");
    expect(summaryLine("", "boom\n")).toBe("boom");
    expect(summaryLine("x".repeat(300), "", 10)).toBe(`${"x".repeat(9)}…`);
    expect(summaryLine("", "")).toBe("");
  });
});

describe("files of the library", () => {
  it("names a recipe file from its name and finds a free one", () => {
    expect(recipeFileName("  Install Docker!  ")).toBe("install-docker.sh");
    expect(recipeFileName("Установить nginx")).toBe("установить-nginx.sh");
    expect(recipeFileName("***")).toBe("recipe.sh");
    expect(freeFileName("a.sh", [])).toBe("a.sh");
    expect(freeFileName("a.sh", ["a.sh", "a-2.sh"])).toBe("a-3.sh");
    expect(playbookFileName("Nginx с TLS")).toBe("nginx-с-tls.yml");
    expect(playbookFileName("***")).toBe("playbook.yml");
    expect(freeFileName("web.yml", ["web.yml"])).toBe("web-2.yml");
  });

  it("a value is written so the header reads it back as it was", () => {
    for (const v of ["plain words", "10m, 1h, 1d", "127.0.0.1:9100", "Docker's repo", 'say "hi"', "a'b\"c", " padded ", "{x}", "#tag"]) {
      const r = parseRecipe(`# vterm:\n#   name: N\n#   params:\n#     P: { label: ${headerValue(v)}, hint: ${headerValue(v)} }\n#   description: ${headerValue(v)}\n`);
      const want = v.includes('"') && v.includes("'") ? v.replace(/"/g, "'") : v;
      expect(r.ok && [r.meta.description, r.meta.params[0].label, r.meta.params[0].hint], v).toEqual([want, want, want]);
    }
    expect(headerValue("plain")).toBe("plain");
  });

  it("the playbook template is a playbook named as asked", () => {
    const text = playbookTemplate('Web "front"', "Serves it");
    expect(text.split("\n").slice(0, 3)).toEqual(["# Serves it", '- name: "Web \\"front\\""', "  hosts: all"]);
  });

  it("the template is a recipe that checks", () => {
    const r = parseRecipe(recipeTemplate("Mine", "Does mine"));
    expect(r.ok && r.meta).toMatchObject({ name: "Mine", description: "Does mine", check: true, sudo: true });
  });

  it("a script made elsewhere becomes a recipe that applies its body; a recipe stays as it is", () => {
    const made = asRecipe("#!/bin/bash\napt-get update\n\nsystemctl restart nginx\n", "Restart\nnginx", "From a recording");
    const r = parseRecipe(made);
    expect(r.ok && r.meta.name).toBe("Restart nginx");
    expect(made).toContain("apply() {\n  apt-get update\n\n  systemctl restart nginx\n}");
    expect(made).not.toContain("#!/bin/bash");
    expect(asRecipe(RECIPE, "x", "y")).toBe(RECIPE);
  });
});
