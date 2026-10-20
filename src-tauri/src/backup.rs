//! Backup export/import.
//!
//! A backup is a portable **`.zip` archive** holding any combination of three
//! data sections — server profiles + folder structure (`servers`), the UI
//! settings snapshot (`settings`), and session recordings (`recordings`). The
//! user picks what to export via a preset *kind* (`servers` / `settings` /
//! `recordings` / `all`).
//!
//! Every archive carries a `manifest.json` at its root identifying the app, the
//! kind, and the sections present; import reads it to auto-detect what to restore
//! (and which sections to leave untouched). `servers`/`settings` live in an inner
//! `backup.json`; recordings are stored as `recordings/*.cast`.
//!
//! Secrets are intentionally **never** included — passwords/passphrases live in
//! the OS keychain (see secrets.rs) and are not portable. An import is shown
//! first (`read_backup`): the frontend changes logins and key paths, resets
//! `hasSavedPassword` where this keychain has no secret, and replaces the
//! catalog or adds to it (`backupimport.ts`); `import_backup` in lib.rs writes
//! that catalog, never the archive's own list as is.
//!
//! The pure functions here (build/encode/decode, manifest and archive helpers)
//! are unit-tested; `import_backup` in lib.rs wraps them with state.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::model::ServerProfile;

/// Current backup schema version. Bump on breaking changes; `decode` rejects
/// versions newer than this.
pub const BACKUP_VERSION: u32 = 1;

/// Data-section identifiers (also used as the manifest's `sections` entries).
pub const SECTION_SERVERS: &str = "servers";
pub const SECTION_SETTINGS: &str = "settings";
pub const SECTION_RECORDINGS: &str = "recordings";

/// Backup preset kinds the user can choose to export.
pub const KIND_SERVERS: &str = "servers";
pub const KIND_SETTINGS: &str = "settings";
pub const KIND_RECORDINGS: &str = "recordings";
pub const KIND_ALL: &str = "all";

/// Archive member names.
pub const MANIFEST_NAME: &str = "manifest.json";
pub const BACKUP_NAME: &str = "backup.json";
pub const RECORDINGS_PREFIX: &str = "recordings/";

/// Which data sections a chosen backup `kind` includes. The `servers` section
/// carries the folder structure too; an unknown kind falls back to a full backup.
pub fn sections_for_kind(kind: &str) -> Vec<String> {
    match kind {
        KIND_SERVERS => vec![SECTION_SERVERS.into()],
        KIND_SETTINGS => vec![SECTION_SETTINGS.into()],
        KIND_RECORDINGS => vec![SECTION_RECORDINGS.into()],
        _ => vec![
            SECTION_SERVERS.into(),
            SECTION_SETTINGS.into(),
            SECTION_RECORDINGS.into(),
        ],
    }
}

/// Identification document at the root of every backup archive (`manifest.json`).
/// Import reads it to learn what the archive holds and restore only those sections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// App marker ("vterm").
    pub app: String,
    pub version: u32,
    /// The user-chosen preset: "servers" | "settings" | "recordings" | "all".
    pub kind: String,
    /// Export time (epoch seconds); informational.
    #[serde(default)]
    pub exported_at: u64,
    /// Data sections present in the archive — drives a section-aware restore.
    #[serde(default)]
    pub sections: Vec<String>,
}

impl Manifest {
    /// Is `section` (one of the `SECTION_*` ids) present in this archive?
    pub fn has(&self, section: &str) -> bool {
        self.sections.iter().any(|s| s == section)
    }
}

/// Assemble the manifest for a chosen `kind`.
pub fn build_manifest(kind: &str, exported_at: u64) -> Manifest {
    Manifest {
        app: "vterm".to_string(),
        version: BACKUP_VERSION,
        kind: kind.to_string(),
        exported_at,
        sections: sections_for_kind(kind),
    }
}

/// Serialize the manifest to pretty JSON.
pub fn encode_manifest(m: &Manifest) -> AppResult<String> {
    serde_json::to_string_pretty(m)
        .map_err(|e| AppError::Message(format!("serialize manifest: {e}")))
}

