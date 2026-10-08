import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitRun = vi.fn();
vi.mock("./api", () => ({
  gitRun: (...a: unknown[]) => gitRun(...a),
  writeToTerminal: vi.fn(),
}));

import GitPanel from "./GitPanel.svelte";
import { removeDockState, setDockCwd } from "./stores/dockstate.svelte";
import { panelSplits, resetPanelShares } from "./stores/panelsplit.svelte";

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

/** argv of every `git_run` call whose first token is `cmd`. */
const calls = (cmd: string) =>
  gitRun.mock.calls.map((c) => c[2] as string[]).filter((a) => a[0] === cmd);

async function mount(prod = false) {
  render(GitPanel, { props: { sessionId: "s1", terminalCwd: "/repo", prod } });
  await screen.findByRole("button", { name: "Pull" });
}

beforeEach(() => {
  removeDockState("s1");
  gitRun.mockReset().mockImplementation(async (_s: string, _c: string, args: string[]) =>
    args[0] === "rev-parse" ? ok("/repo\n") : ok(),
  );
});

describe("GitPanel confirmations", () => {
  it("asks before a pull on an ordinary (non-prod) server and runs it only on confirm", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(await screen.findByText("Confirm git action")).toBeInTheDocument();
    expect(screen.getByText("git pull", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("This server is marked as production.")).toBeNull();
    expect(calls("pull")).toHaveLength(0);

    await fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(calls("pull")).toHaveLength(1));
  });

  it("does nothing when the confirm is cancelled", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await screen.findByText("Confirm git action");
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Confirm git action")).toBeNull());
    expect(calls("push")).toHaveLength(0);
  });

  it("runs fetch straight away — nothing local changes", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(calls("fetch")).toHaveLength(1));
    expect(screen.queryByText("Confirm git action")).toBeNull();
  });

  it("adds the production warning on a prod tab", async () => {
    await mount(true);
    await fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(await screen.findByText("This server is marked as production.")).toBeInTheDocument();
  });
});

describe("GitPanel directory (v1.0.35)", () => {
  it("follows the terminal while following is off, not the file panel", async () => {
    setDockCwd("s1", "/home/u"); // the file panel opened home on connect
    const view = render(GitPanel, { props: { sessionId: "s1", terminalCwd: "/repo" } });
    await screen.findByRole("button", { name: "Pull" });
    expect(gitRun.mock.calls.every((c) => c[1] === "/repo")).toBe(true);

    // A `cd` in the terminal moves git; a move in the file panel does not.
    gitRun.mockClear();
    setDockCwd("s1", "/elsewhere");
    await view.rerender({ sessionId: "s1", terminalCwd: "/other" });
    await waitFor(() => expect(gitRun.mock.calls.some((c) => c[1] === "/other")).toBe(true));
    expect(gitRun.mock.calls.some((c) => c[1] === "/elsewhere")).toBe(false);
  });

  it("runs in the dock's shared directory while following", async () => {
    setDockCwd("s1", "/repo");
    render(GitPanel, {
      props: { sessionId: "s1", terminalCwd: "/term", followTerminal: true },
    });
    await screen.findByRole("button", { name: "Pull" });
    expect(gitRun.mock.calls.every((c) => c[1] === "/repo")).toBe(true);

    gitRun.mockClear();
    setDockCwd("s1", "/other");
    await waitFor(() => expect(gitRun.mock.calls.some((c) => c[1] === "/other")).toBe(true));
  });

  it("shows no path, not the panel's folder, while the terminal cwd is unknown", () => {
    setDockCwd("s1", "/home/u");
    render(GitPanel, { props: { sessionId: "s1" } });
    expect(screen.getByText("No path")).toBeTruthy();
    expect(gitRun).not.toHaveBeenCalled();
  });

  it("offers path sync only while following is off and the shell needs it", async () => {
    const onEnablePathSync = vi.fn();
    const view = render(GitPanel, { props: { sessionId: "s1", onEnablePathSync } });
    await fireEvent.click(screen.getByRole("button", { name: "Enable path sync" }));
    expect(onEnablePathSync).toHaveBeenCalledOnce();
    // Following on: the toolbar toggle owns it; no second button with another meaning.
    await view.rerender({ sessionId: "s1", followTerminal: true, onEnablePathSync });
    expect(screen.queryByRole("button", { name: "Enable path sync" })).toBeNull();
    // No setup needed (a local tab, or the shell already reports): nothing to offer.
    await view.rerender({ sessionId: "s1", followTerminal: false, onEnablePathSync: undefined });
    expect(screen.queryByRole("button", { name: "Enable path sync" })).toBeNull();
  });

  it("marks the follow toggle pressed like the file panel does", async () => {
    setDockCwd("s1", "/repo");
    render(GitPanel, {
      props: { sessionId: "s1", followTerminal: true, onToggleFollowTerminal: vi.fn() },
    });
    await screen.findByRole("button", { name: "Pull" });
    expect(screen.getByTestId("git-follow-terminal").getAttribute("aria-pressed")).toBe("true");
  });
});

