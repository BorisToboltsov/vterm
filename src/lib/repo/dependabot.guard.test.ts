// Dependabot guard: locks in what the update groups are allowed to bundle.
//
// Grouping trades review granularity for fewer PRs, and the trade is only safe
// where a bump cannot hide something that deserves its own look:
//   - a major never rides in a group (a grouped PR once slipped tauri-action
//     v0.6 → v1.0 in among routine SHA bumps — see the dependabot.yml preamble);
//   - russh, the SSH stack, is never grouped at all;
//   - Svelte/SvelteKit minors arrive as their own PR — only patches may group;
//   - a catch-all `*` group is last, because Dependabot assigns a package to the
//     FIRST matching group and a leading catch-all would swallow the rest;
//   - every ecosystem keeps the 7-day cooldown SECURITY.md promises.
//
// There is no YAML parser in the tree and the file is small, so this reads the
// one shape dependabot.yml uses (block maps + flow arrays). Anything it does not
// recognise fails the test rather than being skipped.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Group = {
  name: string;
  patterns: string[];
  exclude: string[];
  updateTypes: string[] | null;
};
type Ecosystem = { name: string; cooldownDays: number | null; groups: Group[] };

const flowArray = (raw: string): string[] => {
  const m = raw.trim().match(/^\[(.*)\]$/);
  if (!m) throw new Error(`expected a flow array, got: ${raw}`);
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
};

export function parseDependabot(src: string): Ecosystem[] {
  const out: Ecosystem[] = [];
  let eco: Ecosystem | null = null;
  let section: string | null = null;
  let group: Group | null = null;
  for (const line of src.split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue;
    const code = line.replace(/\s+#.*$/, "");
    const start = code.match(/^ {2}- package-ecosystem:\s*(\S+)/);
    if (start) {
      eco = { name: start[1], cooldownDays: null, groups: [] };
      out.push(eco);
      section = null;
      group = null;
      continue;
    }
    if (!eco) continue;
    const top = code.match(/^ {4}([a-z-]+):/);
    if (top) {
      section = top[1];
      group = null;
      continue;
    }
    if (section === "cooldown") {
      const d = code.match(/^ {6}default-days:\s*(\d+)/);
      if (d) eco.cooldownDays = Number(d[1]);
      continue;
    }
    if (section !== "groups") continue;
    const g = code.match(/^ {6}([A-Za-z0-9_-]+):\s*$/);
    if (g) {
      group = { name: g[1], patterns: [], exclude: [], updateTypes: null };
      eco.groups.push(group);
      continue;
    }
    const kv = code.match(/^ {8}([a-z-]+):\s*(.+)$/);
    if (!group || !kv) throw new Error(`unrecognised line in groups: ${line}`);
    const [, key, value] = kv;
    if (key === "patterns") group.patterns = flowArray(value);
    else if (key === "exclude-patterns") group.exclude = flowArray(value);
    else if (key === "update-types") group.updateTypes = flowArray(value);
    else throw new Error(`unknown group key: ${key}`);
  }
  return out;
}

/** Dependabot pattern: `*` matches any run of characters, nothing else is special. */
export const globMatch = (pattern: string, name: string): boolean =>
  new RegExp(
    "^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*") + "$",
  ).test(name);

/** The group Dependabot would put `dep` in: the first whose patterns match and excludes don't. */
export const groupFor = (eco: Ecosystem, dep: string): Group | undefined =>
  eco.groups.find(
    (g) => g.patterns.some((p) => globMatch(p, dep)) && !g.exclude.some((p) => globMatch(p, dep)),
  );

const config = parseDependabot(readFileSync(join(process.cwd(), ".github/dependabot.yml"), "utf8"));
const eco = (name: string): Ecosystem => {
  const e = config.find((c) => c.name === name);
  if (!e) throw new Error(`dependabot.yml has no ${name} ecosystem`);
  return e;
};

describe("dependabot groups", () => {
  it("covers the three ecosystems the repo uses", () => {
    expect(config.map((c) => c.name).sort()).toEqual(["cargo", "github-actions", "npm"]);
  });

  it.each(config.map((c) => [c.name, c] as const))("%s keeps the 7-day cooldown", (_n, c) => {
    expect(c.cooldownDays ?? 0).toBeGreaterThanOrEqual(7);
  });

  const groups = config.flatMap((c) => c.groups.map((g) => [`${c.name}/${g.name}`, g] as const));
  it.each(groups)("%s never bundles a major", (_n, g) => {
    expect(g.updateTypes, "a group without update-types admits majors").not.toBeNull();
    for (const t of g.updateTypes ?? []) expect(["minor", "patch"]).toContain(t);
  });

  it.each(config.map((c) => [c.name, c] as const))("%s puts a catch-all group last", (_n, c) => {
    const idx = c.groups.findIndex((g) => g.patterns.includes("*"));
    if (idx !== -1) expect(idx).toBe(c.groups.length - 1);
  });

  it.each(["russh", "russh-sftp"])("cargo never groups %s", (dep) => {
    expect(groupFor(eco("cargo"), dep)?.name).toBeUndefined();
  });

  it.each(["svelte", "@sveltejs/kit"])("npm groups %s by patch only", (dep) => {
    const g = groupFor(eco("npm"), dep);
    if (g) expect(g.updateTypes).toEqual(["patch"]);
  });

  it("the tauri plugins group on both sides of the bridge", () => {
    expect(groupFor(eco("cargo"), "tauri-plugin-dialog")?.name).toBe("tauri");
    expect(groupFor(eco("npm"), "@tauri-apps/plugin-dialog")?.name).toBe("tauri");
  });
});

describe("dependabot.yml reader", () => {
  it("matches globs the way Dependabot does", () => {
    expect(globMatch("russh-*", "russh-sftp")).toBe(true);
    expect(globMatch("russh-*", "russh")).toBe(false);
    expect(globMatch("@types/*", "@types/node")).toBe(true);
    expect(globMatch("tauri", "tauri-build")).toBe(false);
  });

  it("refuses shapes it does not understand instead of skipping them", () => {
    const src = [
      "updates:",
      "  - package-ecosystem: npm",
      "    groups:",
      "      g:",
      "        patterns:",
      '          - "*"',
    ].join("\n");
    expect(() => parseDependabot(src)).toThrow();
  });
});