/// Parse and validate a manifest. Rejects malformed JSON and future schema versions.
pub fn decode_manifest(bytes: &[u8]) -> AppResult<Manifest> {
    let m: Manifest = serde_json::from_slice(bytes)
        .map_err(|e| AppError::Message(format!("not a valid vterm backup manifest: {e}")))?;
    if m.version == 0 || m.version > BACKUP_VERSION {
        return Err(AppError::Message(format!(
            "unsupported backup version {} (this build understands up to {})",
            m.version, BACKUP_VERSION
        )));
    }
    Ok(m)
}

/// Reduce an archive's `recordings/<name>` entry to a safe `*.cast` file name,
/// defending against zip-slip / nested paths. `None` for directory entries,
/// non-`.cast` files, or anything with traversal segments.
pub fn safe_recording_name(entry: &str) -> Option<String> {
    let base = entry.rsplit(['/', '\\']).next().unwrap_or(entry);
    if base.is_empty() || base == ".." || base == "." || !base.ends_with(".cast") {
        return None;
    }
    Some(base.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub version: u32,
    /// Export time (epoch seconds); informational.
    #[serde(default)]
    pub exported_at: u64,
    /// App marker ("vterm"); informational.
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub servers: Vec<ServerProfile>,
    #[serde(default)]
    pub folders: Vec<String>,
    /// Opaque UI settings (frontend localStorage snapshot); backend doesn't
    /// interpret it.
    #[serde(default)]
    pub settings: Option<Value>,
}

/// Assemble a backup document from current state.
pub fn build(
    servers: Vec<ServerProfile>,
    folders: Vec<String>,
    settings: Option<Value>,
    exported_at: u64,
) -> Backup {
    Backup {
        version: BACKUP_VERSION,
        exported_at,
        app: "vterm".to_string(),
        servers,
        folders,
        settings,
    }
}

/// Serialize a backup to pretty JSON.
pub fn encode(backup: &Backup) -> AppResult<String> {
    serde_json::to_string_pretty(backup)
        .map_err(|e| AppError::Message(format!("serialize backup: {e}")))
}

/// Parse and validate a backup document. Rejects malformed JSON and unsupported
/// (future) schema versions.
pub fn decode(bytes: &[u8]) -> AppResult<Backup> {
    let backup: Backup = serde_json::from_slice(bytes)
        .map_err(|e| AppError::Message(format!("not a valid vterm backup: {e}")))?;
    if backup.version == 0 || backup.version > BACKUP_VERSION {
        return Err(AppError::Message(format!(
            "unsupported backup version {} (this build understands up to {})",
            backup.version, BACKUP_VERSION
        )));
    }
    Ok(backup)
}

/// Normalize the folder list restored from a backup: sorted and de-duplicated.
pub fn normalize_folders(mut folders: Vec<String>) -> Vec<String> {
    folders.sort();
    folders.dedup();
    folders
}

/// A backup archive held in memory.
pub type Archive = zip::ZipArchive<std::io::Cursor<Vec<u8>>>;

/// Open a `.zip` backup: the archive, its manifest and — when the manifest
/// declares servers or settings — the inner `backup.json`.
pub fn open_archive(bytes: Vec<u8>) -> AppResult<(Archive, Manifest, Option<Backup>)> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| AppError::Message(format!("open backup archive: {e}")))?;
    let mut read = |name: &str, missing: &str| -> AppResult<Vec<u8>> {
        let mut f = zip
            .by_name(name)
            .map_err(|_| AppError::Message(missing.into()))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| AppError::Message(format!("read {name}: {e}")))?;
        Ok(buf)
    };
    let manifest = decode_manifest(&read(MANIFEST_NAME, "not a vterm backup (no manifest)")?)?;
    let doc = if manifest.has(SECTION_SERVERS) || manifest.has(SECTION_SETTINGS) {
        Some(decode(&read(
            BACKUP_NAME,
            "backup archive missing backup.json",
        )?)?)
    } else {
        None
    };
    Ok((zip, manifest, doc))
}

