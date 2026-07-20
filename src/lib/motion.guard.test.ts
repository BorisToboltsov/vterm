// Transition guard (Phase 42): every Svelte `transition:`/`in:`/`out:` directive
// takes its duration from `motion.ts`, never a bare literal and never the default.
//
// The reason it is a guard and not a convention: the app.css reduce-motion block
// looks like it covers all movement, so a hand-written `transition:slide={{ duration:
// 200 }}` reads as safe. It isn't — Svelte 5 runs transitions through the Web
// Animations API, which no stylesheet can shorten, so that directive animates at
// full length for a user who asked the OS for no motion. Every such directive
// written before this phase did exactly that. A reviewer cannot see the bug at the
// call site (the call site looks like the rest of the codebase), which is precisely
// when a guard earns its keep.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/**
 * Svelte's built-in transition/animation functions. `animate:` belongs here for
 * the same reason as the rest: Svelte's `flip` is WAAPI-driven too, so a list that
 * reorders under reduced motion would still slide.
 */
const NAMES = "fade|slide|scale|fly|blur|draw|flip";
const DIRECTIVE = new RegExp(`(?:^|\\s)(transition|in|out|animate):(${NAMES})\\b`, "g");

/** Reads a balanced `{…}` starting at `from`; returns null when there is no block. */
function braceBlock(src: string, from: number): { text: string; end: number } | null {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== "=") return null;
  i++;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== "{") return null;
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return { text: src.slice(start + 1, i), end: i };
  }
  return null;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".svelte")) acc.push(full);
  }
  return acc;
}

interface Found {
  file: string;
  line: number;
  directive: string;
  params: string | null;
}

function directives(): Found[] {
  const out: Found[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(DIRECTIVE)) {
      const at = m.index + m[0].length;
      const block = braceBlock(src, at);
      out.push({
        file,
        line: src.slice(0, m.index).split("\n").length,
        directive: `${m[1]}:${m[2]}`,
        params: block ? block.text : null,
      });
    }
  }
  return out;
}

describe("transition guard", () => {
  it("routes every transition directive through motion.ts", () => {
    const offenders = directives()
      .filter((d) => !(d.params !== null && /\bmotion(Ms|Scale)?\s*\(/.test(d.params)))
      .map(
        (d) =>
          `${d.file}:${d.line}: ${d.directive}${d.params === null ? " (no params — uses Svelte's default duration)" : `={${d.params.trim().slice(0, 50)}}`}`,
      );
    expect(
      offenders,
      "use motion()/motionScale() from motion.ts — Svelte transitions run on WAAPI " +
        "and ignore the app.css prefers-reduced-motion guard",
    ).toEqual([]);
  });

  it("finds the directives it is meant to police (the matcher still sees real usage)", () => {
    expect(directives().length).toBeGreaterThan(5);
  });

  it("reads balanced parameter blocks, not just the first closing brace", () => {
    const src = `<div transition:slide={motion({ duration: 200 })}></div>`;
    const at = src.indexOf("transition:slide") + "transition:slide".length;
    expect(braceBlock(src, at)?.text).toBe("motion({ duration: 200 })");
  });
});
