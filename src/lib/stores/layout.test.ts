import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultDocks, DOCK_BOUNDS, LAYOUT_VERSION } from "../docklayout";
import { LIST_COLUMNS } from "../colwidths";
import { resetSettings, settings } from "../settings.svelte";
import { columnWidth, setColumnWidth } from "./colwidths.svelte";
import {
  activatePanel,
  isPanelHidden,
  layout,
  movePanel,
  resetLayout,
  resetPanelLayout,
  revealPanel,
  setDockCollapsed,
  setDockSize,
  setPanelHidden,
  STORAGE_KEY,
  toggleDock,
} from "./layout.svelte";

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
  resetLayout();
  resetSettings();
  flushSync();
});

describe("layout store", () => {
  it("starts from the default arrangement", () => {
    expect(layout.docks).toEqual(defaultDocks());
  });

  it("persists the whole dock configuration, collapse included", () => {
    setDockSize("left", 300);
    setDockCollapsed("right", false);
    setDockSize("bottom", 333);
    flushSync();
    const s = stored();
    expect(s.version).toBe(LAYOUT_VERSION);
    expect(s.docks.left.size).toBe(300);
    expect(s.docks.right.collapsed).toBe(false);
    expect(s.docks.bottom.size).toBe(333);
    expect(s.docks.bottom.panels).toEqual(["docker", "k8s"]);
  });

  it("moves a panel between docks and persists the move", () => {
    movePanel("docker", "left");
    flushSync();
    expect(layout.docks.left.panels).toEqual(["servers", "docker"]);
    expect(layout.docks.bottom.panels).toEqual(["k8s"]);
    expect(stored().docks.left.panels).toEqual(["servers", "docker"]);
  });

  it("does not replace the value when a move changes nothing", () => {
    const before = layout.docks;
    movePanel("servers", "left", 0);
    expect(layout.docks).toBe(before);
  });

  it("reveals a panel: its dock opens on it", () => {
    revealPanel("ai");
    expect(layout.docks.right.active).toBe("ai");
    expect(layout.docks.right.collapsed).toBe(false);
  });

  it("activates a tab without opening a collapsed dock", () => {
    activatePanel("right", "git");
    expect(layout.docks.right.active).toBe("git");
    expect(layout.docks.right.collapsed).toBe(true);
    // A panel that is not in that dock is ignored.
    activatePanel("right", "docker");
    expect(layout.docks.right.active).toBe("git");
  });

  it("toggles and clamps", () => {
    toggleDock("bottom");
    expect(layout.docks.bottom.collapsed).toBe(false);
    toggleDock("bottom");
    expect(layout.docks.bottom.collapsed).toBe(true);
    setDockSize("right", 99999);
    expect(layout.docks.right.size).toBe(DOCK_BOUNDS.right.max);
    setDockSize("left", 1);
    expect(layout.docks.left.size).toBe(DOCK_BOUNDS.left.min);
  });

  it("resets to the default arrangement", () => {
    movePanel("ai", "bottom");
    setDockSize("left", 400);
    resetLayout();
    expect(layout.docks).toEqual(defaultDocks());
  });
});

describe("hidden panels", () => {
  it("hides and brings back a panel through the settings", () => {
    expect(isPanelHidden("docker")).toBe(false);
    setPanelHidden("docker", true);
    expect(settings.hiddenPanels).toEqual(["docker"]);
    expect(isPanelHidden("docker")).toBe(true);
    setPanelHidden("docker", false);
    expect(settings.hiddenPanels).toEqual([]);
  });

  it("does not hide the server tree", () => {
    setPanelHidden("servers", true);
    expect(settings.hiddenPanels).toEqual([]);
    expect(isPanelHidden("servers")).toBe(false);
  });

  it("leaves the layout alone — the panel keeps its dock and its place", () => {
    const before = layout.docks;
    setPanelHidden("git", true);
    expect(layout.docks).toBe(before);
    expect(layout.docks.right.panels).toEqual(["files", "git", "ai"]);
  });

  it("does not replace the list when nothing changes", () => {
    setPanelHidden("git", true);
    const list = settings.hiddenPanels;
    setPanelHidden("git", true);
    expect(settings.hiddenPanels).toBe(list);
  });

  it("does not reveal a hidden panel — an indicator must not undo the setting", () => {
    setPanelHidden("ai", true);
    revealPanel("ai");
    expect(layout.docks.right.collapsed).toBe(true);
    expect(layout.docks.right.active).toBe("files");
    setPanelHidden("ai", false);
    revealPanel("ai");
    expect(layout.docks.right.collapsed).toBe(false);
    expect(layout.docks.right.active).toBe("ai");
  });
});

describe("resetPanelLayout", () => {
  it("puts back the docks and the column widths, and leaves hidden panels hidden", () => {
    movePanel("docker", "left");
    setColumnWidth("docker.image", 500);
    setPanelHidden("k8s", true);
    resetPanelLayout();
    expect(layout.docks).toEqual(defaultDocks());
    expect(columnWidth("docker.image")).toBe(LIST_COLUMNS["docker.image"]);
    // Which panels are shown is a setting, not a layout.
    expect(settings.hiddenPanels).toEqual(["k8s"]);
  });
});
