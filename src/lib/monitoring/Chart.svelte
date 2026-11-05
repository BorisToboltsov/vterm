<script lang="ts">
  // A history chart of the monitoring page (v1.33). Where things go is decided by
  // chartgeom.ts; this only draws it at the current moment. Every sample has a
  // fixed slot counted from the right edge, the edge runs to the newest sample
  // (LINE_MS) and the scale to its new ceiling (SCALE_MS), through tween.ts — so a
  // poll slides the line in instead of squeezing or snapping it. The frame loop
  // runs only while something moves; at rest the chart costs nothing. With
  // reduced motion every change lands at once.
  //
  // The SVG is drawn in real pixels (the wrapper's measured width), so lines,
  // markers and labels keep their shape at any size.
  import { onDestroy, untrack } from "svelte";
  import {
    areaPath,
    bandPath,
    edgeDot,
    HISTORY,
    linePath,
    monotonePath,
    niceCeil,
    runs,
    stack,
    timeMarks,
    windowMax,
    type Pt,
    type Sample,
  } from "./chartgeom";
  import { fmtAgo } from "./format";
  import { LINE_MS, retarget, SCALE_MS, still, tweenAt, type Tween } from "../ui/tween";
  import { motionMs, prefersReducedMotion } from "../ui/motion";
  import { t } from "../i18n";

  type Line = { samples: readonly Sample[]; color: string; fill?: boolean; width?: number };

  let {
    lines,
    seq,
    max = undefined,
    floor = 1,
    stacked = false,
    total = true,
    mirror = false,
    height = 48,
    ticks = false,
    format = (v: number) => String(Math.round(v)),
    scaleLabel = false,
    threshold = null,
    thresholdLabel = "",
    marks = false,
    interval = 5,
    dot = true,
    slots = HISTORY,
    class: cls = "",
    testid = undefined,
  }: {
    lines: Line[];
    /** The newest sample number; −1 before the first poll. */
    seq: number;
    /** A fixed ceiling (100 for percentages); omitted — a round ceiling of the window, eased. */
    max?: number;
    /** The lowest automatic ceiling. */
    floor?: number;
    /** Layers summed bottom-up, drawn as bands with the total on top. */
    stacked?: boolean;
    /** Draw the stack's total line — not when the layers always sum to the ceiling (memory). */
    total?: boolean;
    /** `lines[0]` up from the middle, `lines[1]` down (receive / send). */
    mirror?: boolean;
    height?: number;
    /** Values at 0, half and the ceiling on the left. */
    ticks?: boolean;
    format?: (v: number) => string;
    /** Name the ceiling in the corner — for automatically scaled charts. */
    scaleLabel?: boolean;
    threshold?: number | null;
    thresholdLabel?: string;
    /** Time marks under the chart. */
    marks?: boolean;
    /** Seconds between samples, for the marks. */
    interval?: number;
    dot?: boolean;
    slots?: number;
    class?: string;
    testid?: string;
  } = $props();

  const uid = $props.id();
  let width = $state(0);
  const reduce = prefersReducedMotion();
  const lineMs = motionMs(LINE_MS, reduce);
  const scaleMs = motionMs(SCALE_MS, reduce);

  // The ceiling the data asks for, from the samples in the window.
  const target = $derived.by(() => {
    if (max != null) return max;
    const layers = stacked ? [stack(lines.map((l) => l.samples)).at(-1)?.top ?? []] : lines.map((l) => l.samples);
    return niceCeil(windowMax(layers, seq, slots), floor);
  });

  let axisTw = $state.raw<Tween>(still(null));
  let scaleTw = $state.raw<Tween>(still(null));
  let now = $state(0);
  let raf = 0;

  function step(at: number) {
    raf = 0;
    now = at;
    if (at - axisTw.at < lineMs || at - scaleTw.at < scaleMs) raf = requestAnimationFrame(step);
  }

  // A new sample or a new ceiling: set off towards it from where the chart stands.
  $effect(() => {
    const s = seq;
    const top = target;
    untrack(() => {
      const at = performance.now();
      axisTw = retarget(axisTw, s < 0 ? null : s, at, lineMs, null);
      scaleTw = retarget(scaleTw, top, at, scaleMs, null);
      now = at;
      if (!raf && (lineMs > 0 || scaleMs > 0)) raf = requestAnimationFrame(step);
    });
  });
  onDestroy(() => cancelAnimationFrame(raf));

  const GUTTER = 30;
  const MARKS_H = 14;
  const left = $derived(ticks ? GUTTER : 0);
  const plotW = $derived(Math.max(0, width - left - 5));
  const top = 4;
  const plotH = $derived(Math.max(4, height - top - 3 - (marks ? MARKS_H : 0)));
  const axis = $derived(tweenAt(axisTw, now, lineMs));
  const scale = $derived(tweenAt(scaleTw, now, scaleMs) ?? target);

  type Drawn = { color: string; width: number; d: string[]; area: string[]; dot: Pt | null };

  const drawn = $derived.by((): Drawn[] => {
    if (axis == null || plotW <= 0) return [];
    const frame = { axis, width: plotW, top, height: plotH, max: scale, slots };
    if (stacked) {
      const layers = stack(lines.map((l) => l.samples));
      return layers.map((layer, i) => {
        const bands: string[] = [];
        let topPts: Pt[] = [];
        let basePts: Pt[] = [];
        const flush = () => {
          if (topPts.length > 1) bands.push(bandPath(topPts, basePts));
          topPts = [];
          basePts = [];
        };
        layer.top.forEach((t, k) => {
          const b = layer.base[k];
          if (t.v == null || b.v == null) return flush();
          const [tp] = runs([t], frame);
          const [bp] = runs([b], frame);
          if (!tp || !bp) return flush();
          topPts.push(tp[0]);
          basePts.push(bp[0]);
        });
        flush();
        const last = i === layers.length - 1 && total;
        const totals = last ? runs(layer.top, frame) : [];
        return {
          color: lines[i].color,
          width: 1.4,
          d: totals.map(linePath),
          area: bands,
          dot: last && dot ? edgeDot(totals.at(-1) ?? [], plotW) : null,
        };
      });
    }
    return lines.map((l, i) => {
      const half = mirror ? plotH / 2 : plotH;
      const f = mirror ? { ...frame, height: half, top: i === 0 ? top : top + half, down: i === 1 } : frame;
      const base = mirror ? top + half : top + plotH;
      const rs = runs(l.samples, f);
      const ds = rs.map((r) => monotonePath(r));
      return {
        color: l.color,
        width: l.width ?? 1.6,
        d: ds,
        area: l.fill || mirror ? ds.map((d, k) => areaPath(d, rs[k], base)) : [],
        dot: dot ? edgeDot(rs.at(-1) ?? [], plotW) : null,
      };
    });
  });

  const tickValues = $derived(ticks ? [0, scale / 2, scale] : []);
  const yAt = (v: number) => top + plotH - (scale > 0 ? Math.min(1, v / scale) : 0) * plotH;
