// Presentation logic for the Windows "This PC" level (Phase 39.1) — the list of
// drive letters that sits above a drive root, reachable via the ".." row.
//
// Kept pure and DOM-free (ADR 0003), and deliberately free of `t()`: these helpers
// return i18n KEYS and numeric params, never finished prose. The backend likewise
// hands over structured facts (label / kind / free / total) rather than a rendered
// string — a drive row reads "Windows (C:) — 120 GB free of 500 GB", every word of
// which has to be translatable (i18n invariant).

import type { IconName } from "./icons";
import type { MessageKey } from "./i18n";
import type { FileEntry } from "./types";

/** Drive facts from the backend (mirrors `drives.rs` DriveInfo). */
export interface DriveInfo {
  /** Volume label (`Windows`, `Data`); empty when unknown or not probed. */
  label: string;
  kind: "fixed" | "removable" | "remote" | "cdrom" | "ramdisk" | "unknown";
  /** Free bytes available to the caller; null when the drive wasn't probed. */
  free: number | null;
  /** Total bytes; null when the drive wasn't probed. */
  total: number | null;
}

/**
 * Explorer-style row title: the volume label with the letter in parentheses, or
 * the bare letter when there is no label (an unlabelled volume, or one we
 * deliberately did not probe — see `should_enrich` in drives.rs).
 */
export function driveDisplayName(letter: string, drive: DriveInfo): string {
  return drive.label ? `${drive.label} (${letter})` : letter;
}

/** Icon for a drive row: optical drives get a disc, network drives a topology. */
export function driveIcon(drive: DriveInfo): IconName {
  if (drive.kind === "cdrom") return "disc";
  if (drive.kind === "remote") return "network";
  return "hardDrive";
}

/**
 * i18n key naming the drive kind, for the drives we don't show a size for.
 * Spelled out as a literal map rather than an interpolated `as MessageKey` cast:
 * a cast would silently produce a key that doesn't exist, while this fails
 * `pnpm check` the moment a kind is added without translations.
 */
const KIND_KEY: Record<DriveInfo["kind"], MessageKey> = {
  fixed: "drive.kind.fixed",
  removable: "drive.kind.removable",
  remote: "drive.kind.remote",
  cdrom: "drive.kind.cdrom",
  ramdisk: "drive.kind.ramdisk",
  unknown: "drive.kind.unknown",
};

export function driveKindKey(drive: DriveInfo): MessageKey {
  return KIND_KEY[drive.kind] ?? "drive.kind.unknown";
}

/**
 * Usage figures for the row's secondary line, or `null` when the drive was not
 * probed (network/optical — probing a stale mount blocks for seconds) or reported
 * nothing (an empty card reader). `null` means the caller should fall back to the
 * kind label rather than render "0 B free of 0 B".
 */
export function driveUsage(drive: DriveInfo): { free: number; total: number } | null {
  if (drive.free == null || drive.total == null) return null;
  // A total of 0 is what an unreadable volume reports; treat it as "no data"
  // rather than dividing by zero for the fill bar.
  if (drive.total <= 0) return null;
  return { free: drive.free, total: drive.total };
}

/**
 * Used fraction 0…1 for the capacity bar, or `null` when unknown. Clamped, since
 * quota-aware "free bytes available to the caller" can exceed the reported total
 * in odd configurations and would otherwise overflow the bar.
 */
export function driveUsedFraction(drive: DriveInfo): number | null {
  const u = driveUsage(drive);
  if (!u) return null;
  return Math.min(1, Math.max(0, (u.total - u.free) / u.total));
}

/** True for a synthetic drive row (as opposed to a real file/folder entry). */
export function isDriveEntry(entry: FileEntry): boolean {
  return entry.drive != null;
}
