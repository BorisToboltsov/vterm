import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import GitGraph from "./GitGraph.svelte";
import { buildGraph } from "./gitlanes";
import { NO_FILTER, scopeFilter, type GitCommit } from "./git";
import { settings } from "../settings/settings.svelte";

const commit: GitCommit = {
  hash: "abc123", short: "abc123", parents: [], author: "Ann", committer: "Ann",
  timestamp: 1700000000, refs: [], subject: "Add context menus", body: "", head: true,
};
function setup() {
  const onfilter = vi.fn();
  const refresh = vi.fn();
  const props = {
    rows: buildGraph([commit]), filter: NO_FILTER, onfilter,
    run: vi.fn(async () => true), runQuery: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    openDiff: vi.fn(), panelItems: () => [{ label: "Refresh", onSelect: refresh }],
  };
  return { ...render(GitGraph, props), props, onfilter, refresh };
}
afterEach(() => { settings.gitShowTags = true; settings.gitHighlightCurrent = true; });

describe("Git history context controls", () => {
  it("preserves commit actions and changes the same view setting as the toolbar", async () => {
    setup();
    await fireEvent.contextMenu(screen.getByTestId("git-row"));
    expect(screen.getByRole("menuitem", { name: "Copy SHA" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Show tags in rows" }));
    expect(settings.gitShowTags).toBe(false);
  });
  it("selects an author and resets a filtered-empty history from background", async () => {
    const { onfilter, props, rerender, refresh } = setup();
    await fireEvent.contextMenu(screen.getByTestId("git-graph-column"));
    expect(screen.queryByRole("menuitem", { name: "Copy SHA" })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Author" }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Ann" }));
    expect(onfilter).toHaveBeenLastCalledWith({ ...NO_FILTER, author: "Ann" });
    await rerender({ ...props, rows: [], filter: { ...NO_FILTER, author: "Ann" } });
    await fireEvent.contextMenu(screen.getByTestId("git-graph-column"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Reset filters" }));
    expect(onfilter).toHaveBeenLastCalledWith(scopeFilter(settings.gitLogScope));
    await fireEvent.contextMenu(screen.getByTestId("git-graph-column"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
