import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import ColumnHead from "./ColumnHead.svelte";
import { COL_MIN, LIST_COLUMNS } from "./colwidths";
import { columnWidth, resetColumnWidths, setColumnWidth } from "./stores/colwidths.svelte";

const START = LIST_COLUMNS["docker.image"];

function grip() {
  const el = screen.getByTestId("column-grip-docker.image");
  // jsdom has no pointer capture; the action only needs the calls not to throw.
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  return el;
}

async function drag(dx: number) {
  const el = grip();
  await fireEvent(el, new PointerEvent("pointerdown", { clientX: 300, clientY: 10 }));
  await fireEvent(el, new PointerEvent("pointermove", { clientX: 300 + dx, clientY: 10 }));
  await fireEvent(el, new PointerEvent("pointerup", {}));
}

beforeEach(() => {
  localStorage.clear();
  resetColumnWidths();
  flushSync();
});

describe("ColumnHead", () => {
  const props = { col: "docker.image" as const, label: "Image", class: "w-[var(--c-image)] px-2" };

  it("shows the column's title and carries the width classes it is given", () => {
    render(ColumnHead, { props });
    const head = screen.getByTestId("column-docker.image");
    expect(head).toHaveTextContent("Image");
    // The same width variable its rows read — the header does not size itself.
    expect(head.className).toContain("w-[var(--c-image)]");
    expect(head.getAttribute("style")).toBeNull();
    // Shrinks like a row cell when the list is tight, and is ruled on the right.
    expect(head).toHaveClass("min-w-0", "border-r");
  });

  it("truncates its title, not itself — the grip has to overflow the cell", () => {
    // `overflow: hidden` on the cell would cut the grip off at the header's bottom
    // edge, and the column could again be resized only next to its title.
    render(ColumnHead, { props });
    const head = screen.getByTestId("column-docker.image");
    expect(head.className).not.toMatch(/(^|\s)(truncate|overflow-hidden)(\s|$)/);
    expect(screen.getByText("Image")).toHaveClass("block", "truncate");
    expect(head).toContainElement(grip());
  });

  it("reaches down the whole list, so the border can be dragged from any row", () => {
    render(ColumnHead, { props });
    // The list tells the grip how tall it is; without that it covers the header.
    expect(grip().className).toContain("h-[var(--list-h,100%)]");
    expect(grip()).toHaveClass("absolute", "top-0", "z-10");
  });

  it("is easier to grab than to see: an 8px zone around a 2px line", () => {
    render(ColumnHead, { props });
    // Centred on the column's border: 4px into this cell, 4px into the next.
    expect(grip()).toHaveClass("w-2", "-right-1");
    expect(grip().firstElementChild).toHaveClass("w-0.5");
  });

  it("resizes its column by the distance its border is dragged", async () => {
    render(ColumnHead, { props });
    await drag(60);
    expect(columnWidth("docker.image")).toBe(START + 60);
    // The next drag starts from the new width, not from the default.
    await drag(-25);
    expect(columnWidth("docker.image")).toBe(START + 35);
  });

  it("stops at the minimum width", async () => {
    render(ColumnHead, { props });
    await drag(-5000);
    expect(columnWidth("docker.image")).toBe(COL_MIN);
  });

  it("puts the default width back on a double click of the border", async () => {
    setColumnWidth("docker.image", 500);
    render(ColumnHead, { props });
    await fireEvent.dblClick(grip());
    expect(columnWidth("docker.image")).toBe(START);
  });

  it("keeps the drag handle out of the header's accessible name", () => {
    render(ColumnHead, { props });
    expect(grip().getAttribute("aria-hidden")).toBe("true");
    expect(grip()).toHaveClass("cursor-col-resize");
  });
});
