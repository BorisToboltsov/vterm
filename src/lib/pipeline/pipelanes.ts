// The run of a group as lanes (ADR 0068): every pipeline an event starts is a
// lane, and its jobs stand in columns by wave — the order they run in across
// the whole group, not inside one file. A call the caller waits for (a reusable
// workflow, a GitLab child pipeline with `strategy: depend`/`mirror`) is a lane
// of its own right under the caller, started where the call job stands; the
// jobs after the call wait for the called pipeline's last jobs. A child the
// caller does not wait for keeps its trigger job, and the caller goes on. A
// `workflow_run` pipeline is a lane under the one whose end starts it.
//
// A job's column and its turn in the playback come from one list — what it
// waits for (`sources`): the column a job stands in is the step it runs at.
// Pure: no DOM.

import { topoJobs, type PipeJob, type Pipeline } from "./pipeline";
import type { PipelineMap } from "./pipemap";
import { holdsThroughGate, type RunState } from "./pipeplay";
import { planFor, runDeps, type JobVerdict, type Plan, type PipeEvent } from "./pipesim";

/** What the jobs a pipeline starts with wait for: the event itself. */
export const EVENT = "event";

/** Lanes nested deeper than this are not drawn: the loader reads four levels of calls. */
const MAX_DEPTH = 6;

export type LaneStart =
  | { kind: "event" }
  /** Called from `job` of `lane`; `waits` — the caller's job ends with this pipeline. */
  | { kind: "call"; lane: string; job: string; waits: boolean }
  /** Started when `lane` ended (`workflow_run`). */
  | { kind: "after"; lane: string };

export interface Lane {
  /** Unique within the run: a pipeline called from two places has two lanes. */
  key: string;
  /** The map card (the file). */
  card: string;
  pipeline: Pipeline;
  plan: Plan;
  /** 0 — started by the event; one more for each call or `workflow_run` on the way. */
  depth: number;
  start: LaneStart;
  /** The jobs the plan leaves out, by name: they have no turn and no column. */
  leftOut: string[];
}

export interface LaneNode {
  /** `<lane>#<job>`. */
  key: string;
  lane: string;
  job: PipeJob;
  /** The column, from 1. */
  wave: number;
  /** The row within its lane's column, from 0. */
  row: number;
  /** What it waits for: other nodes, or `EVENT`. */
  sources: string[];
  verdict: JobVerdict;
  /** The file cannot say whether it starts: shown where it would stand, never played, waited for by nobody. */
  unsure: boolean;
}

export type LinkKind = "event" | "need" | "call" | "return" | "after";

export interface LaneLink {
  from: string;
  to: string;
  kind: LinkKind;
}

export interface GroupRun {
  lanes: Lane[];
  nodes: LaneNode[];
  links: LaneLink[];
  /** Columns: the last wave. */
  waves: number;
  /** The cards the event starts nothing in. */
  idle: string[];
}

const nodeKey = (lane: string, job: string) => `${lane}#${job}`;

