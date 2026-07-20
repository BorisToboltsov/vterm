// Type-scale guard (Phase 44): font sizes come from the scale
// (`text-caption`/`text-meta`/`text-xs`/`text-sm`/…), never an arbitrary
// `text-[Npx]` literal.
//
// The reason it is a guard and not a convention: before this phase the UI carried
// 328 hand-written literals across 62 files, and 10px vs 11px was decided fresh at
// every new label — a coin-flip nobody could review, because either value looks
// right on its own. The drift only shows up when two of them sit next to each
// other, which is exactly what happened to the uppercase section rubrics (18 at
// 10px, 11 at 11px, in adjacent panels of the same dock).
//
// The scale deliberately carries no `--text-*--line-height` companions — see the
// note in app.css. That is what let the migration be a pure rename; a guard that
// tempted someone to add leading later would undo it silently.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const APP_CSS = join(SRC, "app.css");

/** `text-[13px]`, `text-[0.8rem]`, … — an inline size instead of a scale step. */
const ARBITRARY_SIZE = /\btext-\[[0-9.]+(?:px|rem|em|pt)\]/g;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".svelte")) acc.push(full);
  }
  return acc;
}

describe("type scale guard", () => {
  it("has no arbitrary font size outside the scale", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(ARBITRARY_SIZE)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${file}:${line}: ${m[0]}`);
      }
    }
    expect(
      offenders,
      "use the scale: text-caption (10px) · text-meta (11px) · text-xs (12px) · text-sm (14px)",
    ).toEqual([]);
  });

  it("defines the scale steps the codebase actually uses", () => {
    const css = readFileSync(APP_CSS, "utf8");
    expect(css).toMatch(/--text-caption:\s*10px/);
    expect(css).toMatch(/--text-meta:\s*11px/);
  });

  it("keeps the scale free of line-height companions (the pure-rename property)", () => {
    // With a `--text-x--line-height` present, Tailwind's utility emits `line-height`
    // too (compare the built `.text-xs`), which would turn a size rename into a
    // silent leading change across every one of the 328 call sites.
    //
    // Comments are stripped first and the match requires an actual declaration
    // (name *and* colon): app.css explains this rule in prose, and a bare
    // substring check fails on the very comment that documents it.
    const css = readFileSync(APP_CSS, "utf8").replace(/\/\*[^]*?\*\//g, "");
    expect(css).not.toMatch(/--text-caption--line-height\s*:/);
    expect(css).not.toMatch(/--text-meta--line-height\s*:/);
  });

  it("uses one treatment for uppercase micro-labels", () => {
    // Section rubrics and badges are `text-caption uppercase tracking-wider`. The
    // dock's vertical tab is a documented exception (an interactive label, rotated,
    // where 10px reads badly) — any *other* variant is drift creeping back.
    const variants = new Map<string, string[]>();
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      // `wider` first, plus a word boundary: with `wide` leading the alternation it
      // matches the prefix of `tracking-wider` and reports every correct site.
      for (const m of src.matchAll(/text-(caption|meta) uppercase tracking-(wider|wide)\b/g)) {
        const at = `${file}:${src.slice(0, m.index).split("\n").length}`;
        variants.set(m[0], [...(variants.get(m[0]) ?? []), at]);
      }
    }
    const unexpected = [...variants.entries()]
      .filter(([k]) => k !== "text-caption uppercase tracking-wider")
      .flatMap(([k, at]) => at.filter((a) => !a.includes("RightDock.svelte")).map((a) => `${a}: ${k}`));
    expect(unexpected).toEqual([]);
  });
});
