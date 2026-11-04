import { describe, expect, it } from "vitest";
import {
  allFolderKeys,
  DEFAULT_FAVORITE_BRANCHES,
  findByShort,
  refLabels,
  refRows,
  sanitizeFavoriteBranches,
  tagRef,
  toggledFavorite,
  type RefRow,
} from "./gitrefs";
import type { GitBranch, GitTag } from "./git";

const branch = (name: string, extra: Partial<GitBranch> = {}): GitBranch => ({
  name,
  fullRef: extra.remote ? `refs/remotes/${name}` : `refs/heads/${name}`,
  current: false,
  short: "abc1234",
  upstream: null,
  subject: "",
  remote: false,
  track: null,
  date: 0,
  worktree: null,
  ...extra,
});
const tag = (name: string): GitTag => ({ name, short: "abc1234" });

/** The tree as text: `  label` per row, indented by depth. */
const drawn = (rows: RefRow[]): string[] =>
  rows.map((r) => {
    const label = r.kind === "section" ? `[${r.section}]` : r.label;
    const mark = r.kind === "section" || r.kind === "folder" ? ` ${r.open ? "v" : ">"}${r.count}` : "";
    return `${"  ".repeat(r.depth)}${label}${mark}`;
  });

describe("refLabels", () => {
  it("folds a local branch and its remote twin on one commit into one label", () => {
    expect(
      refLabels([
        { kind: "local", name: "main" },
        { kind: "remote", name: "origin/main" },
      ]),
    ).toEqual([{ kind: "local", name: "main", synced: true }]);
  });
  it("orders the checked-out branch, the local ones, the remote ones, the tags", () => {
    const labels = refLabels([
      { kind: "tag", name: "v1" },
      { kind: "remote", name: "origin/x" },
      { kind: "local", name: "a" },
      { kind: "head", name: "b" },
    ]);
    expect(labels.map((l) => l.name)).toEqual(["b", "a", "origin/x", "v1"]);
  });
  it("keeps a remote branch whose local twin is elsewhere", () => {
    expect(refLabels([{ kind: "remote", name: "origin/main" }])).toEqual([
      { kind: "remote", name: "origin/main", synced: false },
    ]);
  });
  it("leaves tags out when asked", () => {
    expect(refLabels([{ kind: "tag", name: "v1" }], false)).toEqual([]);
  });
});

describe("favourites", () => {
  it("star the usual main branches out of the box", () => {
    expect(sanitizeFavoriteBranches(undefined)).toEqual(DEFAULT_FAVORITE_BRANCHES);
  });
  it("keeps what is stored, and only what could be a name", () => {
    expect(sanitizeFavoriteBranches(["x", "x", " ", 1, null, "y"])).toEqual(["x", "y"]);
    expect(sanitizeFavoriteBranches([])).toEqual([]);
  });
  it("toggle by name", () => {
    expect(toggledFavorite(["a"], "b")).toEqual(["a", "b"]);
    expect(toggledFavorite(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("refRows", () => {
  const branches = [
    branch("main"),
    branch("1.0.5"),
    branch("feat/a"),
    branch("feat/b"),
    branch("docs/ci", { current: true }),
    branch("deep/er/still/x"),
    branch("origin/main", { remote: true }),
    branch("origin/dependabot/npm/y", { remote: true }),
  ];
  const tags = [tag("v2"), tag("v1")];
  const input = { branches, tags, favorites: ["main"] };

  it("opens the local section and the way to the current branch, and nothing else", () => {
    expect(drawn(refRows(input))).toEqual([
      "[local] v6",
      "  main",
      "  1.0.5",
      "  deep/er/still >1",
      "  docs v1",
      "    ci",
      "  feat >2",
      "[remote] >2",
      "[tags] >2",
    ]);
  });

  it("marks a favourite and takes it out of its folder", () => {
    const rows = refRows({ ...input, favorites: ["feat/a"] });
    const fav = rows.find((r) => r.kind === "branch" && r.favorite) as Extract<RefRow, { kind: "branch" }>;
    expect(fav.label).toBe("feat/a");
    expect(fav.depth).toBe(1);
    expect(rows.find((r) => r.kind === "folder" && r.label === "feat")).toMatchObject({ count: 1 });
  });

  it("follows what the user folded and unfolded", () => {
    const opened = new Set(["remote", "remote/origin", "local/feat"]);
    const closed = new Set(["local/docs"]);
    const rows = refRows({
      ...input,
      isOpen: (key, byDefault) => (closed.has(key) ? false : opened.has(key) ? true : byDefault),
    });
    expect(drawn(rows)).toEqual([
      "[local] v6",
      "  main",
      "  1.0.5",
      "  deep/er/still >1",
      "  docs >1",
      "  feat v2",
      "    a",
      "    b",
      "[remote] v2",
      "  origin v2",
      "    main",
      "    dependabot/npm >1",
      "[tags] >2",
    ]);
  });

  it("under a search opens all that is left and drops the sections with nothing", () => {
    expect(drawn(refRows({ ...input, query: "FEAT/" }))).toEqual(["[local] v2", "  feat v2", "    a", "    b"]);
    expect(drawn(refRows({ ...input, query: "v1" }))).toEqual(["[tags] v1", "  v1"]);
    expect(refRows({ ...input, query: "nothing" })).toEqual([]);
  });

  it("gives every row a key of its own", () => {
    const rows = refRows({ ...input, query: "/" });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("names a favourite's key apart from a same-named folder row", () => {
    const rows = refRows({ branches: [branch("a/b"), branch("a/c")], tags: [], favorites: ["a/b"] });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("allFolderKeys", () => {
  it("names every section and folder, however deep", () => {
    const keys = allFolderKeys({ branches: [branch("a/b/c"), branch("a/d")], tags: [tag("x/y")], favorites: [] });
    expect(keys).toEqual(["local", "local/a", "local/a/b", "remote", "tags", "tags/x"]);
  });
});

describe("findByShort", () => {
  const rows = [{ hash: "abcdef0123" }, { hash: "0123456789" }];
  it("finds by a prefix of the hash", () => {
    expect(findByShort(rows, "012345")).toBe(rows[1]);
    expect(findByShort(rows, "ffffff")).toBeUndefined();
  });
  it("does not take an empty hash for a match", () => {
    expect(findByShort(rows, "")).toBeUndefined();
  });
});

it("tagRef names a tag in full", () => {
  expect(tagRef({ name: "v1.2" })).toBe("refs/tags/v1.2");
});
