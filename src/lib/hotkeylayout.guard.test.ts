// Keyboard-layout guard: a letter hotkey must not be matched on the raw `e.key`.
//
// The bug: Ctrl+R opened our command-history overlay with the English layout and
// fell through to the shell's reverse-search with the Russian one — `e.key` is
// "к" there, not "r". Every other letter chord (⌘K, ⌘T, ⌘F, ⌘C/⌘V, the file
// panel's ⌘A/⌘X) had the same silent failure. Letters go through `chordLetter`
// in appshortcuts.ts, which falls back to the physical `e.code` when the layout
// isn't Latin.
//
// The guard fails on `.key === "x"` / `.key !== "x"` with a single Latin letter,
// and on `.key.toLowerCase()` (the `switch`/compare form clipboardKeys.ts used).
// Comments are stripped first so documentation can name the anti-pattern.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

const RAW_LETTER = /\.key\s*[!=]==?\s*["'][a-zA-Z]["']/;
const LOWERED_KEY = /\.key\.toLowerCase\(\)/;
// appshortcuts.ts is where layout handling lives; tests build chords by hand.
const EXEMPT = /(^|[\\/])appshortcuts\.ts$|\.test\.ts$/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".svelte") || entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

/** Blank out comments, keeping line numbers. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

export function offendersIn(src: string): number[] {
  const out: number[] = [];
  stripComments(src)
    .split("\n")
    .forEach((line, i) => {
      if (RAW_LETTER.test(line) || LOWERED_KEY.test(line)) out.push(i + 1);
    });
  return out;
}

describe("hotkey layout guard", () => {
  it("catches the raw forms it exists for", () => {
    expect(offendersIn(`if (e.ctrlKey && e.key === "r") open();`)).toEqual([1]);
    expect(offendersIn(`const x = (e.key === 'A' || e.key === "a");`)).toEqual([1]);
    expect(offendersIn(`switch (ev.key.toLowerCase()) {`)).toEqual([1]);
    expect(offendersIn(`// e.key === "r" used to be here`)).toEqual([]);
    expect(offendersIn(`if (e.key === "Enter") go();`)).toEqual([]);
  });

  it("no letter hotkey is matched on the raw e.key", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (EXEMPT.test(file)) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (const n of offendersIn(src)) {
        offenders.push(`${file.slice(SRC.length + 1)}:${n}: ${lines[n - 1].trim().slice(0, 100)}`);
      }
    }
    expect(
      offenders,
      `letter hotkeys matched on raw e.key break on non-Latin layouts (Russian "к" ≠ "r").\n` +
        `Use chordLetter()/the is*Chord predicates from appshortcuts.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
