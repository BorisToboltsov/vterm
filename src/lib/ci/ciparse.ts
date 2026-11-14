// The forge's answers read into one model of runs, jobs and steps (ADR 0069):
// GitHub Actions' runs and jobs, GitLab's pipelines, jobs and bridges. What an
// answer does not say stays unsaid (principle 5): a GitLab job has no steps, a
// list of pipelines carries no commit message, a time not given is null — never
// a plausible fill. An answer that is not what the forge sends is null, not an
// empty list: "no runs" and "could not read" are different things. Pure.

import type { Forge } from "./forge";

/** Where a run, a job or a step stands — one vocabulary for both forges. */
export type CiState =
  | "queued"
  | "running"
  | "waiting"
  | "manual"
  | "ok"
  | "failed"
  | "cancelled"
  | "skipped"
  | "neutral";

export interface CiRun {
  /** The forge's id: what every other call names. */
  id: string;
  forge: Forge;
  /** The number people say (`#422`): GitHub's run number, GitLab's iid. */
  number: number | null;
  /** The workflow's name (GitHub) or the pipeline's name, if it has one. */
  workflow: string;
  /** The workflow file, repository-relative (GitHub); null when the answer does not say. */
  file: string | null;
  /** The commit's first line (GitHub's display title); null when not given. */
  title: string | null;
  branch: string | null;
  sha: string;
  /** `push`, `pull_request`, `schedule`… (GitLab: the pipeline's source). */
  event: string;
  state: CiState;
  attempt: number;
  created: number;
  started: number | null;
  /** When it ended; null while it runs or when the answer does not say. */
  finished: number | null;
  url: string | null;
}

export interface CiStep {
  number: number;
  name: string;
  state: CiState;
  started: number | null;
  finished: number | null;
}

