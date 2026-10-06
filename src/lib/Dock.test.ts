import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet, flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import Dock from "./Dock.svelte";
import DockDragGhost from "./DockDragGhost.svelte";
import { BOTTOM_MAX_SHARE, DOCK_BOUNDS, type PanelId } from "./docklayout";
import { resetSettings, settings } from "./settings.svelte";
import { cancelPanelDrag, dockDrag } from "./stores/dockdrag.svelte";
import {
  layout,
  movePanel,
  resetLayout,
  setDockCollapsed,
  setPanelHidden,
} from "./stores/layout.svelte";
import { toastsState } from "./stores/toasts.svelte";

// The `panel` snippet a page would supply, reduced to a probe: it records every
// mount and unmount (so "kept, not destroyed" is checked on the component's
// lifetime, not on a class name) and keeps the `visible` getter it was handed.
let mounts: string[] = [];
let unmounts: string[] = [];
let visibleOf: Record<string, () => boolean> = {};
// The same, per session: `"s1/files"` for a session panel, the bare id for the tree.
let sessionMounts: string[] = [];
let sessionUnmounts: string[] = [];
let visibleIn: Record<string, () => boolean> = {};

const panel = createRawSnippet<[PanelId, boolean, string | null]>((id, visible, sid) => ({
  render: () => `<div data-probe="${id()}"></div>`,
  setup: () => {
    const key = id();
    const full = sid() === null ? key : `${sid()}/${key}`;
    mounts.push(key);
    sessionMounts.push(full);
    visibleOf[key] = visible;
    visibleIn[full] = visible;
    return () => {
      unmounts.push(key);
      sessionUnmounts.push(full);
    };
  },
}));

const pane = (id: PanelId) => screen.queryByTestId(`dock-pane-${id}`);

beforeEach(() => {
  localStorage.clear();
  cancelPanelDrag();
  resetLayout();
  resetSettings();
  flushSync();
  mounts = [];
  unmounts = [];
  visibleOf = {};
  sessionMounts = [];
  sessionUnmounts = [];
  visibleIn = {};
});

describe("Dock — what it offers", () => {
  it("shows the server tree with no session, and nothing session-bound", () => {
    movePanel("docker", "left");
    render(Dock, { props: { side: "left", panel } });
    expect(screen.getByTestId("dock-tab-servers")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-tab-docker")).toBeNull();
    // Docker was the stored tab; without a session the dock falls back.
    expect(pane("servers")).not.toHaveClass("hidden");
    expect(layout.docks.left.active).toBe("docker");
  });

  it("is not drawn at all when none of its panels can be shown", () => {
    render(Dock, { props: { side: "right", panel } });
    expect(screen.queryByTestId("dock-right")).toBeNull();
    expect(mounts).toEqual([]);
  });

  it("offers its session panels once there is a session", () => {
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });
    for (const id of ["files", "git", "ai"]) {
      expect(screen.getByTestId(`dock-vtab-${id}`)).toBeInTheDocument();
    }
  });
});

