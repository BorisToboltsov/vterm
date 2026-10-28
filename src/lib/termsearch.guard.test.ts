import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TERMINAL = join(process.cwd(), "src", "lib", "Terminal.svelte");

/**
 * The terminal's search bar stays inside its pane (v1.23). It is anchored to the
 * pane's right edge and used to be as wide as its contents (~400px), so in a
 * narrow pane — the centre allows 240px — it spilled over the docks beside it.
 * Now the bar is capped at the pane, the field shrinks, and the buttons wrap —
 * the row of buttons itself too: alone it is ~155px, wider than a squeezed pane.
 */
export function searchBarViolations(source: string): string[] {
  const out: string[] = [];
  const bar = source.match(/class="([^"]+)"\s+data-testid="terminal-search"/)?.[1] ?? "";
  if (!/\bmax-w-\[calc\(100%-[^\]]+\)\]/.test(bar)) {
    out.push("the search bar is not capped at the width of its pane");
  }
  if (!/\bflex-wrap\b/.test(bar)) out.push("the search bar's buttons cannot wrap to a second row");
  const start = source.indexOf('data-testid="terminal-search"');
  const input = source.slice(start).match(/<input[\s\S]*?class="([^"]+)"/)?.[1] ?? "";
  for (const cls of ["min-w-0", "flex-1"]) {
    if (!input.split(/\s+/).includes(cls)) out.push(`the search field does not carry ${cls}`);
  }
  const afterInput = source.slice(source.indexOf("<input", start));
  const buttons = afterInput.match(/<\/div>\s*<div class="([^"]+)">\s*<button/)?.[1] ?? "";
  if (!["min-w-0", "flex-wrap"].every((cls) => buttons.split(/\s+/).includes(cls))) {
    out.push("the row of buttons cannot wrap within the bar");
  }
  return out;
}

describe("terminal search bar guard", () => {
  const source = readFileSync(TERMINAL, "utf8");

  it("the bar never grows past its pane", () => {
    expect(searchBarViolations(source)).toEqual([]);
  });

  it("catches a bar sized by its contents again", () => {
    const broken = source.replace("flex max-w-[calc(100%-1rem)] flex-wrap", "flex");
    expect(searchBarViolations(broken)).toEqual([
      "the search bar is not capped at the width of its pane",
      "the search bar's buttons cannot wrap to a second row",
    ]);
  });

  it("catches a row of buttons that cannot wrap", () => {
    const broken = source.replace(
      '<div class="flex min-w-0 flex-wrap items-center justify-end gap-1">',
      '<div class="flex items-center gap-1">',
    );
    expect(searchBarViolations(broken)).toEqual(["the row of buttons cannot wrap within the bar"]);
  });

  it("catches a field that keeps its full width", () => {
    const broken = source.replace("w-44 min-w-0 flex-1 bg-transparent", "w-44 bg-transparent");
    expect(searchBarViolations(broken)).toEqual([
      "the search field does not carry min-w-0",
      "the search field does not carry flex-1",
    ]);
  });
});
