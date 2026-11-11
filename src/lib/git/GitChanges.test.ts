import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/clipboard", () => ({ writeClipboard: vi.fn(async () => {}) }));

import GitChanges from "./GitChanges.svelte";
import { resetListOrders, setListOrder } from "../stores/listview.svelte";
import { NO_GROUPS } from "../ui/listview";
import type { GitFile, GitStatus } from "./git";

const file = (path: string, index: string, work: string): GitFile => ({ path, index, work });
const STATUS: GitStatus = {
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  initial: false,
  files: [
    file("README.md", ".", "M"),
    file("src/app.ts", "M", "."),
    file("src/lib/util.ts", ".", "M"),
    file("src/main.ts", ".", "M"),
    file("docs/new.md", "?", "?"),
  ],
};

function setup(collapsed: string[] = []) {
  const ontoggle = vi.fn();
  const onfold = vi.fn();
  render(GitChanges, {
    props: {
      status: STATUS,
      busy: false,
      run: vi.fn(async () => true),
      onOpenInEditor: vi.fn(),
      onOpenReadonlyDiff: vi.fn(),
      onIgnore: vi.fn(),
      absPath: (p: string) => `/repo/${p}`,
      runQuery: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      collapsed,
      ontoggle,
      onfold,
    },
  });
  return { ontoggle, onfold };
}

/** The headers and rows of the list, top to bottom, as text. */
const drawn = () =>
  [...document.querySelectorAll("[data-testid='git-stage'], [data-testid='git-folder'], button.truncate.text-meta")].map((e) =>
    (e.textContent ?? "").replace(/\s+/g, " ").trim(),
  );

beforeEach(() => resetListOrders());
afterEach(() => resetListOrders());

describe("Git changes by folder", () => {
  it("shares grouping from a file menu and search focus from empty space", async () => {
    setup();
    await fireEvent.contextMenu(screen.getByText("src/lib/util.ts"));
    expect(screen.getByRole("menuitem", { name: "Stage" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /^Groups:/ }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Folder" }));
    expect(screen.getAllByTestId("git-folder").length).toBeGreaterThan(0);
    await fireEvent.contextMenu(screen.getByTestId("git-changes"));
    expect(screen.queryByRole("menuitem", { name: "Stage" })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Find in this list" }));
    expect(screen.getByTestId("git-changes-header-field")).toHaveFocus();
  });

  it("lie flat by default, each file by its path", () => {
    setup();
    expect(screen.queryAllByTestId("git-folder")).toHaveLength(0);
    expect(drawn()).toContain("src/lib/util.ts");
  });

  it("grouped by folder, each stage holds its folders — the root last — and a row its name only", () => {
    setListOrder("git.changes", { sort: { key: "", dir: "asc" }, group: "folder" });
    setup();
    expect(drawn()).toEqual([
      "Staged 1",
      "src 1",
      "app.ts",
      "Changes 4",
      "docs 1",
      "new.md",
      "src 1",
      "main.ts",
      "src/lib 1",
      "util.ts",
      "Repository root 1",
      "README.md",
    ]);
  });

  it("a folded folder hides its files, and only in its own stage", async () => {
    setListOrder("git.changes", { sort: { key: "", dir: "asc" }, group: "folder" });
    const { ontoggle } = setup(["changes/src"]);
    expect(drawn()).toContain("app.ts");
    expect(drawn()).not.toContain("main.ts");
    expect(drawn()).toContain("util.ts");
    const [stagedSrc] = screen.getAllByTestId("git-folder-toggle");
    await fireEvent.click(stagedSrc);
    expect(ontoggle).toHaveBeenCalledWith("staged/src");
  });

  it("folds every folder on screen from the «View» menu", async () => {
    setListOrder("git.changes", { sort: { key: "", dir: "asc" }, group: "folder" });
    const { onfold } = setup();
    await fireEvent.click(screen.getByTestId("git-changes-header-view"));
    await fireEvent.click(await screen.findByText("Collapse all"));
    expect(onfold).toHaveBeenCalledTimes(1);
    const [keys, fold] = onfold.mock.calls[0] as [string[], boolean];
    expect(fold).toBe(true);
    expect([...keys].sort()).toEqual(["changes/", "changes/docs", "changes/src", "changes/src/lib", "staged/src"]);
  });

  it("the flat choice is a choice too: back to paths", () => {
    setListOrder("git.changes", { sort: { key: "", dir: "asc" }, group: NO_GROUPS });
    setup();
    expect(screen.queryAllByTestId("git-folder")).toHaveLength(0);
  });
});
