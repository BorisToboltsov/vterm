import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitRun = vi.fn();
vi.mock("./api", () => ({
  gitRun: (...a: unknown[]) => gitRun(...a),
  writeToTerminal: vi.fn(),
}));

import GitPanel from "./GitPanel.svelte";

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

/** argv of every `git_run` call whose first token is `cmd`. */
const calls = (cmd: string) =>
  gitRun.mock.calls.map((c) => c[2] as string[]).filter((a) => a[0] === cmd);

async function mount(prod = false) {
  render(GitPanel, { props: { sessionId: "s1", terminalCwd: "/repo", prod } });
  await screen.findByRole("button", { name: "Pull" });
}

beforeEach(() => {
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
