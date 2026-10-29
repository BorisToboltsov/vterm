import { describe, expect, it } from "vitest";
import { ctrlVPastes, isRightClickAction, rightClickEffect, type RightClickInput } from "./termmouse";

const base: RightClickInput = {
  setting: "paste",
  shift: false,
  hasSelection: false,
  copyOnSelect: true,
};

describe("rightClickEffect", () => {
  it("pastes by default", () => {
    expect(rightClickEffect(base)).toBe("paste");
  });
  it("Shift+right-click opens the menu when right-click pastes", () => {
    expect(rightClickEffect({ ...base, shift: true })).toBe("menu");
  });
  it("menu setting opens the menu; Shift pastes", () => {
    expect(rightClickEffect({ ...base, setting: "menu" })).toBe("menu");
    expect(rightClickEffect({ ...base, setting: "menu", shift: true })).toBe("paste");
  });
  it("pastes over a selection when copy-on-select already copied it", () => {
    expect(rightClickEffect({ ...base, hasSelection: true })).toBe("paste");
  });
  it("copies a selection when copy-on-select is off", () => {
    expect(rightClickEffect({ ...base, hasSelection: true, copyOnSelect: false })).toBe("copy");
    expect(rightClickEffect({ ...base, copyOnSelect: false })).toBe("paste");
  });
  it("the menu wins over copy — the menu has its own Copy", () => {
    expect(
      rightClickEffect({ ...base, shift: true, hasSelection: true, copyOnSelect: false }),
    ).toBe("menu");
  });
});

describe("isRightClickAction", () => {
  it("accepts only the two actions", () => {
    expect(isRightClickAction("paste")).toBe(true);
    expect(isRightClickAction("menu")).toBe(true);
    expect(isRightClickAction("copy")).toBe(false);
    expect(isRightClickAction(undefined)).toBe(false);
  });
});

describe("ctrlVPastes", () => {
  it("pastes on Windows and Linux when enabled", () => {
    expect(ctrlVPastes(true, "windows")).toBe(true);
    expect(ctrlVPastes(true, "linux")).toBe(true);
  });
  it("never on macOS — ⌘V is paste there, Ctrl+V stays a control key", () => {
    expect(ctrlVPastes(true, "macos")).toBe(false);
  });
  it("goes to the shell when disabled or the OS is not known yet", () => {
    expect(ctrlVPastes(false, "windows")).toBe(false);
    expect(ctrlVPastes(true, "")).toBe(false);
  });
});
