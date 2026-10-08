import { describe, expect, it } from "vitest";
import {
  confinedGhost,
  onScreenSessions,
  pendingAuthSession,
  recordingPauses,
  rectStyle,
  stripStyle,
} from "./centerview";

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

describe("stripStyle", () => {
  const bounds = { width: 800, height: 600 };

  it("is the top of the rectangle, a fixed height tall", () => {
    expect(stripStyle({ x: 0, y: 0, w: 400, h: 600 }, bounds, 28)).toBe(
      "left: 0%; top: 0%; width: 50%; height: 28px",
    );
    expect(stripStyle({ x: 401, y: 300, w: 399, h: 300 }, bounds, 28)).toBe(
      "left: 50.125%; top: 50%; width: 49.875%; height: 28px",
    );
  });

  it("starts where the body under it does — the same share of the area", () => {
    const rect = { x: 401, y: 300, w: 399, h: 300 };
    const body = rectStyle(rect, bounds, 28);
    const strip = stripStyle(rect, bounds, 28);
    expect(body).toContain("left: 50.125%");
    expect(strip).toContain("left: 50.125%");
    expect(body).toContain("top: calc(50% + 28px)");
    expect(strip).toContain("top: 50%");
  });

  it("spans the area while it is not measured or the zone is unknown", () => {
    const full = "left: 0; top: 0; width: 100%; height: 28px";
    expect(stripStyle(undefined, bounds, 28)).toBe(full);
    expect(stripStyle({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 }, 28)).toBe(full);
  });
});

describe("confinedGhost", () => {
  const area = { x: 300, y: 100, w: 800, h: 500 };

  it("inside the connection's area the label hangs from the pointer", () => {
    expect(confinedGhost(500, 300, area)).toEqual({ x: 512, y: 308 });
  });

  it("past an edge it stops there, fully in sight — it does not follow the pointer out", () => {
    // Right and bottom: the label's own size is kept inside.
    expect(confinedGhost(2000, 300, area)).toEqual({ x: 896, y: 308 });
    expect(confinedGhost(500, 2000, area)).toEqual({ x: 512, y: 568 });
    // Left and top.
    expect(confinedGhost(0, 300, area)).toEqual({ x: 304, y: 308 });
    expect(confinedGhost(500, 0, area)).toEqual({ x: 512, y: 104 });
    // A corner.
    expect(confinedGhost(-50, 5000, area)).toEqual({ x: 304, y: 568 });
  });

  it("a measured label stops flush with the edge, not where the widest one would", () => {
    const size = { w: 82, h: 26 };
    expect(confinedGhost(2000, 2000, area, size)).toEqual({ x: 1014, y: 570 });
    expect(confinedGhost(500, 300, area, size)).toEqual({ x: 512, y: 308 });
    expect(confinedGhost(-50, -50, area, size)).toEqual({ x: 304, y: 104 });
    // Not measured yet: the room of the widest label.
    expect(confinedGhost(2000, 2000, area, { w: 0, h: 0 })).toEqual({ x: 896, y: 568 });
    for (const x of [-500, 300, 700, 1100, 5000]) {
      for (const y of [-500, 100, 350, 600, 5000]) {
        const at = confinedGhost(x, y, area, size);
        expect(at.x).toBeGreaterThanOrEqual(area.x);
        expect(at.x + size.w).toBeLessThanOrEqual(area.x + area.w);
        expect(at.y).toBeGreaterThanOrEqual(area.y);
        expect(at.y + size.h).toBeLessThanOrEqual(area.y + area.h);
      }
    }
  });

  it("wherever the pointer is, the label is inside the area", () => {
    for (const x of [-500, 0, 299, 300, 700, 1100, 1101, 5000]) {
      for (const y of [-500, 0, 99, 100, 350, 600, 601, 5000]) {
        const at = confinedGhost(x, y, area);
        expect(at.x).toBeGreaterThanOrEqual(area.x);
        expect(at.x + 200).toBeLessThanOrEqual(area.x + area.w);
        expect(at.y).toBeGreaterThanOrEqual(area.y);
        expect(at.y + 28).toBeLessThanOrEqual(area.y + area.h);
      }
    }
  });

  it("an area smaller than the label keeps it at its near edge", () => {
    expect(confinedGhost(500, 300, { x: 300, y: 100, w: 50, h: 10 })).toEqual({ x: 304, y: 104 });
  });

  it("with no area measured it is where the pointer is", () => {
    expect(confinedGhost(500, 300, null)).toEqual({ x: 512, y: 308 });
  });
});

describe("onScreenSessions", () => {
  const covered = new Set(["b"]);
  const showsTerminal = (id: string) => !covered.has(id);

  it("is the tab each pane shows", () => {
    expect(onScreenSessions(["a", "c"], showsTerminal)).toEqual(["a", "c"]);
  });

  it("a connection showing a file in place of its terminal has no terminal on screen", () => {
    expect(onScreenSessions(["a", "b", "c"], showsTerminal)).toEqual(["a", "c"]);
    expect(onScreenSessions(["b"], showsTerminal)).toEqual([]);
  });

  it("nothing shown is nothing on screen", () => {
    expect(onScreenSessions([], showsTerminal)).toEqual([]);
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
