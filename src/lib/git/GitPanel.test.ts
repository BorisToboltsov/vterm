import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitRun = vi.fn();
vi.mock("../api", () => ({
  gitRun: (...a: unknown[]) => gitRun(...a),
  writeToTerminal: vi.fn(),
}));

import GitPanel from "./GitPanel.svelte";
import { removeDockState, setDockCwd } from "../stores/dockstate.svelte";
import { panelSplits, resetPanelShares } from "../stores/panelsplit.svelte";

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

/** argv of every `git_run` call whose first token is `cmd`. */
const calls = (cmd: string) =>
  gitRun.mock.calls.map((c) => c[2] as string[]).filter((a) => a[0] === cmd);

async function mount(prod = false) {
  render(GitPanel, { props: { sessionId: "s1", terminalCwd: "/repo", prod } });
  await screen.findByRole("button", { name: "Pull" });
}

beforeEach(() => {
  removeDockState("s1");
  gitRun.mockReset().mockImplementation(async (_s: string, _c: string, args: string[]) =>
    args[0] === "rev-parse" ? ok("/repo\n") : ok(),
  );
});

describe("GitPanel confirmations", () => {
  it("asks before a pull on an ordinary (non-prod) server and runs it only on confirm", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(await screen.findByText("Confirm git action")).toBeInTheDocument();
    expect(screen.getByText("git pull", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("This server is marked as production.")).toBeNull();
    expect(calls("pull")).toHaveLength(0);

    await fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(calls("pull")).toHaveLength(1));
  });

  it("does nothing when the confirm is cancelled", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await screen.findByText("Confirm git action");
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Confirm git action")).toBeNull());
    expect(calls("push")).toHaveLength(0);
  });

  it("runs fetch straight away — nothing local changes", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(calls("fetch")).toHaveLength(1));
    expect(screen.queryByText("Confirm git action")).toBeNull();
  });

  it("adds the production warning on a prod tab", async () => {
    await mount(true);
    await fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(await screen.findByText("This server is marked as production.")).toBeInTheDocument();
  });
});

describe("GitPanel directory (v1.0.35)", () => {
  it("follows the terminal while following is off, not the file panel", async () => {
    setDockCwd("s1", "/home/u"); // the file panel opened home on connect
    const view = render(GitPanel, { props: { sessionId: "s1", terminalCwd: "/repo" } });
    await screen.findByRole("button", { name: "Pull" });
    expect(gitRun.mock.calls.every((c) => c[1] === "/repo")).toBe(true);

    // A `cd` in the terminal moves git; a move in the file panel does not.
    gitRun.mockClear();
    setDockCwd("s1", "/elsewhere");
    await view.rerender({ sessionId: "s1", terminalCwd: "/other" });
    await waitFor(() => expect(gitRun.mock.calls.some((c) => c[1] === "/other")).toBe(true));
    expect(gitRun.mock.calls.some((c) => c[1] === "/elsewhere")).toBe(false);
  });

  it("runs in the dock's shared directory while following", async () => {
    setDockCwd("s1", "/repo");
    render(GitPanel, {
      props: { sessionId: "s1", terminalCwd: "/term", followTerminal: true },
    });
    await screen.findByRole("button", { name: "Pull" });
    expect(gitRun.mock.calls.every((c) => c[1] === "/repo")).toBe(true);

    gitRun.mockClear();
    setDockCwd("s1", "/other");
    await waitFor(() => expect(gitRun.mock.calls.some((c) => c[1] === "/other")).toBe(true));
  });

  it("shows no path, not the panel's folder, while the terminal cwd is unknown", () => {
    setDockCwd("s1", "/home/u");
    render(GitPanel, { props: { sessionId: "s1" } });
    expect(screen.getByText("No path")).toBeTruthy();
    expect(gitRun).not.toHaveBeenCalled();
  });

  it("offers path sync only while following is off and the shell needs it", async () => {
    const onEnablePathSync = vi.fn();
    const view = render(GitPanel, { props: { sessionId: "s1", onEnablePathSync } });
    await fireEvent.click(screen.getByRole("button", { name: "Enable path sync" }));
    expect(onEnablePathSync).toHaveBeenCalledOnce();
    // Following on: the toolbar toggle owns it; no second button with another meaning.
    await view.rerender({ sessionId: "s1", followTerminal: true, onEnablePathSync });
    expect(screen.queryByRole("button", { name: "Enable path sync" })).toBeNull();
    // No setup needed (a local tab, or the shell already reports): nothing to offer.
    await view.rerender({ sessionId: "s1", followTerminal: false, onEnablePathSync: undefined });
    expect(screen.queryByRole("button", { name: "Enable path sync" })).toBeNull();
  });

  it("marks the follow toggle pressed like the file panel does", async () => {
    setDockCwd("s1", "/repo");
    render(GitPanel, {
      props: { sessionId: "s1", followTerminal: true, onToggleFollowTerminal: vi.fn() },
    });
    await screen.findByRole("button", { name: "Pull" });
    expect(screen.getByTestId("git-follow-terminal").getAttribute("aria-pressed")).toBe("true");
  });
});

