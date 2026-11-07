// Pure git logic for the Git panel (Phase 29). Everything here is DOM/network
// free so it unit-tests cleanly: argument builders (what to run) and parsers
// (how to read the output). The backend (`git.rs` + `git_run`) is a dumb
// executor — this file owns the contract. See INVARIANTS ("чистая логика в .ts").
//
// Field/record separators for machine-readable git output:
//   US (0x1f) between fields; records are newline- or NUL-split. RS (0x1e)
//   fences the one header a command prints ahead of a file list (`commitDetailArgs`).

const US = "\x1f";
const RS = "\x1e";

// ── Argument builders ────────────────────────────────────────────────────────

/** `git rev-parse --show-toplevel` — absolute repo root, or non-zero if not a repo. */
export function repoRootArgs(): string[] {
  return ["rev-parse", "--show-toplevel"];
}

/** Porcelain v2 status with branch headers, NUL-delimited (robust to spaces). */
export function statusArgs(): string[] {
  return ["status", "--porcelain=v2", "--branch", "-z"];
}

/** Commits one load of the history asks for, and how far "load more" may go. */
export const LOG_PAGE = 200;
export const LOG_CAP = 1000;

/** What the history is narrowed to. Each field is git's to apply, not a filter over loaded rows. */
export interface LogFilter {
  text: string;
  /** `text` is an extended regular expression, not a literal string. */
  regex: boolean;
  matchCase: boolean;
  /** A full ref (`refs/heads/x`); null is every ref. */
  branch: string | null;
  author: string | null;
  since: LogSince | null;
  path: string | null;
  /** Follow `path` through renames: the history of one file. */
  follow: boolean;
}

export type LogSince = "today" | "week" | "month" | "year";
export const LOG_SINCE: readonly LogSince[] = ["today", "week", "month", "year"];
// git's own date words, the same whatever the host's locale.
const SINCE_ARG: Record<LogSince, string> = {
  today: "midnight",
  week: "7.days.ago",
  month: "30.days.ago",
  year: "365.days.ago",
};

export const NO_FILTER: LogFilter = {
  text: "",
  regex: false,
  matchCase: false,
  branch: null,
  author: null,
  since: null,
  path: null,
  follow: false,
};

export const isFiltered = (f: LogFilter): boolean =>
  !!(f.text || f.branch || f.author || f.since || f.path);

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function filterArgs(f: LogFilter): string[] {
  const out: string[] = [];
  if (f.text) {
    out.push(`--grep=${f.text}`, f.regex ? "-E" : "-F");
    if (!f.matchCase) out.push("-i");
  }
  if (f.author) {
    // One pattern language per command: under `-E` a name like `bot[x]` is escaped.
    out.push(`--author=${f.text && f.regex ? escapeRegex(f.author) : f.author}`);
    if (!f.text) out.push("-F");
  }
  if (f.since) out.push(`--since=${SINCE_ARG[f.since]}`);
  if (f.path && f.follow) out.push("--follow");
  out.push(f.branch ?? "--all");
  if (f.path) out.push("--", f.path);
  return out;
}

// NUL-separated records (`-z`), so the body (`%b`) can carry newlines safely;
// fields within a record are US-separated. `--decorate=full` names a ref in full:
// a branch, a remote branch and a tag are told apart by git, not by guessing.
const LOG_HEAD = [
  "log",
  "--no-color",
  "-z",
  "--decorate=full",
  `--pretty=format:%H${US}%h${US}%P${US}%an${US}%at${US}%cn${US}%D${US}%s${US}%b`,
];

/** Commit log for the graph: `limit` commits after the first `skip`, narrowed by `filter`. */
export function logArgs(limit = LOG_PAGE, skip = 0, filter: LogFilter = NO_FILTER): string[] {
  const args = [...LOG_HEAD, "-n", String(limit)];
  if (skip > 0) args.push(`--skip=${skip}`);
  return [...args, ...filterArgs(filter)];
}

/** Whether a search could also name a commit: `--grep` reads messages, never hashes. */
export const looksLikeHash = (text: string): boolean => /^[0-9a-f]{4,40}$/i.test(text);

/** The one commit a hash-shaped search names; a non-zero exit means it names none. */
export function hashLookupArgs(hash: string): string[] {
  return [...LOG_HEAD, "-n", "1", hash, "--"];
}

