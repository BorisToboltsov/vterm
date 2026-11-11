import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ContextMenu from "./ContextMenu.svelte";
import type { OpenMenu } from "./ctxmenu";

function menu(): OpenMenu {
  return { x: 1000, y: 700, items: [
    { kind: "submenu", key: "view", label: "View", items: [{ label: "Hidden files", checked: false, onSelect: vi.fn() }] },
    { kind: "submenu", key: "folder", label: "Folder", items: [{ label: "Refresh", onSelect: vi.fn() }] },
  ] };
}

function resize(el: HTMLElement, width: number, height: number) {
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: height });
  const observers = (ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }).instances;
  for (const observer of observers) observer.cb([{ target: el }]);
}

describe("context menu expansion", () => {
  it("navigates nested groups with arrows, skips disabled rows and activates with Enter", async () => {
    const pick = vi.fn();
    const onclose = vi.fn();
    render(ContextMenu, { menu: { x: 0, y: 0, items: [
      { label: "Disabled", disabled: true, onSelect: vi.fn() }, { kind: "separator" },
      { kind: "submenu", key: "view", label: "View", items: [
        { label: "Disabled child", disabled: true, onSelect: vi.fn() },
        { kind: "submenu", key: "sort", label: "Sort", items: [{ label: "Name", checked: true, onSelect: pick }] },
      ] },
      { label: "Last", onSelect: pick },
    ] }, onclose });
    const view = screen.getByRole("menuitem", { name: "View" });
    await waitFor(() => expect(view).toHaveFocus());
    await fireEvent.keyDown(view, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
    await fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(view).toHaveFocus();
    await fireEvent.keyDown(view, { key: "ArrowRight" });
    const sort = screen.getByRole("menuitem", { name: "Sort" });
    await waitFor(() => expect(sort).toHaveFocus());
    await fireEvent.keyDown(sort, { key: "ArrowRight" });
    const name = screen.getByRole("menuitemcheckbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveFocus());
    await fireEvent.keyDown(name, { key: "ArrowLeft" });
    expect(sort).toHaveFocus();
    expect(sort).toHaveAttribute("aria-expanded", "false");
    await fireEvent.keyDown(sort, { key: " " });
    expect(sort).toHaveAttribute("aria-expanded", "true");
    await fireEvent.keyDown(sort, { key: "ArrowLeft" });
    expect(sort).toHaveAttribute("aria-expanded", "false");
    await fireEvent.keyDown(sort, { key: "Home" });
    expect(view).toHaveFocus();
    await fireEvent.keyDown(view, { key: "End" });
    await fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(pick).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it.each(["Escape", "Tab"])("%s restores focus and never reaches the dialog or terminal below", async (key) => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const underlying = vi.fn();
    window.addEventListener("keydown", underlying);
    const onclose = vi.fn();
    const { unmount } = render(ContextMenu, { menu: menu(), onclose });
    try {
      await waitFor(() => expect(screen.getByRole("menuitem", { name: "View" })).toHaveFocus());
      await fireEvent.keyDown(document.activeElement!, { key });
      expect(onclose).toHaveBeenCalledOnce();
      expect(underlying).not.toHaveBeenCalled();
      expect(opener).toHaveFocus();
    } finally {
      unmount();
      window.removeEventListener("keydown", underlying);
      opener.remove();
    }
  });

  it("keeps focus selected by an action after the popup is removed", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    const { rerender, unmount } = render(ContextMenu, { menu: { x: 0, y: 0, items: [
      { label: "Find", onSelect: () => field.focus() },
    ] }, onclose: vi.fn() });
    try {
      await fireEvent.click(screen.getByRole("menuitem", { name: "Find" }));
      await rerender({ menu: null, onclose: vi.fn() });
      expect(field).toHaveFocus();
    } finally { unmount(); field.remove(); }
  });

  it("leaves keys to an overlay that took focus after the menu opened", async () => {
    const { unmount } = render(ContextMenu, { menu: menu(), onclose: vi.fn() });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "View" })).toHaveFocus());
    const field = document.createElement("input");
    document.body.append(field);
    const onKey = vi.fn();
    field.addEventListener("keydown", onKey);
    try {
      field.focus();
      await fireEvent.keyDown(field, { key: "ArrowDown" });
      expect(field).toHaveFocus();
      expect(onKey).toHaveBeenCalledOnce();
    } finally { unmount(); field.remove(); }
  });

  it("focuses an empty menu without activating disabled items", async () => {
    const pick = vi.fn();
    render(ContextMenu, { menu: { x: 0, y: 0, items: [{ label: "Unavailable", disabled: true, onSelect: pick }] }, onclose: vi.fn() });
    const popup = screen.getByRole("menu");
    await waitFor(() => expect(popup).toHaveFocus());
    await fireEvent.keyDown(popup, { key: "ArrowDown" });
    await fireEvent.keyDown(popup, { key: "Enter" });
    expect(pick).not.toHaveBeenCalled();
  });

  it("keeps a nested group's parent open, replaces its sibling and closes on a leaf", async () => {
    const onclose = vi.fn();
    const pick = vi.fn();
    render(ContextMenu, { menu: { x: 0, y: 0, items: [
      { kind: "submenu", key: "view", label: "View", items: [
        { kind: "submenu", key: "sort", label: "Sort", items: [{ label: "Name", checked: true, onSelect: pick }] },
        { kind: "submenu", key: "columns", label: "Columns", items: [
          { kind: "separator" }, { label: "IP", checked: false, onSelect: pick },
        ] },
      ] },
    ] }, onclose });
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Sort" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Name" })).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(screen.getByRole("menuitem", { name: "Columns" }));
    expect(screen.queryByRole("menuitemcheckbox", { name: "Name" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "View" })).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(screen.getByRole("menuitem", { name: "Columns" }));
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Sort" }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Name" }));
    expect(onclose).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledOnce();
  });

  it("opens only one group and resets it for a new menu", async () => {
    const { rerender } = render(ContextMenu, { menu: menu(), onclose: vi.fn() });
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    expect(screen.getByRole("menuitemcheckbox")).toHaveAttribute("aria-checked", "false");
    await fireEvent.click(screen.getByRole("menuitem", { name: "Folder" }));
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toBeInTheDocument();
    await rerender({ menu: menu(), onclose: vi.fn() });
    expect(screen.queryByRole("menuitem", { name: "Refresh" })).toBeNull();
  });

  it("clamps again when a group increases its height near the bottom edge", async () => {
    render(ContextMenu, { menu: menu(), onclose: vi.fn() });
    const popup = screen.getByRole("menu");
    resize(popup, 240, 120);
    await waitFor(() => expect(popup.style.top).toBe(`${window.innerHeight - 124}px`));
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    resize(popup, 240, 360);
    await waitFor(() => expect(popup.style.top).toBe(`${window.innerHeight - 364}px`));
    expect(popup.style.left).toBe(`${window.innerWidth - 244}px`);
  });

  it("closes before invoking an action and ignores a disabled action", async () => {
    const calls: string[] = [];
    const disabled = vi.fn();
    render(ContextMenu, { menu: { x: 0, y: 0, items: [
      { label: "Unavailable", disabled: true, onSelect: disabled },
      { label: "Open", onSelect: () => calls.push("action") },
    ] }, onclose: () => calls.push("close") });
    await fireEvent.click(screen.getByRole("menuitem", { name: "Unavailable" }));
    expect(disabled).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(calls).toEqual(["close", "action"]);
  });
});
