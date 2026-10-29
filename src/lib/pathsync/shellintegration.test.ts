import { describe, expect, it } from "vitest";
import { needsShellSetup, OSC7_SETUP, osc7SetupDisplay } from "./shellintegration";

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

describe("needsShellSetup", () => {
  // Phase 39.3: a local tab's cwd comes from the OS, so the user must never be
  // asked to run a snippet for it — that dialog was the friction that made the
  // feature look broken on a stock macOS zsh.
  it("never asks for a local tab, whatever the shell does", () => {
    expect(needsShellSetup("local", false, false)).toBe(false);
    expect(needsShellSetup("local", true, false)).toBe(false);
    expect(needsShellSetup("local", false, true)).toBe(false);
  });

  it("asks for an SSH tab whose shell has said nothing yet", () => {
    expect(needsShellSetup("ssh", false, false)).toBe(true);
  });

  it("does not ask when the remote shell already reports a cwd", () => {
    // Many Linux hosts ship /etc/profile.d/vte.sh and emit OSC 7 unprompted.
    expect(needsShellSetup("ssh", true, false)).toBe(false);
  });

  it("does not ask twice in one session", () => {
    expect(needsShellSetup("ssh", false, true)).toBe(false);
  });

  it("treats an unknown tab kind like SSH (ask rather than silently do nothing)", () => {
    expect(needsShellSetup(undefined, false, false)).toBe(true);
  });
});
