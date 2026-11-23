// The side-by-side diff before a save and on a conflict (v1.36), drawn the way
// PyCharm draws it: no blank padding on the side that has no lines — a thin line
// marks where the text goes — and a ribbon between the panes ties that line to
// the block on the other side. Each pane scrolls on its own; the other follows
// so that the lines in the middle of the two views correspond, inside a change
// proportionally. So while a block scrolls past, one side stands still and the
// ribbon fans out.
//
// Pure: the changed chunks as lines (from @codemirror/merge's diff), the ribbon's
// outline, the map from one pane's middle to the other's, where a following pane
// moves to, which chunk ↑/↓ goes to, and the marks of the strip beside the panes.
// `DiffPanes.svelte` measures the editors and draws.

import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

/** What a chunk is to the one who saves: lines added, removed, or changed. */
export type ChunkKind = "add" | "del" | "mod";

/** A changed chunk in lines, 0-based, end exclusive: `fromA === toA` — none in A. */
export interface LineChunk {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  kind: ChunkKind;
  /** Changed text inside a `mod` chunk, as document offsets on each side. */
  words: { a: [number, number][]; b: [number, number][] };
}

/** The diff the merge view would show — same algorithm, same limit. */
const DIFF_CONFIG = { scanLimit: 500 };

/** The 0-based line `pos` starts; a position past the end is after the last line. */
function lineIndex(doc: Text, pos: number): number {
  return pos > doc.length ? doc.lines : doc.lineAt(pos).number - 1;
}

/** The changed chunks between `a` (on the server) and `b` (to be written). */
export function lineChunks(a: Text, b: Text): LineChunk[] {
  return Chunk.build(a, b, DIFF_CONFIG).map((c) => {
    const fromA = lineIndex(a, c.fromA);
    const fromB = lineIndex(b, c.fromB);
    const toA = c.toA === c.fromA ? fromA : lineIndex(a, c.endA) + 1;
    const toB = c.toB === c.fromB ? fromB : lineIndex(b, c.endB) + 1;
    const kind: ChunkKind = toA === fromA ? "add" : toB === fromB ? "del" : "mod";
    const words = { a: [] as [number, number][], b: [] as [number, number][] };
    if (kind === "mod") {
      for (const ch of c.changes) {
        if (ch.toA > ch.fromA) words.a.push([c.fromA + ch.fromA, c.fromA + ch.toA]);
        if (ch.toB > ch.fromB) words.b.push([c.fromB + ch.fromB, c.fromB + ch.toB]);
      }
    }
    return { fromA, toA, fromB, toB, kind, words };
  });
}

/**
 * A chunk's place on each side, in document pixels (0 is the top of the text):
 * `a0 === a1` — the chunk has no lines in A, and a0 is where they would go.
 */
