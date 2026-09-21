import { describe, expect, it } from "vitest";
import { sessionBarParts, showSessionBar, type SessionBarInput } from "./sessionbar";

const base: SessionBarInput = {
  editors: 0,
  onTerminal: true,
  connected: true,
  smartLogs: true,
  structured: false,
  broadcast: false,
};

describe("sessionBarParts", () => {
  it("a live terminal with smart logs gets search and the view toggle", () => {
    expect(sessionBarParts(base)).toEqual({ subtabs: false, search: true, viewToggle: true });
  });
  it("sub-tabs appear only with open editors", () => {
    expect(sessionBarParts({ ...base, editors: 2 }).subtabs).toBe(true);
  });
  it("search hides in the structured view; the toggle stays to get back", () => {
    expect(sessionBarParts({ ...base, structured: true })).toEqual({
      subtabs: false,
      search: false,
      viewToggle: true,
    });
  });
  it("tools hide while an editor is the active view", () => {
    expect(sessionBarParts({ ...base, editors: 1, onTerminal: false })).toEqual({
      subtabs: true,
      search: false,
      viewToggle: false,
    });
  });
  it("tools hide until the session is connected", () => {
    const p = sessionBarParts({ ...base, connected: false });
    expect(p.search || p.viewToggle).toBe(false);
  });
  it("tools hide with smart logs off", () => {
    const p = sessionBarParts({ ...base, smartLogs: false });
    expect(p.search || p.viewToggle).toBe(false);
  });
  it("broadcast hides everything", () => {
    expect(showSessionBar(sessionBarParts({ ...base, editors: 3, broadcast: true }))).toBe(false);
  });
});

describe("showSessionBar", () => {
  it("is off when every part is off — the terminal keeps its full height", () => {
    expect(showSessionBar({ subtabs: false, search: false, viewToggle: false })).toBe(false);
    expect(showSessionBar(sessionBarParts({ ...base, smartLogs: false }))).toBe(false);
  });
  it("is on when any part is on", () => {
    expect(showSessionBar({ subtabs: false, search: false, viewToggle: true })).toBe(true);
  });
});
