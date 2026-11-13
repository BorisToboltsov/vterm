// Building a pipeline from its file and the files it names (ADR 0068): GitLab's
// `include: local` (globs too) and child pipelines, GitHub's reusable workflows
// and composite actions of the same repository. Every read goes through the
// reader the caller gives — the file's own connection, SFTP or this computer —
// and nothing else: what lives elsewhere (another project, a URL, GitLab's
// templates) is named external and not fetched (principle 6). The caller is the
// only impure party; this module is logic over an injected reader.

import { baseName, joinPath } from "../files/fspath";
import { compositeSteps, isLocalUses, parseWorkflow } from "./ghactions";
import { buildGitlab, deepMerge, includesOf } from "./gitlabci";
import { globMatch, isPipelineDir, pipelineHomes, pipelineKindOf, repoPath, repoRootOf, WORKFLOW_HOMES, workflowFiles, workflowsDirOf } from "./pipefiles";
import { problem, type PipeFile, type Pipeline, type PipelineKind, type Problem, type SourceSpan } from "./pipeline";
import { isObj, parseYaml, type Obj, type Yaml } from "./yamldoc";

export interface ReaderEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** How the pipeline reaches the files beside its own: the connection the file came through. */
export interface PipeReader {
  /** The text of a file; rejects when it cannot be read. */
  read(path: string): Promise<string>;
  /** A folder's entries; rejects when it cannot be listed. */
  list(dir: string): Promise<ReaderEntry[]>;
}

/**
 * A reader that asks the connection once per path. The schema beside the code
 * reads its own text again on every pause in typing; the files it includes are
 * read once for as long as it is open (a refusal too — it is not asked again).
 */
export function cachedReader(reader: PipeReader): PipeReader {
  const reads = new Map<string, Promise<string>>();
  const lists = new Map<string, Promise<ReaderEntry[]>>();
  const once = <T>(cache: Map<string, Promise<T>>, key: string, ask: () => Promise<T>): Promise<T> => {
    let hit = cache.get(key);
    if (!hit) {
      hit = ask();
      cache.set(key, hit);
    }
    return hit;
  };
  return {
    read: (path) => once(reads, path, () => reader.read(path)),
    list: (dir) => once(lists, dir, () => reader.list(dir)),
  };
}

/** More files than this behind one pipeline is not read — the rest is reported. */
export const MAX_FILES = 40;
/** Includes inside includes, calls inside calls: this deep and no deeper. */
export const MAX_DEPTH = 4;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0];

/** One load: the files read so far (shared by everything one pipeline reads). */
interface Budget {
  read: number;
}

async function readBudgeted(reader: PipeReader, path: string, budget: Budget): Promise<string> {
  if (budget.read >= MAX_FILES) throw new Error("too-many-files");
  budget.read++;
  return reader.read(path);
}

// ── GitLab ───────────────────────────────────────────────────────────────────

interface GitlabParts {
  config: Obj;
  spans: Map<string, SourceSpan>;
  files: PipeFile[];
  problems: Problem[];
}

async function expandGlob(reader: PipeReader, root: string, pattern: string): Promise<string[]> {
  const rel = pattern.replace(/^\.?\/+/, "");
  const at = rel.lastIndexOf("/");
  const dir = repoPath(root, at < 0 ? "." : rel.slice(0, at));
  const mask = at < 0 ? rel : rel.slice(at + 1);
  if (!dir || dir.includes("*")) return [];
  const entries = await reader.list(dir);
  return entries.filter((e) => !e.isDir && globMatch(mask, e.name)).map((e) => e.path).sort();
}

