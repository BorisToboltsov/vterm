import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isWide, WIDE_REM } from "./panelwide";

describe("isWide", () => {
  it("is the container breakpoint: wide from 48rem up", () => {
    expect(isWide(767)).toBe(false);
    expect(isWide(768)).toBe(true);
    expect(isWide(1400)).toBe(true);
    expect(isWide(0)).toBe(false);
  });

  it("follows the root font size, as a container query does", () => {
    expect(isWide(800, 20)).toBe(false);
    expect(isWide(960, 20)).toBe(true);
  });

  it("is narrow for a width it cannot read", () => {
    expect(isWide(Number.NaN)).toBe(false);
    expect(isWide(1000, 0)).toBe(false);
  });

  it("is the same threshold the `@wide:` variants use", () => {
    // One number, two readers: a panel that measures itself and a panel laid out
    // by a container query must switch at the same width.
    const css = readFileSync(join(process.cwd(), "src", "app.css"), "utf8");
    expect(css).toMatch(new RegExp(`--container-wide:\\s*${WIDE_REM}rem;`));
  });
});