export interface ChunkBox {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/**
 * The ribbon between the panes: the chunk's span on the left edge (`a0`–`a1`)
 * joined to its span on the right (`b0`–`b1`) by two curves, in the coordinates
 * of the strip between the panes. A side with no lines pinches to its line.
 */
export function ribbonPath(box: ChunkBox, width: number): string {
  const m = width / 2;
  const { a0, a1, b0, b1 } = box;
  return (
    `M0 ${a0} C${m} ${a0} ${m} ${b0} ${width} ${b0} ` +
    `L${width} ${b1} C${m} ${b1} ${m} ${a1} 0 ${a1} Z`
  );
}

/** The two curves alone — the ribbon's edges, stroked. */
export function ribbonEdges(box: ChunkBox, width: number): string {
  const m = width / 2;
  const { a0, a1, b0, b1 } = box;
  return `M0 ${a0} C${m} ${a0} ${m} ${b0} ${width} ${b0} M0 ${a1} C${m} ${a1} ${m} ${b1} ${width} ${b1}`;
}

/** Which pane moves first: the other one follows it. */
export type Side = "a" | "b";

/**
 * Where a point of the leading side's text corresponds to on the other side, in
 * document pixels. Outside chunks the two texts are the same lines, so the
 * distance to the last chunk carries over; inside a chunk the point moves through
 * the other side's span in proportion. Where the leading side has no lines
 * (a0 === a1) there is nothing to pass through: the other side jumps the block.
 */
export function followPoint(boxes: readonly ChunkBox[], lead: Side, y: number, heights: { a: number; b: number }): number {
  const from = (box: ChunkBox): [number, number, number, number] =>
    lead === "a" ? [box.a0, box.a1, box.b0, box.b1] : [box.b0, box.b1, box.a0, box.a1];
  const end = lead === "a" ? [heights.a, heights.b] : [heights.b, heights.a];
  let lastLead = 0;
  let lastOther = 0;
  for (const box of boxes) {
    const [l0, l1, o0, o1] = from(box);
    if (y < l0) break;
    if (y < l1) return o0 + ((y - l0) / (l1 - l0)) * (o1 - o0);
    lastLead = l1;
    lastOther = o1;
  }
  return Math.min(lastOther + (y - lastLead), Math.max(end[1], lastOther));
}

/** A pane's scroll as the sync reads it, in pixels. */
export interface PaneScroll {
  /** scrollTop of the pane. */
  top: number;
  /** Height of the pane's view. */
  view: number;
  /** Where the text starts inside the scrolled content (the editor's padding). */
  offset: number;
  /** The largest scrollTop the pane allows. */
  max: number;
}

/** The point of the text in the middle of the pane's view, in document pixels. */
export function middleOf(p: PaneScroll): number {
  return p.top + p.view / 2 - p.offset;
}

/** The scrollTop that puts document pixel `y` in the middle of the pane, as far as it can scroll. */
export function scrollToMiddle(y: number, p: PaneScroll): number {
  return Math.min(Math.max(0, y + p.offset - p.view / 2), Math.max(0, p.max));
}

/**
 * The scrollTop the following pane goes to when the leading one is at `lead`:
 * the two middles correspond.
 */
export function followScroll(
  boxes: readonly ChunkBox[],
  leadSide: Side,
  lead: PaneScroll,
  other: PaneScroll,
  heights: { a: number; b: number },
): number {
  return scrollToMiddle(followPoint(boxes, leadSide, middleOf(lead), heights), other);
}

/**
 * One frame of the following pane catching up: a jump across a block (the
 * leading side had no lines there) glides over a few frames instead of
 * snapping, a small step is taken whole. `still` — the user wants no motion.
 */
export function glideStep(current: number, target: number, line: number, still: boolean): number {
  const gap = target - current;
  if (still || Math.abs(gap) <= 2 * line) return target;
  return current + gap * 0.35;
}

/**
 * The chunk ↑/↓ (F7/⇧F7) goes to from `current` (-1: none chosen yet), round
 * the ends; -1 when there is none.
 */
export function stepChunk(count: number, current: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** The middle of a chunk on the side that has lines — where ↑/↓ brings it. */
export function chunkMiddle(box: ChunkBox): { side: Side; y: number } {
  return box.b1 > box.b0 ? { side: "b", y: (box.b0 + box.b1) / 2 } : { side: "a", y: (box.a0 + box.a1) / 2 };
}

/** A mark on the strip beside the panes, in its pixels. */
export interface StripMark {
  index: number;
  kind: ChunkKind;
  top: number;
  height: number;
}

/** The smallest mark: a removal has no lines on the right, it still shows. */
const MARK_MIN = 3;

/** The chunks as marks on a strip as tall as `strip`, against the right side's text. */
export function stripMarks(boxes: readonly ChunkBox[], kinds: readonly ChunkKind[], textHeight: number, strip: number): StripMark[] {
  if (textHeight <= 0 || strip <= 0) return [];
  const scale = strip / textHeight;
  return boxes.map((box, index) => {
    const height = Math.max(MARK_MIN, (box.b1 - box.b0) * scale);
    const top = Math.min(Math.max(0, box.b0 * scale), Math.max(0, strip - height));
    return { index, kind: kinds[index], top, height };
  });
}
