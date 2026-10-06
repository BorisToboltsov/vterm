import { describe, expect, it, vi } from "vitest";
import { PANEL_IDS } from "./docklayout";
import { moveLabel, moveMenuItems, moveTargets, panelLabel, tabMenuItems } from "./dockui";
import { isAction } from "./ctxmenu";

describe("panelLabel", () => {
  it("names every tool panel", () => {
    const labels = PANEL_IDS.map(panelLabel);
    expect(labels).toEqual(["Servers", "SFTP", "Git", "Docker", "k8s", "AI"]);
    // Tabs are told apart by their label alone.
    expect(new Set(labels).size).toBe(PANEL_IDS.length);
  });
});

describe("moving a panel from a menu", () => {
  it("offers the two other docks, never the one the panel is in", () => {
    expect(moveTargets("left")).toEqual(["right", "bottom"]);
    expect(moveTargets("right")).toEqual(["left", "bottom"]);
    expect(moveTargets("bottom")).toEqual(["left", "right"]);
  });

  it("labels each move by its destination", () => {
    expect(moveLabel("left")).toBe("Move to the left panel");
    expect(moveLabel("right")).toBe("Move to the right panel");
    expect(moveLabel("bottom")).toBe("Move to the bottom panel");
  });

  it("builds one menu action per target, wired to that target", () => {
    const onMove = vi.fn();
    const items = moveMenuItems("right", onMove);
    expect(items.map((i) => (isAction(i) ? i.label : ""))).toEqual([
      "Move to the left panel",
      "Move to the bottom panel",
    ]);
    for (const item of items) if (isAction(item)) item.onSelect();
    expect(onMove.mock.calls).toEqual([["left"], ["bottom"]]);
  });
});

describe("a dock tab's menu", () => {
  const labels = (items: ReturnType<typeof tabMenuItems>) =>
    items.map((i) => (isAction(i) ? i.label : `<${i.kind}>`));

  it("offers the moves, then hiding the panel", () => {
    const on = { onMove: vi.fn(), onHide: vi.fn() };
    const items = tabMenuItems("bottom", "docker", on);
    expect(labels(items)).toEqual([
      "Move to the left panel",
      "Move to the right panel",
      "<separator>",
      "Hide panel",
    ]);
    const hide = items.at(-1)!;
    if (isAction(hide)) hide.onSelect();
    expect(on.onHide).toHaveBeenCalledOnce();
    expect(on.onMove).not.toHaveBeenCalled();
  });

  it("does not offer to hide the server tree", () => {
    const items = tabMenuItems("left", "servers", { onMove: vi.fn(), onHide: vi.fn() });
    expect(labels(items)).toEqual(["Move to the right panel", "Move to the bottom panel"]);
  });
});
