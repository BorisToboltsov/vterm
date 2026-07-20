// Status-colour guard (Phase 43): semantic colours come from theme tokens
// (`ok`/`warn`/`bad`/`accent`/`danger`/`muted`), never from Tailwind's fixed palette.
//
// The reason it is a guard and not a convention: a hard-coded `bg-amber-400` looks
// perfectly reasonable in a diff, and on the default near-black theme it *is*
// perfectly readable — which is why 47 of them accumulated across 19 files. They
// are only wrong on the four light themes, where an amber dot on Solarized Light's
// cream panel (`#fdf6e3`) is a smudge and a `bg-green-950` diff line is a
// near-black block inside a light editor. Nobody reviewing a single component on
// the default theme can see that, so the rule has to be mechanical.
//
// The one sanctioned exception is the primary "Connect" button (`bg-green-600` /
// `hover:bg-green-500`), which DESIGN.md pins deliberately: it is a filled button
// with white text, legible on any panel because it supplies its own background.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

const HUES =
  "green|amber|red|sky|blue|emerald|rose|yellow|orange|violet|purple|cyan|teal|indigo|pink|lime|fuchsia|slate|zinc|neutral|stone|gray";
const RAW_PALETTE = new RegExp(`\\b(?:bg|text|border|ring|fill|stroke)-(?:${HUES})-\\d{2,3}\\b`, "g");

/** The pinned primary-action button (DESIGN.md) — a filled green CTA. */
const SANCTIONED = /^(?:bg-green-600|bg-green-500)$/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".svelte")) acc.push(full);
  }
  return acc;
}

function offenders(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(RAW_PALETTE)) {
      if (SANCTIONED.test(m[0])) continue;
      const line = src.slice(0, m.index).split("\n").length;
      out.push(`${file}:${line}: ${m[0]}`);
    }
  }
  return out;
}

describe("status colour guard", () => {
  it("has no raw Tailwind palette colour outside the sanctioned primary button", () => {
    expect(
      offenders(),
      "use the theme tokens (ok/warn/bad/accent/danger/muted) — a fixed palette " +
        "colour cannot be legible on both a near-black and a cream panel",
    ).toEqual([]);
  });

  it("still recognises the sanctioned button, so the exemption is not silently dead", () => {
    const seen = sourceFiles(SRC)
      .map((f) => readFileSync(f, "utf8"))
      .flatMap((src) => [...src.matchAll(RAW_PALETTE)].map((m) => m[0]))
      .filter((c) => SANCTIONED.test(c));
    expect(seen.length).toBeGreaterThan(0);
  });
});