describe("Dock — chrome", () => {
  it("makes the left dock's tab strip as tall as the terminal tab bar it stands next to", () => {
    // Both are `min-h-8` (32px): their bottom borders have to form one line across
    // the window. The right dock sits under that bar and keeps its natural height.
    const { rerender } = render(Dock, { props: { side: "left", panel } });
    const strip = screen.getByTestId("dock-strip-left");
    expect(strip).toHaveClass("min-h-8");
    expect(strip.style.height).toBe("");
    // The bar grows when a tab opens; the strip follows the measured height.
    void rerender({ stripHeight: 37 });
    flushSync();
    expect(strip.style.height).toBe("37px");
  });

  it("gives the right dock's strip a height only when it stands next to a pane's strip", () => {
    // Unsplit, the terminal tab bar spans the row above the right dock and the
    // page hands it no height. Split, the dock rises next to the panes' strips.
    setDockCollapsed("right", false);
    const { rerender } = render(Dock, {
      props: { side: "right", sessionId: "s1", connection: "connected", panel },
    });
    const right = screen.getByTestId("dock-strip-right");
    expect(right).not.toHaveClass("min-h-8");
    expect(right.style.height).toBe("");
    void rerender({ stripHeight: 37 });
    flushSync();
    expect(right.style.height).toBe("37px");
    // The bottom dock's strip is its own collapsed state and never follows a pane.
    render(Dock, {
      props: { side: "bottom", sessionId: "s1", connection: "connected", stripHeight: 37, panel },
    });
    expect(screen.getByTestId("dock-strip-bottom").style.height).toBe("");
  });

  it("puts the collapse button on the inner edge of a side dock and in the bottom dock's left corner", () => {
    setDockCollapsed("right", false);
    render(Dock, { props: { side: "left", panel } });
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    const left = screen.getByTestId("dock-strip-left");
    const right = screen.getByTestId("dock-strip-right");
    const bottom = screen.getByTestId("dock-strip-bottom");
    expect(left.lastElementChild).toBe(screen.getByTestId("dock-toggle-left"));
    expect(right.firstElementChild).toBe(screen.getByTestId("dock-toggle-right"));
    // Bottom: the arrow leads the strip, in its own corner cell; the tabs follow.
    const corner = screen.getByTestId("dock-corner-left");
    expect(bottom.firstElementChild).toBe(corner);
    expect(corner).toContainElement(screen.getByTestId("dock-toggle-bottom"));
    expect(bottom.lastElementChild).toBe(screen.getByTestId("dock-tab-k8s"));
  });

  it("lines the bottom dock's corner up with the left rail: same width, button centred, a border down", () => {
    // The rail above is `w-9` with its own button centred in it. The corner cell
    // under it has to be the same box, or the two arrows stand 6px apart and the
    // rail's border stops dead on top of the strip.
    render(Dock, { props: { side: "left", panel } });
    setDockCollapsed("left", true);
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    flushSync();
    const rail = screen.getByTestId("dock-expand-left").parentElement!;
    const corner = screen.getByTestId("dock-corner-left");
    expect(rail).toHaveClass("w-9", "items-center");
    expect(corner).toHaveClass("w-9", "items-center", "justify-center", "border-r", "border-edge");
  });

  it("ends the bottom strip with a cell under the right dock only while that dock is a rail", () => {
    // Its only job is to carry the rail's border down to the status bar.
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    const cell = screen.getByTestId("dock-corner-right");
    expect(cell).toHaveClass("ml-auto", "w-9", "border-l", "border-edge");
    expect(screen.getByTestId("dock-strip-bottom").lastElementChild).toBe(cell);
    // Right dock open: its border is elsewhere, and an empty cell means nothing.
    setDockCollapsed("right", false);
    flushSync();
    expect(screen.queryByTestId("dock-corner-right")).toBeNull();
    // Right dock with nothing to show (all hidden): there is no rail at all.
    setDockCollapsed("right", true);
    for (const id of ["files", "git", "ai"] as const) setPanelHidden(id, true);
    flushSync();
    expect(screen.queryByTestId("dock-corner-right")).toBeNull();
  });

  it("has no rail cell under a right dock that has no session to show", () => {
    render(Dock, { props: { side: "bottom", panel } });
    expect(screen.queryByTestId("dock-bottom")).toBeNull();
    movePanel("servers", "bottom");
    flushSync();
    expect(screen.getByTestId("dock-bottom")).toBeInTheDocument();
    expect(screen.queryByTestId("dock-corner-right")).toBeNull();
  });
});

