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

  it("hides a level when its chip is toggled off", async () => {
    render(JsonLogView, { props: { entries } });
    await fireEvent.click(screen.getByRole("button", { name: "Toggle info level" }));
    expect(screen.queryByText("started ok")).not.toBeInTheDocument();
    expect(screen.getByText("disk full")).toBeInTheDocument();
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

  it("invokes onShowRaw when the toolbar's Raw segment is clicked", async () => {
    let raw = 0;
    render(JsonLogView, { props: { entries, onShowRaw: () => (raw += 1) } });
    // Table is the active mode here; clicking Raw switches back to the terminal.
    await fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(raw).toBe(1);
    await fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(raw).toBe(1); // already in table mode — no extra call
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
});
