// The pipelines of the CI panel (ADR 0070): the repository's pipeline files —
// read as the schema reads them — each a row with the runs that are its own.
// The panel starts from what the repository runs, not only from what ran: the
// rows stand without the forge (no gh, no sign-in, no remote), the runs join
// them when there are any.
//
// Whose a run is: GitHub names its workflow file; a GitLab pipeline is the
// main `.gitlab-ci.yml`'s, except a child pipeline (`parent_pipeline`), whose
// file the API does not name — it stays nobody's rather than a guess. A called
// workflow has no runs of its own: its jobs run inside its caller's.
//
// Which runs' jobs are read for the rows' dots: each pipeline's latest — a run
// that ended once, a running one with every read of the list — and no more than
// a few per read, so a repository of forty workflows fills in over a few reads
// instead of forty calls at once.

import { baseName } from "../files/fspath";
import type { Pipeline, PipelineKind } from "../pipeline/pipeline";
import type { PipelineMap } from "../pipeline/pipemap";
import { eventPresets, type PipeEvent } from "../pipeline/pipesim";
import type { ListSchema } from "../ui/listview";
import { isActive, type CiJob, type CiRun, type CiState } from "./ciparse";
import { repoRelative } from "./forge";

export interface PipeRow {
  /** The file, as the map names its card. */
  id: string;
  /** The file, repository-relative. */
  rel: string;
  name: string;
  kind: PipelineKind;
  pipeline: Pipeline;
  /** Started only by another pipeline: a reusable workflow, a GitLab child pipeline. */
  called: boolean;
  /** The names of the pipelines that call it. */
  callers: string[];
  /** What starts it by itself (a call is not one). */
  events: PipeEvent[];
  /** Its own runs in the list read, newest first; empty — none there. */
  runs: CiRun[];
  /** Can be started by hand: `workflow_dispatch`, or any GitLab main pipeline. */
  canStart: boolean;
}

/** The jobs of a run read for a row, and the run as it was when they were read. */
export interface HeldJobs {
  state: CiState;
  attempt: number;
  jobs: CiJob[];
}

/** Runs whose jobs are read in one read of the list, at most. */
export const JOBS_PER_READ = 6;

const isGitlabMain = (rel: string): boolean => /^\.gitlab-ci\.ya?ml$/i.test(rel);

/** The row a run belongs to, by its file; null — nobody's that the panel can tell. */
export function ownerOf(run: CiRun, rows: readonly Pick<PipeRow, "id" | "rel" | "kind" | "called">[]): string | null {
  if (run.forge === "github") {
    const file = run.file?.replace(/^\.?\/+/, "");
    return file ? (rows.find((r) => r.kind === "github" && r.rel === file)?.id ?? null) : null;
  }
  if (run.event === "parent_pipeline") return null;
  return rows.find((r) => r.kind === "gitlab" && !r.called && isGitlabMain(r.rel))?.id ?? null;
}

/** The rows of a map of the repository's pipelines, with their runs from the list read. */
export function pipeRows(map: PipelineMap, root: string, runs: readonly CiRun[] | null): PipeRow[] {
  const nameOf = (id: string) => map.cards.find((c) => c.id === id)?.pipeline.name ?? baseName(id);
  const rows: PipeRow[] = map.cards.map((card) => {
    const p = card.pipeline;
    return {
      id: card.id,
      rel: repoRelative(root, card.id) ?? baseName(card.id),
      name: p.name,
      kind: p.kind,
      pipeline: p,
      called: card.called,
      callers: map.calls.filter((c) => c.to === card.id && !c.after).map((c) => nameOf(c.from)),
      events: card.called ? [] : eventPresets(p).filter((e) => e.kind !== "call"),
      runs: [],
      canStart: !card.called && (p.kind === "gitlab" || p.triggers.some((t) => t.event === "workflow_dispatch")),
    };
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const run of [...(runs ?? [])].sort((a, b) => b.created - a.created)) {
    const owner = ownerOf(run, rows);
    if (owner) byId.get(owner)?.runs.push(run);
  }
  return rows;
}

/**
 * The latest runs whose jobs the rows want: not read yet, still going, or not
 * as they were read (another attempt, another state). Running ones first, then
 * the newest; no more than `cap`.
 */
export function jobsToRead(rows: readonly PipeRow[], held: ReadonlyMap<string, HeldJobs>, cap: number = JOBS_PER_READ): CiRun[] {
  const want = rows
    .map((r) => r.runs[0])
    .filter((run): run is CiRun => !!run)
    .filter((run) => {
      const h = held.get(run.id);
      return !h || isActive(run.state) || h.state !== run.state || h.attempt !== run.attempt;
    });
  return want.sort((a, b) => Number(isActive(b.state)) - Number(isActive(a.state)) || b.created - a.created).slice(0, cap);
}

/**
 * The list's filter and order (ADR 0050). Called pipelines stand under the
 * ones an event starts, whatever the order: they run inside those.
 */
export const PIPE_SCHEMA: ListSchema<PipeRow> = {
  text: (r) => `${r.name} ${r.rel} ${r.callers.join(" ")}`,
  sorts: [
    { id: "time", firstDir: "desc", compare: (a, b) => (a.runs[0]?.created ?? 0) - (b.runs[0]?.created ?? 0), missing: (r) => !r.runs.length },
    { id: "name", firstDir: "asc", compare: (a, b) => a.name.localeCompare(b.name) },
  ],
  facets: [
    { id: "state", value: (r) => r.runs[0]?.state ?? "", order: ["failed", "running", "queued", "waiting", "manual", "ok", "cancelled", "skipped", "neutral"] },
  ],
  tie: (a, b) => a.name.localeCompare(b.name),
  rank: (r) => (r.called ? 1 : 0),
};
