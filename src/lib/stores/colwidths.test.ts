import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { COL_MAX, COL_MIN, LIST_COLUMNS } from "../colwidths";
import {
  columns,
  columnWidth,
  resetColumnWidth,
  resetColumnWidths,
  setColumnWidth,
  STORAGE_KEY,
} from "./colwidths.svelte";

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
  resetColumnWidths();
  flushSync();
});

describe("column widths store", () => {
  it("starts every column at its default", () => {
    expect(columns.widths).toEqual({});
    expect(columnWidth("docker.image")).toBe(LIST_COLUMNS["docker.image"]);
  });

  it("remembers a resized column and persists it", () => {
    setColumnWidth("docker.image", 400);
    flushSync();
    expect(columnWidth("docker.image")).toBe(400);
    expect(stored()).toEqual({ "docker.image": 400 });
    // Only what the user changed is stored — a default can still move in a later build.
    expect(columnWidth("docker.name")).toBe(LIST_COLUMNS["docker.name"]);
  });

  it("clamps what it is given", () => {
    setColumnWidth("k8s.name", 5);
    expect(columnWidth("k8s.name")).toBe(COL_MIN);
    setColumnWidth("k8s.name", 1e6);
    expect(columnWidth("k8s.name")).toBe(COL_MAX);
  });

  it("puts one column back, or all of them", () => {
    setColumnWidth("docker.image", 400);
    setColumnWidth("k8s.node", 300);
    resetColumnWidth("docker.image");
    flushSync();
    expect(columnWidth("docker.image")).toBe(LIST_COLUMNS["docker.image"]);
    expect(stored()).toEqual({ "k8s.node": 300 });
    resetColumnWidths();
    flushSync();
    expect(stored()).toEqual({});
  });
});
