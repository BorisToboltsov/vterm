mod backup;
mod error;
mod localfile;
mod model;
mod pty;
mod recording;
mod secrets;
mod servertools;
mod sftp;
mod ssh;
mod store;
mod sync;

use error::{AppError, AppResult};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use model::{AuthMethod, NewServerProfile, ServerProfile};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use sftp::FileEntry;
use ssh::{ConnectOptions, Credential, HostKeyPolicy, SshSession};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Per-session, per-device cumulative `(a, b)` counters + sample instant, used for
/// per-interface network and per-device disk throughput deltas.
type DevSampleStore = Mutex<HashMap<String, HashMap<String, (u64, u64, Instant)>>>;

/// Application state: persisted server profiles + the registry of live SSH sessions.
#[derive(Default)]
struct AppState {
    servers: Mutex<Vec<ServerProfile>>,
    /// Explicit folder paths (incl. empty/nested) for organizing the server list.
    folders: Mutex<Vec<String>>,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<SshSession>>>,
    /// Live local-shell PTYs (the "+" terminal tabs), keyed by session id.
    local_ptys: Mutex<HashMap<String, Arc<pty::LocalPty>>>,
    /// Cancellation flags for in-progress folder downloads, keyed by transfer id.
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Last `/proc/stat` (idle, total) jiffies per session, for CPU% deltas.
    cpu_samples: Mutex<HashMap<String, (u64, u64)>>,
    /// Last cumulative network (rx, tx) bytes + instant per session, for rate deltas.
    net_samples: Mutex<HashMap<String, (u64, u64, Instant)>>,
    /// Last cumulative disk (read, written) bytes + instant per session, for rates.
    disk_samples: Mutex<HashMap<String, (u64, u64, Instant)>>,
    /// Last per-core `/proc/stat` (idle, total) jiffies per session, for per-core CPU%.
    core_samples: Mutex<HashMap<String, Vec<(u64, u64)>>>,
    /// Last aggregate `/proc/stat` cpu jiffies per session, for the CPU breakdown.
    cpu_stat_samples: Mutex<HashMap<String, [u64; 8]>>,
    /// Per-interface network and per-device disk throughput sample stores.
    iface_samples: DevSampleStore,
    diskdev_samples: DevSampleStore,
    /// Last cumulative (ctxt, intr) counters + instant per session, for rate deltas.
    ctxintr_samples: Mutex<HashMap<String, (u64, u64, Instant)>>,
    /// Files vterm was asked to open (CLI args / macOS `Opened`), drained by the
    /// frontend on startup via `take_pending_opens`.
    pending_opens: Mutex<Vec<String>>,
    /// Per-session uid→name / gid→name maps (fetched once from passwd/group), so
    /// the SFTP listing can show owner names like `ls -l`.
    id_names: Mutex<HashMap<String, IdNames>>,
}

/// (uid→name, gid→name) maps resolved from passwd/group for one session.
type IdNames = (HashMap<u32, String>, HashMap<u32, String>);

/// Clone out the session for `session_id`, releasing the registry lock before
/// any network round-trip so other sessions aren't blocked.
async fn session_arc(state: &State<'_, AppState>, session_id: &str) -> AppResult<Arc<SshSession>> {
    state
        .sessions
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or(AppError::NoSession)
}

// ── Server-profile commands ───────────────────────────────────────────────────

#[tauri::command]
fn list_servers(state: State<AppState>) -> Vec<ServerProfile> {
    state.servers.lock().unwrap().clone()
}

#[tauri::command]
fn add_server(profile: NewServerProfile, state: State<AppState>) -> AppResult<ServerProfile> {
    let created = ServerProfile {
        id: uuid_like(),
        alias: profile.alias,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        auth_method: profile.auth_method,
        key_path: profile.key_path,
        has_saved_password: false,
        group: profile.group,
        tags: profile.tags,
        auto_record: profile.auto_record,
    };
    let snapshot = {
        let mut servers = state.servers.lock().unwrap();
        servers.push(created.clone());
        servers.clone()
    };
    store::save_servers(&snapshot)?;
    Ok(created)
}

#[tauri::command]
fn update_server(
    id: String,
    profile: NewServerProfile,
    state: State<AppState>,
) -> AppResult<ServerProfile> {
    let snapshot = {
        let mut servers = state.servers.lock().unwrap();
        match servers.iter_mut().find(|s| s.id == id) {
            Some(server) => {
                server.alias = profile.alias;
                server.host = profile.host;
                server.port = profile.port;
                server.username = profile.username;
                server.auth_method = profile.auth_method;
                server.key_path = profile.key_path;
                server.group = profile.group;
                server.tags = profile.tags;
                server.auto_record = profile.auto_record;
            }
            None => return Err(AppError::UnknownServer),
        }
        servers.clone()
    };
    store::save_servers(&snapshot)?;
    snapshot
        .into_iter()
        .find(|s| s.id == id)
        .ok_or(AppError::UnknownServer)
}

#[tauri::command]
async fn delete_server(id: String, state: State<'_, AppState>) -> AppResult<()> {
    let snapshot = {
        let mut servers = state.servers.lock().unwrap();
        servers.retain(|s| s.id != id);
        servers.clone()
    };
    store::save_servers(&snapshot)?;
    let _ = secrets::delete_all(&id);
    // Drop any live session for this server (Drop closes the connection).
    state.sessions.lock().await.remove(&id);
    Ok(())
}

/// Forget any stored password/passphrase for a server.
#[tauri::command]
fn forget_secrets(id: String, state: State<AppState>) -> AppResult<()> {
    secrets::delete_all(&id)?;
    let snapshot = {
        let mut servers = state.servers.lock().unwrap();
        if let Some(p) = servers.iter_mut().find(|p| p.id == id) {
            p.has_saved_password = false;
        }
        servers.clone()
    };
    store::save_servers(&snapshot)
}

// ── Folder commands ─────────────────────────────────────────────────────────

/// Normalize a folder path: trim, collapse repeated/edge slashes, drop blanks.
fn normalize_path(path: &str) -> String {
    path.split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

#[tauri::command]
fn list_folders(state: State<AppState>) -> Vec<String> {
    let mut folders = state.folders.lock().unwrap().clone();
    folders.sort();
    folders
}

/// Create a folder (and implicitly any missing ancestors).
#[tauri::command]
fn add_folder(path: String, state: State<AppState>) -> AppResult<Vec<String>> {
    let path = normalize_path(&path);
    if path.is_empty() {
        return Err(AppError::Message("empty folder name".to_string()));
    }
    let snapshot = {
        let mut folders = state.folders.lock().unwrap();
        // Insert the path plus every ancestor so the tree is always well-formed.
        let mut acc = String::new();
        for seg in path.split('/') {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            if !folders.contains(&acc) {
                folders.push(acc.clone());
            }
        }
        folders.clone()
    };
    store::save_folders(&snapshot)?;
    let mut sorted = snapshot;
    sorted.sort();
    Ok(sorted)
}

/// Delete a folder and its descendants; servers inside are moved to the root.
#[tauri::command]
fn delete_folder(path: String, state: State<AppState>) -> AppResult<()> {
    let path = normalize_path(&path);
    if path.is_empty() {
        return Ok(());
    }
    let prefix = format!("{path}/");
    let folders_snapshot = {
        let mut folders = state.folders.lock().unwrap();
        folders.retain(|f| f != &path && !f.starts_with(&prefix));
        folders.clone()
    };
    store::save_folders(&folders_snapshot)?;

    // Detach any servers that lived in the removed subtree.
    let servers_snapshot = {
        let mut servers = state.servers.lock().unwrap();
        for s in servers.iter_mut() {
            if let Some(g) = &s.group {
                if g == &path || g.starts_with(&prefix) {
                    s.group = None;
                }
            }
        }
        servers.clone()
    };
    store::save_servers(&servers_snapshot)
}

/// Rewrite a single folder path / server group `value` when `old_path` (or its
/// subtree) is moved/renamed to `new_path`. Paths outside that subtree are left
/// unchanged. Pure (no state) so it can be unit-tested in isolation.
fn reprefixed(value: &str, old_path: &str, new_path: &str) -> String {
    if value == old_path {
        new_path.to_string()
    } else if let Some(rest) = value.strip_prefix(&format!("{old_path}/")) {
        format!("{new_path}/{rest}")
    } else {
        value.to_string()
    }
}

/// Rewrite `old_path` (and its whole subtree) to `new_path` across folders and
/// server groups, then persist both. No-op when the path is unchanged.
fn reprefix_folder(state: &State<AppState>, old_path: &str, new_path: &str) -> AppResult<()> {
    if new_path == old_path {
        return Ok(());
    }

    let folders_snapshot = {
        let mut folders = state.folders.lock().unwrap();
        for f in folders.iter_mut() {
            *f = reprefixed(f, old_path, new_path);
        }
        folders.sort();
        folders.dedup();
        folders.clone()
    };
    store::save_folders(&folders_snapshot)?;

    let servers_snapshot = {
        let mut servers = state.servers.lock().unwrap();
        for s in servers.iter_mut() {
            if let Some(g) = &s.group {
                s.group = Some(reprefixed(g, old_path, new_path));
            }
        }
        servers.clone()
    };
    store::save_servers(&servers_snapshot)
}

/// Move a folder (and its whole subtree) under `new_parent` (None/empty = root).
#[tauri::command]
fn move_folder(path: String, new_parent: Option<String>, state: State<AppState>) -> AppResult<()> {
    let path = normalize_path(&path);
    if path.is_empty() {
        return Err(AppError::Message("invalid folder".to_string()));
    }
    let new_parent = new_parent.map(|p| normalize_path(&p)).unwrap_or_default();
    // Can't move a folder into itself or into one of its own descendants.
    if new_parent == path || new_parent.starts_with(&format!("{path}/")) {
        return Err(AppError::Message(
            "cannot move a folder into itself".to_string(),
        ));
    }
    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
    let new_path = if new_parent.is_empty() {
        name
    } else {
        format!("{new_parent}/{name}")
    };
    reprefix_folder(&state, &path, &new_path)
}

/// Rename a folder in place (keeps its parent), renaming its whole subtree.
#[tauri::command]
fn rename_folder(path: String, new_name: String, state: State<AppState>) -> AppResult<()> {
    let path = normalize_path(&path);
    if path.is_empty() {
        return Err(AppError::Message("invalid folder".to_string()));
    }
    let new_name = normalize_path(&new_name);
    if new_name.is_empty() {
        return Err(AppError::Message("empty folder name".to_string()));
    }
    let parent = match path.rsplit_once('/') {
        Some((p, _)) => p.to_string(),
        None => String::new(),
    };
    let new_path = if parent.is_empty() {
        new_name
    } else {
        format!("{parent}/{new_name}")
    };
    // Guard against renaming into the folder's own subtree.
    if new_path == path || new_path.starts_with(&format!("{path}/")) {
        return Err(AppError::Message("invalid new name".to_string()));
    }
    reprefix_folder(&state, &path, &new_path)
}

/// Move a server into a folder (or to the root when `group` is None/empty).
#[tauri::command]
fn set_server_group(
    id: String,
    group: Option<String>,
    state: State<AppState>,
) -> AppResult<ServerProfile> {
    let group = group.map(|g| normalize_path(&g)).filter(|g| !g.is_empty());
    let snapshot = {
        let mut servers = state.servers.lock().unwrap();
        match servers.iter_mut().find(|s| s.id == id) {
            Some(server) => server.group = group,
            None => return Err(AppError::UnknownServer),
        }
        servers.clone()
    };
    store::save_servers(&snapshot)?;
    snapshot
        .into_iter()
        .find(|s| s.id == id)
        .ok_or(AppError::UnknownServer)
}

// ── Backup (export/import) ─────────────────────────────────────────────────────

/// Current unix time in seconds (0 if the clock predates the epoch).
fn now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Write a backup `.zip` archive to `path`. `kind` chooses which sections go in
/// ("servers" / "settings" / "recordings" / "all"); the archive always carries a
/// `manifest.json` identifying its contents. Secrets are never included (they
/// live in the keychain). `settings` is the frontend's opaque settings snapshot.
#[tauri::command]
fn export_backup(
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
            state.servers.lock().unwrap().clone()
        } else {
            Vec::new()
        };
        let folders = if manifest.has(backup::SECTION_SERVERS) {
            backup::normalize_folders(state.folders.lock().unwrap().clone())
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

    zip.finish().map_err(zip_err)?;
    Ok(())
}

/// Result of importing a backup. Each section count is `None` when the backup
/// didn't include that section (so the frontend reports only what was restored
/// and leaves the rest untouched). `settings` is the opaque UI snapshot to apply.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    /// The backup's declared kind ("servers" / "settings" / "recordings" / "all").
    kind: String,
    servers: Option<usize>,
    folders: Option<usize>,
    recordings: Option<usize>,
    settings: Option<serde_json::Value>,
}

/// Restore a backup from `path`. Auto-detects the format: a `.zip` archive
/// (current) restores exactly the sections its manifest declares; a bare JSON
/// document (legacy) is treated as a full servers+folders+settings backup.
#[tauri::command]
fn import_backup(path: String, state: State<AppState>) -> AppResult<ImportResult> {
    let bytes = std::fs::read(&path).map_err(|e| AppError::Message(format!("read {path}: {e}")))?;
    // Zip files start with the "PK" local-file-header magic.
    if bytes.starts_with(b"PK") {
        import_archive(bytes, &state)
    } else {
        import_legacy_json(&bytes, &state)
    }
}

