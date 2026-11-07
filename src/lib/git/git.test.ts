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
  commitDetailArgs,
  mergeFilesArgs,
  mergeFileDiffArgs,
  parseCommitDetail,
  parseRawNumstatZ,
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
  parseContains,
  parseDecoration,
  parseTags,
  parseStashes,
  parseDiff,
  LOG_PAGE,
  LOG_SINCE,
  NO_FILTER,
  isFiltered,
  looksLikeHash,
  hashLookupArgs,
  updateBranchArgs,
  commitDiffArgs,
  type LogFilter,
  parseCommitFiles,
  stagedFiles,
  unstagedFiles,
  isDestructive,
  needsConfirm,
  isUncommittedChangesError,
  isRemoteConnectionError,
  parseSyncResult,
  stagedDiffArgs,
} from "./git";
import * as git from "./git";

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
      ["h1", "h1s", "p1 p2", "Ann", "1700000000", "GitHub", "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main", "merge branches", "Body one.\nBody two."].join(US) +
      "\0" +
      ["p1", "p1s", "", "Bob", "1699999999", "Bob", "", "root", ""].join(US);
    const commits = parseLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0].hash).toBe("h1");
    expect(commits[0].parents).toEqual(["p1", "p2"]);
    expect(commits[0].committer).toBe("GitHub");
    expect(commits[0].refs).toEqual([
      { kind: "head", name: "main" },
      { kind: "tag", name: "v1" },
      { kind: "remote", name: "origin/main" },
    ]);
    expect(commits[0].head).toBe(true);
    expect(commits[0].subject).toBe("merge branches");
    expect(commits[0].body).toBe("Body one.\nBody two.");
    expect(commits[1].parents).toEqual([]);
    expect(commits[1].refs).toEqual([]);
    expect(commits[1].head).toBe(false);
    expect(commits[1].body).toBe("");
  });

  it("drops a record cut short rather than shift its fields", () => {
    expect(parseLog(["h", "s", "", "Ann", "1"].join("\x1f"))).toEqual([]);
  });
});

describe("parseDecoration", () => {
  it("tells a branch, a remote branch and a tag apart by what git calls them", () => {
    expect(parseDecoration("refs/heads/fix/x, refs/remotes/origin/fix/x, tag: refs/tags/v1.2").refs).toEqual([
      { kind: "local", name: "fix/x" },
      { kind: "remote", name: "origin/fix/x" },
      { kind: "tag", name: "v1.2" },
    ]);
  });
  it("says HEAD only of HEAD: origin/HEAD is not this checkout", () => {
    expect(parseDecoration("refs/remotes/origin/HEAD, refs/remotes/origin/main")).toEqual({
      refs: [{ kind: "remote", name: "origin/main" }],
      head: false,
    });
  });
  it("marks a detached HEAD without a label for it", () => {
    expect(parseDecoration("HEAD")).toEqual({ refs: [], head: true });
    expect(parseDecoration("HEAD -> refs/heads/main")).toEqual({
      refs: [{ kind: "head", name: "main" }],
      head: true,
    });
  });
  it("leaves out what is neither a branch nor a tag", () => {
    expect(parseDecoration("refs/stash").refs).toEqual([]);
  });
  it("reads a short name as a local branch, a short tag as a tag", () => {
    expect(parseDecoration("main, tag: v1").refs).toEqual([
      { kind: "local", name: "main" },
      { kind: "tag", name: "v1" },
    ]);
  });
});

