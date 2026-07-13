import { describe, expect, it } from "vitest";
import {
  statusArgs,
  logArgs,
  branchesArgs,
  stageArgs,
  unstageArgs,
  discardArgs,
  cleanArgs,
  discardFileArgs,
  discardAllArgs,
  stageAllArgs,
  unstageAllArgs,
  commitArgs,
  checkoutArgs,
  createBranchArgs,
  deleteBranchArgs,
  renameBranchArgs,
  mergeArgs,
  rebaseArgs,
  setUpstreamArgs,
  compareBranchesArgs,
  branchWebUrl,
  pushArgs,
  pullArgs,
  fetchArgs,
  stashSaveArgs,
  stashPushFileArgs,
  stashApplyArgs,
  stashPopArgs,
  stashDropArgs,
  stashFilesArgs,
  stashFileDiffArgs,
  diffFileArgs,
  showFileArgs,
  showFileAtArgs,
  commitFilesArgs,
  checkoutCommitArgs,
  resetArgs,
  cherryPickArgs,
  revertArgs,
  tagArgs,
  diffCommitWorkingArgs,
  remoteUrlArgs,
  commitWebUrl,
  parseStatus,
  parseLog,
  parseBranches,
  parseStashes,
  parseDiff,
  parseCommitFiles,
  stagedFiles,
  unstagedFiles,
  isDestructive,
  isUncommittedChangesError,
  isRemoteConnectionError,
  parseSyncResult,
  buildGraph,
  railColor,
  RAIL_COLORS,
  type GitCommit,
} from "./git";

describe("argument builders", () => {
  it("build the expected vectors", () => {
    expect(statusArgs()).toEqual(["status", "--porcelain=v2", "--branch", "-z"]);
    expect(branchesArgs()[0]).toBe("branch");
    expect(logArgs(50)).toContain("50");
    expect(logArgs()).toContain("--all");
    expect(logArgs()).toContain("-z");
    expect(stageArgs(["a", "b"])).toEqual(["add", "--", "a", "b"]);
    expect(unstageArgs(["a"])).toEqual(["restore", "--staged", "--", "a"]);
    expect(discardArgs(["a"])).toEqual(["restore", "--", "a"]);
    expect(cleanArgs(["a", "b"])).toEqual(["clean", "-f", "--", "a", "b"]);
    expect(stageAllArgs()).toEqual(["add", "-A"]);
    expect(unstageAllArgs()).toEqual(["reset", "-q"]);
    expect(commitArgs("hi there")).toEqual(["commit", "-m", "hi there"]);
    expect(checkoutArgs("main")).toEqual(["checkout", "main"]);
    expect(createBranchArgs("feat")).toEqual(["checkout", "-b", "feat"]);
    expect(createBranchArgs("feat", "main")).toEqual(["checkout", "-b", "feat", "main"]);
    expect(deleteBranchArgs("x")).toEqual(["branch", "-d", "x"]);
    expect(deleteBranchArgs("x", true)).toEqual(["branch", "-D", "x"]);
    expect(renameBranchArgs("a", "b")).toEqual(["branch", "-m", "a", "b"]);
    expect(mergeArgs("dev")).toEqual(["merge", "dev"]);
    expect(rebaseArgs("dev")).toEqual(["rebase", "dev"]);
    expect(setUpstreamArgs("feat", "origin/feat")).toEqual([
      "branch",
      "--set-upstream-to=origin/feat",
      "feat",
    ]);
    expect(compareBranchesArgs("main", "feat")).toEqual(["diff", "--no-color", "main", "feat"]);
    expect(pullArgs()).toEqual(["pull", "--ff-only"]);
    expect(fetchArgs()).toEqual(["fetch", "--all", "--prune"]);
    expect(stashSaveArgs()).toEqual(["stash", "push"]);
    expect(stashSaveArgs("wip")).toEqual(["stash", "push", "-m", "wip"]);
    expect(stashPushFileArgs("a.ts")).toEqual(["stash", "push", "--", "a.ts"]);
    expect(stashApplyArgs(2)).toEqual(["stash", "apply", "stash@{2}"]);
    expect(stashPopArgs(0)).toEqual(["stash", "pop", "stash@{0}"]);
    expect(stashDropArgs(1)).toEqual(["stash", "drop", "stash@{1}"]);
    expect(stashFilesArgs(1)).toEqual(["stash", "show", "--name-status", "stash@{1}"]);
    expect(stashFileDiffArgs(0, "f.txt")).toEqual([
      "diff",
      "--no-color",
      "stash@{0}^1",
      "stash@{0}",
      "--",
      "f.txt",
    ]);
    expect(commitFilesArgs("abc")).toContain("abc");
  });

  it("push builds force-with-lease and upstream forms", () => {
    expect(pushArgs()).toEqual(["push"]);
    expect(pushArgs({ force: true })).toEqual(["push", "--force-with-lease"]);
    expect(pushArgs({ setUpstream: true, branch: "feat" })).toEqual([
      "push",
      "--set-upstream",
      "origin",
      "feat",
    ]);
  });

  it("diff/show target a path", () => {
    expect(diffFileArgs("f.ts", false)).toEqual(["diff", "--no-color", "--", "f.ts"]);
    expect(diffFileArgs("f.ts", true)).toEqual(["diff", "--no-color", "--cached", "--", "f.ts"]);
    expect(showFileArgs("sha", "f.ts")).toEqual(["show", "--no-color", "--format=", "sha", "--", "f.ts"]);
    expect(showFileAtArgs("HEAD", "src/f.ts")).toEqual(["show", "HEAD:src/f.ts"]);
  });

  it("commit-level actions (context menu)", () => {
    expect(checkoutCommitArgs("sha")).toEqual(["checkout", "sha"]);
    expect(resetArgs("sha", "soft")).toEqual(["reset", "--soft", "sha"]);
    expect(resetArgs("sha", "hard")).toEqual(["reset", "--hard", "sha"]);
    expect(cherryPickArgs("sha")).toEqual(["cherry-pick", "sha"]);
    expect(revertArgs("sha")).toEqual(["revert", "--no-edit", "sha"]);
    expect(tagArgs("v1", "sha")).toEqual(["tag", "v1", "sha"]);
    expect(diffCommitWorkingArgs("sha")).toEqual(["diff", "--no-color", "sha"]);
    expect(remoteUrlArgs()).toEqual(["remote", "get-url", "origin"]);
  });

  it("discard single file vs all (dirty dialog)", () => {
    expect(discardFileArgs({ path: "a.ts", index: "M" })).toEqual(["checkout", "HEAD", "--", "a.ts"]);
    expect(discardFileArgs({ path: "new.ts", index: "?" })).toEqual(["clean", "-f", "--", "new.ts"]);
    expect(discardAllArgs()).toEqual(["reset", "--hard"]);
  });
});

