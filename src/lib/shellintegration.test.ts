import { describe, expect, it } from "vitest";
import { OSC7_SETUP, osc7SetupDisplay } from "./shellintegration";

describe("OSC7_SETUP", () => {
  it("emits an OSC 7 sequence via printf", () => {
    // ESC ] 7 ; file://…  — the cwd-reporting escape the panels listen for.
    expect(OSC7_SETUP).toContain("printf '\\033]7;file://%s%s\\a'");
    expect(OSC7_SETUP).toContain('"$PWD"');
  });

  it("is history-guarded (leading space) and idempotent", () => {
    expect(OSC7_SETUP.startsWith(" ")).toBe(true); // ignored by HISTCONTROL=ignorespace
    expect(OSC7_SETUP).toContain('*";__vtcwd;"*'); // bash: skip if already installed
    expect(OSC7_SETUP).toContain("add-zsh-hook precmd __vtcwd"); // zsh: idempotent hook
  });

  it("runs the emitter once immediately to sync the current dir", () => {
    expect(OSC7_SETUP.trimEnd().endsWith("__vtcwd")).toBe(true);
  });

  it("display form drops the leading history-guard space", () => {
    expect(osc7SetupDisplay()).toBe(OSC7_SETUP.trim());
    expect(osc7SetupDisplay().startsWith(" ")).toBe(false);
  });
});
