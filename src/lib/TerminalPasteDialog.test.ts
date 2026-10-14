import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TerminalPasteDialog from "./TerminalPasteDialog.svelte";

describe("TerminalPasteDialog", () => {
  it("starts losslessly and pastes the reviewed representation", async () => {
    const onpaste = vi.fn();
    render(TerminalPasteDialog, {
      props: { open: true, text: "echo one\necho two", onpaste },
    });

    expect(screen.getByTestId("paste-preview")).toHaveTextContent("echo one echo two");
    expect(screen.getByTestId("paste-preview").textContent).toBe("echo one\necho two");

    await userEvent.click(screen.getByRole("radio", { name: /One line/i }));
    expect(screen.getByTestId("paste-preview").textContent).toBe("echo one echo two");
    await userEvent.click(screen.getByRole("button", { name: "Paste" }));
    expect(onpaste).toHaveBeenCalledWith("echo one echo two");
  });

  it("warns when transforming comments", async () => {
    render(TerminalPasteDialog, {
      props: { open: true, text: "# inspect\nkubectl get pods" },
    });
    expect(screen.queryByTestId("paste-risk")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /One line/i }));
    expect(screen.getByTestId("paste-risk")).toBeInTheDocument();
  });

  it("does not offer POSIX continuation to other shell dialects", () => {
    render(TerminalPasteDialog, {
      props: { open: true, text: "Get-ChildItem\nSelect-Object Name", continuation: false },
    });
    expect(screen.queryByRole("radio", { name: /Continue with/i })).toBeNull();
  });
});
