import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolve, type MessageKey } from "../i18n";
import { loadYaml, parseYaml, type Yaml } from "../pipeline/yamldoc";
import { readPlaybook } from "./ansibleplay";
import { parseRecipe, recipeScript } from "./recipe";
import {
  foundProjects,
  itemDescription,
  itemMatches,
  itemName,
  libraryItems,
  libraryRecipe,
  playbookDescription,
  restorePlan,
  seedPlan,
  shippedIn,
  shippedText,
  SHIPPED_FILES,
  SHIPPED_PLAYBOOKS,
  SHIPPED_RECIPES,
  textHash,
  type LibraryPlaybook,
  type Translate,
  type YamlRead,
} from "./recipelib";

const tr =
  (lang: "en" | "ru"): Translate =>
  (k) =>
    resolve(lang, k as MessageKey);
const trIn = (lang: string) => tr(lang === "ru" ? "ru" : "en");

let Y: Yaml;
let readYaml: (text: string) => YamlRead;
beforeAll(async () => {
  Y = await loadYaml();
  readYaml = (text) => {
    const doc = parseYaml(Y, text);
    return { value: doc.value, error: doc.error ? doc.error.message : null };
  };
});

/** The lines of a script after its header — what localizing must leave alone. */
const body = (text: string) => text.split("\n").filter((l) => !l.startsWith("#"));

