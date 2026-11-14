// A run laid over its file's schema (ADR 0069). The forge says which jobs ran
// and when, not how they wait on each other — that is in the file. So a job of
// the run is matched to the job of the file by the name the forge gives it:
// GitHub names a matrix copy `build (ubuntu, 20)` or by its `name:` template,
// a job of a called workflow `caller / job`; GitLab names copies `rspec 1/3`
// and `rspec: [ruby, 3]`. What matches nothing is listed, never forced onto a
// job. The time view and its critical path come from the run's own times: a
// job is made when what it waits for is over, so what ended last before it was
// made is what held it up. Pure.

import type { Pipeline, PipeJob } from "../pipeline/pipeline";
import type { RunState } from "../pipeline/pipeplay";
import type { CiJob, CiRun, CiState } from "./ciparse";

/** A name the forge may give a job's copy: a literal, or a pattern where an expression stood. */
type Matcher = { exact: string } | { re: RegExp };

const EXPR = /\$\{\{\s*([^}]*?)\s*\}\}/g;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `${{ matrix.os }}` and `${{ matrix['os'] }}` → the copy's value; any other expression → unknown. */
function expand(template: string, combo: Readonly<Record<string, string>> | null): Matcher {
  let unknown = false;
  const parts: string[] = [];
  let last = 0;
  for (const m of template.matchAll(EXPR)) {
    parts.push(escapeRe(template.slice(last, m.index)));
    const key = m[1].match(/^matrix(?:\.([\w-]+)|\[\s*['"]([^'"]+)['"]\s*\])$/);
    const val = key && combo ? combo[key[1] ?? key[2]] : undefined;
    if (val !== undefined) parts.push(escapeRe(val));
    else {
      unknown = true;
      parts.push(".*?");
    }
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(escapeRe(template.slice(last)));
  if (!unknown) return { exact: parts.join("").replace(/\\(.)/g, "$1") };
  return { re: new RegExp(`^${parts.join("")}$`) };
}

/** The names a job of the file may have in a run. */
export function runNames(job: PipeJob, kind: Pipeline["kind"]): Matcher[] {
  if (kind === "gitlab") {
    const items = job.matrix?.items;
    if (!items) return job.matrix ? [{ re: new RegExp(`^${escapeRe(job.id)}(?: \\d+/\\d+|: \\[.*\\])$`) }] : [{ exact: job.id }];
    if (job.matrix?.axes.startsWith("parallel: matrix")) return items.map((i) => ({ exact: `${job.id}: [${i.split(" · ").join(", ")}]` }));
    return items.map((i) => ({ exact: i }));
  }
  const template = job.title ?? null;
  const base = template ?? job.id;
  const combos = job.matrix?.combos;
  if (combos?.length) {
    return combos.map((c) =>
      template?.includes("${{")
        ? expand(template, c)
        : { exact: `${base} (${Object.values(c).filter((v) => v !== "").join(", ")})` },
    );
  }
  if (job.matrix) return [{ re: new RegExp(`^${escapeRe(base)} \\(.*\\)$`) }, expand(base, null)];
  return [expand(base, null)];
}

/** Where a job of the run stands in the file: its job, and inside a called workflow, under what name. */
export interface Placed {
  job: CiJob;
  /** The job of the file; null — none matches. */
  pipelineJob: string | null;
  /** The name inside a called workflow (`caller / inner` → `inner`); null — a job of the file itself. */
  inner: string | null;
}

function matches(m: Matcher, name: string): boolean {
  return "exact" in m ? m.exact === name : m.re.test(name);
}

function callPart(m: Matcher, name: string): string | null {
  const at = name.indexOf(" / ");
  for (let i = at; i >= 0; i = name.indexOf(" / ", i + 1)) {
    if (matches(m, name.slice(0, i))) return name.slice(i + 3);
  }
  return null;
}

/** Each job of the run, placed on the file's jobs. */
export function placeJobs(pipeline: Pipeline, jobs: readonly CiJob[]): Placed[] {
  const names = pipeline.jobs.map((j) => ({ job: j, names: runNames(j, pipeline.kind) }));
  return jobs.map((job) => {
    for (const { job: pj, names: ms } of names) {
      if (ms.some((m) => matches(m, job.name))) return { job, pipelineJob: pj.id, inner: null };
    }
    if (pipeline.kind === "github") {
      for (const { job: pj, names: ms } of names) {
        if (!pj.call) continue;
        for (const m of ms) {
          const inner = callPart(m, job.name);
          if (inner !== null) return { job, pipelineJob: pj.id, inner };
        }
      }
    }
    return { job, pipelineJob: null, inner: null };
  });
}

/** How one state of the forge is drawn on the schema. */
export function runStateOf(s: CiState, allowFailure = false): RunState {
  switch (s) {
    case "queued":
      return "wait";
    case "running":
      return "run";
    case "waiting":
    case "manual":
      return "gate";
    case "ok":
      return "ok";
    case "failed":
      return allowFailure ? "warn" : "fail";
    case "neutral":
      return "warn";
    case "cancelled":
    case "skipped":
      return "skip";
  }
}

const PRECEDENCE: RunState[] = ["fail", "run", "gate", "wait", "warn", "ok", "skip"];

/** One state for the copies and called jobs of a file's job: the worst going on. */
export function worst(states: readonly RunState[]): RunState {
  for (const s of PRECEDENCE) if (states.includes(s)) return s;
  return "idle";
}

/** What a run did to each job of the file, and what of it the file does not explain. */
export interface RunOnSchema {
  states: Record<string, RunState>;
  /** The run's jobs of each job of the file. */
  jobsOf: Record<string, CiJob[]>;
  /** Jobs of the run no job of the file names. */
  unmatched: CiJob[];
  /** Jobs of the file the run did not have — skipped by its conditions, or not of this version. */
  absent: string[];
}

export function runOnSchema(pipeline: Pipeline, jobs: readonly CiJob[]): RunOnSchema {
  const placed = placeJobs(pipeline, jobs);
  const jobsOf: Record<string, CiJob[]> = {};
  const unmatched: CiJob[] = [];
  for (const p of placed) {
    if (p.pipelineJob === null) unmatched.push(p.job);
    else (jobsOf[p.pipelineJob] ??= []).push(p.job);
  }
  const states: Record<string, RunState> = {};
  const absent: string[] = [];
  for (const j of pipeline.jobs) {
    const of = jobsOf[j.id];
    if (!of?.length) {
      states[j.id] = "skip";
      absent.push(j.id);
    } else states[j.id] = worst(of.map((x) => runStateOf(x.state, x.allowFailure)));
  }
  return { states, jobsOf, unmatched, absent };
}

// ── The time view ────────────────────────────────────────────────────────────

export interface TimeRow {
  key: string;
  label: string;
  /** 1 — a job inside a called workflow, under its caller's row. */
  depth: 0 | 1;
  /** null — the row of a call, standing for its jobs. */
  job: CiJob | null;
  state: CiState;
  created: number | null;
  started: number | null;
  /** null — still going (or the answer does not say). */
  finished: number | null;
  critical: boolean;
}

export interface Timeline {
  start: number;
  end: number;
  rows: TimeRow[];
  /** The critical path, first to last. */
  path: TimeRow[];
  /** What its jobs waited for a runner. */
  waited: number;
  /** Runner time of every job. */
  busy: number;
  /** The path is known only once the run is over. */
  done: boolean;
}

const end = (r: { finished: number | null }, now: number): number => r.finished ?? now;

/** A call's row: its jobs' span, their worst state. */
function callRow(key: string, label: string, kids: TimeRow[]): TimeRow {
  const of = (f: (r: TimeRow) => number | null) => kids.map(f).filter((x): x is number => x !== null);
  const created = of((r) => r.created);
  const started = of((r) => r.started);
  const finished = of((r) => r.finished);
  const order: CiState[] = ["failed", "running", "waiting", "queued", "manual", "cancelled", "neutral", "ok", "skipped"];
  const state = order.find((s) => kids.some((k) => k.state === s)) ?? "neutral";
  return {
    key,
    label,
    depth: 0,
    job: null,
    state,
    created: created.length ? Math.min(...created) : null,
    started: started.length ? Math.min(...started) : null,
    finished: finished.length === kids.length && kids.length ? Math.max(...finished) : null,
    critical: false,
  };
}

const leaf = (job: CiJob, label: string, depth: 0 | 1): TimeRow => ({
  key: job.id,
  label,
  depth,
  job,
  state: job.state,
  created: job.created,
  started: job.started,
  finished: job.finished,
  critical: false,
});

/**
 * The rows of a run in time: the file's jobs in the order written, a call's
 * jobs under it, what the file does not name at the end; and the path that
 * decided how long it took.
 */
export function timeline(run: CiRun, jobs: readonly CiJob[], pipeline: Pipeline | null, now: number): Timeline {
  const rows: TimeRow[] = [];
  const byStart = (a: CiJob, b: CiJob) => (a.started ?? a.created ?? Infinity) - (b.started ?? b.created ?? Infinity);
  const needs = new Map<string, string[]>();
  const placedOf = new Map<string, string>();
  if (pipeline) {
    const placed = placeJobs(pipeline, jobs);
    for (const p of placed) if (p.pipelineJob) placedOf.set(p.job.id, p.pipelineJob);
    for (const pj of pipeline.jobs) {
      needs.set(pj.id, (pj.needs ?? []).map((x) => x.job));
      const mine = placed.filter((p) => p.pipelineJob === pj.id);
      if (!mine.length) continue;
      const direct = mine.filter((p) => p.inner === null).map((p) => p.job).sort(byStart);
      const called = mine.filter((p) => p.inner !== null).sort((a, b) => byStart(a.job, b.job));
      for (const j of direct) rows.push(leaf(j, j.name, 0));
      if (called.length) {
        const kids = called.map((p) => leaf(p.job, p.inner ?? p.job.name, 1));
        rows.push(callRow(`call:${pj.id}`, pj.name, kids), ...kids);
      }
    }
    for (const p of placed.filter((x) => x.pipelineJob === null).map((x) => x.job).sort(byStart)) rows.push(leaf(p, p.name, 0));
  } else {
    for (const j of [...jobs].sort(byStart)) rows.push(leaf(j, j.name, 0));
  }

  const leaves = rows.filter((r) => r.job !== null);
  const known = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  const start = run.started ?? Math.min(run.created, ...known(leaves.map((r) => r.created)));
  const last = known(leaves.map((r) => (r.started === null ? null : end(r, now))));
  const stop = Math.max(start, run.finished ?? (last.length ? Math.max(...last) : now), ...last);
  const done = run.finished !== null && leaves.every((r) => r.finished !== null || r.started === null);

  // The path: from what ended last, back through what ended last before each was made.
  const path: TimeRow[] = [];
  if (done) {
    const ran = leaves.filter((r) => r.started !== null && r.finished !== null);
    let cur = ran.reduce<TimeRow | null>((a, r) => (!a || (r.finished ?? 0) > (a.finished ?? 0) ? r : a), null);
    while (cur) {
      path.unshift(cur);
      const at = cur.created ?? cur.started ?? 0;
      const mine = cur.job ? placedOf.get(cur.job.id) : undefined;
      const wanted = mine && cur.depth === 0 ? needs.get(mine) : undefined;
      const before = ran.filter(
        (r) =>
          r !== cur &&
          !path.includes(r) &&
          (r.finished ?? Infinity) <= at + 2000 &&
          (!wanted?.length || (r.job && wanted.includes(placedOf.get(r.job.id) ?? ""))),
      );
      cur = before.reduce<TimeRow | null>((a, r) => (!a || (r.finished ?? 0) > (a.finished ?? 0) ? r : a), null);
    }
    for (const r of path) r.critical = true;
  }
  const waited = path.reduce((a, r) => a + Math.max(0, (r.started ?? 0) - (r.created ?? r.started ?? 0)), 0);
  const busy = leaves.reduce((a, r) => a + (r.started === null ? 0 : Math.max(0, end(r, now) - r.started)), 0);
  return { start, end: stop, rows, path, waited, busy, done };
}

/** A span of time as it is said: `4 s`, `8 min 12 s` → parts for the caller to word. */
export function durationParts(ms: number): { h: number; m: number; s: number } {
  const t = Math.max(0, Math.round(ms / 1000));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

/** `m:ss` (`h:mm:ss` past an hour) — the compact duration of a row. */
export function clock(ms: number): string {
  const { h, m, s } = durationParts(ms);
  const two = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
