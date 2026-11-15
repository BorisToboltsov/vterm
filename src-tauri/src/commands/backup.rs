// Backup commands of the bridge layer: export and import of the catalog and
// recordings (`backup.rs` holds the archive format).

use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use crate::model::ServerProfile;
use crate::{backup, now_secs, recording, scenarios, store, AppState};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Write a backup `.zip` archive to `path`. `kind` chooses which sections go in
/// ("servers" / "settings" / "recordings" / "all"); the archive always carries a
/// `manifest.json` identifying its contents. Secrets are never included (they
/// live in the keychain). `settings` is the frontend's opaque settings snapshot.
#[tauri::command]
pub fn export_backup(
    path: String,
    kind: String,
    settings: Option<serde_json::Value>,
    state: State<AppState>,
) -> AppResult<()> {
    use std::io::Write;
    let exported_at = now_secs();
    let manifest = backup::build_manifest(&kind, exported_at);

    let file = std::fs::File::create(&path)
        .map_err(|e| AppError::Message(format!("create {path}: {e}")))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let zip_err =
        |e: zip::result::ZipError| AppError::Message(format!("write backup archive: {e}"));

    // Identification document first.
    zip.start_file(backup::MANIFEST_NAME, opts)
        .map_err(zip_err)?;
    zip.write_all(backup::encode_manifest(&manifest)?.as_bytes())
        .map_err(|e| AppError::Message(format!("write manifest: {e}")))?;

    // servers/folders + settings travel in an inner backup.json (only the
    // selected sections are populated — a settings-only backup carries no servers).
    if manifest.has(backup::SECTION_SERVERS) || manifest.has(backup::SECTION_SETTINGS) {
        let servers = if manifest.has(backup::SECTION_SERVERS) {
            state.servers.locked().clone()
        } else {
            Vec::new()
        };
        let folders = if manifest.has(backup::SECTION_SERVERS) {
            backup::normalize_folders(state.folders.locked().clone())
        } else {
            Vec::new()
        };
        let settings = if manifest.has(backup::SECTION_SETTINGS) {
            settings
        } else {
            None
        };
        let doc = backup::build(servers, folders, settings, exported_at);
        zip.start_file(backup::BACKUP_NAME, opts).map_err(zip_err)?;
        zip.write_all(backup::encode(&doc)?.as_bytes())
            .map_err(|e| AppError::Message(format!("write backup.json: {e}")))?;
    }

    // Recordings are copied verbatim under recordings/.
    if manifest.has(backup::SECTION_RECORDINGS) {
        if let Some(dir) = recording::recordings_dir() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().is_none_or(|e| e != "cast") {
                        continue;
                    }
                    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                        continue;
                    };
                    let data = std::fs::read(&p)
                        .map_err(|e| AppError::Message(format!("read recording: {e}")))?;
                    zip.start_file(format!("{}{}", backup::RECORDINGS_PREFIX, name), opts)
                        .map_err(zip_err)?;
                    zip.write_all(&data)
                        .map_err(|e| AppError::Message(format!("write recording: {e}")))?;
                }
            }
        }
    }

    // The recipes of the app's own folder (ADR 0071) under scripts/; a source
    // folder the user added is theirs, and not copied.
    if manifest.has(backup::SECTION_SCRIPTS) {
        if let Some(dir) = scenarios::recipes_dir() {
            for f in scenarios::scan(&dir, &[]).files {
                zip.start_file(format!("{}{}", backup::SCRIPTS_PREFIX, f.name), opts)
                    .map_err(zip_err)?;
                zip.write_all(f.text.as_bytes())
                    .map_err(|e| AppError::Message(format!("write recipe: {e}")))?;
            }
        }
    }

    zip.finish().map_err(zip_err)?;
    Ok(())
}

/// Result of importing a backup. `servers`/`folders` count the catalog written
/// (`None` when none was), `recordings` the recordings extracted (`None` when
/// they were not asked for or the backup has none). `settings` is the backup's
/// UI snapshot — the frontend applies it only if it was chosen.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// The backup's declared kind ("servers" / "settings" / "recordings" / "all").
    kind: String,
    servers: Option<usize>,
    folders: Option<usize>,
    recordings: Option<usize>,
    /// Recipes written into the app's folder (`None` when not asked for or absent).
    scripts: Option<usize>,
    settings: Option<serde_json::Value>,
}

