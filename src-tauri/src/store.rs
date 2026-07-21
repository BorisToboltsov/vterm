//! JSON persistence for server profiles.
//!
//! Profiles are stored in the platform config directory:
//! - macOS:   ~/Library/Application Support/su.vcore.vterm/servers.json
//! - Windows: %APPDATA%\su.vcore.vterm\config\servers.json
//!
//! Passwords are never written here — they go to the OS keychain (Phase 2).

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::model::ServerProfile;

fn config_file(name: &str) -> Option<PathBuf> {
    directories::ProjectDirs::from("su", "vcore", "vterm").map(|dirs| dirs.config_dir().join(name))
}

fn store_path() -> Option<PathBuf> {
    config_file("servers.json")
}

// ── Atomic write ───────────────────────────────────────────────────────────────
//
// Every store file is rewritten whole on each change, so a crash or power loss
// mid-write used to leave a truncated `servers.json` — and `load_*` decodes a
// truncated file as "no servers at all". Same shape as `localfile::local_temp` +
// rename in the file editor, and for the same reason: a half-written file must
// never be observable at the real path.

/// Nanosecond-tagged sibling of `path` used as the write target before the
/// rename. Dot-prefixed so it does not show up in a directory listing.
fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "vterm".into());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = format!(".{name}.vterm-tmp-{nanos:x}");
    match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(tmp),
        _ => PathBuf::from(tmp),
    }
}

/// Write `bytes` to `path` so the target is never observed partially written:
/// full write to a temp sibling, flushed to disk, then renamed onto the target.
///
/// `sync_all` before the rename is the point of the exercise — without it the
/// metadata operation can reach the disk ahead of the data, which is exactly the
/// "file exists but is empty after a power cut" failure. A crash can still leave
/// a temp sibling behind (harmless, dot-prefixed); it can no longer leave a
/// truncated `path`.
///
/// `fs::rename` replaces an existing destination on both POSIX and Windows, but
/// on Windows it fails if another process holds the target open (antivirus, a
/// second vterm) — that is surfaced as an error rather than swallowed, because
/// the caller's alternative is to believe a save happened that did not.
fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let tmp = temp_sibling(path);
    let written = (|| -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", tmp.display()).into());
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename onto {}: {e}", path.display()).into());
    }
    Ok(())
}

// ── Corrupt-file quarantine ────────────────────────────────────────────────────
//
// A store file that reads fine but does not parse used to decode to an empty
// list, which the UI showed as "you have no servers" — and the next save then
// wrote that emptiness over the only copy. Atomic writes do not help here: the
// damage is done by a *successful* write of a wrong value. So a file that fails
// to parse is moved aside before anything else touches it, and the user is told.

/// A store file that could not be parsed on load. `quarantined` is the path the
/// original was moved to, or `None` when even that failed — a distinction the
/// user needs, since only the first case means their data is safe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreWarning {
    pub file: String,
    pub quarantined: Option<String>,
}

fn warnings() -> &'static Mutex<Vec<StoreWarning>> {
    static W: OnceLock<Mutex<Vec<StoreWarning>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(Vec::new()))
}

/// Drain the warnings collected during startup loads. The frontend calls this
/// once on mount; draining means a warning is shown exactly once.
pub fn take_warnings() -> Vec<StoreWarning> {
    let mut w = warnings().lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *w)
}

/// Where a corrupt `path` is moved: same directory, `.corrupt-<nanos>` suffix.
/// Timestamped rather than fixed so a second corruption cannot overwrite the
/// evidence from the first.
fn quarantine_path(path: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "vterm".into());
    let quarantined = format!("{name}.corrupt-{nanos:x}");
    match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(quarantined),
        _ => PathBuf::from(quarantined),
    }
}

/// Read and decode a store file. A missing file is the normal first-run case and
/// yields the default silently; a file that is present but unparseable is moved
/// aside and recorded as a warning, never silently treated as "empty".
fn read_store<T>(path: &Path) -> T
where
    T: Default + serde::de::DeserializeOwned,
{
    let Ok(bytes) = fs::read(path) else {
        // Missing (first run) or unreadable. Nothing to quarantine, and a
        // permission error surfaces on the next save attempt anyway.
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            let dest = quarantine_path(path);
            let quarantined = fs::rename(path, &dest)
                .ok()
                .map(|()| dest.display().to_string());
            if let Ok(mut w) = warnings().lock() {
                w.push(StoreWarning {
                    file: path.display().to_string(),
                    quarantined,
                });
            }
            T::default()
        }
    }
}

