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
//
// Phase 44.10 extends the same rule to the *numberless* `text-white` / `text-black`:
// the original guard only matched palette classes carrying a shade number
// (`text-amber-400`), so a bare `text-white` — which is just as fixed and just as
// invisible on a cream panel — slipped straight through, and 385 of them piled up
// across ~70 components (white-on-cream everywhere the moment a light theme is
// picked; the reporter first hit it in Settings). Primary text must ride the theme
// token `text-text`, which flips dark on light themes. White stays sanctioned only
// where it sits on a *solid saturated* button that carries its own background
// (`bg-green-500/600`, `bg-danger`, `bg-accent`) — never on a translucent tint
// (`bg-accent/10`) or a neutral panel/edge surface.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

const HUES =
  "green|amber|red|sky|blue|emerald|rose|yellow|orange|violet|purple|cyan|teal|indigo|pink|lime|fuchsia|slate|zinc|neutral|stone|gray";
const RAW_PALETTE = new RegExp(`\\b(?:bg|text|border|ring|fill|stroke)-(?:${HUES})-\\d{2,3}\\b`, "g");

/** The pinned primary-action button (DESIGN.md) — a filled green CTA. */
const SANCTIONED = /^(?:bg-green-600|bg-green-500)$/;

/** Numberless `text-white` / `text-black`, with or without an opacity modifier. */
const RAW_WHITE_BLACK = /\btext-(?:white|black)(?:\/\d+)?\b/g;
/**
 * A line where white/black text is legitimate: it sits on a *solid* saturated
 * button background that supplies its own contrast on every theme. The lookahead
 * excludes translucent tints (`bg-accent/10`), which are as pale as the panel.
 */
const SANCTIONED_WHITE_LINE = /\bbg-green-[56]00\b|\bbg-danger\b(?!\/)|\bbg-accent\b(?!\/)/;

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

function whiteOffenders(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (SANCTIONED_WHITE_LINE.test(line)) return;
      for (const m of line.matchAll(RAW_WHITE_BLACK)) out.push(`${file}:${i + 1}: ${m[0]}`);
    });
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

  it("has no bare text-white / text-black outside a solid saturated button", () => {
    expect(
      whiteOffenders(),
      "primary text must use the theme token `text-text` (it flips dark on light " +
        "themes) — a fixed `text-white` is invisible on a cream panel; white is only " +
        "allowed on a solid saturated button that supplies its own background",
    ).toEqual([]);
  });

  it("still sees the sanctioned white-on-button lines, so the exemption is not dead", () => {
    const sanctioned = sourceFiles(SRC)
      .flatMap((f) => readFileSync(f, "utf8").split("\n"))
      .filter(
        (line) => SANCTIONED_WHITE_LINE.test(line) && [...line.matchAll(RAW_WHITE_BLACK)].length > 0,
      );
    expect(sanctioned.length).toBeGreaterThan(0);
  });
});
