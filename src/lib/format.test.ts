import { describe, expect, it } from "vitest";
import { diskFree, fmtBytes, fmtRate, fmtUptime, memPct, osIcon } from "./format";
import { ICONS } from "./icons";

describe("fmtBytes", () => {
  it("renders an em dash for null", () => {
    expect(fmtBytes(null)).toBe("—");
  });
  it("uses MiB below 1 GiB (rounded whole)", () => {
    expect(fmtBytes(512 * 1024 ** 2)).toBe("512 MiB");
    expect(fmtBytes(0)).toBe("0 MiB");
  });
  it("uses GiB with one decimal at/above 1 GiB", () => {
    expect(fmtBytes(1024 ** 3)).toBe("1.0 GiB");
    expect(fmtBytes(Math.round(2.5 * 1024 ** 3))).toBe("2.5 GiB");
  });
});

describe("fmtRate", () => {
  it("renders an em dash for null", () => {
    expect(fmtRate(null)).toBe("—");
  });
  it("uses B/s below 1 KB", () => {
    expect(fmtRate(512)).toBe("512 B/s");
  });
  it("scales to KB/s and MB/s", () => {
    expect(fmtRate(512 * 1024)).toBe("512 KB/s");
    expect(fmtRate(2 * 1024 ** 2)).toBe("2.0 MB/s");
  });
});

describe("fmtUptime", () => {
  it("renders an em dash for null", () => {
    expect(fmtUptime(null)).toBe("—");
  });
  it("formats days/hours/minutes", () => {
    expect(fmtUptime(90061)).toBe("1d 1h"); // 1d 1h 1m
    expect(fmtUptime(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(fmtUptime(5 * 60)).toBe("5m");
  });
});

describe("osIcon", () => {
  it.each([
    ["Darwin", "macOS 15", "osApple"],
    ["Linux", "Ubuntu 24.04", "osLinux"],
    ["FreeBSD", "FreeBSD 14", "osBsd"],
    ["Windows_NT", "Windows", "osWindows"],
  ] as const)("%s → %s icon", (os, pretty, icon) => {
    expect(osIcon(os, pretty)).toBe(icon);
  });
  it("falls back to the Linux icon when os is present but unrecognized", () => {
    expect(osIcon("SunOS", "")).toBe("osLinux");
  });
  it("returns the unknown marker when nothing is known", () => {
    expect(osIcon("", "")).toBe("osUnknown");
  });
  it("only ever returns names that exist in the icon registry", () => {
    const names = [
      osIcon("Darwin", ""),
      osIcon("Linux", ""),
      osIcon("FreeBSD", ""),
      osIcon("Windows_NT", ""),
      osIcon("SunOS", ""),
      osIcon("", ""),
    ];
    for (const n of names) expect(ICONS[n]).toBeTruthy();
  });
});

describe("memPct", () => {
  it("computes a rounded percentage", () => {
    expect(memPct(1, 4)).toBe(25);
    expect(memPct(1, 3)).toBe(33);
  });
  it("is null when data is missing or total is zero", () => {
    expect(memPct(null, 4)).toBeNull();
    expect(memPct(1, null)).toBeNull();
    expect(memPct(1, 0)).toBeNull();
  });
});

describe("diskFree", () => {
  it("subtracts used from total", () => {
    expect(diskFree(3, 10)).toBe(7);
  });
  it("is null when either value is missing", () => {
    expect(diskFree(null, 10)).toBeNull();
    expect(diskFree(3, null)).toBeNull();
  });
});
