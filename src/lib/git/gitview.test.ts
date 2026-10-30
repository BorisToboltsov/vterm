import { describe, expect, it } from "vitest";
import {
  clockTime,
  commitDay,
  commitMoment,
  commitTooltip,
  commitTree,
  commitTreeDirs,
  committerLine,
  fileStatusColor,
  gitAge,
  isLogWide,
  LOG_WIDE_REM,
} from "./gitview";
import { compactAge } from "../ui/age";
import type { CommitFile } from "./git";

describe("fileStatusColor", () => {
  it("maps status letters to the theme's status tokens", () => {
    expect(fileStatusColor("A")).toBe("text-ok");
    expect(fileStatusColor("?")).toBe("text-ok");
    expect(fileStatusColor("M")).toBe("text-accent");
    expect(fileStatusColor("D")).toBe("text-bad");
    expect(fileStatusColor("U")).toBe("text-bad");
    expect(fileStatusColor("R")).toBe("text-accent");
    expect(fileStatusColor("C")).toBe("text-accent");
    expect(fileStatusColor(".")).toBe("text-muted");
    expect(fileStatusColor("")).toBe("text-muted");
  });
  it("reads the letter of a scored status (R100)", () => {
    expect(fileStatusColor("R100")).toBe("text-accent");
  });
  it("hands out no fixed palette colour", () => {
    for (const s of ["A", "?", "M", "D", "U", "R", "C", ".", "", "X"]) {
      expect(fileStatusColor(s)).not.toMatch(/-\d{2,3}$/);
    }
  });
});

describe("commitDay", () => {
  const noon = new Date(2026, 9, 31, 12, 0).getTime();
  const at = (y: number, m: number, d: number, h = 0) => new Date(y, m, d, h).getTime() / 1000;
  it("names today and yesterday by the calendar, not by 24 hours", () => {
    expect(commitDay(at(2026, 9, 31, 0), noon)).toBe("today");
    expect(commitDay(at(2026, 9, 30, 23), noon)).toBe("yesterday");
    expect(commitDay(at(2026, 9, 30, 0), noon)).toBe("yesterday");
    expect(commitDay(at(2026, 9, 29, 23), noon)).toBeNull();
  });
  it("does not call a moment from the future today's", () => {
    expect(commitDay(at(2026, 10, 1, 1), noon)).toBeNull();
  });
});

describe("clockTime", () => {
  it("is the time of day of the same moment", () => {
    const ts = new Date(2026, 9, 7, 14, 3).getTime() / 1000;
    expect(clockTime(ts)).toBe("14:03");
    expect(commitMoment(ts)).toBe("2026-10-07 14:03");
  });
});

describe("isLogWide", () => {
  it("has a threshold of its own, under the panel's", () => {
    expect(LOG_WIDE_REM).toBeLessThan(48);
    expect(isLogWide(575)).toBe(false);
    expect(isLogWide(576)).toBe(true);
    expect(isLogWide(720, 20)).toBe(true);
  });
  it("is narrow for a width it cannot read", () => {
    expect(isLogWide(Number.NaN)).toBe(false);
    expect(isLogWide(0)).toBe(false);
    expect(isLogWide(1000, 0)).toBe(false);
  });
});

describe("commitTooltip", () => {
  const now = 1_700_000_000_000;
  const base = { subject: "Fix bug", author: "Ann", short: "abc1234", timestamp: Math.floor(now / 1000) - 3600 };

  it("includes body when present, omits it otherwise", () => {
    const when = commitMoment(base.timestamp);
    const withBody = commitTooltip({ ...base, body: "Detail line one.\nLine two." }, now);
    expect(withBody).toBe(`Fix bug\n\nDetail line one.\nLine two.\n\n— Ann · ${when} · 1h · abc1234`);
    const noBody = commitTooltip({ ...base, body: "" }, now);
    expect(noBody).toBe(`Fix bug\n\n— Ann · ${when} · 1h · abc1234`);
  });
});

describe("committerLine", () => {
  const commit = { author: "Anna", timestamp: 1000 };
  const own = { authorEmail: "a@x", committer: "Anna", committerEmail: "a@x", committed: 1000 };

  it("says nothing when the author applied the commit as written", () => {
    expect(committerLine(commit, own)).toBeNull();
  });
  it("names another person", () => {
    expect(committerLine(commit, { ...own, committer: "Carl", committerEmail: "c@x" })).toEqual({
      who: "Carl",
      email: "c@x",
      at: 1000,
    });
  });
  it("tells the same name under another address apart", () => {
    expect(committerLine(commit, { ...own, committerEmail: "anna@work" })).not.toBeNull();
  });
  it("names another time — an amend or a rebase of one's own", () => {
    expect(committerLine(commit, { ...own, committed: 5000 })).toEqual({ who: "Anna", email: "a@x", at: 5000 });
  });
  it("a time git did not give is not another time", () => {
    expect(committerLine(commit, { ...own, committed: 0 })).toBeNull();
  });
});

describe("gitAge", () => {
  const now = 1_700_000_000_000;
  const ago = (s: number) => Math.floor(now / 1000) - s;

  it("is the age every other list row shows", () => {
    for (const secs of [10, 5 * 60, 3 * 3600 + 1200, 2 * 86400, 21 * 86400, 100 * 86400, 800 * 86400]) {
      expect(gitAge(ago(secs), now)).toBe(compactAge(ago(secs) * 1000, now));
    }
    expect(gitAge(ago(10), now)).toBe("10s");
    expect(gitAge(ago(3 * 3600 + 1200), now)).toBe("3h20m");
    expect(gitAge(ago(21 * 86400), now)).toBe("3w");
    expect(gitAge(ago(100 * 86400), now)).toBe("3mo");
    expect(gitAge(ago(800 * 86400), now)).toBe("2y");
  });
  it("clamps a commit from the future (clock skew) to zero", () => {
    expect(gitAge(ago(-100), now)).toBe("0s");
  });
});

