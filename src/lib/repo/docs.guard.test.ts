// Documentation guard (1.25.4, stage E): the rules every agent session loads stay
// one file and stay short, and everything they name still exists.
//
// AGENTS.md and CLAUDE.md were two copies of the same process rules that differed
// only in the title line — an edit to one left the other stale. docs/INVARIANTS.md
// is imported into the context of every session and had grown to ~222k characters
// of rule plus history; stage E moved the history to ADRs. A budget on the whole
// file kept it there until v1.36; since then each rule is held short instead — an
// item, a sub-item, a table row — so the canon grows by rules, never by stories:
// a rule that needs more than a phrase of reason gets an ADR and a link.
//
// The rules name gates and ADRs, and code comments cite rules by their title. A
// renamed gate or a reworded title leaves a pointer to nothing, and no other test
// notices — so the names are checked too, both ways for the `*.guard` files: a
// gate the canon does not mention is a contract nobody is told about.
//
// Each check is a function over text; the last block feeds every one of them a
// violation to show it catches one.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const SELF = "docs.guard.test.ts";

/**
 * How long one rule may be, in characters (not bytes: Cyrillic is two in UTF-8):
 * a top-level item with its own lines, a nested sub-item, a row of a table. The
 * whole file had a budget of 100 000 until v1.36; a cap per rule keeps each one
 * a rule — the canon may grow, a rule may not become a story.
 */
export const RULE_LIMITS = { item: 900, subItem: 400, row: 1000 } as const;

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (["node_modules", "target", ".svelte-kit", "build"].includes(e.name)) continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel, keep));
    else if (keep(e.name)) out.push(rel);
  }
  return out;
}

// --- 1. one file of process rules -------------------------------------------

/** What makes CLAUDE.md more than a pointer to AGENTS.md. */
export function claudeProblems(claude: string): string[] {
  const problems: string[] = [];
  if (!/^@AGENTS\.md[ \t]*$/m.test(claude)) problems.push("does not import @AGENTS.md");
  if (/^#{2,}\s/m.test(claude)) problems.push("has sections of its own");
  if ([...claude].length > 400) problems.push("is longer than a pointer");
  return problems;
}

export const importsInvariants = (agents: string) => /^@docs\/INVARIANTS\.md[ \t]*$/m.test(agents);

// --- 2. each rule short --------------------------------------------------------

/**
 * The rules of the canon that are over their limit, as `line N: kind, M > limit`.
 * An item is a `- ` line with the lines indented under it; a sub-item is an
 * `  - ` line with its own; a row is a `|` line (the separator row aside).
 */
export function longRules(text: string, limits: { item: number; subItem: number; row: number } = RULE_LIMITS): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  let cur: { line: number; kind: "item" | "subItem"; text: string } | null = null;
  const close = () => {
    if (cur && [...cur.text].length > limits[cur.kind]) {
      out.push(`line ${cur.line}: ${cur.kind}, ${[...cur.text].length} > ${limits[cur.kind]}`);
    }
    cur = null;
  };
  lines.forEach((line, i) => {
    if (line.startsWith("- ")) {
      close();
      cur = { line: i + 1, kind: "item", text: line };
    } else if (line.startsWith("  - ")) {
      close();
      cur = { line: i + 1, kind: "subItem", text: line };
    } else if (cur && /^ {2,}\S/.test(line)) {
      cur.text += `\n${line}`;
    } else {
      close();
      if (line.startsWith("|") && !/^\|[\s|:-]+\|$/.test(line) && [...line].length > limits.row) {
        out.push(`line ${i + 1}: row, ${[...line].length} > ${limits.row}`);
      }
    }
  });
  close();
  return out;
}

// --- 3. named gates and ADRs exist ------------------------------------------

/** `x.guard` names in backticks. */
export const namedGuards = (text: string) =>
  new Set([...text.matchAll(/`([a-z0-9-]+\.guard)`/g)].map((m) => m[1]));

/** `x.test.ts` names in backticks. */
export const namedTests = (text: string) =>
  new Set([...text.matchAll(/`([A-Za-z0-9.-]+\.test\.ts)`/g)].map((m) => m[1]));

/** Rust test names in the gate-table rows marked `(Rust)`. */
export function namedRustGates(text: string): Set<string> {
  const names = new Set<string>();
  for (const row of text.split("\n").filter((l) => l.startsWith("|") && l.includes("(Rust)"))) {
    const head = row.split("|")[1] ?? "";
    for (const m of head.matchAll(/`([a-z][a-z0-9_]+)`/g)) names.add(m[1]);
  }
  return names;
}

/** ADR numbers cited as "ADR NNNN" or "ADR NNNN, MMMM". */
export function citedAdrs(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/ADR ((?:\d{4}(?:, | и )?)+)/g)) {
    for (const n of m[1].match(/\d{4}/g) ?? []) out.add(n);
  }
  return out;
}

// --- 4. citations of rules resolve ------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*«»"]/g, "")
    .replace(/[—–-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s.,:;]+$/, "")
    .trim();

