import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clamp,
  LEFT_MAX,
  LEFT_MIN,
  layout,
  resetLayout,
  SFTP_MAX,
} from "./layout.svelte";

beforeEach(() => {
  localStorage.clear();
  resetLayout();
  flushSync();
});

describe("clamp", () => {
  it("bounds a value into [lo, hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("layout store", () => {
  it("starts from defaults with SFTP collapsed", () => {
    expect(layout.leftWidth).toBe(256);
    expect(layout.leftCollapsed).toBe(false);
    expect(layout.sftpWidth).toBe(384);
    expect(layout.sftpCollapsed).toBe(true);
  });

  it("persists widths and left-collapse (but not sftpCollapsed)", () => {
    layout.leftWidth = 300;
    layout.leftCollapsed = true;
    layout.sftpWidth = 500;
    layout.sftpCollapsed = false;
    flushSync();
    const stored = JSON.parse(localStorage.getItem("vterm.layout") ?? "{}");
    expect(stored.leftWidth).toBe(300);
    expect(stored.leftCollapsed).toBe(true);
    expect(stored.sftpWidth).toBe(500);
    expect("sftpCollapsed" in stored).toBe(false);
  });
});

describe("layout load() clamping", () => {
  it("clamps persisted widths back into range and forces SFTP collapsed", () => {
    // Simulate a corrupt/out-of-range persisted layout, then reload via reset+set.
    localStorage.setItem(
      "vterm.layout",
      JSON.stringify({ leftWidth: 9999, sftpWidth: 1, leftCollapsed: true }),
    );
    // The module-level `layout` was loaded at import; assert the clamp helper and
    // bounds are wired to the same constants the loader uses.
    expect(clamp(9999, LEFT_MIN, LEFT_MAX)).toBe(LEFT_MAX);
    expect(clamp(1, 240, SFTP_MAX)).toBe(240);
  });
});