describe("Dock — hidden panels", () => {
  const right = () =>
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });

  it("does not offer a hidden panel, and falls back from it", () => {
    setDockCollapsed("right", false);
    layout.docks.right.active = "git";
    setPanelHidden("git", true);
    right();
    expect(screen.queryByTestId("dock-tab-git")).toBeNull();
    expect(mounts).toEqual(["files"]);
    // The layout still has it, in its place — that is how it comes back.
    expect(layout.docks.right.panels).toEqual(["files", "git", "ai"]);
    expect(layout.docks.right.active).toBe("git");
  });

  it("removes a panel the moment it is hidden, and puts it back where it was", () => {
    setDockCollapsed("right", false);
    layout.docks.right.active = "git";
    right();
    expect(mounts).toEqual(["git"]);
    setPanelHidden("git", true);
    flushSync();
    // Gone from the DOM: a hidden panel must not keep polling behind the scenes.
    expect(unmounts).toEqual(["git"]);
    expect(pane("git")).toBeNull();
    setPanelHidden("git", false);
    flushSync();
    const order = [...screen.getByTestId("dock-strip-right").querySelectorAll("[data-dock-tab]")];
    expect(order.map((el) => el.textContent?.trim())).toEqual(["SFTP", "Git", "AI"]);
    expect(pane("git")).not.toHaveClass("hidden");
  });

  it("is not drawn at all when every panel in it is hidden", () => {
    setPanelHidden("docker", true);
    setPanelHidden("k8s", true);
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    expect(screen.queryByTestId("dock-bottom")).toBeNull();
  });

  it("hides a panel from its tab's menu and says where to bring it back", async () => {
    setDockCollapsed("right", false);
    right();
    await fireEvent.contextMenu(screen.getByTestId("dock-tab-git"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Hide panel" }));
    expect(settings.hiddenPanels).toEqual(["git"]);
    expect(screen.queryByTestId("dock-tab-git")).toBeNull();
    expect(toastsState.list.at(-1)?.message).toContain("Settings → Appearance → Panels");
    expect(toastsState.list.at(-1)?.message).toContain("Git");
  });

  it("offers no way to hide the server tree", async () => {
    render(Dock, { props: { side: "left", panel } });
    await fireEvent.contextMenu(screen.getByTestId("dock-tab-servers"));
    expect(screen.getByRole("menuitem", { name: "Move to the right panel" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Hide panel" })).toBeNull();
  });
});

describe("Dock — panels are kept, not rebuilt", () => {
  const open = () =>
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });

  it("mounts nothing while collapsed, then the tab that is opened", async () => {
    open();
    expect(mounts).toEqual([]);
    await fireEvent.click(screen.getByTestId("dock-vtab-git"));
    expect(layout.docks.right.collapsed).toBe(false);
    expect(mounts).toEqual(["git"]);
    expect(visibleOf.git()).toBe(true);
  });

  it("hides the previous panel on a tab switch instead of destroying it", async () => {
    setDockCollapsed("right", false);
    open();
    expect(mounts).toEqual(["files"]);
    await fireEvent.click(screen.getByTestId("dock-tab-git"));
    expect(mounts).toEqual(["files", "git"]);
    expect(unmounts).toEqual([]);
    expect(pane("files")).toHaveClass("hidden");
    expect(visibleOf.files()).toBe(false);
    expect(visibleOf.git()).toBe(true);
    // Coming back shows the same instance again.
    await fireEvent.click(screen.getByTestId("dock-tab-files"));
    expect(mounts).toEqual(["files", "git"]);
    expect(visibleOf.files()).toBe(true);
  });

  it("keeps the panels through a collapse, but tells them they are off screen", async () => {
    setDockCollapsed("right", false);
    open();
    await fireEvent.click(screen.getByTestId("dock-toggle-right"));
    expect(layout.docks.right.collapsed).toBe(true);
    expect(unmounts).toEqual([]);
    expect(visibleOf.files()).toBe(false);
    await fireEvent.click(screen.getByTestId("dock-expand-right"));
    expect(mounts).toEqual(["files"]);
    expect(visibleOf.files()).toBe(true);
  });

  it("rebuilds session panels for another session and leaves the server tree alone", async () => {
    movePanel("files", "left");
    const { rerender } = render(Dock, {
      props: { side: "left", sessionId: "s1", connection: "connected", panel },
    });
    await fireEvent.click(screen.getByTestId("dock-tab-servers"));
    expect(mounts).toEqual(["files", "servers"]);
    await rerender({ sessionId: "s2" });
    // The file panel of s1 is gone; the tree — a global panel — is the same instance.
    expect(unmounts).toEqual(["files"]);
    expect(mounts).toEqual(["files", "servers"]);
    // The new session's file panel mounts when it is first shown, not eagerly.
    await fireEvent.click(screen.getByTestId("dock-tab-files"));
    expect(mounts).toEqual(["files", "servers", "files"]);
  });

  it("keeps the panels of every session on screen, and shows only the focused one's", async () => {
    // Two terminals side by side: the dock follows the pane in focus, and a click
    // on the other pane must flip which panel is visible — not rebuild it.
    setDockCollapsed("right", false);
    const { rerender } = render(Dock, {
      props: {
        side: "right",
        sessionId: "s1",
        sessions: ["s1", "s2"],
        connection: "connected",
        panel,
      },
    });
    // Lazy: the other session's panel is not built until it is first shown.
    expect(sessionMounts).toEqual(["s1/files"]);
    await rerender({ sessionId: "s2" });
    expect(sessionMounts).toEqual(["s1/files", "s2/files"]);
    expect(sessionUnmounts).toEqual([]);
    expect(visibleIn["s1/files"]()).toBe(false);
    expect(visibleIn["s2/files"]()).toBe(true);
    const [first, second] = screen.getAllByTestId("dock-pane-files");
    expect(first).toHaveAttribute("data-session", "s1");
    expect(first).toHaveClass("hidden");
    expect(second).not.toHaveClass("hidden");
    // Back again: the same two instances, the other one visible.
    await rerender({ sessionId: "s1" });
    expect(sessionMounts).toEqual(["s1/files", "s2/files"]);
    expect(visibleIn["s1/files"]()).toBe(true);
    expect(visibleIn["s2/files"]()).toBe(false);
  });

  it("drops the panels of a session that left the screen", async () => {
    setDockCollapsed("right", false);
    const { rerender } = render(Dock, {
      props: {
        side: "right",
        sessionId: "s1",
        sessions: ["s1", "s2"],
        connection: "connected",
        panel,
      },
    });
    await rerender({ sessionId: "s2" });
    // s1's tab went behind another one (or closed): only s2 is on screen now.
    await rerender({ sessions: ["s2"] });
    expect(sessionUnmounts).toEqual(["s1/files"]);
    expect(visibleIn["s2/files"]()).toBe(true);
  });

  it("a hidden session's panel stays hidden whatever the focused session's state", async () => {
    // The offline notice replaces the FOCUSED session's panel; a panel kept for
    // another session must not surface in its place.
    setDockCollapsed("right", false);
    const { rerender } = render(Dock, {
      props: {
        side: "right",
        sessionId: "s1",
        sessions: ["s1", "s2"],
        connection: "connected",
        panel,
      },
    });
    await rerender({ sessionId: "s2", connection: "offline" });
    expect(screen.getByTestId("dock-offline")).toBeInTheDocument();
    expect(visibleIn["s1/files"]()).toBe(false);
    expect(visibleIn["s2/files"]()).toBe(false);
  });

  it("says whose panel it is while there are panes to tell apart", async () => {
    setDockCollapsed("right", false);
    const { rerender } = render(Dock, {
      props: { side: "right", sessionId: "s1", connection: "connected", panel },
    });
    expect(screen.queryByTestId("dock-session-caption")).toBeNull();
    await rerender({ caption: "web-01" });
    expect(screen.getByTestId("dock-session-caption")).toHaveTextContent("web-01");
  });

  it("puts no session caption over the server tree", () => {
    render(Dock, {
      props: { side: "left", sessionId: "s1", connection: "connected", caption: "web-01", panel },
    });
    expect(pane("servers")).not.toHaveClass("hidden");
    expect(screen.queryByTestId("dock-session-caption")).toBeNull();
  });

  it("drops a panel that moved to another dock", async () => {
    setDockCollapsed("right", false);
    open();
    expect(mounts).toEqual(["files"]);
    movePanel("files", "bottom");
    flushSync();
    expect(unmounts).toEqual(["files"]);
    expect(screen.queryByTestId("dock-tab-files")).toBeNull();
  });
});

describe("Dock — a session that is gone", () => {
  const props = { side: "right" as const, sessionId: "s1", panel };

  beforeEach(() => setDockCollapsed("right", false));

  it("replaces the panel with one notice when the SSH session is gone", () => {
    render(Dock, { props: { ...props, sessionKind: "ssh", connection: "offline" } });
    expect(screen.getByTestId("dock-offline")).toBeInTheDocument();
    expect(screen.getByText("No connection to the server")).toBeInTheDocument();
    // The panel stays mounted (its state survives the reconnect) but hidden, and
    // is told so — a hidden panel must not poll a dead session.
    expect(pane("files")).toHaveClass("hidden");
    expect(visibleOf.files()).toBe(false);
  });

  it("shows the panel, not the notice, while connected or still connecting", () => {
    const { rerender } = render(Dock, { props: { ...props, connection: "connected" } });
    expect(screen.queryByTestId("dock-offline")).toBeNull();
    void rerender({ connection: "connecting" });
    flushSync();
    expect(screen.queryByTestId("dock-offline")).toBeNull();
  });

  it("says the shell exited for a local tab", () => {
    render(Dock, { props: { ...props, sessionKind: "local", connection: "offline" } });
    expect(screen.getByText("The shell has exited")).toBeInTheDocument();
  });

  it("never blames the session for the server tree", () => {
    movePanel("servers", "right");
    render(Dock, { props: { ...props, connection: "offline" } });
    expect(screen.queryByTestId("dock-offline")).toBeNull();
    expect(visibleOf.servers()).toBe(true);
  });
});

describe("Dock — bottom", () => {
  const open = () =>
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });

  it("collapses to its tab strip and opens on a tab click", async () => {
    open();
    const dock = screen.getByTestId("dock-bottom");
    const strip = screen.getByTestId("dock-strip-bottom");
    // Collapsed: as tall as the status bar under it (a 24px strip + the border).
    expect(dock.style.height).toBe("25px");
    expect(strip).toHaveClass("h-6");
    expect(mounts).toEqual([]);
    await fireEvent.click(screen.getByTestId("dock-tab-k8s"));
    expect(layout.docks.bottom.collapsed).toBe(false);
    expect(layout.docks.bottom.active).toBe("k8s");
    expect(dock.style.height).toBe(`${DOCK_BOUNDS.bottom.initial}px`);
    expect(strip).toHaveClass("h-8");
    expect(mounts).toEqual(["k8s"]);
  });

  it("never draws taller than its share of the window", () => {
    setDockCollapsed("bottom", false);
    layout.docks.bottom.size = DOCK_BOUNDS.bottom.max;
    open();
    const cap = Math.floor(window.innerHeight * BOTTOM_MAX_SHARE);
    expect(screen.getByTestId("dock-bottom").style.height).toBe(`${cap}px`);
    // The stored size is the user's, the cap is only how it is drawn.
    expect(layout.docks.bottom.size).toBe(DOCK_BOUNDS.bottom.max);
  });
});

