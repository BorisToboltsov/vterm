// A GitHub Actions workflow (and Gitea's/Forgejo's, the same format) read into
// the pipeline model (ADR 0068). Jobs run by `needs`; a matrix is expanded as
// GitHub expands it (`include` adds or extends, `exclude` removes); a job that
// `uses:` another workflow is a call — read by `pipeload.ts` when it is a file
// of this repository, named external when it is not.

import { baseName } from "../files/fspath";
import {
  problem,
  type GhTrigger,
  type JobMatrix,
  type JobNeed,
  type PipeJob,
  type Pipeline,
  type Problem,
} from "./pipeline";
import { isObj, oneLine, str, strList, strMap, type Obj, type YamlFile } from "./yamldoc";

const emptyTrigger = (event: string): GhTrigger => ({
  event,
  branches: null,
  branchesIgnore: null,
  tags: null,
  tagsIgnore: null,
  paths: false,
  types: null,
  crons: [],
  workflows: [],
  inputs: {},
});

function inputDefaults(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v) || !isObj(v.inputs)) return out;
  for (const [name, spec] of Object.entries(v.inputs)) {
    const d = isObj(spec) ? str(spec.default) : null;
    if (d !== null) out[name] = d;
  }
  return out;
}

/** `on:` — a name, a list of names, or a map of events to their filters. */
export function parseTriggers(on: unknown): GhTrigger[] {
  if (typeof on === "string" || Array.isArray(on)) return (strList(on) ?? []).map(emptyTrigger);
  if (!isObj(on)) return [];
  return Object.entries(on).map(([event, cfg]) => {
    const t = emptyTrigger(event);
    if (event === "schedule" && Array.isArray(cfg)) {
      t.crons = cfg.map((c) => (isObj(c) ? str(c.cron) : null)).filter((c): c is string => c !== null);
      return t;
    }
    if (!isObj(cfg)) return t;
    t.branches = strList(cfg.branches);
    t.branchesIgnore = strList(cfg["branches-ignore"]);
    t.tags = strList(cfg.tags);
    t.tagsIgnore = strList(cfg["tags-ignore"]);
    t.paths = cfg.paths !== undefined || cfg["paths-ignore"] !== undefined;
    t.types = strList(cfg.types);
    t.workflows = strList(cfg.workflows) ?? [];
    t.inputs = inputDefaults(cfg);
    return t;
  });
}

const label = (v: unknown): string => str(v) ?? JSON.stringify(v);

/**
 * The copies a `strategy.matrix` makes, as GitHub makes them: the product of
 * the axes, less every combination an `exclude` entry matches, then each
 * `include` entry added to the combinations whose axis values it agrees with —
 * or, matching none, made a combination of its own. An axis or the whole
 * matrix taken from an expression (`${{ fromJSON(…) }}`) has no copies here.
 */
export function expandMatrix(v: unknown): JobMatrix | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return { items: null, axes: str(v)?.trim() ?? "?" };
  const axes = Object.keys(v).filter((k) => k !== "include" && k !== "exclude");
  const shown = axes.join(" × ") || "include";
  if (axes.some((k) => !Array.isArray(v[k]))) return { items: null, axes: shown };
  let combos: Record<string, string>[] = axes.length ? [{}] : [];
  for (const k of axes) combos = combos.flatMap((c) => (v[k] as unknown[]).map((x) => ({ ...c, [k]: label(x) })));
  const entries = (key: "include" | "exclude"): Obj[] | null => {
    const list = v[key];
    if (list === undefined) return [];
    return Array.isArray(list) && list.every(isObj) ? list : null;
  };
  const exclude = entries("exclude");
  const include = entries("include");
  if (!exclude || !include) return { items: null, axes: shown };
  combos = combos.filter((c) => !exclude.some((x) => Object.entries(x).every(([k, val]) => c[k] === label(val))));
  const labels = combos.map((c) => axes.map((k) => c[k]).join(" · "));
  for (const inc of include) {
    const own = Object.entries(inc).filter(([k]) => axes.includes(k));
    const fits = combos.some((c) => own.every(([k, val]) => c[k] === label(val)));
    if (!fits) labels.push(Object.values(inc).map(label).join(" · "));
  }
  return { items: labels, axes: include.length ? `${shown} + include` : shown };
}

/** A step as one line: its name, else what it runs or uses. */
export function stepLine(step: unknown): string {
  if (!isObj(step)) return "—";
  const name = str(step.name);
  if (name) return oneLine(name);
  const uses = str(step.uses);
  if (uses) return `uses: ${uses}`;
  const run = str(step.run);
  return run ? oneLine(run) : "—";
}

