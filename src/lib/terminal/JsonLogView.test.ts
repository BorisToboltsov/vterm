import { render, screen, fireEvent } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import JsonLogView from "./JsonLogView.svelte";
import type { JsonLogEntry } from "./jsonlog";

// jsdom lacks pointer capture; the resize grip calls it on pointerdown.
Element.prototype.setPointerCapture ??= vi.fn();
Element.prototype.releasePointerCapture ??= vi.fn();

const entries: JsonLogEntry[] = [
  {
    seq: 1,
    ts: "t1",
    level: "info",
    message: "started ok",
    raw: { msg: "started ok", a: 1 },
    format: "json",
    source: '{"msg":"started ok","a":1}',
  },
  {
    seq: 2,
    ts: "t2",
    level: "error",
    message: "disk full",
    raw: { msg: "disk full", code: "ENOSPC" },
    format: "json",
    source: '{"msg":"disk full","code":"ENOSPC"}',
  },
];

describe("JsonLogView", () => {
  it("keeps row copy alongside column switches and filters instead of replacing it with the background menu", async () => {
    render(JsonLogView, { entries });
    await fireEvent.contextMenu(screen.getByText("started ok"));
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Columns" }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "a" }));
    expect(screen.getByRole("columnheader", { name: "a" })).toBeInTheDocument();
    const field = screen.getByPlaceholderText("Filter logs…");
    await fireEvent.input(field, { target: { value: "missing" } });
    await fireEvent.contextMenu(screen.getByTestId("jsonlog-view"));
    expect(screen.queryByRole("menuitem", { name: "Copy" })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Reset search and filters" }));
    expect(screen.getByText("started ok")).toBeInTheDocument();
  });

  it("confirms clearing from the context menu", async () => {
    const onClear = vi.fn();
    render(JsonLogView, { entries, onClear });
    await fireEvent.contextMenu(screen.getByTestId("jsonlog-view"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Clear" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onClear).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId("confirm"));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("shows the empty state when there are no entries", () => {
    render(JsonLogView, { props: { entries: [] } });
    expect(screen.getByText("No structured logs yet")).toBeInTheDocument();
  });

  it("expands a row to reveal format badge and copy control", async () => {
    render(JsonLogView, { props: { entries } });
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    const [firstDetails] = screen.getAllByRole("button", { name: "Toggle details" });
    await fireEvent.click(firstDetails);
    expect(screen.getByText("json")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("renders a row per entry with its message", () => {
    render(JsonLogView, { props: { entries } });
    expect(screen.getByText("started ok")).toBeInTheDocument();
    expect(screen.getByText("disk full")).toBeInTheDocument();
  });

  it("colours an error level cell with the danger class", () => {
    render(JsonLogView, { props: { entries } });
    const cell = screen.getByRole("cell", { name: "error" });
    expect(cell.className).toContain("text-danger");
  });

  it("filters entries by the query and updates the count", async () => {
    render(JsonLogView, { props: { entries } });
    const input = screen.getByPlaceholderText("Filter logs…");
    await fireEvent.input(input, { target: { value: "disk" } });
    expect(screen.queryByText("started ok")).not.toBeInTheDocument();
    expect(screen.getByText("disk full")).toBeInTheDocument();
  });

  it("shows a no-matches note when the filter excludes everything", async () => {
    render(JsonLogView, { props: { entries } });
    const input = screen.getByPlaceholderText("Filter logs…");
    await fireEvent.input(input, { target: { value: "zzz-nope" } });
    expect(screen.getByText("No matching entries")).toBeInTheDocument();
  });

  it("keeps the levels picked in the level facet (v1.29: the funnel of a narrow view)", async () => {
    render(JsonLogView, { props: { entries } });
    await fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /Level/ }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /error/ }));
    expect(screen.queryByText("started ok")).not.toBeInTheDocument();
    expect(screen.getByText("disk full")).toBeInTheDocument();
    // The field says how many of how many while the view is narrowed.
    expect(screen.getByTestId("jsonlog-header-field-count")).toHaveTextContent(/1 of \d+/);
  });

  it("adds an extra column from the JSON fields picker", async () => {
    render(JsonLogView, { props: { entries } });
    await fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    await fireEvent.click(screen.getByRole("checkbox", { name: "code" }));
    expect(screen.getByRole("columnheader", { name: "code" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "ENOSPC" })).toBeInTheDocument();
  });

  it("confirms before clearing, then invokes onClear and resets columns", async () => {
    let cleared = 0;
    render(JsonLogView, { props: { entries, onClear: () => (cleared += 1) } });
    // Add a column.
    await fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    await fireEvent.click(screen.getByRole("checkbox", { name: "code" }));
    expect(screen.getByRole("columnheader", { name: "code" })).toBeInTheDocument();
    // Clicking Clear opens a confirmation; nothing is cleared yet.
    await fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(cleared).toBe(0);
    expect(screen.getByText("Clear log table?")).toBeInTheDocument();
    // Confirm.
    await fireEvent.click(screen.getByTestId("confirm"));
    expect(cleared).toBe(1);
    expect(screen.queryByRole("columnheader", { name: "code" })).not.toBeInTheDocument();
  });

  it("cancelling the clear confirmation keeps the data", async () => {
    let cleared = 0;
    render(JsonLogView, { props: { entries, onClear: () => (cleared += 1) } });
    await fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cleared).toBe(0);
    expect(screen.getByText("disk full")).toBeInTheDocument();
  });

  it("carries no Raw/Table switch — it lives in the session bar above the terminal", () => {
    render(JsonLogView, { props: { entries } });
    expect(screen.queryByTestId("view-mode-toggle")).not.toBeInTheDocument();
  });

  it("widens a column when its resize grip is dragged", async () => {
    const { container } = render(JsonLogView, { props: { entries } });
    // The time column is the 2nd <col> (after the fixed expand-toggle column).
    const timeCol = () => container.querySelectorAll("colgroup col")[1] as HTMLElement;
    const before = parseInt(timeCol().style.width, 10);

    const timeGrip = container.querySelectorAll<HTMLElement>(".cursor-col-resize")[0];
    await fireEvent.pointerDown(timeGrip, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerMove(timeGrip, { clientX: 160, pointerId: 1 });
    await fireEvent.pointerUp(timeGrip, { clientX: 160, pointerId: 1 });

    expect(parseInt(timeCol().style.width, 10)).toBe(before + 60);
  });

  it("lets a column be resized from any row: the grip reaches down the table", () => {
    render(JsonLogView, { props: { entries } });
    const grip = screen.getByTestId("jsonlog-grip-time");
    // In the header cell, as tall as the table's visible part (`--list-h`).
    expect(grip.closest("th")).not.toBeNull();
    expect(grip.className).toContain("h-[var(--list-h,100%)]");
    expect(grip).toHaveClass("cursor-col-resize");
  });

  it("does not clip the grip in the header of an added column", async () => {
    render(JsonLogView, { props: { entries } });
    await fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    await fireEvent.click(screen.getByRole("checkbox", { name: "code" }));
    const th = screen.getByRole("columnheader", { name: "code" });
    // The title truncates; the cell must not, or the grip ends at the header.
    expect(th.className).not.toMatch(/(^|\s)(truncate|overflow-hidden)(\s|$)/);
    expect(th.querySelector("span")).toHaveClass("truncate");
    expect(th).toContainElement(screen.getByTestId("jsonlog-grip-x:code"));
  });

  it("puts a column back to its default width on a double click of its border", async () => {
    const { container } = render(JsonLogView, { props: { entries } });
    const timeCol = () => container.querySelectorAll("colgroup col")[1] as HTMLElement;
    const before = timeCol().style.width;
    const grip = screen.getByTestId("jsonlog-grip-time");
    await fireEvent.pointerDown(grip, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerMove(grip, { clientX: 180, pointerId: 1 });
    await fireEvent.pointerUp(grip, { clientX: 180, pointerId: 1 });
    expect(timeCol().style.width).not.toBe(before);
    await fireEvent.dblClick(grip);
    expect(timeCol().style.width).toBe(before);
  });
});
