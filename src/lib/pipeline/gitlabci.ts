// A GitLab CI config read into the pipeline model (ADR 0068), the way GitLab
// reads it: included files merged under the main one, `extends` merged deeply
// (maps merge, lists and values replace, the job's own keys win), `!reference`
// replaced by what it names, `default:` scripts inherited, hidden `.jobs` kept
// as templates and not run. Reading the included files is `pipeload.ts`'s —
// this module is given their parsed values.

import { baseName } from "../files/fspath";
import { needsCycle } from "./ghactions";
import {
  problem,
  type GlOnly,
  type GlRule,
  type JobCall,
  type JobMatrix,
  type JobNeed,
  type JobWhen,
  type PipeFile,
  type PipeJob,
  type Pipeline,
  type Problem,
  type SourceSpan,
} from "./pipeline";
import { isObj, oneLine, str, strList, strMap, YamlReference, type Obj } from "./yamldoc";

/** Top-level keys that configure the pipeline rather than name a job. */
export const GL_KEYWORDS = new Set([
  "default",
  "include",
  "stages",
  "variables",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
  "spec",
  "types",
]);

export const DEFAULT_STAGES = ["build", "test", "deploy"];
const WHENS: readonly JobWhen[] = ["on_success", "manual", "delayed", "always", "on_failure", "never"];
/** GitLab's own limit on `extends` depth. */
const MAX_EXTENDS = 11;
/** `!reference` may nest this deep. */
const MAX_REFERENCE = 10;

/** One entry of `include:`. */
export type GlInclude =
  | { kind: "local"; path: string; conditional: boolean }
  | { kind: "external"; label: string };

/** What `include:` asks for: files of this repository, and what lives elsewhere. */
export function includesOf(config: Obj): GlInclude[] {
  const raw = config.include;
  const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const out: GlInclude[] = [];
  for (const item of list) {
    const s = typeof item === "string" ? item : null;
    if (s !== null) {
      out.push(/^https?:\/\//i.test(s) ? { kind: "external", label: s } : { kind: "local", path: s, conditional: false });
      continue;
    }
    if (!isObj(item)) continue;
    const conditional = item.rules !== undefined;
    const local = str(item.local);
    if (local !== null) {
      out.push({ kind: "local", path: local, conditional });
      continue;
    }
    if (item.project !== undefined) {
      const files = strList(item.file) ?? [];
      out.push({ kind: "external", label: `project: ${str(item.project) ?? "?"}${files.length ? ` (${files.join(", ")})` : ""}` });
    } else if (item.remote !== undefined) out.push({ kind: "external", label: `remote: ${str(item.remote) ?? "?"}` });
    else if (item.template !== undefined) out.push({ kind: "external", label: `template: ${str(item.template) ?? "?"}` });
    else if (item.component !== undefined) out.push({ kind: "external", label: `component: ${str(item.component) ?? "?"}` });
  }
  return out;
}

/** Merge as GitLab merges configs and `extends`: maps key by key, anything else replaced. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

/**
 * Replace every `!reference` in `value` with what it names in `config`,
 * flattening a referenced list into the list it stands in (as GitLab does for
 * scripts and rules). One that names nothing becomes null and is reported.
 */
export function resolveReferences(value: unknown, config: Obj, missing: (path: string[]) => void, depth = 0): unknown {
  if (value instanceof YamlReference) {
    let at: unknown = config;
    for (const key of value.path) at = isObj(at) ? at[key] : undefined;
    if (at === undefined || depth >= MAX_REFERENCE) {
      missing(value.path);
      return null;
    }
    return resolveReferences(at, config, missing, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const resolved = resolveReferences(item, config, missing, depth);
      return item instanceof YamlReference && Array.isArray(resolved) ? resolved : [resolved];
    });
  }
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveReferences(v, config, missing, depth);
    return out;
  }
  return value;
}

/** A job (or template) with everything it `extends` merged in under it. */
export function resolveExtends(
  config: Obj,
  key: string,
  report: (code: "extendsUnknown" | "extendsCycle", parent: string) => void,
  chain: string[] = [],
): Obj {
  const job = config[key];
  if (!isObj(job)) return {};
  let merged: unknown = {};
  for (const parent of strList(job.extends) ?? []) {
    if (chain.includes(parent) || parent === key || chain.length >= MAX_EXTENDS) {
      report("extendsCycle", parent);
      continue;
    }
    if (!isObj(config[parent])) {
      report("extendsUnknown", parent);
      continue;
    }
    merged = deepMerge(merged, resolveExtends(config, parent, report, [...chain, key]));
  }
  const own: Obj = { ...job };
  delete own.extends;
  return deepMerge(merged, own) as Obj;
}

