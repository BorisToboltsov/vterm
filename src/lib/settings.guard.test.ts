import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LIB = join(process.cwd(), "src", "lib");

function svelteSources(): { file: string; text: string }[] {
  return readdirSync(LIB)
    .filter((f) => f.endsWith(".svelte"))
    .map((f) => ({ file: f, text: readFileSync(join(LIB, f), "utf8") }));
}

describe("settings guards", () => {
  it("never two-way binds the UI language", () => {
    // `bind:value={settings.language}` writes the locale straight into the store
    // and skips `setLocale`, which also re-seeds the AI prompts the user hasn't
    // edited (Phase 41). The feature then silently does nothing — exactly the bug
    // this guard exists to stop coming back.
    const offenders = svelteSources()
      .filter(({ text }) => /bind:value=\{settings\.language\}/.test(text))
      .map(({ file }) => file);
    expect(offenders, "use setLocale() instead of bind:value on settings.language").toEqual([]);
  });
});
