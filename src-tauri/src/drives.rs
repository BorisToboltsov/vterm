//! Windows drive enumeration for the local file panel (Phase 39.1).
//!
//! Windows has a level above a drive root that POSIX has no analogue for — the
//! list of drive letters, which Explorer calls "This PC". Phase 39 hid the ".."
//! row at `C:\` (it was navigating to a bare separator and printing `/` in the
//! path bar), which fixed the lie but closed the only door: the panel's path bar
//! is read-only text, so with no ".." there was **no way at all** to reach `D:`.
//! So ".." now leads here instead of nowhere.
//!
//! ## Why `GetLogicalDrives` and not something friendlier
//!
//! Two obvious alternatives were rejected for concrete reasons:
//!
//!   * **`sysinfo::Disks`** (already a dependency, and it hands over volume labels
//!     and free space for free) enumerates volumes via `FindFirstVolumeW` and then
//!     keeps only `DRIVE_FIXED`/`DRIVE_REMOVABLE`. **Mapped network drives and
//!     optical drives never appear** — and a mounted share is an everyday thing for
//!     this app's users.
//!   * **Probing `A:\`…`Z:\` with `fs::metadata`** is complete and dependency-free,
//!     but touching a *stale* mapped network drive blocks on an SMB timeout. The
//!     panel would freeze for seconds every time the user went up to the root.
//!
//! `GetLogicalDrives` returns a bitmask of present letters **without touching any
//! volume**, so it is both complete and instant. That is the whole reason it wins.
//!
//! ## The enrichment tradeoff
//!
//! Labels and free space DO require touching the volume, which reintroduces the
//! hang risk above. So enrichment is limited to `DRIVE_FIXED`/`DRIVE_REMOVABLE`
//! (local hardware, answers immediately) and skipped for `DRIVE_REMOTE`/
//! `DRIVE_CDROM`, which are listed as a bare letter plus their kind. A connected
//! network drive would enrich fine; a disconnected one would hang, and we cannot
//! tell which we have without paying the timeout — so neither is enriched.
//! `SetThreadErrorMode(SEM_FAILCRITICALERRORS)` additionally suppresses the
//! "There is no disk in the drive" modal for an empty card reader or optical bay.
//!
//! Everything here is local syscalls — no network, so the offline invariant holds.

use crate::sftp::FileEntry;
use serde::Serialize;

/// Drive-specific facts for a "This PC" row. Deliberately **structured, not a
/// pre-formatted string**: the display text ("Windows (C:) — 120 GB free of 500 GB")
/// is user-visible and must go through `t()` on the front end, so the backend
/// hands over numbers and a kind, never prose (i18n invariant).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    /// Volume label (`Windows`, `Data`), empty when unknown or not enriched.
    pub label: String,
    /// `fixed` | `removable` | `remote` | `cdrom` | `ramdisk` | `unknown`.
    pub kind: &'static str,
    /// Free bytes available to the caller; `None` when not enriched.
    pub free: Option<u64>,
    /// Total bytes; `None` when not enriched.
    pub total: Option<u64>,
}

// `GetDriveTypeW` return values. Defined locally rather than pulling in the
// `Win32_System_WindowsProgramming` grab-bag feature for seven ABI-frozen
// integers — same pattern as the `FILE_ATTRIBUTE_*` constants in localfile.rs.

// The next two fall into `drive_kind`'s catch-all arm, so nothing but the tests
// names them — `allow` here is unconditional (not `cfg_attr(not(windows))`)
// because they are dead in a non-test build on EVERY platform, Windows included.
// Kept because they document the value space the catch-all absorbs.
#[allow(dead_code)]
const DRIVE_UNKNOWN: u32 = 0;
#[allow(dead_code)]
const DRIVE_NO_ROOT_DIR: u32 = 1;
#[cfg_attr(not(windows), allow(dead_code))]
const DRIVE_REMOVABLE: u32 = 2;
#[cfg_attr(not(windows), allow(dead_code))]
const DRIVE_FIXED: u32 = 3;
#[cfg_attr(not(windows), allow(dead_code))]
const DRIVE_REMOTE: u32 = 4;
#[cfg_attr(not(windows), allow(dead_code))]
const DRIVE_CDROM: u32 = 5;
#[cfg_attr(not(windows), allow(dead_code))]
const DRIVE_RAMDISK: u32 = 6;

