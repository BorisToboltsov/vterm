import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanLog,
  failureOf,
  githubState,
  gitlabState,
  isActive,
  logPlace,
  logTail,
  parseCommitSha,
  parseGithubJobs,
  parseGithubRun,
  parseGithubRuns,
  parseGithubWorkflows,
  parseGitlabJobs,
  parseGitlabPipeline,
  parseGitlabPipelines,
} from "./ciparse";

const here = (f: string) => readFileSync(join(process.cwd(), "src", "lib", "ci", f), "utf8");

describe("GitHub's answers", () => {
  it("reads the runs list of vterm as GitHub sent it", () => {
    const runs = parseGithubRuns(here("ciparse.runs.json"))!;
    expect(runs).toHaveLength(4);
    expect(runs[0]).toMatchObject({ forge: "github", workflow: "Train", file: ".github/workflows/train.yml", branch: "main", event: "push", state: "ok" });
    expect(runs.every((r) => r.finished !== null && !isActive(r.state))).toBe(true);
    // A run still going has no end.
    const raw = JSON.parse(here("ciparse.runs.json")) as { workflow_runs: Record<string, unknown>[] };
    raw.workflow_runs[2] = { ...raw.workflow_runs[2], status: "in_progress", conclusion: null };
    const going = parseGithubRuns(JSON.stringify(raw))![2];
    expect([going.state, going.finished, isActive(going.state)]).toEqual(["running", null, true]);
  });

  it("a run: number, attempt, its file without the ref, start and end", () => {
    const run = parseGithubRun(here("ciparse.release-run.json"))!;
    expect(run).toMatchObject({ id: "42701787236", number: 41, attempt: 1, workflow: "Release", file: ".github/workflows/release.yml", branch: "v1.34.0", state: "ok" });
    expect((run.finished ?? 0) - (run.started ?? 0)).toBe(1349_000);
  });

  it("jobs with their steps and the time each was made, started and ended", () => {
    const jobs = parseGithubJobs(here("ciparse.release-jobs.json"))!;
    expect(jobs).toHaveLength(13);
    const tag = jobs[0];
    expect(tag.name).toBe("Тег = версия");
    expect(tag.steps[0]).toMatchObject({ number: 1, name: "Set up job", state: "ok" });
    expect((tag.started ?? 0) - (tag.created ?? 0)).toBe(3000);
  });

  it("an answer that is not GitHub's is null, not an empty list", () => {
    expect(parseGithubRuns("{}")).toBeNull();
    expect(parseGithubRuns("not json")).toBeNull();
    expect(parseGithubRuns('{"workflow_runs":[]}')).toEqual([]);
    expect(parseGithubJobs('{"message":"Not Found"}')).toBeNull();
    expect(parseGithubRun("[]")).toBeNull();
  });

  it("states: status and conclusion as one word", () => {
    expect(githubState("completed", "success")).toBe("ok");
    expect(githubState("completed", "failure")).toBe("failed");
    expect(githubState("completed", "timed_out")).toBe("failed");
    expect(githubState("completed", "cancelled")).toBe("cancelled");
    expect(githubState("completed", "action_required")).toBe("waiting");
    expect(githubState("in_progress", null)).toBe("running");
    expect(githubState("waiting", null)).toBe("waiting");
    expect(githubState("queued", null)).toBe("queued");
  });

  it("workflows: only files of the repository, not GitHub's own dynamic ones", () => {
    const text = JSON.stringify({ workflows: [{ name: "CI", path: ".github/workflows/ci.yml" }, { name: "Dependabot Updates", path: "dynamic/dependabot/dependabot-updates" }] });
    expect(parseGithubWorkflows(text)).toEqual([{ name: "CI", path: ".github/workflows/ci.yml" }]);
  });

  it("the commit of an action's tag — a full SHA or nothing", () => {
    expect(parseCommitSha(JSON.stringify({ sha: "a".repeat(40) }))).toBe("a".repeat(40));
    expect(parseCommitSha(JSON.stringify({ sha: "abc" }))).toBeNull();
    expect(parseCommitSha('{"message":"No commit found for SHA: v9"}')).toBeNull();
  });
});

