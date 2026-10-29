import { describe, expect, it } from "vitest";
import {
  hostOsFamily,
  supportsLoadAverage,
  supportsSensorsInstall,
  supportsTemperature,
} from "./hostcaps";

describe("hostOsFamily", () => {
  it("classifies what the local sysinfo collector reports", () => {
    expect(hostOsFamily("Windows")).toBe("windows");
    expect(hostOsFamily("Darwin")).toBe("macos");
    expect(hostOsFamily("Ubuntu")).toBe("linux");
  });

  it("classifies what `uname -s` reports over SSH", () => {
    expect(hostOsFamily("Linux")).toBe("linux");
    expect(hostOsFamily("Darwin")).toBe("macos");
    expect(hostOsFamily("FreeBSD")).toBe("bsd");
  });

  // A POSIX shell on Windows (Git Bash / MSYS) answers `uname -s` with these.
  it("recognises Windows POSIX layers", () => {
    expect(hostOsFamily("MINGW64_NT-10.0-22631")).toBe("windows");
    expect(hostOsFamily("CYGWIN_NT-10.0")).toBe("windows");
    expect(hostOsFamily("MSYS_NT-10.0")).toBe("windows");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(hostOsFamily("  linux\n")).toBe("linux");
    expect(hostOsFamily("WINDOWS")).toBe("windows");
  });

  // Before the first poll there is no OS string; that must not read as a family.
  it("treats missing/empty as unknown rather than guessing", () => {
    expect(hostOsFamily("")).toBe("unknown");
    expect(hostOsFamily(null)).toBe("unknown");
    expect(hostOsFamily(undefined)).toBe("unknown");
    expect(hostOsFamily("Plan9")).toBe("unknown");
  });
});

describe("supportsLoadAverage", () => {
  it("is false only on Windows, which has no load-average concept", () => {
    expect(supportsLoadAverage("Windows")).toBe(false);
    expect(supportsLoadAverage("MINGW64_NT-10.0")).toBe(false);
    expect(supportsLoadAverage("Linux")).toBe(true);
    expect(supportsLoadAverage("Darwin")).toBe(true);
    expect(supportsLoadAverage("FreeBSD")).toBe(true);
  });

  // Keep the card while the OS is still unknown: a blank there is "not polled
  // yet", and hiding it would make a transient state look like a permanent one.
  it("keeps the card for an unknown host", () => {
    expect(supportsLoadAverage("")).toBe(true);
  });
});

describe("supportsSensorsInstall", () => {
  // The Phase 39 bug: Windows was offered an apt-installable Linux package.
  it("offers the lm-sensors install on Linux only", () => {
    expect(supportsSensorsInstall("Linux")).toBe(true);
    expect(supportsSensorsInstall("Ubuntu")).toBe(true);
    expect(supportsSensorsInstall("Windows")).toBe(false);
    expect(supportsSensorsInstall("Darwin")).toBe(false);
    expect(supportsSensorsInstall("FreeBSD")).toBe(false);
    expect(supportsSensorsInstall("")).toBe(false);
  });
});

describe("supportsTemperature", () => {
  it("is false on Windows, where no unprivileged offline source exists", () => {
    expect(supportsTemperature("Windows")).toBe(false);
    expect(supportsTemperature("Linux")).toBe(true);
    expect(supportsTemperature("Darwin")).toBe(true);
  });
});
