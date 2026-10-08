import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  TERMINAL_VIEW,
  closeView,
  fileZone,
  focusedFile,
  isFileView,
  loadViews,
  moveViewNext,
  openView,
  showView,
  splitView,
  terminalFocused,
  terminalOnly,
  terminalShown,
  type ViewLayout,
} from "./sessionviews";
import { focusPane, joinPanes, layoutProblems, paneOf, panes } from "./splitlayout";

const T = TERMINAL_VIEW;
/** Zones in reading order: what each holds, with `*` on the view it shows. */
const shape = (l: ViewLayout): string[][] =>
  panes(l).map((zone) => zone.tabs.map((view) => (zone.active === view ? `${view}*` : view)));
const opened = (...files: string[]): ViewLayout => files.reduce(openView, terminalOnly());

describe("a connection with nothing but its terminal", () => {
  it("is one zone showing the terminal, in focus", () => {
    const l = terminalOnly();
    expect(shape(l)).toEqual([[`${T}*`]]);
    expect(terminalShown(l)).toBe(true);
    expect(terminalFocused(l)).toBe(true);
    expect(focusedFile(l)).toBeNull();
    expect(layoutProblems(l, [T])).toEqual([]);
  });

  it("the terminal is not a file", () => {
    expect(isFileView(T)).toBe(false);
    expect(isFileView(null)).toBe(false);
    expect(isFileView("a")).toBe(true);
  });
});

describe("opening a file", () => {
  it("undivided: the file is a view next to the terminal, shown in its place", () => {
    const l = opened("a");
    expect(shape(l)).toEqual([[T, "a*"]]);
    expect(terminalShown(l)).toBe(false);
    expect(terminalFocused(l)).toBe(false);
    expect(focusedFile(l)).toBe("a");
  });

  it("a second file joins the same zone", () => {
    expect(shape(opened("a", "b"))).toEqual([[T, "a", "b*"]]);
  });

  it("divided: a new file joins the files, not the terminal one is typing in", () => {
    // [terminal] | [a], and the terminal's zone in focus.
    let l = splitView(opened("a"), "a", "right");
    l = showView(l, T);
    expect(terminalFocused(l)).toBe(true);
    l = openView(l, "b");
    expect(shape(l)).toEqual([[`${T}*`], ["a", "b*"]]);
    // The file zone took the focus with the file it now shows.
    expect(focusedFile(l)).toBe("b");
    expect(terminalShown(l)).toBe(true);
  });

  it("with files in several zones it goes to the one in focus", () => {
    // [terminal] | [a] | [b]
    let l = splitView(opened("a"), "a", "right");
    l = splitView(openView(l, "b"), "b", "right");
    expect(shape(l)).toEqual([[`${T}*`], ["a*"], ["b*"]]);
    l = showView(l, "a");
    expect(shape(openView(l, "c"))).toEqual([[`${T}*`], ["a", "c*"], ["b*"]]);
  });

  it("the file zone is the one in focus when it shows a file, else the first that does", () => {
    let l = splitView(opened("a"), "a", "right");
    expect(fileZone(l).active).toBe("a");
    l = showView(l, T);
    expect(fileZone(l).active).toBe("a");
    // Undivided and showing the terminal: the only zone there is.
    expect(fileZone(terminalOnly()).active).toBe(T);
  });

  it("the terminal cannot be opened a second time, nor a file twice", () => {
    const l = opened("a");
    expect(openView(l, T)).toBe(l);
    expect(shape(openView(showView(l, T), "a"))).toEqual([[T, "a*"]]);
  });
});

describe("closing a file", () => {
  it("its zone shows the neighbour", () => {
    expect(shape(closeView(opened("a", "b"), "b"))).toEqual([[T, "a*"]]);
    expect(shape(closeView(opened("a"), "a"))).toEqual([[`${T}*`]]);
  });

  it("a zone left with nothing goes, and the connection is one zone again", () => {
    const l = splitView(opened("a"), "a", "right");
    const closed = closeView(l, "a");
    expect(shape(closed)).toEqual([[`${T}*`]]);
    expect(terminalFocused(closed)).toBe(true);
  });

  it("the terminal does not close", () => {
    const l = opened("a");
    expect(closeView(l, T)).toBe(l);
  });
});

describe("zones", () => {
  it("a file goes beside the terminal", () => {
    const l = splitView(opened("a"), "a", "right");
    expect(shape(l)).toEqual([[`${T}*`], ["a*"]]);
    expect(terminalShown(l)).toBe(true);
    expect(focusedFile(l)).toBe("a");
  });

  it("the terminal can be the one that moves — below the file", () => {
    const l = splitView(opened("a"), T, "bottom");
    expect(shape(l)).toEqual([["a*"], [`${T}*`]]);
    expect(terminalFocused(l)).toBe(true);
  });

  it("two files stand side by side", () => {
    let l = splitView(opened("a", "b"), "b", "right");
    expect(shape(l)).toEqual([[T, "a*"], ["b*"]]);
    l = splitView(l, "a", "right");
    expect(shape(l)).toEqual([[`${T}*`], ["a*"], ["b*"]]);
  });

  it("a zone's only view cannot be split off it", () => {
    const l = terminalOnly();
    expect(splitView(l, T, "right")).toBe(l);
    const two = splitView(opened("a"), "a", "right");
    expect(splitView(two, "a", "bottom")).toBe(two);
  });

  it("a view moves to the next zone and is shown there", () => {
    const l = splitView(opened("a", "b"), "b", "right"); // [T a*] | [b*]
    const moved = moveViewNext(l, "a");
    expect(shape(moved)).toEqual([[`${T}*`], ["b", "a*"]]);
    // With one zone there is nowhere to go.
    const one = opened("a");
    expect(moveViewNext(one, "a")).toBe(one);
  });

  it("the zones join back into one, showing the view that was in focus", () => {
    const l = splitView(opened("a", "b"), "b", "right");
    expect(shape(joinPanes(l))).toEqual([[T, "a", "b*"]]);
  });

  it("a view that is not there changes nothing", () => {
    const l = opened("a");
    expect(splitView(l, "nope", "right")).toBe(l);
    expect(moveViewNext(l, "nope")).toBe(l);
    expect(showView(l, "nope")).toBe(l);
  });
});

