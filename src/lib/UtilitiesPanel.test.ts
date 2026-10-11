import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The network tools talk to the backend when they mount; this file is about the
// panel's own chrome, so they have nothing to say.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  netcheckRun: vi.fn(async () => ""),
  probeRun: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  listKnownHosts: vi.fn(async () => []),
}));

import UtilitiesPanel from "./UtilitiesPanel.svelte";
import { resetSettings, settings } from "./settings.svelte";
import { pinAction } from "./stores/topbarpins.svelte";

beforeEach(() => {
  localStorage.clear();
  resetSettings();
  flushSync();
});

describe("UtilitiesPanel — keeping a tool on the top bar (v1.16)", () => {
  it("the tool on screen is pinned and unpinned from its header", async () => {
    render(UtilitiesPanel, { props: { open: true, initialUtility: "cidr" } });
    const pin = await screen.findByTestId("utility-pin");
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin).toHaveAttribute("aria-label", "Keep on the top bar");

    await fireEvent.click(pin);
    expect(settings.topbar).toContain("util:cidr");
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(pin).toHaveAttribute("aria-label", "Remove from the top bar");

    await fireEvent.click(pin);
    expect(settings.topbar).not.toContain("util:cidr");
  });

  it("the button is about the tool that is open, not the last one touched", async () => {
    pinAction("util:jwt");
    render(UtilitiesPanel, { props: { open: true, initialUtility: "cidr" } });
    expect(await screen.findByTestId("utility-pin")).toHaveAttribute("aria-pressed", "false");
    await fireEvent.click(screen.getByTestId("utility-nav-jwt"));
    expect(screen.getByTestId("utility-pin")).toHaveAttribute("aria-pressed", "true");
  });

  it("the list marks the tools that are on the bar", async () => {
    pinAction("util:jwt");
    render(UtilitiesPanel, { props: { open: true, initialUtility: "cidr" } });
    await screen.findByTestId("utility-pin");
    expect(screen.getByTestId("utility-nav-jwt").querySelectorAll("svg")).toHaveLength(2);
    expect(screen.getByTestId("utility-nav-cidr").querySelectorAll("svg")).toHaveLength(1);
  });
});

// ── The session actions of the top bar (v1.16) ───────────────────────────────

import { waitFor, within } from "@testing-library/svelte";
import type { SessionActionState } from "./sessionactions";
import { SESSION_ACTIONS } from "./topbaractions";
import { unpinAction } from "./stores/topbarpins.svelte";

