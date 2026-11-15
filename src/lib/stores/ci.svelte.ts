// The CI store (ADR 0069): every call to a forge goes through here — the CI
// panel's reads and writes, the schema's run, the Git history's badges, the pin
// of an action. Here lives what outlasts a panel: the last list of runs a
// session read (the Git badges show it) and the runs someone asked to watch.
//
// A watch is the one read that goes on with the panel hidden: the person asked
// for it ("tell me when it ends"), it asks one run every WATCH_MS, and it ends
// with the run — or with the tab (`forgetCi` in `closeTabFully`).

import { ciRun, connectionFiles, gitRun } from "../api";
import { diag } from "../api/diag";
import {
  authArgs,
  bridgesArgs,
  cancelArgs,
  dispatchArgs,
  jobsArgs,
  logArgs,
  pinArgs,
  pipelineArgs,
  rerunArgs,
  runArgs,
  runsArgs,
  workflowsArgs,
} from "../ci/ciapi";
import {
  failureOf,
  isActive,
  parseCommitSha,
  parseGithubJobs,
  parseGithubRun,
  parseGithubRuns,
  parseGithubWorkflows,
  parseGitlabJobs,
  parseGitlabPipeline,
  parseGitlabPipelines,
  type CiFailure,
  type CiJob,
  type CiRun,
  type CiWorkflow,
} from "../ci/ciparse";
import { isKnown, parseRemotes, pickRepo, repoRelative, reposOf, type Forge, type Repo, type RepoRemote } from "../ci/forge";
import { parentOf } from "../files/fspath";
import { repoRootArgs } from "../git/git";
import { cachedReader, loadGroup, type PipelineGroup } from "../pipeline/pipeload";
import { loadYaml } from "../pipeline/yamldoc";
import { t } from "../i18n";
import { settings } from "../settings/settings.svelte";
import { aboutSession } from "./diag.svelte";
import { notifyError, notifySuccess } from "./toasts.svelte";

/** A read's answer: the value, or why there is none. */
export type Answer<T> = { ok: true; value: T } | { ok: false; failure: CiFailure };

const fail = (kind: CiFailure["kind"], text: string): { ok: false; failure: CiFailure } => ({ ok: false, failure: { kind, text } });

/** How often a watched run is asked where it stands. */
export const WATCH_MS = 15_000;

async function ask(sessionId: string, args: string[], mirror = false, timeoutSecs = 25) {
  return ciRun(sessionId, args, timeoutSecs, mirror);
}

/** The repositories of the directory, from `git remote -v`; null — not a repository, or git said no. */
export async function repoRemotes(sessionId: string, cwd: string): Promise<RepoRemote[] | null> {
  const out = await gitRun(sessionId, cwd, ["remote", "-v"]);
  if (out.exitCode !== 0) return null;
  return reposOf(parseRemotes(out.stdout), settings.ciForges);
}

/** The repository a file is in and its forge (null — none known); null — not in a repository. */
export async function repoOfFile(sessionId: string, file: string): Promise<{ root: string; repo: Repo | null } | null> {
  const top = await gitRun(sessionId, parentOf(file), repoRootArgs());
  if (top.exitCode !== 0) return null;
  const root = top.stdout.trim();
  const found = pickRepo((await repoRemotes(sessionId, root)) ?? [], null);
  return { root, repo: isKnown(found) ? found : null };
}

/**
 * A file as it was at a run's commit, through git on the session's host — the
 * schema of a run is drawn from it (ADR 0069). null: the commit is not there
 * (not fetched) or the file did not exist in it.
 */
export async function fileAtCommit(sessionId: string, root: string, sha: string, file: string): Promise<string | null> {
  const rel = repoRelative(root, file);
  if (!rel || !/^[0-9a-f]{7,64}$/.test(sha)) return null;
  const out = await gitRun(sessionId, root, ["show", `${sha}:${rel}`]);
  return out.exitCode === 0 ? out.stdout : null;
}

