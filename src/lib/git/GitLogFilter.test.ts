import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import GitLogFilter from "./GitLogFilter.svelte";
import { NO_FILTER, type GitBranch, type LogFilter } from "./git";
import { settings } from "../settings/settings.svelte";

const branch = (name: string, extra: Partial<GitBranch> = {}): GitBranch => ({
  name,
  fullRef: `refs/heads/${name}`,
  current: false,
  short: "abc",
  upstream: null,
  subject: "",
  remote: false,
  track: null,
  date: 0,
  worktree: null,
  ...extra,
});

function setup(props: { filter?: LogFilter; full?: boolean; authors?: string[]; branches?: GitBranch[] } = {}) {
  const onfilter = vi.fn();
  render(GitLogFilter, { props: { filter: NO_FILTER, full: true, onfilter, ...props } });
  return onfilter;
}

afterEach(() => {
  settings.gitShowTags = true;
  settings.gitHighlightCurrent = true;
});

describe("GitLogFilter", () => {
  it("offers each filter as its own button with room, behind one without", () => {
    setup({ full: true });
    expect(screen.getByTestId("git-filter-branch")).toBeInTheDocument();
    expect(screen.queryByTestId("git-filter-menu")).toBeNull();
  });
  it("narrow: one button holds them all, and shows when one is set", async () => {
    setup({ full: false, filter: { ...NO_FILTER, author: "Ann" } });
    expect(screen.queryByTestId("git-filter-branch")).toBeNull();
    const menu = screen.getByTestId("git-filter-menu");
    expect(menu.className).toContain("text-accent");
    await fireEvent.click(menu);
    expect(screen.getByText("Regular expression")).toBeInTheDocument();
    expect(screen.getByText("Reset filters")).toBeInTheDocument();
  });

  it("offers the current branch, the favourites and the most recent, newest first", async () => {
    const onfilter = setup({
      branches: [
        branch("old", { date: 1 }),
        branch("new", { date: 9 }),
        branch("main"),
        branch("here", { current: true }),
        branch("origin/x", { remote: true, fullRef: "refs/remotes/origin/x" }),
      ],
    });
    await fireEvent.click(screen.getByTestId("git-filter-branch"));
    const labels = screen.getAllByRole("menuitemcheckbox").map((b) => b.textContent?.trim());
    expect(labels).toEqual(["All branches", "main", "here", "new", "old"]);
    await fireEvent.click(screen.getByText("new"));
    expect(onfilter).toHaveBeenCalledWith({ ...NO_FILTER, branch: "refs/heads/new" });
  });

  it("keeps a branch filter it would not otherwise list", async () => {
    setup({ filter: { ...NO_FILTER, branch: "refs/tags/v1" } });
    expect(screen.getByTestId("git-filter-branch").textContent).toContain("v1");
    await fireEvent.click(screen.getByTestId("git-filter-branch"));
    expect(screen.getAllByRole("menuitemcheckbox").map((b) => b.textContent?.trim())).toContain("v1");
  });

  it("filters by an author, a period and a path", async () => {
    const onfilter = setup({ authors: ["Ann", "Bob"] });
    await fireEvent.click(screen.getByTestId("git-filter-author"));
    await fireEvent.click(screen.getByText("Bob"));
    expect(onfilter).toHaveBeenLastCalledWith({ ...NO_FILTER, author: "Bob" });

    await fireEvent.click(screen.getByTestId("git-filter-date"));
    await fireEvent.click(screen.getByText("Last 7 days"));
    expect(onfilter).toHaveBeenLastCalledWith({ ...NO_FILTER, since: "week" });

    await fireEvent.click(screen.getByTestId("git-filter-path"));
    await fireEvent.click(screen.getByText("Path…"));
    const input = await screen.findByPlaceholderText("src/lib/file.ts");
    await fireEvent.input(input, { target: { value: " a/b.ts " } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onfilter).toHaveBeenLastCalledWith({ ...NO_FILTER, path: "a/b.ts", follow: false });
  });

  it("says what a filter is set to, and resets them together", async () => {
    const filter: LogFilter = { ...NO_FILTER, branch: "refs/heads/x", author: "Ann", since: "month", path: "p.ts" };
    const onfilter = setup({ filter });
    expect(screen.getByTestId("git-filter-branch").textContent).toContain("x");
    expect(screen.getByTestId("git-filter-author").textContent).toContain("Ann");
    expect(screen.getByTestId("git-filter-date").textContent).toContain("Last 30 days");
    expect(screen.getByTestId("git-filter-path").textContent).toContain("p.ts");
    await fireEvent.click(screen.getByTestId("git-filter-reset"));
    expect(onfilter).toHaveBeenCalledWith(NO_FILTER);
  });

  it("switches how the text is read", async () => {
    const onfilter = setup();
    await fireEvent.click(screen.getByRole("button", { name: "Regular expression" }));
    expect(onfilter).toHaveBeenLastCalledWith({ ...NO_FILTER, regex: true });
    await fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    expect(onfilter).toHaveBeenLastCalledWith({ ...NO_FILTER, matchCase: true });
  });

  it("clears the text by the button and by Escape", async () => {
    const onfilter = setup({ filter: { ...NO_FILTER, text: "x" } });
    expect(screen.getByTestId("git-search")).toHaveValue("x");
    await fireEvent.keyDown(screen.getByTestId("git-search"), { key: "Escape" });
    expect(onfilter).toHaveBeenLastCalledWith({ ...NO_FILTER, text: "" });
  });

  it("the view menu switches tags and the current branch's highlight", async () => {
    setup();
    await fireEvent.click(screen.getByTestId("git-view-menu"));
    await fireEvent.click(screen.getByText("Show tags in rows"));
    expect(settings.gitShowTags).toBe(false);
    await fireEvent.click(screen.getByTestId("git-view-menu"));
    await fireEvent.click(screen.getByText("Highlight the current branch"));
    expect(settings.gitHighlightCurrent).toBe(false);
  });
});
