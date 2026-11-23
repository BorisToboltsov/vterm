<script lang="ts">
  // Two texts side by side, PyCharm's way (v1.36, `sidediff.ts`): each pane a
  // read-only CodeMirror that scrolls on its own, the other following so their
  // middles correspond; no blank padding on the side without lines — a thin line
  // marks where the text goes — and a ribbon in the strip between the panes ties
  // each chunk's two sides together. ↑/↓ (F7/⇧F7) step through the chunks; the
  // strip on the right marks where they are, a click on a mark goes there.
  //
  // Used by `DiffModal` before a save and on a conflict. Long lines wrap: the
  // ribbons and the sync go by each line's own height, not by line numbers.
  import { EditorState, Text, type Extension, type Range } from "@codemirror/state";
  import { Decoration, EditorView, lineNumbers } from "@codemirror/view";
  import { onDestroy, untrack } from "svelte";
  import { editorTheme } from "./cmtheme";
  import { cspNonceExtension } from "./cspnonce";
  import {
    chunkMiddle,
    followScroll,
    glideStep,
    lineChunks,
    ribbonEdges,
    ribbonPath,
    scrollToMiddle,
    stepChunk,
    stripMarks,
    type ChunkBox,
    type ChunkKind,
    type LineChunk,
    type PaneScroll,
    type Side,
    type StripMark,
  } from "./sidediff";
  import { activeTerminalTheme } from "../settings/settings.svelte";
  import { reducedMotion } from "../ui/motion";
  import { tooltip } from "../actions/tooltip";
  import Icon from "../ui/Icon.svelte";
  import { t } from "../i18n";

  let {
    original,
    modified,
    originalLabel,
    modifiedLabel,
  }: {
    /** Left side — what is on the server. */
    original: string;
    /** Right side — what will be written. */
    modified: string;
    originalLabel: string;
    modifiedLabel: string;
  } = $props();

  /** Width of the strip between the panes, where the ribbons run. */
  const GAP = 44;

  let hostA: HTMLDivElement | undefined = $state();
  let hostB: HTMLDivElement | undefined = $state();
  let gapEl: SVGSVGElement | undefined = $state();
  let stripH = $state(0);
  let gapH = $state(0);
  let viewA: EditorView | undefined;
  let viewB: EditorView | undefined;

  let chunks = $state.raw<LineChunk[]>([]);
  let boxes = $state.raw<ChunkBox[]>([]);
  let ribbons = $state.raw<{ fill: string; edge: string; kind: ChunkKind }[]>([]);
  let marks = $state.raw<StripMark[]>([]);
  let current = $state(-1);

  /** A scroll this component made, per pane: its event is not the user's. */
  const ours: Record<Side, number> = { a: NaN, b: NaN };
  let glide = 0;
  let frame = 0;
  let opening = 0;

  const view = (side: Side) => (side === "a" ? viewA : viewB);
  const otherSide = (side: Side): Side => (side === "a" ? "b" : "a");

  /** Changed lines, changed characters and the line where the other side's text goes. */
  function decorations(doc: Text, side: Side, changed: readonly LineChunk[]): Extension {
    const ranges: Range<Decoration>[] = [];
    const lineClass = (i: number, cls: string) => ranges.push(Decoration.line({ class: cls }).range(doc.line(i + 1).from));
    for (const c of changed) {
      const from = side === "a" ? c.fromA : c.fromB;
      const to = side === "a" ? c.toA : c.toB;
      if (from === to) {
        // No lines on this side: a line where they would stand.
        if (from < doc.lines) lineClass(from, `cm-sd-gap cm-sd-gap-above cm-sd-${c.kind}`);
        else lineClass(doc.lines - 1, `cm-sd-gap cm-sd-gap-below cm-sd-${c.kind}`);
        continue;
      }
      for (let i = from; i < to; i++) lineClass(i, `cm-sd-line cm-sd-${c.kind}`);
      for (const [f, e] of side === "a" ? c.words.a : c.words.b) {
        ranges.push(Decoration.mark({ class: "cm-sd-word" }).range(f, e));
      }
    }
    return EditorView.decorations.of(Decoration.set(ranges, true));
  }

  /** Tints from the theme's own status colours, so every theme reads them. */
  const diffTheme = EditorView.theme({
    "&": { height: "100%" },
    ".cm-scroller": { overflow: "auto", scrollbarWidth: "thin" },
    ".cm-sd-line.cm-sd-add": { backgroundColor: "color-mix(in srgb, var(--color-ok) 14%, transparent)" },
    ".cm-sd-line.cm-sd-del": { backgroundColor: "color-mix(in srgb, var(--color-bad) 14%, transparent)" },
    ".cm-sd-line.cm-sd-mod": { backgroundColor: "color-mix(in srgb, var(--color-accent) 14%, transparent)" },
    ".cm-sd-word": { backgroundColor: "color-mix(in srgb, var(--color-accent) 34%, transparent)", borderRadius: "2px" },
    ".cm-sd-gap-above.cm-sd-add": { boxShadow: "inset 0 1.5px 0 var(--color-ok)" },
    ".cm-sd-gap-above.cm-sd-del": { boxShadow: "inset 0 1.5px 0 var(--color-bad)" },
    ".cm-sd-gap-below.cm-sd-add": { boxShadow: "inset 0 -1.5px 0 var(--color-ok)" },
    ".cm-sd-gap-below.cm-sd-del": { boxShadow: "inset 0 -1.5px 0 var(--color-bad)" },
  });

  function editor(doc: Text, side: Side, changed: readonly LineChunk[], parent: HTMLElement): EditorView {
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          // Let CodeMirror's runtime style element pass the packaged-build CSP (cspnonce.ts).
          cspNonceExtension(),
          lineNumbers(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          editorTheme(activeTerminalTheme()),
          diffTheme,
          decorations(doc, side, changed),
          EditorView.updateListener.of((u) => {
            if (u.geometryChanged || u.heightChanged || u.viewportChanged) schedule();
          }),
        ],
      }),
    });
  }

  /** A chunk's span on one side, in document pixels. */
  function span(v: EditorView, from: number, to: number): [number, number] {
    const doc = v.state.doc;
    if (from === to) {
      const y = from < doc.lines ? v.lineBlockAt(doc.line(from + 1).from).top : v.lineBlockAt(doc.length).bottom;
      return [y, y];
    }
    return [v.lineBlockAt(doc.line(from + 1).from).top, v.lineBlockAt(doc.line(to).from).bottom];
  }

  const textHeight = (v: EditorView) => v.lineBlockAt(v.state.doc.length).bottom;

  function pane(v: EditorView): PaneScroll {
    const s = v.scrollDOM;
    return {
      top: s.scrollTop,
      view: s.clientHeight,
      offset: v.documentTop - s.getBoundingClientRect().top + s.scrollTop,
      max: s.scrollHeight - s.clientHeight,
    };
  }

  /** Measure the chunks again and redraw: heights settle as lines come into view. */
  function measure() {
    if (!viewA || !viewB) return;
    const a = viewA;
    const b = viewB;
    boxes = chunks.map((c) => {
      const [a0, a1] = span(a, c.fromA, c.toA);
      const [b0, b1] = span(b, c.fromB, c.toB);
      return { a0, a1, b0, b1 };
    });
    marks = stripMarks(
      boxes,
      chunks.map((c) => c.kind),
      textHeight(b),
      stripH,
    );
    draw();
  }

  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  }

  /** The ribbons for where the panes stand now, in the strip's coordinates. */
  function draw() {
    if (!viewA || !viewB || !gapEl) return;
    const top = gapEl.getBoundingClientRect().top;
    const dA = viewA.documentTop - top;
    const dB = viewB.documentTop - top;
    const out: typeof ribbons = [];
    boxes.forEach((box, i) => {
      const shown = { a0: box.a0 + dA, a1: box.a1 + dA, b0: box.b0 + dB, b1: box.b1 + dB };
      if (Math.max(shown.a1, shown.b1) < -4 || Math.min(shown.a0, shown.b0) > gapH + 4) return;
      out.push({ fill: ribbonPath(shown, GAP), edge: ribbonEdges(shown, GAP), kind: chunks[i].kind });
    });
    ribbons = out;
  }

  /** The other pane catches up with `lead`, gliding over a jump across a block. */
  function follow(lead: Side) {
    const a = viewA;
    const b = viewB;
    if (!a || !b) return;
    const side = otherSide(lead);
    const [lv, ov] = lead === "a" ? [a, b] : [b, a];
    const target = followScroll(boxes, lead, pane(lv), pane(ov), { a: textHeight(a), b: textHeight(b) });
    const still = reducedMotion();
    cancelAnimationFrame(glide);
    const step = () => {
      const el = ov.scrollDOM;
      const next = glideStep(el.scrollTop, target, ov.defaultLineHeight, still);
      if (Math.abs(el.scrollTop - next) >= 0.5) {
        ours[side] = next;
        el.scrollTop = next;
      }
      draw();
      if (Math.abs(next - target) >= 0.5) glide = requestAnimationFrame(step);
    };
    step();
  }

  function scrolled(side: Side) {
    const v = view(side);
    if (!v) return;
    if (Math.abs(v.scrollDOM.scrollTop - ours[side]) < 1) {
      ours[side] = NaN;
      draw();
      return;
    }
    ours[side] = NaN;
    follow(side);
  }

  /** Bring chunk `i` to the middle, by the side that has its lines. */
  function goTo(i: number) {
    if (i < 0 || i >= boxes.length) return;
    current = i;
    const { side, y } = chunkMiddle(boxes[i]);
    const v = view(side);
    if (!v) return;
    const top = scrollToMiddle(y, pane(v));
    if (Math.abs(v.scrollDOM.scrollTop - top) < 1) follow(side);
    else v.scrollDOM.scrollTop = top;
  }

  const step = (dir: 1 | -1) => goTo(stepChunk(chunks.length, current, dir));

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "F7" || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  }

  function teardown() {
    cancelAnimationFrame(glide);
    cancelAnimationFrame(frame);
    cancelAnimationFrame(opening);
    viewA?.destroy();
    viewB?.destroy();
    viewA = viewB = undefined;
  }

  /** Both panes for two texts; returns their teardown. */
  function build(a: Text, b: Text, parentA: HTMLElement, parentB: HTMLElement): () => void {
    teardown();
    const changed = lineChunks(a, b);
    chunks = changed;
    current = -1;
    const va = editor(a, "a", changed, parentA);
    const vb = editor(b, "b", changed, parentB);
    viewA = va;
    viewB = vb;
    const listenA = () => scrolled("a");
    const listenB = () => scrolled("b");
    va.scrollDOM.addEventListener("scroll", listenA, { passive: true });
    vb.scrollDOM.addEventListener("scroll", listenB, { passive: true });
    // Open on the first change, as PyCharm does: a long file may start far from it.
    opening = requestAnimationFrame(() => {
      measure();
      if (changed.length) goTo(0);
    });
    return () => {
      va.scrollDOM.removeEventListener("scroll", listenA);
      vb.scrollDOM.removeEventListener("scroll", listenB);
      teardown();
    };
  }

  // (Re)build both panes whenever the texts change. CodeMirror splits lines on
  // \r\n, \r and \n alike; so does this.
  $effect(() => {
    const a = Text.of(original.split(/\r\n?|\n/));
    const b = Text.of(modified.split(/\r\n?|\n/));
    const parentA = hostA;
    const parentB = hostB;
    if (!parentA || !parentB) return;
    return untrack(() => build(a, b, parentA, parentB));
  });

  // The strip and the gap change size with the dialog: marks and ribbons follow.
  $effect(() => {
    void stripH;
    void gapH;
    untrack(schedule);
  });

  onDestroy(teardown);

  const counter = $derived(
    chunks.length === 0
      ? t("diff.none")
      : current >= 0
        ? t("diff.position", { n: current + 1, count: chunks.length })
        : t("diff.count", { count: chunks.length }),
  );

  const FILL: Record<ChunkKind, string> = { add: "fill-ok/15", del: "fill-bad/15", mod: "fill-accent/15" };
  const EDGE: Record<ChunkKind, string> = { add: "stroke-ok/70", del: "stroke-bad/70", mod: "stroke-accent/70" };
  const MARK: Record<ChunkKind, string> = { add: "bg-ok", del: "bg-bad", mod: "bg-accent" };
