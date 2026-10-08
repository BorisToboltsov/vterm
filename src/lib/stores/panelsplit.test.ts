import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { PANEL_SPLITS, SHARE_MAX, SHARE_MIN } from "../panelsplit";
import { resetPanelLayout } from "./layout.svelte";
import {
  drawnShare,
  panelSplits,
  resetPanelShare,
  resetPanelShares,
  setPanelShare,
  STORAGE_KEY,
} from "./panelsplit.svelte";

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
  resetPanelShares();
  flushSync();
});

describe("panel split store", () => {
  it("starts every panel at its default", () => {
    expect(panelSplits.shares).toEqual({});
    expect(drawnShare("git", 1200)).toBe(PANEL_SPLITS.git);
    expect(drawnShare("docker", 1200)).toBe(PANEL_SPLITS.docker);
  });

  it("remembers where the border was left and persists it", () => {
    setPanelShare("docker", 0.35);
    flushSync();
    expect(drawnShare("docker", 1200)).toBe(0.35);
    expect(stored()).toEqual({ docker: 0.35 });
    // One share per panel kind: the other panels keep theirs.
    expect(drawnShare("k8s", 1200)).toBe(PANEL_SPLITS.k8s);
  });

  it("keeps what it is given inside the fixed limits, and ignores what is not a number", () => {
    setPanelShare("git", 0.01);
    expect(panelSplits.shares.git).toBe(SHARE_MIN);
    setPanelShare("git", 5);
    expect(panelSplits.shares.git).toBe(SHARE_MAX);
    setPanelShare("git", Number.NaN);
    expect(panelSplits.shares.git).toBe(SHARE_MAX);
  });

  it("draws a stored share as far as the row allows, without rewriting it", () => {
    setPanelShare("git", 0.25);
    expect(drawnShare("git", 800)).toBe(0.3);
    expect(panelSplits.shares.git).toBe(0.25);
    expect(drawnShare("git", 2000)).toBe(0.25);
  });

  it("puts one panel back, or all of them", () => {
    setPanelShare("git", 0.6);
    setPanelShare("k8s", 0.3);
    resetPanelShare("git");
    flushSync();
    expect(drawnShare("git", 1200)).toBe(PANEL_SPLITS.git);
    expect(stored()).toEqual({ k8s: 0.3 });
    resetPanelShares();
    flushSync();
    expect(stored()).toEqual({});
  });

  it("\"Reset panel layout\" puts the borders back too", () => {
    setPanelShare("docker", 0.7);
    resetPanelLayout();
    flushSync();
    expect(panelSplits.shares).toEqual({});
  });
});