// ── The wide layout (v1.7) ───────────────────────────────────────────────────

describe("GitPanel in a wide container", () => {
  /** Give the panel a width and let its observer see it (jsdom has no layout). */
  async function resize(width: number) {
    const root = document.querySelector<HTMLElement>("[data-wide]")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    // Whichever observer watches the panel: the others see no change.
    for (const o of observers) o.cb([]);
    await waitFor(() => expect(root.dataset.wide).toBe(String(width >= 768)));
  }
  const subTabs = () =>
    [...document.querySelectorAll("[data-testid^='git-subtab-']")].map((e) =>
      (e as HTMLElement).dataset.testid?.replace("git-subtab-", ""),
    );
  const columns = () =>
    [...document.querySelectorAll("[data-testid^='git-column-']")].map((e) =>
      (e as HTMLElement).dataset.testid?.replace("git-column-", ""),
    );

  it("a narrow dock shows one view at a time, behind three sub-tabs", async () => {
    await mount();
    expect(subTabs()).toEqual(["graph", "changes", "branches"]);
    expect(columns()).toEqual(["changes"]);
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    expect(columns()).toEqual(["graph"]);
  });

  it("wide: the history stands beside the branches and is no longer a tab", async () => {
    await mount();
    await resize(1200);
    expect(subTabs()).toEqual(["branches", "changes"]);
    expect(columns()).toEqual(["branches", "graph"]);
    // The sub-tabs join the toolbar row.
    expect(screen.getByTestId("git-subtabs-wide")).toContainElement(screen.getByTestId("git-subtab-branches"));
    expect(screen.getByTestId("git-subtab-branches")).toHaveAttribute("aria-current", "true");
  });

  it("wide: the border between the two columns is dragged; narrow has none", async () => {
    resetPanelShares();
    await mount();
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(screen.getByTestId("git-column-changes").style.width).toBe("");
    await resize(1200);
    const left = screen.getByTestId("git-column-branches");
    const divider = screen.getByTestId("panel-divider");
    expect(divider).toHaveAttribute("data-split", "git");
    expect(divider.previousElementSibling).toBe(left);
    expect(divider.nextElementSibling).toBe(screen.getByTestId("git-column-graph"));
    // The history starts as by far the wider one.
    expect(left.style.width).toBe("22%");

    const row = left.parentElement!;
    Object.defineProperty(row, "clientWidth", { configurable: true, value: 1000 });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const o of observers) o.cb([{ target: row }]);
    // A row of 1000 px keeps a minimal part: the default is drawn at its limit.
    await waitFor(() => expect(left.style.width).toBe("24%"));
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = vi.fn();
    await fireEvent.pointerDown(divider, { pointerId: 1, clientX: 400, clientY: 10 });
    await fireEvent.pointerMove(divider, { pointerId: 1, clientX: 550, clientY: 10 });
    await fireEvent.pointerUp(divider, { pointerId: 1, clientX: 550, clientY: 10 });
    expect(panelSplits.shares.git).toBeCloseTo(0.39);
    expect(left.style.width).toBe("39%");
    // The changes take the same column, at the same width.
    await fireEvent.click(screen.getByTestId("git-subtab-changes"));
    expect(screen.getByTestId("git-column-changes").style.width).toBe("39%");
    // Narrow again: one view, the whole width, no border.
    await resize(400);
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(screen.getByTestId("git-column-changes").style.width).toBe("");
    resetPanelShares();
  });

  it("wide: the changes take the left column when asked for, the history stays", async () => {
    await mount();
    await resize(1200);
    await fireEvent.click(screen.getByTestId("git-subtab-changes"));
    expect(columns()).toEqual(["changes", "graph"]);
    expect(screen.getByTestId("git-subtab-changes")).toHaveAttribute("aria-current", "true");
  });

  it("a panel left on the history shows the branches beside it when wide — and the history again when narrow", async () => {
    await mount();
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    await resize(1200);
    expect(columns()).toEqual(["branches", "graph"]);
    expect(screen.getByTestId("git-subtab-branches")).toHaveAttribute("aria-current", "true");
    await resize(400);
    expect(subTabs()).toEqual(["graph", "changes", "branches"]);
    expect(columns()).toEqual(["graph"]);
    expect(screen.getByTestId("git-subtab-graph")).toHaveAttribute("aria-current", "true");
  });

  it("a panel nobody chose for opens on the changes when narrow, the branches when wide", async () => {
    await mount();
    expect(columns()).toEqual(["changes"]);
    await resize(1200);
    expect(columns()).toEqual(["branches", "graph"]);
    await resize(400);
    expect(columns()).toEqual(["changes"]);
  });

  it("widening the panel does not ask git for anything again", async () => {
    await mount();
    await waitFor(() => expect(calls("log")).toHaveLength(1));
    await resize(1200);
    await resize(400);
    await resize(1200);
    expect(calls("log")).toHaveLength(1);
    expect(calls("status")).toHaveLength(1);
  });
});

// ── The details of a commit (v1.15) ──────────────────────────────────────────