/**
 * Branch list (local + remote) with metadata; fields NUL-separated. `worktree`
 * asks where each branch is checked out — a field git learned in 2.23: on an older
 * host the whole command fails, and the panel asks again without it.
 */
export function branchesArgs(worktree = true): string[] {
  const fields = [
    "%(HEAD)",
    "%(refname)",
    "%(objectname:short)",
    "%(upstream:short)",
    "%(contents:subject)",
    "%(upstream:trackshort)",
    "%(upstream:track,nobracket)",
    "%(committerdate:unix)",
  ];
  if (worktree) fields.push("%(worktreepath)");
  return ["branch", "-a", "--no-color", `--format=${fields.join("%00")}`];
}

/** Tags, newest first. `%(*objectname)` is the commit an annotated tag points at. */
export function tagsArgs(): string[] {
  return [
    "tag",
    "--list",
    "--sort=-creatordate",
    "--format=%(refname:short)%00%(objectname:short)%00%(*objectname:short)",
  ];
}

/** The branches a commit is on (full refs: a branch is never mistaken for a tag). */
export function branchContainsArgs(hash: string): string[] {
  return ["branch", "-a", "--no-color", "--contains", hash, "--format=%(refname)"];
}

/**
 * Fast-forward a branch that is not checked out from its upstream, or null when it
 * has none. No `+` in the refspec: a branch that diverged is refused, not moved.
 */
export function updateBranchArgs(branch: Pick<GitBranch, "name" | "upstream">): string[] | null {
  const at = branch.upstream?.indexOf("/") ?? -1;
  if (!branch.upstream || at <= 0) return null;
  return ["fetch", branch.upstream.slice(0, at), `${branch.upstream.slice(at + 1)}:${branch.name}`];
}

export function stageArgs(paths: string[]): string[] {
  return ["add", "--", ...paths];
}

/** Stage everything (tracked changes + untracked + deletions). */
export function stageAllArgs(): string[] {
  return ["add", "-A"];
}

/** Unstage everything (mixed reset of the index to HEAD). */
export function unstageAllArgs(): string[] {
  return ["reset", "-q"];
}

export function unstageArgs(paths: string[]): string[] {
  return ["restore", "--staged", "--", ...paths];
}

/** Discard working-tree changes for tracked paths (destructive). */
export function discardArgs(paths: string[]): string[] {
  return ["restore", "--", ...paths];
}

/** Remove untracked files (destructive) — `restore` can't touch them. */
export function cleanArgs(paths: string[]): string[] {
  return ["clean", "-f", "--", ...paths];
}

/**
 * Fully discard one file's changes (destructive): untracked → remove it;
 * tracked → restore both index and working tree to HEAD. Used by the
 * uncommitted-changes dialog to revert a single blocking file.
 */
export function discardFileArgs(file: Pick<GitFile, "path" | "index">): string[] {
  return file.index === "?"
    ? ["clean", "-f", "--", file.path]
    : ["checkout", "HEAD", "--", file.path];
}

/** Discard every tracked change (staged + working tree) — `reset --hard`. */
export function discardAllArgs(): string[] {
  return ["reset", "--hard"];
}

export function commitArgs(message: string): string[] {
  return ["commit", "-m", message];
}

export function checkoutArgs(name: string): string[] {
  return ["checkout", name];
}

export function createBranchArgs(name: string, from?: string): string[] {
  return from ? ["checkout", "-b", name, from] : ["checkout", "-b", name];
}

export function deleteBranchArgs(name: string, force = false): string[] {
  return ["branch", force ? "-D" : "-d", name];
}

export function renameBranchArgs(oldName: string, newName: string): string[] {
  return ["branch", "-m", oldName, newName];
}

export function mergeArgs(name: string): string[] {
  return ["merge", name];
}

/** Rebase the current branch onto `name`. */
export function rebaseArgs(name: string): string[] {
  return ["rebase", name];
}

/** Set `branch`'s upstream to `upstream` (e.g. `origin/feature`). */
export function setUpstreamArgs(branch: string, upstream: string): string[] {
  return ["branch", `--set-upstream-to=${upstream}`, branch];
}

