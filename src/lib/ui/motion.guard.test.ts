import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ANIMATIONS_KEY } from "./motion";

// Whether the app moves is decided in one place (ADR 0066). The setting
// "Animations" — as the system asks, always, never — goes onto <html> by the
// settings store and, for the first frame, by app.html; `reducedMotion()` in
// motion.ts reads it with the system's answer, and every piece of CSS keys on the
// decision, `:root[data-motion="reduce"]`. A component that asked the system on
// its own — `@media (prefers-reduced-motion)`, `matchMedia(…)` — would keep still
// under "Always" and move under "Off": exactly what a Windows VM showed before the
// setting existed, numbers landing in one frame while a dialog still glided. Each
// check is a function over the source with comments stripped, and shows it
// catches its own violation.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Drop `<!-- … -->` blocks with a scan, not a non-greedy regex (CodeQL). */
function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    out += src[i++];
  }
  return out;
}

const strip = (src: string) =>
  stripHtmlComments(src.replace(/\/\*[\s\S]*?\*\//g, "")).replace(/^\s*\/\/.*$/gm, "");

/** Where the system is allowed to be asked: the one module, and the first frame. */
export const ASKS_THE_SYSTEM = new Set(["src/lib/ui/motion.ts", "src/app.html"]);

/** Files that ask the system about motion on their own. */
export function systemAskers(files: [string, string][]): string[] {
  return files
    .filter(([path, src]) => !ASKS_THE_SYSTEM.has(path) && /prefers-reduced-motion|matchMedia\s*[?.(]/.test(strip(src)))
    .map(([path]) => path);
}

/** app.css: the global guard keys on the decision, not on the media query. */
export function cssViolations(css: string): string[] {
  const src = strip(css);
  return /:root\[data-motion="reduce"\]\s*\*[\s\S]*?animation-duration:\s*0\.01ms/.test(src)
    ? []
    : ["the global guard does not key on data-motion"];
}

/** app.html: the first frame already moves, or keeps still, as the user chose. */
export function bootViolations(html: string): string[] {
  const src = strip(html);
  const out: string[] = [];
  if (!src.includes(`localStorage.getItem("${ANIMATIONS_KEY}")`)) out.push("the first frame does not read the choice");
  if (!/setAttribute\("data-animations"/.test(src)) out.push("the first frame does not carry the choice");
  if (!/setAttribute\("data-motion", "reduce"\)/.test(src)) out.push("the first frame does not carry the decision");
  return out;
}

/** The settings store puts the choice on the document whenever it changes. */
export function storeViolations(store: string): string[] {
  const src = strip(store);
  const out: string[] = [];
  if (!/\$effect\(\(\) => \{\s*applyAnimations\(\);/.test(src)) out.push("the choice is not applied on change");
  if (!/dataset\.motion = "reduce"/.test(src)) out.push("the decision does not reach the document");
  if (!/localStorage\.setItem\(ANIMATIONS_KEY/.test(src)) out.push("the choice is not kept for the first frame");
  return out;
}

function sources(dir: string): [string, string][] {
  const out: [string, string][] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|svelte|css|html)$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push([relative(ROOT, join(ROOT, rel)), read(rel)]);
    }
  }
  return out;
}

describe("motion is decided in one place (ADR 0066)", () => {
  it("only motion.ts and app.html ask the system", () => {
    expect(systemAskers(sources("src"))).toEqual([]);
  });

  it("the CSS guard keys on the decision", () => {
    expect(cssViolations(read("src/app.css"))).toEqual([]);
  });

  it("the first frame takes the choice", () => {
    expect(bootViolations(read("src/app.html"))).toEqual([]);
  });

  it("the settings store applies the choice and keeps it", () => {
    expect(storeViolations(read("src/lib/settings/settings.svelte.ts"))).toEqual([]);
  });
});

describe("the checks catch their own violations", () => {
  it("a component asking the system — in CSS or in code — is caught, a comment is not", () => {
    const files: [string, string][] = [
      ["src/lib/x/A.svelte", "<style>@media (prefers-reduced-motion: reduce) { .a { animation: none; } }</style>"],
      ["src/lib/x/b.ts", 'const r = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;'],
      ["src/lib/x/c.ts", "// the global prefers-reduced-motion guard covers it\nexport const c = 1;"],
      ["src/lib/x/D.svelte", "<!-- honours prefers-reduced-motion via app.css -->\n<div></div>"],
      ["src/lib/ui/motion.ts", 'matchMedia("(prefers-reduced-motion: reduce)")'],
    ];
    expect(systemAskers(files)).toEqual(["src/lib/x/A.svelte", "src/lib/x/b.ts"]);
  });

  it("a guard on the media query is caught", () => {
    expect(cssViolations("@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; } }")).toEqual([
      "the global guard does not key on data-motion",
    ]);
  });

  it("a first frame that ignores the choice is caught", () => {
    expect(bootViolations("<script>var u = localStorage.getItem('vterm.uiScale');</script>")).toHaveLength(3);
  });

  it("a store that forgets the document or the first frame is caught", () => {
    expect(storeViolations("$effect(() => {\n applyUiScale();\n});")).toHaveLength(3);
  });
});
