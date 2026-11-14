import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { args: string[]; mirror: boolean }[] = [];
let answer: (args: string[]) => { stdout: string; stderr: string; exitCode: number } = () => ({ stdout: "", stderr: "", exitCode: 0 });
const gitAnswers: Record<string, { stdout: string; stderr: string; exitCode: number }> = {};

vi.mock("../api", () => ({
  ciRun: vi.fn(async (_sid: string, args: string[], _t: number, mirror: boolean) => {
    calls.push({ args, mirror });
    return answer(args);
  }),
  gitRun: vi.fn(async (_sid: string, _cwd: string, args: string[]) => gitAnswers[args.join(" ")] ?? { stdout: "", stderr: "fatal", exitCode: 128 }),
}));

import { captureDiag } from "../api/diag";
import type { Repo } from "../ci/forge";
import {
  cancelRun,
  checkWatched,
  ciRuns,
  ciWatch,
  fileAtCommit,
  forgetCi,
  isWatched,
  readRuns,
  repoOfFile,
  rerunRun,
  runsOfCommit,
  startRun,
  watchRun,
} from "./ci.svelte";
import { toastsState } from "./toasts.svelte";
import { parseGithubRuns } from "../ci/ciparse";

const RUNS = readFileSync(join(process.cwd(), "src", "lib", "ci", "ciparse.runs.json"), "utf8");
const repo: Repo = { remote: "origin", host: "github.com", path: "BorisToboltsov/vterm", forge: "github" };
const run = parseGithubRuns(RUNS)![0];

beforeEach(() => {
  calls.length = 0;
  answer = () => ({ stdout: RUNS, stderr: "", exitCode: 0 });
});
afterEach(() => {
  forgetCi("s1");
  forgetCi("s2");
});

describe("the CI store", () => {
  it("keeps the last list a session read: the Git history marks its commits by it", async () => {
    const got = await readRuns("s1", repo);
    expect(got.ok && got.value.length).toBe(4);
    expect(calls[0]).toEqual({ args: ["gh", "api", "--hostname", "github.com", "repos/BorisToboltsov/vterm/actions/runs?per_page=30"], mirror: false });
    expect(runsOfCommit("s1", repo, run.sha).map((r) => r.workflow)).toContain("Train");
    // Another repository's list says nothing of this one; a workflow's list is not the repository's.
    expect(runsOfCommit("s1", { ...repo, path: "o/other" }, run.sha)).toEqual([]);
    forgetCi("s1");
    expect(ciRuns.bySession.s1).toBeUndefined();
  });

  it("an answer that is not a list is a failure, not no runs", async () => {
    answer = () => ({ stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 });
    const got = await readRuns("s1", repo);
    expect(got).toEqual({ ok: false, failure: { kind: "notFound", text: "gh: Not Found (HTTP 404)" } });
  });

  it("a write is recorded, said before and after, and said in the journal", async () => {
    const diag = captureDiag();
    answer = () => ({ stdout: "", stderr: "", exitCode: 0 });
    expect(await rerunRun("s1", repo, run, true)).toBeNull();
    expect(calls.at(-1)).toEqual({ args: ["gh", "api", "--hostname", "github.com", "-X", "POST", `repos/BorisToboltsov/vterm/actions/runs/${run.id}/rerun-failed-jobs`], mirror: true });
    const events = diag.events().filter((e) => e.source === "ci");
    expect(events.map((e) => [e.level, e.text])).toEqual([
      ["info", "rerun of the failed jobs asked"],
      ["info", "rerun of the failed jobs done"],
    ]);
    expect(toastsState.list.at(-1)?.message).toContain("#35");
    diag.stop();
  });

  it("a refused write is a warning with the forge's words, and a toast", async () => {
    const diag = captureDiag();
    answer = () => ({ stdout: "", stderr: "gh: Resource not accessible by integration (HTTP 403)", exitCode: 1 });
    const failed = await cancelRun("s1", repo, run);
    expect(failed?.kind).toBe("failed");
    const warn = diag.events().find((e) => e.level === "warn" && e.source === "ci");
    expect(warn?.fields).toMatchObject({ forge: "github", run: run.id, said: "gh: Resource not accessible by integration (HTTP 403)" });
    diag.stop();
  });

  it("a run started by hand: the inputs go to the forge, only their number to the diagnostics", async () => {
    const diag = captureDiag();
    answer = () => ({ stdout: "", stderr: "", exitCode: 0 });
    await startRun("s1", repo, ".github/workflows/deploy.yml", "main", { environment: "staging", token: "s3cr3t" });
    expect(calls.at(-1)?.args).toContain("inputs[token]=s3cr3t");
    expect(calls.at(-1)?.mirror).toBe(true);
    expect(JSON.stringify(diag.events())).not.toContain("s3cr3t");
    expect(diag.events()[0].fields).toMatchObject({ forge: "github", ref: "main", fields: 2 });
    diag.stop();
  });

  it("a watch asks its run until it ends, says so, and lets go", async () => {
    const going = { ...run, state: "running" as const, finished: null };
    watchRun("s1", repo, going);
    expect(isWatched("s1", run.id)).toBe(true);
    const one = JSON.parse(RUNS).workflow_runs[0];
    answer = () => ({ stdout: JSON.stringify({ ...one, status: "in_progress", conclusion: null }), stderr: "", exitCode: 0 });
    await checkWatched();
    expect(isWatched("s1", run.id)).toBe(true);
    answer = () => ({ stdout: JSON.stringify({ ...one, status: "completed", conclusion: "failure" }), stderr: "", exitCode: 0 });
    await checkWatched();
    expect(isWatched("s1", run.id)).toBe(false);
    expect(toastsState.list.at(-1)?.message).toMatch(/Train #35 on main ended: Failed/);
  });

  it("a run already over is not watched; a closed tab's watches go with it", () => {
    watchRun("s1", repo, run);
    expect(isWatched("s1", run.id)).toBe(false);
    watchRun("s1", repo, { ...run, state: "queued", finished: null });
    watchRun("s2", repo, { ...run, id: "9", state: "queued", finished: null });
    forgetCi("s1");
    expect(ciWatch.list.map((w) => w.sessionId)).toEqual(["s2"]);
  });

  it("finds a file's repository and reads the file at a commit through git on the session", async () => {
    gitAnswers["rev-parse --show-toplevel"] = { stdout: "/r\n", stderr: "", exitCode: 0 };
    gitAnswers["remote -v"] = { stdout: "origin\thttps://github.com/o/r.git (fetch)\n", stderr: "", exitCode: 0 };
    gitAnswers[`show ${"a".repeat(40)}:.github/workflows/ci.yml`] = { stdout: "on: push\n", stderr: "", exitCode: 0 };
    const found = await repoOfFile("s1", "/r/.github/workflows/ci.yml");
    expect(found).toEqual({ root: "/r", repo: { remote: "origin", host: "github.com", path: "o/r", forge: "github" } });
    expect(await fileAtCommit("s1", "/r", "a".repeat(40), "/r/.github/workflows/ci.yml")).toBe("on: push\n");
    // Not fetched here: null, and the schema says it drew the current file.
    expect(await fileAtCommit("s1", "/r", "b".repeat(40), "/r/.github/workflows/ci.yml")).toBeNull();
    // A sha that is not one is not handed to git.
    expect(await fileAtCommit("s1", "/r", "HEAD;rm", "/r/.github/workflows/ci.yml")).toBeNull();
  });
});
