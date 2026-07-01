//! JSON persistence for server profiles.
//!
//! Profiles are stored in the platform config directory:
//! - macOS:   ~/Library/Application Support/su.vcore.vterm/servers.json
//! - Windows: %APPDATA%\su.vcore.vterm\config\servers.json
//!
//! Passwords are never written here — they go to the OS keychain (Phase 2).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::error::AppResult;
use crate::model::ServerProfile;

fn config_file(name: &str) -> Option<PathBuf> {
    directories::ProjectDirs::from("su", "vcore", "vterm").map(|dirs| dirs.config_dir().join(name))
}

fn store_path() -> Option<PathBuf> {
    config_file("servers.json")
}

/// Decode JSON `bytes` into `T`, falling back to `T::default()` on any parse
/// error (corrupt/partial file). Pure, so it can be unit-tested directly.
fn decode_or_default<T>(bytes: &[u8]) -> T
where
    T: Default + serde::de::DeserializeOwned,
{
    serde_json::from_slice(bytes).unwrap_or_default()
}

/// Load saved profiles. Returns an empty list if the file is missing or unreadable.
pub fn load_servers() -> Vec<ServerProfile> {
    let Some(path) = store_path() else {
        return Vec::new();
    };
    match fs::read(&path) {
        Ok(bytes) => decode_or_default(&bytes),
        Err(_) => Vec::new(),
    }
}

/// Persist the full list of profiles, creating the config directory if needed.
pub fn save_servers(servers: &[ServerProfile]) -> AppResult<()> {
    let path = store_path().ok_or("could not resolve config directory")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(servers).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()).into())
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
    match fs::read(&path) {
        Ok(bytes) => decode_or_default(&bytes),
        Err(_) => Vec::new(),
    }
}

pub fn save_folders(folders: &[String]) -> AppResult<()> {
    let path = folders_path().ok_or("could not resolve config directory")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(folders).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()).into())
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
    match fs::read(&path) {
        Ok(bytes) => decode_or_default(&bytes),
        Err(_) => HashMap::new(),
    }
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
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec_pretty(&map) {
        let _ = fs::write(&path, json);
    }
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
        }
    }

    #[test]
    fn decode_valid_servers() {
        let bytes = serde_json::to_vec(&vec![sample()]).unwrap();
        let got: Vec<ServerProfile> = decode_or_default(&bytes);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].alias, "Web");
    }

    #[test]
    fn decode_broken_json_falls_back_to_default() {
        let got: Vec<ServerProfile> = decode_or_default(b"{ not valid json ]");
        assert!(got.is_empty());
        let folders: Vec<String> = decode_or_default(b"garbage");
        assert!(folders.is_empty());
        let keys: HashMap<String, String> = decode_or_default(b"");
        assert!(keys.is_empty());
    }

    #[test]
    fn file_round_trip_via_tempdir() {
        // Mirrors what save_*/load_* do: pretty JSON on disk, decoded back.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("servers.json");
        let json = serde_json::to_vec_pretty(&vec![sample()]).unwrap();
        fs::write(&path, json).unwrap();

        let bytes = fs::read(&path).unwrap();
        let got: Vec<ServerProfile> = decode_or_default(&bytes);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].group.as_deref(), Some("Prod"));
        assert_eq!(got[0].auth_method, AuthMethod::Password);
    }

    #[test]
    fn folders_round_trip() {
        let folders = vec!["Prod".to_string(), "Prod/EU".to_string()];
        let bytes = serde_json::to_vec(&folders).unwrap();
        let got: Vec<String> = decode_or_default(&bytes);
        assert_eq!(got, folders);
    }
}
