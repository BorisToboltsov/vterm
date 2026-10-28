import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FileLinkDialog from "./FileLinkDialog.svelte";
import type { FileLinkQuestion } from "./termfiles";

const file = (p: Partial<Extract<FileLinkQuestion, { kind: "open" }>> = {}): FileLinkQuestion => ({
  kind: "open",
  sessionId: "s1",
  target: { kind: "file", path: "/etc/nginx/nginx.conf" },
  where: "web-01",
  prod: false,
  ...p,
});

function open(ask: FileLinkQuestion | null) {
  const onanswer = vi.fn();
  render(FileLinkDialog, { props: { ask, onanswer } });
  return onanswer;
}

describe("FileLinkDialog", () => {
  it("renders nothing without a question", () => {
    open(null);
    expect(screen.queryByTestId("filelink-path")).toBeNull();
  });

  it("names the server and the whole path, and opens on the answer", async () => {
    const onanswer = open(file());
    expect(screen.getByText("Open the file?")).toBeInTheDocument();
    expect(screen.getByTestId("filelink-where")).toHaveTextContent("web-01");
    expect(screen.getByTestId("filelink-path")).toHaveTextContent("/etc/nginx/nginx.conf");
    expect(screen.queryByTestId("filelink-prod")).toBeNull();
    await userEvent.click(screen.getByTestId("filelink-open"));
    expect(onanswer).toHaveBeenCalledWith("open", false);
  });

  it("passes “don't ask again” with the answer", async () => {
    const onanswer = open(file());
    await userEvent.click(screen.getByTestId("filelink-silence"));
    await userEvent.click(screen.getByTestId("filelink-open"));
    expect(onanswer).toHaveBeenCalledWith("open", true);
  });

  it("says “this computer” for a local tab, and warns about a production server", () => {
    open(file({ where: null, prod: true }));
    expect(screen.getByTestId("filelink-where")).toHaveTextContent("This computer");
    expect(screen.getByTestId("filelink-prod")).toBeInTheDocument();
  });

  it("says the line a place in the file opens on", () => {
    open(file({ target: { kind: "file", path: "/srv/app/main.c", line: 42 } }));
    expect(screen.getByTestId("filelink-hint")).toHaveTextContent("at line 42");
  });

  it("asks about a folder as a folder", () => {
    open(file({ target: { kind: "dir", path: "/srv/app" } }));
    expect(screen.getByText("Show the folder?")).toBeInTheDocument();
    expect(screen.getByText(/opens in the file panel/i)).toBeInTheDocument();
  });

  it("cancels without opening", async () => {
    const onanswer = open(file());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onanswer).toHaveBeenCalledWith("cancel", false);
  });

  it("offers path sync where the folder is unknown", async () => {
    const onanswer = open({ kind: "sync", sessionId: "s1", where: "web-01", following: false });
    expect(screen.getByTestId("filelink-sync-body")).toHaveTextContent(/does not report which folder/);
    await userEvent.click(screen.getByTestId("filelink-sync"));
    expect(onanswer).toHaveBeenCalledWith("sync", false);
  });

  it("only explains when path sync is already on", async () => {
    const onanswer = open({ kind: "sync", sessionId: "s1", where: "web-01", following: true });
    expect(screen.getByTestId("filelink-sync-body")).toHaveTextContent(/Path sync is on/);
    expect(screen.queryByTestId("filelink-sync")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onanswer).toHaveBeenCalledWith("cancel", false);
  });
});