/// The server catalog an import writes (v1.20): the backup's profiles with
/// logins and key paths changed as the user asked, on their own or added to
/// the current ones — assembled by the frontend (`backupimport.ts`) from what
/// `read_backup` showed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCatalog {
    servers: Vec<ServerProfile>,
    folders: Vec<String>,
}

/// Restore a backup from `path` (a `.zip` archive or a legacy JSON document):
/// write `catalog` when given — the archive's own server list is not written
/// as is — and extract the recordings when `recordings` is set. Settings are
/// returned, not applied. Nothing is written before the catalog is checked.
#[tauri::command]
pub fn import_backup(
    path: String,
    catalog: Option<ImportCatalog>,
    recordings: bool,
    scripts: Option<bool>,
    state: State<AppState>,
) -> AppResult<ImportResult> {
    let bytes = std::fs::read(&path).map_err(|e| AppError::Message(format!("read {path}: {e}")))?;
    if let Some(c) = &catalog {
        backup::check_catalog(&c.servers)?;
    }
    let (kind, settings, mut archive, take) = if bytes.starts_with(b"PK") {
        let (zip, manifest, doc) = backup::open_archive(bytes)?;
        let settings = if manifest.has(backup::SECTION_SETTINGS) {
            doc.and_then(|d| d.settings)
        } else {
            None
        };
        let take = (
            recordings && manifest.has(backup::SECTION_RECORDINGS),
            scripts == Some(true) && manifest.has(backup::SECTION_SCRIPTS),
        );
        let zip = (take.0 || take.1).then_some(zip);
        (manifest.kind, settings, zip, take)
    } else {
        (
            backup::KIND_ALL.to_string(),
            backup::decode(&bytes)?.settings,
            None,
            (false, false),
        )
    };

    let mut result = ImportResult {
        kind,
        servers: None,
        folders: None,
        recordings: None,
        scripts: None,
        settings,
    };

    if let Some(c) = catalog {
        let folders = backup::normalize_folders(c.folders);
        store::save_servers(&c.servers)?;
        store::save_folders(&folders)?;
        result.servers = Some(c.servers.len());
        result.folders = Some(folders.len());
        *state.servers.locked() = c.servers;
        *state.folders.locked() = folders;
    }

    // Recordings: each recordings/*.cast goes into the recordings directory
    // under a collision-safe name (never overwrites an existing recording).
    if let Some(zip) = archive.as_mut() {
        if take.0 {
            result.recordings = Some(import_recordings(zip)?);
        }
        if take.1 {
            result.scripts = Some(import_scripts(zip)?);
        }
    }
    Ok(result)
}

/// Write an archive's recipes into the app's recipes folder — a recipe whose
/// name is taken there stays as it is (the one on this computer wins); the
/// number written.
fn import_scripts(zip: &mut backup::Archive) -> AppResult<usize> {
    use std::io::Read;
    let Some(dir) = scenarios::recipes_dir() else {
        return Ok(0);
    };
    let mut count = 0usize;
    for (index, name) in backup::script_entries(zip)? {
        let mut f = zip
            .by_index(index)
            .map_err(|e| AppError::Message(format!("read archive entry: {e}")))?;
        let mut text = String::new();
        if f.read_to_string(&mut text).is_err() {
            tracing::debug!(source = "storage", name = %name, "a recipe of the backup is not text and was skipped");
            continue;
        }
        match scenarios::save_in(&dir, &name, &text, false) {
            Ok(_) => count += 1,
            Err(AppError::DestinationExists) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(count)
}

/// Extract an archive's recordings; the number extracted.
fn import_recordings(zip: &mut backup::Archive) -> AppResult<usize> {
    use std::io::Read;
    let Some(dir) = recording::recordings_dir() else {
        return Ok(0);
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Message(format!("create recordings dir: {e}")))?;
    let mut count = 0usize;
    for (index, safe) in backup::recording_entries(zip)? {
        let mut f = zip
            .by_index(index)
            .map_err(|e| AppError::Message(format!("read archive entry: {e}")))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| AppError::Message(format!("read recording: {e}")))?;
        let dest = super::recording::unique_recording_path(&dir, &safe);
        std::fs::write(&dest, &buf)
            .map_err(|e| AppError::Message(format!("write recording: {e}")))?;
        count += 1;
    }
    Ok(count)
}