/// Load saved profiles. Returns an empty list if the file is missing; a corrupt
/// file is quarantined first (see `read_store`).
pub fn load_servers() -> Vec<ServerProfile> {
    let Some(path) = store_path() else {
        return Vec::new();
    };
    read_store(&path)
}

/// Persist the full list of profiles, creating the config directory if needed.
pub fn save_servers(servers: &[ServerProfile]) -> AppResult<()> {
    let path = store_path().ok_or("could not resolve config directory")?;
    let json = serde_json::to_vec_pretty(servers).map_err(|e| format!("serialize: {e}"))?;
    write_atomic(&path, &json)
}

// ── Folders (server-list organization) ─────────────────────────────────────────
//
// Folders are stored as a flat list of full "/"-separated paths (e.g.
// "Production", "Production/EU"). Persisting them explicitly lets empty folders
// — and empty nested folders — survive across restarts.

fn folders_path() -> Option<PathBuf> {
    config_file("folders.json")
}

pub fn load_folders() -> Vec<String> {
    let Some(path) = folders_path() else {
        return Vec::new();
    };
    read_store(&path)
}

pub fn save_folders(folders: &[String]) -> AppResult<()> {
    let path = folders_path().ok_or("could not resolve config directory")?;
    let json = serde_json::to_vec_pretty(folders).map_err(|e| format!("serialize: {e}"))?;
    write_atomic(&path, &json)
}

// ── Host-key store (vterm-managed known_hosts) ─────────────────────────────────
//
// Maps "host:port" → host-key fingerprint (SHA256). Used to verify server
// identity on connect according to the configured policy (see ssh.rs).

fn host_keys_path() -> Option<PathBuf> {
    config_file("known_hosts.json")
}

fn load_host_keys() -> HashMap<String, String> {
    let Some(path) = host_keys_path() else {
        return HashMap::new();
    };
    read_store(&path)
}

/// The recorded fingerprint for `host:port`, if any.
pub fn known_host_key(id: &str) -> Option<String> {
    load_host_keys().get(id).cloned()
}

/// Record (or overwrite) the fingerprint for `host:port`. Best-effort: a write
/// failure is ignored so a transient FS error never blocks a connection.
pub fn remember_host_key(id: &str, fingerprint: &str) {
    let mut map = load_host_keys();
    map.insert(id.to_string(), fingerprint.to_string());
    let Some(path) = host_keys_path() else {
        return;
    };
    if let Ok(json) = serde_json::to_vec_pretty(&map) {
        // Best-effort by design (see doc comment), but still atomic: a crash here
        // must not truncate the trust store into "no host is known".
        let _ = write_atomic(&path, &json);
    }
}

/// All recorded host keys as `(host:port, fingerprint)` pairs. Backs the
/// known_hosts manager utility (Phase 33).
pub fn list_host_keys() -> Vec<(String, String)> {
    load_host_keys().into_iter().collect()
}

/// Pure helper: the map with `id` removed + whether it was present. Kept separate
/// so the removal logic is unit-tested without touching the config directory.
fn map_without(mut map: HashMap<String, String>, id: &str) -> (HashMap<String, String>, bool) {
    let removed = map.remove(id).is_some();
    (map, removed)
}

/// Remove the recorded key for `id`, persisting the result. Returns whether an
/// entry was actually removed (so the UI can report "not found" vs "removed").
pub fn forget_host_key(id: &str) -> bool {
    let (map, removed) = map_without(load_host_keys(), id);
    if !removed {
        return false;
    }
    if let Some(path) = host_keys_path() {
        if let Ok(json) = serde_json::to_vec_pretty(&map) {
            let _ = write_atomic(&path, &json);
        }
    }
    removed
}

// ── Tauri commands ─────────────────────────────────────────────────────────────
// Self-contained commands (no shared `AppState`) that read/mutate the on-disk
// store, moved next to that logic (Phase 44.9). Registered as `store::…`.

/// One entry of the vterm-managed known_hosts store, for the manager utility.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    /// `host:port` identifier.
    id: String,
    /// Recorded SHA256 host-key fingerprint.
    fingerprint: String,
}

