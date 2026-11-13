// A pipeline as Mermaid text (ADR 0068), to paste into a README or an issue:
// `flowchart LR`, GitLab stages as subgraphs, written `needs` as arrows. Labels
// are quoted and stripped of what would end the quote — the text comes from a
// file on a server.

import { columnsOf, type GraphMode } from "./pipelayout";
import type { PipeJob, Pipeline } from "./pipeline";

const quote = (s: string): string => `"${s.replace(/["\n\r<>]/g, " ").replace(/\s+/g, " ").trim()}"`;

function label(job: PipeJob): string {
  const marks: string[] = [];
  if (job.matrix?.items) marks.push(`×${job.matrix.items.length}`);
  if (job.when === "manual") marks.push("manual");
  if (job.environment) marks.push(`env: ${job.environment}`);
  if (job.call) marks.push(`→ ${job.call.file}`);
  return quote(marks.length ? `${job.name} (${marks.join(", ")})` : job.name);
}

export function toMermaid(pipeline: Pipeline, mode: GraphMode): string {
  const ids = new Map(pipeline.jobs.map((j, i) => [j.id, `j${i}`]));
  const lines = ["flowchart LR"];
  if (pipeline.kind === "gitlab" && mode === "stages") {
    const { titles } = columnsOf(pipeline, mode);
    titles.forEach((stage, s) => {
      lines.push(`  subgraph s${s}[${quote(stage ?? "")}]`);
      lines.push("    direction TB");
      for (const job of pipeline.jobs.filter((j) => j.stage === stage)) lines.push(`    ${ids.get(job.id)}[${label(job)}]`);
      lines.push("  end");
    });
    titles.slice(1).forEach((_, s) => lines.push(`  s${s} --> s${s + 1}`));
  } else {
    for (const job of pipeline.jobs) lines.push(`  ${ids.get(job.id)}[${label(job)}]`);
  }
  for (const job of pipeline.jobs) {
    for (const need of job.needs ?? []) {
      const from = ids.get(need.job);
      if (from) lines.push(`  ${from} --> ${ids.get(job.id)}`);
    }
  }
  return lines.join("\n") + "\n";
}
