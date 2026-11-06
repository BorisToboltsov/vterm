import { describe, expect, it } from "vitest";
import {
  diskFree,
  fmtAgo,
  fmtBytes,
  fmtCount,
  fmtLimit,
  fmtLoad,
  fmtMhz,
  fmtMs,
  fmtPct,
  fmtRate,
  rateParts,
  fmtUptime,
  isUnlimitedLimit,
  memPct,
  osIcon,
} from "./format";
import { ICONS } from "../ui/icons";

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
  it("tells a value that rounds up to 1024 in the next unit", () => {
    // Was "1024 KB/s": a four-digit number the bar had no room for.
    expect(fmtRate(1023.7 * 1024)).toBe("1.0 MB/s");
    expect(fmtRate(1023.6)).toBe("1.0 KB/s");
    expect(fmtRate(1023.4)).toBe("1023 B/s");
    expect(fmtRate(1023 * 1024)).toBe("1023 KB/s");
    expect(fmtRate(9.96 * 1024)).toBe("10.0 KB/s");
  });
});

describe("rateParts", () => {
  it("gives the number and the unit apart", () => {
    expect(rateParts(512 * 1024)).toEqual({ num: "512", unit: "KB/s", value: 512 });
    expect(rateParts(3.5 * 1024 ** 2)).toMatchObject({ num: "3.5", unit: "MB/s" });
    expect(rateParts(0)).toMatchObject({ num: "0", unit: "B/s" });
  });
  it("knows nothing of an unknown or broken value", () => {
    expect(rateParts(null)).toBeNull();
    expect(rateParts(Number.NaN)).toBeNull();
    expect(fmtRate(Number.NaN)).toBe("—");
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

describe("fmtPct", () => {
  it("rounds and appends a percent sign", () => {
    expect(fmtPct(42)).toBe("42%");
    expect(fmtPct(42.6)).toBe("43%");
    expect(fmtPct(0)).toBe("0%");
  });
  it("is an em dash when null", () => {
    expect(fmtPct(null)).toBe("—");
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

describe("isUnlimitedLimit", () => {
  it("flags a ~i64::MAX ceiling as unlimited", () => {
    expect(isUnlimitedLimit(9223372036854775807)).toBe(true);
    expect(isUnlimitedLimit(1e15)).toBe(true);
  });
  it("treats realistic ceilings and null as bounded", () => {
    expect(isUnlimitedLimit(1048576)).toBe(false);
    expect(isUnlimitedLimit(0)).toBe(false);
    expect(isUnlimitedLimit(null)).toBe(false);
  });
});

describe("fmtLimit", () => {
  it("renders ∞ for an effectively unlimited ceiling", () => {
    expect(fmtLimit(9223372036854775807)).toBe("∞");
  });
  it("localizes a bounded count and dashes null", () => {
    expect(fmtLimit(1024)).toBe((1024).toLocaleString());
    expect(fmtLimit(null)).toBe("—");
  });
});

describe("monitoring page formats (v1.33)", () => {
  it("formats latency, keeping a decimal below 10 ms", () => {
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(NaN)).toBe("—");
    expect(fmtMs(0.42)).toBe("0.4 ms");
    expect(fmtMs(12.6)).toBe("13 ms");
  });

  it("marks seconds ago under a chart, and never writes 60 seconds", () => {
    expect(fmtAgo(0)).toBe("");
    expect(fmtAgo(600)).toBe("−10:00");
    expect(fmtAgo(200)).toBe("−3:20");
    expect(fmtAgo(59.6)).toBe("−1:00");
  });

  it("formats clocks and counts, unknown as a dash", () => {
    expect(fmtMhz(2400)).toBe("2.40 GHz");
    expect(fmtMhz(800)).toBe("800 MHz");
    expect(fmtMhz(null)).toBe("—");
    expect(fmtCount(null)).toBe("—");
    expect(fmtCount(1234.4)).toBe((1234).toLocaleString());
  });

  it("writes a load or its bound without trailing zeros", () => {
    expect(fmtLoad(0.7)).toBe("0.7");
    expect(fmtLoad(0.7 * 3)).toBe("2.1");
    expect(fmtLoad(2)).toBe("2");
    expect(fmtLoad(0.755)).toBe("0.76");
    expect(fmtLoad(null)).toBe("—");
    expect(fmtLoad(NaN)).toBe("—");
  });
});
