import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FileBrowser from "./FileBrowser.svelte";
import type { FileBrowserAdapter } from "./filebrowser";
import type { FileEntry } from "../types";
import { settings } from "../settings/settings.svelte";
import { resetListOrders } from "../stores/listview.svelte";
import { resetDockState } from "../stores/dockstate.svelte";

const entry = (name: string, size: number): FileEntry => ({
  name, path: `/app/${name}`, size, isDir: false, isSymlink: false,
  modified: null, mode: 0o644, uid: null, gid: null, user: null, group: null,
});
const files = [entry("a.txt", 100), entry("b.txt", 10), entry(".hidden", 1)];

async function setup(options: { local?: boolean; mutable?: boolean } = {}) {
  const list = vi.fn(async () => files);
  const follow = vi.fn();
  const sync = vi.fn();
  const open = vi.fn();
  const adapter: FileBrowserAdapter = {
    list, home: async () => "/app", mkdir: vi.fn(), createFile: vi.fn(), remove: vi.fn(), rename: vi.fn(), copy: vi.fn(),
    hasParent: () => false, parentForUp: () => null, mutable: () => options.mutable !== false, mirrorsToTerminal: () => true,
    local: options.local,
    ...(options.local ? {} : { upload: vi.fn(), download: vi.fn(), search: vi.fn() }),
  };
  const result = render(FileBrowser, { props: {
    adapter, embedded: true, testPrefix: "files", stripLabel: "Files", expandLabel: "Expand", collapseLabel: "Collapse",
    onToggleFollowTerminal: options.local ? undefined : follow, followTerminal: true,
    onSync: options.local ? undefined : sync, onOpenFile: open,
  } });
  await screen.findByText("a.txt");
  return { ...result, list, follow, sync, open };
}
async function background() { await fireEvent.contextMenu(screen.getByTestId("files-list")); }
async function row(name = "a.txt") { await fireEvent.contextMenu(screen.getByText(name).closest('[role="treeitem"]')!); }
async function group(name: string) { await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name })); }
async function choose(name: string, checkbox = false) {
  await fireEvent.click(within(screen.getByRole("menu")).getByRole(checkbox ? "menuitemcheckbox" : "menuitem", { name }));
}

beforeEach(() => {
  settings.language = "en";
  settings.sftp.showHiddenFiles = false;
  resetListOrders();
  resetDockState();
});

describe("file context menus", () => {
  it("keeps object actions distinct and gives both surfaces the same collapsed panel groups", async () => {
    await setup();
    await row();
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "New folder" })).toBeNull();
    for (const name of ["View", "Search", "Folder"]) expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-expanded", "false");
    await fireEvent.keyDown(window, { key: "Escape" });
    await background();
    expect(screen.queryByRole("menuitem", { name: "Open" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
    for (const name of ["View", "Search", "Folder"]) expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-expanded", "false");
  });

  it("shares hidden-file state and sorting with the header without moving the selected file", async () => {
    const { open } = await setup();
    await row();
    await group("View");
    await choose("Hidden files", true);
    expect(await screen.findByText(".hidden")).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId("files-header-view"));
    expect(screen.getByRole("menuitemcheckbox", { name: "Hidden files" })).toHaveAttribute("aria-checked", "true");
    await fireEvent.keyDown(window, { key: "Escape" });
    await row();
    await group("View");
    await choose("Size", true);
    expect(screen.getAllByRole("treeitem").map(el => el.textContent)).toEqual([
      expect.stringContaining("a.txt"), expect.stringContaining("b.txt"), expect.stringContaining(".hidden"),
    ]);
    await row();
    await group("View");
    await choose("Ascending", true);
    expect(screen.getAllByRole("treeitem")[0]).toHaveTextContent(".hidden");
    await fireEvent.keyDown(screen.getByTestId("files-list"), { key: "Enter" });
    expect(open).toHaveBeenCalledWith("/app/a.txt", "a.txt");
  });

  it("focuses the existing name filter and opens the existing content search", async () => {
    await setup();
    await background(); await group("Search"); await choose("By name in this folder…");
    const input = screen.getByTestId("files-header-field");
    expect(input).toHaveFocus();
    await fireEvent.input(input, { target: { value: "b.txt" } });
    expect(screen.queryByText("a.txt")).toBeNull();
    await background(); await group("Search"); await choose("Search file contents (grep)");
    expect(screen.getByTestId("files-search-input")).toBeInTheDocument();
  });

  it("refreshes the same folder and uses the existing follow and sync callbacks", async () => {
    const { list, follow, sync } = await setup();
    list.mockClear();
    await background(); await group("Folder"); await choose("Refresh");
    await waitFor(() => expect(list).toHaveBeenCalledWith("/app"));
    await row(); await group("Folder");
    expect(screen.getByRole("menuitemcheckbox", { name: "Sync path with terminal" })).toHaveAttribute("aria-checked", "true");
    await choose("Sync path with terminal", true);
    expect(follow).toHaveBeenCalledOnce();
    await background(); await group("Folder"); await choose("Synchronize files…");
    expect(sync).toHaveBeenCalledOnce();
  });

  it("keeps multiselection when a panel setting changes", async () => {
    await setup();
    await fireEvent.click(screen.getByText("a.txt"));
    await fireEvent.click(screen.getByText("b.txt"), { ctrlKey: true });
    await row(); await group("View"); await choose("Hidden files", true);
    await row();
    expect(screen.getByRole("menuitem", { name: /Delete.*2/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
  });

  it("does not offer remote-only actions without their capabilities", async () => {
    await setup({ local: true });
    await background(); await group("Search");
    expect(screen.queryByRole("menuitem", { name: "Search file contents (grep)" })).toBeNull();
    await group("Folder");
    expect(screen.queryByRole("menuitemcheckbox", { name: "Sync path with terminal" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Synchronize files…" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toBeInTheDocument();
  });

  it("does not offer list settings or mutation at a synthetic drive level", async () => {
    await setup({ local: true, mutable: false });
    await background();
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    await group("Folder");
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toBeInTheDocument();
  });
});