/// Decode a `GetLogicalDrives` bitmask into drive letters: bit 0 is `A`, bit 1
/// `B`, and so on. Pure, so the decoding is unit-tested on every platform rather
/// than only wherever Windows happens to run.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn drive_letters(mask: u32) -> Vec<char> {
    (0..26u32)
        .filter(|i| mask & (1 << i) != 0)
        .filter_map(|i| char::from_u32('A' as u32 + i))
        .collect()
}

/// Map a `GetDriveTypeW` result to the stable string the front end localises.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn drive_kind(drive_type: u32) -> &'static str {
    match drive_type {
        DRIVE_REMOVABLE => "removable",
        DRIVE_FIXED => "fixed",
        DRIVE_REMOTE => "remote",
        DRIVE_CDROM => "cdrom",
        DRIVE_RAMDISK => "ramdisk",
        // DRIVE_UNKNOWN, DRIVE_NO_ROOT_DIR, and anything Windows adds later.
        _ => "unknown",
    }
}

/// Whether it is safe to read this drive's label and free space. See the module
/// docs: network and optical drives can block for seconds when unavailable, and
/// we cannot distinguish "available" from "stale" without paying that cost.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn should_enrich(kind: &str) -> bool {
    matches!(kind, "fixed" | "removable" | "ramdisk")
}