</script>

<div class="flex h-full min-h-0 flex-col" role="presentation" {onkeydown} data-testid="diff-panes">
  <div class="mb-2 flex items-center gap-1 text-xs text-muted">
    <button
      type="button"
      class="rounded p-1 text-text hover:bg-edge disabled:opacity-40"
      aria-label={t("diff.prev")}
      use:tooltip={t("diff.prev")}
      disabled={chunks.length === 0}
      data-testid="diff-prev"
      onclick={() => step(-1)}><Icon name="arrowUp" size={13} /></button
    >
    <button
      type="button"
      class="rounded p-1 text-text hover:bg-edge disabled:opacity-40"
      aria-label={t("diff.next")}
      use:tooltip={t("diff.next")}
      disabled={chunks.length === 0}
      data-testid="diff-next"
      onclick={() => step(1)}><Icon name="arrowDown" size={13} /></button
    >
    <span class="ml-1" data-testid="diff-counter">{counter}</span>
    <span class="flex-1"></span>
    <span class="flex items-center gap-3">
      <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-ok"></span>{t("diff.added")}</span>
      <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-accent"></span>{t("diff.changed")}</span>
      <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-bad"></span>{t("diff.removed")}</span>
    </span>
  </div>
  <div class="mb-1 grid text-xs text-muted" style:grid-template-columns="minmax(0,1fr) {GAP}px minmax(0,1fr) 10px">
    <span class="truncate">{originalLabel}</span>
    <span></span>
    <span class="truncate">{modifiedLabel}</span>
  </div>
  <div
    class="grid min-h-0 flex-1 overflow-hidden rounded border border-edge text-sm"
    style:grid-template-columns="minmax(0,1fr) {GAP}px minmax(0,1fr) 10px"
  >
    <div bind:this={hostA} class="min-h-0 min-w-0 overflow-hidden" data-testid="diff-a"></div>
    <div class="relative min-h-0 border-x border-edge" bind:clientHeight={gapH}>
      <svg bind:this={gapEl} class="absolute inset-0 h-full w-full" aria-hidden="true">
        {#each ribbons as r, i (i)}
          <path d={r.fill} class={FILL[r.kind]} />
          <path d={r.edge} class="fill-none {EDGE[r.kind]}" stroke-width="1" />
        {/each}
      </svg>
    </div>
    <div bind:this={hostB} class="min-h-0 min-w-0 overflow-hidden" data-testid="diff-b"></div>
    <div class="relative min-h-0 border-l border-edge bg-panel" bind:clientHeight={stripH}>
      {#each marks as m (m.index)}
        <button
          type="button"
          class="absolute inset-x-px rounded-sm {MARK[m.kind]}"
          style:top="{m.top}px"
          style:height="{m.height}px"
          aria-label={t("diff.position", { n: m.index + 1, count: chunks.length })}
          data-testid="diff-mark"
          onclick={() => goTo(m.index)}
        ></button>
      {/each}
    </div>
  </div>
</div>
