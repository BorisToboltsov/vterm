import { describe, it, expect } from "vitest";
import { buildContext, withContext, DEFAULT_TAIL_LINES } from "./aicontext";
import { defaultAiSettings, type AiSettings } from "./ai";
import { REDACTED } from "./redact";

function settings(over: Partial<AiSettings> = {}): AiSettings {
  return { ...defaultAiSettings(), ...over };
}

describe("buildContext", () => {
  it("is empty when nothing is collected", () => {
    const c = buildContext({}, settings());
    expect(c.text).toBe("");
    expect(c.lines).toBe(0);
    expect(c.sources).toEqual([]);
  });

  it("prefers the selection over the tail by default", () => {
    const c = buildContext(
      { selection: "selected text", tail: "tail line" },
      settings(),
    );
    expect(c.sources).toEqual(["selection"]);
    expect(c.text).toContain("selected text");
    expect(c.text).not.toContain("tail line");
  });

  it("falls back to the tail when there is no selection", () => {
    const c = buildContext({ tail: "recent output" }, settings());
    expect(c.sources).toEqual(["buffer"]);
    expect(c.text).toContain("recent output");
  });

  it("attaches the whole buffer (superseding the tail) when includeBuffer is on", () => {
    const c = buildContext(
      { buffer: "full scrollback", tail: "just the tail" },
      settings({ includeBuffer: true }),
    );
    expect(c.sources).toEqual(["buffer"]);
    expect(c.text).toContain("full scrollback");
    expect(c.text).not.toContain("just the tail");
  });

  it("keeps both selection and buffer when both apply", () => {
    const c = buildContext(
      { selection: "sel", buffer: "buf" },
      settings({ includeBuffer: true }),
    );
    expect(c.sources).toEqual(["selection", "buffer"]);
  });

  it("includes recording and metadata only when their tiers are on", () => {
    const off = buildContext(
      { tail: "t", recording: "rec", metadata: "meta" },
      settings(),
    );
    expect(off.sources).toEqual(["buffer"]);

    const on = buildContext(
      { tail: "t", recording: "rec", metadata: "meta" },
      settings({ includeRecording: true, includeMetadata: true }),
    );
    expect(on.sources).toEqual(["buffer", "recording", "metadata"]);
    expect(on.text).toContain("rec");
    expect(on.text).toContain("meta");
  });

  it("redacts secrets and counts them across sections", () => {
    const c = buildContext(
      { selection: "export TOKEN=abc", metadata: "PGPASSWORD=xyz" },
      settings({ includeMetadata: true }),
    );
    expect(c.redactions).toBe(2);
    expect(c.text).toContain(REDACTED);
    expect(c.text).not.toContain("abc");
    expect(c.text).not.toContain("xyz");
  });

  it("counts payload lines including section headers", () => {
    const c = buildContext({ tail: "one\ntwo" }, settings());
    // header line + two content lines
    expect(c.lines).toBe(3);
  });

  it("skips whitespace-only sources", () => {
    const c = buildContext({ selection: "   \n  ", tail: "real" }, settings());
    expect(c.sources).toEqual(["buffer"]);
  });
});

describe("withContext", () => {
  it("returns the bare question when there is no context", () => {
    expect(withContext("", "what is up")).toBe("what is up");
  });

  it("fences the context above the question", () => {
    const merged = withContext("### Terminal\nfoo", "explain this");
    expect(merged).toContain("### Terminal\nfoo");
    expect(merged).toContain("explain this");
    expect(merged.indexOf("foo")).toBeLessThan(merged.indexOf("explain this"));
  });
});

describe("DEFAULT_TAIL_LINES", () => {
  it("is a sane positive tail size", () => {
    expect(DEFAULT_TAIL_LINES).toBeGreaterThan(0);
  });
});