describe("GitLab's answers", () => {
  const pipelines = JSON.stringify([
    { id: 77, iid: 12, project_id: 3, sha: "e3b71c0", ref: "main", status: "running", source: "push", created_at: "2026-11-13T10:00:00.000Z", updated_at: "2026-11-13T10:01:00.000Z", web_url: "https://gl/x/-/pipelines/77", name: null },
    { id: 76, iid: 11, project_id: 3, sha: "aaaa", ref: "feat", status: "failed", source: "merge_request_event", created_at: "2026-11-13T09:00:00.000Z", updated_at: "2026-11-13T09:05:00.000Z", web_url: "https://gl/x/-/pipelines/76" },
  ]);

  it("reads pipelines: iid is the number people say, the source is the event", () => {
    const runs = parseGitlabPipelines(pipelines)!;
    expect(runs.map((r) => [r.id, r.number, r.state, r.event])).toEqual([
      ["77", 12, "running", "push"],
      ["76", 11, "failed", "merge_request_event"],
    ]);
    // The list carries no commit message: not made up.
    expect(runs[0].title).toBeNull();
  });

  it("one pipeline: its start and end", () => {
    const p = parseGitlabPipeline(JSON.stringify({ id: 76, iid: 11, sha: "a", ref: "feat", status: "failed", source: "push", created_at: "2026-11-13T09:00:00Z", started_at: "2026-11-13T09:00:10Z", finished_at: "2026-11-13T09:05:00Z" }))!;
    expect((p.finished ?? 0) - (p.started ?? 0)).toBe(290_000);
  });

  it("jobs with their stage; a trigger job names the pipeline it started; no steps", () => {
    const jobs = parseGitlabJobs(
      JSON.stringify([
        { id: 1, name: "rspec 1/2", stage: "test", status: "failed", allow_failure: true, created_at: "2026-11-13T09:00:00Z", started_at: null, finished_at: null },
        { id: 2, name: "deploy", stage: "deploy", status: "success", downstream_pipeline: { id: 90, project_id: 4, status: "success" } },
      ]),
    )!;
    expect(jobs[0]).toMatchObject({ stage: "test", state: "failed", allowFailure: true, steps: [] });
    expect(jobs[1].downstream).toEqual({ id: "90", project: "4" });
    expect(parseGitlabJobs("{}")).toBeNull();
  });

  it("states", () => {
    expect(gitlabState("manual")).toBe("manual");
    expect(gitlabState("canceled")).toBe("cancelled");
    expect(gitlabState("waiting_for_resource")).toBe("queued");
    expect(gitlabState("success")).toBe("ok");
  });
});

describe("the log", () => {
  it("drops GitHub's timestamps and BOM, marks the error lines, keeps the tail", () => {
    const log = [
      "﻿2026-11-09T21:21:54.7299238Z Current runner version: '2.338.2'",
      "2026-11-09T21:21:56.1Z  FAIL  src/lib/ci/cirun.test.ts > jobKey",
      "2026-11-09T21:21:56.2Z ##[error]Process completed with exit code 1.",
      "",
    ].join("\n");
    const tail = logTail(log, 2);
    expect(tail.total).toBe(3);
    expect(tail.lines).toEqual([
      { text: " FAIL  src/lib/ci/cirun.test.ts > jobKey", error: true },
      { text: "Process completed with exit code 1.", error: true },
    ]);
  });

  it("GitLab's trace: colours, section markers and \\r overwrites gone", () => {
    const esc = String.fromCharCode(27);
    const trace = `section_start:1700000000:step_script\r${esc}[0K${esc}[32;1mRunning\r${esc}[0K${esc}[0;m\nprogress 10%\rprogress 100%\n`;
    expect(cleanLog(trace)).toEqual(["Running", "progress 100%", ""]);
  });

  it("a place of the repository the log names — the last one that is a file of it", () => {
    const lines = logTail(" ❯ src/lib/ci/cirun.test.ts:48:31\nat /usr/lib/node.js:3\nsee ./README.md:2", 10).lines;
    expect(logPlace(lines, (p) => p === "src/lib/ci/cirun.test.ts")).toEqual({ path: "src/lib/ci/cirun.test.ts", line: 48 });
    expect(logPlace(lines, (p) => p === "README.md")).toEqual({ path: "README.md", line: 2 });
    expect(logPlace(lines, () => false)).toBeNull();
  });
});

describe("why a call failed", () => {
  const fail = (exitCode: number, stderr: string, stdout = "") => failureOf({ exitCode, stderr, stdout })?.kind;
  it("each failure has its way out", () => {
    expect(failureOf({ exitCode: 0, stdout: "[]", stderr: "" })).toBeNull();
    expect(fail(127, "gh: No such file or directory")).toBe("missing");
    expect(fail(-1, "ci timed out after 25s")).toBe("offline");
    expect(fail(4, "To get started with GitHub CLI, please run:  gh auth login")).toBe("signedOut");
    expect(fail(1, "gh: Bad credentials (HTTP 401)")).toBe("signedOut");
    expect(fail(1, "glab: 401 Unauthorized")).toBe("signedOut");
    expect(fail(1, "gh: Not Found (HTTP 404)", '{"message":"Not Found"}')).toBe("notFound");
    expect(fail(1, "glab: 404 Project Not Found")).toBe("notFound");
    expect(fail(1, "gh: API rate limit exceeded for user (HTTP 403)")).toBe("rateLimit");
    expect(fail(1, "error connecting to api.github.com: dial tcp: lookup api.github.com: no such host")).toBe("offline");
    expect(failureOf({ exitCode: 1, stderr: "\n gh: Something odd (HTTP 500)\nmore", stdout: "" })).toEqual({ kind: "failed", text: "gh: Something odd (HTTP 500)" });
  });
});
