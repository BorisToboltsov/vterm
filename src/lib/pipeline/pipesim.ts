// What a pipeline does for an event (ADR 0068): which jobs it starts, which it
// leaves out and why, where it stops for a person, and whether it is created at
// all. GitHub: `on:` filters, then each job's `if:` over the event's contexts,
// a job whose `needs` were skipped skipped too unless its `if:` says otherwise.
// GitLab: `workflow: rules`, then each job's `rules` (first match) or
// `only`/`except`, a `needs` on a job left out failing the whole pipeline.
//
// The plan is the success path: every job that starts is taken to succeed. What
// the file cannot decide — changed files, secrets, project variables — is "?",
// with what it hangs on named.

import {
  dependsOn,
  topoJobs,
  type GhTrigger,
  type GlOnly,
  type GlRule,
  type JobWhen,
  type PipeJob,
  type Pipeline,
} from "./pipeline";
import { evalGithub, evalGitlab, ghRefFilter, hasStatusCheck, safeRegex, truth, UNKNOWN, type ExprValue } from "./pipexpr";

export type EventKind = "push" | "tag" | "pr" | "schedule" | "manual" | "call";

/** An event to play: what happened, and on which branch or tag. */
export interface PipeEvent {
  kind: EventKind;
  /** The branch pushed to, the tag, or — for a pull/merge request — the target branch. */
  ref: string;
  /** The repository's default branch (`$CI_DEFAULT_BRANCH`). */
  defaultBranch: string;
}

export type ReasonCode =
  | "noCondition"
  | "condTrue"
  | "condFalse"
  | "condUnknown"
  | "condInvalid"
  | "needSkipped"
  | "needUnknown"
  | "triggerOff"
  | "triggerPaths"
  | "triggerOn"
  | "calledOnly"
  | "workflowRule"
  | "workflowNever"
  | "workflowNone"
  | "workflowUnknown"
  | "ruleMatched"
  | "ruleNever"
  | "ruleNone"
  | "ruleUnknown"
  | "onlyMatched"
  | "onlyMissed"
  | "exceptMatched"
  | "onlyUnknown"
  | "defaultRefs"
  | "whenNever"
  | "onFailure"
  | "needMissing"
  | "noJobs";

export interface Reason {
  code: ReasonCode;
  params: Record<string, string | number>;
}

export interface JobVerdict {
  /** Starts (true), is left out (false), or the file cannot say ("?"). */
  run: true | false | "?";
  reason: Reason;
  /** Where the run stops for a person: a manual job, an environment's approval. */
  gate: "manual" | "approval" | null;
  delayed: string | null;
  allowFailure: boolean;
  /** The verdict makes the pipeline invalid (GitLab `needs` on a job left out). */
  error: boolean;
}

export interface Plan {
  created: true | false | "?";
  /** Why the pipeline is or is not created; null when there is nothing to say. */
  reason: Reason | null;
  /** The pipeline is invalid for this event: GitLab refuses to create it. */
  invalid: boolean;
  jobs: Map<string, JobVerdict>;
}

const reason = (code: ReasonCode, params: Reason["params"] = {}): Reason => ({ code, params });
const verdict = (run: JobVerdict["run"], why: Reason, extra: Partial<JobVerdict> = {}): JobVerdict => ({
  run,
  reason: why,
  gate: null,
  delayed: null,
  allowFailure: false,
  error: false,
  ...extra,
});

/** A concrete name a glob filter accepts, for an event button (`v*` → `v1.0.0`). */
export function sampleRef(pattern: string | undefined, fallback: string): string {
  if (!pattern || pattern.startsWith("!")) return fallback;
  if (!/[*?[\]+]/.test(pattern)) return pattern;
  const guess = pattern.replace(/\*\*?/g, "1.0.0").replace(/\?/g, "1").replace(/\[[^\]]*\]/g, "1").replace(/\+/g, "");
  return ghRefFilter([pattern])(guess) ? guess : fallback;
}