/// Restore from a `.zip` backup archive, honouring the manifest's section list.
fn import_archive(bytes: Vec<u8>, state: &State<AppState>) -> AppResult<ImportResult> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| AppError::Message(format!("open backup archive: {e}")))?;

    let manifest = {
        let mut f = zip
            .by_name(backup::MANIFEST_NAME)
            .map_err(|_| AppError::Message("not a vterm backup (no manifest)".into()))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| AppError::Message(format!("read manifest: {e}")))?;
        backup::decode_manifest(&buf)?
    };

    let mut result = ImportResult {
        kind: manifest.kind.clone(),
        servers: None,
        folders: None,
        recordings: None,
        settings: None,
    };

    // Inner backup.json: restore only the sections the manifest declares.
    if manifest.has(backup::SECTION_SERVERS) || manifest.has(backup::SECTION_SETTINGS) {
        let doc = {
            let mut f = zip
                .by_name(backup::BACKUP_NAME)
                .map_err(|_| AppError::Message("backup archive missing backup.json".into()))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)
                .map_err(|e| AppError::Message(format!("read backup.json: {e}")))?;
            backup::decode(&buf)?
        };
        if manifest.has(backup::SECTION_SERVERS) {
            let servers = doc.servers;
            let folders = backup::normalize_folders(doc.folders);
            store::save_servers(&servers)?;
            store::save_folders(&folders)?;
            result.servers = Some(servers.len());
            result.folders = Some(folders.len());
            *state.servers.lock().unwrap() = servers;
            *state.folders.lock().unwrap() = folders;
        }
        if manifest.has(backup::SECTION_SETTINGS) {
            result.settings = doc.settings;
        }
    }

    // Recordings: extract each recordings/*.cast into the recordings directory
    // under a collision-safe name (never overwrites an existing recording).
    if manifest.has(backup::SECTION_RECORDINGS) {
        let mut count = 0usize;
        if let Some(dir) = recording::recordings_dir() {
            std::fs::create_dir_all(&dir)
                .map_err(|e| AppError::Message(format!("create recordings dir: {e}")))?;
            for i in 0..zip.len() {
                let mut f = zip
                    .by_index(i)
                    .map_err(|e| AppError::Message(format!("read archive entry: {e}")))?;
                let entry_name = f.name().to_string();
                if !entry_name.starts_with(backup::RECORDINGS_PREFIX) {
                    continue;
                }
                let Some(safe) = backup::safe_recording_name(&entry_name) else {
                    continue;
                };
                let mut buf = Vec::new();
                f.read_to_end(&mut buf)
                    .map_err(|e| AppError::Message(format!("read recording: {e}")))?;
                let dest = unique_recording_path(&dir, &safe);
                std::fs::write(&dest, &buf)
                    .map_err(|e| AppError::Message(format!("write recording: {e}")))?;
                count += 1;
            }
        }
        result.recordings = Some(count);
    }

    Ok(result)
}

/// Restore a legacy single-JSON backup (servers + folders + settings).
fn import_legacy_json(bytes: &[u8], state: &State<AppState>) -> AppResult<ImportResult> {
    let doc = backup::decode(bytes)?;
    let servers = doc.servers;
    let folders = backup::normalize_folders(doc.folders);
    store::save_servers(&servers)?;
    store::save_folders(&folders)?;

    let result = ImportResult {
        kind: backup::KIND_ALL.to_string(),
        servers: Some(servers.len()),
        folders: Some(folders.len()),
        recordings: None,
        settings: doc.settings,
    };
    *state.servers.lock().unwrap() = servers;
    *state.folders.lock().unwrap() = folders;
    Ok(result)
}

// ── SSH session commands ──────────────────────────────────────────────────────

/// Tells the frontend whether it must prompt for a secret before connecting.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectPlan {
    needs_secret: bool,
    secret_label: String,
}

#[tauri::command]
fn connect_plan(id: String, state: State<AppState>) -> AppResult<ConnectPlan> {
    let profile = state
        .servers
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or(AppError::UnknownServer)?;

    let plan = match profile.auth_method {
        AuthMethod::Password => ConnectPlan {
            needs_secret: secrets::get_password(&id).is_none(),
            secret_label: "Password".to_string(),
        },
        AuthMethod::Key => {
            // Resolve the same way connect_session will (explicit path, else a
            // default in ~/.ssh) so we prompt for a passphrase iff that key needs one.
            let needs = match ssh::resolve_key_path(profile.key_path.as_deref()) {
                Some(path) => {
                    ssh::key_is_encrypted(&path) && secrets::get_passphrase(&id).is_none()
                }
                None => false,
            };
            ConnectPlan {
                needs_secret: needs,
                secret_label: "Passphrase".to_string(),
            }
        }
    };
    Ok(plan)
}

/// Open an SSH session for `server_id`, registered under the per-tab `session_id`.
/// `secret` is the password or key passphrase if the user just typed it; when
/// absent it is read from the keychain. `remember` stores `secret` in the keychain.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn connect_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    server_id: String,
    secret: Option<String>,
    remember: bool,
    cols: u32,
    rows: u32,
    term_type: Option<String>,
    connect_timeout: Option<u64>,
    keepalive_interval: Option<u64>,
    host_key_policy: Option<String>,
) -> AppResult<()> {
    let profile = {
        let servers = state.servers.lock().unwrap();
        servers.iter().find(|s| s.id == server_id).cloned()
    }
    .ok_or(AppError::UnknownServer)?;

    // Wrap the just-typed secret so vterm's own in-memory copy is wiped on drop.
    let secret = secret.map(zeroize::Zeroizing::new);

    let cred = match profile.auth_method {
        AuthMethod::Password => {
            let password = secret
                .clone()
                .or_else(|| secrets::get_password(&server_id))
                .ok_or_else(|| "password required".to_string())?;
            Credential::Password(password)
        }
        AuthMethod::Key => {
            // No explicit key path → fall back to a default key in ~/.ssh/.
            let path = ssh::resolve_key_path(profile.key_path.as_deref()).ok_or_else(|| {
                "no SSH key set and none found in ~/.ssh — pick a private key file".to_string()
            })?;
            let passphrase = secret
                .clone()
                .or_else(|| secrets::get_passphrase(&server_id));
            Credential::Key { path, passphrase }
        }
    };

    // Replace any existing session with the same session id.
    state.sessions.lock().await.remove(&session_id);

    let opts = ConnectOptions {
        term_type: term_type.unwrap_or_else(|| "xterm-256color".to_string()),
        connect_timeout: Duration::from_secs(connect_timeout.unwrap_or(10).max(1)),
        keepalive_interval: Duration::from_secs(keepalive_interval.unwrap_or(15).max(1)),
        host_key_policy: host_key_policy
            .as_deref()
            .map(HostKeyPolicy::from_str)
            .unwrap_or(HostKeyPolicy::TofuReject),
    };

    let session = ssh::connect(
        app,
        session_id.clone(),
        &profile.host,
        profile.port,
        &profile.username,
        cred,
        cols,
        rows,
        opts,
    )
    .await?;

    // Persist the secret only after authentication succeeded (so a wrong typed
    // secret is never written to the keychain).
    if remember {
        if let Some(s) = &secret {
            match profile.auth_method {
                AuthMethod::Password => {
                    secrets::set_password(&server_id, s)?;
                    let snapshot = {
                        let mut servers = state.servers.lock().unwrap();
                        if let Some(p) = servers.iter_mut().find(|p| p.id == server_id) {
                            p.has_saved_password = true;
                        }
                        servers.clone()
                    };
                    store::save_servers(&snapshot)?;
                }
                AuthMethod::Key => secrets::set_passphrase(&server_id, s)?,
            }
        }
    }

    state
        .sessions
        .lock()
        .await
        .insert(session_id, Arc::new(session));
    Ok(())
}

/// Open a local-shell terminal (PTY on the machine running vterm) under the
/// per-tab `session_id`. Output/close events reuse the `term://…` channels, so
/// the frontend terminal widget drives it exactly like an SSH session.
#[tauri::command]
async fn open_local_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    // Replace any existing session registered under this id.
    state.sessions.lock().await.remove(&session_id);
    state.local_ptys.lock().unwrap().remove(&session_id);

    let local = pty::open_local(app, session_id.clone(), cols, rows)?;
    state
        .local_ptys
        .lock()
        .unwrap()
        .insert(session_id, Arc::new(local));
    Ok(())
}

#[tauri::command]
async fn write_to_terminal(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> AppResult<()> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        return session.write_input(data).await;
    }
    let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
    match local {
        Some(pty) => pty.write_input(data),
        None => Err(AppError::NoSession),
    }
}

#[tauri::command]
async fn resize_pty(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        session.resize(cols, rows).await?;
        return Ok(());
    }
    let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
    if let Some(pty) = local {
        pty.resize(cols, rows)?;
    }
    Ok(())
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state.sessions.lock().await.remove(&session_id);
    // Removing the LocalPty drops it, which kills the child shell.
    state.local_ptys.lock().unwrap().remove(&session_id);
    state.cpu_samples.lock().unwrap().remove(&session_id);
    state.core_samples.lock().unwrap().remove(&session_id);
    state.cpu_stat_samples.lock().unwrap().remove(&session_id);
    state.iface_samples.lock().unwrap().remove(&session_id);
    state.diskdev_samples.lock().unwrap().remove(&session_id);
    state.ctxintr_samples.lock().unwrap().remove(&session_id);
    state.id_names.lock().unwrap().remove(&session_id);
    Ok(())
}

/// Per-session uid→name / gid→name maps (fetched once from passwd/group and
/// cached) so the SFTP listing can show owner names. Returns empty maps if the
/// lookup fails (the frontend then falls back to numeric uid/gid).
async fn ensure_id_names(state: &State<'_, AppState>, session_id: &str) -> IdNames {
    if let Some(cached) = state.id_names.lock().unwrap().get(session_id) {
        return cached.clone();
    }
    let maps = match session_arc(state, session_id).await {
        Ok(session) => {
            let out = session
                .run_command(
                    "getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null; \
                     echo '@@VTERM@@'; \
                     getent group 2>/dev/null || cat /etc/group 2>/dev/null",
                )
                .await
                .unwrap_or_default();
            let (p, g) = out.split_once("@@VTERM@@").unwrap_or((out.as_str(), ""));
            (sftp::parse_id_names(p), sftp::parse_id_names(g))
        }
        Err(_) => (HashMap::new(), HashMap::new()),
    };
    state
        .id_names
        .lock()
        .unwrap()
        .insert(session_id.to_string(), maps.clone());
    maps
}

// ── Session recording (asciicast v2) ───────────────────────────────────────────

/// Metadata about a stored recording, read from its asciicast header + file stat.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingMeta {
    path: String,
    title: String,
    description: String,
    server: String,
    width: u32,
    height: u32,
    timestamp: u64,
    size: u64,
}

/// True if `path` is a `.cast` file directly inside the recordings directory
/// (guards `read`/`delete` against arbitrary filesystem access).
fn is_recording_path(path: &std::path::Path) -> bool {
    let Some(dir) = recording::recordings_dir() else {
        return false;
    };
    path.extension().is_some_and(|e| e == "cast") && path.parent() == Some(dir.as_path())
}

/// A free `.cast` path for `name` inside `dir`: returns `dir/name`, or appends
/// `-1`, `-2`, … before the extension if a file with that name already exists.
/// Used by both backup restore and the "upload recording" import so neither ever
/// clobbers an existing recording.
fn unique_recording_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let stem = name.strip_suffix(".cast").unwrap_or(name);
    for n in 1.. {
        let candidate = dir.join(format!("{stem}-{n}.cast"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("ran out of recording name suffixes")
}

/// Read a stored recording's metadata (asciicast header + file size) at `path`.
fn meta_for_path(path: &std::path::Path) -> RecordingMeta {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let header = std::fs::read_to_string(path)
        .ok()
        .and_then(|c| c.lines().next().map(str::to_owned))
        .and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok())
        .unwrap_or(serde_json::Value::Null);
    let title = header["title"].as_str().unwrap_or("").to_owned();
    RecordingMeta {
        path: path.to_string_lossy().into_owned(),
        // Older recordings have no `server` field → fall back to the title.
        server: header["server"].as_str().unwrap_or(&title).to_owned(),
        title,
        description: header["description"].as_str().unwrap_or("").to_owned(),
        width: header["width"].as_u64().unwrap_or(80) as u32,
        height: header["height"].as_u64().unwrap_or(24) as u32,
        timestamp: header["timestamp"].as_u64().unwrap_or(0),
        size,
    }
}

/// Start recording the given session to a new asciicast file; returns its path.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command params arrive by name from JS
async fn start_recording(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    cols: u32,
    rows: u32,
    prompt: String,
    env: String,
    mask_passwords: bool,
    mode: String,
) -> AppResult<String> {
    let dir = recording::recordings_dir().ok_or_else(|| "no recordings directory".to_string())?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!(
        "{}-{}.cast",
        recording::sanitize_title(&title),
        millis
    ));

    let is_ssh = session_arc(&state, &session_id).await.is_ok();
    let local = if is_ssh {
        None
    } else {
        state.local_ptys.lock().unwrap().get(&session_id).cloned()
    };
    if !is_ssh && local.is_none() {
        return Err(AppError::NoSession);
    }

    let rec = recording::Recorder::start(
        path.clone(),
        cols,
        rows,
        &title,
        &prompt,
        &env,
        mask_passwords,
        recording::RecordMode::parse(&mode),
    )?;
    if is_ssh {
        session_arc(&state, &session_id).await?.begin_recording(rec);
    } else if let Some(pty) = local {
        pty.begin_recording(rec);
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Stop recording the given session; returns the file path if one was active.
#[tauri::command]
async fn stop_recording(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Option<String>> {
    let path = if let Ok(session) = session_arc(&state, &session_id).await {
        session.end_recording()
    } else {
        let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
        local.and_then(|p| p.end_recording())
    };
    // Stamp the wall-clock end time into the header now that recording has stopped.
    if let Some(p) = &path {
        if let Ok(content) = std::fs::read_to_string(p) {
            let ended = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if let Some(updated) = recording::with_ended_at(&content, ended) {
                let _ = std::fs::write(p, updated);
            }
        }
    }
    Ok(path.map(|p| p.to_string_lossy().into_owned()))
}

/// Pause or resume the active recording on a session (tab switched away / idle).
#[tauri::command]
async fn set_recording_paused(
    state: State<'_, AppState>,
    session_id: String,
    paused: bool,
) -> AppResult<()> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        session.set_recording_paused(paused);
    } else {
        let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
        if let Some(pty) = local {
            pty.set_recording_paused(paused);
        }
    }
    Ok(())
}

/// Write an audit annotation (e.g. "edited /etc/nginx.conf") into the session's
/// active recording. No-op if the session isn't recording.
#[tauri::command]
async fn annotate_recording(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> AppResult<()> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        session.annotate_recording(&text);
    } else {
        let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
        if let Some(pty) = local {
            pty.annotate_recording(&text);
        }
    }
    Ok(())
}

