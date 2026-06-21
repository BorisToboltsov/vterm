import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readClipboard, writeClipboard } from "./clipboard";

describe("writeClipboard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the async clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await writeClipboard("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand('copy') when the async API throws", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const exec = vi.fn().mockReturnValue(true);
    // jsdom has no execCommand by default.
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;

    await writeClipboard("legacy");

    expect(exec).toHaveBeenCalledWith("copy");
    // The temporary textarea must be cleaned up.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("never throws even if both paths fail", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
    });
    (document as unknown as { execCommand: () => never }).execCommand = () => {
      throw new Error("nope");
    };
    await expect(writeClipboard("x")).resolves.toBeUndefined();
  });
});

describe("readClipboard", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the clipboard text", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn().mockResolvedValue("pasted") },
    });
    expect(await readClipboard()).toBe("pasted");
  });

  it("returns an empty string when reading fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn().mockRejectedValue(new Error("blocked")) },
    });
    expect(await readClipboard()).toBe("");
  });
});