/** Headings and bold rule titles — what a citation may name. */
export const ruleTitles = (invariants: string) => [
  ...[...invariants.matchAll(/^#+ (.+)$/gm)].map((m) => norm(m[1])),
  // A single `*` may sit inside bold (`*_SCRIPT`), so `[^*]+` would lose the pairing.
  ...[...invariants.matchAll(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g)].map((m) => norm(m[1])),
];

/** Quotes that follow "INVARIANTS" on the same line, outside the canon. */
export const externalCitations = (source: string) =>
  [...source.matchAll(/INVARIANTS[^«"\n]{0,40}[«"]([^»"\n]{3,90})[»"]/g)].map((m) => m[1]);

/** "см. «…»" inside the canon itself. */
export const internalCitations = (invariants: string) =>
  [...invariants.matchAll(/см\. «([^»\n]+)»/g)].map((m) => m[1]);

export const unresolved = (quotes: string[], titles: string[]) =>
  quotes.filter((q) => !titles.some((t) => t.includes(norm(q))));

// --- the repository -----------------------------------------------------------

const INVARIANTS = read("docs/INVARIANTS.md");
const AGENTS = read("AGENTS.md");
const TITLES = ruleTitles(INVARIANTS);

describe("documentation guard", () => {
  it("keeps one file of process rules: CLAUDE.md only imports AGENTS.md", () => {
    expect(claudeProblems(read("CLAUDE.md"))).toEqual([]);
    expect(importsInvariants(AGENTS)).toBe(true);
  });

  it("keeps every rule of INVARIANTS short", () => {
    // Too long: the rule, its reason in a phrase and its gate stay; the story goes to an ADR.
    expect(longRules(INVARIANTS)).toEqual([]);
  });

  it("names every *.guard file, and every named guard exists", () => {
    const files = new Set(walk("src", (n) => n.endsWith(".guard.test.ts")).map((f) => basename(f, ".test.ts")));
    const named = namedGuards(INVARIANTS);
    expect([...files].filter((f) => !named.has(f))).toEqual([]);
    expect([...named].filter((n) => !files.has(n))).toEqual([]);
  });

  it("names only test files that exist", () => {
    const files = new Set(walk("src", (n) => n.endsWith(".test.ts")).map((f) => basename(f)));
    expect([...namedTests(INVARIANTS)].filter((n) => !files.has(n))).toEqual([]);
  });

  it("names only Rust gates that exist", () => {
    const rust = walk("src-tauri/src", (n) => n.endsWith(".rs"))
      .map(read)
      .join("\n");
    const names = namedRustGates(INVARIANTS);
    expect(names.size).toBeGreaterThan(20);
    expect([...names].filter((n) => !new RegExp(`fn ${n}\\b`).test(rust))).toEqual([]);
  });

  it("cites only ADRs that exist", () => {
    const adrs = new Set(readdirSync(join(ROOT, "docs/adr")).map((f) => f.slice(0, 4)));
    const cited = new Set([...citedAdrs(INVARIANTS), ...citedAdrs(AGENTS)]);
    expect([...cited].filter((n) => !adrs.has(n))).toEqual([]);
  });

  it("resolves every citation of a rule, in the canon and outside it", () => {
    expect(unresolved(internalCitations(INVARIANTS), TITLES)).toEqual([]);
    const sources = [
      ...walk("src", (n) => /\.(ts|svelte|js)$/.test(n) && n !== SELF),
      ...walk("src-tauri/src", (n) => n.endsWith(".rs")),
      ...walk("lint", (n) => n.endsWith(".js")),
      ...walk("docs", (n) => n.endsWith(".md") && n !== "INVARIANTS.md"),
      ...["eslint.config.js", "AGENTS.md", "README.md", "CONTRIBUTING.md", "SECURITY.md"].filter((f) =>
        existsSync(join(ROOT, f)),
      ),
    ];
    const broken = sources.flatMap((f) => unresolved(externalCitations(read(f)), TITLES).map((q) => `${f}: «${q}»`));
    expect(broken).toEqual([]);
  });

  it("catches each violation it exists for", () => {
    expect(claudeProblems("# CLAUDE.md\n\n## Ветки\n\nкопия правил")).toEqual([
      "does not import @AGENTS.md",
      "has sections of its own",
    ]);
    expect(claudeProblems("@AGENTS.md\n" + "x".repeat(500))).toEqual(["is longer than a pointer"]);
    expect(importsInvariants("Контракты — в docs/INVARIANTS.md.")).toBe(false);
    const lim = { item: 20, subItem: 12, row: 15 };
    expect(longRules(`- **Правило.** ${"я".repeat(6)}\n  продолжение`, lim)).toEqual(["line 1: item, 35 > 20"]);
    expect(longRules("- **Коротко.**\n  - подпункт длиннее\n    своего предела", lim)).toEqual([
      "line 2: subItem, 39 > 12",
    ]);
    expect(longRules("| a | очень длинная строка |\n|---|---|", lim)).toEqual(["line 1: row, 28 > 15"]);
    // Within the limits, and a new item starts a new count.
    expect(longRules("- **Раз.**\n- **Два.**\n\n| a | b |", lim)).toEqual([]);
    expect([...namedGuards("Гейт `ghost.guard` и `real.guard`.")]).toEqual(["ghost.guard", "real.guard"]);
    expect([...namedTests("гейт `Ghost.test.ts`")]).toEqual(["Ghost.test.ts"]);
    expect([...namedRustGates("| `gone_gate` · `other_gate` (Rust) | что-то `not_a_gate` |")]).toEqual([
      "gone_gate",
      "other_gate",
    ]);
    expect([...citedAdrs("(ADR 0012, 0033) и ADR 9999")].sort()).toEqual(["0012", "0033", "9999"]);
    const titles = ruleTitles("## Окна\n\n- **Зонд: `*_SCRIPT`** и **Центр — дерево областей, терминалы — один список**");
    expect(unresolved(externalCitations("// INVARIANTS: «Центр — дерево областей»"), titles)).toEqual([]);
    expect(unresolved(externalCitations('// INVARIANTS ("k8s — отдельный драйвер")'), titles)).toEqual([
      "k8s — отдельный драйвер",
    ]);
    expect(unresolved(internalCitations("(см. «Окна»), (см. «Пропавшее правило»)"), titles)).toEqual([
      "Пропавшее правило",
    ]);
  });
});
