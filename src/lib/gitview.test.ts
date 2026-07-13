import { describe, expect, it } from "vitest";
import { fileStatusColor, relTime, commitTooltip } from "./gitview";

describe("fileStatusColor", () => {
  it("maps status letters to color classes", () => {
    expect(fileStatusColor("A")).toContain("green");
    expect(fileStatusColor("?")).toContain("green");
    expect(fileStatusColor("M")).toContain("amber");
    expect(fileStatusColor("D")).toContain("red");
    expect(fileStatusColor("R")).toContain("blue");
    expect(fileStatusColor("C")).toContain("blue");
    expect(fileStatusColor("U")).toContain("red");
    expect(fileStatusColor(".")).toContain("muted");
    expect(fileStatusColor("")).toContain("muted");
  });
});

describe("commitTooltip", () => {
  const now = 1_700_000_000_000;
  const base = { subject: "Fix bug", author: "Ann", short: "abc1234", timestamp: Math.floor(now / 1000) - 3600 };

  it("includes body when present, omits it otherwise", () => {
    const withBody = commitTooltip({ ...base, body: "Detail line one.\nLine two." }, now);
    expect(withBody).toBe("Fix bug\n\nDetail line one.\nLine two.\n\n— Ann · 1h · abc1234");
    const noBody = commitTooltip({ ...base, body: "" }, now);
    expect(noBody).toBe("Fix bug\n\n— Ann · 1h · abc1234");
  });
});

describe("relTime", () => {
  const now = 1_700_000_000_000; // fixed "now" in ms
  const ago = (sec: number) => Math.floor(now / 1000) - sec;

  it("formats each bucket", () => {
    expect(relTime(ago(10), now)).toBe("now");
    expect(relTime(ago(5 * 60), now)).toBe("5m");
    expect(relTime(ago(3 * 3600), now)).toBe("3h");
    expect(relTime(ago(2 * 86400), now)).toBe("2d");
    expect(relTime(ago(3 * 7 * 86400), now)).toBe("3w");
    expect(relTime(ago(400 * 86400), now)).toBe("1y");
  });

  it("clamps future timestamps to now", () => {
    expect(relTime(ago(-100), now)).toBe("now");
  });
});
