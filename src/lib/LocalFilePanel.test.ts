import { render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LocalFilePanel from "./LocalFilePanel.svelte";
import type { FileEntry } from "./types";

// The file listing as a table (v1.7). `FileBrowser.svelte` has no test file of
// its own (its name collides with `filebrowser.ts` on a case-insensitive volume —
// `filecase.guard`), so the listing is rendered through the local panel.

const api = vi.hoisted(() => ({
  localList: vi.fn(),
  localHome: vi.fn(),
}));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  localList: api.localList,
  localHome: api.localHome,
}));

const MODIFIED = Math.floor(new Date(2026, 9, 7, 14, 3).getTime() / 1000);

const entry = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/home/ops/${name}`,
  isDir: false,
  isSymlink: false,
  size: 2048,
  modified: MODIFIED,
  mode: 0o644,
  attrs: null,
  uid: 1000,
  gid: 50,
  user: "ops",
  group: "staff",
  drive: null,
  ...over,
});

async function renderPanel(entries: FileEntry[]) {
  api.localHome.mockResolvedValue("/home/ops");
  api.localList.mockResolvedValue(entries);
  render(LocalFilePanel, { props: { sessionId: "s1", embedded: true, visible: true } });
  await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBe(entries.length));
}

beforeEach(() => {
  api.localList.mockReset();
  api.localHome.mockReset();
});

describe("the file listing as a table (wide layout)", () => {
  /** The width a cell asks for: `w-[…]` on a header cell, `@wide:w-[…]` on a row cell. */
  const width = (el: Element) =>
    el.className.match(/(?:^|\s)(?:@wide:)?(w-\[[^\]]+\]|w-16)(?=\s|$)/)?.[1] ?? null;
  const pad = (el: Element) => el.className.match(/(?:^|\s)(?:@wide:)?(p[xr]-2)(?=\s|$)/)?.[1] ?? null;

  it("titles the columns, in a header that only exists when wide", async () => {
    await renderPanel([entry("deploy.sh")]);
    const header = screen.getByTestId("localfiles-columns");
    expect(header.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(header.className).toContain("@wide:flex");
    expect(header).toHaveClass("sticky", "top-0");
    expect([...header.firstElementChild!.children].map((c) => c.textContent?.trim())).toEqual([
      "Name",
      "Size",
      "Permissions",
      "Owner",
      "Modified",
    ]);
    // The listing lays itself out by its own width: it is the query container.
    expect(screen.getByTestId("localfiles-list").className).toContain("@container");
  });

  it("the name and the owner can be resized, the fixed columns cannot", async () => {
    await renderPanel([entry("deploy.sh")]);
    for (const col of ["files.name", "files.owner"]) {
      expect(screen.getByTestId(`column-grip-${col}`)).toHaveClass("cursor-col-resize");
    }
    expect(screen.getByTestId("localfiles-columns").querySelectorAll('[data-testid^="column-grip-"]')).toHaveLength(2);
  });

  it("sizes the header and the rows from the same widths, cell for cell", async () => {
    await renderPanel([entry("deploy.sh")]);
    const header = screen.getByTestId("localfiles-columns");
    const row = screen.getByRole("treeitem");
    const headCells = [...header.firstElementChild!.children];
    const rowCells = [...row.firstElementChild!.children];
    expect(headCells.map(width)).toEqual([
      "w-[var(--c-name)]",
      "w-[5.5rem]",
      "w-[6.5rem]",
      "w-[var(--c-owner)]",
      "w-[9rem]",
    ]);
    expect(rowCells.map(width)).toEqual(headCells.map(width));
    expect(rowCells.map(pad)).toEqual(headCells.map(pad));
    // The box of hover actions is the same width in every row, and the header
    // keeps the same room: otherwise rows with fewer buttons shrink differently.
    expect(width(header.lastElementChild!)).toBe("w-16");
    expect(width(row.lastElementChild!)).toBe("w-16");
    // A rule on the right of every cell but the last, the full height of the row.
    for (const cell of rowCells.slice(0, -1)) expect(cell.className).toContain("@wide:border-r");
    expect(row.className).toContain("@wide:items-stretch");
  });

  it("feeds the widths to the listing as CSS variables", async () => {
    const { resetColumnWidths, setColumnWidth } = await import("./stores/colwidths.svelte");
    const { flushSync } = await import("svelte");
    resetColumnWidths();
    await renderPanel([entry("deploy.sh")]);
    const list = screen.getByTestId("localfiles-list");
    expect(list.style.getPropertyValue("--c-name")).toBe("320px");
    expect(list.style.getPropertyValue("--c-owner")).toBe("150px");
    setColumnWidth("files.name", 410);
    flushSync();
    expect(list.style.getPropertyValue("--c-name")).toBe("410px");
    resetColumnWidths();
  });

  it("a row shows what `ls -l` shows: size, permissions, owner, when it changed", async () => {
    await renderPanel([entry("deploy.sh", { mode: 0o755 })]);
    expect(screen.getByTestId("localfiles-col-size")).toHaveTextContent("2.0 KB");
    expect(screen.getByTestId("localfiles-col-mode")).toHaveTextContent("-rwxr-xr-x");
    expect(screen.getByTestId("localfiles-col-owner")).toHaveTextContent("ops:staff");
    expect(screen.getByTestId("localfiles-col-modified")).toHaveTextContent("2026-10-07 14:03");
  });

  it("the extra columns exist only when wide; a narrow dock keeps name and size", async () => {
    await renderPanel([entry("deploy.sh")]);
    for (const col of ["mode", "owner", "modified"]) {
      const cell = screen.getByTestId(`localfiles-col-${col}`);
      expect(cell.className).toMatch(/(^|\s)hidden(\s|$)/);
      expect(cell.className).toContain("@wide:block");
    }
    const size = screen.getByTestId("localfiles-col-size");
    expect(size.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(size.className).toContain("ml-auto");
  });

  it("a folder has no size: nothing in a narrow dock, an empty cell in the table", async () => {
    await renderPanel([entry("projects", { isDir: true, mode: 0o755, size: 4096 })]);
    const size = screen.getByTestId("localfiles-col-size");
    expect(size).toHaveTextContent("");
    expect(size.className).toMatch(/(^|\s)hidden(\s|$)/);
    // …but the cell keeps its place in the table, so the columns after it line up.
    expect(size.className).toContain("@wide:block");
    expect(screen.getByTestId("localfiles-col-mode")).toHaveTextContent("drwxr-xr-x");
  });

  it("what the listing did not report is a dash, not a made-up value", async () => {
    await renderPanel([entry("no-meta.bin", { modified: null })]);
    expect(screen.getByTestId("localfiles-col-modified")).toHaveTextContent("—");
  });
});