/** Diff of what `branch` has relative to `base` (read-only comparison). */
export function compareBranchesArgs(base: string, branch: string): string[] {
  return ["diff", "--no-color", base, branch];
}

/** Detached checkout of a specific commit (context menu). */
export function checkoutCommitArgs(hash: string): string[] {
  return ["checkout", hash];
}

export type ResetMode = "soft" | "mixed" | "hard";
export function resetArgs(hash: string, mode: ResetMode): string[] {
  return ["reset", `--${mode}`, hash];
}

export function cherryPickArgs(hash: string): string[] {
  return ["cherry-pick", hash];
}

export function revertArgs(hash: string): string[] {
  return ["revert", "--no-edit", hash];
}

export function tagArgs(name: string, hash: string): string[] {
  return ["tag", name, hash];
}

/** Diff a commit against the current working tree. */
export function diffCommitWorkingArgs(hash: string): string[] {
  return ["diff", "--no-color", hash];
}

export function remoteUrlArgs(): string[] {
  return ["remote", "get-url", "origin"];
}

export function fetchArgs(): string[] {
  return ["fetch", "--all", "--prune"];
}

export function pullArgs(): string[] {
  return ["pull", "--ff-only"];
}

export function pushArgs(opts: { force?: boolean; setUpstream?: boolean; branch?: string } = {}): string[] {
  const args = ["push"];
  if (opts.force) args.push("--force-with-lease");
  if (opts.setUpstream && opts.branch) args.push("--set-upstream", "origin", opts.branch);
  return args;
}

export function stashSaveArgs(message?: string): string[] {
  return message ? ["stash", "push", "-m", message] : ["stash", "push"];
}

/** Stash the changes of a single file (`git stash push -- <path>`). */
export function stashPushFileArgs(path: string): string[] {
  return ["stash", "push", "--", path];
}

export function stashListArgs(): string[] {
  return ["stash", "list", `--format=%gd${US}%s`];
}

export function stashApplyArgs(index: number): string[] {
  return ["stash", "apply", `stash@{${index}}`];
}

export function stashPopArgs(index: number): string[] {
  return ["stash", "pop", `stash@{${index}}`];
}

export function stashDropArgs(index: number): string[] {
  return ["stash", "drop", `stash@{${index}}`];
}

/** name-status of the files captured in a stash entry. */
export function stashFilesArgs(index: number): string[] {
  return ["stash", "show", "--name-status", `stash@{${index}}`];
}

/**
 * Unified diff of one file inside a stash. `git stash show -p` rejects a
 * pathspec ("Too many revisions"), so diff the stash against its base commit
 * (`stash@{N}^1..stash@{N}`) with the pathspec instead — same content.
 */
export function stashFileDiffArgs(index: number, path: string): string[] {
  return ["diff", "--no-color", `stash@{${index}}^1`, `stash@{${index}}`, "--", path];
}

/** Unified diff for one path — staged (`--cached`) or working-tree. */
export function diffFileArgs(path: string, staged: boolean): string[] {
  const args = ["diff", "--no-color"];
  if (staged) args.push("--cached");
  return [...args, "--", path];
}

/**
 * The whole staged diff (`git diff --cached`), for drafting a commit message.
 *
 * `-U…` trims the context lines: a model needs the changed hunks, and the default
 * three lines either side roughly doubles the tokens on a large diff for nothing.
 */
export function stagedDiffArgs(contextLines = 1): string[] {
  return ["diff", "--no-color", "--cached", `-U${contextLines}`];
}

/** Unified diff of one path at a commit (against its first parent). */
export function showFileArgs(hash: string, path: string): string[] {
  return ["show", "--no-color", "--format=", hash, "--", path];
}

/** The whole diff of a commit; a merge's is against its first parent, as its file list is. */
export function commitDiffArgs(hash: string, merge: boolean): string[] {
  return merge
    ? ["diff", "--no-color", `${hash}^1`, hash]
    : ["show", "--no-color", "--format=", hash];
}

/**
 * The full content of a file at a revision (`git show <ref>:<path>`). Used as the
 * diff base for the editable inline diff in the editor; a non-zero exit (file
 * absent at that ref, e.g. untracked) means an empty base.
 */
export function showFileAtArgs(ref: string, path: string): string[] {
  return ["show", `${ref}:${path}`];
}

