import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import PanelsSettings from "./PanelsSettings.svelte";
import { LIST_COLUMNS } from "./colwidths";
import { defaultDocks } from "./docklayout";
import { resetSettings, settings } from "./settings.svelte";
import { columnWidth, setColumnWidth } from "./stores/colwidths.svelte";
import { layout, movePanel, resetLayout, setPanelHidden } from "./stores/layout.svelte";
import { clearToasts, toastsState } from "./stores/toasts.svelte";

const box = (id: string) => screen.getByTestId(`panel-visible-${id}`) as HTMLInputElement;

beforeEach(() => {
  localStorage.clear();
  resetLayout();
  resetSettings();
  clearToasts();
  flushSync();
});

describe("PanelsSettings", () => {
  it("lists every panel that can be hidden — and not the server tree", () => {
    render(PanelsSettings);
    for (const id of ["files", "git", "docker", "k8s", "ai"]) expect(box(id).checked).toBe(true);
    expect(screen.queryByTestId("panel-visible-servers")).toBeNull();
    // Named as on their tabs, so the list reads like the docks do.
    expect(screen.getByLabelText("SFTP")).toBe(box("files"));
    expect(screen.getByLabelText("Docker")).toBe(box("docker"));
  });

  it("hides a panel when its box is cleared and brings it back when ticked", async () => {
    render(PanelsSettings);
    await fireEvent.click(box("docker"));
    expect(settings.hiddenPanels).toEqual(["docker"]);
    expect(box("docker").checked).toBe(false);
    await fireEvent.click(box("docker"));
    expect(settings.hiddenPanels).toEqual([]);
  });

  it("shows what is already hidden, however it was hidden", () => {
    setPanelHidden("git", true);
    render(PanelsSettings);
    expect(box("git").checked).toBe(false);
    expect(box("files").checked).toBe(true);
    // Hidden from a tab's menu while the section is open.
    setPanelHidden("ai", true);
    flushSync();
    expect(box("ai").checked).toBe(false);
  });

  it("resets the layout and the column widths — and says so", async () => {
    movePanel("docker", "left");
    setColumnWidth("k8s.node", 300);
    setPanelHidden("git", true);
    render(PanelsSettings);
    await fireEvent.click(screen.getByTestId("panels-reset-layout"));
    expect(layout.docks).toEqual(defaultDocks());
    expect(columnWidth("k8s.node")).toBe(LIST_COLUMNS["k8s.node"]);
    // The settings window covers the docks: without a word the click looks dead.
    expect(toastsState.list.at(-1)?.message).toBe("Panel layout reset");
    // Resetting where panels sit does not un-hide them.
    expect(settings.hiddenPanels).toEqual(["git"]);
  });
});