describe("GitPanel commit details", () => {
  const US = "\x1f";
  const RS = "\x1e";
  const AT = 1_700_000_000;
  interface Row {
    hash: string;
    parents?: string[];
    refs?: string;
    subject: string;
    body?: string;
  }
  const MERGE: Row = { hash: "c".repeat(40), parents: ["b".repeat(40), "f".repeat(40)], refs: "HEAD -> main", subject: "Merge branch 'feat'" };
  const FEAT: Row = { hash: "f".repeat(40), parents: ["a".repeat(40)], subject: "Docs: umask before the build", body: "Why the\nstatic files answered 403." };
  const MAIN: Row = { hash: "b".repeat(40), parents: ["a".repeat(40)], subject: "On main" };
  const ROOT: Row = { hash: "a".repeat(40), subject: "First" };
  const logLine = (c: Row) =>
    [c.hash, c.hash.slice(0, 7), (c.parents ?? []).join(" "), "Anna Author", String(AT), "Anna Author", c.refs ?? "", c.subject, c.body ?? ""].join(US);
  const LOG = [MERGE, FEAT, MAIN, ROOT].map(logLine).join("\0");

  const header = (committer = "Anna Author", email = "anna@example.com", at = AT) =>
    `${RS}${["Anna Author", "anna@example.com", String(AT), committer, email, String(at)].join(US)}${RS}`;
  const FILES =
    ":100644 100644 1 2 M\0AGENTS.md\0:000000 100644 0 3 A\0docs/operations/заметка.md\0:100644 100644 4 5 R100\0src/old.ts\0src/new.ts\0" +
    "2\t1\tAGENTS.md\x003\t0\tdocs/operations/заметка.md\x000\t0\t\0src/old.ts\0src/new.ts\0";

  /** What git answers; a test replaces single answers through `answers`. */
  let answers: Record<string, (args: string[]) => unknown>;
  beforeEach(() => {
    resetPanelShares();
    answers = {
      "rev-parse": () => ok("/repo\n"),
      log: () => ok(LOG),
      show: (args) =>
        args.includes("--numstat")
          ? ok(`${header()}\0\n${args[args.length - 1] === MERGE.hash ? "" : FILES}`)
          : ok("diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n"),
      diff: (args) =>
        args.includes("--numstat") ? ok(":100644 100644 1 2 M\0merged.ts\x001\t1\tmerged.ts\0") : ok("diff --git a/m b/m\n@@ -1 +1 @@\n-a\n+b\n"),
    };
    gitRun.mockReset().mockImplementation(async (_s: string, _c: string, args: string[]) =>
      (answers[args[0]] ?? (() => ok()))(args),
    );
  });

  /** Give an element a width and let the observers see it (jsdom has no layout). */
  function setWidth(el: HTMLElement, width: number) {
    Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const o of observers) o.cb([{ target: el }]);
  }
  /** The panel `panelWidth` px wide, its history row `rowWidth` px wide. */
  async function layout(panelWidth: number, rowWidth: number) {
    const root = document.querySelector<HTMLElement>("[data-wide]")!;
    setWidth(root, panelWidth);
    await waitFor(() => expect(root.dataset.wide).toBe(String(panelWidth >= 768)));
    setWidth(screen.getByTestId("git-graph-row"), rowWidth);
  }
  async function mountHistory() {
    await mount();
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    await screen.findByText(FEAT.subject);
  }
  /** The same, under fake timers, where nothing waits by polling. */
  async function mountHistoryFake() {
    render(GitPanel, { props: { sessionId: "s1", terminalCwd: "/repo" } });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    await vi.advanceTimersByTimeAsync(0);
  }
  const commitRow = (c: Row) => within(screen.getByTestId("git-graph")).getByText(c.subject).closest("button")!;
  const logSearches = () => calls("log").filter((a) => a.some((t) => t.startsWith("--grep=")));
  const detailCalls = () => calls("show").filter((a) => a.includes("--numstat"));
  const drawnTree = () =>
    [...screen.getByTestId("git-commit-detail").querySelectorAll("[data-testid='git-commit-dir'], [data-testid='git-commit-file']")].map(
      (e) => (e.textContent ?? "").replace(/\s+/g, " ").trim(),
    );

  it("a narrow dock opens the commit in a strip under the history", async () => {
    await mountHistory();
    expect(screen.queryByTestId("git-commit-detail")).toBeNull();
    await fireEvent.click(commitRow(FEAT));

    const strip = await screen.findByTestId("git-commit-strip");
    expect(screen.queryByTestId("git-commit-pane")).toBeNull();
    await waitFor(() => expect(within(strip).getAllByTestId("git-commit-file")).toHaveLength(3));
    // The message whole, the author with the address, the hash in full.
    expect(within(strip).getByText(FEAT.subject)).toBeInTheDocument();
    expect(within(strip).getByTestId("git-commit-body").textContent).toBe(FEAT.body);
    expect(within(strip).getByTestId("git-commit-author").textContent).toContain("Anna Author <anna@example.com>");
    expect(within(strip).getByText(FEAT.hash)).toBeInTheDocument();
    // Applied by its author as written: no committer line.
    expect(within(strip).queryByTestId("git-commit-committer")).toBeNull();
    // One call, NUL-terminated, for the header and the files together.
    expect(detailCalls()).toHaveLength(1);
    expect(detailCalls()[0]).toContain("-z");
    expect(calls("diff")).toHaveLength(0);
  });

  it("shows the files as a tree: folders first, a chain of single folders folded, non-ASCII names as they are", async () => {
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    await waitFor(() => expect(drawnTree()).toHaveLength(5));
    // A rename that changed no line shows no counts — not "+0 −0".
    expect(drawnTree()).toEqual(["docs/operations 1", "A заметка.md +3", "src 1", "R new.ts", "M AGENTS.md +2 −1"]);
    // Folding a folder hides what is under it and keeps its count.
    await fireEvent.click(within(screen.getByTestId("git-commit-detail")).getByText("src").closest("button")!);
    expect(drawnTree()).toEqual(["docs/operations 1", "A заметка.md +3", "src 1", "M AGENTS.md +2 −1"]);
  });

  it("clicking the selected commit again closes its details", async () => {
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    await screen.findByTestId("git-commit-strip");
    await fireEvent.click(commitRow(FEAT));
    await waitFor(() => expect(screen.queryByTestId("git-commit-detail")).toBeNull());
  });

  it("wide, and the row holds both: the details stand beside the history, with a border to drag", async () => {
    await mountHistory();
    await layout(1200, 700);

    // Nothing to pick first: the commit HEAD stands on is shown.
    const pane = await screen.findByTestId("git-commit-pane");
    expect(screen.queryByTestId("git-commit-strip")).toBeNull();
    await waitFor(() => expect(within(pane).getByTestId("git-commit-detail").dataset.commit).toBe(MERGE.hash));
    expect(within(pane).queryByTestId("side-pane-close")).toBeNull();

    await fireEvent.click(commitRow(FEAT));
    await waitFor(() => expect(within(pane).getByTestId("git-commit-detail").dataset.commit).toBe(FEAT.hash));
    const list = screen.getByTestId("git-graph-column");
    expect(list.style.width).toBe("65%");
    const border = [...document.querySelectorAll<HTMLElement>("[data-testid='panel-divider']")].find(
      (d) => d.dataset.split === "gitCommit",
    )!;
    expect(border.previousElementSibling).toBe(list);
    expect(border.nextElementSibling).toBe(screen.getByTestId("git-commit-side"));

    // Its own share, not the one between the branches and the history.
    border.setPointerCapture = vi.fn();
    border.releasePointerCapture = vi.fn();
    await fireEvent.pointerDown(border, { pointerId: 1, clientX: 455, clientY: 10 });
    await fireEvent.pointerMove(border, { pointerId: 1, clientX: 315, clientY: 10 });
    await fireEvent.pointerUp(border, { pointerId: 1, clientX: 315, clientY: 10 });
    expect(panelSplits.shares.gitCommit).toBeCloseTo(0.45);
    expect(panelSplits.shares.git).toBeUndefined();
    expect(list.style.width).toBe("45%");

    // Clicking the shown commit again leaves it shown: this column does not close.
    await fireEvent.click(commitRow(FEAT));
    expect(screen.getByTestId("git-commit-detail").dataset.commit).toBe(FEAT.hash);
  });

  it("what opened by itself beside the list does not follow the panel into the strip; what was picked does", async () => {
    await mountHistory();
    await layout(1200, 700);
    await screen.findByTestId("git-commit-pane");
    setWidth(screen.getByTestId("git-graph-row"), 400);
    await waitFor(() => expect(screen.queryByTestId("git-commit-detail")).toBeNull());

    setWidth(screen.getByTestId("git-graph-row"), 700);
    await screen.findByTestId("git-commit-pane");
    await fireEvent.click(commitRow(FEAT));
    await waitFor(() => expect(screen.getByTestId("git-commit-detail").dataset.commit).toBe(FEAT.hash));
    setWidth(screen.getByTestId("git-graph-row"), 400);
    await screen.findByTestId("git-commit-strip");
    expect(screen.getByTestId("git-commit-detail").dataset.commit).toBe(FEAT.hash);
  });

  it("wide, but the row cannot hold both: the strip, not a squeezed pane", async () => {
    await mountHistory();
    await layout(1200, 479);
    await fireEvent.click(commitRow(FEAT));
    await screen.findByTestId("git-commit-strip");
    expect(screen.queryByTestId("git-commit-pane")).toBeNull();
    // Room appears (the border to the changes was dragged): the same commit moves beside.
    setWidth(screen.getByTestId("git-graph-row"), 480);
    await screen.findByTestId("git-commit-pane");
    expect(screen.queryByTestId("git-commit-strip")).toBeNull();
    // Moving it asked git for nothing again.
    expect(detailCalls()).toHaveLength(1);
  });

  it("a narrow panel never puts it beside, however wide the row", async () => {
    await mountHistory();
    await layout(700, 700);
    await fireEvent.click(commitRow(FEAT));
    await screen.findByTestId("git-commit-strip");
    expect(screen.queryByTestId("git-commit-pane")).toBeNull();
  });

  it("a merge lists what it brought in — its diff against the first parent — and says so", async () => {
    await mountHistory();
    await fireEvent.click(commitRow(MERGE));
    const detail = await screen.findByTestId("git-commit-detail");
    await waitFor(() => expect(within(detail).getAllByTestId("git-commit-file")).toHaveLength(1));
    expect(drawnTree()).toEqual(["M merged.ts +1 −1"]);
    expect(within(detail).getByTestId("git-commit-merge-note")).toBeInTheDocument();
    expect(calls("diff")).toEqual([["diff", "-z", "--no-color", "--raw", "--numstat", `${MERGE.hash}^1`, MERGE.hash]]);
    // A file of it opens the same diff, for that file.
    await fireEvent.click(within(detail).getByTestId("git-commit-file"));
    await waitFor(() =>
      expect(calls("diff")).toContainEqual(["diff", "--no-color", `${MERGE.hash}^1`, MERGE.hash, "--", "merged.ts"]),
    );
  });

  it("a merge is told against its second parent when asked — the files, a file's diff and the whole diff (v1.34)", async () => {
    await mountHistory();
    await fireEvent.click(commitRow(MERGE));
    const detail = await screen.findByTestId("git-commit-detail");
    await waitFor(() => expect(within(detail).getAllByTestId("git-commit-file")).toHaveLength(1));
    expect(within(detail).getByTestId("git-commit-parent-1")).toHaveAttribute("aria-pressed", "true");
    await fireEvent.click(within(detail).getByTestId("git-commit-parent-2"));
    await waitFor(() =>
      expect(calls("diff")).toContainEqual(["diff", "-z", "--no-color", "--raw", "--numstat", `${MERGE.hash}^2`, MERGE.hash]),
    );
    expect(within(detail).getByTestId("git-commit-parent-2")).toHaveAttribute("aria-pressed", "true");
    // Its author and the rest of the header are not asked again.
    expect(detailCalls()).toHaveLength(1);
    await fireEvent.click(within(detail).getByTestId("git-commit-file"));
    await waitFor(() =>
      expect(calls("diff")).toContainEqual(["diff", "--no-color", `${MERGE.hash}^2`, MERGE.hash, "--", "merged.ts"]),
    );
    await fireEvent.click(within(detail).getByTestId("git-commit-diff"));
    await waitFor(() => expect(calls("diff")).toContainEqual(["diff", "--no-color", `${MERGE.hash}^2`, MERGE.hash]));
    // Another commit, and back: the first parent again.
    await fireEvent.click(commitRow(FEAT));
    await fireEvent.click(commitRow(MERGE));
    await waitFor(() =>
      expect(within(screen.getByTestId("git-commit-detail")).getByTestId("git-commit-parent-1")).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("an ordinary commit carries no merge note, and its file opens the commit's own diff", async () => {
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    const detail = await screen.findByTestId("git-commit-detail");
    await waitFor(() => expect(within(detail).getAllByTestId("git-commit-file")).toHaveLength(3));
    expect(within(detail).queryByTestId("git-commit-merge-note")).toBeNull();
    await fireEvent.click(within(detail).getByText("AGENTS.md").closest("button")!);
    await waitFor(() =>
      expect(calls("show")).toContainEqual(["show", "--no-color", "--format=", FEAT.hash, "--", "AGENTS.md"]),
    );
  });

  it("names the committer when someone else applied the commit", async () => {
    answers.show = () => ok(`${header("Carl Committer", "carl@example.com", AT + 3600)}\0\n${FILES}`);
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    const line = await screen.findByTestId("git-commit-committer");
    expect(line.textContent?.trim()).toMatch(/^Carl Committer <carl@example\.com> · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("a commit git could not show is an error, never 'no files'", async () => {
    answers.show = () => ({ stdout: "", stderr: "fatal: bad object", exitCode: 128 });
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    expect(await screen.findByTestId("git-commit-failed")).toBeInTheDocument();
    expect(screen.queryByText("No files in this commit")).toBeNull();
    // What the log already knew is still shown.
    expect(within(screen.getByTestId("git-commit-detail")).getByText(FEAT.subject)).toBeInTheDocument();
  });

  it("a merge whose diff failed is an error too, not an empty merge", async () => {
    answers.diff = () => ({ stdout: "", stderr: "fatal: bad revision", exitCode: 128 });
    await mountHistory();
    await fireEvent.click(commitRow(MERGE));
    expect(await screen.findByTestId("git-commit-failed")).toBeInTheDocument();
  });

  it("the answer for a commit left behind does not overwrite the one picked after it", async () => {
    let releaseFeat: (v: unknown) => void = () => {};
    answers.show = (args) =>
      args[args.length - 1] === FEAT.hash
        ? new Promise((resolve) => (releaseFeat = resolve))
        : ok(`${header()}\0\n:000000 100644 0 1 A\0only-main.txt\0`);
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    await fireEvent.click(commitRow(MAIN));
    await waitFor(() => expect(drawnTree()).toEqual(["A only-main.txt"]));
    // The slow answer arrives now — for a commit no longer shown.
    releaseFeat(ok(`${header()}\0\n${FILES}`));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("git-commit-detail").dataset.commit).toBe(MAIN.hash);
    expect(drawnTree()).toEqual(["A only-main.txt"]);
  });

  it("a parent is a way to its commit when the history has it", async () => {
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    const detail = await screen.findByTestId("git-commit-detail");
    await fireEvent.click(within(detail).getByTestId("git-commit-parent"));
    await waitFor(() => expect(screen.getByTestId("git-commit-detail").dataset.commit).toBe(ROOT.hash));
    // The root has no parents to offer.
    expect(within(screen.getByTestId("git-commit-detail")).queryByTestId("git-commit-parent")).toBeNull();
  });

  it("a narrow list writes two lines: the subject and its age, the label and the author", async () => {
    await mountHistory();
    const row = commitRow(MERGE);
    const age = within(row).getByTestId("git-row-age").textContent ?? "";
    // `compactAge`: digits and unit letters (2y, 8mo, 3w, 5d4h) — never the old "now".
    expect(age).toMatch(/^(\d+(y|mo|w|d|h|m|s))+$/);
    expect(within(row).getByTestId("git-row-author").textContent).toBe("Anna Author");
    expect(within(row).queryByTestId("git-row-moment")).toBeNull();
    expect(row.style.height).toBe("38px");
    expect(within(row).getByTestId("git-ref").dataset.kind).toBe("head");
  });

  it("a list with room writes one line with columns, from a threshold of its own", async () => {
    await mountHistory();
    setWidth(screen.getByTestId("git-graph"), 575);
    expect(commitRow(FEAT).style.height).toBe("38px");
    setWidth(screen.getByTestId("git-graph"), 576);
    await waitFor(() => expect(commitRow(FEAT).style.height).toBe("26px"));
    const row = commitRow(FEAT);
    expect(within(row).queryByTestId("git-row-age")).toBeNull();
    expect(within(row).getByTestId("git-row-author").textContent).toBe("Anna Author");
    expect(within(row).getByTestId("git-row-moment").textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // The rows and the lines beside them read the same height.
    expect(screen.getByTestId("git-rails").getAttribute("height")).toBe(String(4 * 26));
  });

  it("marks an author who did not apply the commit, and says who did", async () => {
    answers.log = () =>
      ok([FEAT.hash, FEAT.hash.slice(0, 7), "", "Anna Author", String(AT), "GitHub", "", FEAT.subject, ""].join(US));
    await mountHistory();
    expect(within(commitRow(FEAT)).getByTestId("git-row-author").textContent).toBe("Anna Author*");
  });

  it("the commits of the current branch stand out, and merges step back", async () => {
    await mountHistory();
    const head = commitRow(MERGE);
    expect(head.dataset.onHead).toBe("true");
    expect(within(head).getByText(MERGE.subject).className).toContain("text-muted");
    expect(within(commitRow(FEAT)).getByText(FEAT.subject).className).toContain("text-text");
  });

  it("every line takes its colour from the theme, and the commit's labels follow it", async () => {
    await mountHistory();
    const strokes = [...screen.getByTestId("git-rails").querySelectorAll("path")].map((p) => p.getAttribute("stroke"));
    expect(strokes.length).toBeGreaterThan(0);
    for (const s of strokes) expect(s).toMatch(/^var\(--color-rail-\d\)$/);
  });

  it("hovering a row brings its line forward", async () => {
    await mountHistory();
    await fireEvent.mouseEnter(commitRow(FEAT));
    const paths = [...screen.getByTestId("git-rails").querySelectorAll("path")];
    expect(paths.some((p) => p.getAttribute("opacity") === "0.18")).toBe(true);
    expect(paths.some((p) => p.getAttribute("opacity") === "1")).toBe(true);
    await fireEvent.mouseLeave(commitRow(FEAT).parentElement!);
    expect(paths.every((p) => p.getAttribute("opacity") === "1")).toBe(true);
  });

  it("names the branches a commit is on, and counts past three", async () => {
    answers.branch = (args) =>
      args.includes("--contains")
        ? ok("refs/heads/a\nrefs/heads/b\nrefs/heads/c\nrefs/remotes/origin/a\nrefs/remotes/origin/HEAD\n")
        : ok();
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    const line = await screen.findByTestId("git-commit-contains");
    expect(line.textContent).toContain("a, b, c");
    expect(line.textContent).toContain("1");
  });

  it("a commit's file tree folds and unfolds at once, and its whole diff is a click away", async () => {
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    await waitFor(() => expect(drawnTree()).toHaveLength(5));
    await fireEvent.click(screen.getByTestId("git-commit-collapse"));
    expect(drawnTree()).toEqual(["docs/operations 1", "src 1", "M AGENTS.md +2 −1"]);
    await fireEvent.click(screen.getByTestId("git-commit-expand"));
    expect(drawnTree()).toHaveLength(5);
    await fireEvent.click(screen.getByTestId("git-commit-diff"));
    await waitFor(() => expect(calls("show").some((a) => a.at(-1) === FEAT.hash && a.includes("--format="))).toBe(true));
  });

  it("colours a file's name by its status, as its letter is", async () => {
    await mountHistory();
    await fireEvent.click(commitRow(FEAT));
    const file = await waitFor(() => screen.getAllByTestId("git-commit-file").find((f) => f.textContent?.includes("AGENTS"))!);
    expect(within(file).getByText("AGENTS.md").className).toContain("text-accent");
  });

  // ── Search ─────────────────────────────────────────────────────────────────
  it("searches with git, not over what is loaded, and says when nothing matches", async () => {
    await mountHistory();
    answers.log = () => ok("");
    await fireEvent.input(screen.getByTestId("git-search"), { target: { value: "umask" } });
    await fireEvent.keyDown(screen.getByTestId("git-search"), { key: "Enter" });
    await waitFor(() => expect(logSearches()).toHaveLength(1));
    expect(logSearches()[0]).toContain("--grep=umask");
    expect(await screen.findByTestId("git-no-matches")).toBeInTheDocument();
    // The search stays on screen to change it.
    expect(screen.getByTestId("git-search")).toHaveValue("umask");
  });

  it("waits for the typing to stop before asking", async () => {
    vi.useFakeTimers();
    try {
      await mountHistoryFake();
      await fireEvent.input(screen.getByTestId("git-search"), { target: { value: "u" } });
      await fireEvent.input(screen.getByTestId("git-search"), { target: { value: "um" } });
      expect(logSearches()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(400);
      expect(logSearches().map((a) => a.find((t) => t.startsWith("--grep=")))).toEqual(["--grep=um"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a search shaped like a hash also asks for that commit", async () => {
    await mountHistory();
    answers.log = (args) =>
      args.includes("--grep=" + FEAT.hash.slice(0, 7)) ? ok("") : args.includes(FEAT.hash.slice(0, 7)) ? ok(logLine(FEAT)) : ok(LOG);
    await fireEvent.input(screen.getByTestId("git-search"), { target: { value: FEAT.hash.slice(0, 7) } });
    await fireEvent.keyDown(screen.getByTestId("git-search"), { key: "Enter" });
    await waitFor(() => expect(within(screen.getByTestId("git-graph")).queryByText(MAIN.subject)).toBeNull());
    expect(commitRow(FEAT)).toBeInTheDocument();
  });

  it("says why git refused a search, and does not call it empty", async () => {
    await mountHistory();
    answers.log = () => ({ stdout: "", stderr: "fatal: Invalid regexp", exitCode: 128 });
    await fireEvent.input(screen.getByTestId("git-search"), { target: { value: "(" } });
    await fireEvent.keyDown(screen.getByTestId("git-search"), { key: "Enter" });
    const error = await screen.findByTestId("git-search-error");
    expect(error.textContent).toContain("Invalid regexp");
  });

  it("the answer for an older search does not overwrite a newer one", async () => {
    await mountHistory();
    let slow: (v: unknown) => void = () => {};
    answers.log = (args) =>
      args.includes("--grep=old")
        ? new Promise((resolve) => (slow = resolve))
        : args.includes("--grep=new")
          ? ok(logLine(FEAT))
          : ok(LOG);
    const box = screen.getByTestId("git-search");
    await fireEvent.input(box, { target: { value: "old" } });
    await fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(logSearches()).toHaveLength(1));
    await fireEvent.input(box, { target: { value: "new" } });
    await fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(within(screen.getByTestId("git-graph")).queryByText(MAIN.subject)).toBeNull());
    slow(ok(logLine(MAIN)));
    await new Promise((r) => setTimeout(r));
    expect(within(screen.getByTestId("git-graph")).queryByText(MAIN.subject)).toBeNull();
  });

  it("another repository starts with no filter and one page", async () => {
    const view = render(GitPanel, { props: { sessionId: "s1", terminalCwd: "/repo" } });
    await fireEvent.click(await screen.findByTestId("git-subtab-graph"));
    const box = await screen.findByTestId("git-search");
    await fireEvent.input(box, { target: { value: "umask" } });
    await fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(logSearches()).toHaveLength(1));

    gitRun.mockClear();
    answers["rev-parse"] = () => ok("/other\n");
    await view.rerender({ sessionId: "s1", terminalCwd: "/other" });
    await waitFor(() => expect(calls("log").length).toBeGreaterThan(0));
    expect(logSearches()).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId("git-search")).toHaveValue(""));
  });

  // ── More of the history ────────────────────────────────────────────────────
  const logOf = (n: number, from = 0): string =>
    Array.from({ length: n }, (_, i) =>
      logLine({ hash: `${String(from + i).padStart(40, "0")}`, subject: `commit ${from + i}` }),
    ).join("\0");

  it("a short history just ends: nothing was cut", async () => {
    await mountHistory();
    expect(screen.queryByTestId("git-log-more")).toBeNull();
  });

  it("says the history was cut, and loads on from where it stopped", async () => {
    answers.log = (args) => (args.some((a) => a.startsWith("--skip=")) ? ok(logOf(50, 200)) : ok(logOf(200)));
    await mount();
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    const more = await screen.findByTestId("git-log-more");
    expect(more.textContent).toContain("200");
    await fireEvent.click(within(more).getByTestId("git-load-more"));
    await waitFor(() => expect(calls("log").some((a) => a.includes("--skip=200"))).toBe(true));
    // That page was not full: there is nothing more to ask for, and nothing to say.
    await waitFor(() => expect(screen.queryByTestId("git-log-more")).toBeNull());
    expect(screen.getByTestId("git-rails").getAttribute("height")).toBe(String(250 * 38));
  });

  it("a refresh keeps what was loaded", async () => {
    answers.log = (args) => {
      const n = Number(args[args.indexOf("-n") + 1]);
      return args.some((a) => a.startsWith("--skip=")) ? ok(logOf(n, 200)) : ok(logOf(n));
    };
    await mount();
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    await fireEvent.click(await screen.findByTestId("git-load-more"));
    await waitFor(() => expect(screen.getByTestId("git-rails").getAttribute("height")).toBe(String(400 * 38)));
    gitRun.mockClear();
    await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls("log").length).toBe(1));
    expect(calls("log")[0]).toContain("400");
  });

  it("stops at the cap and says so", async () => {
    answers.log = (args) => {
      const n = Number(args[args.indexOf("-n") + 1]);
      const skip = Number(args.find((a) => a.startsWith("--skip="))?.slice(7) ?? 0);
      return ok(logOf(n, skip));
    };
    await mount();
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    for (let page = 0; page < 4; page++) {
      await fireEvent.click(await screen.findByTestId("git-load-more"));
      await waitFor(() => expect(screen.getByTestId("git-rails").getAttribute("height")).toBe(String((page + 2) * 200 * 38)));
    }
    const line = screen.getByTestId("git-log-more");
    expect(line.textContent).toContain("1000");
    expect(screen.queryByTestId("git-load-more")).toBeNull();
  });

  it("draws only the rows near the view", async () => {
    answers.log = () => ok(logOf(200));
    await mount();
    await fireEvent.click(screen.getByTestId("git-subtab-graph"));
    await screen.findByTestId("git-log-more");
    const list = screen.getByTestId("git-graph");
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 380 });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const o of observers) o.cb([{ target: list }]);
    await waitFor(() => expect(screen.getAllByTestId("git-row").length).toBeLessThan(40));
  });

  // ── From the tree into the history ─────────────────────────────────────────
  async function wideWithBranches(brOutput: string) {
    answers.branch = (args) => (args.includes("--contains") ? ok() : ok(brOutput));
    await mount();
    const root = document.querySelector<HTMLElement>("[data-wide]")!;
    setWidth(root, 1200);
    await waitFor(() => expect(root.dataset.wide).toBe("true"));
    setWidth(screen.getByTestId("git-graph-row"), 900);
    await screen.findByTestId("git-tree");
  }
  const brRow = (name: string, short: string, current = false) =>
    [current ? "*" : " ", `refs/heads/${name}`, short, "", "s", "", "", "100", ""].join("\0");

  it("a click on a branch brings its commit up in the history", async () => {
    await wideWithBranches(brRow("main", MERGE.hash.slice(0, 7), true) + "\n" + brRow("feat", FEAT.hash.slice(0, 7)));
    await fireEvent.click(await screen.findByText("feat"));
    await waitFor(() => expect(screen.getByTestId("git-commit-detail").dataset.commit).toBe(FEAT.hash));
    // Selecting is not switching.
    expect(calls("checkout")).toHaveLength(0);
  });

  it("a branch older than what is loaded narrows the history to it", async () => {
    await wideWithBranches(brRow("main", MERGE.hash.slice(0, 7), true) + "\n" + brRow("old", "feedfee"));
    answers.log = (args) => (args.includes("refs/heads/old") ? ok(logLine({ hash: `feedfee${"0".repeat(33)}`, subject: "Old tip" })) : ok(LOG));
    await fireEvent.click(await screen.findByText("old"));
    await waitFor(() => expect(calls("log").some((a) => a.includes("refs/heads/old"))).toBe(true));
    await within(screen.getByTestId("git-graph")).findByText("Old tip");
    await waitFor(() => expect(screen.getByTestId("git-commit-detail").dataset.commit).toBe(`feedfee${"0".repeat(33)}`));
  });

  it("a double click on a branch switches to it, and the confirmation still stands", async () => {
    await wideWithBranches(brRow("main", MERGE.hash.slice(0, 7), true) + "\n" + brRow("feat", FEAT.hash.slice(0, 7)));
    await fireEvent.dblClick(await screen.findByText("feat"));
    expect(await screen.findByText("Confirm git action")).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId("confirm"));
    await waitFor(() => expect(calls("checkout")).toEqual([["checkout", "feat"]]));
  });

  it("asks a git too old for worktree paths again without them", async () => {
    const asked: string[][] = [];
    answers.branch = (args) => {
      asked.push(args);
      return args.at(-1)!.includes("worktreepath")
        ? { stdout: "", stderr: "fatal: unknown field name: worktreepath", exitCode: 128 }
        : ok(brRow("main", MERGE.hash.slice(0, 7), true));
    };
    await mount();
    await waitFor(() => expect(asked).toHaveLength(2));
    await fireEvent.click(screen.getByTestId("git-subtab-branches"));
    expect(await screen.findByText("main")).toBeInTheDocument();
  });
});