describe("Dock — resizing", () => {
  const drag = async (side: "left" | "right" | "bottom", dx: number, dy: number) => {
    const handle = screen.getByTestId(`dock-resize-${side}`);
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    await fireEvent(handle, new PointerEvent("pointerdown", { clientX: 500, clientY: 500 }));
    await fireEvent(
      handle,
      new PointerEvent("pointermove", { clientX: 500 + dx, clientY: 500 + dy }),
    );
    await fireEvent(handle, new PointerEvent("pointerup", {}));
  };

  it("grows the left dock to the right and the right dock to the left", async () => {
    setDockCollapsed("right", false);
    render(Dock, { props: { side: "left", panel } });
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });
    await drag("left", 40, 0);
    expect(layout.docks.left.size).toBe(DOCK_BOUNDS.left.initial + 40);
    await drag("right", -60, 0);
    expect(layout.docks.right.size).toBe(DOCK_BOUNDS.right.initial + 60);
  });

  it("grows the bottom dock upwards, within its limits", async () => {
    setDockCollapsed("bottom", false);
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    await drag("bottom", 0, -50);
    expect(layout.docks.bottom.size).toBe(DOCK_BOUNDS.bottom.initial + 50);
    await drag("bottom", 0, 5000);
    expect(layout.docks.bottom.size).toBe(DOCK_BOUNDS.bottom.min);
  });

  it("does not bank height the window cannot show", async () => {
    setDockCollapsed("bottom", false);
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    await drag("bottom", 0, -5000);
    // Capped at the dock's share of the window, not at its absolute maximum: the
    // next drag down has to move the edge at once.
    expect(layout.docks.bottom.size).toBe(Math.floor(window.innerHeight * BOTTOM_MAX_SHARE));
  });

  it("offers no resize handle while collapsed", () => {
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    expect(screen.queryByTestId("dock-resize-bottom")).toBeNull();
  });
});

