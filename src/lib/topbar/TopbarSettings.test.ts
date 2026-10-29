import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import TopbarSettings from "./TopbarSettings.svelte";
import { resetSettings, settings } from "../settings/settings.svelte";
import { BUILTIN_ACTIONS, DEFAULT_TOPBAR } from "./topbaractions";
import { pinAction, unpinAction } from "../stores/topbarpins.svelte";
import { clearToasts, toastsState } from "../stores/toasts.svelte";
import { UTILITIES } from "../utilities/utilities";

const box = (id: string) => screen.getByTestId(`topbar-pinned-${id}`) as HTMLInputElement;

beforeEach(() => {
  localStorage.clear();
  resetSettings();
  clearToasts();
  flushSync();
});

describe("TopbarSettings", () => {
  it("lists every button there is: the built-in ones ticked, the tools not", () => {
    render(TopbarSettings);
    for (const id of BUILTIN_ACTIONS) expect(box(id).checked, id).toBe(true);
    for (const u of UTILITIES) expect(box(`util:${u.id}`).checked, u.id).toBe(false);
    // Named as in the bar's menu.
    expect(screen.getByLabelText("Recording (REC)")).toBe(box("record"));
    expect(screen.getByLabelText("CIDR / Subnet")).toBe(box("util:cidr"));
  });

  it("Utilities and Settings are ticked and cannot be unticked", () => {
    render(TopbarSettings);
    for (const id of ["utilities", "settings"]) {
      expect(box(id).checked, id).toBe(true);
      expect(box(id).disabled, id).toBe(true);
    }
    for (const id of BUILTIN_ACTIONS.filter((x) => x !== "settings" && x !== "utilities")) {
      expect(box(id).disabled, id).toBe(false);
    }
  });

  it("says where a button that was taken off is still found", () => {
    render(TopbarSettings);
    expect(screen.getByTestId("topbar-where").textContent).toContain("Utilities window");
  });

  it("a tick puts a button on the bar, clearing it takes the button off", async () => {
    render(TopbarSettings);
    await fireEvent.click(box("util:tls"));
    expect(settings.topbar).toContain("util:tls");
    await fireEvent.click(box("monitoring"));
    expect(settings.topbar).not.toContain("monitoring");
    await fireEvent.click(box("monitoring"));
    expect(settings.topbar).toContain("monitoring");
  });

  it("follows a change made elsewhere — the bar's menu, another window", async () => {
    render(TopbarSettings);
    pinAction("util:jwt");
    unpinAction("recordings");
    flushSync();
    expect(box("util:jwt").checked).toBe(true);
    expect(box("recordings").checked).toBe(false);
  });

  it("restores the default buttons, and says so — the settings window covers the bar", async () => {
    unpinAction("record");
    pinAction("util:cidr");
    render(TopbarSettings);
    await fireEvent.click(screen.getByTestId("topbar-reset"));
    expect(settings.topbar).toEqual([...DEFAULT_TOPBAR]);
    expect(toastsState.list.map((x) => x.message)).toContain("Top bar restored");
  });
});