/// List stored recordings (newest first), reading metadata from each header.
#[tauri::command]
fn list_recordings() -> AppResult<Vec<RecordingMeta>> {
    let Some(dir) = recording::recordings_dir() else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(vec![]); // dir not created yet
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "cast") {
            continue;
        }
        out.push(meta_for_path(&path));
    }
    out.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
    Ok(out)
}

/// Import (upload) an external recording into the library by copying it into the
/// recordings directory under a collision-safe name. Validates that the file is
/// an **asciicast v2** recording (a JSON header line with `version: 2`) so the
/// player — which expects the full raw `.cast` stream — can replay it. Returns
/// the new recording's metadata so the frontend can refresh its list.
#[tauri::command]
fn import_recording(src_path: String) -> AppResult<RecordingMeta> {
    let dir = recording::recordings_dir().ok_or_else(|| "no recordings directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create recordings dir: {e}"))?;

    let content =
        std::fs::read_to_string(&src_path).map_err(|e| format!("read {src_path}: {e}"))?;
    // The first line must be a valid asciicast v2 header object.
    let first = content.lines().next().unwrap_or("").trim();
    let header: serde_json::Value = serde_json::from_str(first)
        .map_err(|_| AppError::Message("not an asciicast recording (bad header)".into()))?;
    if header.get("version").and_then(serde_json::Value::as_u64) != Some(2) {
        return Err(AppError::Message(
            "unsupported recording — expected an asciicast v2 (.cast) file".into(),
        ));
    }

    let base = std::path::Path::new(&src_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("imported.cast");
    let name = if base.ends_with(".cast") {
        base.to_string()
    } else {
        format!("{base}.cast")
    };
    let dest = unique_recording_path(&dir, &name);
    std::fs::write(&dest, content.as_bytes()).map_err(|e| format!("write recording: {e}"))?;
    Ok(meta_for_path(&dest))
}

/// Delete a stored recording (only within the recordings directory).
#[tauri::command]
fn delete_recording(path: String) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !is_recording_path(&p) {
        return Err(AppError::Message("not a recording".into()));
    }
    std::fs::remove_file(&p).map_err(|e| format!("delete recording: {e}"))?;
    Ok(())
}

/// Set a recording's title and description (rewrites the asciicast header in
/// place). Used by the "name this recording" prompt shown after stopping.
#[tauri::command]
fn set_recording_meta(path: String, title: String, description: String) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !is_recording_path(&p) {
        return Err(AppError::Message("not a recording".into()));
    }
    let content = std::fs::read_to_string(&p).map_err(|e| format!("read recording: {e}"))?;
    let updated = recording::with_updated_meta(&content, &title, &description)
        .ok_or_else(|| AppError::Message("invalid recording header".into()))?;
    std::fs::write(&p, updated).map_err(|e| format!("write recording: {e}"))?;
    Ok(())
}

/// Read a recording's raw asciicast content (for the AI transcript export / player).
#[tauri::command]
fn read_recording(path: String) -> AppResult<String> {
    let p = std::path::PathBuf::from(&path);
    if !is_recording_path(&p) {
        return Err(AppError::Message("not a recording".into()));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("read recording: {e}").into())
}

/// Write exported text (a transcript or a copied .cast) to a user-chosen path.
/// The destination comes from a native save dialog, so the user intends it.
#[tauri::command]
fn export_recording(path: String, content: String) -> AppResult<()> {
    std::fs::write(&path, content).map_err(|e| format!("export recording: {e}").into())
}

// ── Remote metrics (bottom status bar) ─────────────────────────────────────────

/// One lightweight, portable shell snippet that prints `key=value` lines. Every
/// field is guarded so a missing tool/file just yields an empty value (which the
/// UI renders as a dash) rather than failing the whole probe.
const METRICS_SCRIPT: &str = "\
printf 'os=%s\\n' \"$(uname -s 2>/dev/null)\"; \
printf 'host=%s\\n' \"$(hostname 2>/dev/null)\"; \
printf 'user=%s\\n' \"$(id -un 2>/dev/null || whoami 2>/dev/null)\"; \
printf 'pretty=%s\\n' \"$( ( . /etc/os-release 2>/dev/null && printf %s \"$PRETTY_NAME\" ) || ( sw_vers -productName 2>/dev/null | tr -d '\\n' ) )\"; \
printf 'load=%s\\n' \"$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)\"; \
printf 'mem=%s\\n' \"$(awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{if(t>0)printf \"%d %d\",(t-a)*1024,t*1024}' /proc/meminfo 2>/dev/null)\"; \
printf 'disk=%s\\n' \"$(df -kP / 2>/dev/null | awk 'NR==2{printf \"%d %d\",$3*1024,$2*1024}')\"; \
printf 'cpustat=%s\\n' \"$(grep '^cpu ' /proc/stat 2>/dev/null | head -1 | sed 's/^cpu *//')\"; \
printf 'net=%s\\n' \"$(awk 'NR>2{sub(/:/,\"\",$1); if($1!=\"lo\"){rx+=$2; tx+=$10}} END{printf \"%d %d\",rx,tx}' /proc/net/dev 2>/dev/null)\"; \
printf 'uptime=%s\\n' \"$(cut -d. -f1 /proc/uptime 2>/dev/null)\"; \
printf 'swap=%s\\n' \"$(awk '/SwapTotal/{t=$2}/SwapFree/{f=$2}END{if(t>0)printf \"%d %d\",(t-f)*1024,t*1024}' /proc/meminfo 2>/dev/null)\"; \
printf 'diskio=%s\\n' \"$(awk '$3 ~ /^(sd|nvme|vd|xvd|hd)[a-z0-9]*$/ {r+=$6; w+=$10} END{printf \"%d %d\",r*512,w*512}' /proc/diskstats 2>/dev/null)\"; \
printf 'users=%s\\n' \"$(who 2>/dev/null | awk '{print $1}' | sort -u | tr '\\n' ' ')\"; \
printf 'ip=%s\\n' \"$(hostname -I 2>/dev/null | awk '{print $1}')\"; \
printf 'topproc=%s\\n' \"$(ps -eo pcpu=,comm= 2>/dev/null | sort -rn | head -3 | awk '{printf \"%s %d%%, \",$2,$1}' | sed 's/, $//')\"; \
printf 'cputemp=%s\\n' \"$(awk '{printf \"%.0f\",$1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null)\"; \
printf 'netconns=%s\\n' \"$(ss -tH state established 2>/dev/null | wc -l | tr -d ' ')\"; \
printf 'kernel=%s\\n' \"$(uname -r 2>/dev/null)\"; \
printf 'stime=%s\\n' \"$(date '+%H:%M %Z' 2>/dev/null)\"";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    os: String,
    pretty_name: String,
    hostname: String,
    user: String,
    load1: Option<f64>,
    load5: Option<f64>,
    load15: Option<f64>,
    /// CPU utilization 0–100, computed from a `/proc/stat` delta between polls.
    cpu_pct: Option<f64>,
    mem_used: Option<u64>,
    mem_total: Option<u64>,
    disk_used: Option<u64>,
    disk_total: Option<u64>,
    /// Network throughput in bytes/sec, from a `/proc/net/dev` delta between polls.
    net_rx_rate: Option<u64>,
    net_tx_rate: Option<u64>,
    /// Disk I/O in bytes/sec, from a `/proc/diskstats` delta between polls.
    disk_read_rate: Option<u64>,
    disk_write_rate: Option<u64>,
    uptime_secs: Option<u64>,
    swap_used: Option<u64>,
    swap_total: Option<u64>,
    /// Space-separated logged-in usernames (count derived on the frontend).
    users: String,
    ip: String,
    /// Top CPU process as "name NN%".
    top_proc: String,
    cpu_temp: Option<f64>,
    net_conns: Option<u64>,
    kernel: String,
    /// Remote clock + timezone, e.g. "14:05 UTC".
    server_time: String,
}

fn parse_metrics(raw: &str) -> Metrics {
    let mut m = Metrics::default();
    for line in raw.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key {
            "os" => m.os = value.to_string(),
            "pretty" => m.pretty_name = value.to_string(),
            "host" => m.hostname = value.to_string(),
            "user" => m.user = value.to_string(),
            "load" => {
                let mut it = value.split_whitespace();
                m.load1 = it.next().and_then(|v| v.parse().ok());
                m.load5 = it.next().and_then(|v| v.parse().ok());
                m.load15 = it.next().and_then(|v| v.parse().ok());
            }
            "mem" => {
                let mut it = value.split_whitespace();
                m.mem_used = it.next().and_then(|v| v.parse().ok());
                m.mem_total = it.next().and_then(|v| v.parse().ok());
            }
            "disk" => {
                let mut it = value.split_whitespace();
                m.disk_used = it.next().and_then(|v| v.parse().ok());
                m.disk_total = it.next().and_then(|v| v.parse().ok());
            }
            "uptime" => m.uptime_secs = value.parse().ok(),
            "swap" => {
                let mut it = value.split_whitespace();
                m.swap_used = it.next().and_then(|v| v.parse().ok());
                m.swap_total = it.next().and_then(|v| v.parse().ok());
            }
            "users" => m.users = value.to_string(),
            "ip" => m.ip = value.to_string(),
            "topproc" => m.top_proc = value.to_string(),
            "cputemp" => m.cpu_temp = value.parse().ok(),
            "netconns" => m.net_conns = value.parse().ok(),
            "kernel" => m.kernel = value.to_string(),
            "stime" => m.server_time = value.to_string(),
            _ => {}
        }
    }
    if m.pretty_name.is_empty() {
        m.pretty_name = m.os.clone();
    }
    m
}

/// From a `/proc/stat` "cpu" line ("user nice system idle iowait …"), return
/// (idle_jiffies, total_jiffies). Idle counts both idle and iowait.
fn parse_cpustat(raw: &str) -> Option<(u64, u64)> {
    let line = raw.lines().find_map(|l| l.strip_prefix("cpustat="))?;
    let nums: Vec<u64> = line
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    if nums.len() < 5 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    let idle = nums[3] + nums[4];
    Some((idle, total))
}

/// Parse a `key=<a> <b>` line into a pair of cumulative `u64` counters. Used for
/// network (`net=rx tx`) and disk I/O (`diskio=read written`) byte deltas.
fn parse_pair(raw: &str, key: &str) -> Option<(u64, u64)> {
    let prefix = format!("{key}=");
    let line = raw.lines().find_map(|l| l.strip_prefix(prefix.as_str()))?;
    let nums: Vec<u64> = line
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    if nums.len() < 2 {
        return None;
    }
    Some((nums[0], nums[1]))
}

fn parse_net(raw: &str) -> Option<(u64, u64)> {
    parse_pair(raw, "net")
}

/// Turn cumulative counters into a per-second rate using the previous sample for
/// this session (updating it). Returns `(None, None)` on the first poll.
fn rate_from(
    samples: &Mutex<HashMap<String, (u64, u64, Instant)>>,
    session_id: &str,
    cur: (u64, u64),
) -> (Option<u64>, Option<u64>) {
    let now = Instant::now();
    let mut s = samples.lock().unwrap();
    let mut a = None;
    let mut b = None;
    if let Some(&(pa, pb, pinst)) = s.get(session_id) {
        let secs = now.duration_since(pinst).as_secs_f64();
        if secs > 0.0 {
            a = Some((cur.0.saturating_sub(pa) as f64 / secs) as u64);
            b = Some((cur.1.saturating_sub(pb) as f64 / secs) as u64);
        }
    }
    s.insert(session_id.to_string(), (cur.0, cur.1, now));
    (a, b)
}