/** name-status of a commit — which files it touched and how. */
export function commitFilesArgs(hash: string): string[] {
  return ["show", "--no-color", "--name-status", "--format=", hash];
}

/**
 * One commit for the details pane, in one call: who wrote it and who applied
 * it, fenced by RS, then the files it touched with their line counts. `-z` ends
 * every path with NUL and leaves it as it is — without it git quotes a non-ASCII
 * name into octal escapes (`"\320\267…"`), and a tab or a newline in a name
 * breaks the row. `--raw` and not `--name-status`: git drops `--numstat` next to
 * `--name-status`, while the raw records and the counts are printed together.
 */
export function commitDetailArgs(hash: string): string[] {
  return [
    "show",
    "-z",
    "--no-color",
    "--raw",
    "--numstat",
    `--format=${RS}%an${US}%ae${US}%at${US}%cn${US}%ce${US}%ct${RS}`,
    hash,
  ];
}

/**
 * What a merge brought into the branch: its diff against the first parent.
 * `git show` lists a merge's files only where the result differs from *both*
 * parents — nothing, for a clean merge — and what `-m`/`--first-parent` do to
 * that changed between git versions; a diff of two named commits reads the
 * same everywhere.
 */
export function mergeFilesArgs(hash: string): string[] {
  return ["diff", "-z", "--no-color", "--raw", "--numstat", `${hash}^1`, hash];
}

/** One file of that list: what the merge changed in it, against the first parent. */
export function mergeFileDiffArgs(hash: string, path: string): string[] {
  return ["diff", "--no-color", `${hash}^1`, hash, "--", path];
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitFile {
  path: string;
  /** Rename/copy origin path, when the entry is a rename/copy. */
  orig?: string;
  /** Index (staged) status char: M A D R C or '.' (none), '?' untracked, 'u' unmerged. */
  index: string;
  /** Work-tree (unstaged) status char. */
  work: string;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** true when `# branch.oid (initial)` — no commits yet. */
  initial: boolean;
  files: GitFile[];
}

/** What a ref on a commit is: `head` is the branch checked out, HEAD's target. */
export type GitRefKind = "head" | "local" | "remote" | "tag";

export interface GitRef {
  kind: GitRefKind;
  /** `main`, `origin/main`, `v1.2` — short, as the rest of the panel shows it. */
  name: string;
}

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  /** Who applied it: someone else after a rebase, a cherry-pick, a merge on a forge. */
  committer: string;
  timestamp: number;
  /** The branches and tags on it, as git names them. */
  refs: GitRef[];
  subject: string;
  /** Commit message body (everything after the subject), trimmed; may be empty. */
  body: string;
  /** This commit is the current HEAD (its decoration carried `HEAD`). */
  head: boolean;
}

export interface GitBranch {
  /** Short display name (e.g. `main`, `origin/main`). */
  name: string;
  fullRef: string;
  current: boolean;
  short: string;
  upstream: string | null;
  subject: string;
  remote: boolean;
  /** Against the upstream; null when there is none or git did not say. */
  track: BranchTrack | null;
  /** Its last commit, unix seconds; 0 when git did not say. */
  date: number;
  /** Where it is checked out, when it is; null also on a git too old to say. */
  worktree: string | null;
}

/** A branch against its upstream. `gone`: the upstream is configured and no longer exists. */
export interface BranchTrack {
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface GitTag {
  name: string;
  /** The commit it points at (the tag's own object for a lightweight one is that commit). */
  short: string;
}

export interface GitStashEntry {
  index: number;
  ref: string;
  subject: string;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/** Parse `git status --porcelain=v2 --branch -z` output. */
export function parseStatus(raw: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    initial: false,
    files: [],
  };
  // NUL-delimited records; rename entries consume an extra origin record.
  const toks = raw.split("\0");
  for (let i = 0; i < toks.length; i++) {
    const line = toks[i];
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      status.branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.oid ")) {
      status.initial = line.endsWith("(initial)");
    } else if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice("# branch.upstream ".length) || null;
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (line.startsWith("1 ")) {
      const xy = line.slice(2, 4);
      status.files.push({ path: fieldPath(line, 8), index: xy[0], work: xy[1] });
    } else if (line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      const path = fieldPath(line, 9);
      const orig = toks[i + 1] ?? "";
      i++; // consume the origin-path record
      status.files.push({ path, orig, index: xy[0], work: xy[1] });
    } else if (line.startsWith("u ")) {
      const xy = line.slice(2, 4);
      status.files.push({ path: fieldPath(line, 10), index: xy[0], work: xy[1] });
    } else if (line.startsWith("? ")) {
      status.files.push({ path: line.slice(2), index: "?", work: "?" });
    }
    // "! " ignored entries are skipped.
  }
  return status;
}

