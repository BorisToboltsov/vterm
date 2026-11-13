import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FileBrowser from "./FileBrowser.svelte";
import type { FileBrowserAdapter } from "./filebrowser";
import type { FileEntry } from "../types";
import { settings } from "../settings/settings.svelte";
import { resetListOrders } from "../stores/listview.svelte";
import { resetDockState } from "../stores/dockstate.svelte";

const entry = (name: string, isDir = false, dir = "/app"): FileEntry => ({
  name, path: `${dir}/${name}`, size: 1, isDir, isSymlink: false,
  modified: null, mode: 0o644, uid: null, gid: null, user: null, group: null,
});

async function setup(files: FileEntry[], home = "/app", withPipelines = true) {
  const onPipelines = vi.fn();
  const adapter: FileBrowserAdapter = {
    list: vi.fn(async () => files), home: async () => home, mkdir: vi.fn(), createFile: vi.fn(), remove: vi.fn(), rename: vi.fn(), copy: vi.fn(),
    hasParent: () => false, parentForUp: () => null, mutable: () => true, mirrorsToTerminal: () => true, local: true,
  };
  render(FileBrowser, { props: {
    adapter, embedded: true, testPrefix: "files", stripLabel: "Files", expandLabel: "Expand", collapseLabel: "Collapse",
    onOpenFile: vi.fn(), onPipelines: withPipelines ? onPipelines : undefined,
  } });
  await screen.findByText(files[0].name);
  return { onPipelines };
}
const menu = () => within(screen.getByRole("menu"));
async function row(name: string, extra: { metaKey?: boolean } = {}) {
  const el = screen.getByText(name).closest('[role="treeitem"]')!;
  if (extra.metaKey) await fireEvent.click(el, { metaKey: true });
  await fireEvent.contextMenu(el);
}

beforeEach(() => {
  settings.language = "en";
  settings.sftp.showHiddenFiles = true;
  resetListOrders();
  resetDockState();
});

describe("pipelines in the file panel (ADR 0068)", () => {
  it("offers a pipeline file's schema", async () => {
    const { onPipelines } = await setup([entry(".gitlab-ci.yml"), entry("README.md")]);
    await row(".gitlab-ci.yml");
    await fireEvent.click(menu().getByRole("menuitem", { name: "Pipeline schema" }));
    expect(onPipelines).toHaveBeenCalledWith([{ path: "/app/.gitlab-ci.yml", isDir: false }]);
  });

  it("does not offer it on a file that is no pipeline", async () => {
    await setup([entry(".gitlab-ci.yml"), entry("README.md")]);
    await row("README.md");
    expect(menu().queryByRole("menuitem", { name: /schema/ })).toBeNull();
  });

  it("offers the map of a workflows folder and of several workflow files", async () => {
    const dir = "/app/.github";
    const { onPipelines } = await setup([entry("workflows", true, dir), entry("CODEOWNERS", false, dir)], dir);
    await row("workflows");
    await fireEvent.click(menu().getByRole("menuitem", { name: "Pipelines schema" }));
    expect(onPipelines).toHaveBeenCalledWith([{ path: "/app/.github/workflows", isDir: true }]);
  });

  it("offers the map of the folder shown when it holds pipelines", async () => {
    const { onPipelines } = await setup([entry(".github", true), entry("src", true)]);
    await fireEvent.contextMenu(screen.getByTestId("files-list"));
    await fireEvent.click(menu().getByRole("menuitem", { name: "Pipelines schema" }));
    expect(onPipelines).toHaveBeenCalledWith([{ path: "/app", isDir: true }]);
  });

  it("offers nothing where the panel has no way to show pipelines", async () => {
    await setup([entry(".gitlab-ci.yml"), entry(".github", true)], "/app", false);
    await row(".gitlab-ci.yml");
    expect(menu().queryByRole("menuitem", { name: /schema/ })).toBeNull();
    await fireEvent.keyDown(window, { key: "Escape" });
    await fireEvent.contextMenu(screen.getByTestId("files-list"));
    expect(menu().queryByRole("menuitem", { name: /schema/ })).toBeNull();
  });
});