/// Probe the active session for OS info and resource usage (status bar).
#[tauri::command]
async fn fetch_metrics(state: State<'_, AppState>, session_id: String) -> AppResult<Metrics> {
    let session = session_arc(&state, &session_id).await?;
    let raw = session.run_command(METRICS_SCRIPT).await?;
    let mut m = parse_metrics(&raw);

    // CPU% needs two samples; the first poll for a session has no prior reading.
    if let Some((idle, total)) = parse_cpustat(&raw) {
        let mut samples = state.cpu_samples.lock().unwrap();
        if let Some(&(pidle, ptotal)) = samples.get(&session_id) {
            let dt = total.saturating_sub(ptotal);
            let di = idle.saturating_sub(pidle);
            if dt > 0 {
                m.cpu_pct = Some(((dt - di) as f64 / dt as f64 * 100.0).clamp(0.0, 100.0));
            }
        }
        samples.insert(session_id.clone(), (idle, total));
    }

    // Network + disk I/O rates need two samples and the wall-clock gap between them.
    if let Some(net) = parse_net(&raw) {
        (m.net_rx_rate, m.net_tx_rate) = rate_from(&state.net_samples, &session_id, net);
    }
    if let Some(dio) = parse_pair(&raw, "diskio") {
        (m.disk_read_rate, m.disk_write_rate) = rate_from(&state.disk_samples, &session_id, dio);
    }
    Ok(m)
}

// ── Detailed metrics (monitoring overlay; fetched only while the page is open) ──

/// Richer, heavier probe than the status bar's `METRICS_SCRIPT`. Run only when
/// the monitoring overlay is open. Lines are `key=value`; multi-record values
/// (partitions, TCP states) pack records separated by `;`/spaces.
const DETAIL_SCRIPT: &str = "\
printf 'percpu=%s\\n' \"$(awk '/^cpu[0-9]/{idle=$5+$6; tot=0; for(i=2;i<=NF;i++)tot+=$i; printf \"%d,%d \",idle,tot}' /proc/stat 2>/dev/null)\"; \
printf 'memdetail=%s\\n' \"$(awk '/^MemTotal:/{t=$2}/^MemFree:/{f=$2}/^MemAvailable:/{a=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}END{printf \"%d %d %d %d %d\",t*1024,f*1024,a*1024,b*1024,c*1024}' /proc/meminfo 2>/dev/null)\"; \
printf 'topmem=%s\\n' \"$(ps -eo pmem=,comm= 2>/dev/null | sort -rn | head -3 | awk '{printf \"%s %s%%, \",$2,$1}' | sed 's/, $//')\"; \
printf 'parts=%s\\n' \"$(df -P -T -k 2>/dev/null | awk 'NR>1 && $2!~/^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|cgroup|cgroup2|mqueue|debugfs|tracefs|none)$/ {printf \"%s,%s,%d,%d;\",$7,$2,$3*1024,$4*1024}')\"; \
printf 'inodes=%s\\n' \"$(df -P -T -i 2>/dev/null | awk 'NR>1 && $2!~/^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|cgroup|cgroup2|mqueue|debugfs|tracefs|none)$/ {printf \"%s,%d,%d;\",$7,$3,$4}')\"; \
printf 'filenr=%s\\n' \"$(awk '{print $1, $3}' /proc/sys/fs/file-nr 2>/dev/null)\"; \
printf 'ulimit=%s\\n' \"$( (ulimit -Sn; ulimit -Hn) 2>/dev/null | tr '\\n' ' ')\"; \
printf 'psicpu=%s\\n' \"$(grep '^some' /proc/pressure/cpu 2>/dev/null)\"; \
printf 'psimem=%s\\n' \"$(grep '^some' /proc/pressure/memory 2>/dev/null)\"; \
printf 'psiio=%s\\n' \"$(grep '^some' /proc/pressure/io 2>/dev/null)\"; \
printf 'tcp=%s\\n' \"$(ss -tanH 2>/dev/null | awk '{print $1}' | sort | uniq -c | awk '{printf \"%s:%s \",$2,$1}')\"; \
printf 'sensors=%s\\n' \"$(sensors -u 2>/dev/null | awk '/^[^ ].*:$/{if(l!=\"\"&&v!=\"\"){printf \"%s,%s,%s,%s;\",l,v,h,c}l=$0;sub(/:$/,\"\",l);gsub(/,/,\"\",l);v=\"\";h=\"\";c=\"\";next}/temp[0-9]+_input:/{v=$2+0}/temp[0-9]+_max:/{h=$2+0}/temp[0-9]+_crit:/{c=$2+0}END{if(l!=\"\"&&v!=\"\"){printf \"%s,%s,%s,%s;\",l,v,h,c}}')\"; \
printf 'cpubreak=%s\\n' \"$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null)\"; \
printf 'topcpu=%s\\n' \"$(ps -eo pid=,user=,pcpu=,pmem=,comm= 2>/dev/null | sort -k3 -rn | head -6 | awk '{printf \"%s|%s|%s|%s|%s;\",$1,$2,$3,$4,$5}')\"; \
printf 'failed=%s\\n' \"$(command -v systemctl >/dev/null 2>&1 && systemctl --failed --no-legend 2>/dev/null | wc -l | tr -d ' ')\"; \
printf 'listen=%s\\n' \"$(command -v ss >/dev/null 2>&1 && ss -tlnH 2>/dev/null | wc -l | tr -d ' ')\"; \
printf 'conntrack=%s %s\\n' \"$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null)\" \"$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null)\"; \
printf 'timesync=%s\\n' \"$(command -v timedatectl >/dev/null 2>&1 && timedatectl show -p NTPSynchronized --value 2>/dev/null)\"; \
printf 'netdev=%s\\n' \"$(awk 'NR>2{sub(/:/,\"\");if($1!=\"lo\")printf \"%s,%s,%s,%s,%s,%s,%s;\",$1,$2,$4,$5,$10,$12,$13}' /proc/net/dev 2>/dev/null)\"; \
printf 'diskdev=%s\\n' \"$(awk '$3!~/^(loop|ram|dm-|sr)/ && ($6>0||$10>0){printf \"%s,%s,%s;\",$3,$6,$10}' /proc/diskstats 2>/dev/null)\"; \
printf 'sessions=%s\\n' \"$(who 2>/dev/null | awk '{f=\"\";if($NF ~ /^\\(.*\\)$/){f=$NF;gsub(/[()]/,\"\",f)}printf \"%s,%s,%s %s,%s;\",$1,$2,$3,$4,f}')\"; \
printf 'ctxintr=%s\\n' \"$(awk '/^ctxt /{c=$2}/^intr /{i=$2}END{printf \"%d %d\",c,i}' /proc/stat 2>/dev/null)\"; \
printf 'procs=%s\\n' \"$(awk '/^procs_running/{r=$2}/^procs_blocked/{b=$2}END{printf \"%d %d\",r,b}' /proc/stat 2>/dev/null)\"";

/// Pressure Stall Information (PSI) `some` averages over 10/60/300 s windows.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Psi {
    avg10: f64,
    avg60: f64,
    avg300: f64,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Partition {
    mount: String,
    fstype: String,
    used: u64,
    total: u64,
    inodes_used: Option<u64>,
    inodes_total: Option<u64>,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct TcpState {
    state: String,
    count: u64,
}

/// One temperature sensor reading from lm-sensors (`sensors -u`).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Sensor {
    label: String,
    temp: f64,
    high: Option<f64>,
    crit: Option<f64>,
}

/// CPU time breakdown over the last interval (percentages summing to ~100).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct CpuBreakdown {
    user: f64,
    system: f64,
    iowait: f64,
    steal: f64,
    idle: f64,
}

/// One process row for the top-CPU table.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Proc {
    pid: u32,
    user: String,
    cpu: f64,
    mem: f64,
    comm: String,
}

/// Per-interface network: rx/tx bytes-per-second + cumulative error/drop counters.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct NetIface {
    name: String,
    rx_rate: u64,
    tx_rate: u64,
    rx_errs: u64,
    rx_drop: u64,
    tx_errs: u64,
    tx_drop: u64,
}

/// Per-device disk throughput (bytes/sec) from `/proc/diskstats` sector deltas.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskDev {
    name: String,
    read_rate: u64,
    write_rate: u64,
}

/// One logged-in session from `who` (tty, origin, login time).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Session {
    user: String,
    tty: String,
    from: String,
    login: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct MetricsDetail {
    /// Per-core CPU utilization 0–100 (empty on the first poll of a session).
    per_cpu: Vec<f64>,
    mem_total: Option<u64>,
    mem_free: Option<u64>,
    mem_available: Option<u64>,
    mem_buffers: Option<u64>,
    mem_cached: Option<u64>,
    /// Top processes by memory, "name N%" comma-joined.
    top_mem: String,
    partitions: Vec<Partition>,
    /// System-wide open file descriptors vs the `fs.file-max` ceiling.
    file_nr_used: Option<u64>,
    file_nr_max: Option<u64>,
    ulimit_soft: Option<u64>,
    ulimit_hard: Option<u64>,
    psi_cpu: Option<Psi>,
    psi_mem: Option<Psi>,
    psi_io: Option<Psi>,
    tcp: Vec<TcpState>,
    /// Temperature sensors (lm-sensors); empty when `sensors` isn't installed.
    sensors: Vec<Sensor>,
    /// CPU time split (user/system/iowait/steal/idle %); None on the first poll.
    cpu_breakdown: Option<CpuBreakdown>,
    /// Top processes by CPU (pid/user/cpu/mem/comm).
    top_procs: Vec<Proc>,
    /// Failed systemd units / listening TCP sockets / nf_conntrack usage.
    failed_units: Option<u64>,
    listen_ports: Option<u64>,
    conntrack: Option<u64>,
    conntrack_max: Option<u64>,
    /// NTP clock synchronization (timedatectl); None when unknown.
    time_synced: Option<bool>,
    /// Per-interface network and per-device disk throughput + logged-in sessions.
    net_ifaces: Vec<NetIface>,
    disk_devs: Vec<DiskDev>,
    sessions: Vec<Session>,
    /// Context switches / interrupts per second (rate from cumulative counters).
    ctxt_rate: Option<u64>,
    intr_rate: Option<u64>,
    procs_running: Option<u64>,
    procs_blocked: Option<u64>,
}

/// Parse `key=a,b a,b …` per-core jiffies into `(idle, total)` pairs.
fn parse_percpu(raw: &str) -> Vec<(u64, u64)> {
    let Some(line) = raw.lines().find_map(|l| l.strip_prefix("percpu=")) else {
        return Vec::new();
    };
    line.split_whitespace()
        .filter_map(|tok| {
            let (idle, total) = tok.split_once(',')?;
            Some((idle.parse().ok()?, total.parse().ok()?))
        })
        .collect()
}

/// Per-core utilization from previous and current `(idle, total)` jiffies.
/// Cores whose totals didn't advance (or counts changed) yield 0.
fn percpu_delta(prev: &[(u64, u64)], cur: &[(u64, u64)]) -> Vec<f64> {
    if prev.len() != cur.len() {
        return Vec::new();
    }
    cur.iter()
        .zip(prev.iter())
        .map(|(&(ci, ct), &(pi, pt))| {
            let dt = ct.saturating_sub(pt);
            let di = ci.saturating_sub(pi);
            if dt > 0 {
                ((dt - di) as f64 / dt as f64 * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            }
        })
        .collect()
}

/// Parse a `some avg10=x avg60=y avg300=z total=…` PSI line.
fn parse_psi(raw: &str, key: &str) -> Option<Psi> {
    let prefix = format!("{key}=");
    let line = raw.lines().find_map(|l| l.strip_prefix(prefix.as_str()))?;
    if line.trim().is_empty() {
        return None;
    }
    let mut p = Psi::default();
    for tok in line.split_whitespace() {
        if let Some((k, v)) = tok.split_once('=') {
            let val: f64 = v.parse().unwrap_or(0.0);
            match k {
                "avg10" => p.avg10 = val,
                "avg60" => p.avg60 = val,
                "avg300" => p.avg300 = val,
                _ => {}
            }
        }
    }
    Some(p)
}

/// Merge the `parts=` (space/used) and `inodes=` records into partitions, keyed
/// by mount point.
fn parse_partitions(raw: &str) -> Vec<Partition> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("parts="))
        .unwrap_or("");
    let inodes_line = raw
        .lines()
        .find_map(|l| l.strip_prefix("inodes="))
        .unwrap_or("");

    let mut inode_map: HashMap<String, (u64, u64)> = HashMap::new();
    for rec in inodes_line.split(';').filter(|r| !r.is_empty()) {
        let f: Vec<&str> = rec.split(',').collect();
        if f.len() == 3 {
            if let (Ok(total), Ok(used)) = (f[1].parse(), f[2].parse()) {
                inode_map.insert(f[0].to_string(), (used, total));
            }
        }
    }

    let mut out = Vec::new();
    for rec in line.split(';').filter(|r| !r.is_empty()) {
        let f: Vec<&str> = rec.split(',').collect();
        if f.len() != 4 {
            continue;
        }
        let (Ok(total), Ok(used)) = (f[2].parse::<u64>(), f[3].parse::<u64>()) else {
            continue;
        };
        let (inodes_used, inodes_total) = match inode_map.get(f[0]) {
            Some(&(u, t)) => (Some(u), Some(t)),
            None => (None, None),
        };
        out.push(Partition {
            mount: f[0].to_string(),
            fstype: f[1].to_string(),
            used,
            total,
            inodes_used,
            inodes_total,
        });
    }
    out
}

