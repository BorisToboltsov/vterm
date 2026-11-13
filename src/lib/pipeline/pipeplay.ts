// Playing a plan (ADR 0068): the order a pipeline would run its jobs in, wave
// by wave — a wave starts every job whose dependencies have finished. It shows
// order, not time: how long a job takes is not in the file, so every job takes
// one step. A manual job or an environment that asks for approval stops its
// part of the run until the person lets it go (`openGate`).

import type { Pipeline } from "./pipeline";
import { runDeps, type Plan } from "./pipesim";

/** A job's place in the playback. */
export type RunState = "idle" | "wait" | "run" | "ok" | "warn" | "gate" | "skip" | "unknown" | "error";

export interface Playback {
  states: Record<string, RunState>;
  /** Waves started so far. */
  wave: number;
}

/** The states before anything runs: what the plan says of each job. */
export function planStates(plan: Plan): Record<string, RunState> {
  const out: Record<string, RunState> = {};
  for (const [id, v] of plan.jobs) {
    out[id] = v.error ? "error" : v.run === true ? "idle" : v.run === "?" ? "unknown" : "skip";
  }
  return out;
}

/** Every job that starts is waiting; nothing has run yet. */
export function startPlayback(plan: Plan): Playback {
  const states = planStates(plan);
  for (const id of Object.keys(states)) if (states[id] === "idle") states[id] = "wait";
  return { states, wave: 0 };
}

const done = (s: RunState | undefined) => s === "ok" || s === "warn";

/** Whether a dependency lets a job start: finished, or a manual job that does not hold the stages after it. */
function cleared(pipeline: Pipeline, plan: Plan, pb: Playback, jobId: string, dep: string): boolean {
  const s = pb.states[dep];
  if (done(s)) return true;
  if (s !== "gate") return false;
  const job = pipeline.jobs.find((j) => j.id === jobId);
  const explicit = job?.needs?.some((n) => n.job === dep) ?? false;
  return !explicit && plan.jobs.get(dep)?.gate === "manual" && plan.jobs.get(dep)?.allowFailure === true;
}

/**
 * Start the next wave: every waiting job whose dependencies are cleared. A job
 * behind a gate stops at it ("gate"). Returns the jobs that started running —
 * none, when the run has finished or waits for a person.
 */
export function nextWave(pipeline: Pipeline, plan: Plan, pb: Playback): { pb: Playback; started: string[] } {
  const now: Playback = { states: { ...pb.states }, wave: pb.wave };
  const started: string[] = [];
  let gated = false;
  // A job that stops at a gate may clear the jobs after it (a manual job they
  // need not wait for): look again until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const job of pipeline.jobs) {
      if (now.states[job.id] !== "wait") continue;
      const deps = runDeps(pipeline, plan, job);
      if (!deps.every((d) => cleared(pipeline, plan, now, job.id, d))) continue;
      if (plan.jobs.get(job.id)?.gate) {
        now.states[job.id] = "gate";
        gated = changed = true;
        continue;
      }
      now.states[job.id] = "run";
      started.push(job.id);
    }
  }
  const states = now.states;
  if (!started.length && !gated) return { pb, started };
  return { pb: { states, wave: started.length ? pb.wave + 1 : pb.wave }, started };
}

/** The jobs of a wave have finished: as they would succeed, a job allowed to fail marked as such. */
export function finishJobs(plan: Plan, pb: Playback, ids: readonly string[]): Playback {
  const states = { ...pb.states };
  for (const id of ids) if (states[id] === "run") states[id] = plan.jobs.get(id)?.allowFailure ? "warn" : "ok";
  return { ...pb, states };
}

/** The person lets a gated job go: it runs now, in a wave of its own. */
export function openGate(pb: Playback, id: string): Playback {
  if (pb.states[id] !== "gate") return pb;
  return { wave: pb.wave + 1, states: { ...pb.states, [id]: "run" } };
}

/** Where the playback stands. */
export function playbackPhase(pb: Playback): "running" | "waiting" | "done" {
  const states = Object.values(pb.states);
  if (states.includes("run") || states.includes("wait") && !states.includes("gate")) return "running";
  return states.includes("gate") ? "waiting" : "done";
}
