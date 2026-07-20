// Rendered-markdown link guard (Phase 44.3). Every `{@html …}` sink whose content
// comes from `renderMarkdown` MUST sit on an element carrying `use:mdLinks`.
//
// This exact drift is what the guard exists to stop: markdown.ts was written for a
// single trusted caller (the bundled manual, which did intercept clicks), and then
// grew four callers rendering content we do not control — LLM replies, AI plans,
// any .md opened over SFTP, user notes — none of which intercepted anything. A
// `[x](javascript:…)` link in any of them executes in the WebView, which holds
// `invoke()` access to every Tauri command. Nothing about the individual edits that
// added those callers looked wrong at the time; only the whole set does.
//
// Two layers back this up and both must hold: `markdown.ts:safeUrl` refuses unsafe
// schemes at render time, and `mdLinks` refuses them again on click while stopping
// the WebView from navigating at all.
//
// The check is PER SINK, on the enclosing element's opening tag, over a
// comment-stripped copy of the source. A file-level "does `use:mdLinks` appear
// anywhere" test is not enough — the first version of this guard was exactly that,
// and it passed on a file whose action had been deleted, because a nearby prose
// comment still mentioned the action by name.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

// `{@html …}` sinks that are NOT rendered markdown and so need no interception.
// Keep this list short and justified — it is the guard's only escape hatch.
const EXEMPT: Record<string, string> = {
  "lib/Icon.svelte": "static SVG from the ICONS registry, never user input",
};

/** Blank out comments so prose mentioning the action can't satisfy the check. */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/**
 * The opening tag of the element that directly encloses `{@html}` at `at`.
 * Heuristic: the text before the sink ends with that tag's `>`, and the tag starts
 * at the nearest `<` before it. Good enough for the `<div …>{@html …}</div>` shape
 * every sink in this codebase uses; returns null when the shape is unexpected, and
 * an unrecognised shape is reported rather than silently passed.
 */
function enclosingTag(src: string, at: number): string | null {
  const before = src.slice(0, at).trimEnd();
  if (!before.endsWith(">")) return null;
  const open = before.lastIndexOf("<");
  if (open < 0) return null;
  return before.slice(open);
}

function svelteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFiles(full, acc);
    else if (entry.endsWith(".svelte")) acc.push(full);
  }
  return acc;
}

describe("rendered-markdown link guard", () => {
  it("every {@html} markdown sink is mounted under use:mdLinks", () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(SRC)) {
      const rel = file.slice(SRC.length + 1).replaceAll("\\", "/");
      if (EXEMPT[rel]) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      for (let i = src.indexOf("{@html"); i >= 0; i = src.indexOf("{@html", i + 1)) {
        const line = src.slice(0, i).split("\n").length;
        const tag = enclosingTag(src, i);
        if (tag === null) {
          offenders.push(`${rel}:${line}: could not find the element enclosing this {@html}`);
        } else if (!/use:mdLinks[\s/>]/.test(tag)) {
          offenders.push(`${rel}:${line}: {@html} sink without use:mdLinks on its element`);
        }
      }
    }
    expect(
      offenders,
      `rendered markdown must be mounted under use:mdLinks (actions/mdlinks.ts);\n` +
        `a non-markdown sink may be added to EXEMPT with a reason:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the exempt list only names files that still exist and still have a sink", () => {
    const stale = Object.keys(EXEMPT).filter((rel) => {
      try {
        return !readFileSync(join(SRC, rel), "utf8").includes("{@html");
      } catch {
        return true; // file gone
      }
    });
    expect(stale, `stale EXEMPT entries in mdlink.guard.test.ts: ${stale.join(", ")}`).toEqual([]);
  });
});