/// List every recorded host key (`host:port` → fingerprint). Local file read only.
#[tauri::command]
pub fn list_known_hosts() -> Vec<KnownHostEntry> {
    list_host_keys()
        .into_iter()
        .map(|(id, fingerprint)| KnownHostEntry { id, fingerprint })
        .collect()
}

/// Forget the recorded host key for `id`. Returns whether an entry was removed.
#[tauri::command]
pub fn remove_known_host(id: String) -> bool {
    forget_host_key(&id)
}

/// Config files that failed to parse during the startup load and were moved
/// aside. Drains the list, so the frontend shows each warning exactly once.
#[tauri::command]
pub fn take_store_warnings() -> Vec<StoreWarning> {
    take_warnings()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AuthMethod, ServerProfile};

    fn sample() -> ServerProfile {
        ServerProfile {
            id: "srv-1".into(),
            alias: "Web".into(),
            host: "10.0.0.1".into(),
            port: 22,
            username: "root".into(),
            auth_method: AuthMethod::Password,
            key_path: None,
            has_saved_password: false,
            group: Some("Prod".into()),
            tags: vec!["web".into()],
            auto_record: false,
            no_ai: false,
            chat_prompt_id: None,
            exec_mode: None,
            proxy: None,
            notes: String::new(),
            icon: String::new(),
            icon_color: String::new(),
        }
    }

    /// Serializes the tests that touch the process-global warning list, which
    /// `take_warnings` drains — parallel test threads would otherwise steal each
    /// other's warnings.
    fn warnings_guard() -> std::sync::MutexGuard<'static, ()> {
        static G: OnceLock<Mutex<()>> = OnceLock::new();
        G.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn servers_round_trip_through_the_real_write_path() {
        // Exercises save→load as it actually runs, not a decode of hand-made
        // bytes: the atomic write is part of what has to round-trip.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("servers.json");
        write_atomic(&path, &serde_json::to_vec_pretty(&vec![sample()]).unwrap()).unwrap();

        let got: Vec<ServerProfile> = read_store(&path);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].alias, "Web");
        assert_eq!(got[0].group.as_deref(), Some("Prod"));
        assert_eq!(got[0].auth_method, AuthMethod::Password);
    }

    #[test]
    fn folders_round_trip_through_the_real_write_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("folders.json");
        let folders = vec!["Prod".to_string(), "Prod/EU".to_string()];
        write_atomic(&path, &serde_json::to_vec_pretty(&folders).unwrap()).unwrap();

        let got: Vec<String> = read_store(&path);
        assert_eq!(got, folders);
    }

    #[test]
    fn host_keys_round_trip_through_the_real_write_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        let mut map = HashMap::new();
        map.insert("a:22".to_string(), "fp-a".to_string());
        write_atomic(&path, &serde_json::to_vec_pretty(&map).unwrap()).unwrap();

        let got: HashMap<String, String> = read_store(&path);
        assert_eq!(got, map);
    }

    // ── Atomic write ───────────────────────────────────────────────────────────

    #[test]
    fn temp_sibling_is_a_hidden_neighbour() {
        let t = temp_sibling(Path::new("/cfg/servers.json"));
        assert_eq!(t.parent().unwrap(), Path::new("/cfg"));
        let name = t.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with(".servers.json.vterm-tmp-"));
        // Two calls must not collide on the same target.
        assert_ne!(temp_sibling(Path::new("/cfg/servers.json")), t);
    }

    #[test]
    fn write_atomic_replaces_content_and_leaves_no_temp_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("servers.json");

        write_atomic(&path, b"[1]").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"[1]");
        // Overwriting an existing file is the normal case, not an error.
        write_atomic(&path, b"[2,3]").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"[2,3]");

        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("vterm-tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
    }

    #[test]
    fn write_atomic_creates_the_config_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/deeper/servers.json");
        write_atomic(&path, b"[]").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"[]");
    }

    #[test]
    fn failed_rename_reports_and_cleans_up_the_temp() {
        // A directory at the target path makes the rename fail; the temp file
        // must not survive it, and the caller must hear about the failure rather
        // than believe the save happened.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("servers.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("occupied"), b"x").unwrap();

        assert!(write_atomic(&path, b"[]").is_err());
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("vterm-tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
    }

    // ── Corrupt-file quarantine ────────────────────────────────────────────────

    #[test]
    fn warning_serializes_as_the_frontend_declares_it() {
        // `StoreWarning` in api/core.ts types `quarantined` as `string | null` and
        // branches on it to pick between two different messages — a rename of the
        // field or an `Option` that skipped serializing would silently downgrade
        // "your data is at risk" into the reassuring message.
        let json = serde_json::to_string(&StoreWarning {
            file: "/cfg/servers.json".into(),
            quarantined: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"file":"/cfg/servers.json","quarantined":null}"#);

        let json = serde_json::to_string(&StoreWarning {
            file: "/cfg/servers.json".into(),
            quarantined: Some("/cfg/servers.json.corrupt-1".into()),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"file":"/cfg/servers.json","quarantined":"/cfg/servers.json.corrupt-1"}"#
        );
    }

    #[test]
    fn quarantine_path_is_a_timestamped_neighbour() {
        let q = quarantine_path(Path::new("/cfg/servers.json"));
        assert_eq!(q.parent().unwrap(), Path::new("/cfg"));
        let name = q.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("servers.json.corrupt-"));
        // A second corruption must not overwrite the evidence from the first.
        assert_ne!(quarantine_path(Path::new("/cfg/servers.json")), q);
    }

    #[test]
    fn read_store_returns_the_value_and_warns_about_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("servers.json");
        fs::write(&path, serde_json::to_vec(&vec![sample()]).unwrap()).unwrap();

        let got: Vec<ServerProfile> = read_store(&path);
        assert_eq!(got.len(), 1);
        assert!(path.exists(), "a readable file must be left alone");
    }

    #[test]
    fn read_store_treats_a_missing_file_as_a_normal_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let got: Vec<ServerProfile> = read_store(&dir.path().join("nope.json"));
        assert!(got.is_empty());
        // No file appeared, and nothing was quarantined.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn corrupt_file_is_moved_aside_and_reported_never_silently_emptied() {
        // The whole point: a file that parses as nothing must not be mistaken for
        // "the user has no servers", because the next save would write that over
        // the only copy.
        let _g = warnings_guard();
        take_warnings();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("servers.json");
        fs::write(&path, b"{ half-written garbage ]").unwrap();

        let got: Vec<ServerProfile> = read_store(&path);
        assert!(got.is_empty(), "corrupt content cannot yield profiles");
        assert!(
            !path.exists(),
            "the corrupt file must be moved out of the way"
        );

        let saved: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("servers.json.corrupt-"))
            .collect();
        assert_eq!(saved.len(), 1, "the original bytes must survive somewhere");
        let kept = fs::read(dir.path().join(&saved[0])).unwrap();
        assert_eq!(kept, b"{ half-written garbage ]");

        // And the user is told — with the path their data is now at.
        let warning = take_warnings()
            .into_iter()
            .find(|w| w.file == path.display().to_string())
            .expect("a corrupt load must produce a warning");
        assert_eq!(
            warning.quarantined,
            Some(dir.path().join(&saved[0]).display().to_string())
        );

        // Draining is what makes the toast show exactly once.
        assert!(take_warnings().is_empty());
    }

    #[test]
    fn a_later_save_cannot_reach_the_quarantined_copy() {
        // Regression guard for the actual data-loss path: load a corrupt file,
        // then save the (empty) result — the rescued copy must be untouched.
        let _g = warnings_guard();
        take_warnings();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("folders.json");
        fs::write(&path, b"not json at all").unwrap();

        let _: Vec<String> = read_store(&path);
        write_atomic(&path, b"[]").unwrap();

        let rescued: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("folders.json.corrupt-"))
            .collect();
        assert_eq!(rescued.len(), 1);
        assert_eq!(
            fs::read(dir.path().join(&rescued[0])).unwrap(),
            b"not json at all"
        );
        take_warnings();
    }

    #[test]
    fn map_without_removes_only_the_named_key() {
        let mut m = HashMap::new();
        m.insert("a:22".to_string(), "fp-a".to_string());
        m.insert("b:22".to_string(), "fp-b".to_string());

        let (after, removed) = map_without(m.clone(), "a:22");
        assert!(removed);
        assert_eq!(after.len(), 1);
        assert_eq!(after.get("b:22").map(String::as_str), Some("fp-b"));

        let (after, removed) = map_without(m, "missing:22");
        assert!(!removed);
        assert_eq!(after.len(), 2);
    }
}