describe("what is on screen and what takes the keys", () => {
  it("a terminal covered by a file in its own zone is not on screen", () => {
    expect(terminalShown(opened("a"))).toBe(false);
    expect(terminalShown(showView(opened("a"), T))).toBe(true);
  });

  it("beside a file the terminal is on screen, whichever zone is in focus", () => {
    const l = splitView(opened("a"), "a", "right");
    expect(terminalShown(l)).toBe(true);
    expect(terminalFocused(l)).toBe(false);
    const back = focusPane(l, paneOf(l, T)!.id);
    expect(terminalFocused(back)).toBe(true);
    expect(focusedFile(back)).toBeNull();
  });
});

describe("loadViews", () => {
  it("what cannot be read is one zone showing the terminal, the files behind it", () => {
    for (const junk of [null, undefined, 5, "x", [], {}, { root: 1 }]) {
      expect(shape(loadViews(junk, ["a", "b"]))).toEqual([[`${T}*`, "a", "b"]]);
    }
    expect(shape(loadViews(null, []))).toEqual([[`${T}*`]]);
  });

  it("keeps the zones a layout had", () => {
    const l = splitView(opened("a", "b"), "b", "right");
    expect(shape(loadViews(JSON.parse(JSON.stringify(l)), ["a", "b"]))).toEqual(shape(l));
  });

  it("drops a view whose file did not come along, and gives a file it does not name a place", () => {
    const l = splitView(opened("a", "b"), "b", "right"); // [T a*] | [b*]
    const loaded = loadViews(JSON.parse(JSON.stringify(l)), ["a", "c"]);
    expect(layoutProblems(loaded, [T, "a", "c"])).toEqual([]);
    expect(paneOf(loaded, "b")).toBeNull();
    expect(paneOf(loaded, "c")).not.toBeNull();
  });

  it("a layout that lost its terminal gets it back", () => {
    const raw = { root: { kind: "pane", id: "p0", tabs: ["a"], active: "a" }, focus: "p0", seq: 1 };
    const loaded = loadViews(raw, ["a"]);
    expect(paneOf(loaded, T)).not.toBeNull();
    expect(layoutProblems(loaded, [T, "a"])).toEqual([]);
  });

  it("a file that calls itself the terminal is not a second terminal", () => {
    expect(layoutProblems(loadViews(null, [T, "a"]), [T, "a"])).toEqual([]);
  });
});

// ── Whatever is done, the connection stays sound ─────────────────────────────

type Op =
  | { op: "open"; file: string }
  | { op: "close"; file: string }
  | { op: "show"; view: string }
  | { op: "split"; view: string; edge: "left" | "right" | "top" | "bottom" }
  | { op: "next"; view: string }
  | { op: "join" };

const FILE = fc.constantFrom("a", "b", "c", "d");
const VIEW = fc.constantFrom(T, "a", "b", "c", "d");
const OP: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("open" as const), file: FILE }),
  fc.record({ op: fc.constant("close" as const), file: FILE }),
  fc.record({ op: fc.constant("show" as const), view: VIEW }),
  fc.record({
    op: fc.constant("split" as const),
    view: VIEW,
    edge: fc.constantFrom("left" as const, "right" as const, "top" as const, "bottom" as const),
  }),
  fc.record({ op: fc.constant("next" as const), view: VIEW }),
  fc.record({ op: fc.constant("join" as const) }),
);

describe("any sequence of operations", () => {
  it("keeps the terminal and every open file in exactly one zone, and no zone empty", () => {
    fc.assert(
      fc.property(fc.array(OP, { maxLength: 40 }), (ops) => {
        let l = terminalOnly();
        const open = new Set<string>();
        for (const o of ops) {
          if (o.op === "open") {
            l = openView(l, o.file);
            open.add(o.file);
          } else if (o.op === "close") {
            l = closeView(l, o.file);
            open.delete(o.file);
          } else if (o.op === "show") l = showView(l, o.view);
          else if (o.op === "split") l = splitView(l, o.view, o.edge);
          else if (o.op === "next") l = moveViewNext(l, o.view);
          else l = joinPanes(l);
          expect(layoutProblems(l, [T, ...open])).toEqual([]);
          // The terminal is always somewhere, and never gone with a file.
          expect(paneOf(l, T)).not.toBeNull();
          // A file in focus is an open one.
          const file = focusedFile(l);
          if (file !== null) expect(open.has(file)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("opening a file never hides a terminal that stands in a zone of its own", () => {
    fc.assert(
      fc.property(fc.array(OP, { maxLength: 30 }), FILE, (ops, file) => {
        let l = terminalOnly();
        for (const o of ops) {
          if (o.op === "open") l = openView(l, o.file);
          else if (o.op === "close") l = closeView(l, o.file);
          else if (o.op === "show") l = showView(l, o.view);
          else if (o.op === "split") l = splitView(l, o.view, o.edge);
          else if (o.op === "next") l = moveViewNext(l, o.view);
          else l = joinPanes(l);
        }
        const zone = paneOf(l, T)!;
        const alone = zone.tabs.length === 1 && panes(l).length > 1;
        if (alone && paneOf(l, file) === null) {
          expect(terminalShown(openView(l, file))).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