/** Extract the path field of a porcelain-v2 entry: everything after the Nth space. */
function fieldPath(line: string, skipFields: number): string {
  let idx = 0;
  for (let n = 0; n < skipFields; n++) {
    idx = line.indexOf(" ", idx);
    if (idx === -1) return "";
    idx++;
  }
  return line.slice(idx);
}

/** Files staged in the index (X status present). */
export function stagedFiles(files: GitFile[]): GitFile[] {
  return files.filter((f) => f.index !== "." && f.index !== "?");
}

/** Files with working-tree changes or untracked (Y status present). */
export function unstagedFiles(files: GitFile[]): GitFile[] {
  return files.filter((f) => f.work !== ".");
}

/**
 * The refs of one `%D` decoration (`--decorate=full`). A ref that is neither a
 * branch nor a tag (`refs/stash`) is not a label, and neither is `origin/HEAD`.
 * A short name — no `refs/` at all — is read as a local branch.
 */
export function parseDecoration(decoration: string): { refs: GitRef[]; head: boolean } {
  const refs: GitRef[] = [];
  let head = false;
  for (const raw of decoration.split(",").map((r) => r.trim()).filter(Boolean)) {
    if (raw === "HEAD") {
      head = true;
      continue;
    }
    const isHead = raw.startsWith("HEAD -> ");
    head ||= isHead;
    const ref = raw.replace(/^HEAD -> /, "").replace(/^tag: /, "");
    if (ref.startsWith("refs/tags/") || raw.startsWith("tag: ")) {
      refs.push({ kind: "tag", name: ref.replace(/^refs\/tags\//, "") });
    } else if (ref.startsWith("refs/remotes/")) {
      if (!ref.endsWith("/HEAD")) refs.push({ kind: "remote", name: ref.slice("refs/remotes/".length) });
    } else if (ref.startsWith("refs/heads/") || !ref.startsWith("refs/")) {
      refs.push({ kind: isHead ? "head" : "local", name: ref.replace(/^refs\/heads\//, "") });
    }
  }
  return { refs, head };
}

/** Parse the machine-readable `git log` output from {@link logArgs}. */
export function parseLog(raw: string): GitCommit[] {
  const out: GitCommit[] = [];
  for (const line of raw.split("\0")) {
    if (!line) continue;
    const f = line.split(US);
    if (f.length < 8) continue;
    out.push({
      hash: f[0],
      short: f[1],
      parents: f[2] ? f[2].split(" ").filter(Boolean) : [],
      author: f[3],
      timestamp: Number(f[4]) || 0,
      committer: f[5],
      ...parseDecoration(f[6] ?? ""),
      subject: f[7],
      body: (f.slice(8).join(US) ?? "").trim(),
    });
  }
  return out;
}

/** Parse `git branch -a --format=…` (NUL-separated fields). */
export function parseBranches(raw: string): GitBranch[] {
  const out: GitBranch[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [head, fullRef, short, upstream, subject, trackShort, track, date, worktree] = line.split("\0");
    if (!fullRef) continue;
    // Skip the `origin/HEAD -> origin/main` symbolic pointer.
    if (short === "" && fullRef.endsWith("/HEAD")) continue;
    const remote = fullRef.startsWith("refs/remotes/");
    const name = fullRef.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
    if (remote && name.endsWith("/HEAD")) continue;
    out.push({
      name,
      fullRef,
      current: head === "*",
      short: short ?? "",
      upstream: upstream || null,
      subject: subject ?? "",
      remote,
      track: parseTrack(trackShort ?? "", track ?? ""),
      date: Number(date) || 0,
      worktree: worktree || null,
    });
  }
  return out;
}

/**
 * `%(upstream:trackshort)` and `%(upstream:track,nobracket)` read together: the
 * words of the long form are translated by the host's locale, so only its numbers
 * are taken, and the short form says which is which.
 */
function parseTrack(short: string, track: string): BranchTrack | null {
  const n = (track.match(/\d+/g) ?? []).map(Number);
  if (short === ">") return { ahead: n[0] ?? 0, behind: 0, gone: false };
  if (short === "<") return { ahead: 0, behind: n[0] ?? 0, gone: false };
  if (short === "<>") return { ahead: n[0] ?? 0, behind: n[1] ?? 0, gone: false };
  if (short === "=") return { ahead: 0, behind: 0, gone: false };
  return track.trim() ? { ahead: 0, behind: 0, gone: true } : null;
}

/** Parse {@link tagsArgs}: the commit of an annotated tag wins over the tag's object. */
export function parseTags(raw: string): GitTag[] {
  const out: GitTag[] = [];
  for (const line of raw.split("\n")) {
    const [name, object, target] = line.split("\0");
    if (name) out.push({ name, short: target || object || "" });
  }
  return out;
}

/** Parse {@link branchContainsArgs}: short names, local before remote, no `origin/HEAD`. */
export function parseContains(raw: string): string[] {
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of raw.split("\n").map((l) => l.trim())) {
    if (ref.startsWith("refs/heads/")) local.push(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) remote.push(ref.slice("refs/remotes/".length));
  }
  return [...local, ...remote];
}

/** Parse `git stash list --format=%gd␟%s`. */
export function parseStashes(raw: string): GitStashEntry[] {
  const out: GitStashEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [ref, subject] = line.split(US);
    const m = ref?.match(/stash@\{(\d+)\}/);
    out.push({ index: m ? Number(m[1]) : out.length, ref: ref ?? "", subject: subject ?? "" });
  }
  return out;
}

export type DiffLineType = "add" | "del" | "ctx" | "hunk" | "meta";
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** Parse a unified diff into typed lines for the diff view. */
export function parseDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename ")) {
      out.push({ type: "meta", text: line });
    } else if (line.startsWith("@@")) {
      out.push({ type: "hunk", text: line });
    } else if (line.startsWith("+")) {
      out.push({ type: "add", text: line });
    } else if (line.startsWith("-")) {
      out.push({ type: "del", text: line });
    } else {
      out.push({ type: "ctx", text: line });
    }
  }
  // Trailing empty line from split — drop it.
  if (out.length && out[out.length - 1].text === "") out.pop();
  return out;
}

/** Lines a commit added to a file and took out of it, as `git --numstat` counts them. */
export interface LineCounts {
  added: number;
  deleted: number;
}

export interface CommitFile {
  path: string;
  /** name-status letter: A M D R C … */
  status: string;
  /** Where a renamed or copied file came from. */
  orig?: string;
  /** Its line counts; null for a binary file, which git does not count; absent when not asked. */
  lines?: LineCounts | null;
}

const NUMSTAT = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

/**
 * Parse a `-z --raw --numstat` listing. The raw records come first —
 * `:100644 100644 abc def M\0path\0`, a rename or a copy `…R080\0from\0to\0` —
 * and give the status; then the counts — `2\t1\tpath\0`, a rename
 * `1\t1\t\0from\0to\0`, a binary file `-\t-\tpath\0` — matched to them by path.
 * A listing cut short mid-record drops that record; a file git printed no count
 * for keeps none, rather than a made-up zero.
 */
export function parseRawNumstatZ(raw: string): CommitFile[] {
  const files: CommitFile[] = [];
  const counts = new Map<string, LineCounts | null>();
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    // The listing follows a header's line break; nothing else starts with one.
    const token = tokens[i].replace(/^\n+/, "");
    if (!token) continue;
    if (token.startsWith(":")) {
      const status = token.slice(token.lastIndexOf(" ") + 1)[0];
      if (status === "R" || status === "C") {
        const orig = tokens[i + 1];
        const path = tokens[i + 2];
        i += 2;
        if (orig && path) files.push({ path, status, orig });
      } else {
        const path = tokens[++i];
        if (status && path) files.push({ path, status });
      }
      continue;
    }
    const m = NUMSTAT.exec(token);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      // A rename's counts name it by both paths, in tokens of their own.
      i += 2;
      path = tokens[i] ?? "";
    }
    if (!path) continue;
    counts.set(path, m[1] === "-" || m[2] === "-" ? null : { added: Number(m[1]), deleted: Number(m[2]) });
  }
  return files.map((f) => (counts.has(f.path) ? { ...f, lines: counts.get(f.path) ?? null } : f));
}

