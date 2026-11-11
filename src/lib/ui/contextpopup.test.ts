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
