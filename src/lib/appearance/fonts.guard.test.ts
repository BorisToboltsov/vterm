import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const readsRawFont = (source: string) => /settings\.fontFamily/.test(source);
it("terminal consumers resolve the font through the preference", () => {
  for (const file of ["terminal/Terminal.svelte", "recording/RecordingPlayer.svelte"]) {
    const source = readFileSync(`src/lib/${file}`, "utf8");
    expect(readsRawFont(source)).toBe(false);
    expect(source).toContain("activeFontFamily()");
    expect(readsRawFont(source.replaceAll("activeFontFamily()", "settings.fontFamily"))).toBe(true);
  }
});
it("removed font packages never return to the bundle", () => {
  for (const file of ["package.json", "pnpm-lock.yaml", "src/routes/+layout.svelte", "src/lib/appearance/AppearanceSettings.svelte"]) {
    expect(readFileSync(file, "utf8")).not.toMatch(/VT323|Press Start 2P|@fontsource\/(vt323|press-start-2p)/);
  }
});
