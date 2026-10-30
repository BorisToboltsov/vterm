import { describe, expect, it } from "vitest";
import {
  buildGraph,
  edgePath,
  mainTip,
  primaryFor,
  RAIL_COLORS,
  reachableFromHead,
  TURN_RADIUS,
  type GraphRow,
} from "./gitlanes";
import { NO_FILTER, type GitCommit, type GitRef } from "./git";

const c = (hash: string, parents: string[], refs: GitRef[] = [], head = false): GitCommit => ({
  hash,
  short: hash.slice(0, 7),
  parents,
  author: "a",
  committer: "a",
  timestamp: 0,
  refs,
  subject: hash,
  body: "",
  head,
});
const local = (name: string): GitRef => ({ kind: "local", name });

/** A branch that lives beside main while main moves on, in the order `git log` gives. */
const BESIDE = [
  c("m5", ["m4", "s3"], [local("main")]),
  c("s3", ["s2"], [local("feature")]),
  c("m4", ["m3"]),
  c("s2", ["s1"]),
  c("m3", ["m2"]),
  c("s1", ["m2"]),
  c("m2", ["m1"]),
  c("m1", []),
];

/**
 * A history out of a seed: commits on top of recent tips, some merging, some
 * branching off an older commit, in the order `git log` gives them.
 */
function randomHistory(seed: number, size: number): GitCommit[] {
  let state = seed;
  const next = (n: number): number => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state % n;
  };
  const made: GitCommit[] = [];
  const tips: string[] = [];
  for (let i = 0; i < size; i++) {
    const hash = `c${i}`;
    const parents: string[] = [];
    if (made.length) {
      const pool = tips.length && next(4) ? tips : made.slice(-6).map((m) => m.hash);
      const first = pool[next(pool.length)];
      parents.push(first);
      tips.splice(tips.indexOf(first) >>> 0, tips.includes(first) ? 1 : 0);
      if (next(5) === 0 && tips.length) {
        const second = tips[next(tips.length)];
        if (second !== first) {
          parents.push(second);
          tips.splice(tips.indexOf(second), 1);
        }
      }
    }
    tips.push(hash);
    made.push(c(hash, parents, next(6) === 0 ? [local(`b/${hash}`)] : []));
  }
  const history = made.reverse();
  history[next(history.length)].refs.push(local("main"));
  return history;
}

/** Can a line be followed from `row`'s commit down to its parent's row and lane? */
function reaches(rows: GraphRow[], from: number, to: number): boolean {
  let lanes = new Set([rows[from].col]);
  for (let r = from; r < to; r++) {
    const nextLanes = new Set<number>();
    for (const e of rows[r].edges) if (lanes.has(e.from)) nextLanes.add(e.to);
    lanes = nextLanes;
    if (lanes.size === 0) return false;
  }
  return lanes.has(rows[to].col);
}