</script>

<div bind:clientWidth={width} class="relative {cls}" style="height: {height}px" data-testid={testid}>
  {#if width > 0}
    <svg {width} {height} viewBox="0 0 {width} {height}" class="block overflow-visible" role="img" aria-hidden="true">
      <defs>
        <clipPath id="clip-{uid}"><rect x="0" y="0" width={plotW} height={height} /></clipPath>
      </defs>
      {#each tickValues as v, i (i)}
        <line
          x1={left}
          x2={left + plotW}
          y1={yAt(v)}
          y2={yAt(v)}
          class="stroke-edge"
          stroke-dasharray={i === 0 ? undefined : "2 4"}
        />
        <text x={left - 5} y={yAt(v) + 3.5} text-anchor="end" class="fill-muted text-caption tabular-nums">{format(v)}</text>
      {/each}
      {#if mirror}
        <line x1={left} x2={left + plotW} y1={top + plotH / 2} y2={top + plotH / 2} class="stroke-edge" />
      {/if}
      {#if threshold != null && threshold <= scale}
        <line
          x1={left}
          x2={left + plotW}
          y1={yAt(threshold)}
          y2={yAt(threshold)}
          stroke="var(--color-warn)"
          stroke-opacity="0.7"
          stroke-dasharray="4 3"
        />
        {#if thresholdLabel}
          <text x={left + plotW} y={yAt(threshold) - 3} text-anchor="end" fill="var(--color-warn)" class="text-caption">{thresholdLabel}</text>
        {/if}
      {/if}
      <g transform="translate({left},0)">
        <g clip-path="url(#clip-{uid})">
          {#each drawn as s, i (i)}
            {#each s.area as a, k (k)}
              <path d={a} style="fill: {s.color}" fill-opacity={stacked ? 0.55 : 0.12} />
            {/each}
            {#each s.d as d, k (k)}
              <path
                {d}
                fill="none"
                style="stroke: {stacked ? 'var(--color-text)' : s.color}"
                stroke-width={s.width}
                stroke-linejoin="round"
                stroke-linecap="round"
              />
            {/each}
          {/each}
        </g>
        {#each drawn as s, i (i)}
          {#if s.dot}
            <circle
              cx={s.dot.x}
              cy={s.dot.y}
              r="3"
              style="fill: {stacked ? 'var(--color-text)' : s.color}"
              class="stroke-panel"
              stroke-width="2"
            />
          {/if}
        {/each}
      </g>
      {#if scaleLabel}
        <text x={left + plotW} y={top + 9} text-anchor="end" class="fill-muted text-caption tabular-nums">{format(scale)}</text>
      {/if}
      {#if marks}
        {#each timeMarks(slots, interval) as m, i (i)}
          <text
            x={left + m.at * plotW}
            y={height - 2}
            text-anchor={i === 0 ? "start" : m.ago === 0 ? "end" : "middle"}
            class="fill-muted text-caption tabular-nums">{m.ago === 0 ? t("mon.now") : fmtAgo(m.ago)}</text
          >
        {/each}
      {/if}
    </svg>
  {/if}
</div>
