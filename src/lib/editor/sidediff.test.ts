import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import {
  chunkMiddle,
  followPoint,
  followScroll,
  glideStep,
  lineChunks,
  middleOf,
  ribbonEdges,
  ribbonPath,
  scrollToMiddle,
  stepChunk,
  stripMarks,
  type ChunkBox,
  type PaneScroll,
} from "./sidediff";

const doc = (lines: string[]) => Text.of(lines);

describe("lineChunks", () => {
  const base = ["services:", "  backend:", "    image: app:0.1", "    restart: unless-stopped", "    entrypoint: /app/run.sh", "  nginx:", "    ports:", "      - 443:443", "      - 80:80", "    restart: always"];

  it("finds lines added, removed and changed, as 0-based line spans", () => {
    const next = [...base];
    next[2] = "    image: app:0.2";
    next.splice(4, 0, "    deploy:", "      replicas: 2");
    next.splice(10, 1);
    const chunks = lineChunks(doc(base), doc(next));
    expect(chunks.map(({ fromA, toA, fromB, toB, kind }) => ({ fromA, toA, fromB, toB, kind }))).toEqual([
      { fromA: 2, toA: 3, fromB: 2, toB: 3, kind: "mod" },
      { fromA: 4, toA: 4, fromB: 4, toB: 6, kind: "add" },
      { fromA: 8, toA: 9, fromB: 10, toB: 10, kind: "del" },
    ]);
  });

  it("marks the changed characters of a changed line on both sides", () => {
    const a = doc(base);
    const next = [...base];
    next[2] = "    image: app:0.2";
    const b = doc(next);
    const [chunk] = lineChunks(a, b);
    expect(chunk.words.a.map(([f, t]) => a.sliceString(f, t))).toEqual(["1"]);
    expect(chunk.words.b.map(([f, t]) => b.sliceString(f, t))).toEqual(["2"]);
  });

  it("places lines added after the last one at the end of the old text", () => {
    // A file that ends with a newline: its last line is the empty one after it.
    const chunks = lineChunks(doc(["a", "b", ""]), doc(["a", "b", "c", ""]));
    expect(chunks.map(({ fromA, toA, fromB, toB, kind }) => ({ fromA, toA, fromB, toB, kind }))).toEqual([
      { fromA: 2, toA: 2, fromB: 2, toB: 3, kind: "add" },
    ]);
  });

  it("finds nothing between equal texts", () => {
    expect(lineChunks(doc(base), doc(base))).toEqual([]);
  });
});

describe("the ribbon", () => {
  it("joins the left span to the right one with two curves", () => {
    const box = { a0: 10, a1: 30, b0: 50, b1: 90 };
    expect(ribbonPath(box, 40)).toBe("M0 10 C20 10 20 50 40 50 L40 90 C20 90 20 30 0 30 Z");
    expect(ribbonEdges(box, 40)).toBe("M0 10 C20 10 20 50 40 50 M0 30 C20 30 20 90 40 90");
  });

  it("pinches to the line on a side without lines", () => {
    expect(ribbonPath({ a0: 20, a1: 20, b0: 0, b1: 60 }, 40)).toBe("M0 20 C20 20 20 0 40 0 L40 60 C20 60 20 20 0 20 Z");
  });
});

// One line is 18 px. A: 40 lines; B: 13 more lines at line 21 of A (an
// insertion), and line 30 of A is gone in B.
const L = 18;
const boxes: ChunkBox[] = [
  { a0: 21 * L, a1: 21 * L, b0: 21 * L, b1: 34 * L },
  { a0: 30 * L, a1: 31 * L, b0: 43 * L, b1: 43 * L },
];
const heights = { a: 40 * L, b: 52 * L };

describe("followPoint", () => {
  it("keeps the same line before the first change", () => {
    expect(followPoint(boxes, "a", 5 * L, heights)).toBe(5 * L);
    expect(followPoint(boxes, "b", 5 * L, heights)).toBe(5 * L);
  });

  it("scrolling through a block on the right holds the left at the line where it goes", () => {
    for (const y of [21 * L, 25 * L, 33 * L + 17]) expect(followPoint(boxes, "b", y, heights)).toBe(21 * L);
  });

  it("scrolling the left past the line jumps the right over the block", () => {
    expect(followPoint(boxes, "a", 21 * L - 1, heights)).toBe(21 * L - 1);
    expect(followPoint(boxes, "a", 21 * L, heights)).toBe(34 * L);
    expect(followPoint(boxes, "a", 25 * L, heights)).toBe(38 * L);
  });

  it("moves through a removed line in proportion and carries the offset after it", () => {
    expect(followPoint(boxes, "a", 30 * L + 9, heights)).toBe(43 * L);
    expect(followPoint(boxes, "a", 35 * L, heights)).toBe(47 * L);
    expect(followPoint(boxes, "b", 47 * L, heights)).toBe(35 * L);
  });

  it("goes no further than the other text", () => {
    expect(followPoint(boxes, "b", 60 * L, heights)).toBe(40 * L);
  });
});

describe("following scroll", () => {
  const pane = (top: number): PaneScroll => ({ top, view: 300, offset: 4, max: 600 });

  it("reads the middle of the view and puts a point there", () => {
    expect(middleOf(pane(100))).toBe(246);
    expect(scrollToMiddle(246, pane(0))).toBe(100);
  });

  it("stays inside what the pane can scroll", () => {
    expect(scrollToMiddle(10, pane(0))).toBe(0);
    expect(scrollToMiddle(5000, pane(0))).toBe(600);
  });

  it("brings the other pane's corresponding line to its middle", () => {
    const left = pane(25 * L - 146);
    expect(middleOf(left)).toBe(25 * L);
    expect(followScroll(boxes, "a", left, { ...pane(0), max: 2000 }, heights)).toBe(38 * L + 4 - 150);
  });
});

describe("glideStep", () => {
  it("takes a small step whole and glides over a jump", () => {
    expect(glideStep(100, 120, L, false)).toBe(120);
    expect(glideStep(100, 400, L, false)).toBe(205);
  });

  it("jumps at once when no motion is wanted", () => {
    expect(glideStep(100, 400, L, true)).toBe(400);
  });
});

describe("stepChunk", () => {
  it("starts at the first or the last and goes round the ends", () => {
    expect(stepChunk(3, -1, 1)).toBe(0);
    expect(stepChunk(3, -1, -1)).toBe(2);
    expect(stepChunk(3, 2, 1)).toBe(0);
    expect(stepChunk(3, 0, -1)).toBe(2);
    expect(stepChunk(0, -1, 1)).toBe(-1);
  });
});

describe("chunkMiddle", () => {
  it("brings a chunk by the side that has its lines", () => {
    expect(chunkMiddle(boxes[0])).toEqual({ side: "b", y: 27.5 * L });
    expect(chunkMiddle(boxes[1])).toEqual({ side: "a", y: 30.5 * L });
  });
});

describe("stripMarks", () => {
  it("scales the right side's text to the strip, a removal still visible", () => {
    const marks = stripMarks(boxes, ["add", "del"], heights.b, 52 * 2);
    expect(marks).toEqual([
      { index: 0, kind: "add", top: 42, height: 26 },
      { index: 1, kind: "del", top: 86, height: 3 },
    ]);
  });

  it("keeps a mark inside the strip, and none for a strip not laid out", () => {
    expect(stripMarks([{ a0: 0, a1: 0, b0: 100, b1: 100 }], ["add"], 100, 50)[0].top).toBe(47);
    expect(stripMarks(boxes, ["add", "del"], heights.b, 0)).toEqual([]);
  });
});
