import { describe, expect, it } from "vitest";
import {
  progressWeight,
  planFolders,
  filterPlan,
  matchesFilter,
  planFacts,
  emptyPlanReason,
  wipesTarget,
  syncBlockReasons,
  syncErrorView,
  pickerDirs,
  compileExclude,
  parseExcludes,
  diffTrees,
  applicable,
  summarize,
  syncTransferId,
  syncRowStatus,
  syncRowPct,
  syncRunSummary,
  type HashEntry,
  type SyncAction,
  type SyncProgressMap,
} from "./sync";

const h = (path: string, sha256: string): HashEntry => ({ path, sha256 });

describe("compileExclude", () => {
  it("matches a bare name against any path segment", () => {
    const ex = compileExclude([".git"]);
    expect(ex(".git")).toBe(true);
    expect(ex("a/.git/config")).toBe(true);
    expect(ex("src/app.ts")).toBe(false);
  });

  it("supports glob wildcards on a segment", () => {
    const ex = compileExclude(["*.tfstate"]);
    expect(ex("terraform.tfstate")).toBe(true);
    expect(ex("env/prod.tfstate")).toBe(true);
    expect(ex("main.tf")).toBe(false);
  });

  it("matches a path-anchored pattern and everything under it", () => {
    const ex = compileExclude(["build/dist"]);
    expect(ex("build/dist")).toBe(true);
    expect(ex("build/dist/app.js")).toBe(true);
    expect(ex("build/other")).toBe(false);
  });

  it("ignores blank patterns (empty list excludes nothing)", () => {
    const ex = compileExclude(["", "   "]);
    expect(ex("anything")).toBe(false);
  });
});

describe("parseExcludes", () => {
  it("splits on newlines and commas, trimming blanks", () => {
    expect(parseExcludes(".git, *.log\nnode_modules\n\n")).toEqual([
      ".git",
      "*.log",
      "node_modules",
    ]);
  });
});

describe("diffTrees", () => {
  const local = [h("same.txt", "aa"), h("changed.txt", "L1"), h("only-local.txt", "x")];
  const remote = [h("same.txt", "aa"), h("changed.txt", "R1"), h("only-remote.txt", "y")];

  it("push: upload new + changed; identical skipped; extraneous only with the flag", () => {
    const plan = diffTrees(local, remote, "push", [], false);
    expect(plan).toEqual([
      { path: "changed.txt", op: "upload", reason: "changed" },
      { path: "only-local.txt", op: "upload", reason: "new" },
    ]);
    const withDel = diffTrees(local, remote, "push", [], true);
    expect(withDel).toContainEqual({ path: "only-remote.txt", op: "deleteRemote", reason: "removed" });
  });

  it("pull: download new + changed; extraneous local deleted only with the flag", () => {
    const plan = diffTrees(local, remote, "pull", [], false);
    expect(plan).toEqual([
      { path: "changed.txt", op: "download", reason: "changed" },
      { path: "only-remote.txt", op: "download", reason: "new" },
    ]);
    const withDel = diffTrees(local, remote, "pull", [], true);
    expect(withDel).toContainEqual({ path: "only-local.txt", op: "deleteLocal", reason: "removed" });
  });

  it("bi: adds missing on both sides, flags content differences as conflicts", () => {
    const plan = diffTrees(local, remote, "bi", [], false);
    expect(plan).toEqual([
      { path: "changed.txt", op: "conflict", reason: "conflict" },
      { path: "only-local.txt", op: "upload", reason: "new" },
      { path: "only-remote.txt", op: "download", reason: "new" },
    ]);
  });

  it("honours exclude patterns on both sides", () => {
    const l = [h(".git/cfg", "1"), h("keep.txt", "2")];
    const r = [h("keep.txt", "3")];
    const plan = diffTrees(l, r, "push", [".git"], false);
    expect(plan).toEqual([{ path: "keep.txt", op: "upload", reason: "changed" }]);
  });
});

describe("applicable / summarize", () => {
  it("drops conflicts from the apply set", () => {
    const plan = diffTrees(
      [h("a", "1"), h("b", "2")],
      [h("a", "9"), h("b", "8")],
      "bi",
      [],
      false,
    );
    expect(applicable(plan)).toHaveLength(0); // both are conflicts
  });

  it("counts ops", () => {
    const s = summarize([
      { path: "a", op: "upload", reason: "new" },
      { path: "b", op: "upload", reason: "changed" },
      { path: "c", op: "conflict", reason: "conflict" },
    ]);
    expect(s.upload).toBe(2);
    expect(s.conflict).toBe(1);
    expect(s.download).toBe(0);
  });
});

// ── run progress (Phase 39.8) ─────────────────────────────────────────────────

