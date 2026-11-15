import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadGroup, type PipeReader } from "../pipeline/pipeload";
import { buildMap } from "../pipeline/pipemap";
import { loadYaml, type Yaml } from "../pipeline/yamldoc";
import { applyView, NO_FILTER } from "../ui/listview";
import { parseGithubRuns, type CiJob, type CiRun } from "./ciparse";
import { jobsToRead, ownerOf, PIPE_SCHEMA, pipeRows, type HeldJobs, type PipeRow } from "./cipipes";

const ROOT = process.cwd();
const REPO = "/repo";
const disk = (path: string) => join(ROOT, path.slice(REPO.length));

/** The repository itself, as the panel's connection reads it. */
const repoReader: PipeReader = {
  read: (path) => Promise.resolve(readFileSync(disk(path), "utf8")),
  list: (dir) =>
    Promise.resolve(readdirSync(disk(dir)).map((name) => ({ name, path: `${dir}/${name}`, isDir: statSync(join(disk(dir), name)).isDirectory() }))),
};

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

const runs = parseGithubRuns(readFileSync(join(ROOT, "src/lib/ci/ciparse.runs.json"), "utf8")) as CiRun[];

async function vtermRows(list: CiRun[] | null = runs): Promise<PipeRow[]> {
  const group = await loadGroup(Y, repoReader, [{ path: REPO, isDir: true }]);
  return pipeRows(buildMap(group.pipelines), REPO, list);
}

const run = (over: Partial<CiRun>): CiRun => ({
  id: "1",
  forge: "github",
  number: 1,
  workflow: "CI",
  file: ".github/workflows/ci.yml",
  title: null,
  branch: "main",
  sha: "abc",
  event: "push",
  state: "ok",
  attempt: 1,
  created: 1000,
  started: 1000,
  finished: 2000,
  url: null,
  ...over,
});

describe("the CI panel's pipelines — vterm's own", () => {
  it("lists every workflow file, the reusable ones as called, by whom", async () => {
    const rows = await vtermRows();
    const byRel = Object.fromEntries(rows.map((r) => [r.rel, r]));
    expect(Object.keys(byRel).sort()).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/codeql.yml",
      ".github/workflows/deep.yml",
      ".github/workflows/release.yml",
      ".github/workflows/security.yml",
      ".github/workflows/train.yml",
    ]);
    // ci.yml and deep.yml run on events of their own as well: they are started, and called too.
    expect(byRel[".github/workflows/ci.yml"].called).toBe(false);
    expect(byRel[".github/workflows/ci.yml"].callers).toEqual(["Release"]);
    expect(byRel[".github/workflows/deep.yml"].callers).toEqual(["Release"]);
    expect(byRel[".github/workflows/release.yml"].events.map((e) => e.kind)).toEqual(["tag"]);
    expect(byRel[".github/workflows/train.yml"].canStart).toBe(true);
    expect(byRel[".github/workflows/ci.yml"].canStart).toBe(false);
  });

  it("gives each run to its workflow file, newest first", async () => {
    const rows = await vtermRows();
    const byRel = Object.fromEntries(rows.map((r) => [r.rel, r]));
    expect(byRel[".github/workflows/ci.yml"].runs.map((r) => r.workflow)).toEqual(["CI"]);
    expect(byRel[".github/workflows/train.yml"].runs.map((r) => r.number)).toEqual([35]);
    expect(byRel[".github/workflows/release.yml"].runs).toEqual([]);
    expect(rows.flatMap((r) => r.runs)).toHaveLength(runs.length);
  });

  it("stands without the forge: no list read, no runs, the rows all the same", async () => {
    const rows = await vtermRows(null);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.runs.length === 0)).toBe(true);
  });

  it("orders by the latest run, the never-run last, called ones under started ones", async () => {
    const rows = await vtermRows([run({ id: "a", file: ".github/workflows/train.yml", created: 5 }), run({ id: "b", file: ".github/workflows/codeql.yml", created: 9 })]);
    const view = applyView(rows, PIPE_SCHEMA, NO_FILTER, { sort: { key: "time", dir: "desc" }, group: "none" });
    expect(view.groups[0].items.slice(0, 2).map((r) => r.rel)).toEqual([".github/workflows/codeql.yml", ".github/workflows/train.yml"]);
    // The filter finds a pipeline by name and by who calls it.
    const found = applyView(rows, PIPE_SCHEMA, { text: "relea", facets: {} }, { sort: { key: "name", dir: "asc" }, group: "none" });
    expect(found.groups[0].items.map((r) => r.rel).sort()).toEqual([".github/workflows/ci.yml", ".github/workflows/deep.yml", ".github/workflows/release.yml"]);
    // A pipeline only ever called stands under the started ones, whatever the order.
    const called = { ...rows[0], id: "/x", name: "AAA", called: true };
    const both = applyView([...rows, called], PIPE_SCHEMA, NO_FILTER, { sort: { key: "name", dir: "asc" }, group: "none" });
    expect(both.groups[0].items.at(-1)?.id).toBe("/x");
  });
});

describe("ownerOf", () => {
  const rows = [
    { id: "/r/.github/workflows/ci.yml", rel: ".github/workflows/ci.yml", kind: "github" as const, called: false },
    { id: "/r/.gitlab-ci.yml", rel: ".gitlab-ci.yml", kind: "gitlab" as const, called: false },
    { id: "/r/ci/child.yml", rel: "ci/child.yml", kind: "gitlab" as const, called: true },
  ];
  it("knows a GitHub run by its file and nothing else", () => {
    expect(ownerOf(run({}), rows)).toBe("/r/.github/workflows/ci.yml");
    expect(ownerOf(run({ file: "dynamic/github-code-scanning/codeql" }), rows)).toBeNull();
    expect(ownerOf(run({ file: null }), rows)).toBeNull();
  });
  it("gives GitLab's pipelines to the main file, a child pipeline to nobody", () => {
    expect(ownerOf(run({ forge: "gitlab", file: null, event: "push" }), rows)).toBe("/r/.gitlab-ci.yml");
    expect(ownerOf(run({ forge: "gitlab", file: null, event: "parent_pipeline" }), rows)).toBeNull();
    expect(ownerOf(run({ forge: "gitlab", file: null }), rows.slice(0, 1))).toBeNull();
  });
});

describe("jobsToRead", () => {
  const row = (id: string, latest: CiRun | null): PipeRow =>
    ({ id, rel: id, name: id, runs: latest ? [latest] : [] }) as unknown as PipeRow;
  const held = (state: CiRun["state"], attempt = 1): HeldJobs => ({ state, attempt, jobs: [] as CiJob[] });

  it("reads a run that ended once, a running one every time, a changed one again", () => {
    const done = run({ id: "done", created: 1 });
    const going = run({ id: "going", state: "running", created: 2 });
    const again = run({ id: "again", attempt: 2, created: 3 });
    const rows = [row("a", done), row("b", going), row("c", again), row("d", null)];
    const map = new Map([
      ["done", held("ok")],
      ["going", held("running")],
      ["again", held("ok", 1)],
    ]);
    expect(jobsToRead(rows, map).map((r) => r.id)).toEqual(["going", "again"]);
    expect(jobsToRead(rows, new Map()).map((r) => r.id)).toEqual(["going", "again", "done"]);
  });

  it("reads no more than its cap, the running and the newest first", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`r${i}`, run({ id: `r${i}`, created: i, state: i === 2 ? "running" : "ok" })));
    expect(jobsToRead(rows, new Map(), 3).map((r) => r.id)).toEqual(["r2", "r9", "r8"]);
  });
});