/** The events worth a button for this pipeline: those its triggers name, GitLab's usual five. */
export function eventPresets(pipeline: Pick<Pipeline, "kind" | "triggers">, defaultBranch = "main"): PipeEvent[] {
  const ev = (kind: EventKind, ref: string): PipeEvent => ({ kind, ref, defaultBranch });
  if (pipeline.kind === "gitlab") {
    return [ev("push", defaultBranch), ev("pr", defaultBranch), ev("tag", "v1.0.0"), ev("schedule", defaultBranch), ev("manual", defaultBranch)];
  }
  const out: PipeEvent[] = [];
  const add = (e: PipeEvent) => {
    if (!out.some((o) => o.kind === e.kind && o.ref === e.ref)) out.push(e);
  };
  for (const t of pipeline.triggers) {
    if (t.event === "push") {
      const branchOnly = t.tags !== null && t.branches === null && t.branchesIgnore === null;
      if (!branchOnly) add(ev("push", sampleRef(t.branches?.[0], defaultBranch)));
      if (t.tags !== null) add(ev("tag", sampleRef(t.tags[0], "v1.0.0")));
    } else if (t.event === "pull_request" || t.event === "pull_request_target") {
      add(ev("pr", sampleRef(t.branches?.[0], defaultBranch)));
    } else if (t.event === "schedule") add(ev("schedule", defaultBranch));
    else if (t.event === "workflow_dispatch") add(ev("manual", defaultBranch));
    else if (t.event === "workflow_call") add(ev("call", defaultBranch));
  }
  if (out.length === 0) add(ev("push", defaultBranch));
  return out;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

const GH_EVENT: Record<EventKind, string[]> = {
  push: ["push"],
  tag: ["push"],
  pr: ["pull_request", "pull_request_target"],
  schedule: ["schedule"],
  manual: ["workflow_dispatch"],
  call: ["workflow_call"],
};

/** Whether a trigger fires for the event: true, false, or "?" when it filters on paths. */
function triggerFires(t: GhTrigger, e: PipeEvent): boolean | "?" {
  if (!GH_EVENT[e.kind].includes(t.event)) return false;
  if (e.kind === "push" || e.kind === "tag") {
    const [only, ignore, otherOnly, otherIgnore] =
      e.kind === "push" ? [t.branches, t.branchesIgnore, t.tags, t.tagsIgnore] : [t.tags, t.tagsIgnore, t.branches, t.branchesIgnore];
    if (only === null && ignore === null && (otherOnly !== null || otherIgnore !== null)) return false;
    if (only !== null && !ghRefFilter(only)(e.ref)) return false;
    if (ignore !== null && ghRefFilter(ignore)(e.ref)) return false;
  } else if (e.kind === "pr") {
    if (t.branches !== null && !ghRefFilter(t.branches)(e.ref)) return false;
    if (t.branchesIgnore !== null && ghRefFilter(t.branchesIgnore)(e.ref)) return false;
  }
  return t.paths ? "?" : true;
}

function githubContext(e: PipeEvent, pipeline: Pipeline, job: PipeJob, needs: Map<string, JobVerdict>, inputs: Record<string, string>) {
  const names: Record<EventKind, ExprValue> = { push: "push", tag: "push", pr: "pull_request", schedule: "schedule", manual: "workflow_dispatch", call: UNKNOWN };
  const event = names[e.kind];
  const ref = e.kind === "tag" ? `refs/tags/${e.ref}` : e.kind === "pr" ? "refs/pull/1/merge" : `refs/heads/${e.ref}`;
  const github: Record<string, ExprValue> = {
    event_name: event,
    ref: e.kind === "call" ? UNKNOWN : ref,
    ref_name: e.kind === "call" ? UNKNOWN : e.kind === "pr" ? "1/merge" : e.ref,
    ref_type: e.kind === "tag" ? "tag" : e.kind === "call" ? UNKNOWN : "branch",
    base_ref: e.kind === "pr" ? e.ref : e.kind === "call" ? UNKNOWN : "",
    head_ref: e.kind === "pr" || e.kind === "call" ? UNKNOWN : "",
  };
  const env = { ...pipeline.variables, ...job.vars };
  return (path: string[]): ExprValue => {
    // Context and `github` property names are read as GitHub reads them: in any case.
    const [head, a, b, c] = path.map((part, i) => (i === 0 || (i === 1 && path[0].toLowerCase() === "github") ? part.toLowerCase() : part));
    if (head === "github") {
      if (a === "event" && b === "pull_request" && c === "base" && path[4] === "ref") return e.kind === "pr" ? e.ref : null;
      return a !== undefined && a in github ? github[a] : UNKNOWN;
    }
    if (head === "env" && a !== undefined) return a in env ? env[a] : UNKNOWN;
    if (head === "inputs" && a !== undefined) return a in inputs ? inputs[a] : UNKNOWN;
    if (head === "needs" && a !== undefined && b === "result") {
      const v = needs.get(a);
      if (!v) return UNKNOWN;
      return v.run === true ? "success" : v.run === false ? "skipped" : UNKNOWN;
    }
    return UNKNOWN;
  };
}

function planGithub(pipeline: Pipeline, e: PipeEvent, called: boolean): Plan {
  const jobs = new Map<string, JobVerdict>();
  let created: Plan["created"] = true;
  let why: Reason | null = null;
  if (!called) {
    const fires = pipeline.triggers.map((t) => triggerFires(t, e));
    created = fires.includes(true) ? true : fires.includes("?") ? "?" : false;
    if (created === false) why = reason(pipeline.callable ? "calledOnly" : "triggerOff", { event: GH_EVENT[e.kind][0] });
    else if (created === "?") why = reason("triggerPaths");
    else why = reason("triggerOn", { event: GH_EVENT[e.kind][0] });
  }
  const inputs = e.kind === "manual" || e.kind === "call" ? Object.assign({}, ...pipeline.triggers.map((t) => t.inputs)) : {};
  for (const job of topoJobs(pipeline)) {
    if (created === false) {
      jobs.set(job.id, verdict(false, why ?? reason("triggerOff", { event: GH_EVENT[e.kind][0] })));
      continue;
    }
    const needs = (job.needs ?? []).map((n) => n.job).filter((id) => jobs.has(id));
    const skipped = needs.find((id) => jobs.get(id)!.run === false);
    const unsure = needs.find((id) => jobs.get(id)!.run === "?");
    const extra: Partial<JobVerdict> = { gate: job.environment ? "approval" : null, allowFailure: job.allowFailure };
    const cond = job.condition;
    const status = cond !== null && hasStatusCheck(cond);
    if (!status && skipped) {
      jobs.set(job.id, verdict(false, reason("needSkipped", { need: skipped }), extra));
      continue;
    }
    let run: JobVerdict["run"] = true;
    let why2 = reason("noCondition");
    if (cond !== null) {
      const success: ExprValue = skipped ? false : unsure ? UNKNOWN : true;
      const res = evalGithub(cond, { lookup: githubContext(e, pipeline, job, jobs, inputs), success });
      const t = truth(res.value);
      if (res.invalid) [run, why2] = ["?", reason("condInvalid", { cond })];
      else if (t === UNKNOWN) [run, why2] = ["?", reason("condUnknown", { cond, what: res.unknowns.join(", ") })];
      else [run, why2] = t ? [true, reason("condTrue", { cond })] : [false, reason("condFalse", { cond })];
    }
    if (run === true && !status && unsure) [run, why2] = ["?", reason("needUnknown", { need: unsure })];
    if (run === true && created === "?") run = "?";
    jobs.set(job.id, verdict(run, why2, extra));
  }
  return { created, reason: why, invalid: false, jobs };
}

// ── GitLab ───────────────────────────────────────────────────────────────────

/** The variables GitLab sets for the event; the others of `CI_` are not known here. */
function gitlabVars(e: PipeEvent): Record<string, string | null> {
  const branch = e.kind === "push" || e.kind === "schedule" || e.kind === "manual" ? e.ref : null;
  const source = { push: "push", tag: "push", pr: "merge_request_event", schedule: "schedule", manual: "web", call: "parent_pipeline" }[e.kind];
  const refName = e.kind === "pr" ? null : e.ref;
  return {
    CI_PIPELINE_SOURCE: source,
    CI_COMMIT_BRANCH: branch,
    CI_COMMIT_TAG: e.kind === "tag" ? e.ref : null,
    CI_COMMIT_REF_NAME: refName,
    CI_COMMIT_REF_PROTECTED: null,
    CI_DEFAULT_BRANCH: e.defaultBranch,
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: e.kind === "pr" ? e.ref : null,
    CI_MERGE_REQUEST_ID: null,
    CI_MERGE_REQUEST_IID: null,
    CI_OPEN_MERGE_REQUESTS: null,
    CI_PIPELINE_TRIGGERED: null,
  };
}

const UNSET_WHEN_MR = new Set(["CI_COMMIT_REF_NAME", "CI_MERGE_REQUEST_ID", "CI_MERGE_REQUEST_IID"]);

function varsFor(e: PipeEvent, pipeline: Pipeline, job: PipeJob | null) {
  const predefined = gitlabVars(e);
  const own: Record<string, string> = { ...pipeline.variables, ...(job?.vars ?? {}) };
  return (name: string): string | null | typeof UNKNOWN => {
    if (name in own) return /\$/.test(own[name]) ? UNKNOWN : own[name];
    if (name in predefined) {
      // In a merge request pipeline these are set, but to what the file cannot say.
      if (e.kind === "pr" && UNSET_WHEN_MR.has(name)) return UNKNOWN;
      if (e.kind === "pr" && name === "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME") return UNKNOWN;
      return predefined[name];
    }
    if (name === "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME") return e.kind === "pr" ? UNKNOWN : null;
    if (e.kind !== "pr" && name.startsWith("CI_MERGE_REQUEST_")) return null;
    return UNKNOWN;
  };
}

type RuleOutcome = { match: true; index: number; rule: GlRule } | { match: false } | { match: "?"; index: number; what: string };

/** The first rule that matches, as GitLab picks it. */
function firstRule(rules: readonly GlRule[], vars: ReturnType<typeof varsFor>): RuleOutcome {
  for (const [index, rule] of rules.entries()) {
    let cond: boolean | typeof UNKNOWN = true;
    let what = "";
    if (rule.if !== null) {
      const res = evalGitlab(rule.if, vars);
      cond = res.invalid ? UNKNOWN : truth(res.value);
      what = res.invalid ? "if" : res.unknowns.join(", ");
    }
    if (cond === false) continue;
    if (rule.changes || rule.exists) {
      return { match: "?", index: index + 1, what: rule.changes ? "changes" : "exists" };
    }
    if (cond === UNKNOWN) return { match: "?", index: index + 1, what };
    return { match: true, index: index + 1, rule };
  }
  return { match: false };
}

const REF_KEYWORDS: Record<string, (e: PipeEvent) => boolean> = {
  branches: (e) => e.kind === "push" || e.kind === "schedule" || e.kind === "manual",
  tags: (e) => e.kind === "tag",
  merge_requests: (e) => e.kind === "pr",
  schedules: (e) => e.kind === "schedule",
  web: (e) => e.kind === "manual",
  pushes: (e) => e.kind === "push" || e.kind === "tag",
  api: () => false,
  triggers: () => false,
  pipelines: (e) => e.kind === "call",
  external: () => false,
  external_pull_requests: () => false,
  chat: () => false,
};

/** Whether `only`/`except` lets the event in: true, false, or "?" (changes, unknown variables). */
function onlyMatches(o: GlOnly, e: PipeEvent, vars: ReturnType<typeof varsFor>): { hit: boolean | "?"; what: string } {
  let refs: boolean | "?" = o.refs.length === 0;
  for (const r of o.refs) {
    const kw = REF_KEYWORDS[r];
    let hit: boolean;
    if (kw) hit = kw(e);
    else if (e.kind === "pr") hit = false;
    else if (r.startsWith("/") && r.lastIndexOf("/") > 0) {
      const re = safeRegex(r.slice(1, r.lastIndexOf("/")), r.slice(r.lastIndexOf("/") + 1));
      if (!re) {
        refs = refs === true ? true : "?";
        continue;
      }
      hit = re.test(e.ref);
    } else hit = r === e.ref;
    if (hit) refs = true;
  }
  if (refs === false) return { hit: false, what: "" };
  let what = "";
  let varsHit: boolean | "?" = o.variables.length === 0;
  for (const v of o.variables) {
    const res = evalGitlab(v, vars);
    const t = res.invalid ? UNKNOWN : truth(res.value);
    if (t === true) varsHit = true;
    else if (t === UNKNOWN && varsHit !== true) {
      varsHit = "?";
      what = res.unknowns.join(", ") || v;
    }
  }
  if (varsHit === false) return { hit: false, what: "" };
  if (o.changes) return { hit: "?", what: "changes" };
  if (refs === "?" || varsHit === "?") return { hit: "?", what: what || "regex" };
  return { hit: true, what: "" };
}

function gitlabJob(job: PipeJob, e: PipeEvent, pipeline: Pipeline): JobVerdict {
  const vars = varsFor(e, pipeline, job);
  let when: JobWhen = job.when;
  let allowFailure = job.allowFailure;
  let run: JobVerdict["run"] = true;
  let why: Reason;
  if (job.rules) {
    const r = firstRule(job.rules, vars);
    if (r.match === false) return verdict(false, reason("ruleNone"));
    if (r.match === "?") {
      run = "?";
      why = reason("ruleUnknown", { n: r.index, what: r.what });
    } else {
      when = r.rule.when ?? job.when;
      if (r.rule.allowFailure !== null) allowFailure = r.rule.allowFailure;
      else if (when === "manual" && r.rule.when === "manual") allowFailure = false;
      if (when === "never") return verdict(false, reason("ruleNever", { n: r.index }));
      why = reason("ruleMatched", { n: r.index, when });
    }
  } else {
    const only = job.only ?? (job.except ? null : { refs: ["branches", "tags"], variables: [], changes: false });
    if (only) {
      const m = onlyMatches(only, e, vars);
      if (m.hit === false) return verdict(false, reason(job.only ? "onlyMissed" : "defaultRefs", { refs: only.refs.join(", ") }));
      if (m.hit === "?") {
        run = "?";
        why = reason("onlyUnknown", { what: m.what });
      } else why = reason(job.only ? "onlyMatched" : "noCondition", { refs: only.refs.join(", ") });
    } else why = reason("noCondition");
    if (job.except) {
      const m = onlyMatches(job.except, e, vars);
      if (m.hit === true) return verdict(false, reason("exceptMatched", { refs: job.except.refs.join(", ") }));
      if (m.hit === "?") {
        run = "?";
        why = reason("onlyUnknown", { what: m.what });
      }
    }
  }
  if (when === "never") return verdict(false, reason("whenNever"));
  if (when === "on_failure") return verdict(false, reason("onFailure"));
  return verdict(run, why, {
    gate: when === "manual" ? "manual" : null,
    delayed: when === "delayed" ? (job.startIn ?? "?") : null,
    allowFailure,
  });
}

function planGitlab(pipeline: Pipeline, e: PipeEvent, called: boolean): Plan {
  const jobs = new Map<string, JobVerdict>();
  let created: Plan["created"] = true;
  let why: Reason | null = null;
  if (pipeline.workflowRules && !called) {
    const r = firstRule(pipeline.workflowRules, varsFor(e, pipeline, null));
    if (r.match === false) [created, why] = [false, reason("workflowNone")];
    else if (r.match === "?") [created, why] = ["?", reason("workflowUnknown", { n: r.index, what: r.what })];
    else if (r.rule.when === "never") [created, why] = [false, reason("workflowNever", { n: r.index })];
    else why = reason("workflowRule", { n: r.index });
  }
  for (const job of pipeline.jobs) {
    jobs.set(job.id, created === false ? verdict(false, why!) : gitlabJob(job, e, pipeline));
  }
  let invalid = false;
  if (created !== false) {
    for (const job of pipeline.jobs) {
      const v = jobs.get(job.id)!;
      if (v.run === false) continue;
      for (const need of job.needs ?? []) {
        const target = jobs.get(need.job);
        if (!target || need.optional) continue;
        if (target.run === false) {
          jobs.set(job.id, { ...v, run: v.run === true ? false : v.run, reason: reason("needMissing", { need: need.job }), error: true });
          if (v.run === true) invalid = true;
        } else if (target.run === "?" && v.run === true) jobs.set(job.id, { ...v, run: "?", reason: reason("needUnknown", { need: need.job }) });
      }
    }
    const any = [...jobs.values()].map((v) => v.run);
    if (!invalid && !any.includes(true) && !any.includes("?")) [created, why] = [false, reason("noJobs")];
    else if (!invalid && !any.includes(true)) created = "?";
  }
  if (invalid) created = false;
  return { created, reason: why, invalid, jobs };
}

/** The plan of `pipeline` for `event`. `called` — run as another's child or reusable workflow. */
export function planFor(pipeline: Pipeline, event: PipeEvent, called = false): Plan {
  return pipeline.kind === "github" ? planGithub(pipeline, event, called) : planGitlab(pipeline, event, called);
}

/**
 * What a job waits for in the playback: what it depends on, among the jobs that
 * surely start — one the file cannot decide is played as not there.
 */
export function runDeps(pipeline: Pipeline, plan: Plan, job: PipeJob): string[] {
  const present = (id: string) => plan.jobs.get(id)?.run === true;
  return dependsOn(pipeline, job, present).filter(present);
}