/// Parse the `cpubreak=` aggregate `/proc/stat` jiffies (user nice system idle
/// iowait irq softirq steal) into 8 cumulative counters.
fn parse_cpu_jiffies(raw: &str) -> Option<[u64; 8]> {
    let line = raw.lines().find_map(|l| l.strip_prefix("cpubreak="))?;
    let n: Vec<u64> = line
        .split_whitespace()
        .filter_map(|x| x.parse().ok())
        .collect();
    if n.len() < 8 {
        return None;
    }
    Some([n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7]])
}

/// CPU time breakdown from two jiffy samples. `None` when the interval didn't
/// advance. Percentages: user(+nice), system(+irq+softirq), iowait, steal, idle.
fn cpu_breakdown(prev: &[u64; 8], cur: &[u64; 8]) -> Option<CpuBreakdown> {
    let d: Vec<i64> = (0..8).map(|i| cur[i] as i64 - prev[i] as i64).collect();
    let tot: i64 = d.iter().map(|v| v.max(&0)).sum();
    if tot <= 0 {
        return None;
    }
    let pct = |v: i64| (v.max(0) as f64 / tot as f64) * 100.0;
    Some(CpuBreakdown {
        user: pct(d[0] + d[1]),
        system: pct(d[2] + d[5] + d[6]),
        iowait: pct(d[4]),
        steal: pct(d[7]),
        idle: pct(d[3]),
    })
}

/// Parse the `topcpu=pid|user|cpu|mem|comm;…` line into process rows.
fn parse_top_procs(raw: &str) -> Vec<Proc> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("topcpu="))
        .unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').collect();
            if f.len() != 5 {
                return None;
            }
            Some(Proc {
                pid: f[0].trim().parse().ok()?,
                user: f[1].trim().to_string(),
                cpu: f[2].trim().parse().ok()?,
                mem: f[3].trim().parse().ok()?,
                comm: f[4].trim().to_string(),
            })
        })
        .collect()
}

/// Per-device byte rates: for each `(name, a, b)` cumulative counter, return the
/// per-second delta against this session's previous sample (updating it). Devices
/// with no prior sample (first poll) are omitted from the result.
fn dev_rate_map(
    store: &DevSampleStore,
    session_id: &str,
    cur: &[(String, u64, u64)],
) -> HashMap<String, (u64, u64)> {
    let now = Instant::now();
    let mut guard = store.lock().unwrap();
    let prevs = guard.entry(session_id.to_string()).or_default();
    let mut out = HashMap::new();
    let mut next = HashMap::new();
    for (name, a, b) in cur {
        if let Some(&(pa, pb, pt)) = prevs.get(name) {
            let dt = now.duration_since(pt).as_secs_f64();
            if dt > 0.0 {
                let ra = (a.saturating_sub(pa) as f64 / dt) as u64;
                let rb = (b.saturating_sub(pb) as f64 / dt) as u64;
                out.insert(name.clone(), (ra, rb));
            }
        }
        next.insert(name.clone(), (*a, *b, now));
    }
    *prevs = next;
    out
}

/// Parse `netdev=name,rxBytes,rxErrs,rxDrop,txBytes,txErrs,txDrop;…` into raw rows
/// (rates are derived separately from two samples).
#[allow(clippy::type_complexity)]
fn parse_netdev(raw: &str) -> Vec<(String, u64, u64, u64, u64, u64, u64)> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("netdev="))
        .unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split(',').collect();
            if f.len() != 7 {
                return None;
            }
            let n = |i: usize| f[i].parse::<u64>().ok();
            Some((f[0].to_string(), n(1)?, n(2)?, n(3)?, n(4)?, n(5)?, n(6)?))
        })
        .collect()
}

/// Parse `diskdev=name,readSectors,writeSectors;…` into `(name, readBytes, writeBytes)`
/// (sectors are 512 bytes).
fn parse_diskdev(raw: &str) -> Vec<(String, u64, u64)> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("diskdev="))
        .unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split(',').collect();
            if f.len() != 3 {
                return None;
            }
            Some((
                f[0].to_string(),
                f[1].parse::<u64>().ok()? * 512,
                f[2].parse::<u64>().ok()? * 512,
            ))
        })
        .collect()
}

/// Parse `sessions=user,tty,login,from;…` into session rows.
fn parse_sessions(raw: &str) -> Vec<Session> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("sessions="))
        .unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split(',').collect();
            if f.len() != 4 || f[0].is_empty() {
                return None;
            }
            Some(Session {
                user: f[0].to_string(),
                tty: f[1].to_string(),
                login: f[2].trim().to_string(),
                from: f[3].to_string(),
            })
        })
        .collect()
}

/// Parse the `sensors=label,temp,high,crit;…` line into sensor readings. `high`
/// and `crit` are optional (empty field → `None`); records without a numeric temp
/// are skipped.
fn parse_sensors(raw: &str) -> Vec<Sensor> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("sensors="))
        .unwrap_or("");
    line.split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let mut f = rec.split(',');
            let label = f.next()?.trim().to_string();
            let temp: f64 = f.next()?.parse().ok()?;
            if label.is_empty() {
                return None;
            }
            let high = f.next().and_then(|s| s.parse().ok());
            let crit = f.next().and_then(|s| s.parse().ok());
            Some(Sensor {
                label,
                temp,
                high,
                crit,
            })
        })
        .collect()
}

/// Parse the `tcp=STATE:count …` line into per-state counts.
fn parse_tcp(raw: &str) -> Vec<TcpState> {
    let line = raw
        .lines()
        .find_map(|l| l.strip_prefix("tcp="))
        .unwrap_or("");
    line.split_whitespace()
        .filter_map(|tok| {
            let (state, count) = tok.split_once(':')?;
            Some(TcpState {
                state: state.to_string(),
                count: count.parse().ok()?,
            })
        })
        .collect()
}

/// Build the static part of `MetricsDetail` (everything not needing a delta).
fn parse_detail(raw: &str) -> MetricsDetail {
    let mut d = MetricsDetail::default();
    if let Some(line) = raw.lines().find_map(|l| l.strip_prefix("memdetail=")) {
        let n: Vec<u64> = line
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if n.len() == 5 {
            d.mem_total = Some(n[0]);
            d.mem_free = Some(n[1]);
            d.mem_available = Some(n[2]);
            d.mem_buffers = Some(n[3]);
            d.mem_cached = Some(n[4]);
        }
    }
    d.top_mem = raw
        .lines()
        .find_map(|l| l.strip_prefix("topmem="))
        .unwrap_or("")
        .trim()
        .to_string();
    d.partitions = parse_partitions(raw);
    if let Some((used, max)) = parse_pair(raw, "filenr") {
        d.file_nr_used = Some(used);
        d.file_nr_max = Some(max);
    }
    if let Some((soft, hard)) = parse_pair(raw, "ulimit") {
        d.ulimit_soft = Some(soft);
        d.ulimit_hard = Some(hard);
    }
    d.psi_cpu = parse_psi(raw, "psicpu");
    d.psi_mem = parse_psi(raw, "psimem");
    d.psi_io = parse_psi(raw, "psiio");
    d.tcp = parse_tcp(raw);
    d.sensors = parse_sensors(raw);
    d.top_procs = parse_top_procs(raw);
    d.failed_units = raw
        .lines()
        .find_map(|l| l.strip_prefix("failed="))
        .and_then(|s| s.trim().parse().ok());
    d.listen_ports = raw
        .lines()
        .find_map(|l| l.strip_prefix("listen="))
        .and_then(|s| s.trim().parse().ok());
    if let Some((c, m)) = parse_pair(raw, "conntrack") {
        d.conntrack = Some(c);
        d.conntrack_max = Some(m);
    }
    d.time_synced = raw
        .lines()
        .find_map(|l| l.strip_prefix("timesync="))
        .and_then(|s| match s.trim() {
            "yes" | "true" | "1" => Some(true),
            "no" | "false" | "0" => Some(false),
            _ => None,
        });
    d.sessions = parse_sessions(raw);
    if let Some((r, b)) = parse_pair(raw, "procs") {
        d.procs_running = Some(r);
        d.procs_blocked = Some(b);
    }
    d
}

/// Probe the active session for detailed metrics (monitoring overlay).
#[tauri::command]
async fn fetch_metrics_detail(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<MetricsDetail> {
    let session = session_arc(&state, &session_id).await?;
    let raw = session.run_command(DETAIL_SCRIPT).await?;
    let mut d = parse_detail(&raw);

    // Per-core CPU% needs two samples (per-core jiffies stored per session).
    let cur = parse_percpu(&raw);
    if !cur.is_empty() {
        let mut samples = state.core_samples.lock().unwrap();
        if let Some(prev) = samples.get(&session_id) {
            d.per_cpu = percpu_delta(prev, &cur);
        }
        samples.insert(session_id.clone(), cur);
    }

    // CPU time breakdown (user/system/iowait/steal/idle) from two jiffy samples.
    if let Some(cur) = parse_cpu_jiffies(&raw) {
        let mut samples = state.cpu_stat_samples.lock().unwrap();
        if let Some(prev) = samples.get(&session_id) {
            d.cpu_breakdown = cpu_breakdown(prev, &cur);
        }
        samples.insert(session_id.clone(), cur);
    }

    // Per-interface network rates (rx/tx bytes/s) from two samples; error/drop
    // counters are cumulative and carried through as-is.
    let nd = parse_netdev(&raw);
    if !nd.is_empty() {
        let cur: Vec<(String, u64, u64)> = nd.iter().map(|r| (r.0.clone(), r.1, r.4)).collect();
        let rates = dev_rate_map(&state.iface_samples, &session_id, &cur);
        d.net_ifaces = nd
            .into_iter()
            .map(|(name, _rxb, rx_errs, rx_drop, _txb, tx_errs, tx_drop)| {
                let (rx_rate, tx_rate) = rates.get(&name).copied().unwrap_or((0, 0));
                NetIface {
                    name,
                    rx_rate,
                    tx_rate,
                    rx_errs,
                    rx_drop,
                    tx_errs,
                    tx_drop,
                }
            })
            .collect();
    }

    // Per-device disk throughput (bytes/s) from sector-count deltas.
    let dd = parse_diskdev(&raw);
    if !dd.is_empty() {
        let rates = dev_rate_map(&state.diskdev_samples, &session_id, &dd);
        d.disk_devs = dd
            .into_iter()
            .filter_map(|(name, _r, _w)| {
                rates.get(&name).map(|&(read_rate, write_rate)| DiskDev {
                    name,
                    read_rate,
                    write_rate,
                })
            })
            .collect();
    }

    // Context-switch / interrupt rates (delta of cumulative counters).
    if let Some(ci) = parse_pair(&raw, "ctxintr") {
        (d.ctxt_rate, d.intr_rate) = rate_from(&state.ctxintr_samples, &session_id, ci);
    }
    Ok(d)
}

/// Distro-aware count of pending package updates + a reboot-required flag. Heavy
/// (reads package caches), so it lives behind its own command and is fetched
/// lazily by the monitoring overlay — never by the status bar.
const PENDING_SCRIPT: &str = r#"
reboot=0; [ -e /var/run/reboot-required ] && reboot=1
mgr=""; up=""; sec=""
if command -v apt-get >/dev/null 2>&1; then
  mgr=apt
  if [ -x /usr/lib/update-notifier/apt-check ]; then
    r=$(/usr/lib/update-notifier/apt-check 2>&1); up=${r%%;*}; sec=${r##*;}
  else
    up=$(LANG=C apt-get -s upgrade 2>/dev/null | grep -c '^Inst')
    sec=$(LANG=C apt-get -s upgrade 2>/dev/null | grep '^Inst' | grep -ic 'security')
  fi
elif command -v dnf >/dev/null 2>&1; then
  mgr=dnf; up=$(dnf -q check-update 2>/dev/null | grep -c '^[a-zA-Z0-9]')
elif command -v yum >/dev/null 2>&1; then
  mgr=yum; up=$(yum -q check-update 2>/dev/null | grep -c '^[a-zA-Z0-9]')
elif command -v checkupdates >/dev/null 2>&1; then
  mgr=pacman; up=$(checkupdates 2>/dev/null | grep -c '.')
elif command -v zypper >/dev/null 2>&1; then
  mgr=zypper; up=$(zypper -q lu 2>/dev/null | grep -c '^v ')
elif command -v apk >/dev/null 2>&1; then
  mgr=apk; up=$(apk version -l '<' 2>/dev/null | grep -c '<')
fi
printf 'mgr=%s\nupdates=%s\nsecurity=%s\nreboot=%s\n' "$mgr" "$up" "$sec" "$reboot"
"#;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct PendingUpdates {
    /// Package manager detected ("apt"/"dnf"/…); empty if none recognized.
    manager: String,
    updates: Option<u64>,
    security: Option<u64>,
    reboot_required: bool,
}

fn parse_pending(raw: &str) -> PendingUpdates {
    let mut p = PendingUpdates::default();
    for line in raw.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim();
        match k {
            "mgr" => p.manager = v.to_string(),
            "updates" => p.updates = v.parse().ok(),
            "security" => p.security = v.parse().ok(),
            "reboot" => p.reboot_required = v == "1",
            _ => {}
        }
    }
    p
}