const whenOf = (v: unknown): JobWhen | null => {
  const s = str(v);
  return s && (WHENS as readonly string[]).includes(s) ? (s as JobWhen) : null;
};

export function parseRules(v: unknown): GlRule[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter(isObj).map((r) => ({
    if: str(r.if),
    changes: r.changes !== undefined,
    exists: r.exists !== undefined,
    when: whenOf(r.when),
    allowFailure: typeof r.allow_failure === "boolean" ? r.allow_failure : null,
  }));
}

export function parseOnly(v: unknown): GlOnly | null {
  if (v === undefined || v === null) return null;
  if (isObj(v)) return { refs: strList(v.refs) ?? [], variables: strList(v.variables) ?? [], changes: v.changes !== undefined };
  const refs = strList(v);
  return refs ? { refs, variables: [], changes: false } : null;
}

/** `parallel: N` and `parallel: matrix:` as the copies they make. */
export function parallelOf(id: string, v: unknown): JobMatrix | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 1) {
    return { items: Array.from({ length: v }, (_, i) => `${id} ${i + 1}/${v}`), axes: `parallel: ${v}` };
  }
  if (!isObj(v) || v.matrix === undefined) return null;
  if (!Array.isArray(v.matrix)) return { items: null, axes: "parallel: matrix" };
  const items: string[] = [];
  for (const entry of v.matrix) {
    if (!isObj(entry)) return { items: null, axes: "parallel: matrix" };
    let combos: string[][] = [[]];
    for (const val of Object.values(entry)) {
      const options = Array.isArray(val) ? val.map((x) => str(x)) : [str(val)];
      if (options.some((o) => o === null)) return { items: null, axes: "parallel: matrix" };
      combos = combos.flatMap((c) => options.map((o) => [...c, o as string]));
    }
    items.push(...combos.map((c) => c.join(" · ")));
  }
  return { items, axes: "parallel: matrix" };
}

function needsOf(v: unknown): JobNeed[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return null;
  const out: JobNeed[] = [];
  for (const n of v) {
    const s = str(n);
    if (s !== null) out.push({ job: s, optional: false });
    else if (isObj(n) && str(n.job) !== null && n.project === undefined && n.pipeline === undefined) {
      out.push({ job: str(n.job) as string, optional: n.optional === true });
    }
  }
  return out;
}

/** A job's `trigger:` — a child pipeline from this repository, or another project's pipeline. */
export function triggerOf(v: unknown): JobCall | null {
  if (v === undefined || v === null) return null;
  // Only `depend` and `mirror` keep the trigger job running until the child ends.
  const waits = isObj(v) && (v.strategy === "depend" || v.strategy === "mirror");
  const project = str(v) ?? (isObj(v) ? str(v.project) : null);
  if (project !== null) return { file: project, pipeline: null, missing: "external", waits };
  if (!isObj(v)) return null;
  const includes = Array.isArray(v.include) ? v.include : [v.include];
  for (const inc of includes) {
    const local = str(inc) ?? (isObj(inc) ? str(inc.local) : null);
    if (local !== null) return { file: local, pipeline: null, missing: null, waits };
    if (isObj(inc) && inc.artifact !== undefined) return { file: `artifact: ${str(inc.artifact) ?? "?"}`, pipeline: null, missing: "external", waits };
    if (isObj(inc) && inc.project !== undefined) return { file: `project: ${str(inc.project) ?? "?"}`, pipeline: null, missing: "external", waits };
    if (isObj(inc) && inc.template !== undefined) return { file: `template: ${str(inc.template) ?? "?"}`, pipeline: null, missing: "external", waits };
  }
  return null;
}

/** Script lines as one line each; a reference that named nothing is said as such. */
function scriptLines(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((line) => (line === null ? "!reference ?" : oneLine(str(line) ?? JSON.stringify(line)))).filter(Boolean);
}

/** Whether a job takes the `default:` key `key` (`inherit: default:` may refuse it). */
function inherits(job: Obj, key: string): boolean {
  const inherit = isObj(job.inherit) ? job.inherit.default : undefined;
  if (inherit === false) return false;
  if (Array.isArray(inherit)) return inherit.includes(key);
  return true;
}

