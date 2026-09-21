import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitRun = vi.fn();
vi.mock("./api", () => ({
  gitRun: (...a: unknown[]) => gitRun(...a),
  writeToTerminal: vi.fn(),
}));

import GitPanel from "./GitPanel.svelte";
import { removeDockState, setDockCwd } from "./stores/dockstate.svelte";

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

/** argv of every `git_run` call whose first token is `cmd`. */
const calls = (cmd: string) =>
  gitRun.mock.calls.map((c) => c[2] as string[]).filter((a) => a[0] === cmd);

async function mount(prod = false) {
  setDockCwd("s1", "/repo");
  render(GitPanel, { props: { sessionId: "s1", prod } });
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
    expect(screen.queryByText("This server is tagged production.")).toBeNull();
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
    expect(await screen.findByText("This server is tagged production.")).toBeInTheDocument();
  });
});

describe("GitPanel directory (v1.0.24)", () => {
  it("runs in the dock's shared directory and moves with it", async () => {
    setDockCwd("s1", "/repo");
    render(GitPanel, { props: { sessionId: "s1" } });
    await screen.findByRole("button", { name: "Pull" });
    expect(gitRun.mock.calls.every((c) => c[1] === "/repo")).toBe(true);

    // The file panel opened another repo: git follows it, not the terminal.
    gitRun.mockClear();
    setDockCwd("s1", "/other");
    await waitFor(() => expect(gitRun.mock.calls.some((c) => c[1] === "/other")).toBe(true));
  });

  it("offers to follow the terminal only while following is off", async () => {
    const view = render(GitPanel, {
      props: { sessionId: "s1", followTerminal: false, onToggleFollowTerminal: vi.fn() },
    });
    expect(screen.getByRole("button", { name: "Follow terminal path" })).toBeTruthy();
    // Already on: the same button would switch following OFF.
    await view.rerender({ sessionId: "s1", followTerminal: true, onToggleFollowTerminal: vi.fn() });
    expect(screen.queryByRole("button", { name: "Follow terminal path" })).toBeNull();
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