const up = (path: string): SyncAction => ({ path, op: "upload", reason: "changed" });

describe("syncTransferId", () => {
  it("mirrors the Rust side and separates same-named files", () => {
    // Must equal `sync::sync_transfer_id`; the event's base name cannot tell
    // these two apart, which is the whole reason the id carries the path.
    expect(syncTransferId("app/config.yml")).toBe("sync:app/config.yml");
    expect(syncTransferId("a/config.yml")).not.toBe(syncTransferId("b/config.yml"));
  });
});

describe("syncRowStatus", () => {
  it("reads the phase when no progress has arrived", () => {
    expect(syncRowStatus("upload", undefined, "running")).toBe("pending");
    // A stopped run must not leave rows saying "queued" — nothing is coming.
    expect(syncRowStatus("upload", undefined, "stopped")).toBe("notRun");
    expect(syncRowStatus("upload", undefined, "done")).toBe("notRun");
  });

  it("tracks a file through the run", () => {
    expect(syncRowStatus("upload", { transferred: 5, total: 10, done: false }, "running")).toBe(
      "running",
    );
    expect(syncRowStatus("upload", { transferred: 10, total: 10, done: true }, "running")).toBe(
      "done",
    );
  });

  it("always marks conflicts skipped, whatever the phase", () => {
    expect(syncRowStatus("conflict", undefined, "idle")).toBe("skipped");
    expect(syncRowStatus("conflict", undefined, "stopped")).toBe("skipped");
  });
});

describe("syncRowPct", () => {
  it("clamps, rounds, and treats done as complete", () => {
    expect(syncRowPct(undefined)).toBe(0);
    expect(syncRowPct({ transferred: 1, total: 3, done: false })).toBe(33);
    // A delete carries no bytes at all — done still means 100.
    expect(syncRowPct({ transferred: 0, total: 0, done: true })).toBe(100);
    expect(syncRowPct({ transferred: 99, total: 10, done: false })).toBe(100);
  });
});

describe("syncRunSummary", () => {
  const plan: SyncAction[] = [up("a"), up("b"), { path: "c", op: "conflict", reason: "conflict" }];

  it("counts against the applicable plan, not the whole list", () => {
    const s = syncRunSummary(plan, {});
    expect(s.filesTotal).toBe(2); // the conflict is never applied
    expect(s).toMatchObject({ filesDone: 0, pct: 0 });
  });

  it("weights a finished file whole and an in-flight one by bytes", () => {
    const map: SyncProgressMap = {
      "sync:a": { transferred: 10, total: 10, done: true },
      "sync:b": { transferred: 5, total: 10, done: false },
    };
    expect(syncRunSummary(plan, map)).toEqual({ filesDone: 1, filesTotal: 2, pct: 75 });
  });

  it("reaches 100% on a plan of byte-less deletes", () => {
    const deletes: SyncAction[] = [
      { path: "x", op: "deleteRemote", reason: "removed" },
      { path: "y", op: "deleteLocal", reason: "removed" },
    ];
    const map: SyncProgressMap = {
      "sync:x": { transferred: 0, total: 0, done: true },
      "sync:y": { transferred: 0, total: 0, done: true },
    };
    expect(syncRunSummary(deletes, map).pct).toBe(100);
  });
});

const e = (path: string, sha256 = "h") => ({ path, sha256 });

describe("planFacts / emptyPlanReason", () => {
  it("tells two empty folders from identical ones", () => {
    expect(emptyPlanReason(planFacts([], [], "push", []))).toBe("bothEmpty");
    expect(emptyPlanReason(planFacts([e("a")], [e("a")], "push", []))).toBe("identical");
  });

  it("says everything was filtered out rather than 'in sync'", () => {
    const f = planFacts([e(".git/HEAD")], [e(".git/HEAD"), e(".git/x")], "push", [".git"]);
    expect(f.excluded).toBe(2);
    expect(emptyPlanReason(f)).toBe("allExcluded");
  });

  it("counts target-only files as extraneous per direction", () => {
    expect(planFacts([], [e("a"), e("b")], "push", []).extraneous).toBe(2);
    expect(planFacts([e("a")], [], "pull", []).extraneous).toBe(1);
    // Both ways has no target side — nothing is extraneous there.
    expect(planFacts([e("a")], [e("b")], "bi", []).extraneous).toBe(0);
    expect(emptyPlanReason(planFacts([], [e("a")], "push", []))).toBe("onlyExtraneous");
  });
});

