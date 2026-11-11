import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/clipboard", () => ({ writeClipboard: vi.fn(async () => {}) }));

import GitBranches from "./GitBranches.svelte";
import { settings } from "../settings/settings.svelte";
import { DEFAULT_FAVORITE_BRANCHES } from "./gitrefs";
import type { GitBranch, GitTag } from "./git";

const branch = (name: string, extra: Partial<GitBranch> = {}): GitBranch => ({
  name,
  fullRef: extra.remote ? `refs/remotes/${name}` : `refs/heads/${name}`,
  current: false,
  short: `${name.length}abcdef`,
  upstream: null,
  subject: "",
  remote: false,
  track: null,
  date: 0,
  worktree: null,
  ...extra,
});

const BRANCHES = [
  branch("main", { upstream: "origin/main", track: { ahead: 0, behind: 2, gone: false } }),
  branch("docs/guide", { current: true, upstream: "origin/docs/guide" }),
  branch("docs/old", { track: { ahead: 0, behind: 0, gone: true }, upstream: "origin/docs/old" }),
  branch("feat/a", { upstream: "origin/feat/a", track: { ahead: 3, behind: 0, gone: false } }),
  branch("feat/wt", { worktree: "/elsewhere" }),
  branch("origin/main", { remote: true }),
];
const TAGS: GitTag[] = [{ name: "v1", short: "abc1234" }];

function setup(props: Record<string, unknown> = {}) {
  const run = vi.fn(async () => true);
  const runQuery = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  const openDiff = vi.fn();
  const onreveal = vi.fn();
  const onlyref = vi.fn();
  render(GitBranches, {
    props: { branches: BRANCHES, tags: TAGS, stashes: [], run, runQuery, openDiff, onreveal, onlyref, ...props },
  });
  return { run, runQuery, openDiff, onreveal, onlyref };
}
const row = (name: string) =>
  [...screen.getAllByTestId("git-tree-branch")].find((b) => b.dataset.branch === name)!;
const shownBranches = () => screen.getAllByTestId("git-tree-branch").map((b) => b.dataset.branch);

beforeEach(() => {
  settings.gitFavoriteBranches = [...DEFAULT_FAVORITE_BRANCHES];
});
afterEach(() => {
  settings.gitFavoriteBranches = [...DEFAULT_FAVORITE_BRANCHES];
});