export interface CiJob {
  id: string;
  name: string;
  /** GitLab's stage; null on GitHub. */
  stage: string | null;
  state: CiState;
  /** When the job was made — queued for a runner. */
  created: number | null;
  started: number | null;
  finished: number | null;
  steps: CiStep[];
  url: string | null;
  /** GitLab `allow_failure`: a failure that does not fail the pipeline. */
  allowFailure: boolean;
  /** A GitLab trigger job: the pipeline it started, when there is one. */
  downstream: { id: string; project: string | null } | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ms = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const id = (v: unknown): string | null => (typeof v === "number" || (typeof v === "string" && v) ? String(v) : null);

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** GitHub's `status` + `conclusion` as one state. */
export function githubState(status: unknown, conclusion: unknown): CiState {
  switch (status) {
    case "in_progress":
      return "running";
    case "waiting":
      return "waiting";
    case "queued":
    case "requested":
    case "pending":
      return "queued";
    case "completed":
      switch (conclusion) {
        case "success":
          return "ok";
        case "failure":
        case "timed_out":
        case "startup_failure":
          return "failed";
        case "cancelled":
          return "cancelled";
        case "skipped":
          return "skipped";
        case "action_required":
          return "waiting";
        default:
          return "neutral";
      }
    default:
      return "neutral";
  }
}

/** GitLab's `status` as a state. */
export function gitlabState(status: unknown): CiState {
  switch (status) {
    case "created":
    case "pending":
    case "preparing":
    case "scheduled":
    case "waiting_for_resource":
      return "queued";
    case "running":
      return "running";
    case "waiting_for_callback":
      return "waiting";
    case "manual":
      return "manual";
    case "success":
      return "ok";
    case "failed":
      return "failed";
    case "canceled":
    case "canceling":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "neutral";
  }
}

/** Still going: the list is asked again while one of its runs is. */
export const isActive = (state: CiState): boolean => state === "queued" || state === "running" || state === "waiting";

/** Ended in a way someone has to look at. */
export const isBad = (state: CiState): boolean => state === "failed";

/** `.github/workflows/ci.yml@refs/heads/main` → `.github/workflows/ci.yml`. */
const workflowFile = (path: unknown): string | null => s(path)?.split("@")[0] ?? null;

function githubRun(r: unknown): CiRun | null {
  if (!isObj(r)) return null;
  const runId = id(r.id);
  const created = ms(r.created_at);
  if (!runId || created === null) return null;
  const state = githubState(r.status, r.conclusion);
  return {
    id: runId,
    forge: "github",
    number: n(r.run_number),
    workflow: s(r.name) ?? workflowFile(r.path) ?? runId,
    file: workflowFile(r.path),
    title: s(r.display_title),
    branch: s(r.head_branch),
    sha: s(r.head_sha) ?? "",
    event: s(r.event) ?? "",
    state,
    attempt: n(r.run_attempt) ?? 1,
    created,
    started: ms(r.run_started_at),
    // A completed run's last update is its end; the API names no other.
    finished: r.status === "completed" ? ms(r.updated_at) : null,
    url: s(r.html_url),
  };
}

/** `GET …/actions/runs` (or a workflow's runs). */
export function parseGithubRuns(text: string): CiRun[] | null {
  const v = json(text);
  if (!isObj(v) || !Array.isArray(v.workflow_runs)) return null;
  return v.workflow_runs.map(githubRun).filter((r): r is CiRun => r !== null);
}

/** `GET …/actions/runs/{id}`. */
export function parseGithubRun(text: string): CiRun | null {
  return githubRun(json(text));
}

/** `GET …/actions/runs/{id}/jobs`. */
export function parseGithubJobs(text: string): CiJob[] | null {
  const v = json(text);
  if (!isObj(v) || !Array.isArray(v.jobs)) return null;
  const out: CiJob[] = [];
  for (const j of v.jobs) {
    if (!isObj(j)) continue;
    const jobId = id(j.id);
    if (!jobId) continue;
    const steps: CiStep[] = Array.isArray(j.steps)
      ? j.steps.filter(isObj).map((st, i) => ({
          number: n(st.number) ?? i + 1,
          name: s(st.name) ?? "",
          state: githubState(st.status, st.conclusion),
          started: ms(st.started_at),
          finished: ms(st.completed_at),
        }))
      : [];
    out.push({
      id: jobId,
      name: s(j.name) ?? jobId,
      stage: null,
      state: githubState(j.status, j.conclusion),
      created: ms(j.created_at),
      started: ms(j.started_at),
      finished: ms(j.completed_at),
      steps,
      url: s(j.html_url),
      allowFailure: false,
      downstream: null,
    });
  }
  return out;
}

export interface CiWorkflow {
  name: string;
  /** Repository-relative: `.github/workflows/ci.yml`. */
  path: string;
}

/** `GET …/actions/workflows`. */
export function parseGithubWorkflows(text: string): CiWorkflow[] | null {
  const v = json(text);
  if (!isObj(v) || !Array.isArray(v.workflows)) return null;
  return v.workflows
    .filter(isObj)
    .map((w) => ({ name: s(w.name) ?? "", path: s(w.path) ?? "" }))
    .filter((w) => w.path.startsWith(".github/") || w.path.startsWith(".gitea/") || w.path.startsWith(".forgejo/"));
}

function gitlabRun(p: unknown): CiRun | null {
  if (!isObj(p)) return null;
  const runId = id(p.id);
  const created = ms(p.created_at);
  if (!runId || created === null) return null;
  const state = gitlabState(p.status);
  const commit = isObj(p.commit) ? p.commit : null;
  return {
    id: runId,
    forge: "gitlab",
    number: n(p.iid),
    workflow: s(p.name) ?? "",
    file: null,
    title: commit ? s(commit.title) : null,
    branch: s(p.ref),
    sha: s(p.sha) ?? "",
    event: s(p.source) ?? "",
    state,
    attempt: 1,
    created,
    started: ms(p.started_at),
    finished: ms(p.finished_at),
    url: s(p.web_url),
  };
}

/** `GET projects/:p/pipelines`. */
export function parseGitlabPipelines(text: string): CiRun[] | null {
  const v = json(text);
  if (!Array.isArray(v)) return null;
  return v.map(gitlabRun).filter((r): r is CiRun => r !== null);
}

/** `GET projects/:p/pipelines/:id`. */
export function parseGitlabPipeline(text: string): CiRun | null {
  return gitlabRun(json(text));
}

function gitlabJob(j: Obj): CiJob | null {
  const jobId = id(j.id);
  if (!jobId) return null;
  const down = isObj(j.downstream_pipeline) ? j.downstream_pipeline : null;
  return {
    id: jobId,
    name: s(j.name) ?? jobId,
    stage: s(j.stage),
    state: gitlabState(j.status),
    created: ms(j.created_at),
    started: ms(j.started_at),
    finished: ms(j.finished_at),
    steps: [],
    url: s(j.web_url),
    allowFailure: j.allow_failure === true,
    downstream: down && id(down.id) ? { id: String(down.id), project: id(down.project_id) } : null,
  };
}

/** `GET projects/:p/pipelines/:id/jobs` or `…/bridges`. */
export function parseGitlabJobs(text: string): CiJob[] | null {
  const v = json(text);
  if (!Array.isArray(v)) return null;
  return v.filter(isObj).map(gitlabJob).filter((j): j is CiJob => j !== null);
}

/** `gh api repos/:o/:r/commits/:ref` → the commit's SHA. */
export function parseCommitSha(text: string): string | null {
  const v = json(text);
  const sha = isObj(v) ? s(v.sha) : null;
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// ── The log ──────────────────────────────────────────────────────────────────

export interface LogLine {
  text: string;
  /** The runner marked it an error (`##[error]`), or it reads as one. */
  error: boolean;
}

export interface LogTail {
  lines: LogLine[];
  /** Lines in the whole log. */
  total: number;
}

/** An ANSI escape (colour, erase): the escape character itself is spelled out, not written into a regex. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
const SECTION = /section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?\r?/g;

/**
 * A job's log as people read it: the runner's timestamps, colours and GitLab's
 * section markers taken off, a line overwritten by `\r` shown as it ended.
 */
export function cleanLog(text: string): string[] {
  return text
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((raw) => {
      const line = raw.replace(SECTION, "").replace(ANSI, "").replace(/\r$/, "");
      const at = line.lastIndexOf("\r");
      return (at >= 0 ? line.slice(at + 1) : line).replace(STAMP, "");
    });
}

/** Whether a log line is where it went wrong. */
export const isErrorLine = (line: string): boolean =>
  line.startsWith("##[error]") || /^(?:ERROR|Error|error)(?:\[|:| )/.test(line) || /\bFAIL(?:ED)?\b/.test(line);

/** The last `count` lines of a log, the error lines marked. */
export function logTail(text: string, count: number): LogTail {
  const lines = cleanLog(text);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return {
    total: lines.length,
    lines: lines.slice(-count).map((l) => ({ text: l.replace(/^##\[(error|warning|notice)\]/, ""), error: isErrorLine(l) })),
  };
}

/**
 * A path and line the log names in this repository (`src/x.ts:48:31`), for
 * "go to the line": the first that `exists` says is a file of it.
 */
export function logPlace(lines: readonly LogLine[], exists: (path: string) => boolean): { path: string; line: number } | null {
  return logPlaces(lines).find((p) => exists(p.path)) ?? null;
}

/** The repository-relative places a log names, the last first, each once — asked of git one by one. */
export function logPlaces(lines: readonly LogLine[]): { path: string; line: number }[] {
  const re = /(?:^|[\s(❯>'"])((?:\.\/)?[\w.@/-]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?/g;
  const out: { path: string; line: number }[] = [];
  for (const l of [...lines].reverse()) {
    for (const m of l.text.matchAll(re)) {
      const path = m[1].replace(/^\.\//, "");
      if (!path.startsWith("/") && !path.includes("..") && !out.some((p) => p.path === path)) out.push({ path, line: Number(m[2]) });
    }
  }
  return out;
}

// ── Why a call failed ────────────────────────────────────────────────────────

/** What a failed call means to the person: each has its own words and its own way out. */
export type CiProblem = "missing" | "signedOut" | "notFound" | "rateLimit" | "offline" | "failed";

export interface CiFailure {
  kind: CiProblem;
  /** The program's own first line, for "failed" and the journal. */
  text: string;
}

/** Why a `gh`/`glab` call did not answer; null — it did. */
export function failureOf(out: { exitCode: number; stdout: string; stderr: string }): CiFailure | null {
  if (out.exitCode === 0) return null;
  const said = `${out.stderr}\n${out.stdout}`;
  const text =
    out.stderr
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ??
    out.stdout.trim().split("\n")[0] ??
    "";
  const kind: CiProblem =
    out.exitCode === 127
      ? "missing"
      : out.exitCode === -1
        ? "offline"
        : /auth login|not logged|logged in to no|401|bad credentials|requires authentication|no token/i.test(said)
          ? "signedOut"
          : /rate limit/i.test(said)
            ? "rateLimit"
            : /HTTP 404|404 not found|"Not Found"|404 Project Not Found/i.test(said)
              ? "notFound"
              : /could not resolve|no such host|dial tcp|connection refused|network is unreachable|timed? ?out|tls|x509|certificate/i.test(said)
                ? "offline"
                : "failed";
  return { kind, text: text.slice(0, 300) };
}
