import { describe, expect, it, vi } from "vitest";
import { isAction, type MenuAction, type MenuItem, type MenuSubmenu } from "./ctxmenu";
import { ICONS } from "./icons";
import { allTopbarIds, BUILTIN_ACTIONS, DEFAULT_TOPBAR, type TopbarId } from "./topbaractions";
import { actionIcon, actionLabel, topbarMenu } from "./topbarui";
import { UTILITIES } from "./utilities";

const on = () => ({ pin: vi.fn(), unpin: vi.fn(), reset: vi.fn() });
const actions = (items: MenuItem[]): MenuAction[] => items.filter(isAction);
const row = (items: MenuItem[], label: string): MenuAction => actions(items).find((a) => a.label === label)!;
const tools = (items: MenuItem[]): MenuSubmenu => items.find((i): i is MenuSubmenu => i.kind === "submenu")!;

describe("what a button is called and drawn as", () => {
  it("names every button, each differently", () => {
    const labels = allTopbarIds().map(actionLabel);
    expect(labels.slice(0, BUILTIN_ACTIONS.length)).toEqual([
      "Broadcast input",
      "Notes",
      "Monitoring",
      "Recording (REC)",
      "Recordings",
      "Utilities",
      "Settings",
    ]);
    expect(labels.every((l) => l.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("a tool is called what the Utilities panel calls it", () => {
    expect(actionLabel("util:cidr")).toBe("CIDR / Subnet");
  });

  it("every button has an icon from the registry", () => {
    for (const id of allTopbarIds()) expect(ICONS[actionIcon(id)], id).toBeTruthy();
  });

  it("no two tools share an icon — pinned side by side they must be told apart", () => {
    const icons = UTILITIES.map((u) => u.icon);
    expect(new Set(icons).size).toBe(icons.length);
    // The pair that used to: the padlock stays with TLS.
    expect(actionIcon("util:tls")).toBe("lock");
    expect(actionIcon("util:password")).toBe("password");
  });

  it("…and no tool looks like a built-in button of the bar", () => {
    const builtin = BUILTIN_ACTIONS.map(actionIcon);
    for (const u of UTILITIES) expect(builtin, u.id).not.toContain(u.icon);
  });
});

describe("the bar's menu", () => {
  it("lists every built-in button as a switch, ticked while it is on the bar", () => {
    const bar: TopbarId[] = ["record", "settings"];
    const items = topbarMenu(bar, null, on());
    const builtin = actions(items).filter((a) => a.checked !== undefined);
    expect(builtin.map((a) => a.label)).toEqual(BUILTIN_ACTIONS.map(actionLabel));
    expect(builtin.filter((a) => a.checked).map((a) => a.label)).toEqual(["Recording (REC)", "Settings"]);
  });

  it("the tools are a group of their own, in the panel's order", () => {
    const group = tools(topbarMenu(["util:cidr", "settings"], null, on()));
    // Named apart from the "Utilities" row — the button that opens the panel.
    expect(group.label).toBe("Single tools");
    expect(actions(topbarMenu(["settings"], null, on())).map((a) => a.label)).not.toContain(group.label);
    expect(group.items.map((a) => a.label)).toEqual(UTILITIES.map((u) => actionLabel(`util:${u.id}`)));
    expect(group.items.filter((a) => a.checked).map((a) => a.label)).toEqual(["CIDR / Subnet"]);
  });

  it("a ticked row takes the button off, an unticked one puts it on", () => {
    const calls = on();
    const items = topbarMenu(["record", "settings"], null, calls);
    row(items, "Recording (REC)").onSelect();
    expect(calls.unpin).toHaveBeenCalledWith("record");
    row(items, "Monitoring").onSelect();
    expect(calls.pin).toHaveBeenCalledWith("monitoring");
    tools(items).items.find((a) => a.label === "CIDR / Subnet")!.onSelect();
    expect(calls.pin).toHaveBeenCalledWith("util:cidr");
  });

  it("Utilities and Settings are shown ticked and are not offered", () => {
    const items = topbarMenu([...DEFAULT_TOPBAR], null, on());
    for (const label of ["Utilities", "Settings"]) {
      expect(row(items, label).checked, label).toBe(true);
      expect(row(items, label).disabled, label).toBe(true);
    }
    // Every other row can be used.
    const rest = actions(items).filter((a) => a.label !== "Settings" && a.label !== "Utilities");
    expect(rest.every((a) => !a.disabled)).toBe(true);
  });

  it("over a button of the bar: taking that one off comes first", () => {
    const calls = on();
    const items = topbarMenu([...DEFAULT_TOPBAR], "monitoring", calls);
    expect(isAction(items[0]) && items[0].label).toBe("Remove from the top bar");
    expect(items[1]).toEqual({ kind: "separator" });
    (items[0] as MenuAction).onSelect();
    expect(calls.unpin).toHaveBeenCalledWith("monitoring");
  });

  it("over an anchor: nothing to offer for that one — the list starts at once", () => {
    for (const anchor of ["settings", "utilities"] as const) {
      const items = topbarMenu([...DEFAULT_TOPBAR], anchor, on());
      expect(isAction(items[0]) && items[0].label, anchor).toBe("Broadcast input");
    }
  });

  it("over an indicator that is not on the list: keeping it comes first", () => {
    const calls = on();
    // REC shown because a recording is running; the user had taken it off.
    const items = topbarMenu(["settings"], "record", calls);
    expect(isAction(items[0]) && items[0].label).toBe("Keep on the top bar");
    (items[0] as MenuAction).onSelect();
    expect(calls.pin).toHaveBeenCalledWith("record");
  });

  it("ends with the way back to the default bar", () => {
    const calls = on();
    const items = topbarMenu(["settings"], null, calls);
    const last = items[items.length - 1] as MenuAction;
    expect(last.label).toBe("Restore the default buttons");
    expect(items[items.length - 2]).toEqual({ kind: "separator" });
    last.onSelect();
    expect(calls.reset).toHaveBeenCalledOnce();
  });
});