describe("logArgs", () => {
  it("asks for full ref names, the whole history, a page at a time", () => {
    const args = logArgs();
    expect(args).toContain("--decorate=full");
    expect(args).toContain("--all");
    expect(args[args.indexOf("-n") + 1]).toBe(String(LOG_PAGE));
    expect(args.some((a) => a.startsWith("--skip"))).toBe(false);
  });
  it("goes on from where it stopped", () => {
    expect(logArgs(200, 400)).toContain("--skip=400");
  });
  const tail = (filter: Partial<LogFilter>) => {
    const args = logArgs(10, 0, { ...NO_FILTER, ...filter });
    return args.slice(args.indexOf("10") + 1);
  };
  it("searches messages literally and without case unless told otherwise", () => {
    expect(tail({ text: "a.b" })).toEqual(["--grep=a.b", "-F", "-i", "--all"]);
    expect(tail({ text: "a.b", regex: true, matchCase: true })).toEqual(["--grep=a.b", "-E", "--all"]);
  });
  it("takes an author's name as a name, also beside a regular expression", () => {
    expect(tail({ author: "dependabot[bot]" })).toEqual(["--author=dependabot[bot]", "-F", "--all"]);
    expect(tail({ text: "x", regex: true, author: "dependabot[bot]" })).toEqual([
      "--grep=x",
      "-E",
      "-i",
      "--author=dependabot\\[bot\\]",
      "--all",
    ]);
  });
  it("narrows to one ref, a period and a path, the path last", () => {
    expect(tail({ branch: "refs/heads/x", since: "week", path: "a b.ts" })).toEqual([
      "--since=7.days.ago",
      "refs/heads/x",
      "--",
      "a b.ts",
    ]);
    for (const since of LOG_SINCE) expect(tail({ since }).join(" ")).toContain("--since=");
  });
  it("follows one file through its renames, and only a file", () => {
    expect(tail({ path: "a.ts", follow: true })).toEqual(["--follow", "--all", "--", "a.ts"]);
    expect(tail({ follow: true })).toEqual(["--all"]);
  });
  it("never lets a search value be read as an option of its own", () => {
    for (const a of logArgs(10, 0, { ...NO_FILTER, text: "--output=/tmp/x" })) {
      expect(a.startsWith("--output")).toBe(false);
    }
  });
});

describe("isFiltered", () => {
  it("is about what narrows the history, not how a search is read", () => {
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ ...NO_FILTER, regex: true, matchCase: true })).toBe(false);
    for (const f of [{ text: "x" }, { branch: "refs/heads/x" }, { author: "a" }, { since: "week" as const }, { path: "p" }]) {
      expect(isFiltered({ ...NO_FILTER, ...f })).toBe(true);
    }
  });
});

describe("looksLikeHash and hashLookupArgs", () => {
  it("takes hex of a commit's length, and nothing an option could start with", () => {
    expect(looksLikeHash("1591790")).toBe(true);
    expect(looksLikeHash("ABCD")).toBe(true);
    expect(looksLikeHash("abc")).toBe(false);
    expect(looksLikeHash("fix: x")).toBe(false);
    expect(looksLikeHash("--all")).toBe(false);
    expect(looksLikeHash("a".repeat(41))).toBe(false);
  });
  it("asks for that one commit, closing the revisions so it is never read as a path", () => {
    const args = hashLookupArgs("abcd");
    expect(args.slice(-4)).toEqual(["-n", "1", "abcd", "--"]);
    expect(args).not.toContain("--all");
  });
});

describe("branchesArgs", () => {
  it("asks where a branch is checked out, or does not, for a git too old to know", () => {
    expect(branchesArgs().at(-1)).toContain("%(worktreepath)");
    expect(branchesArgs(false).at(-1)).not.toContain("worktreepath");
  });
  it("reads the upstream's state in both forms", () => {
    expect(branchesArgs().at(-1)).toContain("%(upstream:trackshort)%00%(upstream:track,nobracket)");
  });
});

describe("updateBranchArgs", () => {
  it("fast-forwards from the upstream; no + in the refspec, so a diverged branch is refused", () => {
    expect(updateBranchArgs({ name: "main", upstream: "origin/main" })).toEqual(["fetch", "origin", "main:main"]);
    expect(updateBranchArgs({ name: "x", upstream: "fork/feat/x" })).toEqual(["fetch", "fork", "feat/x:x"]);
  });
  it("has nothing to do for a branch without one", () => {
    expect(updateBranchArgs({ name: "x", upstream: null })).toBeNull();
    expect(updateBranchArgs({ name: "x", upstream: "local" })).toBeNull();
  });
});

