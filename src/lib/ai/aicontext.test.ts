import { describe, it, expect } from "vitest";
import { buildContext, contextSummary, terminalSlot, textLines, withContext, DEFAULT_TAIL_LINES } from "./aicontext";
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

  it("lets a selection win over the whole buffer — it is the narrower intent", () => {
    const c = buildContext(
      { selection: "sel", buffer: "full scrollback", tail: "tail" },
      settings({ includeBuffer: true }),
    );
    expect(c.sources).toEqual(["selection"]);
    expect(c.text).not.toContain("full scrollback");
  });

  it("an attached block takes the terminal slot; recording and metadata still add", () => {
    const c = buildContext(
      { selection: "live sel", buffer: "buf", tail: "tail", recording: "rec", metadata: "meta" },
      settings({ includeBuffer: true, includeRecording: true, includeMetadata: true }),
      { header: "Docker container", text: "container logs" },
    );
    expect(c.text).toContain("### Docker container\ncontainer logs");
    expect(c.text).not.toContain("live sel");
    expect(c.text).not.toContain("buf");
    expect(c.text).toContain("rec");
    expect(c.text).toContain("meta");
    expect(c.sources).toEqual(["buffer", "recording", "metadata"]);
  });

  it("an empty attached block falls back to the ordinary terminal slot", () => {
    const c = buildContext({ tail: "tail" }, settings(), { header: "X", text: "  \n " });
    expect(c.text).toContain("tail");
    expect(c.text).not.toContain("### X");
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

describe("textLines", () => {
  it("counts lines as sent — a trailing newline is not a line", () => {
    expect(textLines("a\nb\n")).toBe(2);
    expect(textLines("one")).toBe(1);
    expect(textLines("  \n ")).toBe(0);
    expect(textLines("")).toBe(0);
  });
});

describe("terminalSlot", () => {
  it("picks the narrowest source present", () => {
    expect(terminalSlot({ attached: true, selection: true, includeBuffer: true })).toBe("attachment");
    expect(terminalSlot({ attached: false, selection: true, includeBuffer: true })).toBe("selection");
    expect(terminalSlot({ attached: false, selection: false, includeBuffer: true })).toBe("buffer");
    expect(terminalSlot({ attached: false, selection: false, includeBuffer: false })).toBe("tail");
  });
});

describe("contextSummary", () => {
  const tiers = (over: Partial<AiSettings> = {}) => settings(over);
  const keys = (parts: ReturnType<typeof contextSummary>) => parts.map((p) => p.key);

  it("promises the selection with its line count", () => {
    const parts = contextSummary({ attached: false, selectionLines: 12, tiers: tiers(), hasRecording: false });
    expect(parts).toEqual([{ key: "ai.context.slot.selection", params: { count: "12" } }]);
  });

  it("falls back to the tail, sized like the real read", () => {
    const parts = contextSummary({ attached: false, selectionLines: 0, tiers: tiers(), hasRecording: false });
    expect(parts).toEqual([{ key: "ai.context.slot.tail", params: { count: String(DEFAULT_TAIL_LINES) } }]);
  });

  it("names the whole buffer only without a selection, and the chip above both", () => {
    const buf = tiers({ includeBuffer: true });
    expect(keys(contextSummary({ attached: false, selectionLines: 0, tiers: buf, hasRecording: false }))).toEqual([
      "ai.context.slot.buffer",
    ]);
    expect(keys(contextSummary({ attached: false, selectionLines: 3, tiers: buf, hasRecording: false }))).toEqual([
      "ai.context.slot.selection",
    ]);
    expect(keys(contextSummary({ attached: true, selectionLines: 3, tiers: buf, hasRecording: false }))).toEqual([
      "ai.context.slot.attachment",
    ]);
  });

  it("promises the recording only when one is running", () => {
    const rec = tiers({ includeRecording: true, includeMetadata: true });
    expect(keys(contextSummary({ attached: false, selectionLines: 0, tiers: rec, hasRecording: false }))).toEqual([
      "ai.context.slot.tail",
      "ai.context.plusMetadata",
    ]);
    expect(keys(contextSummary({ attached: false, selectionLines: 0, tiers: rec, hasRecording: true }))).toEqual([
      "ai.context.slot.tail",
      "ai.context.plusRecording",
      "ai.context.plusMetadata",
    ]);
  });

  it("agrees with buildContext on the slot", () => {
    // The caption must promise what gets built: same inputs, same choice.
    for (const includeBuffer of [false, true]) {
      for (const sel of ["", "picked"]) {
        const s = tiers({ includeBuffer });
        const built = buildContext({ selection: sel, buffer: "BUF", tail: "TAIL" }, s);
        const [part] = contextSummary({ attached: false, selectionLines: textLines(sel), tiers: s, hasRecording: false });
        const expected = sel ? "picked" : includeBuffer ? "BUF" : "TAIL";
        expect(built.text).toContain(expected);
        expect(part.key).toBe(
          sel ? "ai.context.slot.selection" : includeBuffer ? "ai.context.slot.buffer" : "ai.context.slot.tail",
        );
      }
    }
  });
});
