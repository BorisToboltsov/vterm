import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import QuitDialog from "./QuitDialog.svelte";

describe("QuitDialog", () => {
  it("asks even when nothing would be cut off", () => {
    render(QuitDialog, { props: { open: true, rows: [] } });
    expect(screen.getByText("Quit vterm?")).toBeInTheDocument();
    expect(screen.getByTestId("confirm")).toHaveTextContent("Quit");
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.queryByTestId("quit-rows")).toBeNull();
  });

  it("lists each kind on its own row with its count", () => {
    render(QuitDialog, {
      props: {
        open: true,
        rows: [
          { key: "ssh", count: 3 },
          { key: "recording", count: 1 },
        ],
      },
    });
    expect(screen.getByTestId("quit-row-ssh")).toHaveTextContent(/SSH connections\s*3/);
    expect(screen.getByTestId("quit-row-recording")).toHaveTextContent(/Session recordings\s*1/);
    expect(screen.queryByTestId("quit-row-local")).toBeNull();
  });

  it("asks about a secondary window in its own words, with that window's rows", () => {
    // A window a tab was moved out to (ADR 0017): closing it ends its sessions,
    // the app stays — so the question is about the window, not about quitting.
    render(QuitDialog, {
      props: { open: true, kind: "window", rows: [{ key: "local", count: 2 }] },
    });
    expect(screen.getByText("Close this window?")).toBeInTheDocument();
    expect(screen.queryByText("Quit vterm?")).toBeNull();
    expect(screen.getByTestId("confirm")).toHaveTextContent("Close window");
    expect(screen.getByTestId("quit-row-local")).toHaveTextContent(/Local tabs\s*2/);
  });

  it("confirms and cancels through the callbacks", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(QuitDialog, { props: { open: true, rows: [], onconfirm, oncancel } });
    await userEvent.click(screen.getByTestId("confirm"));
    await userEvent.click(screen.getByText("Cancel"));
    expect(onconfirm).toHaveBeenCalledOnce();
    expect(oncancel).toHaveBeenCalledOnce();
  });
});
