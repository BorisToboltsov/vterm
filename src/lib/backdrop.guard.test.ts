// Backdrop guard: a dimmed dialog backdrop only dims — it never closes.
// Coming back from another app (to copy a password, say), the first click easily
// lands outside the card, and the half-filled "new server" form silently vanished
// with everything typed into it. Closing a dialog is its buttons, its ×, or
// Escape — deliberate acts. The ⌘K palette is the exception: a transient popup
// expected to dismiss on a click elsewhere, holding nothing worth losing.
// (Right-click menus use an undimmed catcher, which this guard doesn't match.)
//
// The guard finds every element whose class dims the window (`inset-0` +
// `bg-black/…`) and fails if that element is a <button> or carries a click
// handler. Checked per element, on source with comments stripped.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
// Transient popup that legitimately dismisses on an outside click.
const EXEMPT = new Set(["lib/CommandPalette.svelte"]);

function svelteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFiles(full, acc);
    else if (entry.endsWith(".svelte")) acc.push(full);
  }
  return acc;
}

const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

/** The opening tag around `at`: back to its `<`, forward to the `>` outside `{…}`. */
function openingTag(src: string, at: number): string {
  const start = src.lastIndexOf("<", at);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Every dimming backdrop element's opening tag in a component's markup. */
export function backdropTags(src: string): string[] {
  const markup = stripComments(src);
  const out: string[] = [];
  const re = /bg-black\/\d+/g;
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    const tag = openingTag(markup, m.index);
    if (/\binset-0\b/.test(tag)) out.push(tag);
  }
  return out;
}

/** A backdrop that closes: a button, or anything with a click handler. */
export const closesOnClick = (tag: string) => /^<button\b/.test(tag) || /\bon:?click\b/.test(tag);

describe("backdrop guard", () => {
  it("no dialog backdrop closes on a click", () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (EXEMPT.has(rel)) continue;
      for (const tag of backdropTags(readFileSync(file, "utf8"))) {
        if (closesOnClick(tag)) offenders.push(`${rel}: ${tag.replace(/\s+/g, " ")}`);
      }
    }
    expect(
      offenders,
      `dialog backdrops must only dim — close via buttons/×/Escape:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("catches the shapes it is meant to catch", () => {
    // The guard is only as good as its matcher: prove it on live violations.
    const asButton = `<button class="absolute inset-0 bg-black/50" onclick={() => (open = false)}></button>`;
    const asDiv = `<div class="absolute inset-0 bg-black/50" onclick={close}></div>`;
    const inert = `<!-- <button class="inset-0 bg-black/50"> --><div class="absolute inset-0 bg-black/50" aria-hidden="true"></div>`;
    expect(backdropTags(asButton).map(closesOnClick)).toEqual([true]);
    expect(backdropTags(asDiv).map(closesOnClick)).toEqual([true]);
    expect(backdropTags(inert).map(closesOnClick)).toEqual([false]);
  });

  it("still sees the exempt popups (the exemption is live, not stale)", () => {
    for (const rel of EXEMPT) {
      expect(backdropTags(readFileSync(join(SRC, rel), "utf8")).length, rel).toBeGreaterThan(0);
    }
  });
});