/// Lazily probe the active session for pending package updates.
#[tauri::command]
async fn fetch_pending_updates(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<PendingUpdates> {
    let session = session_arc(&state, &session_id).await?;
    let raw = session.run_command(PENDING_SCRIPT).await?;
    Ok(parse_pending(&raw))
}

/// Optional "extras" probed once when the monitoring overlay opens: NVIDIA GPUs,
/// Docker containers, disk SMART health and the OOM-kill count. Heavy/optional and
/// best-effort (each guarded by `command -v`; SMART needs root, so it populates for
/// root sessions and is empty otherwise) — never part of the per-poll detail probe.
const EXTRAS_SCRIPT: &str = r#"
gpu=""
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu=$(nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | awk -F', *' '{printf "%s|%s|%s|%s|%s;",$1,$2,$3,$4,$5}')
fi
printf 'gpu=%s\n' "$gpu"
docker=""
if command -v docker >/dev/null 2>&1; then
  docker=$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null | awk '{gsub(/%/,"");printf "%s;",$0}')
fi
printf 'docker=%s\n' "$docker"
printf 'oom=%s\n' "$(dmesg 2>/dev/null | grep -ic 'out of memory')"
smart=""
for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}'); do
  o=$(smartctl -H -A /dev/$d 2>/dev/null)
  [ -z "$o" ] && continue
  h=$(printf '%s\n' "$o" | awk '/overall-health/{print $NF}')
  t=$(printf '%s\n' "$o" | awk '/Temperature_Celsius/{print $10} /^Temperature:/{print $2}' | head -1)
  p=$(printf '%s\n' "$o" | awk '/Power_On_Hours/{print $10} /Power On Hours/{print $NF}' | head -1)
  smart="$smart$d|$h|$t|$p;"
done
printf 'smart=%s\n' "$smart"
"#;

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Gpu {
    name: String,
    util: f64,
    /// VRAM used / total in MiB (as reported by nvidia-smi `nounits`).
    mem_used: u64,
    mem_total: u64,
    temp: f64,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct DockerStat {
    name: String,
    cpu: f64,
    /// Memory usage string, e.g. "1.2GiB / 3.8GiB".
    mem: String,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct SmartDisk {
    device: String,
    health: String,
    temp: Option<f64>,
    power_on_hours: Option<u64>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Extras {
    gpus: Vec<Gpu>,
    docker: Vec<DockerStat>,
    smart: Vec<SmartDisk>,
    oom_kills: Option<u64>,
}

fn parse_extras(raw: &str) -> Extras {
    let field = |key: &str| raw.lines().find_map(|l| l.strip_prefix(key)).unwrap_or("");
    let gpus = field("gpu=")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').collect();
            if f.len() != 5 {
                return None;
            }
            Some(Gpu {
                name: f[0].trim().to_string(),
                util: f[1].trim().parse().unwrap_or(0.0),
                mem_used: f[2].trim().parse().unwrap_or(0),
                mem_total: f[3].trim().parse().unwrap_or(0),
                temp: f[4].trim().parse().unwrap_or(0.0),
            })
        })
        .collect();
    let docker = field("docker=")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').collect();
            if f.len() != 3 {
                return None;
            }
            Some(DockerStat {
                name: f[0].trim().to_string(),
                cpu: f[1].trim().parse().unwrap_or(0.0),
                mem: f[2].trim().to_string(),
            })
        })
        .collect();
    let smart = field("smart=")
        .split(';')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('|').collect();
            if f.len() != 4 || f[0].is_empty() {
                return None;
            }
            Some(SmartDisk {
                device: f[0].trim().to_string(),
                health: f[1].trim().to_string(),
                temp: f[2].trim().parse().ok(),
                power_on_hours: f[3].trim().parse().ok(),
            })
        })
        .collect();
    let oom_kills = field("oom=").trim().parse().ok();
    Extras {
        gpus,
        docker,
        smart,
        oom_kills,
    }
}

/// Probe optional extras (GPU/Docker/SMART/OOM) — lazy, once per overlay open.
#[tauri::command]
async fn fetch_extras(state: State<'_, AppState>, session_id: String) -> AppResult<Extras> {
    let session = session_arc(&state, &session_id).await?;
    let raw = session.run_command(EXTRAS_SCRIPT).await?;
    Ok(parse_extras(&raw))
}

// ── SFTP commands ─────────────────────────────────────────────────────────────

/// Fetch (opening on first use) the SFTP session for a tab, then release the lock
/// so long transfers don't block other sessions.
async fn get_sftp(state: &State<'_, AppState>, session_id: &str) -> AppResult<Arc<SftpSession>> {
    let session = session_arc(state, session_id).await?;
    session.sftp().await
}

#[tauri::command]
async fn sftp_home(state: State<'_, AppState>, session_id: String) -> AppResult<String> {
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::home(&sftp).await
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<Vec<FileEntry>> {
    let sftp = get_sftp(&state, &session_id).await?;
    let mut entries = sftp::list(&sftp, &path).await?;
    // Fill owner names from a cached passwd/group map (SFTP attrs rarely carry them).
    let (users, groups) = ensure_id_names(&state, &session_id).await;
    for e in &mut entries {
        if e.user.is_none() {
            e.user = e.uid.and_then(|u| users.get(&u).cloned());
        }
        if e.group.is_none() {
            e.group = e.gid.and_then(|g| groups.get(&g).cloned());
        }
    }
    Ok(entries)
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, session_id: String, path: String) -> AppResult<()> {
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::mkdir(&sftp, &path).await
}

#[tauri::command]
async fn sftp_create_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::create_file(&sftp, &path).await
}

/// Open a remote file as text in the in-app editor (rejects large/binary files).
/// `max_bytes` is the configurable open-size limit; clamped to a hard ceiling so a
/// bad setting can't slurp a huge file into memory.
#[tauri::command]
async fn sftp_read_text(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    max_bytes: Option<u64>,
    sudo: Option<bool>,
    sudo_password: Option<String>,
) -> AppResult<sftp::TextFile> {
    let limit = max_bytes
        .unwrap_or(sftp::MAX_EDIT_SIZE)
        .clamp(1, sftp::HARD_MAX_EDIT_SIZE);
    if sudo == Some(true) {
        let session = session_arc(&state, &session_id).await?;
        return sync::sudo_read(
            &session,
            &path,
            limit,
            sudo_password.as_deref().unwrap_or(""),
        )
        .await;
    }
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::read_text(&sftp, &path, limit).await
}

/// Save editor text back to a remote file (atomic temp+rename, conflict-checked).
/// `sudo` writes root-owned files via `sudo cp`; `backup` keeps a `.bak` copy.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn sftp_write_text(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
    eol: String,
    expected_sha256: Option<String>,
    sudo: Option<bool>,
    sudo_password: Option<String>,
    backup: Option<bool>,
) -> AppResult<sftp::WriteResult> {
    let backup = backup.unwrap_or(false);
    if sudo == Some(true) {
        let session = session_arc(&state, &session_id).await?;
        let sftp = session.sftp().await?;
        return sync::sudo_write(
            &session,
            &sftp,
            &path,
            &content,
            &eol,
            expected_sha256.as_deref(),
            backup,
            sudo_password.as_deref().unwrap_or(""),
        )
        .await;
    }
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::write_text(
        &sftp,
        &path,
        &content,
        &eol,
        expected_sha256.as_deref(),
        backup,
    )
    .await
}

/// Open a LOCAL file as text in the editor ("Open with vterm" flow). Same guards
/// and contract as `sftp_read_text`, but on the machine running vterm.
#[tauri::command]
async fn read_local_text(path: String, max_bytes: Option<u64>) -> AppResult<sftp::TextFile> {
    let limit = max_bytes
        .unwrap_or(sftp::MAX_EDIT_SIZE)
        .clamp(1, sftp::HARD_MAX_EDIT_SIZE);
    localfile::read_text(&path, limit).await
}

/// Save editor text back to a LOCAL file (atomic temp+rename, conflict-checked).
#[tauri::command]
async fn write_local_text(
    path: String,
    content: String,
    eol: String,
    expected_sha256: Option<String>,
) -> AppResult<sftp::WriteResult> {
    localfile::write_text(&path, &content, &eol, expected_sha256.as_deref()).await
}

/// Take and clear the queue of files vterm was asked to open (CLI args at launch
/// and macOS `Opened` events), so the frontend can open them on startup.
#[tauri::command]
fn take_pending_opens(state: State<AppState>) -> Vec<String> {
    std::mem::take(&mut state.pending_opens.lock().unwrap())
}

// ── Local filesystem browser (the right panel for local-terminal tabs) ─────────

#[tauri::command]
fn local_home() -> AppResult<String> {
    localfile::home()
}

#[tauri::command]
async fn local_list(path: String) -> AppResult<Vec<sftp::FileEntry>> {
    localfile::list(&path).await
}

#[tauri::command]
async fn local_mkdir(path: String) -> AppResult<()> {
    localfile::mkdir(&path).await
}

#[tauri::command]
async fn local_create_file(path: String) -> AppResult<()> {
    localfile::create_file(&path).await
}

#[tauri::command]
async fn local_delete(path: String, is_dir: bool) -> AppResult<()> {
    localfile::remove(&path, is_dir).await
}

// ── Directory sync (Phase 12.5) ────────────────────────────────────────────────

/// Hash every file under a remote directory via `sha256sum` over the SSH exec
/// channel (no download). Returns `/`-relative path → sha256.
#[tauri::command]
async fn sftp_hash_tree(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<Vec<sync::HashEntry>> {
    let session = session_arc(&state, &session_id).await?;
    let out = session
        .run_command(&sync::remote_hash_command(&path))
        .await?;
    Ok(sync::parse_hashsum(&out))
}

/// Hash every file under a local directory (the local side of sync).
#[tauri::command]
async fn local_hash_tree(path: String) -> AppResult<Vec<sync::HashEntry>> {
    localfile::hash_tree(&path).await
}

/// Lint the editor buffer with a real tool on the server (Phase 12.7): stage the
/// content to a temp file, run the language's linter, return its output. `found`
/// is false when no linter maps to the language or the tool isn't installed.
#[tauri::command]
async fn lint_remote(
    state: State<'_, AppState>,
    session_id: String,
    content: String,
    kind: String,
) -> AppResult<sync::LintResult> {
    let Some(tool) = sync::lint_tool(&kind) else {
        return Ok(sync::LintResult::default());
    };
    let session = session_arc(&state, &session_id).await?;
    // Is the tool installed?
    let chk = session
        .run_command(&format!(
            "command -v {} >/dev/null 2>&1 && echo __VTERM_OK__",
            tool.bin
        ))
        .await
        .unwrap_or_default();
    if !chk.contains("__VTERM_OK__") {
        return Ok(sync::LintResult {
            tool: tool.bin.to_string(),
            found: false,
            format: tool.format.to_string(),
            ..Default::default()
        });
    }
    // Stage the buffer to a temp file in the user's home, lint it, then remove it.
    let sftp = session.sftp().await?;
    let home = sftp
        .canonicalize(".")
        .await
        .map_err(|e| format!("home dir: {e}"))?;
    let tmp = format!("{}/.vterm-lint-{}", home.trim_end_matches('/'), uuid_like());
    sftp::write_bytes(&sftp, &tmp, content.as_bytes()).await?;
    let out = session
        .run_command(&sync::lint_command(&tool, &tmp))
        .await
        .unwrap_or_default();
    let _ = sftp.remove_file(tmp.clone()).await;
    Ok(sync::LintResult {
        tool: tool.bin.to_string(),
        found: true,
        output: out.replace(&tmp, "FILE"),
        format: tool.format.to_string(),
    })
}

/// Detect the server's package manager and which optional tools are installed
/// (Phase 12.8). One round-trip; resolves the install command per tool/distro.
#[tauri::command]
async fn server_tools_status(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<servertools::ToolsStatus> {
    let session = session_arc(&state, &session_id).await?;
    let raw = session.run_command(&servertools::status_command()).await?;
    let (manager, have) = servertools::parse_status(&raw);
    Ok(servertools::build_status(&manager, &have))
}

/// Run an install command on the server (one-click path). A leading `sudo` is fed
/// the password via stdin; non-sudo commands (pip/brew) run as-is. Returns output.
#[tauri::command]
async fn run_tool_install(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    sudo_password: Option<String>,
) -> AppResult<String> {
    let session = session_arc(&state, &session_id).await?;
    let cmd = format!("{} 2>&1", servertools::sudoize(&command));
    let mut pw = sudo_password.unwrap_or_default().into_bytes();
    pw.push(b'\n');
    session.run_command_stdin(&cmd, &pw).await
}

/// Apply a computed sync plan: upload/download changed files, delete extraneous.
#[tauri::command]
async fn sftp_sync_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_root: String,
    remote_root: String,
    actions: Vec<sync::SyncAction>,
) -> AppResult<sync::SyncStats> {
    let sftp = get_sftp(&state, &session_id).await?;
    sync::apply(&app, &sftp, &local_root, &remote_root, actions).await
}

/// Content search under a remote directory via `grep -rn` over SSH (Phase 12.6).
#[tauri::command]
async fn sftp_grep(
    state: State<'_, AppState>,
    session_id: String,
    dir: String,
    query: String,
    case_insensitive: bool,
    fixed: bool,
) -> AppResult<Vec<sync::GrepMatch>> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let session = session_arc(&state, &session_id).await?;
    let out = session
        .run_command(&sync::grep_command(&dir, &query, case_insensitive, fixed))
        .await?;
    Ok(sync::parse_grep(&out))
}