describe("GitBranches tree", () => {
  it("uses row actions and background search separately, with the same fold controls", async () => {
    setup();
    await fireEvent.contextMenu(row("main"));
    expect(screen.getByRole("menuitem", { name: "Copy branch name" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Expand all" }));
    expect(shownBranches()).toContain("feat/a");
    const field = screen.getByTestId("git-tree-search");
    await fireEvent.input(field, { target: { value: "missing" } });
    await fireEvent.contextMenu(screen.getByTestId("git-branches"));
    expect(screen.queryByRole("menuitem", { name: "Copy branch name" })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Clear the filter" }));
    expect(shownBranches()).toContain("main");
  });

  it("opens on the favourites and the way to the current branch", () => {
    setup();
    expect(shownBranches()).toEqual(["main", "docs/guide", "docs/old"]);
    expect(within(row("main")).getByTestId("git-tree-star")).toBeInTheDocument();
    expect(row("docs/guide")).toHaveAttribute("aria-current", "true");
  });

  it("folds and unfolds a folder, and everything at once", async () => {
    setup();
    await fireEvent.click(screen.getByText("feat"));
    expect(shownBranches()).toContain("feat/a");
    await fireEvent.click(screen.getByText("feat"));
    expect(shownBranches()).not.toContain("feat/a");
    await fireEvent.click(screen.getByTestId("git-tree-expand"));
    expect(shownBranches()).toEqual(expect.arrayContaining(["feat/a", "origin/main"]));
    expect(screen.getAllByTestId("git-tree-tag")).toHaveLength(1);
    await fireEvent.click(screen.getByTestId("git-tree-collapse"));
    expect(screen.queryAllByTestId("git-tree-branch")).toHaveLength(0);
  });

  it("narrows by name, any case, with everything left open", async () => {
    setup();
    await fireEvent.input(screen.getByTestId("git-tree-search"), { target: { value: "FEAT/W" } });
    expect(shownBranches()).toEqual(["feat/wt"]);
    expect(screen.queryByTestId("git-tree-tag")).toBeNull();
    await fireEvent.keyDown(screen.getByTestId("git-tree-search"), { key: "Escape" });
    expect(shownBranches()).toEqual(["main", "docs/guide", "docs/old"]);
  });

  it("shows how a branch stands against its upstream, and where else it is out", async () => {
    setup();
    expect(within(row("main")).getByTestId("git-tree-track").textContent?.trim()).toBe("↓2");
    expect(within(row("docs/old")).getByTestId("git-tree-gone")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("feat"));
    expect(within(row("feat/a")).getByTestId("git-tree-track").textContent?.trim()).toBe("↑3");
    expect(within(row("feat/wt")).getByTestId("git-tree-worktree")).toBeInTheDocument();
    // The checked-out branch is out here: no label for that.
    expect(within(row("docs/guide")).queryByTestId("git-tree-worktree")).toBeNull();
  });
});

describe("GitBranches clicks", () => {
  it("wide: a click brings the commit up, a double click switches", async () => {
    const { onreveal, run } = setup({ wide: true });
    await fireEvent.click(row("main"));
    expect(onreveal).toHaveBeenCalledWith(BRANCHES[0].short, "refs/heads/main");
    expect(run).not.toHaveBeenCalled();
    await fireEvent.dblClick(row("main"));
    expect(run).toHaveBeenCalledWith(["checkout", "main"], expect.anything());
  });

  it("narrow: a click only selects; the history is behind a sub-tab, reached by the toolbar", async () => {
    const { onreveal } = setup({ wide: false });
    expect(screen.getByTestId("git-branch-reveal")).toBeDisabled();
    await fireEvent.click(row("main"));
    expect(onreveal).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId("git-branch-reveal"));
    expect(onreveal).toHaveBeenCalledWith(BRANCHES[0].short, "refs/heads/main");
  });

  it("a double click on the current branch does nothing", async () => {
    const { run } = setup();
    await fireEvent.dblClick(row("docs/guide"));
    expect(run).not.toHaveBeenCalled();
  });

  it("a click on a tag brings its commit up", async () => {
    const { onreveal } = setup({ wide: true });
    await fireEvent.click(screen.getByText("Tags"));
    await fireEvent.click(screen.getByText("v1"));
    expect(onreveal).toHaveBeenCalledWith("abc1234", "refs/tags/v1");
  });
});

describe("GitBranches toolbar", () => {
  it("stands beside the tree in a wide panel, above it in a narrow one", () => {
    setup({ wide: true });
    expect(screen.getByTestId("git-branch-tools").dataset.vertical).toBe("true");
    expect(screen.queryByTestId("git-branch-reveal")).toBeNull();
  });

  it("acts on the selected branch only", async () => {
    const { run, openDiff } = setup();
    expect(screen.getByTestId("git-branch-delete")).toBeDisabled();
    expect(screen.getByTestId("git-branch-compare")).toBeDisabled();
    expect(screen.getByTestId("git-branch-update")).toBeDisabled();
    expect(screen.getByTestId("git-branch-star")).toBeDisabled();

    await fireEvent.click(row("docs/old"));
    await fireEvent.click(screen.getByTestId("git-branch-delete"));
    expect(run).toHaveBeenCalledWith(["branch", "-d", "docs/old"], { destructive: true });
    await fireEvent.click(screen.getByTestId("git-branch-compare"));
    await waitFor(() => expect(openDiff).toHaveBeenCalledOnce());
  });

  it("never offers to delete the current branch or a remote one", async () => {
    setup();
    await fireEvent.click(row("docs/guide"));
    expect(screen.getByTestId("git-branch-delete")).toBeDisabled();
    await fireEvent.click(screen.getByTestId("git-tree-expand"));
    await fireEvent.click(row("origin/main"));
    expect(screen.getByTestId("git-branch-delete")).toBeDisabled();
  });

  it("updates another branch by fast-forward, the current one by pull, one with no upstream not at all", async () => {
    const { run } = setup();
    await fireEvent.click(row("main"));
    await fireEvent.click(screen.getByTestId("git-branch-update"));
    expect(run).toHaveBeenLastCalledWith(["fetch", "origin", "main:main"], expect.anything());
    await fireEvent.click(row("docs/guide"));
    await fireEvent.click(screen.getByTestId("git-branch-update"));
    expect(run).toHaveBeenLastCalledWith(["pull", "--ff-only"], expect.anything());
    await fireEvent.click(screen.getByText("feat"));
    await fireEvent.click(row("feat/wt"));
    expect(screen.getByTestId("git-branch-update")).toBeDisabled();
  });

  it("stars a branch into the favourites, and takes it back out", async () => {
    setup();
    await fireEvent.click(row("docs/old"));
    await fireEvent.click(screen.getByTestId("git-branch-star"));
    expect(settings.gitFavoriteBranches).toContain("docs/old");
    expect(within(row("docs/old")).getByTestId("git-tree-star")).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId("git-branch-star"));
    expect(settings.gitFavoriteBranches).not.toContain("docs/old");
  });

  it("creates a branch from the toolbar", async () => {
    const { run } = setup();
    await fireEvent.click(screen.getByTestId("git-branch-new"));
    const input = screen.getByPlaceholderText(/name/i);
    await fireEvent.input(input, { target: { value: "feat/new" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledWith(["checkout", "-b", "feat/new"], expect.objectContaining({ successKey: "git.branchCreated" }));
  });
});

describe("GitBranches menu", () => {
  it("offers the history of a branch and of a tag", async () => {
    const { onreveal, onlyref } = setup();
    await fireEvent.contextMenu(row("docs/old"));
    await fireEvent.click(screen.getByText("Show in history"));
    expect(onreveal).toHaveBeenCalledWith(expect.any(String), "refs/heads/docs/old");
    await fireEvent.contextMenu(row("docs/old"));
    await fireEvent.click(screen.getByText("Show only its history"));
    expect(onlyref).toHaveBeenCalledWith("refs/heads/docs/old");

    await fireEvent.click(screen.getByText("Tags"));
    await fireEvent.contextMenu(screen.getByText("v1").closest("button")!);
    await fireEvent.click(screen.getByText("Show only its history"));
    expect(onlyref).toHaveBeenCalledWith("refs/tags/v1");
  });

  it("renames in place from the menu", async () => {
    const { run } = setup();
    await fireEvent.contextMenu(row("docs/old"));
    await fireEvent.click(screen.getByText("Rename branch"));
    const input = screen.getByDisplayValue("docs/old");
    await fireEvent.input(input, { target: { value: "docs/older" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledWith(["branch", "-m", "docs/old", "docs/older"]);
  });
});
