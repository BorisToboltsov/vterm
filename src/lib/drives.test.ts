import { describe, expect, it } from "vitest";
import {
  driveDisplayName,
  driveIcon,
  driveKindKey,
  driveUsage,
  driveUsedFraction,
  isDriveEntry,
  type DriveInfo,
} from "./drives";
import type { FileEntry } from "./types";

const drive = (over: Partial<DriveInfo> = {}): DriveInfo => ({
  label: "Windows",
  kind: "fixed",
  free: 120,
  total: 500,
  ...over,
});

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  name: "C:",
  path: "C:\\",
  isDir: true,
  isSymlink: false,
  size: 0,
  modified: null,
  mode: null,
  uid: null,
  gid: null,
  user: null,
  group: null,
  ...over,
});

describe("driveDisplayName", () => {
  it("reads like Explorer when the volume has a label", () => {
    expect(driveDisplayName("C:", drive())).toBe("Windows (C:)");
  });

  // Unlabelled volumes, and the network/optical drives we deliberately skip
  // probing, have no label — the bare letter must still be a usable row title.
  it("falls back to the bare letter with no label", () => {
    expect(driveDisplayName("D:", drive({ label: "" }))).toBe("D:");
    expect(driveDisplayName("Z:", drive({ label: "", kind: "remote" }))).toBe("Z:");
  });
});

describe("driveIcon", () => {
  it("distinguishes optical and network drives from local ones", () => {
    expect(driveIcon(drive({ kind: "fixed" }))).toBe("hardDrive");
    expect(driveIcon(drive({ kind: "removable" }))).toBe("hardDrive");
    expect(driveIcon(drive({ kind: "ramdisk" }))).toBe("hardDrive");
    expect(driveIcon(drive({ kind: "cdrom" }))).toBe("disc");
    expect(driveIcon(drive({ kind: "remote" }))).toBe("network");
    expect(driveIcon(drive({ kind: "unknown" }))).toBe("hardDrive");
  });
});

describe("driveKindKey", () => {
  it("maps each kind to its own i18n key", () => {
    expect(driveKindKey(drive({ kind: "remote" }))).toBe("drive.kind.remote");
    expect(driveKindKey(drive({ kind: "cdrom" }))).toBe("drive.kind.cdrom");
    expect(driveKindKey(drive({ kind: "fixed" }))).toBe("drive.kind.fixed");
  });
});

describe("driveUsage", () => {
  it("reports free and total when the drive was probed", () => {
    expect(driveUsage(drive())).toEqual({ free: 120, total: 500 });
  });

  // Network/optical drives are listed but never probed, because touching a stale
  // SMB mount blocks for seconds. They must fall back to the kind label.
  it("is null for an unprobed drive", () => {
    expect(driveUsage(drive({ free: null, total: null }))).toBeNull();
    expect(driveUsage(drive({ free: 10, total: null }))).toBeNull();
    expect(driveUsage(drive({ free: null, total: 10 }))).toBeNull();
  });

  // An unreadable volume (empty card reader) answers zero — not "0 B free of 0 B".
  it("is null for a zero-capacity volume rather than dividing by zero", () => {
    expect(driveUsage(drive({ free: 0, total: 0 }))).toBeNull();
  });
});

describe("driveUsedFraction", () => {
  it("computes the used share for the capacity bar", () => {
    expect(driveUsedFraction(drive({ free: 250, total: 500 }))).toBe(0.5);
    expect(driveUsedFraction(drive({ free: 0, total: 500 }))).toBe(1);
    expect(driveUsedFraction(drive({ free: 500, total: 500 }))).toBe(0);
  });

  it("is null when there is nothing to draw", () => {
    expect(driveUsedFraction(drive({ free: null, total: null }))).toBeNull();
  });

  // Quota-aware "available to the caller" can exceed the total; the bar must not
  // overflow or go negative.
  it("clamps a quota-skewed free figure into 0…1", () => {
    expect(driveUsedFraction(drive({ free: 900, total: 500 }))).toBe(0);
  });
});

describe("isDriveEntry", () => {
  it("distinguishes synthetic drive rows from real entries", () => {
    expect(isDriveEntry(entry({ drive: drive() }))).toBe(true);
    expect(isDriveEntry(entry())).toBe(false);
    expect(isDriveEntry(entry({ name: "Users", path: "C:\\Users" }))).toBe(false);
  });
});