describe("isUncommittedChangesError", () => {
  it("recognizes the dirty-working-tree abort, ignores unrelated errors", () => {
    const dirty =
      "error: Your local changes to the following files would be overwritten by checkout:\n" +
      "\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches.\nAborting";
    expect(isUncommittedChangesError(dirty)).toBe(true);
    // Verbatim git output from a real `git checkout main` abort.
    const real =
      "error: Your local changes to the following files would be overwritten by checkout:\n" +
      "        .gitlab-ci.yml\n" +
      "Please commit your changes or stash them before you switch branches.\n" +
      "Aborting";
    expect(isUncommittedChangesError(real)).toBe(true);
    expect(isUncommittedChangesError("error: pathspec 'x' did not match")).toBe(false);
    expect(isUncommittedChangesError("fatal: not a git repository")).toBe(false);
    expect(isUncommittedChangesError("")).toBe(false);
  });
});

describe("isRemoteConnectionError", () => {
  it("flags unreachable/auth/host-key failures, not ordinary git errors", () => {
    expect(isRemoteConnectionError("fatal: Could not read from remote repository.")).toBe(true);
    expect(isRemoteConnectionError("ssh: connect to host x port 22: Connection timed out")).toBe(true);
    expect(isRemoteConnectionError("Could not resolve host: git.example.com")).toBe(true);
    expect(isRemoteConnectionError("Permission denied (publickey).")).toBe(true);
    expect(isRemoteConnectionError("Authentication failed for 'https://...'")).toBe(true);
    expect(isRemoteConnectionError("error: failed to push some refs (fast-forward)")).toBe(false);
    expect(isRemoteConnectionError("")).toBe(false);
  });
});

describe("parseSyncResult", () => {
  it("reads up-to-date and object ranges", () => {
    expect(parseSyncResult("Everything up-to-date")).toEqual({ upToDate: true, range: null });
    expect(parseSyncResult("Already up to date.")).toEqual({ upToDate: true, range: null });
    expect(parseSyncResult("   abc1234..9de0345  main -> main")).toEqual({
      upToDate: false,
      range: "abc1234..9de0345",
    });
    expect(parseSyncResult("done")).toEqual({ upToDate: false, range: null });
  });
});

