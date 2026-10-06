import { describe, expect, it } from "vitest";
import { onScreenSessions, pendingAuthSession, recordingPauses, rectStyle } from "./centerview";

describe("rectStyle", () => {
  const bounds = { width: 800, height: 600 };

  it("places a pane as a share of the area", () => {
    expect(rectStyle({ x: 0, y: 0, w: 400, h: 600 }, bounds)).toBe(
      "left: 0%; top: calc(0% + 0px); width: 50%; height: calc(100% - 0px)",
    );
    expect(rectStyle({ x: 401, y: 300, w: 399, h: 300 }, bounds, 32)).toBe(
      "left: 50.125%; top: calc(50% + 32px); width: 49.875%; height: calc(50% - 32px)",
    );
  });

  it("fills the area while it is not measured or the pane is unknown", () => {
    const full = "left: 0; top: 0px; width: 100%; height: calc(100% - 0px)";
    expect(rectStyle(undefined, bounds)).toBe(full);
    expect(rectStyle({ x: 0, y: 0, w: 1, h: 1 }, { width: 0, height: 600 })).toBe(full);
    expect(rectStyle({ x: 0, y: 0, w: 1, h: 1 }, { width: 800, height: 0 }, 30)).toBe(
      "left: 0; top: 30px; width: 100%; height: calc(100% - 30px)",
    );
  });
});

describe("onScreenSessions", () => {
  const base = { shown: ["a", "c"], active: "a", broadcast: false, grid: false, members: ["a", "b"] };

  it("is the tab each pane shows", () => {
    expect(onScreenSessions(base)).toEqual(["a", "c"]);
  });

  it("in the broadcast grid it is every member", () => {
    expect(onScreenSessions({ ...base, broadcast: true, grid: true })).toEqual(["a", "b"]);
  });

  it("in the broadcast focus view it is the focused member", () => {
    expect(onScreenSessions({ ...base, broadcast: true })).toEqual(["a"]);
    expect(onScreenSessions({ ...base, broadcast: true, active: null })).toEqual([]);
  });
});

describe("pendingAuthSession", () => {
  const asked = (ids: string[]) => (id: string) => ids.includes(id);

  it("prefers the session in focus", () => {
    expect(pendingAuthSession(["a", "b"], "b", asked(["a", "b"]))).toBe("b");
  });

  it("falls back to another session on screen", () => {
    expect(pendingAuthSession(["a", "b"], "a", asked(["b"]))).toBe("b");
    expect(pendingAuthSession(["a", "b"], null, asked(["b"]))).toBe("b");
  });

  it("a tab that is not on screen waits", () => {
    expect(pendingAuthSession(["a"], "a", asked(["z"]))).toBeNull();
    expect(pendingAuthSession([], "z", asked(["z"]))).toBeNull();
  });
});

describe("recordingPauses", () => {
  it("keeps the on-screen recordings running and pauses the rest", () => {
    expect(recordingPauses(["a", "b", "c"], ["c", "a", "x"])).toEqual({
      pause: ["b"],
      watch: ["a", "c"],
    });
    expect(recordingPauses([], ["a"])).toEqual({ pause: [], watch: [] });
  });
});