export interface GitlabSource {
  /** The main file. */
  file: string;
  /** The config with every included file merged under the main one. */
  config: Obj;
  /** Where each top-level key is written, from the file that defines it last. */
  spans: Map<string, SourceSpan>;
  files: PipeFile[];
  problems: Problem[];
}

/** The merged config as a pipeline; child pipelines are filled in by the loader. */
export function buildGitlab(src: GitlabSource): Pipeline {
  const problems = [...src.problems];
  const raw = src.config;
  const config = resolveReferences(raw, raw, (path) => {
    problems.push(problem("referenceUnknown", "warn", { path: path.join(".") }, src.file, null));
  }) as Obj;
  const declared = strList(config.stages) ?? strList(config.types) ?? DEFAULT_STAGES;
  const defaults = isObj(config.default) ? config.default : {};
  const pipeline: Pipeline = {
    kind: "gitlab",
    file: src.file,
    name: isObj(config.workflow) && str(config.workflow.name) ? (str(config.workflow.name) as string) : baseName(src.file),
    stages: [],
    jobs: [],
    triggers: [],
    workflowRules: isObj(config.workflow) ? parseRules(config.workflow.rules) : null,
    variables: strMap(config.variables),
    files: src.files,
    problems,
    callable: false,
  };
  const all = [".pre", ...declared.filter((s) => s !== ".pre" && s !== ".post"), ".post"];
  for (const key of Object.keys(config)) {
    if (GL_KEYWORDS.has(key) || key.startsWith(".") || !isObj(config[key])) continue;
    const span = src.spans.get(key) ?? { file: src.file, line: 1, endLine: 1 };
    const j = resolveExtends(config, key, (code, parent) => {
      problems.push(problem(code, "error", { job: key, parent }, span.file, span.line));
    });
    const rules = parseRules(j.rules);
    const when = whenOf(j.when) ?? "on_success";
    const stage = str(j.stage) ?? "test";
    if (!all.includes(stage)) problems.push(problem("stageUnknown", "error", { job: key, stage }, span.file, span.line));
    const before = j.before_script ?? (inherits(j, "before_script") ? (defaults.before_script ?? config.before_script) : undefined);
    const call = triggerOf(j.trigger);
    const job: PipeJob = {
      id: key,
      name: key,
      stage,
      needs: needsOf(j.needs),
      matrix: parallelOf(key, j.parallel),
      call,
      environment: str(j.environment) ?? (isObj(j.environment) ? str(j.environment.name) : null),
      when,
      startIn: str(j.start_in),
      // A manual job without rules does not hold the stages after it (GitLab's
      // default); one made manual by a rule does, unless the rule says otherwise.
      allowFailure: j.allow_failure === true || isObj(j.allow_failure) || (j.allow_failure === undefined && when === "manual" && !rules),
      condition: null,
      rules,
      only: parseOnly(j.only),
      except: parseOnly(j.except),
      steps: call ? [`trigger: ${call.file}`] : [...scriptLines(before), ...scriptLines(j.script)],
      vars: strMap(j.variables),
      span,
    };
    if (call?.missing === "external") {
      problems.push(problem("callExternal", "warn", { job: key, uses: call.file }, span.file, span.line));
    }
    pipeline.jobs.push(job);
  }
  pipeline.stages = all.filter((s) => (s !== ".pre" && s !== ".post") || pipeline.jobs.some((j) => j.stage === s));
  if (pipeline.jobs.length === 0) problems.push(problem("noJobs", "error", {}, src.file, 1));
  const stageAt = (job: PipeJob) => pipeline.stages.indexOf(job.stage ?? "");
  for (const job of pipeline.jobs) {
    for (const need of job.needs ?? []) {
      const target = pipeline.jobs.find((j) => j.id === need.job);
      if (!target) problems.push(problem("needsUnknown", "error", { job: job.id, need: need.job }, job.span.file, job.span.line));
      else if (stageAt(target) > stageAt(job)) {
        problems.push(problem("needsLaterStage", "error", { job: job.id, need: need.job }, job.span.file, job.span.line));
      }
    }
  }
  for (const id of needsCycle(pipeline.jobs)) {
    const job = pipeline.jobs.find((j) => j.id === id);
    problems.push(problem("needsCycle", "error", { job: id }, job?.span.file ?? null, job?.span.line ?? null));
  }
  return pipeline;
}
