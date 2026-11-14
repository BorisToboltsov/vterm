// The calls of the CI panel (ADR 0069): one `gh api` / `glab api` argv per
// question, to the REST paths `ci::check_args` lets through — and nothing else.
// The forge's own JSON is read by `ciparse.ts`. Pure.

import { CLI, type Repo } from "./forge";

/** A segment or query value as the backend's policy takes it: letters, digits,
 *  `._-`, everything else percent-encoded (`/` too — a GitLab project path is one segment). */
export function enc(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9._-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

const base = (r: Repo): string => {
  if (r.forge === "github") {
    const [owner, name] = r.path.split("/");
    return `repos/${enc(owner ?? "")}/${enc(name ?? "")}`;
  }
  return `projects/${enc(r.path)}`;
};

const query = (q: Record<string, string | number | null | undefined>): string => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

const api = (r: Repo, endpoint: string, ...rest: string[]): string[] => [
  CLI[r.forge],
  "api",
  "--hostname",
  r.host,
  ...rest,
  endpoint,
];

const post = (r: Repo, endpoint: string, ...fields: string[]): string[] => [
  ...api(r, endpoint, "-X", "POST"),
  ...fields,
];

/** How many runs a list asks for. */
export const RUNS_PAGE = 30;

/** Whether the CLI is signed in to the repository's host. */
export function authArgs(r: Repo): string[] {
  return [CLI[r.forge], "auth", "status", "--hostname", r.host];
}

/** The latest runs: of the repository, of one workflow file, of one branch. */
export function runsArgs(r: Repo, opts: { branch?: string | null; workflow?: string | null } = {}): string[] {
  if (r.forge === "github") {
    const where = opts.workflow ? `/actions/workflows/${enc(opts.workflow)}/runs` : "/actions/runs";
    return api(r, `${base(r)}${where}${query({ per_page: RUNS_PAGE, branch: opts.branch })}`);
  }
  return api(r, `${base(r)}/pipelines${query({ per_page: RUNS_PAGE, ref: opts.branch })}`);
}

/** One run: its state now (a watched run is asked this). */
export function runArgs(r: Repo, id: string): string[] {
  return api(r, `${base(r)}/${r.forge === "github" ? "actions/runs" : "pipelines"}/${id}`);
}

/** A run's jobs — GitHub with their steps; the latest attempt of each. */
export function jobsArgs(r: Repo, id: string): string[] {
  return r.forge === "github"
    ? api(r, `${base(r)}/actions/runs/${id}/jobs${query({ per_page: 100, filter: "latest" })}`)
    : api(r, `${base(r)}/pipelines/${id}/jobs${query({ per_page: 100 })}`);
}

/** A GitLab pipeline's trigger jobs: the child and multi-project pipelines it starts. */
export function bridgesArgs(r: Repo, id: string): string[] {
  return api(r, `${base(r)}/pipelines/${id}/bridges${query({ per_page: 100 })}`);
}

/** A job's log. */
export function logArgs(r: Repo, jobId: string): string[] {
  return r.forge === "github"
    ? api(r, `${base(r)}/actions/jobs/${jobId}/logs`)
    : api(r, `${base(r)}/jobs/${jobId}/trace`);
}

/** The repository's workflows — the file each run comes from (GitHub). */
export function workflowsArgs(r: Repo): string[] {
  return api(r, `${base(r)}/actions/workflows${query({ per_page: 100 })}`);
}

/**
 * Run the failed jobs again (`failed`), or the whole run. GitLab retries a
 * pipeline's failed and cancelled jobs; the whole of it again is a new pipeline
 * for its ref (`pipelineArgs`).
 */
export function rerunArgs(r: Repo, id: string, failed: boolean): string[] {
  if (r.forge === "github") return post(r, `${base(r)}/actions/runs/${id}/${failed ? "rerun-failed-jobs" : "rerun"}`);
  return post(r, `${base(r)}/pipelines/${id}/retry`);
}

export function cancelArgs(r: Repo, id: string): string[] {
  return post(r, `${base(r)}/${r.forge === "github" ? "actions/runs" : "pipelines"}/${id}/cancel`);
}

/** Start a workflow by hand (`workflow_dispatch`) on `ref`, with its inputs. */
export function dispatchArgs(r: Repo, file: string, ref: string, inputs: Record<string, string>): string[] {
  const fields = ["-f", `ref=${ref}`];
  for (const [k, v] of Object.entries(inputs)) fields.push("-f", `inputs[${k}]=${v}`);
  return post(r, `${base(r)}/actions/workflows/${enc(file)}/dispatches`, ...fields);
}

/** Start a GitLab pipeline for `ref`, with variables. */
export function pipelineArgs(r: Repo, ref: string, variables: Record<string, string>): string[] {
  const fields = ["-f", `ref=${ref}`];
  const list = Object.entries(variables).map(([key, value]) => ({ key, value }));
  if (list.length) fields.push("-F", `variables=${JSON.stringify(list)}`);
  return post(r, `${base(r)}/pipeline`, ...fields);
}

/** The commit a tag or branch of an action points at — to pin `uses:` by SHA. */
export function pinArgs(action: string, ref: string): string[] {
  const [owner, name] = action.split("/");
  return ["gh", "api", "--hostname", "github.com", `repos/${enc(owner ?? "")}/${enc(name ?? "")}/commits/${enc(ref)}`];
}