/** The run of `event` across the map: `starts` — the cards it starts by itself (`startedBy`). */
export function groupRun(map: PipelineMap, event: PipeEvent, starts: readonly string[]): GroupRun {
  const lanes: Lane[] = [];
  const nodes: LaneNode[] = [];
  /** Nodes that wait for what starts their lane rather than for a job of it. */
  const entered = new Set<string>();
  const cardOf = (id: string) => map.cards.find((c) => c.id === id);

  /** What a lane's end is: the nodes nothing else in it waits for, and the wave they end at. */
  type End = { keys: string[]; wave: number };

  const addLane = (pipeline: Pipeline, plan: Plan, key: string, depth: number, start: LaneStart, entry: End, chain: readonly string[]): End => {
    const lane: Lane = { key, card: pipeline.file, pipeline, plan, depth, start, leftOut: [] };
    lanes.push(lane);
    const ends = new Map<string, End>();
    const waitedOn = new Set<string>();
    const place = (job: PipeJob, from: End, verdict: JobVerdict, unsure: boolean): string => {
      const k = nodeKey(key, job.id);
      nodes.push({ key: k, lane: key, job, wave: from.wave + 1, row: 0, sources: from.keys, verdict, unsure });
      if (from === entry) entered.add(k);
      return k;
    };
    for (const job of topoJobs(pipeline)) {
      const v = plan.jobs.get(job.id);
      if (!v || v.run === false) {
        lane.leftOut.push(job.name);
        continue;
      }
      const deps = runDeps(pipeline, plan, job).filter((d) => ends.has(d) && holdsThroughGate(pipeline, plan, job.id, d));
      const from: End = deps.length
        ? { keys: deps.flatMap((d) => ends.get(d)!.keys), wave: Math.max(...deps.map((d) => ends.get(d)!.wave)) }
        : entry;
      if (v.run === "?") {
        place(job, from, v, true);
        continue;
      }
      deps.forEach((d) => waitedOn.add(d));
      const callee = job.call?.pipeline;
      if (callee && depth < MAX_DEPTH && !chain.includes(callee.file)) {
        const waits = job.call!.waits;
        // A waited-for call is the called pipeline itself and has no box of its
        // own — unless it stops at a gate first; one not waited for is a job
        // that ends as soon as the child is created.
        const own = v.gate || !waits ? place(job, from, v, false) : null;
        const entry2: End = own ? { keys: [own], wave: from.wave + 1 } : from;
        const sub = addLane(callee, planFor(callee, event, true), `${key}>${job.id}`, depth + 1, { kind: "call", lane: key, job: job.id, waits }, entry2, [
          ...chain,
          callee.file,
        ]);
        ends.set(job.id, waits ? sub : entry2);
        continue;
      }
      ends.set(job.id, { keys: [place(job, from, v, false)], wave: from.wave + 1 });
    }
    // A manual job allowed to fail holds nothing after it, nor the end of its pipeline.
    const blocking = (id: string) => plan.jobs.get(id)?.gate !== "manual" || plan.jobs.get(id)?.allowFailure !== true;
    const last = [...ends.entries()].filter(([id]) => !waitedOn.has(id) && blocking(id)).map(([, e]) => e);
    const end: End = last.length ? { keys: last.flatMap((e) => e.keys), wave: Math.max(...last.map((e) => e.wave)) } : entry;
    // A pipeline that starts when this one ends stands under it.
    if (start.kind !== "call") {
      for (const call of map.calls.filter((c) => c.after && c.from === pipeline.file)) {
        const next = cardOf(call.to);
        if (!next || depth >= MAX_DEPTH || chain.includes(next.id)) continue;
        addLane(next.pipeline, planFor(next.pipeline, event, true), `${key}~${next.id}`, depth + 1, { kind: "after", lane: key }, end, [...chain, next.id]);
      }
    }
    return end;
  };

  for (const id of starts) {
    const card = cardOf(id);
    if (card) addLane(card.pipeline, planFor(card.pipeline, event), id, 0, { kind: "event" }, { keys: [EVENT], wave: 0 }, [id]);
  }
  arrangeRows(nodes);
  const laneOf = new Map(lanes.map((l) => [l.key, l]));
  const nodeOf = new Map(nodes.map((n) => [n.key, n]));
  const links: LaneLink[] = [];
  for (const n of nodes) {
    for (const s of n.sources) {
      const from = nodeOf.get(s);
      // Into a lane from what starts it — a call or the end of another — or back
      // out of a called lane into the jobs that waited for it.
      const start = laneOf.get(n.lane)!.start.kind;
      const kind: LinkKind = !from
        ? "event"
        : from.lane === n.lane
          ? "need"
          : !entered.has(n.key)
            ? "return"
            : start === "after"
              ? "after"
              : "call";
      links.push({ from: s, to: n.key, kind });
    }
  }
  const waves = Math.max(1, ...nodes.map((n) => n.wave));
  const used = new Set(lanes.map((l) => l.card));
  return { lanes, nodes, links, waves, idle: map.cards.filter((c) => !used.has(c.id)).map((c) => c.id) };
}

/**
 * Rows within each lane's column: jobs level with what they wait for in their
 * lane where there is room, so most links run straight.
 */
