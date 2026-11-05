import { describe, expect, it } from "vitest";
import type { ProcRow } from "../api";
import { applyView, NO_FILTER } from "../ui/listview";
import { historyPids, PROC_ORDER, PROC_SCHEMA, procTree, TREE_DEPTH_MAX } from "./proclist";

const p = (pid: number, ppid: number | null, comm: string, o: Partial<ProcRow> = {}): ProcRow => ({
  pid,
  ppid,
  user: "root",
  state: "sleeping",
  elapsedSecs: 100,
  threads: 1,
  rss: 1024,
  mem: 0.1,
  cpu: 0,
  comm,
  ...o,
});

const ROWS = [
  p(1, 0, "systemd"),
  p(812, 1, "sshd", { cpu: 0.2 }),
  p(900, 812, "sshd", { user: "deploy", cpu: 1 }),
  p(901, 900, "bash", { user: "deploy", cpu: 0 }),
  p(2841, 1, "postgres", { user: "postgres", cpu: 38, mem: 12.4 }),
  p(2850, 2841, "postgres", { user: "postgres", cpu: null, mem: 3 }),
];

describe("the process list", () => {
  it("orders busiest first by default, with no reading yet going last", () => {
    const view = applyView(ROWS, PROC_SCHEMA, NO_FILTER, PROC_ORDER);
    const pids = view.groups[0].items.map((r) => r.pid);
    expect(pids[0]).toBe(2841);
    expect(pids.at(-1)).toBe(2850);
  });

  it("filters by name, user or pid, and by the user and state facets", () => {
    const byText = (text: string) => applyView(ROWS, PROC_SCHEMA, { text, facets: {} }, PROC_ORDER).shown;
    expect(byText("postgres")).toBe(2);
    expect(byText("deploy")).toBe(2);
    expect(byText("901")).toBe(1);
    const facet = applyView(ROWS, PROC_SCHEMA, { text: "", facets: { user: ["deploy"] } }, PROC_ORDER);
    expect(facet.shown).toBe(2);
  });

  it("draws a tree by parent, siblings in the list's order", () => {
    const kept = applyView(ROWS, PROC_SCHEMA, NO_FILTER, PROC_ORDER).groups[0].items;
    const tree = procTree(ROWS, kept);
    expect(tree.map((t) => [t.row.pid, t.depth])).toEqual([
      [1, 0],
      [2841, 1],
      [2850, 2],
      [812, 1],
      [900, 2],
      [901, 3],
    ]);
    expect(tree[0].kids).toBe(2);
    expect(tree.every((t) => !t.context)).toBe(true);
  });

  it("keeps the parents of a match above it, dimmed, so a match is never orphaned", () => {
    const kept = applyView(ROWS, PROC_SCHEMA, { text: "bash", facets: {} }, PROC_ORDER).groups[0].items;
    const tree = procTree(ROWS, kept);
    expect(tree.map((t) => [t.row.pid, t.context])).toEqual([
      [1, true],
      [812, true],
      [900, true],
      [901, false],
    ]);
  });

  it("survives a parent loop and caps the indentation", () => {
    const loop = [p(5, 6, "a"), p(6, 5, "b")];
    expect(procTree(loop, loop).map((t) => t.row.pid).sort()).toEqual([5, 6]);
    const chain = Array.from({ length: 20 }, (_, i) => p(i + 1, i === 0 ? null : i, `c${i}`));
    const deepest = Math.max(...procTree(chain, chain).map((t) => t.depth));
    expect(deepest).toBe(TREE_DEPTH_MAX);
  });

  it("keeps a history line only for the busiest by CPU and by memory", () => {
    const keep = historyPids(ROWS, 2);
    expect([...keep].sort((a, b) => a - b)).toEqual([900, 2841, 2850]);
  });
});