/// The recordings an archive carries: (entry index, safe `*.cast` name).
pub fn recording_entries(zip: &mut Archive) -> AppResult<Vec<(usize, String)>> {
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let f = zip
            .by_index(i)
            .map_err(|e| AppError::Message(format!("read archive entry: {e}")))?;
        let name = f.name();
        if !name.starts_with(RECORDINGS_PREFIX) {
            continue;
        }
        if let Some(safe) = safe_recording_name(name) {
            out.push((i, safe));
        }
    }
    Ok(out)
}

/// What a backup holds, read without restoring anything (v1.20). The import
/// preview shows it; what is written — and how the servers are changed on the
/// way — the frontend decides (`backupimport.ts`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupContents {
    /// The backup's declared kind; "all" for a legacy JSON backup.
    pub kind: String,
    /// Server profiles; None when the backup has no servers section.
    pub servers: Option<Vec<ServerProfile>>,
    pub folders: Option<Vec<String>>,
    /// The backup carries a settings snapshot.
    pub settings: bool,
    /// How many recordings it carries; None when it has no recordings section.
    pub recordings: Option<usize>,
}

/// Read what a backup file (`.zip` archive or legacy JSON) holds.
pub fn read_contents(bytes: Vec<u8>) -> AppResult<BackupContents> {
    // Zip files start with the "PK" local-file-header magic.
    if !bytes.starts_with(b"PK") {
        let doc = decode(&bytes)?;
        return Ok(BackupContents {
            kind: KIND_ALL.to_string(),
            settings: doc.settings.is_some(),
            servers: Some(doc.servers),
            folders: Some(normalize_folders(doc.folders)),
            recordings: None,
        });
    }
    let (mut zip, manifest, doc) = open_archive(bytes)?;
    let recordings = if manifest.has(SECTION_RECORDINGS) {
        Some(recording_entries(&mut zip)?.len())
    } else {
        None
    };
    let settings =
        manifest.has(SECTION_SETTINGS) && doc.as_ref().is_some_and(|d| d.settings.is_some());
    let (servers, folders) = match doc {
        Some(d) if manifest.has(SECTION_SERVERS) => {
            (Some(d.servers), Some(normalize_folders(d.folders)))
        }
        _ => (None, None),
    };
    Ok(BackupContents {
        kind: manifest.kind,
        servers,
        folders,
        settings,
        recordings,
    })
}

/// What a backup at `path` holds — the import preview; nothing is written.
#[tauri::command]
pub fn read_backup(path: String) -> AppResult<BackupContents> {
    let bytes = std::fs::read(&path).map_err(|e| AppError::Message(format!("read {path}: {e}")))?;
    read_contents(bytes)
}

