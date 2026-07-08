import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { createRawSnippet } from "svelte";
import { describe, expect, it, vi } from "vitest";
import Modal from "./Modal.svelte";
import ConfirmDialog from "./ConfirmDialog.svelte";

// A tiny text snippet usable as `children`.
const text = (s: string) =>
  createRawSnippet(() => ({ render: () => `<span>${s}</span>` }));

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(Modal, { props: { open: false, title: "Hi", children: text("body") } });
    expect(screen.queryByText("Hi")).toBeNull();
  });

  it("renders title and children when open", () => {
    render(Modal, { props: { open: true, title: "Settings", children: text("body") } });
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("calls onclose when the backdrop is clicked", async () => {
    const onclose = vi.fn();
    render(Modal, { props: { open: true, onclose, children: text("body") } });
    await userEvent.click(screen.getByLabelText("Close dialog"));
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("calls onclose on Escape", async () => {
    const onclose = vi.fn();
    render(Modal, { props: { open: true, onclose, children: text("body") } });
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("renders without a title heading when none is given", () => {
    const { container } = render(Modal, { props: { open: true, children: text("body") } });
    expect(container.querySelector("h2")).toBeNull();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("ignores non-Escape keys", async () => {
    const onclose = vi.fn();
    render(Modal, { props: { open: true, onclose, children: text("body") } });
    await userEvent.keyboard("a");
    expect(onclose).not.toHaveBeenCalled();
  });

  it("shows no close (×) button by default", () => {
    render(Modal, { props: { open: true, title: "Hi", onclose: vi.fn(), children: text("body") } });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("shows a close (×) button when showClose is set, and clicking it closes", async () => {
    const onclose = vi.fn();
    render(Modal, {
      props: { open: true, title: "Hi", showClose: true, onclose, children: text("body") },
    });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("keeps initial focus on the first form control even with a close button", () => {
    // The × lives outside the dialog/trap, so it must not steal the opening focus.
    render(Modal, { props: { open: true, title: "T", showClose: true, onclose: vi.fn(), children: twoButtons } });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "one" }));
  });

  it("exposes dialog semantics (role/aria-modal/aria-label)", () => {
    render(Modal, { props: { open: true, title: "Edit server", children: text("body") } });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Edit server");
  });

  // A children snippet with two focusable controls for focus-management tests.
  const twoButtons = createRawSnippet(() => ({
    render: () => `<span><button>one</button><button>two</button></span>`,
  }));

  it("moves focus into the dialog on open (first control)", () => {
    render(Modal, { props: { open: true, title: "T", children: twoButtons } });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "one" }));
  });

  it("traps Tab within the dialog (wraps at the edges)", async () => {
    render(Modal, { props: { open: true, title: "T", children: twoButtons } });
    const one = screen.getByRole("button", { name: "one" });
    const two = screen.getByRole("button", { name: "two" });
    expect(document.activeElement).toBe(one);
    // Shift+Tab from the first control wraps to the last.
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(two);
    // Tab from the last control wraps back to the first.
    await userEvent.tab();
    expect(document.activeElement).toBe(one);
  });
});

describe("ConfirmDialog", () => {
  it("wires confirm and cancel callbacks", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(ConfirmDialog, {
      props: {
        open: true,
        title: "Delete folder?",
        confirmLabel: "Delete",
        onconfirm,
        oncancel,
        children: text("Are you sure?"),
      },
    });
    expect(screen.getByText("Delete folder?")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("confirm"));
    expect(onconfirm).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(oncancel).toHaveBeenCalledOnce();
  });

  it("uses an accent (non-danger) confirm button when danger=false", () => {
    render(ConfirmDialog, {
      props: {
        open: true,
        title: "Close tab?",
        confirmLabel: "Close",
        danger: false,
        children: text("Session ends."),
      },
    });
    const confirm = screen.getByTestId("confirm");
    expect(confirm.className).toContain("bg-accent");
    expect(confirm.className).not.toContain("bg-danger");
  });
});