/** One GitLab file and, under it, everything it includes — merged in GitLab's order. */
async function gitlabParts(
  Y: Yaml,
  reader: PipeReader,
  root: string,
  file: string,
  text: string,
  depth: number,
  budget: Budget,
  seen: Set<string>,
): Promise<GitlabParts> {
  const out: GitlabParts = { config: {}, spans: new Map(), files: [], problems: [] };
  const doc = parseYaml(Y, text);
  if (doc.error) {
    out.problems.push(problem("yaml", "error", { message: doc.error.message }, file, doc.error.line));
    return out;
  }
  if (!isObj(doc.value)) {
    if (doc.value !== null) out.problems.push(problem("notMap", "error", {}, file, 1));
    return out;
  }
  const merged: Obj = {};
  const absorb = (part: GitlabParts) => {
    for (const [k, v] of Object.entries(part.config)) merged[k] = deepMerge(merged[k], v);
    part.spans.forEach((span, key) => out.spans.set(key, span));
    out.files.push(...part.files);
    out.problems.push(...part.problems);
  };
  for (const inc of includesOf(doc.value)) {
    if (inc.kind === "external") {
      out.files.push({ path: inc.label, state: "external", detail: inc.label });
      out.problems.push(problem("includeExternal", "warn", { what: inc.label }, file, doc.span(["include"])?.line ?? null));
      continue;
    }
    if (depth >= MAX_DEPTH) {
      out.problems.push(problem("includeDeep", "warn", { path: inc.path }, file, doc.span(["include"])?.line ?? null));
      continue;
    }
    let paths: string[];
    try {
      paths = inc.path.includes("*") ? await expandGlob(reader, root, inc.path) : [repoPath(root, inc.path)].filter((p): p is string => !!p);
    } catch (e) {
      out.files.push({ path: inc.path, state: "failed", detail: errText(e) });
      out.problems.push(problem("includeFailed", "warn", { path: inc.path, reason: errText(e) }, file, doc.span(["include"])?.line ?? null));
      continue;
    }
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        const body = await readBudgeted(reader, path, budget);
        const part = await gitlabParts(Y, reader, root, path, body, depth + 1, budget, seen);
        part.files.unshift({ path, state: "read", detail: inc.conditional ? "rules" : null });
        absorb(part);
      } catch (e) {
        const tooMany = errText(e) === "too-many-files";
        out.files.push({ path, state: "failed", detail: tooMany ? null : errText(e) });
        out.problems.push(
          tooMany
            ? problem("tooManyFiles", "warn", { max: MAX_FILES }, file, null)
            : problem("includeFailed", "warn", { path, reason: errText(e) }, file, doc.span(["include"])?.line ?? null),
        );
      }
    }
  }
  // The file's own keys go over what it includes: a job here replaces, a map merges.
  for (const [k, v] of Object.entries(doc.value)) {
    if (k === "include") continue;
    merged[k] = deepMerge(merged[k], v);
    const span = doc.span([k]);
    if (span) out.spans.set(k, { file, ...span });
  }
  out.config = merged;
  return out;
}