/// One synthetic directory entry per drive, for the "This PC" level. `name` is the
/// bare letter (`C:`); the display string is composed on the front end from
/// `drive`. Empty on non-Windows, where this level does not exist.
pub fn list() -> Vec<FileEntry> {
    #[cfg(windows)]
    {
        windows_impl::list()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Build the `FileEntry` for one drive. Split out of the Windows-only lookup so
/// the entry shape is exercised by tests on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn drive_entry(letter: char, info: DriveInfo) -> FileEntry {
    FileEntry {
        name: format!("{letter}:"),
        path: format!("{letter}:\\"),
        is_dir: true,
        is_symlink: false,
        size: 0,
        modified: None,
        // A drive has neither unix mode bits nor DOS attributes of its own; the
        // panel renders "—" rather than inventing permissions for it.
        mode: None,
        attrs: None,
        uid: None,
        gid: None,
        user: None,
        group: None,
        drive: Some(info),
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SetThreadErrorMode, SEM_FAILCRITICALERRORS,
    };

    /// `C:\` as a NUL-terminated UTF-16 buffer, which is what every Win32 call
    /// below wants as its root-path argument.
    fn root_wide(letter: char) -> Vec<u16> {
        format!("{letter}:\\\0").encode_utf16().collect()
    }

    /// Volume label for a drive, or empty when it has none / is unreadable.
    fn volume_label(root: &[u16]) -> String {
        let mut name = [0u16; 261]; // MAX_PATH + 1
        let ok = unsafe {
            GetVolumeInformationW(
                root.as_ptr(),
                name.as_mut_ptr(),
                name.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };
        if ok == 0 {
            return String::new();
        }
        let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        String::from_utf16_lossy(&name[..end])
    }

    /// (free, total) bytes for a drive, or `None` when unreadable (e.g. an empty
    /// card reader). `free` is the caller-available figure, which is what the user
    /// cares about under a disk quota.
    fn free_space(root: &[u16]) -> Option<(u64, u64)> {
        let mut avail = 0u64;
        let mut total = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(root.as_ptr(), &mut avail, &mut total, std::ptr::null_mut())
        };
        (ok != 0).then_some((avail, total))
    }

    pub(super) fn list() -> Vec<FileEntry> {
        // Suppress the "There is no disk in the drive" modal an empty optical or
        // card-reader bay would otherwise pop up during enrichment. Restored below
        // so the setting doesn't leak into the rest of the process.
        let mut prev = 0u32;
        let changed = unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, &mut prev) } != 0;

        let entries = drive_letters(unsafe { GetLogicalDrives() })
            .into_iter()
            .map(|letter| {
                let root = root_wide(letter);
                let kind = drive_kind(unsafe { GetDriveTypeW(root.as_ptr()) });
                // Network/optical drives are listed but never probed — see the
                // module docs on why this is a hang, not a cosmetic, concern.
                let (label, free, total) = if should_enrich(kind) {
                    let (free, total) = match free_space(&root) {
                        Some((f, t)) => (Some(f), Some(t)),
                        None => (None, None),
                    };
                    (volume_label(&root), free, total)
                } else {
                    (String::new(), None, None)
                };
                drive_entry(
                    letter,
                    DriveInfo {
                        label,
                        kind,
                        free,
                        total,
                    },
                )
            })
            .collect();

        if changed {
            unsafe { SetThreadErrorMode(prev, std::ptr::null_mut()) };
        }
        entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_logical_drive_bitmask() {
        // Bit 0 = A:, bit 2 = C:. A typical machine with C: and D:.
        assert_eq!(drive_letters(0b0000_1100), vec!['C', 'D']);
        // A floppy-era mask: A: and C:.
        assert_eq!(drive_letters(0b0000_0101), vec!['A', 'C']);
        // Single drive.
        assert_eq!(drive_letters(1 << 2), vec!['C']);
        // Last valid letter, Z: (bit 25) — the loop must not stop short.
        assert_eq!(drive_letters(1 << 25), vec!['Z']);
        // No drives at all (can't happen in practice, but must not panic).
        assert!(drive_letters(0).is_empty());
    }

    #[test]
    fn ignores_bits_above_the_letter_range() {
        // Bits 26+ have no letter; they must be dropped, not turned into `[`.
        assert_eq!(drive_letters(0xFFFF_FFFF).len(), 26);
        assert_eq!(drive_letters(0xFFFF_FFFF)[25], 'Z');
        assert_eq!(drive_letters(1 << 26), Vec::<char>::new());
    }

    #[test]
    fn maps_every_drive_type_to_a_stable_kind() {
        assert_eq!(drive_kind(DRIVE_FIXED), "fixed");
        assert_eq!(drive_kind(DRIVE_REMOVABLE), "removable");
        assert_eq!(drive_kind(DRIVE_REMOTE), "remote");
        assert_eq!(drive_kind(DRIVE_CDROM), "cdrom");
        assert_eq!(drive_kind(DRIVE_RAMDISK), "ramdisk");
        assert_eq!(drive_kind(DRIVE_UNKNOWN), "unknown");
        assert_eq!(drive_kind(DRIVE_NO_ROOT_DIR), "unknown");
        assert_eq!(drive_kind(999), "unknown"); // future/unexpected value
    }

    // The hang-avoidance rule from the module docs, pinned as a test so it can't
    // be "simplified" into probing every drive.
    #[test]
    fn never_probes_network_or_optical_drives() {
        assert!(should_enrich("fixed"));
        assert!(should_enrich("removable"));
        assert!(
            !should_enrich("remote"),
            "a stale SMB mount blocks for seconds"
        );
        assert!(!should_enrich("cdrom"), "an empty optical bay blocks");
        assert!(!should_enrich("unknown"));
    }

    #[test]
    fn drive_entry_is_a_navigable_directory_at_the_drive_root() {
        let e = drive_entry(
            'C',
            DriveInfo {
                label: "Windows".into(),
                kind: "fixed",
                free: Some(120),
                total: Some(500),
            },
        );
        assert_eq!(e.name, "C:");
        // Must be the drive ROOT, so clicking it lands in a listable directory.
        assert_eq!(e.path, "C:\\");
        assert!(e.is_dir);
        // No invented permissions/ownership for a synthetic entry.
        assert!(e.mode.is_none());
        assert!(e.attrs.is_none());
        assert!(e.uid.is_none());
        assert_eq!(e.drive.unwrap().label, "Windows");
    }
}