describe("UtilitiesPanel — the session actions", () => {
  const READY: SessionActionState = {
    connected: true,
    canRecord: true,
    recording: false,
    canBroadcast: true,
    broadcastActive: false,
    notesFor: "db-01",
  };
  const nav = (id: string) => screen.getByTestId(`utility-nav-session:${id}`);
  const rows = () =>
    [...screen.getByTestId("utilities-panel").querySelectorAll<HTMLElement>("nav [data-testid^='utility-nav-']")].map(
      (el) => el.dataset.testid!.replace("utility-nav-", ""),
    );

  it("stand in a group of their own, above the tools", async () => {
    render(UtilitiesPanel, { props: { open: true, actions: READY } });
    await screen.findByTestId("utilities-group-session");
    expect(screen.getByTestId("utilities-group-session").textContent?.trim()).toBe("Session");
    expect(screen.getByTestId("utilities-group-tools").textContent?.trim()).toBe("Tools");
    expect(rows().slice(0, SESSION_ACTIONS.length)).toEqual(SESSION_ACTIONS.map((id) => `session:${id}`));
    expect(rows()[SESSION_ACTIONS.length]).toBe("netcheck");
    // The window still opens on a tool, as it always did.
    expect(screen.getByTestId("utility-nav-netcheck")).toHaveAttribute("aria-current", "page");
  });

  it("without a page behind it the window lists the tools only", async () => {
    render(UtilitiesPanel, { props: { open: true, initialUtility: "cidr" } });
    await screen.findByTestId("utility-pin");
    expect(screen.queryByTestId("utilities-group-session")).toBeNull();
    expect(screen.queryByTestId("utilities-group-tools")).toBeNull();
    expect(rows()[0]).toBe("netcheck");
  });

  it("a row opens a card: what it is, the button that runs it, the pin", async () => {
    unpinAction("monitoring");
    const onSessionAction = vi.fn();
    const view = render(UtilitiesPanel, { props: { open: true, actions: READY, onSessionAction } });
    await fireEvent.click(await screen.findByTestId("utility-nav-session:monitoring"));

    const pane = screen.getByTestId("utility-pane");
    expect(within(pane).getByRole("heading", { level: 3 }).textContent?.trim()).toBe("Monitoring");
    expect(pane.textContent).toContain("Charts of the processor, memory, disks and network");
    const card = within(pane).getByTestId("session-action");
    expect(card.dataset.action).toBe("monitoring");
    // Taken off the bar: the card says so, and the pin puts it back.
    expect(within(card).getByTestId("session-action-offbar")).toBeInTheDocument();
    const pin = screen.getByTestId("utility-pin");
    expect(pin).toHaveAttribute("aria-pressed", "false");
    await fireEvent.click(pin);
    expect(settings.topbar).toContain("monitoring");
    expect(within(card).queryByTestId("session-action-offbar")).toBeNull();
    expect(nav("monitoring").querySelectorAll("svg")).toHaveLength(2);

    // Running it steps the window aside: the overlay it opens takes its place.
    await fireEvent.click(within(card).getByTestId("session-action-run"));
    expect(onSessionAction).toHaveBeenCalledWith("monitoring");
    await waitFor(() => expect(screen.queryByTestId("utilities-panel")).toBeNull());
    view.unmount();
  });

  it("a switch stays in the window and shows what it turned on", async () => {
    const onSessionAction = vi.fn();
    const view = render(UtilitiesPanel, { props: { open: true, actions: READY, onSessionAction } });
    await fireEvent.click(await screen.findByTestId("utility-nav-session:record"));
    const run = screen.getByTestId("session-action-run");
    expect(run.textContent?.trim()).toBe("Record session");
    expect(screen.queryByTestId("session-action-on")).toBeNull();

    await fireEvent.click(run);
    expect(onSessionAction).toHaveBeenCalledWith("record");
    expect(screen.getByTestId("utilities-panel")).toBeInTheDocument();

    // The page reports the recording as running.
    await view.rerender({ open: true, actions: { ...READY, recording: true }, onSessionAction });
    expect(screen.getByTestId("session-action-run").textContent?.trim()).toBe("Stop recording");
    expect(screen.getByTestId("session-action-on").textContent?.trim()).toBe("Recording is on");
  });

  it("an action that cannot run says why, next to a disabled button", async () => {
    const onSessionAction = vi.fn();
    const none: SessionActionState = { ...READY, connected: false, canBroadcast: false, notesFor: null };
    render(UtilitiesPanel, { props: { open: true, actions: none, onSessionAction } });

    await fireEvent.click(await screen.findByTestId("utility-nav-session:monitoring"));
    expect(screen.getByTestId("session-action-run")).toBeDisabled();
    expect(screen.getByTestId("session-action-reason").textContent?.trim()).toBe(
      "Open a tab with a connected session first",
    );
    await fireEvent.click(nav("broadcast"));
    expect(screen.getByTestId("session-action-reason").textContent?.trim()).toBe("Open a tab first");
    await fireEvent.click(nav("notes"));
    expect(screen.getByTestId("session-action-reason").textContent?.trim()).toBe(
      "Select a server in the tree, or open its tab",
    );
    expect(screen.queryByTestId("session-action-target")).toBeNull();
    // The library needs nothing.
    await fireEvent.click(nav("recordings"));
    expect(screen.getByTestId("session-action-run")).toBeEnabled();
    expect(screen.queryByTestId("session-action-reason")).toBeNull();
    expect(onSessionAction).not.toHaveBeenCalled();
  });

  it("the notes card names the server they would open for", async () => {
    render(UtilitiesPanel, { props: { open: true, actions: READY } });
    await fireEvent.click(await screen.findByTestId("utility-nav-session:notes"));
    expect(screen.getByTestId("session-action-target").textContent?.trim()).toBe("Notes of db-01");
  });

  it("the search finds an action, and the group heads only what it holds", async () => {
    render(UtilitiesPanel, { props: { open: true, actions: READY } });
    const search = await screen.findByTestId("utilities-search");
    // "broadcast" is also a word of the subnet calculator: both groups answer.
    await fireEvent.input(search, { target: { value: "broadcast" } });
    await waitFor(() => expect(rows()).toEqual(["session:broadcast", "cidr"]));
    expect(screen.getByTestId("utilities-group-tools")).toBeInTheDocument();
    // What matched is what is on screen — the pane never keeps a filtered-out row.
    expect(screen.getByTestId("session-action").dataset.action).toBe("broadcast");

    await fireEvent.input(search, { target: { value: "синхронный" } });
    await waitFor(() => expect(rows()).toEqual(["session:broadcast"]));
    expect(screen.queryByTestId("utilities-group-tools")).toBeNull();

    await fireEvent.input(search, { target: { value: "cidr" } });
    await waitFor(() => expect(rows()).toEqual(["cidr"]));
    expect(screen.queryByTestId("utilities-group-session")).toBeNull();
    expect(screen.queryByTestId("session-action")).toBeNull();
  });
});