describe("commitWebUrl", () => {
  it("converts ssh (scp) and https remotes", () => {
    expect(commitWebUrl("git@github.com:owner/repo.git", "abc")).toBe(
      "https://github.com/owner/repo/commit/abc",
    );
    expect(commitWebUrl("https://gitlab.com/grp/sub/repo.git", "def")).toBe(
      "https://gitlab.com/grp/sub/repo/commit/def",
    );
    expect(commitWebUrl("ssh://git@github.com:22/owner/repo", "xyz")).toBe(
      "https://github.com/owner/repo/commit/xyz",
    );
  });

  it("builds branch URLs (tree / bitbucket branch)", () => {
    expect(branchWebUrl("git@github.com:owner/repo.git", "feat")).toBe(
      "https://github.com/owner/repo/tree/feat",
    );
    expect(branchWebUrl("git@bitbucket.org:team/repo.git", "feat")).toBe(
      "https://bitbucket.org/team/repo/branch/feat",
    );
    expect(branchWebUrl("/local/repo", "feat")).toBe(null);
  });

  it("uses /commits/ for bitbucket and null for unknown remotes", () => {
    expect(commitWebUrl("git@bitbucket.org:team/repo.git", "abc")).toBe(
      "https://bitbucket.org/team/repo/commits/abc",
    );
    expect(commitWebUrl("/local/path/repo", "abc")).toBe(null);
    expect(commitWebUrl("", "abc")).toBe(null);
  });
});

describe("parseStatus", () => {
  it("reads branch headers and ahead/behind", () => {
    const raw =
      "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0";
    const st = parseStatus(raw);
    expect(st.branch).toBe("main");
    expect(st.upstream).toBe("origin/main");
    expect(st.ahead).toBe(2);
    expect(st.behind).toBe(1);
    expect(st.initial).toBe(false);
  });

  it("flags the initial commit and detached head", () => {
    const raw = "# branch.oid (initial)\0# branch.head (detached)\0";
    const st = parseStatus(raw);
    expect(st.initial).toBe(true);
    expect(st.branch).toBe(null);
  });

  it("parses ordinary, renamed and untracked entries", () => {
    const raw =
      "1 M. N... 100644 100644 100644 aaa bbb src/a.ts\0" +
      "1 .M N... 100644 100644 100644 aaa bbb src/b.ts\0" +
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\0old.ts\0" +
      "? untracked.ts\0";
    const st = parseStatus(raw);
    expect(st.files).toHaveLength(4);
    const a = st.files.find((f) => f.path === "src/a.ts")!;
    expect(a.index).toBe("M");
    expect(a.work).toBe(".");
    const b = st.files.find((f) => f.path === "src/b.ts")!;
    expect(b.index).toBe(".");
    expect(b.work).toBe("M");
    const rn = st.files.find((f) => f.path === "new.ts")!;
    expect(rn.orig).toBe("old.ts");
    expect(rn.index).toBe("R");
    const un = st.files.find((f) => f.path === "untracked.ts")!;
    expect(un.index).toBe("?");
    expect(un.work).toBe("?");
  });

  it("splits staged vs unstaged", () => {
    const files = parseStatus(
      "1 M. N... 100644 100644 100644 aaa bbb staged.ts\0" +
        "1 .M N... 100644 100644 100644 aaa bbb work.ts\0" +
        "? new.ts\0",
    ).files;
    expect(stagedFiles(files).map((f) => f.path)).toEqual(["staged.ts"]);
    expect(unstagedFiles(files).map((f) => f.path).sort()).toEqual(["new.ts", "work.ts"]);
  });
});

describe("parseLog", () => {
  it("parses fields, parents and decorations", () => {
    const US = "\x1f";
    // NUL-separated records (-z); the body carries newlines safely.
    const raw =
      ["h1", "h1s", "p1 p2", "Ann", "1700000000", "HEAD -> main, tag: v1, origin/main", "merge branches", "Body one.\nBody two."].join(US) +
      "\0" +
      ["p1", "p1s", "", "Bob", "1699999999", "", "root", ""].join(US);
    const commits = parseLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0].hash).toBe("h1");
    expect(commits[0].parents).toEqual(["p1", "p2"]);
    expect(commits[0].refs).toEqual(["main", "v1", "origin/main"]);
    expect(commits[0].head).toBe(true);
    expect(commits[0].subject).toBe("merge branches");
    expect(commits[0].body).toBe("Body one.\nBody two.");
    expect(commits[1].parents).toEqual([]);
    expect(commits[1].refs).toEqual([]);
    expect(commits[1].head).toBe(false);
    expect(commits[1].body).toBe("");
  });
});

describe("parseBranches", () => {
  it("separates local and remote and marks current", () => {
    const raw =
      "*\0refs/heads/main\0abc\0origin/main\0latest\n" +
      " \0refs/heads/feat\0def\0\0wip\n" +
      " \0refs/remotes/origin/main\0abc\0\0latest\n" +
      " \0refs/remotes/origin/HEAD\0\0\0";
    const br = parseBranches(raw);
    // origin/HEAD pointer is dropped.
    expect(br).toHaveLength(3);
    const main = br.find((b) => b.name === "main")!;
    expect(main.current).toBe(true);
    expect(main.upstream).toBe("origin/main");
    expect(main.remote).toBe(false);
    const remote = br.find((b) => b.remote)!;
    expect(remote.name).toBe("origin/main");
  });
});