/** What the details pane adds to a commit of the log. */
export interface CommitDetail {
  authorEmail: string;
  /** Who applied the commit — someone else after a rebase, a cherry-pick, `git am`. */
  committer: string;
  committerEmail: string;
  /** When it was applied, unix seconds; 0 when git did not say. */
  committed: number;
  files: CommitFile[];
}

/**
 * Parse the answer to `commitDetailArgs`. Null when it is not that answer (git
 * failed, or printed something else): the pane says so instead of showing a
 * commit with no author and no files.
 */
export function parseCommitDetail(raw: string): CommitDetail | null {
  const from = raw.indexOf(RS);
  const to = from < 0 ? -1 : raw.indexOf(RS, from + 1);
  if (to < 0) return null;
  const f = raw.slice(from + 1, to).split(US);
  if (f.length < 6) return null;
  return {
    authorEmail: f[1],
    committer: f[3],
    committerEmail: f[4],
    committed: Number(f[5]) || 0,
    files: parseRawNumstatZ(raw.slice(to + 1)),
  };
}

/** Parse `git show --name-status --format=` output for one commit. */
export function parseCommitFiles(raw: string): CommitFile[] {
  const out: CommitFile[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0][0];
    // Rename/copy rows are `R100\told\tnew` — the new path is what matters.
    const path = parts.length >= 3 ? parts[2] : parts[1];
    if (path) out.push({ path, status });
  }
  return out;
}