describe("commitDiffArgs", () => {
  it("shows a commit, and a merge against its first parent as its file list does", () => {
    expect(commitDiffArgs("h", false)).toEqual(["show", "--no-color", "--format=", "h"]);
    expect(commitDiffArgs("h", true)).toEqual(["diff", "--no-color", "h^1", "h"]);
  });
});

describe("parseTags", () => {
  it("takes the commit of an annotated tag, the object of a lightweight one", () => {
    expect(parseTags("v2\0aaa\0bbb\nv1\0ccc\0\n")).toEqual([
      { name: "v2", short: "bbb" },
      { name: "v1", short: "ccc" },
    ]);
  });
});

describe("parseContains", () => {
  it("names local branches first and leaves out origin/HEAD and a detached line", () => {
    expect(
      parseContains("refs/remotes/origin/main\nrefs/heads/x\nrefs/remotes/origin/HEAD\n(HEAD detached at abc)\n"),
    ).toEqual(["x", "origin/main"]);
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

  it("reads the upstream's state whatever language the host's git speaks", () => {
    const row = (short: string, track: string) =>
      ["*", "refs/heads/a", "abc", "origin/a", "s", short, track, "100", ""].join("\0");
    const track = (short: string, text: string) => parseBranches(row(short, text))[0].track;
    expect(track(">", "voraus 3")).toEqual({ ahead: 3, behind: 0, gone: false });
    expect(track("<", "позади 2")).toEqual({ ahead: 0, behind: 2, gone: false });
    expect(track("<>", "ahead 3, behind 2")).toEqual({ ahead: 3, behind: 2, gone: false });
    expect(track("=", "")).toEqual({ ahead: 0, behind: 0, gone: false });
    expect(track("", "gone")).toEqual({ ahead: 0, behind: 0, gone: true });
    expect(track("", "")).toBeNull();
  });

  it("takes the date and the worktree when the host's git gave them", () => {
    const [b] = parseBranches([" ", "refs/heads/a", "abc", "", "s", "", "", "1700000000", "/repo/wt"].join("\0"));
    expect(b.date).toBe(1700000000);
    expect(b.worktree).toBe("/repo/wt");
    const [old] = parseBranches(" \0refs/heads/a\0abc\0\0s");
    expect(old).toMatchObject({ date: 0, worktree: null, track: null });
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

describe("commit details", () => {
  const US = "\x1f";
  const RS = "\x1e";
  // What git 2.54 prints for `commitDetailArgs` — bytes taken from a real repo:
  // a modified file, an added one with a space and Cyrillic in its name, a
  // binary file, one with a tab in its name, a rename with an edit.
  const meta = ["Anna Author", "anna@example.com", "1791671525", "Carl Committer", "carl@example.com", "1791671999"];
  const listing =
    ":100644 100644 4cb29ea ea14db2 M\0AGENTS.md\0" +
    ":000000 100644 0000000 b77b4eb A\0docs/заметка с пробелом.md\0" +
    ":100644 100644 8352675 95d586e M\0logo.bin\0" +
    ":000000 100644 0000000 718f4d2 A\0odd\tname.txt\0" +
    ":100644 100644 9405325 c2f2e5e R080\0old.ts\0src/new.ts\0" +
    "2\t1\tAGENTS.md\0" +
    "2\t0\tdocs/заметка с пробелом.md\0" +
    "-\t-\tlogo.bin\0" +
    "1\t0\todd\tname.txt\0" +
    "1\t1\t\0old.ts\0src/new.ts\0";
  const answer = `${RS}${meta.join(US)}${RS}\0\n${listing}`;

  it("asks for the header and the files in one NUL-terminated call", () => {
    const args = commitDetailArgs("abc123");
    expect(args[0]).toBe("show");
    expect(args).toContain("-z");
    // `--name-status` would silence `--numstat`; the raw records carry the status.
    expect(args).toContain("--raw");
    expect(args).toContain("--numstat");
    expect(args).not.toContain("--name-status");
    expect(args[args.length - 1]).toBe("abc123");
    const format = args.find((a) => a.startsWith("--format="))!;
    expect(format).toBe(`--format=${RS}%an${US}%ae${US}%at${US}%cn${US}%ce${US}%ct${RS}`);
  });

  it("asks a merge for its diff against the first parent, by name", () => {
    expect(mergeFilesArgs("abc123")).toEqual(["diff", "-z", "--no-color", "--raw", "--numstat", "abc123^1", "abc123"]);
    expect(mergeFileDiffArgs("abc123", "src/a b.ts")).toEqual([
      "diff",
      "--no-color",
      "abc123^1",
      "abc123",
      "--",
      "src/a b.ts",
    ]);
  });

  it("reads who wrote it, who applied it and the files", () => {
    expect(parseCommitDetail(answer)).toEqual({
      authorEmail: "anna@example.com",
      committer: "Carl Committer",
      committerEmail: "carl@example.com",
      committed: 1791671999,
      files: [
        { path: "AGENTS.md", status: "M", lines: { added: 2, deleted: 1 } },
        { path: "docs/заметка с пробелом.md", status: "A", lines: { added: 2, deleted: 0 } },
        { path: "logo.bin", status: "M", lines: null },
        { path: "odd\tname.txt", status: "A", lines: { added: 1, deleted: 0 } },
        { path: "src/new.ts", status: "R", orig: "old.ts", lines: { added: 1, deleted: 1 } },
      ],
    });
  });

  it("a clean merge answers with a header and no files", () => {
    const merge = `${RS}${meta.join(US)}${RS}\0\0`;
    expect(parseCommitDetail(merge)?.files).toEqual([]);
  });

  it("is null for what is not that answer", () => {
    expect(parseCommitDetail("")).toBeNull();
    expect(parseCommitDetail("fatal: bad object abc123")).toBeNull();
    expect(parseCommitDetail(`${RS}only one fence`)).toBeNull();
    expect(parseCommitDetail(`${RS}too${US}few${RS}`)).toBeNull();
  });

  it("an unreadable commit time is zero, not NaN", () => {
    const odd = `${RS}a${US}b${US}c${US}d${US}e${US}soon${RS}`;
    expect(parseCommitDetail(odd)?.committed).toBe(0);
  });
});

describe("parseRawNumstatZ", () => {
  it("reads a merge's `git diff -z --raw --numstat`: status from the raw records, counts by path", () => {
    expect(
      parseRawNumstatZ(
        ":100644 100644 a1 b2 M\0a.ts\0:100644 000000 c3 0000000 D\0gone.ts\0:100644 100644 d4 e5 C075\0base.ts\0copy.ts\0" +
          "3\t0\ta.ts\0" +
          "0\t12\tgone.ts\0" +
          "4\t1\t\0base.ts\0copy.ts\0",
      ),
    ).toEqual([
      { path: "a.ts", status: "M", lines: { added: 3, deleted: 0 } },
      { path: "gone.ts", status: "D", lines: { added: 0, deleted: 12 } },
      { path: "copy.ts", status: "C", orig: "base.ts", lines: { added: 4, deleted: 1 } },
    ]);
  });
  it("keeps a name with a tab or a line break whole, in the record and in the count", () => {
    expect(parseRawNumstatZ(":000000 100644 0 f A\0odd\tname\nhere.txt\x001\t0\todd\tname\nhere.txt\0")).toEqual([
      { path: "odd\tname\nhere.txt", status: "A", lines: { added: 1, deleted: 0 } },
    ]);
  });
  it("gives a file git printed no count for no count, not a zero", () => {
    expect(parseRawNumstatZ(":100644 100644 a b M\0a.ts\0")).toEqual([{ path: "a.ts", status: "M" }]);
  });
  it("is empty for nothing, and drops a record cut short", () => {
    expect(parseRawNumstatZ("")).toEqual([]);
    expect(parseRawNumstatZ("\0\0")).toEqual([]);
    expect(parseRawNumstatZ(":100644 100644 a b M\0a.ts\0:100644 100644 c d R100\0old.ts")).toEqual([
      { path: "a.ts", status: "M" },
    ]);
    expect(parseRawNumstatZ(":100644 100644 a b M\0a.ts\0:100644 100644 c d D")).toEqual([
      { path: "a.ts", status: "M" },
    ]);
    expect(parseRawNumstatZ(":100644 100644 a b R100\0old.ts\0new.ts\x001\t1\t\0old.ts")).toEqual([
      { path: "new.ts", status: "R", orig: "old.ts" },
    ]);
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
    // Unstage keeps the edits in the working tree.
    expect(isDestructive(["restore", "--staged", "--", "f"])).toBe(false);
    expect(isDestructive(["restore", "--staged", "--worktree", "--", "f"])).toBe(true);
    expect(isDestructive(["merge", "dev"])).toBe(true);
    expect(isDestructive(["rebase", "dev"])).toBe(true);
    expect(isDestructive(["stash", "drop", "stash@{0}"])).toBe(true);
    expect(isDestructive(["stash", "list"])).toBe(false);
    expect(isDestructive(["checkout", "-f", "main"])).toBe(true);
    expect(isDestructive(["checkout", "main"])).toBe(false);
    expect(isDestructive(["status"])).toBe(false);
  });
});

describe("formatGitCommand", () => {
  it("quotes arguments that would split, leaves the rest bare", () => {
    expect(git.formatGitCommand(["checkout", "main"])).toBe("git checkout main");
    expect(git.formatGitCommand(git.commitArgs('fix "x" now'))).toBe('git commit -m "fix \\"x\\" now"');
    expect(git.formatGitCommand(["commit", "-m", ""])).toBe('git commit -m ""');
  });
});

describe("needsConfirm", () => {
  it("confirms everything that moves HEAD, rewrites history, hits the remote or drops work", () => {
    for (const args of [
      git.checkoutArgs("main"),
      git.checkoutCommitArgs("abc123"),
      ["switch", "main"],
      git.commitArgs("msg"),
      git.pushArgs(),
      git.pullArgs(),
      git.mergeArgs("dev"),
      git.rebaseArgs("dev"),
      git.resetArgs("abc123", "soft"),
      git.resetArgs("abc123", "mixed"),
      git.resetArgs("abc123", "hard"),
      git.revertArgs("abc123"),
      git.cherryPickArgs("abc123"),
      git.renameBranchArgs("a", "b"),
      git.deleteBranchArgs("a"),
      git.stashApplyArgs(0),
      git.stashPopArgs(0),
      git.stashDropArgs(0),
      git.discardArgs(["f"]),
      git.cleanArgs(["f"]),
      git.discardAllArgs(),
      ["tag", "-d", "v1"],
    ]) {
      expect(needsConfirm(args), args.join(" ")).toBe(true);
    }
  });

  it("leaves cheap, trivially undone ops alone", () => {
    for (const args of [
      git.stageArgs(["f"]),
      git.unstageArgs(["f"]),
      git.stageAllArgs(),
      git.unstageAllArgs(),
      git.fetchArgs(),
      git.createBranchArgs("feat"),
      git.createBranchArgs("feat", "abc123"),
      ["switch", "-c", "feat"],
      git.tagArgs("v1", "abc123"),
      git.stashSaveArgs(),
      git.stashPushFileArgs("f"),
      git.setUpstreamArgs("main", "origin/main"),
      ["status"],
    ]) {
      expect(needsConfirm(args), args.join(" ")).toBe(false);
    }
  });

  it("is a superset of isDestructive", () => {
    for (const args of [["push", "--force"], ["branch", "-D", "x"], ["clean", "-f"]]) {
      expect(isDestructive(args)).toBe(true);
      expect(needsConfirm(args)).toBe(true);
    }
  });
});

describe("stagedDiffArgs (Phase 41)", () => {
  it("asks git for the staged diff with trimmed context", () => {
    // Context lines roughly double the tokens on a large diff without helping the
    // model describe the change.
    expect(stagedDiffArgs()).toEqual(["diff", "--no-color", "--cached", "-U1"]);
    expect(stagedDiffArgs(0)).toEqual(["diff", "--no-color", "--cached", "-U0"]);
  });

  it("never colours output, which would confuse the parser and the model", () => {
    expect(stagedDiffArgs()).toContain("--no-color");
  });
});
