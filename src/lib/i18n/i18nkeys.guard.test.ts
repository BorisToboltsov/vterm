import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "./messages";

// Every message key is used somewhere in the app.
//
// A key is added to every locale at once, so a dead one costs a translation on
// each new feature that touches its neighbours and a line in every review of the
// dictionary — and nothing ever tells you it is dead: the type of `t()` checks
// that a key exists, not that anybody still asks for it. 51 of them had piled up
// by v1.25.0 (whole Docker prune and k8s column sets that the panels stopped
// showing). A key counts as used when it appears as a string literal in a source
// file other than the dictionary, or when it starts with the fixed part of a
// template that builds keys (`ai.context.slot.${slot}`). Tests do not count — a
// key only a test asks for is not shown to anyone — and neither do comments.

const SRC = join(process.cwd(), "src");
/** Files that define the dictionaries rather than use them. */
const DICTIONARIES = ["lib/i18n/en.ts", "lib/i18n/ru.ts", "lib/i18n/messages.ts"];

/** Drop `<!-- … -->` by scanning, not with one non-greedy `.replace` (CodeQL). */
function stripHtmlComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    out += text[i++];
  }
  return out;
}

function strip(src: string): string {
  return stripHtmlComments(src.replace(/\r\n/g, "\n"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** Keys nobody asks for, given the code (comments already stripped). */
function deadKeys(keys: readonly string[], code: string): string[] {
  const literals = new Set([...code.matchAll(/["'`]([A-Za-z0-9_.-]+)["'`]/g)].map((m) => m[1]));
  const prefixes = [...code.matchAll(/`([A-Za-z0-9_.-]+\.)\$\{/g)].map((m) => m[1]);
  return keys.filter((k) => !literals.has(k) && !prefixes.some((p) => k.startsWith(p)));
}

describe("message keys", () => {
  const code = sourceFiles(SRC)
    .filter((f) => !DICTIONARIES.includes(relative(SRC, f).split("\\").join("/")))
    .map((f) => strip(readFileSync(f, "utf8")))
    .join("\n");

  it("are all used by the app", () => {
    expect(deadKeys(Object.keys(en), code)).toEqual([]);
  });

  it("the dictionary itself is excluded, so a key cannot vouch for itself", () => {
    const seen = sourceFiles(SRC).map((f) => relative(SRC, f).split("\\").join("/"));
    for (const dictionary of DICTIONARIES) expect(seen, dictionary).toContain(dictionary);
  });

  it("catches its own violations", () => {
    const keys = ["menu.open", "menu.gone", "ai.context.slot.buffer"];
    expect(deadKeys(keys, 't("menu.open"); const k = `ai.context.slot.${slot}`;')).toEqual(["menu.gone"]);
    // A key named only in a comment is still dead.
    expect(deadKeys(["menu.gone"], strip('// t("menu.gone")\n/* "menu.gone" */\n<!-- "menu.gone" -->'))).toEqual([
      "menu.gone",
    ]);
    // Single quotes and plain template literals count as uses.
    expect(deadKeys(["a.b", "c.d"], "t('a.b'); t(`c.d`);")).toEqual([]);
  });
});