/**
 * The pipelines of a repository (ADR 0070): its workflow files and GitLab
 * pipelines, read through the connection the session's files come through —
 * SFTP, or this computer for a local tab — by the schema's own loader, with its
 * budget and depth. Rejects only when the YAML parser does not load; a file
 * that cannot be read is in `failed`.
 */
export async function readPipelines(sessionId: string, local: boolean, root: string): Promise<PipelineGroup> {
  const Y = await loadYaml();
  const reader = cachedReader(connectionFiles(local ? null : sessionId, settings.sftp.maxOpenMb * 1024 * 1024));
  return loadGroup(Y, reader, [{ path: root, isDir: true }]);
}

/** The forge of a host, said by the user once (`settings.ciForges`). */
export function setHostForge(host: string, forge: Forge): void {
  settings.ciForges = { ...settings.ciForges, [host.toLowerCase()]: forge };
}

/** Whether the CLI is there and signed in to the host. */
export async function checkAuth(sessionId: string, repo: Repo): Promise<CiFailure | null> {
  const out = await ask(sessionId, authArgs(repo), false, 15);
  const failure = failureOf(out);
  // `auth status` answers 1 for "not signed in" without the words of a 401.
  return failure && failure.kind === "failed" ? { kind: "signedOut", text: failure.text } : failure;
}

function read<T>(out: { exitCode: number; stdout: string; stderr: string }, parse: (text: string) => T | null): Answer<T> {
  const failure = failureOf(out);
  if (failure) return { ok: false, failure };
  const value = parse(out.stdout);
  return value === null ? fail("failed", out.stdout.trim().split("\n")[0]?.slice(0, 300) ?? "") : { ok: true, value };
}

// ── The last list a session read — what the Git history marks its commits by ──

export const ciRuns = $state<{ bySession: Record<string, { repo: string; runs: CiRun[]; at: number }> }>({ bySession: {} });

const repoKey = (r: Repo) => `${r.host}/${r.path}`;

/** The runs of a commit, from the last list the session read of this repository. */
export function runsOfCommit(sessionId: string, repo: Repo | null, sha: string): CiRun[] {
  const snap = ciRuns.bySession[sessionId];
  if (!repo || !snap || snap.repo !== repoKey(repo)) return [];
  return snap.runs.filter((r) => r.sha === sha);
}

/** The latest runs of the repository (of a branch, of one workflow file). */
export async function readRuns(
  sessionId: string,
  repo: Repo,
  opts: { branch?: string | null; workflow?: string | null } = {},
): Promise<Answer<CiRun[]>> {
  const out = await ask(sessionId, runsArgs(repo, opts));
  const answer = read(out, repo.forge === "github" ? parseGithubRuns : parseGitlabPipelines);
  if (answer.ok && !opts.workflow) {
    ciRuns.bySession[sessionId] = { repo: repoKey(repo), runs: answer.value, at: Date.now() };
  }
  return answer;
}

export async function readRun(sessionId: string, repo: Repo, id: string): Promise<Answer<CiRun>> {
  const out = await ask(sessionId, runArgs(repo, id));
  return read(out, repo.forge === "github" ? parseGithubRun : parseGitlabPipeline);
}

/** A run's jobs; GitLab's with its trigger jobs, which start the pipelines below it. */
export async function readJobs(sessionId: string, repo: Repo, id: string): Promise<Answer<CiJob[]>> {
  if (repo.forge === "github") return read(await ask(sessionId, jobsArgs(repo, id)), parseGithubJobs);
  const [jobs, bridges] = await Promise.all([ask(sessionId, jobsArgs(repo, id)), ask(sessionId, bridgesArgs(repo, id))]);
  const a = read(jobs, parseGitlabJobs);
  if (!a.ok) return a;
  const b = read(bridges, parseGitlabJobs);
  return { ok: true, value: [...a.value, ...(b.ok ? b.value : [])] };
}

/** A job's whole log. */
export async function readLog(sessionId: string, repo: Repo, jobId: string): Promise<Answer<string>> {
  return read(await ask(sessionId, logArgs(repo, jobId), false, 40), (text) => text);
}

