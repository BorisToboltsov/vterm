import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";
import PathSyncDialog, { type PathSyncAsk } from "./PathSyncDialog.svelte";

const ssh = (p: Partial<PathSyncAsk> = {}): PathSyncAsk => ({
  sessionId: "s1",
  kind: "ssh",
  target: "Timeweb1",
  prod: false,
  needsSetup: true,
  ...p,
});

function open(ask: PathSyncAsk | null) {
  const onanswer = vi.fn();
  const oncancel = vi.fn();
  const r = render(PathSyncDialog, { props: { ask, onanswer, oncancel } });
  return { ...r, onanswer, oncancel };
}

describe("PathSyncDialog", () => {
  it("renders nothing without a question", () => {
    open(null);
    expect(screen.queryByTestId("path-sync-choices")).toBeNull();
  });

  it("offers three answers, starts at “only now” and names the server", async () => {
    const { onanswer } = open(ssh());
    expect(screen.getByTestId("path-sync-once")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("path-sync-always")).toHaveTextContent("Always on Timeweb1");
    expect(screen.getByTestId("path-sync-setup")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("path-sync-confirm"));
    expect(onanswer).toHaveBeenCalledWith("once");
  });

  it("answers with the tile chosen", async () => {
    const { onanswer } = open(ssh());
    await userEvent.click(screen.getByTestId("path-sync-manual"));
    expect(screen.getByTestId("path-sync-manual")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/without asking whenever a shell/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("path-sync-confirm"));
    expect(onanswer).toHaveBeenCalledWith("manual");
  });

  it("arrow keys move the choice like a radio group", async () => {
    open(ssh());
    screen.getByTestId("path-sync-once").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByTestId("path-sync-manual")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(screen.getByTestId("path-sync-manual"));
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByTestId("path-sync-always")).toHaveAttribute("aria-checked", "true");
  });

  it("shows the command a lasting answer would type, even when this shell reports its folder", async () => {
    open(ssh({ needsSetup: false }));
    expect(screen.queryByTestId("path-sync-setup")).toBeNull();
    expect(screen.getByText("The file and Git panels will follow the terminal's folder.")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("path-sync-always"));
    expect(screen.getByTestId("path-sync-setup")).toBeInTheDocument();
    expect(screen.getByText(/already reports its folder/)).toBeInTheDocument();
    expect(screen.getByText(/at every connect\./)).toBeInTheDocument();
  });

  it("warns on a prod server only for “always”", async () => {
    open(ssh({ prod: true }));
    expect(screen.queryByTestId("path-sync-prod")).toBeNull();
    await userEvent.click(screen.getByTestId("path-sync-always"));
    expect(screen.getByTestId("path-sync-prod")).toBeInTheDocument();
  });

  it("a local tab is “this computer”, with no command and the settings pointer", () => {
    open(ssh({ kind: "local", target: null, needsSetup: false }));
    expect(screen.getByTestId("path-sync-always")).toHaveTextContent("Always on this computer");
    expect(screen.queryByTestId("path-sync-setup")).toBeNull();
    expect(screen.getByText("You can change it later in Settings → Terminal.")).toBeInTheDocument();
  });

  it("cancel answers nothing", async () => {
    const { onanswer, oncancel } = open(ssh());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(oncancel).toHaveBeenCalledOnce();
    expect(onanswer).not.toHaveBeenCalled();
  });

  it("a new question starts at “only now” again", async () => {
    const { rerender } = open(ssh());
    await userEvent.click(screen.getByTestId("path-sync-always"));
    await rerender({ ask: ssh({ sessionId: "s2" }) });
    flushSync();
    expect(screen.getByTestId("path-sync-once")).toHaveAttribute("aria-checked", "true");
  });
});
