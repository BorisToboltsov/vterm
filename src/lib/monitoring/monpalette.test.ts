import { describe, expect, it } from "vitest";
import { levelDot, levelFill, SERIES, tcpColor } from "./monpalette";

describe("monitoring colours", () => {
  it("draws every series in a theme line colour, never a fixed hex", () => {
    for (const c of Object.values(SERIES)) expect(c).toMatch(/^var\(--color-rail-[0-6]\)$/);
  });

  it("colours a TCP state by its name, so a new state repaints nothing", () => {
    expect(tcpColor("ESTAB")).toBe(tcpColor("estab"));
    expect(tcpColor("LISTEN")).not.toBe(tcpColor("ESTAB"));
    expect(tcpColor("UNKNOWN-STATE")).toBe("var(--color-rail-6)");
  });

  it("takes state colours from the semantic tokens", () => {
    expect([levelFill("ok"), levelFill("warn"), levelFill("crit")]).toEqual([
      "var(--color-accent)",
      "var(--color-warn)",
      "var(--color-bad)",
    ]);
    expect(levelDot("ok")).toBe("var(--color-ok)");
  });
});