export async function readWorkflows(sessionId: string, repo: Repo): Promise<Answer<CiWorkflow[]>> {
  return read(await ask(sessionId, workflowsArgs(repo)), parseGithubWorkflows);
}

// ── What the panel does ──────────────────────────────────────────────────────

/** What a write is about, for the diagnostics: never the values a form carried, only how many. */
interface WriteAbout {
  forge: Forge;
  run?: string;
  ref?: string;
  fields?: number;
}

/** A write: said in the diagnostics before and after, in the journal after, recorded as `[ci]`. */
async function write(sessionId: string, what: string, args: string[], about: WriteAbout, done: string): Promise<CiFailure | null> {
  const { forge, run = null, ref = null, fields = null } = about;
  diag.info("ci", `${what} asked`, { forge, run, ref, fields }, aboutSession(sessionId));
  const out = await ask(sessionId, args, true, 30);
  const failure = failureOf(out);
  if (failure) {
    diag.warn("ci", `${what} did not happen: the forge said no`, { forge, run, ref, kind: failure.kind, said: failure.text }, aboutSession(sessionId));
    notifyError(t("ci.actionFailed", { text: failure.text || failure.kind }), { source: "ci", sessionId });
    return failure;
  }
  diag.info("ci", `${what} done`, { forge, run, ref }, aboutSession(sessionId));
  notifySuccess(done, { source: "ci", sessionId });
  return null;
}

const label = (run: CiRun) => `${run.workflow || run.branch || ""} #${run.number ?? run.id}`.trim();

/**
 * Run the failed jobs again, or the whole run. GitLab retries a pipeline's
 * failed jobs; the whole of it again is a new pipeline for the same ref.
 */
export function rerunRun(sessionId: string, repo: Repo, run: CiRun, failed: boolean): Promise<CiFailure | null> {
  const args = repo.forge === "gitlab" && !failed ? pipelineArgs(repo, run.branch ?? run.sha, {}) : rerunArgs(repo, run.id, failed);
  return write(sessionId, failed ? "rerun of the failed jobs" : "rerun of the run", args, { run: run.id, forge: repo.forge }, t(failed ? "ci.rerunFailedDone" : "ci.rerunDone", { run: label(run) }));
}

export function cancelRun(sessionId: string, repo: Repo, run: CiRun): Promise<CiFailure | null> {
  return write(sessionId, "cancel of the run", cancelArgs(repo, run.id), { run: run.id, forge: repo.forge }, t("ci.cancelDone", { run: label(run) }));
}

/**
 * Start a run by hand: a workflow's `workflow_dispatch` (GitHub, `file` named)
 * or a pipeline for the ref (GitLab). The values are not written to the
 * diagnostics — only how many there were.
 */
export function startRun(sessionId: string, repo: Repo, file: string | null, ref: string, values: Record<string, string>): Promise<CiFailure | null> {
  const args = repo.forge === "github" && file ? dispatchArgs(repo, file.split("/").pop() ?? file, ref, values) : pipelineArgs(repo, ref, values);
  return write(sessionId, "run started by hand", args, { forge: repo.forge, ref, fields: Object.keys(values).length }, t("ci.startDone", { ref }));
}

/** The commit an action's tag points at — asked of github.com, where actions live. */
export async function pinCommit(sessionId: string, repo: string, ref: string): Promise<Answer<string>> {
  return read(await ask(sessionId, pinArgs(repo, ref)), parseCommitSha);
}

// ── Watching a run ───────────────────────────────────────────────────────────

export interface CiWatch {
  sessionId: string;
  repo: Repo;
  runId: string;
  label: string;
  branch: string | null;
}

export const ciWatch = $state<{ list: CiWatch[] }>({ list: [] });
let timer: ReturnType<typeof setInterval> | null = null;

export const isWatched = (sessionId: string, runId: string): boolean =>
  ciWatch.list.some((w) => w.sessionId === sessionId && w.runId === runId);