function arrangeRows(nodes: LaneNode[]): void {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const groups = new Map<string, LaneNode[]>();
  for (const n of nodes) {
    const g = `${n.lane}|${n.wave}`;
    groups.set(g, [...(groups.get(g) ?? []), n]);
  }
  const order = [...groups.values()].sort((a, b) => a[0].wave - b[0].wave);
  for (const group of order) {
    const want = (n: LaneNode) => {
      const mine = n.sources.map((s) => byKey.get(s)).filter((s): s is LaneNode => !!s && s.lane === n.lane);
      return mine.length ? mine.reduce((a, s) => a + s.row, 0) / mine.length : -1;
    };
    const sorted = group.map((n, i) => ({ n, w: want(n), i })).sort((a, b) => a.w - b.w || a.i - b.i);
    let next = 0;
    for (const { n, w } of sorted) {
      n.row = Math.max(next, Math.round(w));
      next = n.row + 1;
    }
  }
}

// ── Playing the run ──────────────────────────────────────────────────────────

export interface GroupPlayback {
  states: Record<string, RunState>;
}

/** What a node is before anything runs. */
export function laneState(n: LaneNode): RunState {
  return n.unsure ? "unknown" : n.verdict.error ? "error" : "idle";
}

/** Every job that starts is waiting; nothing has run yet. */
export function startGroup(run: GroupRun): GroupPlayback {
  const states: Record<string, RunState> = {};
  for (const n of run.nodes) states[n.key] = laneState(n) === "idle" ? "wait" : laneState(n);
  return { states };
}

const done = (s: RunState | undefined) => s === "ok" || s === "warn";

/**
 * The next step: every waiting job whose sources have all finished starts — or
 * stops at its gate. Returns the jobs that started running; none — the run has
 * finished or waits for a person.
 */
export function groupStep(run: GroupRun, pb: GroupPlayback): { pb: GroupPlayback; started: string[] } {
  const states = { ...pb.states };
  const started: string[] = [];
  let gated = false;
  for (const n of run.nodes) {
    if (pb.states[n.key] !== "wait") continue;
    if (!n.sources.every((s) => s === EVENT || done(pb.states[s]))) continue;
    if (n.verdict.gate) {
      states[n.key] = "gate";
      gated = true;
      continue;
    }
    states[n.key] = "run";
    started.push(n.key);
  }
  return started.length || gated ? { pb: { states }, started } : { pb, started };
}

/** The jobs of a step have finished: as they would succeed, one allowed to fail marked as such. */
export function groupFinish(run: GroupRun, pb: GroupPlayback, keys: readonly string[]): GroupPlayback {
  const states = { ...pb.states };
  for (const k of keys) {
    if (states[k] !== "run") continue;
    states[k] = run.nodes.find((n) => n.key === k)?.verdict.allowFailure ? "warn" : "ok";
  }
  return { states };
}

/** The person lets a gated job go: it runs now. */
export function groupOpenGate(pb: GroupPlayback, key: string): GroupPlayback {
  return pb.states[key] === "gate" ? { states: { ...pb.states, [key]: "run" } } : pb;
}

/**
 * The column the run stands at: the furthest wave with a job running — between
 * steps, the furthest a job has reached; null before anything has started.
 */
export function currentWave(run: GroupRun, pb: GroupPlayback): number | null {
  const furthest = (pick: (s: RunState | undefined) => boolean) => {
    const waves = run.nodes.filter((n) => pick(pb.states[n.key])).map((n) => n.wave);
    return waves.length ? Math.max(...waves) : null;
  };
  return furthest((s) => s === "run") ?? furthest((s) => s === "gate" || done(s));
}

/** Where a lane stands: running while any of its jobs runs, done when all that start have. */
export function laneProgress(run: GroupRun, pb: GroupPlayback | null, lane: string): "idle" | "run" | "ok" | "wait" {
  const states = run.nodes.filter((n) => n.lane === lane && !n.unsure).map((n) => pb?.states[n.key] ?? "idle");
  if (!pb || !states.length) return "idle";
  if (states.includes("run")) return "run";
  if (states.every(done)) return "ok";
  return states.includes("gate") ? "wait" : states.some(done) ? "run" : "idle";
}
