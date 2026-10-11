import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LocalFilePanel from "./LocalFilePanel.svelte";
import type { FileEntry } from "./types";
import { fileSort, resetFileSort, setFileSort } from "./stores/filesort.svelte";

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
  localStorage.clear();
  resetFileSort();
  flushSync();
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

// ── The order of the listing (v1.17) ─────────────────────────────────────────

describe("the order of the file listing", () => {
  const at = (y: number, mo: number, d: number) => Math.floor(new Date(y, mo, d, 12, 0).getTime() / 1000);
  const LISTING = [
    entry("conf.d", { isDir: true, mode: 0o755, modified: at(2026, 9, 9) }),
    entry("sites", { isDir: true, mode: 0o755, modified: at(2026, 8, 30) }),
    entry("mime.types", { size: 5300, modified: at(2026, 7, 2) }),
    entry("nginx.conf", { size: 2400, modified: at(2026, 9, 11) }),
    entry("upstreams.conf", { size: 812, modified: at(2026, 9, 2), user: "deploy", group: "www" }),
  ];
  /** The names the listing shows, top to bottom. */
  const shown = () =>
    screen.getAllByRole("treeitem").map((row) => row.querySelector(".truncate")?.textContent?.trim());
  const title = (key: string) => screen.getByTestId(`column-sort-files.${key}`);
  /** Tell the listing how wide it is (jsdom has no layout): a table, or a list. */
  function setListWidth(width: number) {
    const list = screen.getByTestId("localfiles-list");
    Object.defineProperty(list, "clientWidth", { configurable: true, value: width });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const o of observers) o.cb([{ target: list }]);
  }

  it("comes as it always did: folders first, then by name — and the title says so", async () => {
    await renderPanel(LISTING);
    expect(shown()).toEqual(["conf.d", "sites", "mime.types", "nginx.conf", "upstreams.conf"]);
    expect(title("name")).toHaveAttribute("data-sorted", "asc");
    expect(title("name")).toHaveAttribute("aria-pressed", "true");
    for (const key of ["size", "mode", "owner", "modified"]) {
      expect(title(key)).toHaveAttribute("aria-pressed", "false");
      expect(title(key)).not.toHaveAttribute("data-sorted");
    }
  });

  it("a click on a column title orders by it; another one turns the order round", async () => {
    await renderPanel(LISTING);
    await fireEvent.click(title("modified"));
    // The latest first — and each group by its own times, folders above.
    expect(shown()).toEqual(["conf.d", "sites", "nginx.conf", "upstreams.conf", "mime.types"]);
    expect(title("modified")).toHaveAttribute("data-sorted", "desc");
    expect(title("name")).not.toHaveAttribute("data-sorted");

    await fireEvent.click(title("modified"));
    expect(shown()).toEqual(["sites", "conf.d", "mime.types", "upstreams.conf", "nginx.conf"]);
    expect(title("modified")).toHaveAttribute("data-sorted", "asc");

    await fireEvent.click(title("size"));
    expect(shown().slice(2)).toEqual(["mime.types", "nginx.conf", "upstreams.conf"]);
    await fireEvent.click(title("owner"));
    expect(shown().slice(2)).toEqual(["upstreams.conf", "mime.types", "nginx.conf"]);
  });

  it("the order is the app's: it is kept, and a panel opened later comes in it", async () => {
    setFileSort({ key: "size", dir: "asc" });
    flushSync();
    expect(JSON.parse(localStorage.getItem("vterm.filesort") ?? "null")).toEqual({ key: "size", dir: "asc" });
    await renderPanel(LISTING);
    expect(shown().slice(2)).toEqual(["upstreams.conf", "nginx.conf", "mime.types"]);
  });

  it("a list has no titles to click: the toolbar offers the same order as a menu", async () => {
    await renderPanel(LISTING);
    // Narrow: the menu button is there, plain while the order is the usual one.
    const button = screen.getByTestId("localfiles-sort");
    expect(button.className).not.toContain("text-accent");
    await fireEvent.click(button);
    const menu = screen.getByRole("menu");
    const row = (label: string) => within(menu).getByText(label).closest("button")!;
    expect(row("Name")).toHaveAttribute("aria-checked", "true");
    expect(row("Ascending")).toHaveAttribute("aria-checked", "true");
    expect(row("Modified")).toHaveAttribute("aria-checked", "false");

    await fireEvent.click(row("Modified"));
    expect(fileSort.sort).toEqual({ key: "modified", dir: "desc" });
    await waitFor(() => expect(shown()).toEqual(["conf.d", "sites", "nginx.conf", "upstreams.conf", "mime.types"]));
    // A listing that is not by name says so on the button.
    expect(screen.getByTestId("localfiles-sort").className).toContain("text-accent");

    await fireEvent.click(screen.getByTestId("localfiles-sort"));
    await fireEvent.click(within(screen.getByRole("menu")).getByText("Ascending").closest("button")!);
    expect(fileSort.sort).toEqual({ key: "modified", dir: "asc" });
  });

  it("a table is ordered from its titles — the toolbar button steps aside", async () => {
    await renderPanel(LISTING);
    expect(screen.getByTestId("localfiles-sort")).toBeInTheDocument();
    setListWidth(900);
    await waitFor(() => expect(screen.queryByTestId("localfiles-sort")).toBeNull());
    setListWidth(400);
    await waitFor(() => expect(screen.getByTestId("localfiles-sort")).toBeInTheDocument());
  });

  it("the row under the keyboard cursor stays under it when the order changes", async () => {
    await renderPanel(LISTING);
    const list = screen.getByTestId("localfiles-list");
    /** The row the keyboard cursor frames. */
    const underCursor = () =>
      screen
        .getAllByRole("treeitem")
        .find((row) => row.className.includes("outline-accent/70"))
        ?.querySelector(".truncate")
        ?.textContent?.trim() ?? null;
    list.focus();
    // Walk down to "nginx.conf" in the listing by name.
    for (let i = 0; i < 8 && underCursor() !== "nginx.conf"; i++) {
      await fireEvent.keyDown(list, { key: "ArrowDown" });
    }
    expect(underCursor()).toBe("nginx.conf");
    // By time it is another row of the listing — and still the one framed.
    await fireEvent.click(title("modified"));
    expect(shown().indexOf("nginx.conf")).toBe(2);
    expect(underCursor()).toBe("nginx.conf");
    // From there the keys go on from its new place.
    await fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(underCursor()).toBe("upstreams.conf");
  });
});
