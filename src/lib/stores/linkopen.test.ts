import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));
const writeClipboard = vi.fn().mockResolvedValue(undefined);
vi.mock("../app/clipboard", () => ({
  writeClipboard: (...a: unknown[]) => writeClipboard(...a),
}));

import { settings } from "../settings/settings.svelte";
import { answerLink, clickLink, currentLinkQuestion, terminalLinkHandler } from "./linkopen.svelte";
import { clearToasts, toastsState } from "./toasts.svelte";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a click on a terminal link", () => {
  beforeEach(() => {
    openUrl.mockClear();
    writeClipboard.mockClear();
    answerLink("cancel");
    settings.terminalLinks = "confirm";
    clearToasts();
    flushSync();
  });

  it("asks first by default and opens on the answer", () => {
    clickLink("https://example.com/x");
    expect(openUrl).not.toHaveBeenCalled();
    expect(currentLinkQuestion()?.target.href).toBe("https://example.com/x");
    answerLink("open");
    expect(currentLinkQuestion()).toBeNull();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/x");
    expect(settings.terminalLinks).toBe("confirm");
  });

  it("opens right away in direct mode, and never in off mode", () => {
    settings.terminalLinks = "direct";
    clickLink("https://example.com/");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/");
    expect(currentLinkQuestion()).toBeNull();
    openUrl.mockClear();
    settings.terminalLinks = "off";
    clickLink("https://example.com/");
    expect(openUrl).not.toHaveBeenCalled();
    expect(currentLinkQuestion()).toBeNull();
  });

  it("never hands another scheme to the browser", () => {
    settings.terminalLinks = "direct";
    clickLink("file:///etc/passwd");
    clickLink("javascript:alert(1)");
    expect(openUrl).not.toHaveBeenCalled();
    expect(currentLinkQuestion()).toBeNull();
  });

  it("“don't ask again” switches to direct mode — only when the link is opened", () => {
    clickLink("https://example.com/");
    answerLink("cancel", true);
    expect(settings.terminalLinks).toBe("confirm");
    clickLink("https://example.com/");
    answerLink("copy", true);
    expect(settings.terminalLinks).toBe("confirm");
    clickLink("https://example.com/");
    answerLink("open", true);
    expect(settings.terminalLinks).toBe("direct");
  });

  it("a misleading OSC 8 link asks in direct mode and cannot silence the question", () => {
    settings.terminalLinks = "direct";
    clickLink("https://evil.io/", "github.com");
    expect(openUrl).not.toHaveBeenCalled();
    expect(currentLinkQuestion()).toMatchObject({ shown: "github.com", canSilence: false });
    settings.terminalLinks = "confirm";
    answerLink("open", true);
    expect(openUrl).toHaveBeenCalledWith("https://evil.io/");
    expect(settings.terminalLinks).toBe("confirm");
  });

  it("copy puts the address on the clipboard and says so", async () => {
    clickLink("https://example.com/a b");
    answerLink("copy");
    await flush();
    expect(writeClipboard).toHaveBeenCalledWith("https://example.com/a%20b");
    expect(openUrl).not.toHaveBeenCalled();
    expect(toastsState.list.map((x) => x.kind)).toEqual(["success"]);
  });

  it("a browser that cannot be started is reported", async () => {
    openUrl.mockRejectedValueOnce(new Error("no handler"));
    settings.terminalLinks = "direct";
    clickLink("https://example.com/");
    await flush();
    expect(toastsState.list.map((x) => x.kind)).toEqual(["error"]);
  });

  it("an http link is never opened, only copied", async () => {
    settings.terminalLinks = "direct";
    clickLink("http://localhost:8080/");
    expect(currentLinkQuestion()?.target.openable).toBe(false);
    answerLink("open", true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(settings.terminalLinks).toBe("direct");
    clickLink("http://localhost:8080/");
    answerLink("copy");
    await flush();
    expect(writeClipboard).toHaveBeenCalledWith("http://localhost:8080/");
  });

  it("an answer with no question does nothing", () => {
    answerLink("open", true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(settings.terminalLinks).toBe("confirm");
  });
});

describe("the xterm link handler", () => {
  beforeEach(() => {
    openUrl.mockClear();
    answerLink("cancel");
    settings.terminalLinks = "direct";
  });

  const buffer = (lines: string[]) => ({
    getLine: (y: number) =>
      lines[y] === undefined
        ? undefined
        : {
            translateToString: (_trim?: boolean, start = 0, end?: number) =>
              lines[y].slice(start, end),
          },
  });
  const range = (y: number, x1: number, x2: number) => ({
    start: { x: x1, y },
    end: { x: x2, y },
  });
  const click = {} as MouseEvent;

  it("reads the text shown over the link and asks when it names another site", () => {
    const handler = terminalLinkHandler(() => buffer(["", "see github.com now"]));
    handler.activate(click, "https://evil.io/", range(2, 5, 14));
    expect(openUrl).not.toHaveBeenCalled();
    expect(currentLinkQuestion()?.shown).toBe("github.com");
  });

  it("opens a link whose text claims no site", () => {
    const handler = terminalLinkHandler(() => buffer(["open the docs"]));
    handler.activate(click, "https://example.com/docs", range(1, 10, 13));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });
});
