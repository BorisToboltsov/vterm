import { describe, it, expect } from "vitest";
import { buildRunbookContext } from "./airunbook";
import { REDACTED } from "./redact";

describe("buildRunbookContext", () => {
  it("redacts secrets and counts them", () => {
    const ctx = buildRunbookContext("export TOKEN=abc123\nsystemctl restart app");
    expect(ctx.text).toContain(REDACTED);
    expect(ctx.text).not.toContain("abc123");
    expect(ctx.redactions).toBe(1);
    expect(ctx.sources).toEqual(["recording"]);
  });

  it("counts transcript lines and trims trailing whitespace", () => {
    const ctx = buildRunbookContext("one\ntwo\nthree\n\n\n");
    expect(ctx.lines).toBe(3);
  });

  it("is empty for a blank transcript", () => {
    const ctx = buildRunbookContext("   \n  \n");
    expect(ctx.text).toBe("");
    expect(ctx.lines).toBe(0);
    expect(ctx.redactions).toBe(0);
  });
});
