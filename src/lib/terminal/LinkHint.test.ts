import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LinkHint from "./LinkHint.svelte";
import { setLocale } from "../i18n";
import { currentLinkHint, dismissLinkHint, modifierHeld, setModifierHeld, showLinkHint } from "../stores/linkhint.svelte";

describe("LinkHint", () => {
  beforeEach(() => {
    dismissLinkHint();
    setModifierHeld(false);
    setLocale("ru");
    flushSync();
  });

  function shown(kind: "web" | "file" | "dir" | "path" = "file") {
    const act = vi.fn();
    render(LinkHint);
    showLinkHint({ x: 100, y: 120 }, kind, act);
    flushSync();
    return act;
  }

  it("says where the link opens and that ⌘/Ctrl-click opens it, and opens nothing by itself", () => {
    const act = shown("web");
    const hint = screen.getByTestId("link-hint");
    expect(hint.textContent).toContain("Открыть в браузере");
    expect(hint.textContent).toMatch(/(⌘|Ctrl)-клик/);
    expect(act).not.toHaveBeenCalled();
  });

  it("names the editor, the file panel, or just opening", () => {
    shown("file");
    expect(screen.getByTestId("link-hint").textContent).toContain("Открыть в редакторе");
    dismissLinkHint();
    showLinkHint({ x: 1, y: 1 }, "dir", () => {});
    flushSync();
    expect(screen.getByTestId("link-hint").textContent).toContain("Открыть в панели файлов");
    showLinkHint({ x: 1, y: 1 }, "path", () => {});
    flushSync();
    expect(screen.getByTestId("link-hint-open").textContent?.trim()).toBe("Открыть");
  });

  it("its button opens as ⌘-click does, and the hint goes", async () => {
    const act = shown();
    await fireEvent.pointerDown(screen.getByTestId("link-hint-open"));
    expect(currentLinkHint()).not.toBeNull();
    await fireEvent.click(screen.getByTestId("link-hint-open"));
    expect(act).toHaveBeenCalledOnce();
    expect(currentLinkHint()).toBeNull();
    expect(screen.queryByTestId("link-hint")).toBeNull();
  });

  it("goes with Esc, which reaches nothing else — not the shell", () => {
    const act = shown();
    const behind = vi.fn();
    document.body.addEventListener("keydown", behind);
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      flushSync();
      expect(currentLinkHint()).toBeNull();
      expect(behind).not.toHaveBeenCalled();
      expect(act).not.toHaveBeenCalled();
    } finally {
      document.body.removeEventListener("keydown", behind);
    }
  });

  it("goes with any other key, which goes on to the terminal; a modifier alone keeps it", () => {
    shown();
    const behind = vi.fn();
    document.body.addEventListener("keydown", behind);
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }));
      flushSync();
      expect(currentLinkHint()).not.toBeNull();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
      flushSync();
      expect(currentLinkHint()).toBeNull();
      expect(behind).toHaveBeenCalledTimes(2);
    } finally {
      document.body.removeEventListener("keydown", behind);
    }
  });

  it("goes with a press elsewhere, the wheel, or the window losing focus", async () => {
    shown();
    await fireEvent.pointerDown(document.body);
    expect(currentLinkHint()).toBeNull();
    showLinkHint({ x: 1, y: 1 }, "file", () => {});
    await fireEvent.wheel(window);
    expect(currentLinkHint()).toBeNull();
    showLinkHint({ x: 1, y: 1 }, "file", () => {});
    await fireEvent.blur(window);
    expect(currentLinkHint()).toBeNull();
  });

  it("stays while the pointer is near the click and goes once it wanders off", async () => {
    shown();
    await fireEvent.pointerMove(document.body, { clientX: 140, clientY: 150 });
    expect(currentLinkHint()).not.toBeNull();
    await fireEvent.pointerMove(document.body, { clientX: 400, clientY: 400 });
    expect(currentLinkHint()).toBeNull();
  });

  it("tells the store whether the modifier is held", () => {
    render(LinkHint);
    const key = (type: string, init: KeyboardEventInit) =>
      document.body.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
    // hostEnv has not resolved the OS here: off macOS the modifier is Ctrl.
    key("keydown", { key: "Control", ctrlKey: true });
    expect(modifierHeld()).toBe(true);
    key("keyup", { key: "Control", ctrlKey: false });
    expect(modifierHeld()).toBe(false);
  });
});