#[tauri::command]
async fn sftp_delete(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> AppResult<()> {
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::remove(&sftp, &path, is_dir).await
}

#[tauri::command]
async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
) -> AppResult<()> {
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::upload(&app, transfer_id, &sftp, &local_path, &remote_path).await
}

#[tauri::command]
async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    is_dir: bool,
) -> AppResult<()> {
    let sftp = get_sftp(&state, &session_id).await?;
    if is_dir {
        // `local_path` is the destination *parent* directory.
        let cancel = Arc::new(AtomicBool::new(false));
        state
            .cancels
            .lock()
            .unwrap()
            .insert(transfer_id.clone(), cancel.clone());
        let result = sftp::download_dir(
            &app,
            transfer_id.clone(),
            &sftp,
            &remote_path,
            &local_path,
            cancel,
        )
        .await;
        state.cancels.lock().unwrap().remove(&transfer_id);
        result
    } else {
        sftp::download(&app, transfer_id, &sftp, &remote_path, &local_path).await
    }
}

/// Request cancellation of an in-progress folder download.
#[tauri::command]
fn sftp_cancel(state: State<AppState>, transfer_id: String) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Tiny unique-id helper so we don't pull in the `uuid` crate yet.
pub(crate) fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("srv-{nanos:x}")
}

/// Read UTF-8 text from the OS clipboard in the Rust process.
///
/// The frontend deliberately avoids `navigator.clipboard.readText()`: in
/// WKWebView (macOS) it pops WebKit's "Paste" permission button, and the app
/// ships without a native Edit menu (so the terminal keeps ⌘C/⌘V). Reading the
/// pasteboard here — the same thing `tauri-plugin-clipboard-manager` would do —
/// never touches the webview, so no prompt appears. Returns the empty string for
/// an empty/non-text clipboard; errors on platforms without a native reader so
/// the caller can fall back to the web API.
#[tauri::command]
fn read_clipboard_text() -> AppResult<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        // SAFETY: reading the general pasteboard via AppKit. NSPasteboard reads
        // are thread-safe, so this is fine off the main thread (Tauri command
        // pool). We only borrow the returned string to copy it into a Rust String.
        let text =
            unsafe { NSPasteboard::generalPasteboard().stringForType(NSPasteboardTypeString) };
        Ok(text.map(|s| s.to_string()).unwrap_or_default())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(AppError::Message(
            "native clipboard read is only implemented on macOS".into(),
        ))
    }
}

/// Localized labels for the native menu. Sourced from the frontend i18n
/// dictionaries (`src/lib/i18n`) so the native menu follows the same language as
/// the rest of the UI. Defaults are the canonical English used for the very
/// first build, before the WebView pushes the user's language.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuLabels {
    // Used only in the Windows/Linux in-window menu bar (macOS has no File menu).
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    file_menu: String,
    help_menu: String,
    settings: String,
    about: String,
    help: String,
    manual: String,
    monitoring: String,
}

impl Default for MenuLabels {
    fn default() -> Self {
        Self {
            file_menu: "File".into(),
            help_menu: "Help".into(),
            settings: "Settings…".into(),
            about: "About vterm".into(),
            help: "Help".into(),
            manual: "Manual".into(),
            monitoring: "Monitoring".into(),
        }
    }
}

/// Build the native application menu from localized `labels`. On macOS the items
/// live in the standard "vterm" app menu (Settings with ⌘,) and a Help menu; on
/// Windows/Linux they appear in an in-window menu bar (File → Settings…, Help).
/// Item ids are stable across languages, so the `on_menu_event` routing keeps
/// working after a rebuild (see `set_menu_language`).
fn build_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    labels: &MenuLabels,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let settings = MenuItemBuilder::with_id("settings", &labels.settings)
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let about = MenuItemBuilder::with_id("about", &labels.about).build(app)?;
    let help = MenuItemBuilder::with_id("help", &labels.help).build(app)?;
    let manual = MenuItemBuilder::with_id("manual", &labels.manual).build(app)?;
    let monitoring = MenuItemBuilder::with_id("monitoring", &labels.monitoring)
        .accelerator("CmdOrCtrl+Shift+M")
        .build(app)?;

    #[cfg(target_os = "macos")]
    {
        // No Edit menu on purpose: the terminal handles ⌘C/⌘V itself, and a
        // native Edit menu would steal those accelerators before xterm sees them.
        let app_menu = SubmenuBuilder::new(app, "vterm")
            .item(&about)
            .separator()
            .item(&settings)
            .item(&monitoring)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let help_menu = SubmenuBuilder::new(app, &labels.help_menu)
            .item(&help)
            .item(&manual)
            .build()?;
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&help_menu)
            .build()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let file_menu = SubmenuBuilder::new(app, &labels.file_menu)
            .item(&settings)
            .item(&monitoring)
            .separator()
            .quit()
            .build()?;
        let help_menu = SubmenuBuilder::new(app, &labels.help_menu)
            .item(&about)
            .item(&help)
            .item(&manual)
            .build()?;
        MenuBuilder::new(app)
            .item(&file_menu)
            .item(&help_menu)
            .build()
    }
}

