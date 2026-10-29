import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TopBar from "./TopBar.svelte";

const base = {
  title: "Timeweb",
  subtitle: "root@31.130.129.206:22",
  connected: true,
  onToggleRecording: () => {},
  onOpenRecordings: () => {},
  onOpenMonitoring: () => {},
  onOpenSettings: () => {},
};

describe("TopBar", () => {
  it("shows the connection breadcrumb (alias · user@host:port)", () => {
    render(TopBar, { props: { ...base } });
    expect(screen.getByText("Timeweb")).toBeInTheDocument();
    expect(screen.getByText("root@31.130.129.206:22")).toBeInTheDocument();
  });

  it("opens settings from the gear button", async () => {
    const onOpenSettings = vi.fn();
    render(TopBar, { props: { ...base, onOpenSettings } });
    await userEvent.click(screen.getByTestId("topbar-settings"));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("opens monitoring from its button while connected", async () => {
    const onOpenMonitoring = vi.fn();
    render(TopBar, { props: { ...base, connected: true, onOpenMonitoring } });
    await userEvent.click(screen.getByTestId("topbar-monitoring"));
    expect(onOpenMonitoring).toHaveBeenCalledOnce();
  });

  it("keeps the monitoring button in its slot but disabled when not connected", async () => {
    // Fixed layout: the button stays put (so nothing reflows on connect) but is
    // dimmed + disabled and does not fire until a session exists.
    const onOpenMonitoring = vi.fn();
    render(TopBar, { props: { ...base, connected: false, onOpenMonitoring } });
    const mon = screen.getByTestId("topbar-monitoring");
    expect(mon).toBeInTheDocument();
    expect(mon).toBeDisabled();
    await userEvent.click(mon);
    expect(onOpenMonitoring).not.toHaveBeenCalled();
    // Settings stays available regardless.
    expect(screen.getByTestId("topbar-settings")).toBeInTheDocument();
  });

  it("no longer renders the brand or an add-server button", () => {
    render(TopBar, { props: { ...base } });
    expect(screen.queryByText("vterm")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-server")).not.toBeInTheDocument();
  });

  it("opens the recordings library from its button", async () => {
    const onOpenRecordings = vi.fn();
    render(TopBar, { props: { ...base, onOpenRecordings } });
    await userEvent.click(screen.getByTestId("open-recordings"));
    expect(onOpenRecordings).toHaveBeenCalledOnce();
  });

  it("keeps the REC toggle in its slot, disabled until the tab can be recorded", () => {
    const { unmount } = render(TopBar, { props: { ...base, canRecord: false } });
    const rec = screen.getByTestId("record-toggle");
    expect(rec).toBeInTheDocument();
    expect(rec).toBeDisabled();
    unmount();
    render(TopBar, { props: { ...base, canRecord: true } });
    expect(screen.getByTestId("record-toggle")).toBeEnabled();
  });

  it("toggles recording and reflects the running state via aria-pressed", async () => {
    const onToggleRecording = vi.fn();
    const { unmount } = render(TopBar, {
      props: { ...base, canRecord: true, recording: false, onToggleRecording },
    });
    const rec = screen.getByTestId("record-toggle");
    expect(rec).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(rec);
    expect(onToggleRecording).toHaveBeenCalledOnce();
    unmount();
    render(TopBar, { props: { ...base, canRecord: true, recording: true } });
    expect(screen.getByTestId("record-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the broadcast button in its slot but disabled without an active tab", async () => {
    const onToggleBroadcast = vi.fn();
    render(TopBar, { props: { ...base, canBroadcast: false, onToggleBroadcast } });
    const btn = screen.getByTestId("topbar-broadcast");
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onToggleBroadcast).not.toHaveBeenCalled();
  });

  it("toggles broadcast and reflects membership via aria-pressed", async () => {
    const onToggleBroadcast = vi.fn();
    const { unmount } = render(TopBar, {
      props: { ...base, canBroadcast: true, broadcastActive: false, onToggleBroadcast },
    });
    const btn = screen.getByTestId("topbar-broadcast");
    expect(btn).toBeEnabled();
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(btn);
    expect(onToggleBroadcast).toHaveBeenCalledOnce();
    unmount();
    render(TopBar, { props: { ...base, canBroadcast: true, broadcastActive: true } });
    expect(screen.getByTestId("topbar-broadcast")).toHaveAttribute("aria-pressed", "true");
  });

  it("places the broadcast button before the notes button", () => {
    render(TopBar, { props: { ...base, canBroadcast: true, showNotes: true } });
    const bc = screen.getByTestId("topbar-broadcast");
    const notes = screen.getByTestId("topbar-notes");
    expect(bc.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("places the recording controls before the settings gear", () => {
    render(TopBar, { props: { ...base, canRecord: true } });
    const rec = screen.getByTestId("record-toggle");
    const lib = screen.getByTestId("open-recordings");
    const gear = screen.getByTestId("topbar-settings");
    // DOM order: REC → library → settings (rec/library sit before the gear).
    expect(rec.compareDocumentPosition(gear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lib.compareDocumentPosition(gear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ── The bar is the user's (v1.16) ────────────────────────────────────────────

import { fireEvent, waitFor, within } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach } from "vitest";
import { resetSettings, settings } from "../settings/settings.svelte";
import { DEFAULT_TOPBAR, TOPBAR_SIZES, type TopbarId } from "./topbaractions";
import { actionLabel } from "./topbarui";
import { pinAction, unpinAction } from "../stores/topbarpins.svelte";
import { cancelTopbarDrag, topbarDrag } from "../stores/topbardrag.svelte";

describe("TopBar — the user's buttons", () => {
  beforeEach(() => {
    localStorage.clear();
    cancelTopbarDrag();
    resetSettings();
    flushSync();
  });

  /** The buttons the bar draws, left to right, by the action each stands for. */
  const drawn = () =>
    [...screen.getByTestId("topbar-actions").querySelectorAll<HTMLElement>("[data-topbar-item]")].map(
      (el) => el.dataset.topbarItem,
    );
  const item = (id: TopbarId) =>
    screen.getByTestId("topbar-actions").querySelector<HTMLElement>(`[data-topbar-item="${id}"]`)!;
  const menuRow = (label: string) => within(screen.getByRole("menu")).getByText(label).closest("button")!;

  it("a fresh install shows the bar as it always was", () => {
    render(TopBar, { props: { ...base, showNotes: true } });
    expect(drawn()).toEqual([...DEFAULT_TOPBAR]);
    expect(screen.queryByTestId("topbar-more")).toBeNull();
  });

  it("a pinned tool is a button of its own and opens the panel on that tool", async () => {
    const onOpenUtilities = vi.fn();
    pinAction("util:cidr");
    render(TopBar, { props: { ...base, onOpenUtilities } });
    const btn = screen.getByTestId("topbar-util-cidr");
    expect(btn).toHaveAttribute("aria-label", "CIDR / Subnet");
    await userEvent.click(btn);
    expect(onOpenUtilities).toHaveBeenCalledWith("cidr");
    // The wrench still opens the panel as a whole.
    await userEvent.click(screen.getByTestId("topbar-utilities"));
    expect(onOpenUtilities).toHaveBeenLastCalledWith();
    // It stands before the gear, which stays last.
    expect(drawn().slice(-2)).toEqual(["util:cidr", "settings"]);
  });

  it("a button taken off the list is gone from the bar; the two anchors never are", () => {
    unpinAction("monitoring");
    unpinAction("recordings");
    // Asking for the anchors changes nothing.
    unpinAction("utilities");
    unpinAction("settings");
    render(TopBar, { props: { ...base } });
    expect(screen.queryByTestId("topbar-monitoring")).toBeNull();
    expect(screen.queryByTestId("open-recordings")).toBeNull();
    expect(screen.getByTestId("topbar-utilities")).toBeInTheDocument();
    expect(screen.getByTestId("topbar-settings")).toBeInTheDocument();
  });

  it("right-click on a button offers to take it off — and does", async () => {
    render(TopBar, { props: { ...base } });
    await fireEvent.contextMenu(screen.getByTestId("open-recordings"));
    await fireEvent.click(menuRow("Remove from the top bar"));
    expect(settings.topbar).not.toContain("recordings");
    await waitFor(() => expect(screen.queryByTestId("open-recordings")).toBeNull());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the menu is a checklist of every button, and a tick puts one back", async () => {
    unpinAction("monitoring");
    render(TopBar, { props: { ...base } });
    await fireEvent.contextMenu(screen.getByTestId("topbar-actions"));
    const row = menuRow("Monitoring");
    expect(row).toHaveAttribute("role", "menuitemcheckbox");
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(menuRow("Recordings")).toHaveAttribute("aria-checked", "true");
    // Rows line up: ticked or not, the tick column is there.
    expect(row.querySelector("[data-checked='false']")).not.toBeNull();
    expect(menuRow("Recordings").querySelector("[data-checked='true'] svg")).not.toBeNull();
    await fireEvent.click(row);
    expect(settings.topbar).toContain("monitoring");
    await waitFor(() => expect(screen.getByTestId("topbar-monitoring")).toBeInTheDocument());
  });

  it("the menu's tools group pins a tool", async () => {
    render(TopBar, { props: { ...base } });
    await fireEvent.contextMenu(screen.getByTestId("topbar-actions"));
    await fireEvent.click(menuRow("Single tools"));
    const tool = menuRow(actionLabel("util:jwt"));
    expect(tool).toHaveAttribute("aria-checked", "false");
    await fireEvent.click(tool);
    expect(settings.topbar).toContain("util:jwt");
  });

  it("Settings and Utilities cannot be taken off: the row is ticked and disabled, the button has no 'remove'", async () => {
    render(TopBar, { props: { ...base } });
    for (const [testid, label] of [
      ["topbar-settings", "Settings"],
      ["topbar-utilities", "Utilities"],
    ]) {
      await fireEvent.contextMenu(screen.getByTestId(testid));
      expect(within(screen.getByRole("menu")).queryByText("Remove from the top bar"), label).toBeNull();
      expect(menuRow(label)).toBeDisabled();
      expect(menuRow(label)).toHaveAttribute("aria-checked", "true");
      await fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
  });

  it("REC taken off the bar is shown while a recording is running, and can be kept from there", async () => {
    unpinAction("record");
    const view = render(TopBar, { props: { ...base, canRecord: true, recording: false } });
    expect(screen.queryByTestId("record-toggle")).toBeNull();

    await view.rerender({ ...base, canRecord: true, recording: true });
    const rec = screen.getByTestId("record-toggle");
    expect(rec).toHaveAttribute("aria-pressed", "true");
    // Ahead of the user's own buttons, and not one of them: it cannot be dragged.
    expect(drawn()[0]).toBe("record");
    expect(item("record").dataset.topbarPin).toBeUndefined();

    await fireEvent.contextMenu(rec);
    await fireEvent.click(menuRow("Keep on the top bar"));
    expect(settings.topbar).toContain("record");

    await view.rerender({ ...base, canRecord: true, recording: false });
    expect(screen.getByTestId("record-toggle")).toBeInTheDocument();
  });

  it("the broadcast button likewise comes back while the tab is in the group", async () => {
    unpinAction("broadcast");
    const view = render(TopBar, { props: { ...base, canBroadcast: true, broadcastActive: false } });
    expect(screen.queryByTestId("topbar-broadcast")).toBeNull();
    await view.rerender({ ...base, canBroadcast: true, broadcastActive: true });
    expect(screen.getByTestId("topbar-broadcast")).toHaveAttribute("aria-pressed", "true");
    await view.rerender({ ...base, canBroadcast: true, broadcastActive: false });
    expect(screen.queryByTestId("topbar-broadcast")).toBeNull();
  });

  describe("what does not fit", () => {
    /** Give the bar a width and let the observers see it (jsdom has no layout). */
    function setBarWidth(width: number) {
      const header = screen.getByTestId("topbar-actions").parentElement!;
      Object.defineProperty(header, "clientWidth", { configurable: true, value: width });
      const observers = (
        globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
      ).instances;
      for (const o of observers) o.cb([{ target: header }]);
    }
    const S = TOPBAR_SIZES;
    /** A bar with room for the «⋯» button, the two anchors and `icons` more icon buttons. */
    const widthFor = (icons: number) => S.crumb + S.chrome + S.icon + (S.icon + S.gap) * (icons + 2) + 2;

    it("goes under «⋯» from the end of the list; Utilities and Settings stay on the bar", async () => {
      const onOpenRecordings = vi.fn();
      render(TopBar, { props: { ...base, onOpenRecordings } });
      setBarWidth(widthFor(2));
      await waitFor(() => expect(screen.getByTestId("topbar-more")).toBeInTheDocument());
      // No server is selected, so the notes button is not there to count.
      expect(drawn()).toEqual(["broadcast", "monitoring", "utilities", "settings"]);

      // The rest are rows that do what the buttons did.
      await userEvent.click(screen.getByTestId("topbar-more"));
      const rows = within(screen.getByRole("menu")).getAllByRole("menuitem").map((r) => r.textContent?.trim());
      expect(rows).toEqual(["Record session", "Recordings"]);
      await fireEvent.click(menuRow("Recordings"));
      expect(onOpenRecordings).toHaveBeenCalledOnce();
    });

    it("a row under «⋯» is disabled exactly when its button would be", async () => {
      render(TopBar, { props: { ...base, connected: false, canRecord: false } });
      setBarWidth(widthFor(1));
      await waitFor(() => expect(screen.getByTestId("topbar-more")).toBeInTheDocument());
      await userEvent.click(screen.getByTestId("topbar-more"));
      expect(menuRow("Monitoring")).toBeDisabled();
      expect(menuRow("Record session")).toBeDisabled();
      expect(menuRow("Recordings")).toBeEnabled();
    });

    it("a recording that is running is never under «⋯»", async () => {
      render(TopBar, { props: { ...base, canRecord: true, recording: true } });
      setBarWidth(widthFor(0));
      await waitFor(() => expect(screen.getByTestId("topbar-more")).toBeInTheDocument());
      expect(drawn()).toEqual(["record", "utilities", "settings"]);
    });

    it("a wide bar has no «⋯»", async () => {
      render(TopBar, { props: { ...base } });
      setBarWidth(1400);
      await waitFor(() => expect(drawn()).toHaveLength(6));
      expect(screen.queryByTestId("topbar-more")).toBeNull();
    });
  });

  describe("dragging a button along the bar", () => {
    /** Lay the bar's buttons out in a row: 27 px each, 4 px apart, from x = 500. */
    function layOut() {
      const bar = screen.getByTestId("topbar-actions");
      bar.getBoundingClientRect = () => new DOMRect(500, 6, 400, 27);
      [...bar.querySelectorAll<HTMLElement>("[data-topbar-item]")].forEach((el, i) => {
        el.getBoundingClientRect = () => new DOMRect(500 + i * 31, 6, 27, 27);
        el.setPointerCapture = vi.fn();
        el.releasePointerCapture = vi.fn();
      });
    }
    /** x of the middle of the button at position `i` of the laid-out row. */
    const mid = (i: number) => 500 + i * 31 + 13.5;
    const down = (el: HTMLElement, x: number) =>
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: x, clientY: 18 });
    const move = (x: number, y = 18) =>
      fireEvent(window, new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    const up = () => fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    it("moves it: the neighbours make room while it is held, the list changes once — on release", async () => {
      render(TopBar, { props: { ...base } });
      layOut();
      const before = [...settings.topbar];
      // No notes button without a selected server: the row is
      // broadcast, monitoring, record, recordings, utilities, settings.
      await down(item("broadcast"), mid(0));
      await move(mid(0) + 3);
      expect(topbarDrag.id).toBeNull();
      // Past the middle of the third button (record): it would stand after it.
      await move(mid(2) + 5);
      expect(topbarDrag.id).toBe("broadcast");
      expect(screen.getByTestId("topbar-drag-ghost")).toBeInTheDocument();
      await waitFor(() => expect(drawn()).toEqual(["monitoring", "record", "broadcast", "recordings", "utilities", "settings"]));
      // The held button keeps a slot, unseen; the list is untouched.
      expect(item("broadcast").className).toContain("opacity-0");
      expect(settings.topbar).toEqual(before);

      await up();
      expect(settings.topbar).toEqual([
        "notes",
        "monitoring",
        "record",
        "broadcast",
        "recordings",
        "utilities",
        "settings",
      ]);
      expect(topbarDrag.id).toBeNull();
      await waitFor(() => expect(screen.queryByTestId("topbar-drag-ghost")).toBeNull());
    });

    it("released away from the bar, nothing moves", async () => {
      render(TopBar, { props: { ...base } });
      layOut();
      const before = [...settings.topbar];
      await down(item("broadcast"), mid(0));
      await move(mid(3), 18);
      expect(topbarDrag.over).not.toBeNull();
      await move(mid(3), 400);
      expect(topbarDrag.over).toBeNull();
      await up();
      expect(settings.topbar).toEqual(before);
    });

    it("Esc puts it back", async () => {
      render(TopBar, { props: { ...base } });
      layOut();
      const before = [...settings.topbar];
      await down(item("broadcast"), mid(0));
      await move(mid(3));
      expect(topbarDrag.id).toBe("broadcast");
      await fireEvent.keyDown(window, { key: "Escape" });
      expect(topbarDrag.id).toBeNull();
      await up();
      expect(settings.topbar).toEqual(before);
    });

    it("the click that ends a drag does not press the button", async () => {
      const onOpenSettings = vi.fn();
      render(TopBar, { props: { ...base, onOpenSettings } });
      layOut();
      const gear = item("settings");
      await down(gear, mid(5));
      await move(mid(1));
      await up();
      await fireEvent.click(screen.getByTestId("topbar-settings"));
      expect(onOpenSettings).not.toHaveBeenCalled();
      expect(settings.topbar[0]).not.toBe("settings");
      expect(settings.topbar.indexOf("settings")).toBeLessThan(settings.topbar.indexOf("utilities"));
      // An ordinary click afterwards works again.
      await new Promise((r) => setTimeout(r, 5));
      await fireEvent.click(screen.getByTestId("topbar-settings"));
      expect(onOpenSettings).toHaveBeenCalledOnce();
    });

    it("a press without a move is just a click", async () => {
      const onOpenSettings = vi.fn();
      render(TopBar, { props: { ...base, onOpenSettings } });
      layOut();
      await down(item("settings"), mid(5));
      await up();
      await fireEvent.click(screen.getByTestId("topbar-settings"));
      expect(onOpenSettings).toHaveBeenCalledOnce();
      expect(settings.topbar).toEqual([...DEFAULT_TOPBAR]);
    });

    it("the right button does not start a drag", async () => {
      render(TopBar, { props: { ...base } });
      layOut();
      await fireEvent.pointerDown(item("broadcast"), { pointerId: 1, button: 2, clientX: mid(0), clientY: 18 });
      await move(mid(3));
      expect(topbarDrag.id).toBeNull();
    });
  });
});