function retime(): void {
  if (ciWatch.list.length && !timer) timer = setInterval(() => void checkWatched(), WATCH_MS);
  if (!ciWatch.list.length && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Tell when the run ends — even with the panel hidden, until it does. */
export function watchRun(sessionId: string, repo: Repo, run: CiRun): void {
  if (isWatched(sessionId, run.id) || !isActive(run.state)) return;
  ciWatch.list = [...ciWatch.list, { sessionId, repo, runId: run.id, label: label(run), branch: run.branch }];
  diag.info("ci", "a run is watched", { run: run.id }, aboutSession(sessionId));
  retime();
}

export function unwatchRun(sessionId: string, runId: string): void {
  ciWatch.list = ciWatch.list.filter((w) => !(w.sessionId === sessionId && w.runId === runId));
  retime();
}

let checking = false;

/** Ask each watched run once; one that ended is said and let go. */
export async function checkWatched(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    for (const w of [...ciWatch.list]) {
      const answer = await readRun(w.sessionId, w.repo, w.runId);
      if (!answer.ok) {
        // A watch that cannot ask any more (the CLI signed out, the run gone) ends with a word.
        if (answer.failure.kind !== "offline" && answer.failure.kind !== "rateLimit") {
          diag.warn("ci", "a watched run could not be asked: the watch ends", { run: w.runId, kind: answer.failure.kind }, aboutSession(w.sessionId));
          notifyError(t("ci.watchLost", { run: w.label }), { source: "ci", sessionId: w.sessionId });
          unwatchRun(w.sessionId, w.runId);
        }
        continue;
      }
      if (isActive(answer.value.state)) continue;
      unwatchRun(w.sessionId, w.runId);
      const run = answer.value;
      const ok = run.state === "ok";
      const text = t(ok ? "ci.watchOk" : "ci.watchEnded", { run: w.label, branch: w.branch ?? run.sha.slice(0, 7), state: t(`ci.state.${run.state}` as const) });
      if (ok) notifySuccess(text, { source: "ci", sessionId: w.sessionId });
      else notifyError(text, { source: "ci", sessionId: w.sessionId });
    }
  } finally {
    checking = false;
  }
}

// ── What the CI panel asked a file's schema to show ──────────────────────────

/**
 * What a schema is asked for: a run of the file (ADR 0069), the play of the
 * event that starts it, or the form to start it by hand (ADR 0070).
 */
export type SchemaAsk = { kind: "run"; repo: Repo; runId: string } | { kind: "play" } | { kind: "start" };

/** The ask of each file's schema, by session and path; `seq` — asked again. */
export const ciSchemaAsk = $state<{ by: Record<string, SchemaAsk & { seq: number }> }>({ by: {} });
const askKey = (sessionId: string, path: string) => `${sessionId}\n${path}`;
let askSeq = 0;

export function askOnSchema(sessionId: string, path: string, ask: SchemaAsk): void {
  ciSchemaAsk.by[askKey(sessionId, path)] = { ...ask, seq: ++askSeq };
}

export function askRunOnSchema(sessionId: string, path: string, repo: Repo, runId: string): void {
  askOnSchema(sessionId, path, { kind: "run", repo, runId });
}

/** What the schema of `path` was asked to show, if anything. */
export function schemaAskOf(sessionId: string | null, path: string): (SchemaAsk & { seq: number }) | null {
  return sessionId ? (ciSchemaAsk.by[askKey(sessionId, path)] ?? null) : null;
}

/** The tab is closed: its watches stop, its list goes. */
export function forgetCi(sessionId: string): void {
  delete ciRuns.bySession[sessionId];
  for (const key of Object.keys(ciSchemaAsk.by)) if (key.startsWith(`${sessionId}\n`)) delete ciSchemaAsk.by[key];
  if (ciWatch.list.some((w) => w.sessionId === sessionId)) {
    ciWatch.list = ciWatch.list.filter((w) => w.sessionId !== sessionId);
    retime();
  }
}
