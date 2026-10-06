import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  clampColumn,
  COL_MAX,
  COL_MIN,
  columnVars,
  colWidth,
  isListColumn,
  LIST_COLUMNS,
  listColumnWidth,
  resizedWidth,
  sanitizeListWidths,
  type ListColumn,
} from "./colwidths";

const IDS = Object.keys(LIST_COLUMNS) as ListColumn[];

describe("column width arithmetic", () => {
  it("reads a resized width or falls back", () => {
    expect(colWidth({ time: 200 }, "time", 170)).toBe(200);
    expect(colWidth({}, "time", 170)).toBe(170);
    expect(colWidth({ time: 0 }, "time", 170)).toBe(170);
  });

  it("applies a drag delta and never goes below the minimum", () => {
    expect(resizedWidth(170, 30.4)).toBe(200);
    expect(resizedWidth(80, -100)).toBe(COL_MIN);
    expect(resizedWidth(80, -100, 40)).toBe(40);
  });

  it("clamps a stored width into what a column may be", () => {
    expect(clampColumn(1)).toBe(COL_MIN);
    expect(clampColumn(1e9)).toBe(COL_MAX);
    expect(clampColumn(200.6)).toBe(201);
  });
});

describe("list columns", () => {
  it("knows its columns", () => {
    expect(isListColumn("docker.image")).toBe(true);
    expect(isListColumn("k8s.node")).toBe(true);
    expect(isListColumn("docker.nope")).toBe(false);
    // An inherited property name is not a column.
    expect(isListColumn("toString")).toBe(false);
    expect(isListColumn(7)).toBe(false);
  });

  it("starts every column inside the allowed range", () => {
    for (const id of IDS) {
      expect(LIST_COLUMNS[id]).toBeGreaterThanOrEqual(COL_MIN);
      expect(LIST_COLUMNS[id]).toBeLessThanOrEqual(COL_MAX);
    }
  });

  it("draws the user's width, or the default", () => {
    expect(listColumnWidth({ "docker.image": 400 }, "docker.image")).toBe(400);
    expect(listColumnWidth({}, "docker.image")).toBe(LIST_COLUMNS["docker.image"]);
  });

  it("renders the widths as CSS variables for the list", () => {
    expect(
      columnVars({ "docker.image": 400 }, { "--c-name": "docker.name", "--c-image": "docker.image" }),
    ).toBe(`--c-name: ${LIST_COLUMNS["docker.name"]}px; --c-image: 400px`);
  });
});

describe("sanitizeListWidths", () => {
  it("keeps known columns with sane widths", () => {
    expect(sanitizeListWidths({ "docker.image": 400, "k8s.node": 120 })).toEqual({
      "docker.image": 400,
      "k8s.node": 120,
    });
  });

  it("drops unknown columns and non-numbers, clamps the rest", () => {
    expect(
      sanitizeListWidths({
        "docker.image": 99999,
        "docker.name": 1,
        "docker.status": "wide",
        "docker.ports": Number.NaN,
        "git.hash": 100,
        toString: 100,
      }),
    ).toEqual({ "docker.image": COL_MAX, "docker.name": COL_MIN });
  });

  it("survives garbage of any shape", () => {
    for (const raw of [null, undefined, 1, "x", [], [200], { nested: { a: 1 } }]) {
      expect(sanitizeListWidths(raw)).toEqual({});
    }
  });

  it("never lets anything but a clamped number through", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const out = sanitizeListWidths(raw);
        for (const [key, value] of Object.entries(out)) {
          expect(isListColumn(key)).toBe(true);
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(COL_MIN);
          expect(value).toBeLessThanOrEqual(COL_MAX);
        }
      }),
    );
  });
});
