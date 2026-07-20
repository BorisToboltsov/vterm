// Pure git logic for the Git panel (Phase 29). Everything here is DOM/network
// free so it unit-tests cleanly: argument builders (what to run) and parsers
// (how to read the output). The backend (`git.rs` + `git_run`) is a dumb
// executor — this file owns the contract. See INVARIANTS ("чистая логика в .ts").
//
// Field/record separators for machine-readable git output:
//   US (0x1f) between fields, RS (0x1e) is avoided — records are newline-split.

const US = "\x1f";

// ── Argument builders ────────────────────────────────────────────────────────

/** `git rev-parse --show-toplevel` — absolute repo root, or non-zero if not a repo. */
export function repoRootArgs(): string[] {
  return ["rev-parse", "--show-toplevel"];
}

/** Porcelain v2 status with branch headers, NUL-delimited (robust to spaces). */
export function statusArgs(): string[] {
  return ["status", "--porcelain=v2", "--branch", "-z"];
}

/**
 * Commit log for the graph. NUL-separated records (`-z`) so the body (`%b`) can
 * carry newlines safely; fields within a record are US-separated.
 */
export function logArgs(limit = 200): string[] {
  return [
    "log",
    "--no-color",
    "-z",
    `--pretty=format:%H${US}%h${US}%P${US}%an${US}%at${US}%D${US}%s${US}%b`,
    "-n",
    String(limit),
    "--all",
  ];
}

/** Branch list (local + remote) with metadata; fields NUL-separated. */
export function branchesArgs(): string[] {
  return [
    "branch",
    "-a",
    "--no-color",
    "--format=%(HEAD)%00%(refname)%00%(objectname:short)%00%(upstream:short)%00%(contents:subject)",
  ];
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

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  timestamp: number;
  /** Decoration ref names (HEAD, branch, tag, origin/…). */
  refs: string[];
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

/** Parse the machine-readable `git log` output from {@link logArgs}. */
export function parseLog(raw: string): GitCommit[] {
  const out: GitCommit[] = [];
  for (const line of raw.split("\0")) {
    if (!line) continue;
    const f = line.split(US);
    if (f.length < 7) continue;
    const decoration = f[5] ?? "";
    out.push({
      hash: f[0],
      short: f[1],
      parents: f[2] ? f[2].split(" ").filter(Boolean) : [],
      author: f[3],
      timestamp: Number(f[4]) || 0,
      refs: decoration
        ? decoration
            .split(",")
            .map((r) => r.trim().replace(/^HEAD -> /, "").replace(/^tag: /, ""))
            .filter((r) => r && r !== "HEAD")
        : [],
      subject: f[6],
      body: (f.slice(7).join(US) ?? "").trim(),
      head: /\bHEAD\b/.test(decoration),
    });
  }
  return out;
}

/** Parse `git branch -a --format=…` (NUL-separated fields). */
export function parseBranches(raw: string): GitBranch[] {
  const out: GitBranch[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [head, fullRef, short, upstream, subject] = line.split("\0");
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
    });
  }
  return out;
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

export interface CommitFile {
  path: string;
  /** name-status letter: A M D R C … */
  status: string;
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
      // Discarding working-tree or staged changes.
      return true;
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

// ── Graph layout ─────────────────────────────────────────────────────────────

export interface GraphSegment {
  /** Lane index at the top edge of the row band. */
  from: number;
  /** Lane index at the bottom edge (or at the node for merge-ins). */
  to: number;
  color: string;
  /** 'through' full-height · 'out' node→parent (lower half) · 'in' lane→node (upper half). */
  kind: "through" | "out" | "in";
}

export interface GraphRow {
  commit: GitCommit;
  /** Node lane index within this row. */
  col: number;
  color: string;
  /** Max lane count spanning this row (for width). */
  lanes: number;
  segments: GraphSegment[];
}

/** Distinct, dark-mode-friendly rail colors, cycled by lane index. */
export const RAIL_COLORS = [
  "#4aa3ff",
  "#3ecf8e",
  "#e8a13a",
  "#c678dd",
  "#e06c9a",
  "#56b6c2",
  "#d19a66",
  "#98c379",
];

export function railColor(col: number): string {
  return RAIL_COLORS[((col % RAIL_COLORS.length) + RAIL_COLORS.length) % RAIL_COLORS.length];
}

/**
 * Assign each commit to a lane and emit per-row rail segments, producing a
 * GitKraken-style multi-lane graph. Commits must be in log order (newest first).
 *
 * The frontier is a compact array of "hash expected next" per lane. For each
 * commit we find its lane (or open a fresh one), route passing lanes forward,
 * fold converging lanes into the node, and open lanes for the commit's parents.
 */
export function buildGraph(commits: GitCommit[]): GraphRow[] {
  const rows: GraphRow[] = [];
  let frontier: string[] = [];

  for (const commit of commits) {
    let myCol = frontier.indexOf(commit.hash);
    const existed = myCol !== -1;
    if (!existed) {
      myCol = frontier.length;
      frontier = [...frontier, commit.hash];
    }
    const inLanes = frontier.slice();
    const out: string[] = [];
    const segments: GraphSegment[] = [];

    // Not a fresh tip → a child above feeds this node: draw the upper-half stub
    // so the node connects to the rail arriving from the previous row.
    if (existed) {
      segments.push({ from: myCol, to: myCol, color: railColor(myCol), kind: "in" });
    }

    // Route every incoming lane except the node's own lane.
    for (let k = 0; k < inLanes.length; k++) {
      if (k === myCol) continue;
      if (inLanes[k] === commit.hash) {
        // A branch merging back into this commit — draw into the node.
        segments.push({ from: k, to: myCol, color: railColor(k), kind: "in" });
        continue;
      }
      let oi = out.indexOf(inLanes[k]);
      if (oi === -1) {
        oi = out.length;
        out.push(inLanes[k]);
      }
      segments.push({ from: k, to: oi, color: railColor(oi), kind: "through" });
    }

    // Open lanes for this commit's parents and draw node→parent segments.
    for (const p of commit.parents) {
      let oi = out.indexOf(p);
      if (oi === -1) {
        oi = out.length;
        out.push(p);
      }
      segments.push({ from: myCol, to: oi, color: railColor(oi), kind: "out" });
    }

    rows.push({
      commit,
      col: myCol,
      color: railColor(myCol),
      lanes: Math.max(inLanes.length, out.length),
      segments,
    });
    frontier = out;
  }

  return rows;
}
