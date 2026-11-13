// Which files are CI pipelines and where their repository begins (ADR 0068).
// Recognised by path, as the CI systems find them: a workflow is any YAML under
// `.github/workflows/` (and Gitea's and Forgejo's twins of it, which run the
// same format); a GitLab pipeline is `.gitlab-ci.yml` or a file named after it.
// A GitLab fragment (`ci/test.yml`, included by the main file) has no such name
// and is told by what it holds.

import { baseName, joinPath, parentOf, resolveRelative } from "../files/fspath";
import type { PipelineKind } from "./pipeline";

/** Folders a workflow directory lives in: GitHub's and its Gitea/Forgejo twins. */
export const WORKFLOW_HOMES = [".github", ".gitea", ".forgejo"] as const;

const segments = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean);
const isYamlName = (name: string): boolean => /\.ya?ml$/i.test(name);

/** The pipeline format a path names by itself, or null. */
export function pipelineKindOf(path: string): PipelineKind | null {
  const name = baseName(path);
  if (!isYamlName(name)) return null;
  const segs = segments(path);
  const at = segs.length - 2;
  if (at >= 1 && segs[at] === "workflows" && (WORKFLOW_HOMES as readonly string[]).includes(segs[at - 1])) return "github";
  if (/(^|\.)gitlab-ci\.ya?ml$/i.test(name)) return "gitlab";
  return null;
}

/**
 * Whether YAML text reads as GitLab CI: `stages:` at the top, or a top-level
 * key whose body says `script:`, `stage:`, `extends:` or `trigger:`. Only asked
 * of YAML that no path already names.
 */
export function looksLikeGitlab(text: string): boolean {
  let inBlock = false;
  for (const line of text.slice(0, 20000).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      if (/^(stages|include):/.test(line)) return true;
      inBlock = /^[^\s#][^:]*:\s*(#.*)?$/.test(line);
      continue;
    }
    if (inBlock && /^\s+(script|stage|extends|trigger):/.test(line)) return true;
  }
  return false;
}

/** Whether a folder holds pipelines: a workflows folder, or the folder over one. */
export function isPipelineDir(path: string): boolean {
  const segs = segments(path);
  const last = segs[segs.length - 1] ?? "";
  if ((WORKFLOW_HOMES as readonly string[]).includes(last)) return true;
  return last === "workflows" && (WORKFLOW_HOMES as readonly string[]).includes(segs[segs.length - 2] ?? "");
}

/** Whether a folder listing shows a repository with pipelines in it. */
export function holdsPipelines(names: readonly string[]): boolean {
  return names.some((n) => (WORKFLOW_HOMES as readonly string[]).includes(n) || pipelineKindOf(`/${n}`) === "gitlab");
}

/**
 * The repository a pipeline file belongs to: above `.github` for a workflow,
 * the folder of `.gitlab-ci.yml` for GitLab. A GitLab fragment is placed in its
 * own folder — the best a file alone can say.
 */
export function repoRootOf(path: string): string {
  const segs = segments(path);
  const at = segs.length - 2;
  if (at >= 1 && segs[at] === "workflows" && (WORKFLOW_HOMES as readonly string[]).includes(segs[at - 1])) {
    return parentOf(parentOf(parentOf(path)));
  }
  return parentOf(path);
}

/**
 * A path the config names, under the repository root: GitLab's `include: local`
 * (`/ci/test.yml` and `ci/test.yml` alike) and GitHub's `./.github/…`. Null when
 * it leaves the root — a config does not reach outside its repository.
 */
export function repoPath(root: string, rel: string): string | null {
  const clean = rel.trim().replace(/^[.$]?\/+/, "");
  if (!clean || /^[a-z]+:\/\//i.test(clean)) return null;
  return resolveRelative(root, clean);
}

/** Whether a name in a folder matches a GitLab include glob segment (`*.yml`). */
export function globMatch(pattern: string, name: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`).test(name);
}

/** The workflow files a listing of a workflows folder holds, by path, sorted. */
export function workflowFiles(entries: readonly { name: string; path: string; isDir: boolean }[]): string[] {
  return entries.filter((e) => !e.isDir && isYamlName(e.name)).map((e) => e.path).sort();
}

/** Where to look for pipelines under a repository root. */
export function pipelineHomes(root: string): { workflows: string[]; gitlab: string[] } {
  return {
    workflows: WORKFLOW_HOMES.map((home) => joinPath(joinPath(root, home), "workflows")),
    gitlab: [joinPath(root, ".gitlab-ci.yml"), joinPath(root, ".gitlab-ci.yaml")],
  };
}

/** The workflows folder named by a path that is a home (`.github`) or the folder itself. */
export function workflowsDirOf(path: string): string {
  const last = baseName(path);
  return (WORKFLOW_HOMES as readonly string[]).includes(last) ? joinPath(path, "workflows") : path;
}
