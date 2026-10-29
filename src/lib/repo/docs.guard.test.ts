// Documentation guard (1.25.4, stage E): the rules every agent session loads stay
// one file and stay short, and everything they name still exists.
//
// AGENTS.md and CLAUDE.md were two copies of the same process rules that differed
// only in the title line — an edit to one left the other stale. docs/INVARIANTS.md
// is imported into the context of every session and had grown to ~222k characters
// of rule plus history; stage E moved the history to ADRs, and the budget keeps it
// there: a rule that needs more than a phrase of reason gets an ADR and a link.
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

/** Characters, not bytes: Cyrillic is two bytes a character in UTF-8. */
export const INVARIANTS_BUDGET = 90_000;

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

// --- 2. budget ----------------------------------------------------------------

export const overBudget = (text: string, budget = INVARIANTS_BUDGET) => [...text].length > budget;

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

  it("keeps INVARIANTS within its budget", () => {
    // Over budget: condense a rule to a phrase of reason and move the story to an ADR.
    expect([...INVARIANTS].length).toBeLessThanOrEqual(INVARIANTS_BUDGET);
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
    expect(overBudget("я".repeat(11), 10)).toBe(true);
    expect(overBudget("я".repeat(10), 10)).toBe(false);
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
