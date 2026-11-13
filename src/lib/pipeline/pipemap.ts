// The map of a group of pipelines (ADR 0068): the events that start them, the
// pipelines themselves, and how they call one another — a reusable workflow,
// a GitLab child pipeline, a workflow that starts when another one ends
// (`workflow_run`). For a chosen event each pipeline is played by `pipesim.ts`.

import { baseName } from "../files/fspath";
import type { Pipeline } from "./pipeline";
import { eventPresets, planFor, type Plan, type PipeEvent } from "./pipesim";

export interface MapCard {
  /** The file — unique within the map. */
  id: string;
  pipeline: Pipeline;
  /** Started only by another pipeline. */
  called: boolean;
}

export interface MapCall {
  from: string;
  to: string;
  /** `workflow_run`: starts when the other ends, rather than being called by it. */
  after: boolean;
}

export interface PipelineMap {
  cards: MapCard[];
  calls: MapCall[];
  events: PipeEvent[];
}

const eventKey = (e: PipeEvent): string => `${e.kind}:${e.ref}`;

/** Cards, calls and the events worth a button, for a group's pipelines. */
export function buildMap(pipelines: readonly Pipeline[], defaultBranch = "main"): PipelineMap {
  const cards: MapCard[] = [];
  const calls: MapCall[] = [];
  const add = (p: Pipeline, called: boolean) => {
    const known = cards.find((c) => c.id === p.file);
    if (known) {
      known.called &&= called;
      return;
    }
    cards.push({ id: p.file, pipeline: p, called });
  };
  pipelines.forEach((p) => add(p, p.callable));
  // The loader reads calls to a fixed depth; a pipeline met again is not walked twice.
  const walked = new Set<Pipeline>();
  const visit = (p: Pipeline) => {
    if (walked.has(p)) return;
    walked.add(p);
    for (const job of p.jobs) {
      const inner = job.call?.pipeline;
      if (!inner) continue;
      add(inner, true);
      if (!calls.some((c) => c.from === p.file && c.to === inner.file)) calls.push({ from: p.file, to: inner.file, after: false });
      visit(inner);
    }
  };
  pipelines.forEach(visit);
  for (const p of pipelines) {
    for (const t of p.triggers.filter((x) => x.event === "workflow_run")) {
      for (const name of t.workflows) {
        const source = pipelines.find((o) => o.name === name || baseName(o.file) === name);
        if (source && source !== p) calls.push({ from: source.file, to: p.file, after: true });
      }
    }
  }
  const events: PipeEvent[] = [];
  for (const p of pipelines) {
    for (const e of eventPresets(p, defaultBranch)) if (e.kind !== "call" && !events.some((x) => eventKey(x) === eventKey(e))) events.push(e);
  }
  return { cards, calls, events };
}

/** For an event: each card's plan — a called card played as called, the rest as started by it. */
export function mapPlans(map: PipelineMap, event: PipeEvent): Map<string, Plan> {
  const out = new Map<string, Plan>();
  for (const card of map.cards) out.set(card.id, planFor(card.pipeline, event, card.called));
  return out;
}

/** The cards an event starts by itself (not through a call). */
export function startedBy(map: PipelineMap, event: PipeEvent): string[] {
  return map.cards.filter((c) => !c.called && planFor(c.pipeline, event).created !== false).map((c) => c.id);
}

export { eventKey };