describe("wipesTarget", () => {
  it("flags an empty source with delete-extraneous on", () => {
    expect(wipesTarget(planFacts([], [e("a")], "push", []), "push", true)).toBe("local");
    expect(wipesTarget(planFacts([e("a")], [], "pull", []), "pull", true)).toBe("remote");
  });

  it("stays quiet when nothing would be deleted", () => {
    expect(wipesTarget(planFacts([], [e("a")], "push", []), "push", false)).toBeNull();
    expect(wipesTarget(planFacts([e("b")], [e("a")], "push", []), "push", true)).toBeNull();
    expect(wipesTarget(planFacts([], [e("a")], "bi", []), "bi", true)).toBeNull();
    expect(wipesTarget(planFacts([], [], "push", []), "push", true)).toBeNull();
  });
});

describe("syncBlockReasons", () => {
  const base = {
    localPath: "/l",
    remotePath: "/r",
    hasPlan: true,
    applicableCount: 1,
    conflictCount: 0,
    phase: "idle" as const,
    busy: false,
  };

  it("enables both when ready", () => {
    expect(syncBlockReasons(base)).toEqual({ compare: null, apply: null });
  });

  it("names the missing step", () => {
    expect(syncBlockReasons({ ...base, localPath: "" }).compare).toBe("sync.needLocal");
    expect(syncBlockReasons({ ...base, remotePath: "" }).apply).toBe("sync.needRemote");
    expect(syncBlockReasons({ ...base, hasPlan: false }).apply).toBe("sync.needCompare");
    expect(syncBlockReasons({ ...base, phase: "stopped" }).apply).toBe("sync.compareAfterStop");
    expect(syncBlockReasons({ ...base, applicableCount: 0, conflictCount: 2 }).apply).toBe(
      "sync.onlyConflicts",
    );
    expect(syncBlockReasons({ ...base, applicableCount: 0 }).apply).toBe("sync.nothingToApply");
    expect(syncBlockReasons({ ...base, otherRunning: true }).apply).toBe("sync.otherRunning");
  });
});

describe("syncErrorView", () => {
  it("maps the backend markers", () => {
    expect(syncErrorView("sync-dir-unreadable: cannot read folder /srv/my app")).toEqual({
      key: "sync.errDirUnreadable",
      path: "/srv/my app",
    });
    expect(syncErrorView("hash-tool-missing: neither …").key).toBe("sync.errHashTool");
    expect(syncErrorView("hash-incomplete: …").key).toBe("sync.errIncomplete");
    expect(syncErrorView("no active session")).toEqual({ key: null, raw: "no active session" });
  });
});

describe("pickerDirs", () => {
  it("keeps folders only, sorted by name", () => {
    const list = [
      { name: "zeta", isDir: true },
      { name: "file", isDir: false },
      { name: "alpha", isDir: true },
      { name: "..", isDir: true },
    ];
    expect(pickerDirs(list).map((d) => d.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("big plans", () => {
  const plan = [
    { path: "README", op: "upload" as const, reason: "new" as const },
    { path: "src/a.ts", op: "upload" as const, reason: "new" as const },
    { path: "src/b.ts", op: "deleteRemote" as const, reason: "removed" as const },
    { path: "srcx/c.ts", op: "conflict" as const, reason: "conflict" as const },
    { path: "src/d/e.ts", op: "deleteLocal" as const, reason: "removed" as const },
  ];

  it("weighs progress per file", () => {
    expect(progressWeight({ transferred: 5, total: 10, done: false })).toBe(0.5);
    expect(progressWeight({ transferred: 0, total: 0, done: false })).toBe(0);
    expect(progressWeight({ transferred: 20, total: 10, done: false })).toBe(1);
    expect(progressWeight({ transferred: 0, total: 0, done: true })).toBe(1);
  });

  it("groups by top-level folder, biggest first", () => {
    const f = planFolders(plan);
    expect(f.map((x) => [x.folder, x.total])).toEqual([
      ["src", 3],
      ["", 1],
      ["srcx", 1],
    ]);
    expect(f[0].counts.upload).toBe(1);
    expect(f[0].counts.deleteRemote + f[0].counts.deleteLocal).toBe(2);
  });

  it("filters by op kind and folder without prefix collisions", () => {
    expect(matchesFilter("deleteLocal", "delete")).toBe(true);
    expect(filterPlan(plan, "delete", null).map((a) => a.path)).toEqual(["src/b.ts", "src/d/e.ts"]);
    // `src` must not catch `srcx/…`.
    expect(filterPlan(plan, "all", "src")).toHaveLength(3);
    expect(filterPlan(plan, "all", "").map((a) => a.path)).toEqual(["README"]);
    expect(filterPlan(plan, "all", null)).toBe(plan);
  });

  it("adds backend-pruned items to the excluded count", () => {
    const f = planFacts([], [], "push", [".git"], 3);
    expect(f.excluded).toBe(3);
    expect(emptyPlanReason(f)).toBe("allExcluded");
  });
});
