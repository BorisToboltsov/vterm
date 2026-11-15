// A pipeline as a handful of dots (ADR 0070): its jobs in the columns of its
// schema — GitLab's stages, or how far down its `needs` a job is on GitHub —
// one dot a job, a matrix too, its written `needs` as thin lines. Small enough
// for a row of the CI panel's lists, where the schema itself does not fit: it
// says how the pipeline is built and, with a run's states, where that run went.
//
// A column taller than `rows` and the columns past `cols` are not drawn; how
// many jobs that leaves out is said (`hidden`), not hidden. Geometry in units at
// 100 % scale — the component multiplies (`uiPx`). Pure: no DOM.

import { columnsOf } from "./pipelayout";
import type { Pipeline } from "./pipeline";

export const DOTS = {
  /** Between columns. */
  pitchX: 10,
  /** Between dots of a column. */
  pitchY: 6,
  r: 2.4,
  pad: 3,
  /** Dots a column shows at most. */
  rows: 4,
  /** Columns shown at most. */
  cols: 8,
} as const;

export interface DotsLayout {
  dots: { id: string; x: number; y: number }[];
  /** `needs` between dots that are drawn. */
  links: { from: string; to: string; d: string }[];
  /** Jobs without a dot: past the rows of their column, or in a column past the last. */
  hidden: number;
  width: number;
  height: number;
}

const n = (v: number): number => Math.round(v * 100) / 100;

export function dotsOf(pipeline: Pipeline, rows: number = DOTS.rows, cols: number = DOTS.cols): DotsLayout {
  const { col, titles } = columnsOf(pipeline, pipeline.kind === "gitlab" ? "stages" : "links");
  const ncol = Math.min(cols, Math.max(1, titles.length));
  const columns: string[][] = Array.from({ length: ncol }, () => []);
  let hidden = 0;
  for (const job of pipeline.jobs) {
    const c = col.get(job.id) ?? 0;
    if (c >= ncol || columns[c].length >= rows) hidden++;
    else columns[c].push(job.id);
  }
  // Empty stages are not columns of dots: GitLab leaves them out of the graph too.
  const shown = columns.filter((c) => c.length > 0);
  const tallest = Math.max(1, ...shown.map((c) => c.length));
  const at = new Map<string, [number, number]>();
  const dots: DotsLayout["dots"] = [];
  shown.forEach((ids, i) => {
    // A shorter column stands in the middle of the tallest.
    const top = DOTS.pad + ((tallest - ids.length) * DOTS.pitchY) / 2;
    ids.forEach((id, k) => {
      const x = DOTS.pad + i * DOTS.pitchX;
      const y = top + k * DOTS.pitchY;
      at.set(id, [x, y]);
      dots.push({ id, x: n(x), y: n(y) });
    });
  });
  const links: DotsLayout["links"] = [];
  for (const job of pipeline.jobs) {
    const to = at.get(job.id);
    if (!to || !job.needs) continue;
    for (const need of job.needs) {
      const from = at.get(need.job);
      if (!from) continue;
      const bend = DOTS.pitchX / 2;
      links.push({
        from: need.job,
        to: job.id,
        d: `M${n(from[0])} ${n(from[1])} C${n(from[0] + bend)} ${n(from[1])} ${n(to[0] - bend)} ${n(to[1])} ${n(to[0])} ${n(to[1])}`,
      });
    }
  }
  return {
    dots,
    links,
    hidden,
    width: n(2 * DOTS.pad + Math.max(0, shown.length - 1) * DOTS.pitchX),
    height: n(2 * DOTS.pad + (tallest - 1) * DOTS.pitchY),
  };
}