/// A server catalog to be written by an import: every profile has an id, and
/// no two share one — the keychain keeps secrets by id, so a repeated id would
/// hand one server's password to another.
pub fn check_catalog(servers: &[ServerProfile]) -> AppResult<()> {
    let mut seen = std::collections::HashSet::new();
    for s in servers {
        if s.id.trim().is_empty() {
            return Err(AppError::Message(
                "backup import: a server without an id".into(),
            ));
        }
        if !seen.insert(s.id.as_str()) {
            return Err(AppError::Message(format!(
                "backup import: server id {} appears twice",
                s.id
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AuthMethod;

    fn sample_server() -> ServerProfile {
        ServerProfile {
            id: "srv-1".into(),
            alias: "Web".into(),
            host: "10.0.0.1".into(),
            port: 22,
            username: "root".into(),
            auth_method: AuthMethod::Key,
            key_path: Some("/home/u/.ssh/id_ed25519".into()),
            has_saved_password: false,
            group: Some("Prod".into()),
            tags: vec!["web".into()],
            prod: None,
            auto_record: true,
            no_ai: false,
            chat_prompt_id: None,
            exec_mode: None,
            proxy: None,
            notes: String::new(),
            icon: String::new(),
            icon_color: String::new(),
        }
    }

    #[test]
    fn round_trip_preserves_servers_and_folders() {
        let backup = build(
            vec![sample_server()],
            vec!["Prod".into(), "Prod/EU".into()],
            Some(serde_json::json!({ "theme": "dracula", "fontSize": 14 })),
            1_700_000_000,
        );
        let json = encode(&backup).unwrap();
        // camelCase contract for the frontend.
        assert!(json.contains("\"exportedAt\""));
        assert!(json.contains("\"hasSavedPassword\""));

        let back = decode(json.as_bytes()).unwrap();
        assert_eq!(back.version, BACKUP_VERSION);
        assert_eq!(back.servers.len(), 1);
        assert_eq!(back.servers[0].alias, "Web");
        assert_eq!(back.folders, vec!["Prod", "Prod/EU"]);
        assert_eq!(back.settings.unwrap()["theme"], "dracula");
    }

    #[test]
    fn backup_never_contains_secret_fields() {
        // ServerProfile has no password/passphrase field, so a backup can't leak
        // one. Guard against that invariant regressing.
        let json = encode(&build(vec![sample_server()], vec![], None, 0)).unwrap();
        let lower = json.to_lowercase();
        assert!(!lower.contains("\"password\""));
        assert!(!lower.contains("passphrase"));
    }

    fn archive(manifest_kind: &str, doc: Option<&Backup>, casts: &[&str]) -> Vec<u8> {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file(MANIFEST_NAME, opts).unwrap();
        zip.write_all(
            encode_manifest(&build_manifest(manifest_kind, 0))
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        if let Some(doc) = doc {
            zip.start_file(BACKUP_NAME, opts).unwrap();
            zip.write_all(encode(doc).unwrap().as_bytes()).unwrap();
        }
        for name in casts {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(b"{}\n").unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn contents_of_a_full_archive_are_read_without_restoring() {
        let doc = build(
            vec![sample_server()],
            vec!["Prod".into(), "Dev".into(), "Prod".into()],
            Some(serde_json::json!({ "theme": "nord" })),
            0,
        );
        let bytes = archive(
            KIND_ALL,
            Some(&doc),
            &[
                "recordings/a.cast",
                "recordings/../evil.cast",
                "recordings/notes.txt",
            ],
        );
        let c = read_contents(bytes).unwrap();
        assert_eq!(c.kind, KIND_ALL);
        assert_eq!(c.servers.unwrap()[0].id, "srv-1");
        assert_eq!(c.folders.unwrap(), vec!["Dev", "Prod"]);
        assert!(c.settings);
        // Only entries that would be restored are counted.
        assert_eq!(c.recordings, Some(2));
    }

    #[test]
    fn contents_name_only_the_sections_an_archive_declares() {
        let doc = build(
            vec![sample_server()],
            vec![],
            Some(serde_json::json!({})),
            0,
        );
        let c = read_contents(archive(KIND_SETTINGS, Some(&doc), &[])).unwrap();
        assert!(c.servers.is_none() && c.folders.is_none() && c.recordings.is_none());
        assert!(c.settings);
        let c = read_contents(archive(KIND_RECORDINGS, None, &["recordings/x.cast"])).unwrap();
        assert!(c.servers.is_none() && !c.settings);
        assert_eq!(c.recordings, Some(1));
    }

    #[test]
    fn contents_of_a_legacy_json_backup_are_everything_but_recordings() {
        let json = encode(&build(vec![sample_server()], vec!["A".into()], None, 0)).unwrap();
        let c = read_contents(json.into_bytes()).unwrap();
        assert_eq!(c.kind, KIND_ALL);
        assert_eq!(c.servers.unwrap().len(), 1);
        assert!(!c.settings);
        assert!(c.recordings.is_none());
    }

    #[test]
    fn an_archive_without_its_document_is_refused() {
        assert!(read_contents(archive(KIND_ALL, None, &[])).is_err());
        assert!(read_contents(b"PK not a zip".to_vec()).is_err());
    }

    #[test]
    fn a_catalog_with_a_missing_or_repeated_id_is_refused() {
        let a = sample_server();
        let mut b = sample_server();
        b.id = "srv-2".into();
        assert!(check_catalog(&[a.clone(), b.clone()]).is_ok());
        assert!(check_catalog(&[a.clone(), a.clone()]).is_err());
        b.id = " ".into();
        assert!(check_catalog(&[a, b]).is_err());
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(decode(b"{ not json").is_err());
        assert!(decode(b"[]").is_err()); // not an object
    }

    #[test]
    fn decode_rejects_future_version() {
        let raw = serde_json::json!({ "version": 999, "servers": [], "folders": [] });
        let err = decode(raw.to_string().as_bytes()).unwrap_err();
        assert!(err.to_string().contains("unsupported backup version"));
    }

    #[test]
    fn decode_accepts_minimal_document() {
        // Only version + servers; folders/settings default.
        let raw = serde_json::json!({ "version": 1, "servers": [] });
        let b = decode(raw.to_string().as_bytes()).unwrap();
        assert!(b.servers.is_empty());
        assert!(b.folders.is_empty());
        assert!(b.settings.is_none());
    }

    #[test]
    fn normalize_folders_sorts_and_dedups() {
        let f = normalize_folders(vec!["B".into(), "A".into(), "B".into()]);
        assert_eq!(f, vec!["A", "B"]);
    }

    #[test]
    fn kind_maps_to_expected_sections() {
        assert_eq!(sections_for_kind(KIND_SERVERS), vec![SECTION_SERVERS]);
        assert_eq!(sections_for_kind(KIND_SETTINGS), vec![SECTION_SETTINGS]);
        assert_eq!(sections_for_kind(KIND_RECORDINGS), vec![SECTION_RECORDINGS]);
        assert_eq!(
            sections_for_kind(KIND_ALL),
            vec![SECTION_SERVERS, SECTION_SETTINGS, SECTION_RECORDINGS]
        );
        // Unknown kind → full backup.
        assert_eq!(
            sections_for_kind("???"),
            vec![SECTION_SERVERS, SECTION_SETTINGS, SECTION_RECORDINGS]
        );
    }

    #[test]
    fn manifest_round_trips_and_reports_sections() {
        let m = build_manifest(KIND_SERVERS, 1_700_000_000);
        let json = encode_manifest(&m).unwrap();
        assert!(json.contains("\"exportedAt\""));
        let back = decode_manifest(json.as_bytes()).unwrap();
        assert_eq!(back.app, "vterm");
        assert_eq!(back.kind, KIND_SERVERS);
        assert!(back.has(SECTION_SERVERS));
        assert!(!back.has(SECTION_SETTINGS));
        assert!(!back.has(SECTION_RECORDINGS));
    }

    #[test]
    fn decode_manifest_rejects_future_version() {
        let raw = serde_json::json!({ "app": "vterm", "version": 999, "kind": "all" });
        let err = decode_manifest(raw.to_string().as_bytes()).unwrap_err();
        assert!(err.to_string().contains("unsupported backup version"));
    }

    #[test]
    fn safe_recording_name_guards_against_zip_slip() {
        assert_eq!(
            safe_recording_name("recordings/web.cast").as_deref(),
            Some("web.cast")
        );
        assert_eq!(safe_recording_name("a/b/c.cast").as_deref(), Some("c.cast"));
        // Traversal, absolute paths, and non-cast entries are rejected.
        assert_eq!(safe_recording_name("../../etc/passwd"), None);
        assert_eq!(safe_recording_name("recordings/notes.txt"), None);
        assert_eq!(safe_recording_name("recordings/"), None);
        assert_eq!(
            safe_recording_name("..\\evil.cast").as_deref(),
            Some("evil.cast")
        );
    }
}
