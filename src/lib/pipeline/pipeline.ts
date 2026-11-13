// The pipeline a CI file describes (ADR 0068): one model for GitHub Actions and
// GitLab CI, built from the YAML by `ghactions.ts` / `gitlabci.ts`, read through
// the file's own connection by `pipeload.ts`, judged for an event by `pipesim.ts`
// and laid out by `pipelayout.ts`. Pure data — no DOM, no backend.
//
// What the file does not say stays unsaid (principle 5): a matrix taken from an
// expression has no copies here, a file of another project is "external", a
// condition that reads a secret is unknown — never a plausible guess.

export type PipelineKind = "github" | "gitlab";

/** Where a job is written: its file and its lines (1-based, inclusive). */
export interface SourceSpan {
  file: string;
  line: number;
  endLine: number;
}

export interface JobNeed {
  job: string;
  /** GitLab `optional: true`: a need that may be missing from the pipeline. */
  optional: boolean;
}

export interface JobMatrix {
  /** One label per copy ("ubuntu · 20", "rspec 2/3"), or null — the copies come from an expression. */
  items: string[] | null;
  /** The axes as the file names them: "os × node", "parallel: 3". */
  axes: string;
}

export interface JobCall {
  /** The called file as written: `./.github/workflows/e2e.yml`, `ci/child.yml`. */
  file: string;
  /** The called pipeline, once read; null — it was not. */
  pipeline: Pipeline | null;
  /** Why there is none: a file of another repository, or one that could not be read. */
  missing: "external" | "unread" | null;
  /**
   * The calling job ends with the called pipeline: a reusable workflow always; a
   * GitLab child pipeline only with `strategy: depend`/`mirror` — without it the
   * trigger job succeeds as soon as the child is created.
   */
  waits: boolean;
}

/** GitLab `when:` — GitHub jobs are all `on_success`. */
export type JobWhen = "on_success" | "manual" | "delayed" | "always" | "on_failure" | "never";

/** One GitLab rule, as written. */
export interface GlRule {
  if: string | null;
  /** The rule names `changes:` — which files changed is not known here. */
  changes: boolean;
  /** The rule names `exists:` — the repository is not looked at. */
  exists: boolean;
  when: JobWhen | null;
  allowFailure: boolean | null;
}

/** GitLab `only:` / `except:`. */
export interface GlOnly {
  refs: string[];
  variables: string[];
  changes: boolean;
}

export interface PipeJob {
  /** The key in the file: unique within its pipeline. */
  id: string;
  /** What to show: GitHub's `name:` when given, else the key. */
  name: string;
  /** GitLab stage; null on GitHub. */
  stage: string | null;
  /** Explicit `needs`; null — none written (GitLab: the earlier stages). */
  needs: JobNeed[] | null;
  matrix: JobMatrix | null;
  call: JobCall | null;
  environment: string | null;
  when: JobWhen;
  startIn: string | null;
  allowFailure: boolean;
  /** GitHub `if:`, as written. */
  condition: string | null;
  rules: GlRule[] | null;
  only: GlOnly | null;
  except: GlOnly | null;
  /** What the job runs, one line per step or script line. */
  steps: string[];
  /** Job-level `env:` / `variables:` with plain values. */
  vars: Record<string, string>;
  span: SourceSpan;
}

/** A GitHub trigger (`on:`). */
export interface GhTrigger {
  event: string;
  branches: string[] | null;
  branchesIgnore: string[] | null;
  tags: string[] | null;
  tagsIgnore: string[] | null;
  /** `paths:` / `paths-ignore:` is set — which files changed is not known here. */
  paths: boolean;
  types: string[] | null;
  crons: string[];
  /** `workflow_run: workflows:` — the workflows whose end starts this one. */
  workflows: string[];
  /** `workflow_dispatch` / `workflow_call` input defaults. */
  inputs: Record<string, string>;
}

export interface PipeFile {
  path: string;
  /** read — taken in; failed — tried and refused; external — another repository's, not tried. */
  state: "read" | "failed" | "external";
  /** What was asked for when the path is not a file here (`project: infra/ci`), or the refusal. */
  detail: string | null;
}

