import { describe, expect, it } from "vitest";
import {
  sessionBarParts,
  showSessionBar,
  type SessionBarInput,
  type SessionBarParts,
} from "./sessionbar";

const base: SessionBarInput = {
  editors: 0,
  onTerminal: true,
  connected: true,
  smartLogs: true,
  structured: false,
  broadcast: false,
  ai: true,
};

const none: SessionBarParts = {
  subtabs: false,
  search: false,
  viewToggle: false,
  clear: false,
  askAi: false,
};

describe("sessionBarParts", () => {
  it("a live terminal with smart logs and AI gets every tool", () => {
    expect(sessionBarParts(base)).toEqual({
      subtabs: false,
      search: true,
      viewToggle: true,
      clear: true,
      askAi: true,
    });
  });
  it("sub-tabs appear only with open editors", () => {
    expect(sessionBarParts({ ...base, editors: 2 }).subtabs).toBe(true);
  });
  it("the structured view keeps only the toggle to get back", () => {
    expect(sessionBarParts({ ...base, structured: true })).toEqual({ ...none, viewToggle: true });
  });
  it("tools hide while an editor is the active view", () => {
    expect(sessionBarParts({ ...base, editors: 1, onTerminal: false })).toEqual({
      ...none,
      subtabs: true,
    });
  });
  it("tools hide until the session is connected", () => {
    expect(sessionBarParts({ ...base, connected: false })).toEqual(none);
  });
  it("smart logs off drops search and the toggle, keeps clear and Ask AI", () => {
    expect(sessionBarParts({ ...base, smartLogs: false })).toEqual({
      ...none,
      clear: true,
      askAi: true,
    });
  });
  it("Ask AI needs the assistant (configured, server not noAi)", () => {
    const p = sessionBarParts({ ...base, ai: false });
    expect(p.askAi).toBe(false);
    expect(p.clear).toBe(true);
  });
  it("broadcast hides everything", () => {
    expect(sessionBarParts({ ...base, editors: 3, broadcast: true })).toEqual(none);
  });
});

describe("showSessionBar", () => {
  it("is shown for every live terminal, smart logs or not", () => {
    expect(showSessionBar(sessionBarParts({ ...base, smartLogs: false, ai: false }))).toBe(true);
  });
  it("is off when every part is off — the terminal keeps its full height", () => {
    expect(showSessionBar(none)).toBe(false);
    expect(showSessionBar(sessionBarParts({ ...base, connected: false }))).toBe(false);
  });
  it("is on when any part is on", () => {
    for (const k of Object.keys(none) as (keyof SessionBarParts)[]) {
      expect(showSessionBar({ ...none, [k]: true })).toBe(true);
    }
  });
});