describe("commitMoment", () => {
  it("is the long-iso moment of the file table, in local time", () => {
    const d = new Date(2026, 8, 2, 12, 55, 30);
    expect(commitMoment(Math.floor(d.getTime() / 1000))).toBe("2026-09-02 12:55");
  });
  it("is a dash when git gave no time", () => {
    expect(commitMoment(0)).toBe("—");
    expect(commitMoment(NaN)).toBe("—");
  });
});

describe("commitTree", () => {
  const f = (path: string, status = "M"): CommitFile => ({ path, status });
  /** The tree as indented text — one line a row. */
  const drawn = (files: CommitFile[], closed?: Set<string>) =>
    commitTree(files, closed).map((r) =>
      r.kind === "dir"
        ? `${"  ".repeat(r.depth)}${r.label}/ (${r.count})${r.open ? "" : " …"}`
        : `${"  ".repeat(r.depth)}${r.name} [${r.file.status}]`,
    );

  it("is empty for a commit with no files", () => {
    expect(commitTree([])).toEqual([]);
  });

  it("puts directories before files and sorts each level by name", () => {
    expect(drawn([f("b.md"), f("src/z.ts"), f("AGENTS.md"), f("src/a.ts"), f("docs/x.md")])).toEqual([
      "docs/ (1)",
      "  x.md [M]",
      "src/ (2)",
      "  a.ts [M]",
      "  z.ts [M]",
      "AGENTS.md [M]",
      "b.md [M]",
    ]);
  });

  it("folds a chain of directories that hold only the next one", () => {
    // The commit of the screenshot this was drawn from: two files, one deep.
    expect(drawn([f("docs/operations/linux-dev-oel.md"), f("AGENTS.md")])).toEqual([
      "docs/operations/ (1)",
      "  linux-dev-oel.md [M]",
      "AGENTS.md [M]",
    ]);
  });

  it("stops folding where a directory has a file or a second directory", () => {
    expect(drawn([f("a/b/c/x.ts"), f("a/b/y.ts"), f("a/b/d/e/z.ts")])).toEqual([
      "a/b/ (3)",
      "  c/ (1)",
      "    x.ts [M]",
      "  d/e/ (1)",
      "    z.ts [M]",
      "  y.ts [M]",
    ]);
  });

  it("counts the files under a directory at any depth", () => {
    const rows = commitTree([f("a/x"), f("a/b/y"), f("a/b/c/z"), f("q")]);
    expect(rows.find((r) => r.kind === "dir" && r.path === "a")).toMatchObject({ count: 3 });
    expect(rows.find((r) => r.kind === "dir" && r.path === "a/b")).toMatchObject({ count: 2 });
  });

  it("a closed directory keeps its row and its count, and shows nothing under it", () => {
    const files = [f("src/lib/a.ts"), f("src/lib/b.ts"), f("src/main.ts"), f("README.md")];
    expect(drawn(files, new Set(["src"]))).toEqual(["src/ (3) …", "README.md [M]"]);
    expect(drawn(files, new Set(["src/lib"]))).toEqual([
      "src/ (3)",
      "  lib/ (2) …",
      "  main.ts [M]",
      "README.md [M]",
    ]);
  });

  it("a folded chain is closed by the path of its last directory", () => {
    const files = [f("docs/operations/a.md"), f("docs/operations/b.md")];
    expect(commitTree(files)[0]).toMatchObject({ kind: "dir", path: "docs/operations" });
    expect(drawn(files, new Set(["docs/operations"]))).toEqual(["docs/operations/ (2) …"]);
    // The first directory of the chain is not a row, so it closes nothing.
    expect(drawn(files, new Set(["docs"]))).toHaveLength(3);
  });

  it("keeps the file it was given on its row — status, origin of a rename", () => {
    const renamed: CommitFile = { path: "src/new.ts", status: "R", orig: "src/old.ts" };
    const row = commitTree([renamed]).find((r) => r.kind === "file");
    expect(row).toMatchObject({ kind: "file", name: "new.ts", depth: 1 });
    expect(row?.kind === "file" && row.file).toBe(renamed);
  });

  it("every file appears exactly once while nothing is closed", () => {
    const files = ["a", "b/c", "b/d/e", "b/d/f", "g/h/i/j", "g/h/k", "z/y/x/w/v"].map((p) => f(p));
    const shown = commitTree(files).flatMap((r) => (r.kind === "file" ? [r.file.path] : []));
    expect(shown.sort()).toEqual(files.map((x) => x.path).sort());
  });

  it("does not trip on doubled or trailing slashes", () => {
    expect(drawn([f("a//b.ts"), f("dir/")])).toEqual(["a/ (1)", "  b.ts [M]", "dir [M]"]);
  });
});

describe("commitTreeDirs", () => {
  it("names every directory, folded chains under their full path", () => {
    const files: CommitFile[] = [
      { path: "a/b/c.ts", status: "M" },
      { path: "a/d/e.ts", status: "A" },
      { path: "x/y/z/f.ts", status: "D" },
      { path: "top.ts", status: "M" },
    ];
    expect([...commitTreeDirs(files)].sort()).toEqual(["a", "a/b", "a/d", "x/y/z"]);
  });
});