/**
 * A `uses:` that names a file of this repository rather than another one's:
 * `./…`, or `$/…` — the same repository at the same commit.
 */
export const isLocalUses = (uses: string): boolean => uses.startsWith("./") || uses.startsWith("$/");

/** The jobs whose `needs` close a loop, by key. */
export function needsCycle(jobs: readonly Pick<PipeJob, "id" | "needs">[]): string[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const state = new Map<string, "open" | "done">();
  const loop = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      path.slice(path.indexOf(id)).forEach((x) => loop.add(x));
      return;
    }
    state.set(id, "open");
    for (const n of byId.get(id)?.needs ?? []) if (byId.has(n.job)) visit(n.job, [...path, id]);
    state.set(id, "done");
  };
  jobs.forEach((j) => visit(j.id, []));
  return [...loop];
}

/** A workflow file as a pipeline; its calls are filled in by the loader. */
export function parseWorkflow(file: string, doc: YamlFile): Pipeline {
  const pipeline: Pipeline = {
    kind: "github",
    file,
    name: baseName(file),
    stages: [],
    jobs: [],
    triggers: [],
    workflowRules: null,
    variables: {},
    files: [{ path: file, state: "read", detail: null }],
    problems: [],
    callable: false,
  };
  const problems: Problem[] = pipeline.problems;
  if (doc.error) {
    problems.push(problem("yaml", "error", { message: doc.error.message }, file, doc.error.line));
    return pipeline;
  }
  const root = doc.value;
  if (!isObj(root)) {
    problems.push(problem("notMap", "error", {}, file, 1));
    return pipeline;
  }
  pipeline.name = str(root.name) ?? pipeline.name;
  pipeline.triggers = parseTriggers(root.on);
  pipeline.callable = pipeline.triggers.length > 0 && pipeline.triggers.every((t) => t.event === "workflow_call");
  pipeline.variables = strMap(root.env);
  const jobs = isObj(root.jobs) ? root.jobs : {};
  for (const id of doc.keys(["jobs"])) {
    const j = jobs[id];
    if (!isObj(j)) continue;
    const span = doc.span(["jobs", id]) ?? { line: 1, endLine: 1 };
    const needs = strList(j.needs);
    const shownName = str(j.name);
    const uses = str(j.uses);
    const strategy = isObj(j.strategy) ? j.strategy : null;
    const matrix = expandMatrix(strategy?.matrix);
    if (matrix && matrix.items === null) problems.push(problem("matrixExpr", "warn", { job: id }, file, span.line));
    const job: PipeJob = {
      id,
      name: shownName && !shownName.includes("${{") ? shownName : id,
      stage: null,
      needs: needs ? needs.map((n): JobNeed => ({ job: n, optional: false })) : null,
      matrix,
      call: uses ? { file: uses, pipeline: null, missing: isLocalUses(uses) ? null : "external", waits: true } : null,
      environment: str(j.environment) ?? (isObj(j.environment) ? str(j.environment.name) : null),
      when: "on_success",
      startIn: null,
      allowFailure: j["continue-on-error"] === true,
      condition: str(j.if),
      rules: null,
      only: null,
      except: null,
      steps: uses ? [`uses: ${uses}`] : Array.isArray(j.steps) ? j.steps.map(stepLine) : [],
      vars: strMap(j.env),
      span: { file, ...span },
    };
    if (job.call?.missing === "external") {
      problems.push(problem("callExternal", "warn", { job: id, uses: job.call.file }, file, span.line));
      pipeline.files.push({ path: job.call.file, state: "external", detail: job.call.file });
    }
    pipeline.jobs.push(job);
  }
  if (pipeline.jobs.length === 0) problems.push(problem("noJobs", "error", {}, file, 1));
  for (const job of pipeline.jobs) {
    for (const need of job.needs ?? []) {
      if (!pipeline.jobs.some((j) => j.id === need.job)) {
        problems.push(problem("needsUnknown", "error", { job: job.id, need: need.job }, file, job.span.line));
      }
    }
  }
  for (const id of needsCycle(pipeline.jobs)) {
    const job = pipeline.jobs.find((j) => j.id === id);
    problems.push(problem("needsCycle", "error", { job: id }, file, job?.span.line ?? null));
  }
  return pipeline;
}

/** The steps of a composite action (`action.yml`), one line each; null — not a composite action. */
export function compositeSteps(doc: YamlFile): string[] | null {
  const root = doc.value;
  if (!isObj(root) || !isObj(root.runs) || str(root.runs.using) !== "composite") return null;
  return Array.isArray(root.runs.steps) ? root.runs.steps.map(stepLine) : [];
}