// ── The wide layout (v1.7) ───────────────────────────────────────────────────

describe("GitPanel in a wide container", () => {
  /** Give the panel a width and let its observer see it (jsdom has no layout). */
  async function resize(width: number) {
    const root = document.querySelector<HTMLElement>("[data-wide]")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    // Whichever observer watches the panel: the others see no change.
    for (const o of observers) o.cb([]);
    await waitFor(() => expect(root.dataset.wide).toBe(String(width >= 768)));
  }
  const subTabs = () =>
    [...document.querySelectorAll("[data-testid^='git-subtab-']")].map((e) =>
      (e as HTMLElement).dataset.testid?.replace("git-subtab-", ""),
    );
  const columns = () =>
    [...document.querySelectorAll("[data-testid^='git-column-']")].map((e) =>
      (e as HTMLElement).dataset.testid?.replace("git-column-", ""),
    );

  it("a narrow dock shows one view at a time, behind three sub-tabs", async () => {
    await mount();
    expect(subTabs()).toEqual(["graph", "changes", "branches"]);
    expect(columns()).toEqual(["changes"]);
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    expect(columns()).toEqual(["graph"]);
  });

  it("wide: the history stands beside the changes and is no longer a tab", async () => {
    await mount();
    await resize(1200);
    expect(subTabs()).toEqual(["changes", "branches"]);
    expect(columns()).toEqual(["changes", "graph"]);
    // The sub-tabs join the toolbar row.
    expect(screen.getByTestId("git-subtabs-wide")).toContainElement(screen.getByTestId("git-subtab-changes"));
    expect(screen.getByTestId("git-subtab-changes")).toHaveAttribute("aria-current", "true");
  });

  it("wide: the border between the two columns is dragged; narrow has none", async () => {
    resetPanelShares();
    await mount();
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(screen.getByTestId("git-column-changes").style.width).toBe("");
    await resize(1200);
    const left = screen.getByTestId("git-column-changes");
    const divider = screen.getByTestId("panel-divider");
    expect(divider).toHaveAttribute("data-split", "git");
    expect(divider.previousElementSibling).toBe(left);
    expect(divider.nextElementSibling).toBe(screen.getByTestId("git-column-graph"));
    // The history starts as the wider one.
    expect(left.style.width).toBe("40%");

    const row = left.parentElement!;
    Object.defineProperty(row, "clientWidth", { configurable: true, value: 1000 });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const o of observers) o.cb([{ target: row }]);
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = vi.fn();
    await fireEvent.pointerDown(divider, { pointerId: 1, clientX: 400, clientY: 10 });
    await fireEvent.pointerMove(divider, { pointerId: 1, clientX: 550, clientY: 10 });
    await fireEvent.pointerUp(divider, { pointerId: 1, clientX: 550, clientY: 10 });
    expect(panelSplits.shares.git).toBeCloseTo(0.55);
    expect(left.style.width).toBe("55%");
    // The branches take the same column, at the same width.
    await fireEvent.click(screen.getByTestId("git-subtab-branches"));
    expect(screen.getByTestId("git-column-branches").style.width).toBe("55%");
    // Narrow again: one view, the whole width, no border.
    await resize(400);
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(screen.getByTestId("git-column-branches").style.width).toBe("");
    resetPanelShares();
  });

  it("wide: branches take the left column, the history stays", async () => {
    await mount();
    await resize(1200);
    await fireEvent.click(screen.getByTestId("git-subtab-branches"));
    expect(columns()).toEqual(["branches", "graph"]);
    expect(screen.getByTestId("git-subtab-branches")).toHaveAttribute("aria-current", "true");
  });

  it("a panel left on the history shows changes beside it when wide — and the history again when narrow", async () => {
    await mount();
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    await resize(1200);
    expect(columns()).toEqual(["changes", "graph"]);
    expect(screen.getByTestId("git-subtab-changes")).toHaveAttribute("aria-current", "true");
    await resize(400);
    expect(subTabs()).toEqual(["graph", "changes", "branches"]);
    expect(columns()).toEqual(["graph"]);
    expect(screen.getByTestId("git-subtab-graph")).toHaveAttribute("aria-current", "true");
  });

  it("widening the panel does not ask git for anything again", async () => {
    await mount();
    await waitFor(() => expect(calls("log")).toHaveLength(1));
    await resize(1200);
    await resize(400);
    await resize(1200);
    expect(calls("log")).toHaveLength(1);
    expect(calls("status")).toHaveLength(1);
  });
});
