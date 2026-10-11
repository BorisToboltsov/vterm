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

//
// v1.15 extends it to the classes a `.ts` file hands out. The guard read only
// `.svelte`, so a helper returning `"text-amber-400"` for the markup to
// interpolate passed untouched — that is how the Git status letters stayed on
// the fixed palette (`gitview.ts`) long after the components were moved off it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

/** Non-test TypeScript under `src/`, as a path relative to it → its source. */
function scripts(dir = SRC, acc: Record<string, string> = {}): Record<string, string> {
  // What an entry is comes with the listing: asked of the path afterwards, the
  // answer could be about a different file than the one then read.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const name = entry.name;
    if (entry.isDirectory()) scripts(full, acc);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      acc[relative(SRC, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  }
  return acc;
}

/**
 * `.ts` files that hand out a fixed palette class on purpose, each with the
 * reason. An entry that no longer excuses anything fails the gate.
 */
const SCRIPT_EXEMPT: Record<string, string> = {
  "lib/servericons.ts":
    "the colour a user gives a server is a label picked from a fixed set, not a state",
};

/**
 * Palette classes a script hands out, as `path:line: class`. Comments are
 * dropped first — the prose around a fix names the class it removed. No class
 * is sanctioned here: the one pinned button lives in markup.
 */
export function scriptOffenders(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [rel, source] of Object.entries(files)) {
    // Blanked, not removed: the line numbers must stay the file's own.
    const src = source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
    for (const m of src.matchAll(RAW_PALETTE)) {
      out.push(`${rel}:${src.slice(0, m.index).split("\n").length}: ${m[0]}`);
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

  it("no script hands out a raw palette class either", () => {
    const found = scriptOffenders(scripts());
    const excused = Object.keys(SCRIPT_EXEMPT);
    expect(
      found.filter((v) => !excused.some((rel) => v.startsWith(`${rel}:`))),
      "a class name returned from a .ts file ends up in markup like any other — " +
        "return a theme token (text-ok / text-warn / text-bad / text-accent / text-muted)",
    ).toEqual([]);
    // An exemption with nothing left to excuse is a stale licence.
    for (const rel of excused) {
      expect(found.some((v) => v.startsWith(`${rel}:`)), `${rel} is exempt but clean`).toBe(true);
    }
  });

  it("catches the class a helper returns, and is not fooled by a comment naming it", () => {
    // The helper as it was until v1.15.
    const old = 'export function fileStatusColor(s: string): string {\n  return s === "M" ? "text-amber-400" : "text-muted";\n}\n';
    expect(scriptOffenders({ "lib/gitview.ts": old })).toEqual(["lib/gitview.ts:2: text-amber-400"]);
    // The sanctioned button's class is no licence in a script: the connection
    // dots were a fixed green and yellow in the tabs store until v1.15.
    expect(scriptOffenders({ "lib/stores/tabs.svelte.ts": 'export const dot = "bg-green-500";' })).toEqual([
      "lib/stores/tabs.svelte.ts:1: bg-green-500",
    ]);
    const prose =
      '// was `text-amber-400` — a smudge on a cream panel\n/* and bg-red-500 */\nexport const c = "text-warn"; // not text-green-400\n';
    expect(scriptOffenders({ "lib/x.ts": prose })).toEqual([]);
    // A URL keeps its `//`, and what follows it on the line is still read.
    expect(scriptOffenders({ "lib/x.ts": 'const u = "https://x.y"; const c = "text-sky-400";' })).toEqual([
      "lib/x.ts:1: text-sky-400",
    ]);
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