/**
 * Build a web URL to view a commit on the hosting service, from a git remote
 * URL. Handles `git@host:owner/repo(.git)` and `https://host/owner/repo(.git)`
 * (and `ssh://git@host[:port]/owner/repo`). Returns null when the remote isn't a
 * recognizable http(s)/ssh host. Pure — no network; the caller opens the URL.
 */
function remoteHostPath(remote: string): { host: string; path: string } | null {
  const r = remote.trim().replace(/\.git$/, "");
  if (!r) return null;
  let host: string;
  let path: string;
  const scp = r.match(/^[^/@]+@([^:]+):(.+)$/); // git@host:owner/repo
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    const m = r.match(/^(?:https?|ssh):\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
    if (!m) return null;
    host = m[1];
    path = m[2];
  }
  path = path.replace(/^\/+/, "");
  return host && path ? { host, path } : null;
}

export function commitWebUrl(remote: string, hash: string): string | null {
  const hp = remoteHostPath(remote);
  if (!hp) return null;
  // Bitbucket uses /commits/<sha>; GitHub/GitLab/Gitea use /commit/<sha>.
  const segment = /bitbucket/i.test(hp.host) ? "commits" : "commit";
  return `https://${hp.host}/${hp.path}/${segment}/${hash}`;
}

/** Web URL to view a branch on the hosting service (see {@link commitWebUrl}). */
export function branchWebUrl(remote: string, branch: string): string | null {
  const hp = remoteHostPath(remote);
  if (!hp) return null;
  // Bitbucket uses /branch/<name>; GitHub/GitLab/Gitea use /tree/<name>.
  const segment = /bitbucket/i.test(hp.host) ? "branch" : "tree";
  return `https://${hp.host}/${hp.path}/${segment}/${branch}`;
}

/**
 * Whether a failed git command was aborted because the working tree has
 * uncommitted changes that the operation would overwrite (checkout/switch,
 * merge, rebase, pull…). Lets the UI explain it and offer to stash + retry
 * instead of surfacing the raw multi-line English stderr. Pure — matches git's
 * canonical wording.
 */
export function isUncommittedChangesError(stderr: string): boolean {
  return (
    /would be overwritten by/i.test(stderr) ||
    /commit your changes or stash them/i.test(stderr) ||
    /Please commit your changes or stash/i.test(stderr) ||
    /overwritten by (checkout|merge|rebase)/i.test(stderr) ||
    /cannot .*with a dirty working tree/i.test(stderr)
  );
}

