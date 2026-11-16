// Git in the file panel's listing (ADR 0077): one `git status` of the folder
// shown — its branch, how far it is from upstream, and a letter by every
// entry that changed; what `.gitignore` hides is dimmed, a folder with changes
// inside gets a dot. Read through the Git driver (`git_run`, its policy), only
// while the panel is on screen; outside a repository git says so and the
// listing shows nothing.

/** The letter by an entry: modified, added, deleted, renamed, untracked, conflict; a dot — inside. */
export type GitMark = "M" | "A" | "D" | "R" | "U" | "C" | "•";

export interface ListingGit {
  branch: string | null;
  ahead: number;
  behind: number;
  /** How many paths under the folder changed (untracked included, ignored not). */
  changed: number;
  /** Entry name → its mark. */
  marks: Map<string, GitMark>;
  /** Entry names `.gitignore` hides. */
  ignored: Set<string>;
}

/** The status of the folder shown: porcelain v2, NUL-separated, ignored files too, limited to `.`. */
export const LISTING_STATUS_ARGS = ["status", "--porcelain=v2", "--branch", "-z", "--ignored", "--", "."];

/** Where the folder is inside its repository (`sub/dir/` or empty at the top). */
export const PREFIX_ARGS = ["rev-parse", "--show-prefix"];

function markOf(xy: string): GitMark {
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "C";
  const y = xy[1];
  const x = xy[0];
  const c = y !== "." ? y : x;
  switch (c) {
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
    case "C":
      return "R";
    default:
      return "M";
  }
}

/** The status of `git status --porcelain=v2 --branch -z --ignored`, for the folder at `prefix`. */
export function parseListingStatus(out: string, prefix: string): ListingGit {
  const res: ListingGit = { branch: null, ahead: 0, behind: 0, changed: 0, marks: new Map(), ignored: new Set() };
  const pre = prefix.replace(/\/?$/, prefix ? "/" : "");
  const recs = out.split("\0");
  const put = (path: string, mark: GitMark | "ignored") => {
    if (!path.startsWith(pre)) return;
    const rel = path.slice(pre.length).replace(/\/$/, "");
    if (rel === "") return;
    const slash = rel.indexOf("/");
    const name = slash < 0 ? rel : rel.slice(0, slash);
    if (mark === "ignored") {
      if (slash < 0) res.ignored.add(name);
      return;
    }
    res.changed++;
    if (slash >= 0) {
      if (!res.marks.has(name)) res.marks.set(name, "•");
      return;
    }
    res.marks.set(name, mark);
  };
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.startsWith("# branch.head ")) {
      const head = r.slice("# branch.head ".length);
      res.branch = head === "(detached)" ? null : head;
    } else if (r.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(r);
      if (m) {
        res.ahead = Number(m[1]);
        res.behind = Number(m[2]);
      }
    } else if (r.startsWith("1 ")) {
      const parts = r.split(" ");
      put(parts.slice(8).join(" "), markOf(parts[1]));
    } else if (r.startsWith("2 ")) {
      const parts = r.split(" ");
      put(parts.slice(9).join(" "), markOf(parts[1]));
      i++; // the original path follows as its own record
    } else if (r.startsWith("u ")) {
      const parts = r.split(" ");
      put(parts.slice(10).join(" "), "C");
    } else if (r.startsWith("? ")) {
      put(r.slice(2), "U");
    } else if (r.startsWith("! ")) {
      put(r.slice(2), "ignored");
    }
  }
  return res;
}

/** The theme tone of a mark. */
export function markTone(m: GitMark): "warn" | "ok" | "bad" {
  if (m === "A" || m === "U") return "ok";
  if (m === "D" || m === "C") return "bad";
  return "warn";
}