describe("parseStashes", () => {
  it("extracts index and subject", () => {
    const US = "\x1f";
    const raw = `stash@{0}${US}WIP on main: abc\nstash@{1}${US}On feat: def`;
    const st = parseStashes(raw);
    expect(st).toHaveLength(2);
    expect(st[0].index).toBe(0);
    expect(st[1].index).toBe(1);
    expect(st[0].subject).toContain("WIP");
  });
});

describe("parseDiff", () => {
  it("types meta, hunk, add, del and context lines", () => {
    const raw = [
      "diff --git a/f b/f",
      "index 000..111 100644",
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,2 @@",
      " context",
      "-removed",
      "+added",
    ].join("\n");
    const lines = parseDiff(raw);
    expect(lines.find((l) => l.type === "hunk")!.text).toContain("@@");
    expect(lines.filter((l) => l.type === "add")).toHaveLength(1);
    expect(lines.filter((l) => l.type === "del")).toHaveLength(1);
    expect(lines.filter((l) => l.type === "meta").length).toBeGreaterThanOrEqual(4);
    expect(lines.filter((l) => l.type === "ctx")).toHaveLength(1);
  });
});

describe("parseCommitFiles", () => {
  it("handles plain and rename rows", () => {
    const raw = "M\tsrc/a.ts\nA\tsrc/b.ts\nR100\told.ts\tnew.ts";
    const files = parseCommitFiles(raw);
    expect(files).toHaveLength(3);
    expect(files[0]).toEqual({ path: "src/a.ts", status: "M" });
    expect(files[2]).toEqual({ path: "new.ts", status: "R" });
  });
});

describe("isDestructive", () => {
  it("flags force pushes, hard resets, deletes and discards", () => {
    expect(isDestructive(["push", "--force-with-lease"])).toBe(true);
    expect(isDestructive(["push"])).toBe(false);
    expect(isDestructive(["branch", "-D", "x"])).toBe(true);
    expect(isDestructive(["branch", "-m", "a", "b"])).toBe(false);
    expect(isDestructive(["reset", "--hard"])).toBe(true);
    expect(isDestructive(["reset", "-q"])).toBe(false);
    expect(isDestructive(["restore", "--", "f"])).toBe(true);
    expect(isDestructive(["merge", "dev"])).toBe(true);
    expect(isDestructive(["rebase", "dev"])).toBe(true);
    expect(isDestructive(["stash", "drop", "stash@{0}"])).toBe(true);
    expect(isDestructive(["stash", "list"])).toBe(false);
    expect(isDestructive(["checkout", "-f", "main"])).toBe(true);
    expect(isDestructive(["checkout", "main"])).toBe(false);
    expect(isDestructive(["status"])).toBe(false);
  });
});

describe("buildGraph", () => {
  const c = (hash: string, parents: string[]): GitCommit => ({
    hash,
    short: hash,
    parents,
    author: "a",
    timestamp: 0,
    refs: [],
    subject: hash,
    body: "",
    head: false,
  });

  it("places a linear history in a single lane", () => {
    const rows = buildGraph([c("c", ["b"]), c("b", ["a"]), c("a", [])]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(rows.every((r) => r.lanes >= 1)).toBe(true);
    // Last (root) commit has no parents → no outgoing 'out' segment.
    expect(rows[2].segments.some((s) => s.kind === "out")).toBe(false);
  });

  it("assigns a merge commit two outgoing segments", () => {
    const rows = buildGraph([c("m", ["a", "b"]), c("b", ["a"]), c("a", [])]);
    const merge = rows[0];
    expect(merge.segments.filter((s) => s.kind === "out")).toHaveLength(2);
    // A second lane must appear for the second parent.
    expect(Math.max(...rows.map((r) => r.lanes))).toBeGreaterThanOrEqual(2);
  });

  it("draws a merge-in when a lane converges into a later commit", () => {
    const rows = buildGraph([c("m", ["a", "b"]), c("b", ["a"]), c("a", [])]);
    // Commit 'a' is reached from two lanes → an 'in' convergence segment exists.
    const a = rows[2];
    expect(a.segments.some((s) => s.kind === "in")).toBe(true);
  });
});

describe("railColor", () => {
  it("cycles and handles wrap", () => {
    expect(railColor(0)).toBe(RAIL_COLORS[0]);
    expect(railColor(RAIL_COLORS.length)).toBe(RAIL_COLORS[0]);
  });
});