/**
 * Whether a failed network op (fetch/pull/push) couldn't reach the remote —
 * connection, DNS, auth, or host-key failure. Drives the warning-triangle badge
 * on the sync buttons. Pure — matches git/ssh's canonical wording.
 */
export function isRemoteConnectionError(stderr: string): boolean {
  return /could not read from remote repository|could not resolve host|connection (timed out|refused|reset)|network is unreachable|no route to host|unable to access|repository not found|authentication failed|permission denied \(publickey\)|host key verification failed|operation timed out/i.test(
    stderr,
  );
}

export interface SyncResult {
  /** Remote already had everything (nothing transferred). */
  upToDate: boolean;
  /** The `abc..def` object range git reported, when present. */
  range: string | null;
}

/** Extract a short summary from `git push`/`pull`/`fetch` output. */
export function parseSyncResult(output: string): SyncResult {
  const upToDate = /up[- ]to[- ]date/i.test(output);
  const m = output.match(/([0-9a-f]{7,40}\.\.[0-9a-f]{7,40})/);
  return { upToDate, range: m ? m[1] : null };
}

// ── Destructive-op classifier (prod confirmation) ────────────────────────────

/**
 * Whether an argument vector performs a destructive/irreversible action, so the
 * UI can require confirmation on prod-tagged servers. Bias: over-flag. This is a
 * safety net, not a security boundary (the prod gate + confirm dialog are).
 */
export function isDestructive(args: string[]): boolean {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "push":
      return rest.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease");
    case "branch":
      return rest.includes("-D") || rest.includes("-d") || rest.includes("--delete");
    case "reset":
      return rest.includes("--hard");
    case "checkout":
      return rest.includes("-f") || rest.includes("--force");
    case "restore":
      // Discarding working-tree changes. `--staged` alone only moves the index
      // back (unstage) — the edits stay in the working tree, nothing is lost.
      return !rest.includes("--staged") || rest.includes("--worktree") || rest.includes("-W");
    case "clean":
      return true;
    case "merge":
    case "rebase":
      return true;
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" || rest[0] === "pop";
    default:
      return false;
  }
}

/**
 * Whether an op asks for confirmation on ANY server (prod adds a red warning on
 * top). Wider than `isDestructive`: everything that moves HEAD, rewrites
 * history, touches the remote or drops work. Left out on purpose — cheap and
 * trivially undone: stage/unstage, fetch, creating a branch or tag, stash save,
 * setting an upstream. A confirm on every stage click would train the user to
 * click through the one that matters.
 */
export function needsConfirm(args: string[]): boolean {
  if (isDestructive(args)) return true;
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "checkout":
      // `checkout -b` creates a branch from the current HEAD — nothing to lose.
      return !rest.includes("-b");
    case "switch":
      return !rest.includes("-c") && !rest.includes("--create");
    case "reset":
      // A bare `reset -q` only unstages (index back to HEAD); a mode or a target
      // commit moves the branch.
      return rest.some((a) => !a.startsWith("-") || /^--(soft|mixed|hard|merge|keep)$/.test(a));
    case "commit":
    case "push":
    case "pull":
    case "revert":
    case "cherry-pick":
      return true;
    case "branch":
      return rest.includes("-m") || rest.includes("-M") || rest.includes("--move");
    case "stash":
      return rest[0] === "apply";
    case "tag":
      return rest.includes("-d") || rest.includes("--delete");
    default:
      return false;
  }
}

/** Options of the panel's mutating `run()` — shared by the Git sub-views. */
export interface GitRunOpts {
  /** Force a (red) confirmation even if `needsConfirm` wouldn't ask. */
  destructive?: boolean;
  /** Type the command into the terminal instead of running it captured. */
  echo?: boolean;
  successKey?: string;
  /** The user already confirmed this op (e.g. the second half of commit+push). */
  confirmed?: boolean;
  /** What the confirm dialog shows instead of the op's own command line. */
  confirmText?: string;
}

/**
 * A git argv as the user would type it — for showing in a confirm dialog, not
 * for executing (execution passes argv verbatim). Arguments with whitespace or
 * quotes get double quotes so a commit message reads as one argument.
 */
export function formatGitCommand(args: string[]): string {
  const q = (a: string) => (a === "" || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a);
  return ["git", ...args.map(q)].join(" ");
}