export type ProblemCode =
  | "yaml"
  | "notMap"
  | "noJobs"
  | "needsUnknown"
  | "needsCycle"
  | "needsLaterStage"
  | "stageUnknown"
  | "extendsUnknown"
  | "extendsCycle"
  | "referenceUnknown"
  | "includeExternal"
  | "includeFailed"
  | "includeDeep"
  | "callExternal"
  | "callFailed"
  | "matrixExpr"
  | "tooManyFiles";

export interface Problem {
  code: ProblemCode;
  level: "error" | "warn";
  params: Record<string, string | number>;
  file: string | null;
  line: number | null;
}

export interface Pipeline {
  kind: PipelineKind;
  /** The file the pipeline starts in. */
  file: string;
  /** Workflow `name:` (GitHub), else the file's name. */
  name: string;
  /** GitLab stages in order, `.pre`/`.post` only when a job uses them; empty on GitHub. */
  stages: string[];
  jobs: PipeJob[];
  triggers: GhTrigger[];
  /** GitLab `workflow: rules:`; null — none. */
  workflowRules: GlRule[] | null;
  /** Top-level `env:` / `variables:` with plain values. */
  variables: Record<string, string>;
  /** Every file it was built from, the main one first. */
  files: PipeFile[];
  problems: Problem[];
  /** Started only by another workflow (`workflow_call`) — a reusable one. */
  callable: boolean;
}

export const problem = (
  code: ProblemCode,
  level: Problem["level"],
  params: Problem["params"] = {},
  file: string | null = null,
  line: number | null = null,
): Problem => ({ code, level, params, file, line });

/** A job of `pipeline` by key. */
export const jobOf = (pipeline: Pick<Pipeline, "jobs">, id: string): PipeJob | undefined =>
  pipeline.jobs.find((j) => j.id === id);

/**
 * What a job waits for before it starts, by key: its `needs`, or — on GitLab,
 * when none are written — every job of the stages before its own. `present`
 * narrows to the jobs that are in the run at all (a job left out of a GitLab
 * pipeline is not waited for by the stages after it).
 */
export function dependsOn(pipeline: Pick<Pipeline, "kind" | "stages" | "jobs">, job: PipeJob, present?: (id: string) => boolean): string[] {
  if (job.needs) return job.needs.map((n) => n.job).filter((id) => !!jobOf(pipeline, id));
  if (pipeline.kind !== "gitlab" || job.stage === null) return [];
  const at = pipeline.stages.indexOf(job.stage);
  return pipeline.jobs
    .filter((o) => o.stage !== null && pipeline.stages.indexOf(o.stage) < at && (!present || present(o.id)))
    .map((o) => o.id);
}

/** The jobs in an order where everything a job depends on comes before it; a cycle is cut where it closes. */
export function topoJobs(pipeline: Pick<Pipeline, "kind" | "stages" | "jobs">): PipeJob[] {
  const out: PipeJob[] = [];
  const state = new Map<string, "open" | "done">();
  const visit = (job: PipeJob) => {
    if (state.has(job.id)) return;
    state.set(job.id, "open");
    for (const id of dependsOn(pipeline, job)) {
      const dep = jobOf(pipeline, id);
      if (dep && !state.has(dep.id)) visit(dep);
    }
    state.set(job.id, "done");
    out.push(job);
  };
  pipeline.jobs.forEach(visit);
  return out;
}

/** The jobs a job waits on directly or through others, by key. */
export function upstreamOf(pipeline: Pick<Pipeline, "kind" | "stages" | "jobs">, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (key: string) => {
    const job = jobOf(pipeline, key);
    if (!job) return;
    for (const dep of dependsOn(pipeline, job)) {
      if (out.has(dep)) continue;
      out.add(dep);
      walk(dep);
    }
  };
  walk(id);
  return out;
}

/** The jobs waiting on a job directly or through others, by key. */
export function downstreamOf(pipeline: Pick<Pipeline, "kind" | "stages" | "jobs">, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (key: string) => {
    for (const job of pipeline.jobs) {
      if (out.has(job.id) || !dependsOn(pipeline, job).includes(key)) continue;
      out.add(job.id);
      walk(job.id);
    }
  };
  walk(id);
  return out;
}

/** The job whose lines hold `line` of `file` — the one the editor's cursor is in. */
export function jobAtLine(pipeline: Pick<Pipeline, "jobs">, file: string, line: number): PipeJob | null {
  return pipeline.jobs.find((j) => j.span.file === file && line >= j.span.line && line <= j.span.endLine) ?? null;
}