describe("what ships with the app", () => {
  it("is every recipe and playbook, in order, each one in the build", () => {
    expect(SHIPPED_FILES).toEqual([...SHIPPED_RECIPES.map((n) => `${n}.sh`), ...SHIPPED_PLAYBOOKS.map((n) => `${n}.yml`)]);
    for (const f of SHIPPED_FILES) expect(shippedText(f), f).not.toBe("");
  });

  it("each recipe checks before it applies, ends on the line that picks the mode, and needs root", () => {
    for (const n of SHIPPED_RECIPES) {
      const text = shippedText(`${n}.sh`);
      const parsed = parseRecipe(text);
      expect(parsed.ok, n).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.meta.check, n).toBe(true);
      expect(parsed.meta.sudo, n).toBe(true);
      expect(text, n).toMatch(/^check\(\) \{/m);
      expect(text, n).toMatch(/^apply\(\) \{/m);
      expect(text.trimEnd().split("\n").pop(), n).toBe('case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac');
    }
  });

  it("each playbook is YAML of plays, says what it does at its top, and is named by its play", () => {
    for (const n of SHIPPED_PLAYBOOKS) {
      const text = shippedText(`${n}.yml`);
      const read = readYaml(text);
      expect(read.error, n).toBeNull();
      const book = readPlaybook(read.value);
      expect(book?.plays.length, n).toBeGreaterThan(0);
      expect(playbookDescription(text), n).not.toBe("");
      expect(text, n).toMatch(/^- name: /m);
    }
  });

  it.each(["en", "ru"] as const)("is written in %s: the header and the play name from the dictionary, the code as it is", (lang) => {
    for (const n of SHIPPED_RECIPES) {
      const file = `${n}.sh`;
      const text = shippedIn(file, tr(lang));
      const parsed = parseRecipe(text);
      expect(parsed.ok, `${lang} ${file}`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.meta.name).toBe(resolve(lang, `scenarios.builtin.${n}.name` as MessageKey));
      expect(parsed.meta.description).toBe(resolve(lang, `scenarios.builtin.${n}.desc` as MessageKey));
      const raw = parseRecipe(shippedText(file));
      if (!raw.ok) throw new Error(file);
      for (const [i, p] of parsed.meta.params.entries()) {
        expect(p.label).toBe(resolve(lang, `scenarios.builtin.${n}.${p.name}` as MessageKey));
        if (raw.meta.params[i].hint) expect(p.hint).toBe(resolve(lang, `scenarios.builtin.${n}.${p.name}.hint` as MessageKey));
        // What the run is given stays the build's.
        expect([p.name, p.type, p.default, p.required]).toEqual([raw.meta.params[i].name, raw.meta.params[i].type, raw.meta.params[i].default, raw.meta.params[i].required]);
      }
      expect(body(text)).toEqual(body(shippedText(file)));
    }
    for (const n of SHIPPED_PLAYBOOKS) {
      const text = shippedIn(`${n}.yml`, tr(lang));
      const read = readYaml(text);
      expect(read.error, `${lang} ${n}`).toBeNull();
      const item = libraryItems({ dir: "/m", files: [{ path: `/m/${n}.yml`, dir: "/m", name: `${n}.yml`, text }] }, readYaml).items[0];
      expect(itemName(item)).toBe(resolve(lang, `scenarios.starter.${n}.name` as MessageKey));
      expect(itemDescription(item)).toBe(resolve(lang, `scenarios.starter.${n}.desc` as MessageKey));
      expect(text.split("\n").slice(2)).toEqual(shippedText(`${n}.yml`).split("\n").slice(2));
    }
  });

  // The shell itself reads every recipe — written in Russian, with its parameters exported, as a server gets it.
  it.skipIf(process.platform === "win32")("are valid sh, as a server runs them", () => {
    const dir = mkdtempSync(join(tmpdir(), "vterm-recipes-"));
    try {
      for (const n of SHIPPED_RECIPES) {
        const text = shippedIn(`${n}.sh`, tr("ru"));
        const parsed = parseRecipe(text);
        if (!parsed.ok) throw new Error(n);
        const file = join(dir, `${n}.sh`);
        writeFileSync(file, recipeScript(text, parsed.meta, {}, "check"));
        expect(() => execFileSync("sh", ["-n", file]), n).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writing the shipped ones into «Mine»", () => {
  const ru = (f: string) => shippedIn(f, tr("ru"));
  const docker = "install-docker.sh";

  it("writes each once, in the reader's language, and remembers what it wrote", () => {
    const plan = seedPlan(new Map(), {}, "ru", trIn);
    expect(plan.writes.map((w) => w.file)).toEqual(SHIPPED_FILES);
    expect(plan.writes.every((w) => !w.replace)).toBe(true);
    expect(plan.writes[0].text).toBe(ru(docker));
    expect(plan.seeded[docker]).toEqual({ hash: textHash(ru(docker)), lang: "ru" });
    // Written: nothing more to do.
    const present = new Map(plan.writes.map((w) => [w.file, w.text]));
    expect(seedPlan(present, plan.seeded, "ru", trIn).writes).toEqual([]);
  });

  it("a file the user changed, renamed or deleted is never written again", () => {
    const seeded = seedPlan(new Map(), {}, "ru", trIn).seeded;
    const present = new Map(SHIPPED_FILES.map((f) => [f, ru(f)]));
    present.set(docker, `${ru(docker)}\n# mine now\n`);
    present.delete("swap-file.sh");
    const plan = seedPlan(present, seeded, "ru", trIn);
    expect(plan.writes).toEqual([]);
    expect(plan.seeded).toEqual(seeded);
  });

  it("a file still as written is written anew when a later build changed it — in the language it was written in", () => {
    const old = "#!/bin/sh\n# vterm:\n#   name: Old Docker\necho old\n";
    const seeded = { [docker]: { hash: textHash(old), lang: "ru" } };
    const present = new Map([[docker, old]]);
    const plan = seedPlan(present, seeded, "en", trIn);
    expect(plan.writes.find((w) => w.file === docker)).toEqual({ file: docker, text: ru(docker), replace: true });
    expect(plan.seeded[docker]).toEqual({ hash: textHash(ru(docker)), lang: "ru" });
  });

  it("a name the user already had is theirs; an untouched copy of the build's text is the app's", () => {
    const present = new Map([
      [docker, "#!/bin/sh\necho my own docker\n"],
      ["swap-file.sh", shippedText("swap-file.sh")],
    ]);
    const plan = seedPlan(present, {}, "ru", trIn);
    expect(plan.writes.find((w) => w.file === docker)).toBeUndefined();
    expect(plan.seeded[docker]).toEqual({ hash: "", lang: "ru" });
    expect(plan.writes.find((w) => w.file === "swap-file.sh")).toEqual({ file: "swap-file.sh", text: ru("swap-file.sh"), replace: true });
    // Theirs stays theirs, whatever comes later.
    expect(seedPlan(present, plan.seeded, "ru", trIn).writes.find((w) => w.file === docker)).toBeUndefined();
  });

  it("brings back only what «Mine» lacks, in the reader's language now", () => {
    const seeded = seedPlan(new Map(), {}, "ru", trIn).seeded;
    const present = new Map(SHIPPED_FILES.filter((f) => f !== "cleanup-disk.sh").map((f) => [f, "changed"]));
    const plan = restorePlan(present, seeded, "en", tr("en"));
    expect(plan.writes).toEqual([{ file: "cleanup-disk.sh", text: shippedIn("cleanup-disk.sh", tr("en")), replace: false }]);
    expect(plan.seeded["cleanup-disk.sh"].lang).toBe("en");
    expect(restorePlan(new Map(SHIPPED_FILES.map((f) => [f, "x"])), seeded, "en", tr("en")).writes).toEqual([]);
  });

  it("tells one text from another", () => {
    expect(textHash("a")).toBe(textHash("a"));
    expect(textHash("a")).not.toBe(textHash("b"));
    expect(textHash("")).not.toBe("");
  });
});

describe("the user's files", () => {
  const scan = (files: [string, string, string][], folders: { path: string; source: string; entries: { name: string; isDir: boolean }[] }[] = []) => ({
    dir: "/data/scripts",
    files: files.map(([dir, name, text]) => ({ path: `${dir}/${name}`, dir, name, text })),
    folders,
  });

  it("are recipes and playbooks of «Mine» or a folder; YAML that is something else is counted, not shown", () => {
    const out = libraryItems(
      scan([
        ["/data/scripts", "a.sh", "# vterm:\n#   name: A\n"],
        ["/data/scripts", "web.yml", "# Serves the site\n- name: Web\n  hosts: web\n  tasks: []\n"],
        ["/repo", "vars.yml", "port: 80\n"],
        ["/repo", "broken.yml", "- name: x\n  hosts: [\n"],
        ["/repo", "plain.sh", "echo hi\n"],
      ]),
      readYaml,
    );
    expect(out.items.map((r) => [r.kind, r.origin, r.file])).toEqual([
      ["recipe", "own", "a.sh"],
      ["playbook", "own", "web.yml"],
      ["playbook", "source", "broken.yml"],
      ["recipe", "source", "plain.sh"],
    ]);
    expect(out.notPlaybooks).toBe(1);
    const web = out.items[1] as LibraryPlaybook;
    expect([web.name, web.description, web.book?.plays[0].hosts]).toEqual(["Web", "Serves the site", "web"]);
    // A playbook with a typo is said, not dropped.
    const broken = out.items[2] as LibraryPlaybook;
    expect(broken.book).toBeNull();
    expect(broken.error).toBeTruthy();
    expect(itemName(broken)).toBe("broken");
    // Without the parser the YAML is not read at all.
    expect(libraryItems(scan([["/data/scripts", "web.yml", "- hosts: all\n"]]), null).items).toEqual([]);
  });

  it("a folder that is an Ansible project shows as the project; projects in a folder are found", () => {
    const folders = [
      { path: "/infra", source: "/infra", entries: [{ name: "ansible.cfg", isDir: false }, { name: "site.yml", isDir: false }] },
      { path: "/infra/tf", source: "/infra", entries: [{ name: "main.tf", isDir: false }] },
      { path: "/infra/docs", source: "/infra", entries: [{ name: "README.md", isDir: false }] },
    ];
    const s = scan([["/infra", "site.yml", "- hosts: all\n"]], folders);
    expect(libraryItems(s, readYaml).items).toEqual([]);
    expect(foundProjects(s)).toEqual([
      { kind: "ansible", root: "/infra", source: "/infra" },
      { kind: "terraform", root: "/infra/tf", source: "/infra" },
    ]);
  });

  it("are named by their header or first play and found by name, description or file", () => {
    const r = libraryRecipe("own", "x.sh", "/d", "/d/x.sh", "# vterm:\n#   name: Docker ставит\n#   description: движок\n");
    expect(itemMatches(r, "")).toBe(true);
    expect(itemMatches(r, "ДВИЖ")).toBe(true);
    expect(itemMatches(r, "x.sh")).toBe(true);
    expect(itemMatches(r, "nginx")).toBe(false);
    expect(itemName(libraryRecipe("own", "p.sh", "/d", "/d/p.sh", "echo\n"))).toBe("p.sh");
  });

  it("a playbook's description is the comment at its top", () => {
    expect(playbookDescription("---\n# One\n#  two\n\n- hosts: all\n")).toBe("One two");
    expect(playbookDescription("- hosts: all\n# later\n")).toBe("");
  });
});
