import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPipeline, type PipeReader } from "../pipeline/pipeload";
import { loadYaml } from "../pipeline/yamldoc";
import type { CiJob, CiRun } from "./ciparse";
import { parseGithubJobs, parseGithubRun } from "./ciparse";
import { clock, placeJobs, runNames, runOnSchema, runStateOf, timeline, worst } from "./cirun";

const ROOT = process.cwd();
const here = (f: string) => readFileSync(join(ROOT, "src", "lib", "ci", f), "utf8");

/** The repository's own workflow files, read as the schema reads them. */
const repoReader: PipeReader = {
  read: (path) => Promise.resolve(readFileSync(join(ROOT, path.replace(/^\/repo\//, "")), "utf8")),
  list: () => Promise.resolve([]),
};

async function releasePipeline() {
  const Y = await loadYaml();
  const text = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  return loadPipeline(Y, repoReader, "/repo/.github/workflows/release.yml", text);
}

const run = parseGithubRun(here("ciparse.release-run.json")) as CiRun;
const jobs = parseGithubJobs(here("ciparse.release-jobs.json")) as CiJob[];

describe("placing a run's jobs on the file — vterm's release v1.34.0", () => {
  it("names a matrix copy as GitHub does: values in order, empty ones left out", async () => {
    const p = await releasePipeline();
    const release = p.jobs.find((j) => j.id === "release")!;
    expect(runNames(release, "github")).toEqual([
      { exact: "release (macos-latest, --target universal-apple-darwin)" },
      { exact: "release (windows-latest)" },
      { exact: "release (ubuntu-22.04)" },
    ]);
  });

  it("puts all 13 jobs on the file — the called workflows' under their callers", async () => {
    const p = await releasePipeline();
    const placed = placeJobs(p, jobs);
    expect(placed.filter((x) => x.pipelineJob === null)).toEqual([]);
    const of = (name: string) => placed.find((x) => x.job.name === name)!;
    expect(of("Тег = версия")).toMatchObject({ pipelineJob: "tag", inner: null });
    expect(of("Гейты качества / Rust (Windows)")).toMatchObject({ pipelineJob: "verify", inner: "Rust (Windows)" });
    expect(of("Глубокие проверки / Фаззинг недоверенного входа")).toMatchObject({ pipelineJob: "deep" });
    expect(of("release (ubuntu-22.04)")).toMatchObject({ pipelineJob: "release", inner: null });
    const on = runOnSchema(p, jobs);
    expect(on.states).toMatchObject({ tag: "ok", verify: "ok", deep: "ok", release: "ok", integrity: "ok" });
    expect(on.jobsOf.verify).toHaveLength(5);
    expect(on.jobsOf.release).toHaveLength(3);
    expect(on.unmatched).toEqual([]);
  });

  it("expands a `name:` template with the copy's matrix values", async () => {
    const Y = await loadYaml();
    const text = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const p = await loadPipeline(Y, repoReader, "/repo/.github/workflows/ci.yml", text);
    const rust = p.jobs.find((j) => j.id === "rust")!;
    expect(runNames(rust, "github").map((m) => ("exact" in m ? m.exact : String(m.re)))).toEqual([
      "Rust (Linux)",
      "Rust (Windows)",
      "Rust (macOS)",
    ]);
  });

  it("an expression the run alone knows matches as a pattern; what fits nothing is listed", async () => {
    const Y = await loadYaml();
    const p = await loadPipeline(
      Y,
      repoReader,
      "/r/.github/workflows/x.yml",
      "on: push\njobs:\n  build:\n    name: Build ${{ inputs.target }}\n    runs-on: x\n    steps: [{run: a}]\n",
    );
    const ran = [job("1", "Build linux"), job("2", "Stray")];
    const on = runOnSchema(p, ran);
    expect(on.jobsOf.build?.map((j) => j.name)).toEqual(["Build linux"]);
    expect(on.unmatched.map((j) => j.name)).toEqual(["Stray"]);
  });

  it("GitLab: parallel copies and matrix copies by the names GitLab gives", async () => {
    const Y = await loadYaml();
    const p = await loadPipeline(
      Y,
      repoReader,
      "/r/.gitlab-ci.yml",
      "rspec:\n  parallel: 2\n  script: [x]\nlint:\n  parallel:\n    matrix:\n      - LANG: [go, rust]\n  script: [y]\n",
    );
    const ran = ["rspec 1/2", "rspec 2/2", "lint: [go]", "lint: [rust]"].map((n, i) => job(String(i), n));
    const on = runOnSchema(p, ran);
    expect(on.jobsOf.rspec).toHaveLength(2);
    expect(on.jobsOf.lint).toHaveLength(2);
    expect(on.unmatched).toEqual([]);
  });
});

function job(id: string, name: string, over: Partial<CiJob> = {}): CiJob {
  return { id, name, stage: null, state: "ok", created: 0, started: 0, finished: 1000, steps: [], url: null, allowFailure: false, downstream: null, ...over };
}

describe("states on the schema", () => {
  it("a failure that may fail is a warning; the worst of the copies stands for the job", () => {
    expect(runStateOf("failed")).toBe("fail");
    expect(runStateOf("failed", true)).toBe("warn");
    expect(runStateOf("queued")).toBe("wait");
    expect(runStateOf("manual")).toBe("gate");
    expect(worst(["ok", "fail", "run"])).toBe("fail");
    expect(worst(["ok", "run"])).toBe("run");
    expect(worst(["ok", "skip"])).toBe("ok");
  });
});

describe("the run in time — release v1.34.0", () => {
  it("rows in the file's order, a call's jobs under it, and the path that decided the length", async () => {
    const p = await releasePipeline();
    const tl = timeline(run, jobs, p, Date.now());
    expect(tl.done).toBe(true);
    expect(tl.end - tl.start).toBe(1349_000); // 22 min 29 s, as GitHub says
    expect(tl.rows.map((r) => `${r.depth}:${r.label}`).slice(0, 4)).toEqual([
      "0:Тег = версия",
      "0:Гейты качества",
      "1:Зависимости (cargo deny, pnpm audit)",
      "1:Rust (Windows)",
    ]);
    // Fuzzing held the builds; the macOS build held the checksums.
    expect(tl.path.map((r) => r.label)).toEqual([
      "Тег = версия",
      "Фаззинг недоверенного входа",
      "release (macos-latest, --target universal-apple-darwin)",
      "Целостность (суммы, provenance, SBOM)",
    ]);
    const fuzz = tl.path[1];
    expect(clock((fuzz.finished ?? 0) - (fuzz.started ?? 0))).toBe("8:12");
    // Queued 3+4+4+3 s along the path: the runners were not what took the time.
    expect(tl.waited).toBe(14_000);
  });

  it("no path while the run goes on — only what is known", () => {
    const going: CiRun = { ...run, finished: null, state: "running" };
    const tl = timeline(going, [job("a", "a", { state: "running", finished: null, created: run.created, started: run.created })], null, run.created + 5000);
    expect(tl.done).toBe(false);
    expect(tl.path).toEqual([]);
    expect(tl.busy).toBe(5000);
  });
});