describe("buildGraph", () => {
  it("places a linear history in a single lane, on one colour", () => {
    const rows = buildGraph([c("c", ["b"]), c("b", ["a"]), c("a", [])]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
    expect(rows[0].edges).toEqual([expect.objectContaining({ from: 0, to: 0, kind: "straight" })]);
    // The root has nothing below it.
    expect(rows[2].edges).toEqual([]);
  });

  it("gives a merge's second parent its own lane, leaving the node sideways", () => {
    const rows = buildGraph([c("m", ["a", "b"], [local("main")]), c("b", ["a"]), c("a", [])]);
    expect(rows[1].col).toBe(1);
    expect(rows[0].edges).toContainEqual(expect.objectContaining({ from: 0, to: 0, kind: "straight" }));
    expect(rows[0].edges).toContainEqual(expect.objectContaining({ from: 0, to: 1, kind: "out" }));
    // And it comes back into the commit both stand on.
    expect(rows[1].edges).toContainEqual(expect.objectContaining({ from: 1, to: 0, kind: "in" }));
  });

  it("a branch beside main does not trade lanes with it, however long they run together", () => {
    const rows = buildGraph(BESIDE);
    const lanes = Object.fromEntries(rows.map((r) => [r.commit.hash, r.col]));
    for (const m of ["m5", "m4", "m3", "m2", "m1"]) expect(lanes[m]).toBe(0);
    for (const s of ["s3", "s2", "s1"]) expect(lanes[s]).toBe(1);
    // One colour each, and not each other's.
    const color = (h: string) => rows.find((r) => r.commit.hash === h)!.color;
    expect(new Set(["m5", "m4", "m3", "m2", "m1"].map(color))).toEqual(new Set([0]));
    const side = new Set(["s3", "s2", "s1"].map(color));
    expect(side.size).toBe(1);
    expect(side.has(0)).toBe(false);
  });

  it("colours two branches on the same lane differently: a colour is not a lane's number", () => {
    const rows = buildGraph([
      c("t2", ["m2"], [local("second")]),
      c("m2", ["m1"], [local("main")]),
      c("t1", ["m1"], [local("first")]),
      c("m1", []),
    ]);
    const [second, , first] = rows;
    expect(second.col).toBe(first.col);
    expect(second.color).not.toBe(first.color);
  });

  it("a branch keeps its colour when other commits land around it, and origin/x is x", () => {
    const tip = (refs: GitRef[]) => c("t", ["m"], refs);
    const alone = buildGraph([tip([local("feat/a")]), c("m", [], [local("main")])]);
    const remote = buildGraph([tip([{ kind: "remote", name: "origin/feat/a" }]), c("m", [], [local("main")])]);
    const later = buildGraph([c("n", ["m"], [local("main")]), tip([local("feat/a")]), c("m", [])]);
    expect(remote[0].color).toBe(alone[0].color);
    expect(later[1].color).toBe(alone[0].color);
  });

  it("holds its contract on arbitrary histories", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const commits = randomHistory(seed, 90);
      const rows = buildGraph(commits);
      const index = new Map(commits.map((x, i) => [x.hash, i]));

      // Every commit is joined to every parent by the lines drawn.
      rows.forEach((row, i) => {
        for (const p of row.commit.parents) {
          expect(reaches(rows, i, index.get(p)!), `seed ${seed}: ${row.commit.hash} → ${p}`).toBe(true);
        }
      });

      const seen = new Map<number, { color: number; lanes: Set<number> }>();
      for (const row of rows) {
        expect(row.color).toBeGreaterThanOrEqual(0);
        expect(row.color).toBeLessThan(RAIL_COLORS);
        for (const e of row.edges) {
          const line = seen.get(e.line) ?? { color: e.color, lanes: new Set<number>() };
          // A line has one colour from end to end…
          expect(e.color, `seed ${seed}: line ${e.line}`).toBe(line.color);
          // …and runs down one lane: straight stretches never change it.
          if (e.kind === "straight") line.lanes.add(e.from);
          expect(line.lanes.size, `seed ${seed}: line ${e.line}`).toBeLessThanOrEqual(1);
          seen.set(e.line, line);
          // Only a turn goes sideways, and only a turn is named one.
          expect(e.kind === "straight", `seed ${seed}`).toBe(e.from === e.to);
        }
      }

      // The main line stands on the first lane in the first colour, all the way.
      const main = mainTip(commits);
      for (let h = main; h && index.has(h); ) {
        const row = rows[index.get(h)!];
        expect(row.col).toBe(0);
        expect(row.color).toBe(0);
        h = row.commit.parents[0] ?? null;
      }
    }
  });

  it("the main line is reserved its lane before its tip appears", () => {
    const rows = buildGraph([c("x", ["m"], [local("feature")]), c("m", ["r"], [local("main")]), c("r", [])]);
    expect(rows[0].col).toBe(1);
    expect(rows[1].col).toBe(0);
  });

  it("a parent beyond what is loaded is a cut, not a lane waiting for ever", () => {
    const rows = buildGraph([c("b", ["a", "z"], [local("main")]), c("a", ["gone"])]);
    expect(rows[0].cut).toBe(true);
    expect(rows[1].cut).toBe(true);
    expect(Math.max(...rows.map((r) => r.lanes))).toBe(1);
  });

  it("survives a parent listed above its child (a clock that ran backwards)", () => {
    const rows = buildGraph([c("older", []), c("child", ["older"], [local("main")])]);
    expect(rows[1].cut).toBe(true);
    expect(rows[1].edges).toEqual([]);
  });

  it("draws nothing for a search's scattered commits but what connects them", () => {
    const rows = buildGraph([c("x", ["gone"]), c("y", ["other"])], null);
    expect(rows.map((r) => r.col)).toEqual([0, 0]);
    expect(rows.flatMap((r) => r.edges)).toEqual([]);
  });

  it("draws the main line last, on top of what crosses it", () => {
    const rows = buildGraph([c("m", ["a", "b"], [local("main")]), c("b", ["a"]), c("a", [])]);
    expect(rows[0].edges.at(-1)!.color).toBe(0);
  });
});

