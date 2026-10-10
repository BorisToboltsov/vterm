import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CopyToDialog from "./CopyToDialog.svelte";

// (A prop named `target` collides with testing-library's own mount option, so the
// props are always passed under `props`.)

const target = { sessionId: "db", title: "db-01", local: false, prod: false };

describe("CopyToDialog", () => {
  it("names the tab, the file and the folder it will land in", () => {
    render(CopyToDialog, { props: { open: true, target, names: ["nginx.conf"], dir: "/srv/backup" } });
    expect(screen.getByText("Copy to “db-01”")).toBeInTheDocument();
    expect(screen.getByText("“nginx.conf” will be copied into the folder:")).toBeInTheDocument();
    expect((screen.getByTestId("copy-to-dir") as HTMLInputElement).value).toBe("/srv/backup");
  });

  it("counts a selection of several", () => {
    render(CopyToDialog, { props: { open: true, target, names: ["a", "b", "c"], dir: "/srv" } });
    expect(
      screen.getByText("The selected items (3) will be copied into the folder:"),
    ).toBeInTheDocument();
  });

  it("copies into the folder as typed", async () => {
    const onconfirm = vi.fn();
    render(CopyToDialog, { props: { open: true, target, names: ["a"], dir: "/srv", onconfirm } });
    await fireEvent.input(screen.getByTestId("copy-to-dir"), { target: { value: "  /var/www " } });
    await fireEvent.click(screen.getByTestId("copy-to-confirm"));
    expect(onconfirm).toHaveBeenCalledWith("/var/www");
  });

  it("does not copy into a folder that names nothing", async () => {
    const onconfirm = vi.fn();
    render(CopyToDialog, { props: { open: true, target, names: ["a"], dir: "  ", onconfirm } });
    expect(screen.getByTestId("copy-to-confirm")).toBeDisabled();
    await fireEvent.submit(screen.getByTestId("copy-to-dir").closest("form")!);
    expect(onconfirm).not.toHaveBeenCalled();
  });

  it("warns when the tab is a production server", () => {
    render(CopyToDialog, { props: { open: true, target: { ...target, prod: true }, names: ["a"], dir: "/srv" } });
    expect(screen.getByText("This server is marked as production.")).toBeInTheDocument();
  });

  it("says the bytes pass through the app when both sides are servers — and only then", () => {
    const { unmount } = render(CopyToDialog, { props: { open: true, target, names: ["a"], dir: "/srv", throughApp: true,
    } });
    expect(screen.getByText(/go from server to server through this app/)).toBeInTheDocument();
    unmount();
    render(CopyToDialog, { props: { open: true, target, names: ["a"], dir: "/srv" } });
    expect(screen.queryByText(/go from server to server through this app/)).toBeNull();
  });

  it("cancel copies nothing", async () => {
    const [onconfirm, oncancel] = [vi.fn(), vi.fn()];
    render(CopyToDialog, { props: { open: true, target, names: ["a"], dir: "/srv", onconfirm, oncancel } });
    await fireEvent.click(screen.getByText("Cancel"));
    expect(oncancel).toHaveBeenCalled();
    expect(onconfirm).not.toHaveBeenCalled();
  });
});