/// Rebuild the native menu in the language chosen on the frontend. Called by the
/// WebView on startup and whenever the user switches language in Settings.
#[tauri::command]
fn set_menu_language(app: AppHandle, labels: MenuLabels) -> Result<(), String> {
    let menu = build_app_menu(&app, &labels).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// Treat non-flag CLI arguments as file paths to open in the editor.
fn file_args(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .cloned()
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Files passed on the command line at first launch (Windows/Linux "open with"
    // gives the path as argv; macOS uses the `Opened` run event below).
    let initial_files = file_args(&std::env::args().collect::<Vec<_>>());

    let state = AppState {
        servers: Mutex::new(store::load_servers()),
        folders: Mutex::new(store::load_folders()),
        sessions: tokio::sync::Mutex::new(HashMap::new()),
        local_ptys: Mutex::new(HashMap::new()),
        cancels: Mutex::new(HashMap::new()),
        cpu_samples: Mutex::new(HashMap::new()),
        net_samples: Mutex::new(HashMap::new()),
        disk_samples: Mutex::new(HashMap::new()),
        core_samples: Mutex::new(HashMap::new()),
        cpu_stat_samples: Mutex::new(HashMap::new()),
        iface_samples: Mutex::new(HashMap::new()),
        diskdev_samples: Mutex::new(HashMap::new()),
        ctxintr_samples: Mutex::new(HashMap::new()),
        pending_opens: Mutex::new(initial_files),
        id_names: Mutex::new(HashMap::new()),
    };

    let app = tauri::Builder::default()
        // single-instance must be registered first: a second launch (e.g. another
        // "open with vterm") forwards its file args to the running window instead.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for path in file_args(&argv) {
                let _ = app.emit("vterm://open-file", path);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| build_app_menu(app, &MenuLabels::default()))
        .on_menu_event(|app, event| {
            let _ = match event.id().as_ref() {
                "settings" => app.emit("menu://settings", ()),
                "about" => app.emit("menu://about", ()),
                "help" => app.emit("menu://help", ()),
                "manual" => app.emit("menu://manual", ()),
                "monitoring" => app.emit("menu://monitoring", ()),
                _ => Ok(()),
            };
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            list_servers,
            add_server,
            update_server,
            delete_server,
            forget_secrets,
            list_folders,
            add_folder,
            delete_folder,
            move_folder,
            rename_folder,
            set_server_group,
            export_backup,
            import_backup,
            connect_plan,
            connect_session,
            open_local_terminal,
            write_to_terminal,
            resize_pty,
            disconnect,
            fetch_metrics,
            fetch_metrics_detail,
            fetch_pending_updates,
            fetch_extras,
            sftp_home,
            sftp_list,
            sftp_mkdir,
            sftp_create_file,
            sftp_read_text,
            sftp_write_text,
            read_local_text,
            write_local_text,
            take_pending_opens,
            local_home,
            local_list,
            local_mkdir,
            local_create_file,
            local_delete,
            sftp_hash_tree,
            local_hash_tree,
            sftp_sync_apply,
            sftp_grep,
            lint_remote,
            server_tools_status,
            run_tool_install,
            sftp_delete,
            sftp_upload,
            sftp_download,
            sftp_cancel,
            read_clipboard_text,
            set_menu_language,
            start_recording,
            stop_recording,
            set_recording_paused,
            annotate_recording,
            list_recordings,
            delete_recording,
            set_recording_meta,
            read_recording,
            export_recording,
            import_recording
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
        // macOS delivers "Open with" / dropped files as an Opened run event (the
        // variant only exists on macOS/iOS — Windows/Linux get the path via argv,
        // handled by single-instance / initial `pending_opens`). Queue + emit so the
        // frontend opens them whether or not it's listening yet.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state
                        .pending_opens
                        .lock()
                        .unwrap()
                        .extend(paths.iter().cloned());
                }
                for p in paths {
                    let _ = app_handle.emit("vterm://open-file", p);
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app_handle, event);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── normalize_path ────────────────────────────────────────────────────────
    #[test]
    fn normalize_path_collapses_and_trims() {
        assert_eq!(normalize_path("  Production / EU "), "Production/EU");
        assert_eq!(normalize_path("//a//b///c/"), "a/b/c");
        assert_eq!(normalize_path("solo"), "solo");
    }

    #[test]
    fn normalize_path_blank_becomes_empty() {
        assert_eq!(normalize_path(""), "");
        assert_eq!(normalize_path("   "), "");
        assert_eq!(normalize_path("///"), "");
    }

    // ── reprefixed (folder move/rename core) ──────────────────────────────────
    #[test]
    fn reprefixed_exact_match_renamed() {
        assert_eq!(reprefixed("Prod", "Prod", "Production"), "Production");
    }

    #[test]
    fn reprefixed_subtree_is_carried_along() {
        assert_eq!(
            reprefixed("Prod/EU/web", "Prod", "Production"),
            "Production/EU/web"
        );
        // Move under a new parent.
        assert_eq!(reprefixed("Prod/EU", "Prod/EU", "Staging/EU"), "Staging/EU");
    }

    #[test]
    fn reprefixed_unrelated_paths_unchanged() {
        assert_eq!(reprefixed("Other", "Prod", "Production"), "Other");
        // "Production" must not be treated as a child of "Prod" (prefix guard).
        assert_eq!(reprefixed("Production", "Prod", "X"), "Production");
    }

    // ── parse_metrics ─────────────────────────────────────────────────────────
    #[test]
    fn parse_metrics_full_linux_sample() {
        let raw = "os=Linux\n\
                   host=web01\n\
                   user=root\n\
                   pretty=Ubuntu 24.04 LTS\n\
                   load=0.15 0.20 0.30\n\
                   mem=1048576 4194304\n\
                   disk=2097152 10485760\n\
                   cpustat=100 0 50 850 0 0 0";
        let m = parse_metrics(raw);
        assert_eq!(m.os, "Linux");
        assert_eq!(m.hostname, "web01");
        assert_eq!(m.user, "root");
        assert_eq!(m.pretty_name, "Ubuntu 24.04 LTS");
        assert_eq!(m.load1, Some(0.15));
        assert_eq!(m.load5, Some(0.20));
        assert_eq!(m.load15, Some(0.30));
        assert_eq!(m.mem_used, Some(1048576));
        assert_eq!(m.mem_total, Some(4194304));
        assert_eq!(m.disk_used, Some(2097152));
        assert_eq!(m.disk_total, Some(10485760));
    }

    #[test]
    fn parse_metrics_falls_back_pretty_to_os() {
        // macOS without /etc/os-release: pretty is empty, should mirror os.
        let m = parse_metrics("os=Darwin\nhost=mac\npretty=\n");
        assert_eq!(m.pretty_name, "Darwin");
    }

    #[test]
    fn parse_metrics_ignores_garbage_and_blanks() {
        let m = parse_metrics("garbage line\n\nload=notanumber\nmem=\n=oops\nunknown=1");
        assert_eq!(m.load1, None);
        assert_eq!(m.mem_used, None);
        assert!(m.os.is_empty());
    }

    // ── parse_cpustat ─────────────────────────────────────────────────────────
    #[test]
    fn parse_cpustat_idle_and_total() {
        // user nice system idle iowait …
        let (idle, total) = parse_cpustat("cpustat=100 0 50 800 50 0 0").unwrap();
        assert_eq!(idle, 850); // idle + iowait
        assert_eq!(total, 1000);
    }

    #[test]
    fn parse_cpustat_missing_or_short_is_none() {
        assert!(parse_cpustat("os=Linux").is_none());
        assert!(parse_cpustat("cpustat=1 2 3").is_none()); // < 5 fields
    }

    // ── parse_net ─────────────────────────────────────────────────────────────
    #[test]
    fn parse_net_reads_rx_tx() {
        let (rx, tx) = parse_net("cpustat=1 2\nnet=12345 6789").unwrap();
        assert_eq!(rx, 12345);
        assert_eq!(tx, 6789);
    }

    #[test]
    fn parse_net_missing_or_short_is_none() {
        assert!(parse_net("os=Linux").is_none());
        assert!(parse_net("net=42").is_none()); // < 2 fields
    }

    #[test]
    fn parse_pair_reads_named_counters() {
        let (r, w) = parse_pair("diskio=1000 2000\nnet=5 6", "diskio").unwrap();
        assert_eq!((r, w), (1000, 2000));
        assert!(parse_pair("diskio=1", "diskio").is_none()); // < 2 fields
        assert!(parse_pair("net=1 2", "diskio").is_none()); // wrong key
    }

    #[test]
    fn parse_metrics_reads_extended_fields() {
        let m = parse_metrics(
            "uptime=90061\nswap=1024 4096\nusers=alice bob \nip=10.0.0.5\n\
             topproc=node 87%\ncputemp=56\nnetconns=42\nkernel=6.1.0\nstime=14:05 UTC",
        );
        assert_eq!(m.uptime_secs, Some(90061));
        assert_eq!(m.swap_used, Some(1024));
        assert_eq!(m.swap_total, Some(4096));
        assert_eq!(m.users, "alice bob");
        assert_eq!(m.ip, "10.0.0.5");
        assert_eq!(m.top_proc, "node 87%");
        assert_eq!(m.cpu_temp, Some(56.0));
        assert_eq!(m.net_conns, Some(42));
        assert_eq!(m.kernel, "6.1.0");
        assert_eq!(m.server_time, "14:05 UTC");
    }

    // ── detailed metrics (monitoring overlay) ─────────────────────────────────
    #[test]
    fn parse_percpu_reads_idle_total_pairs() {
        let v = parse_percpu("percpu=100,1000 200,2000 \nfoo=bar");
        assert_eq!(v, vec![(100, 1000), (200, 2000)]);
        assert!(parse_percpu("os=Linux").is_empty());
    }

    #[test]
    fn percpu_delta_computes_busy_percentage() {
        // core0: total +100, idle +20 → 80% busy. core1: total +100, idle +100 → 0%.
        let prev = [(100, 1000), (500, 5000)];
        let cur = [(120, 1100), (600, 5100)];
        let pct = percpu_delta(&prev, &cur);
        assert_eq!(pct, vec![80.0, 0.0]);
        // Mismatched core counts → empty (a CPU hotplug between polls).
        assert!(percpu_delta(&prev, &[(1, 2)]).is_empty());
    }

    #[test]
    fn parse_psi_reads_some_averages() {
        let p = parse_psi(
            "psicpu=avg10=1.50 avg60=0.20 avg300=0.05 total=999",
            "psicpu",
        )
        .unwrap();
        assert_eq!((p.avg10, p.avg60, p.avg300), (1.50, 0.20, 0.05));
        // Empty line (kernel without PSI) → None.
        assert!(parse_psi("psicpu=", "psicpu").is_none());
        assert!(parse_psi("os=Linux", "psicpu").is_none());
    }

    #[test]
    fn parse_partitions_merges_space_and_inodes() {
        let raw = "parts=/,ext4,10485760,5242880;/boot,vfat,1048576,524288;\n\
                   inodes=/,655360,123456;\n";
        let parts = parse_partitions(raw);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].mount, "/");
        assert_eq!(parts[0].fstype, "ext4");
        assert_eq!(parts[0].total, 10485760);
        assert_eq!(parts[0].used, 5242880);
        assert_eq!(parts[0].inodes_total, Some(655360));
        assert_eq!(parts[0].inodes_used, Some(123456));
        // /boot has no inode record → None, not a crash.
        assert_eq!(parts[1].mount, "/boot");
        assert_eq!(parts[1].inodes_total, None);
    }

    #[test]
    fn parse_tcp_counts_states() {
        let t = parse_tcp("tcp=ESTAB:12 LISTEN:8 TIME-WAIT:3 \n");
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].state, "ESTAB");
        assert_eq!(t[0].count, 12);
        assert!(parse_tcp("os=Linux").is_empty());
    }

    #[test]
    fn parse_netdev_diskdev_sessions_rows() {
        let nd = parse_netdev("netdev=eth0,1000,1,2,500,3,4;wlan0,9,0,0,8,0,0;");
        assert_eq!(nd.len(), 2);
        assert_eq!(nd[0], ("eth0".into(), 1000, 1, 2, 500, 3, 4));

        // Sectors → bytes (×512).
        let dd = parse_diskdev("diskdev=sda,10,20;");
        assert_eq!(dd, vec![("sda".to_string(), 5120, 10240)]);

        let s = parse_sessions(
            "sessions=root,pts/0,2026-06-29 14:00,10.0.0.5;bob,tty1,2026-06-29 09:00,;",
        );
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].user, "root");
        assert_eq!(s[0].from, "10.0.0.5");
        assert_eq!(s[1].from, "");
        assert!(parse_netdev("os=Linux").is_empty());
    }

    #[test]
    fn dev_rate_map_computes_per_second_deltas() {
        let store: DevSampleStore = Mutex::new(HashMap::new());
        // First call: no prior sample → empty.
        let r1 = dev_rate_map(&store, "s1", &[("eth0".into(), 1000, 2000)]);
        assert!(r1.is_empty());
        // Backdate the stored sample by 1s so the next delta yields a rate.
        {
            let mut g = store.lock().unwrap();
            let e = g.get_mut("s1").unwrap().get_mut("eth0").unwrap();
            e.2 -= std::time::Duration::from_secs(1);
        }
        let r2 = dev_rate_map(&store, "s1", &[("eth0".into(), 1500, 2400)]);
        let (rx, tx) = r2["eth0"];
        assert!((490..=510).contains(&rx), "rx ~500, got {rx}");
        assert!((390..=410).contains(&tx), "tx ~400, got {tx}");
    }

    #[test]
    fn cpu_breakdown_splits_user_system_iowait_steal() {
        // prev → cur: 100 user, 50 system, 20 iowait, 30 steal, 800 idle ticks.
        let prev = [0u64, 0, 0, 0, 0, 0, 0, 0];
        let cur = [100u64, 0, 50, 800, 20, 0, 0, 30];
        let b = cpu_breakdown(&prev, &cur).unwrap();
        assert_eq!(b.user.round(), 10.0);
        assert_eq!(b.system.round(), 5.0);
        assert_eq!(b.iowait.round(), 2.0);
        assert_eq!(b.steal.round(), 3.0);
        assert_eq!(b.idle.round(), 80.0);
        // No advance → None.
        assert!(cpu_breakdown(&cur, &cur).is_none());
    }

    #[test]
    fn parse_top_procs_reads_pipe_records() {
        let raw = "topcpu=1234|root|12.5|3.1|nginx;5678|www|4.0|1.2|php-fpm;";
        let p = parse_top_procs(raw);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].pid, 1234);
        assert_eq!(p[0].user, "root");
        assert_eq!(p[0].cpu, 12.5);
        assert_eq!(p[0].comm, "nginx");
        assert!(parse_top_procs("os=Linux").is_empty());
    }

    #[test]
    fn parse_detail_reads_health_scalars() {
        let raw = "failed=2\nlisten=9\nconntrack=120 65536\ntimesync=yes\n";
        let d = parse_detail(raw);
        assert_eq!(d.failed_units, Some(2));
        assert_eq!(d.listen_ports, Some(9));
        assert_eq!(d.conntrack, Some(120));
        assert_eq!(d.conntrack_max, Some(65536));
        assert_eq!(d.time_synced, Some(true));
        // Empty/absent → None.
        let e = parse_detail("timesync=\nfailed=\n");
        assert_eq!(e.time_synced, None);
        assert_eq!(e.failed_units, None);
    }

    #[test]
    fn parse_sensors_reads_label_temp_high_crit() {
        let raw = "sensors=Package id 0,45,84,100;Core 0,43,,100;Composite,35.85,,88.85;";
        let s = parse_sensors(raw);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].label, "Package id 0");
        assert_eq!(s[0].temp, 45.0);
        assert_eq!(s[0].high, Some(84.0));
        assert_eq!(s[0].crit, Some(100.0));
        // Empty `high` field → None.
        assert_eq!(s[1].label, "Core 0");
        assert_eq!(s[1].high, None);
        assert_eq!(s[1].crit, Some(100.0));
        assert_eq!(s[2].temp, 35.85);
        // No sensors line → empty.
        assert!(parse_sensors("os=Linux").is_empty());
    }

    #[test]
    fn parse_detail_reads_mem_filenr_ulimit_and_procs() {
        let raw = "memdetail=8000 1000 4000 200 2000\n\
                   topmem=node 12%, postgres 8%\n\
                   filenr=1536 9223372036854775807\n\
                   ulimit=1024 524288\n\
                   procs=2 0\n";
        let d = parse_detail(raw);
        assert_eq!(d.mem_total, Some(8000));
        assert_eq!(d.mem_available, Some(4000));
        assert_eq!(d.mem_cached, Some(2000));
        assert_eq!(d.top_mem, "node 12%, postgres 8%");
        assert_eq!(d.file_nr_used, Some(1536));
        assert_eq!(d.file_nr_max, Some(9223372036854775807));
        assert_eq!(d.ulimit_soft, Some(1024));
        assert_eq!(d.ulimit_hard, Some(524288));
        assert_eq!(d.procs_running, Some(2));
        assert_eq!(d.procs_blocked, Some(0));
    }

    // The metrics scripts are shell with awk embedded inside Rust string escapes;
    // a stray backslash silently breaks awk at runtime. Run them through `sh` on
    // the dev machine to catch quoting regressions (output is /proc-dependent, so
    // we only assert the keys are emitted and the shell exits cleanly).
    #[test]
    fn detail_script_runs_in_a_shell_and_emits_keys() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(DETAIL_SCRIPT)
            .output()
            .expect("spawn sh");
        assert!(out.status.success(), "DETAIL_SCRIPT exited non-zero");
        let text = String::from_utf8_lossy(&out.stdout);
        for key in [
            "percpu=",
            "memdetail=",
            "parts=",
            "filenr=",
            "ulimit=",
            "tcp=",
            "sensors=",
            "cpubreak=",
            "topcpu=",
            "failed=",
            "listen=",
            "conntrack=",
            "timesync=",
            "netdev=",
            "diskdev=",
            "sessions=",
        ] {
            assert!(text.contains(key), "DETAIL_SCRIPT missing {key}: {text}");
        }
    }

    #[test]
    fn pending_script_runs_in_a_shell_and_emits_keys() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(PENDING_SCRIPT)
            .output()
            .expect("spawn sh");
        assert!(out.status.success(), "PENDING_SCRIPT exited non-zero");
        let text = String::from_utf8_lossy(&out.stdout);
        for key in ["mgr=", "updates=", "security=", "reboot="] {
            assert!(text.contains(key), "PENDING_SCRIPT missing {key}: {text}");
        }
    }

    #[test]
    fn extras_script_runs_in_a_shell_and_emits_keys() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(EXTRAS_SCRIPT)
            .output()
            .expect("spawn sh");
        assert!(out.status.success(), "EXTRAS_SCRIPT exited non-zero");
        let text = String::from_utf8_lossy(&out.stdout);
        for key in ["gpu=", "docker=", "oom=", "smart="] {
            assert!(text.contains(key), "EXTRAS_SCRIPT missing {key}: {text}");
        }
    }

    #[test]
    fn parse_extras_reads_gpu_docker_smart_oom() {
        let raw = "gpu=GeForce RTX 4090|35|1024|24576|61;\n\
                   docker=web|12.5|1.2GiB / 3.8GiB;db|3.0|512MiB / 2GiB;\n\
                   oom=2\n\
                   smart=sda|PASSED|38|12345;nvme0n1|PASSED||678;";
        let e = parse_extras(raw);
        assert_eq!(e.gpus.len(), 1);
        assert_eq!(e.gpus[0].name, "GeForce RTX 4090");
        assert_eq!(e.gpus[0].util, 35.0);
        assert_eq!(e.gpus[0].mem_total, 24576);
        assert_eq!(e.docker.len(), 2);
        assert_eq!(e.docker[0].name, "web");
        assert_eq!(e.docker[0].cpu, 12.5);
        assert_eq!(e.docker[0].mem, "1.2GiB / 3.8GiB");
        assert_eq!(e.oom_kills, Some(2));
        assert_eq!(e.smart.len(), 2);
        assert_eq!(e.smart[0].device, "sda");
        assert_eq!(e.smart[0].health, "PASSED");
        assert_eq!(e.smart[0].temp, Some(38.0));
        assert_eq!(e.smart[0].power_on_hours, Some(12345));
        // Missing temp field → None.
        assert_eq!(e.smart[1].temp, None);
        assert_eq!(e.smart[1].power_on_hours, Some(678));
        // Empty input → all empty.
        let empty = parse_extras("gpu=\ndocker=\noom=\nsmart=\n");
        assert!(empty.gpus.is_empty() && empty.docker.is_empty() && empty.smart.is_empty());
        assert_eq!(empty.oom_kills, None);
    }

    #[test]
    fn parse_pending_reads_manager_and_counts() {
        let p = parse_pending("mgr=apt\nupdates=12\nsecurity=3\nreboot=1\n");
        assert_eq!(p.manager, "apt");
        assert_eq!(p.updates, Some(12));
        assert_eq!(p.security, Some(3));
        assert!(p.reboot_required);
        // No recognized manager → empty/None, reboot false.
        let none = parse_pending("mgr=\nupdates=\nsecurity=\nreboot=0\n");
        assert!(none.manager.is_empty());
        assert_eq!(none.updates, None);
        assert!(!none.reboot_required);
    }

    // ── uuid_like ─────────────────────────────────────────────────────────────
    #[test]
    fn uuid_like_has_prefix_and_is_unique() {
        let a = uuid_like();
        assert!(a.starts_with("srv-"));
        // Hex suffix only.
        assert!(a["srv-".len()..].chars().all(|c| c.is_ascii_hexdigit()));
        let b = uuid_like();
        assert_ne!(a, b);
    }
}