describe("mainTip", () => {
  it("prefers the local main branch, then the remote's, then HEAD", () => {
    expect(mainTip([c("a", [], [local("feat")], true), c("b", [], [local("main")])])).toBe("b");
    expect(mainTip([c("a", [], [], true), c("b", [], [{ kind: "remote", name: "origin/master" }])])).toBe("b");
    expect(mainTip([c("a", [], [local("feat")]), c("b", [], [local("x")], true)])).toBe("b");
    expect(mainTip([c("a", [])])).toBeNull();
  });
  it("takes a checked-out main like any other", () => {
    expect(mainTip([c("a", [], [{ kind: "head", name: "main" }], true)])).toBe("a");
  });
});

describe("primaryFor", () => {
  const history = [c("t", ["m"], [local("feat")]), c("m", [], [local("main")])];
  it("reads the whole history along main", () => {
    expect(primaryFor(history, NO_FILTER)).toBe("m");
  });
  it("reads one branch along itself", () => {
    expect(primaryFor(history, { ...NO_FILTER, branch: "refs/heads/feat" })).toBe("t");
  });
  it("has no main line in a search", () => {
    expect(primaryFor(history, { ...NO_FILTER, text: "x" })).toBeNull();
    expect(primaryFor(history, { ...NO_FILTER, branch: "refs/heads/feat", author: "a" })).toBeNull();
  });
});

describe("edgePath", () => {
  const x = (lane: number) => 10 + lane * 14;
  it("draws a straight line down a lane", () => {
    expect(edgePath({ from: 1, to: 1, kind: "straight" }, 13, 39, x)).toBe("M24 13V39");
  });
  it("leaves a commit sideways, then turns down", () => {
    expect(edgePath({ from: 0, to: 1, kind: "out" }, 13, 39, x)).toBe(
      `M10 13H${24 - TURN_RADIUS}A${TURN_RADIUS} ${TURN_RADIUS} 0 0 1 24 ${13 + TURN_RADIUS}V39`,
    );
  });
  it("runs down its lane, then turns into the commit below", () => {
    expect(edgePath({ from: 1, to: 0, kind: "in" }, 13, 39, x)).toBe(
      `M24 13V${39 - TURN_RADIUS}A${TURN_RADIUS} ${TURN_RADIUS} 0 0 1 ${24 - TURN_RADIUS} 39H10`,
    );
  });
  it("turns the other way on the way back, and at one radius however far it goes", () => {
    expect(edgePath({ from: 2, to: 0, kind: "out" }, 0, 26, x)).toContain(`A${TURN_RADIUS} ${TURN_RADIUS} 0 0 0 10 ${TURN_RADIUS}`);
    expect(edgePath({ from: 0, to: 5, kind: "in" }, 0, 26, x)).toContain(`A${TURN_RADIUS} ${TURN_RADIUS} 0 0 0 ${10 + TURN_RADIUS} 26`);
  });
  it("is a straight line where a clamp put both ends on one lane", () => {
    expect(edgePath({ from: 9, to: 12, kind: "in" }, 0, 26, () => 100)).toBe("M100 0V26");
  });
});

describe("reachableFromHead", () => {
  it("walks the parents of HEAD, and nothing else", () => {
    const set = reachableFromHead([c("x", ["m"]), c("h", ["m"], [], true), c("m", ["r"]), c("r", [])]);
    expect([...set].sort()).toEqual(["h", "m", "r"]);
  });
  it("is empty when HEAD is not loaded", () => {
    expect(reachableFromHead([c("a", [])]).size).toBe(0);
  });
});