describe("Dock — moving a panel", () => {
  it("moves a tab from its right-click menu", async () => {
    render(Dock, { props: { side: "left", panel } });
    await fireEvent.contextMenu(screen.getByTestId("dock-tab-servers"));
    // Only the other two docks are offered.
    expect(screen.queryByRole("menuitem", { name: "Move to the left panel" })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Move to the bottom panel" }));
    expect(layout.docks.bottom.panels).toEqual(["docker", "k8s", "servers"]);
    expect(layout.docks.left.panels).toEqual([]);
  });

  it("offers its window edge as a drop zone only while empty and a tab is dragged", () => {
    render(Dock, { props: { side: "right", panel } });
    expect(screen.queryByTestId("dock-zone-right")).toBeNull();
    dockDrag.panel = "servers";
    flushSync();
    const zone = screen.getByTestId("dock-zone-right");
    expect(zone.dataset.dockDrop).toBe("right");
    // An overlay, not a strip in the layout: it must not resize the terminal.
    expect(zone).toHaveClass("fixed");
  });

  /** The strip's tabs as drawn: label, with the dragged tab's slot in brackets. */
  const strip = (side: "left" | "right" | "bottom") =>
    [...screen.getByTestId(`dock-strip-${side}`).querySelectorAll<HTMLElement>("[data-dock-tab]")].map(
      (el) => (el.dataset.dockPlaceholder === undefined ? el.textContent!.trim() : `[${el.textContent!.trim()}]`),
    );

  it("opens a slot for the dragged tab where it would land, and closes the one it left", () => {
    setDockCollapsed("right", false);
    setDockCollapsed("bottom", false);
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    dockDrag.panel = "docker";
    dockDrag.over = { side: "right", index: 1 };
    flushSync();
    expect(strip("right")).toEqual(["SFTP", "[Docker]", "Git", "AI"]);
    expect(strip("bottom")).toEqual(["k8s"]);
    // The pointer moves on: the slot follows it.
    dockDrag.over = { side: "right", index: 3 };
    flushSync();
    expect(strip("right")).toEqual(["SFTP", "Git", "AI", "[Docker]"]);
  });

  it("keeps the slot where the tab came from while it is over nothing", () => {
    setDockCollapsed("right", false);
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });
    dockDrag.panel = "git";
    dockDrag.over = null;
    flushSync();
    expect(strip("right")).toEqual(["SFTP", "[Git]", "AI"]);
  });

  it("draws the slot as empty space: there, hit-testable, invisible", () => {
    setDockCollapsed("right", false);
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });
    dockDrag.panel = "git";
    flushSync();
    const slot = screen.getByTestId("dock-tab-git");
    // opacity, not `invisible`/`hidden`: the slot has to keep its place AND answer
    // the hit test — a pointer over "nothing" is read as "append to the end".
    expect(slot).toHaveClass("opacity-0");
    expect(slot.className).not.toMatch(/(^|\s)(invisible|hidden)(\s|$)/);
    expect(slot.dataset.dockPlaceholder).toBe("");
    expect(screen.getByTestId("dock-tab-files").dataset.dockPlaceholder).toBeUndefined();
  });

  it("previews on a collapsed dock's rail too", () => {
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });
    dockDrag.panel = "docker";
    dockDrag.over = { side: "right", index: 0 };
    flushSync();
    const rail = [...document.querySelectorAll<HTMLElement>('[data-dock-axis="y"] [data-dock-tab]')];
    expect(rail.map((el) => el.textContent?.trim())).toEqual(["Docker", "SFTP", "Git", "AI"]);
    expect(rail[0].dataset.dockPlaceholder).toBe("");
    expect(rail[0]).toHaveClass("opacity-0");
  });

  it("previews the order only — nothing is moved, mounted or opened until the drop", () => {
    setDockCollapsed("bottom", false);
    render(Dock, { props: { side: "right", sessionId: "s1", connection: "connected", panel } });
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    const before = layout.docks;
    dockDrag.panel = "docker";
    dockDrag.over = { side: "right", index: 0 };
    flushSync();
    expect(layout.docks).toBe(before);
    // The right dock stays collapsed, the Docker panel stays where it is mounted.
    expect(layout.docks.right.collapsed).toBe(true);
    expect(mounts).toEqual(["docker"]);
    expect(unmounts).toEqual([]);
    expect(pane("docker")).not.toHaveClass("hidden");
  });

  it("keeps a dock on screen while its only tab is in the air", () => {
    // Dropping the dock out of the layout mid-drag would resize the terminal.
    movePanel("k8s", "right");
    setDockCollapsed("bottom", false);
    render(Dock, { props: { side: "bottom", sessionId: "s1", connection: "connected", panel } });
    dockDrag.panel = "docker";
    dockDrag.over = { side: "right", index: null };
    flushSync();
    expect(screen.getByTestId("dock-bottom")).toBeInTheDocument();
    expect(strip("bottom")).toEqual([]);
  });

  it("lights an empty dock's window edge when the tab is over it", () => {
    render(Dock, { props: { side: "right", panel } });
    dockDrag.panel = "servers";
    flushSync();
    const zone = screen.getByTestId("dock-zone-right");
    expect(zone).toHaveClass("bg-accent/10");
    dockDrag.over = { side: "right", index: null };
    flushSync();
    expect(zone).toHaveClass("bg-accent/25");
    dockDrag.over = { side: "bottom", index: null };
    flushSync();
    expect(zone).toHaveClass("bg-accent/10");
  });

  it("carries each tab's index in the full panel list for the drop logic", () => {
    // No session: only the tree is offered, but it is the dock's SECOND panel.
    movePanel("docker", "left", 0);
    render(Dock, { props: { side: "left", panel } });
    expect(screen.getByTestId("dock-tab-servers").dataset.dockTab).toBe("1");
  });
});