async function loadGitlab(Y: Yaml, reader: PipeReader, file: string, text: string, root: string, depth: number, budget: Budget): Promise<Pipeline> {
  const parts = await gitlabParts(Y, reader, root, file, text, depth, budget, new Set([file]));
  const pipeline = buildGitlab({
    file,
    config: parts.config,
    spans: parts.spans,
    files: [{ path: file, state: "read", detail: null }, ...parts.files],
    problems: parts.problems,
  });
  for (const job of pipeline.jobs) {
    const call = job.call;
    if (!call || call.missing) continue;
    const path = repoPath(root, call.file);
    if (!path || depth + 1 >= MAX_DEPTH) {
      call.missing = "unread";
      continue;
    }
    try {
      const body = await readBudgeted(reader, path, budget);
      call.pipeline = await loadGitlab(Y, reader, path, body, root, depth + 1, budget);
    } catch (e) {
      call.missing = "unread";
      pipeline.files.push({ path, state: "failed", detail: errText(e) });
      pipeline.problems.push(problem("callFailed", "warn", { job: job.id, path, reason: errText(e) }, job.span.file, job.span.line));
    }
  }
  return pipeline;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

async function loadWorkflow(Y: Yaml, reader: PipeReader, file: string, text: string, root: string, depth: number, budget: Budget): Promise<Pipeline> {
  const pipeline = parseWorkflow(file, parseYaml(Y, text));
  const actions = new Map<string, string[] | null>();
  for (const job of pipeline.jobs) {
    const call = job.call;
    if (call && !call.missing) {
      const path = repoPath(root, call.file);
      if (!path || depth + 1 >= MAX_DEPTH) {
        call.missing = "unread";
        continue;
      }
      try {
        const body = await readBudgeted(reader, path, budget);
        call.pipeline = await loadWorkflow(Y, reader, path, body, root, depth + 1, budget);
        pipeline.files.push({ path, state: "read", detail: null });
      } catch (e) {
        call.missing = "unread";
        pipeline.files.push({ path, state: "failed", detail: errText(e) });
        pipeline.problems.push(problem("callFailed", "warn", { job: job.id, path, reason: errText(e) }, file, job.span.line));
      }
      continue;
    }
    // Composite actions of this repository: their steps stand in the job.
    const expanded: string[] = [];
    for (const line of job.steps) {
      expanded.push(line);
      const uses = /^uses: ([.$]\/\S+)$/.exec(line)?.[1];
      if (!uses || !isLocalUses(uses)) continue;
      const dir = repoPath(root, uses);
      if (!dir) continue;
      if (!actions.has(dir)) actions.set(dir, await readAction(Y, reader, dir, budget, pipeline));
      for (const step of actions.get(dir) ?? []) expanded.push(`↳ ${step}`);
    }
    job.steps = expanded;
  }
  return pipeline;
}

async function readAction(Y: Yaml, reader: PipeReader, dir: string, budget: Budget, pipeline: Pipeline): Promise<string[] | null> {
  for (const name of ["action.yml", "action.yaml"]) {
    const path = joinPath(dir, name);
    let body: string;
    try {
      body = await readBudgeted(reader, path, budget);
    } catch {
      continue;
    }
    pipeline.files.push({ path, state: "read", detail: null });
    return compositeSteps(parseYaml(Y, body));
  }
  pipeline.files.push({ path: dir, state: "failed", detail: null });
  return null;
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** A pipeline from its file's text: GitHub when the path says so, else GitLab. */
export async function loadPipeline(Y: Yaml, reader: PipeReader, file: string, text: string, kind?: PipelineKind): Promise<Pipeline> {
  const budget: Budget = { read: 0 };
  const root = repoRootOf(file);
  const as = kind ?? pipelineKindOf(file) ?? "gitlab";
  return as === "github" ? loadWorkflow(Y, reader, file, text, root, 0, budget) : loadGitlab(Y, reader, file, text, root, 0, budget);
}

export interface PipelineGroup {
  /** Where the files were looked for. */
  roots: string[];
  pipelines: Pipeline[];
  /** Files that were found but could not be read. */
  failed: PipeFile[];
}

/** The pipeline files a target names: itself, a workflows folder's files, or a repository's. */
async function filesOf(reader: PipeReader, target: { path: string; isDir: boolean }): Promise<string[]> {
  if (!target.isDir) return pipelineKindOf(target.path) ? [target.path] : [];
  if (isPipelineDir(target.path)) {
    const dir = workflowsDirOf(target.path);
    return workflowFiles(await reader.list(dir));
  }
  const homes = pipelineHomes(target.path);
  const names = new Set((await reader.list(target.path)).map((e) => e.name));
  const out: string[] = [];
  for (const [i, dir] of homes.workflows.entries()) {
    if (!names.has(WORKFLOW_HOMES[i])) continue;
    let listed: ReaderEntry[];
    try {
      listed = await reader.list(dir);
    } catch {
      // A `.github` without workflows is not a pipeline that failed: none here.
      listed = [];
    }
    out.push(...workflowFiles(listed));
  }
  out.push(...homes.gitlab.filter((p) => names.has(baseName(p))));
  return out;
}

/** The pipelines of a set of files and folders, as one group for the map. */
export async function loadGroup(Y: Yaml, reader: PipeReader, targets: readonly { path: string; isDir: boolean }[]): Promise<PipelineGroup> {
  const group: PipelineGroup = { roots: targets.map((t) => t.path), pipelines: [], failed: [] };
  const files: string[] = [];
  for (const target of targets) {
    try {
      for (const f of await filesOf(reader, target)) if (!files.includes(f)) files.push(f);
    } catch (e) {
      group.failed.push({ path: target.path, state: "failed", detail: errText(e) });
    }
  }
  for (const file of files.slice(0, MAX_FILES)) {
    try {
      group.pipelines.push(await loadPipeline(Y, reader, file, await reader.read(file)));
    } catch (e) {
      group.failed.push({ path: file, state: "failed", detail: errText(e) });
    }
  }
  return group;
}