describe("DockDragGhost", () => {
  it("is a copy of the picked-up tab that follows the pointer", () => {
    render(DockDragGhost);
    expect(screen.queryByTestId("dock-drag-ghost")).toBeNull();
    dockDrag.panel = "docker";
    dockDrag.x = 100;
    dockDrag.y = 50;
    dockDrag.width = 120;
    dockDrag.height = 30;
    flushSync();
    const ghost = screen.getByTestId("dock-drag-ghost");
    expect(ghost).toHaveTextContent("Docker");
    // Drawn exactly where the store says the tab is — the grab offset is the
    // store's business, so the tab does not jump under the pointer on pick-up.
    expect(ghost.style.left).toBe("100px");
    expect(ghost.style.top).toBe("50px");
    expect(ghost.style.width).toBe("120px");
    expect(ghost.style.height).toBe("30px");
    // It must not swallow the hit test that finds the dock underneath.
    expect(ghost).toHaveClass("pointer-events-none");
    expect(ghost.dataset.settling).toBeUndefined();
  });

  it("keeps a rail tab's vertical lettering", () => {
    render(DockDragGhost);
    dockDrag.panel = "files";
    dockDrag.vertical = true;
    flushSync();
    expect(screen.getByTestId("dock-drag-ghost").className).toContain("[writing-mode:vertical-rl]");
    dockDrag.vertical = false;
    flushSync();
    expect(screen.getByTestId("dock-drag-ghost").className).not.toContain("writing-mode");
  });

  it("glides to its slot once released", () => {
    render(DockDragGhost);
    dockDrag.panel = "docker";
    flushSync();
    const ghost = screen.getByTestId("dock-drag-ghost");
    expect(ghost).not.toHaveClass("vt-dock-settle");
    dockDrag.settling = true;
    flushSync();
    // Only then does it animate its position: while it follows the pointer a
    // transition would make it lag behind the hand.
    expect(ghost).toHaveClass("vt-dock-settle");
    expect(ghost.dataset.settling).toBe("true");
  });
});
