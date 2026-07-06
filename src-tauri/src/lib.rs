mod ai;
mod backup;
mod error;
mod folders;
mod localfile;
mod metrics;
mod model;
mod pty;
mod recording;
mod secrets;
mod servers;
mod servertools;
mod sftp;
mod ssh;
mod store;
mod sync;

use error::{AppError, AppResult};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use model::{AuthMethod, ProxyKind, ServerProfile};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use sftp::FileEntry;
use ssh::{ConnectOptions, Credential, HostKeyPolicy, ProxyJump, SshSession};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// Application state: persisted server profiles + the registry of live SSH sessions.
#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) servers: Mutex<Vec<ServerProfile>>,
    /// Explicit folder paths (incl. empty/nested) for organizing the server list.
    pub(crate) folders: Mutex<Vec<String>>,
    pub(crate) sessions: tokio::sync::Mutex<HashMap<String, Arc<SshSession>>>,
    /// Live local-shell PTYs (the "+" terminal tabs), keyed by session id.
    local_ptys: Mutex<HashMap<String, Arc<pty::LocalPty>>>,
    /// Cancellation flags for in-progress folder downloads, keyed by transfer id.
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Per-session sample stores for the metrics probes (CPU%, throughput, etc.);
    /// see [`metrics::MetricsSamples`]. Cleared on disconnect.
    pub(crate) metrics_samples: metrics::MetricsSamples,
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
pub(crate) async fn session_arc(
    state: &State<'_, AppState>,
    session_id: &str,
) -> AppResult<Arc<SshSession>> {
    state
        .sessions
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or(AppError::NoSession)
}

// ── AI-endpoint keychain commands ─────────────────────────────────────────────

/// Store an AI endpoint's API key in the keychain (Phase 17). Never logged.
#[tauri::command]
fn set_ai_key(endpoint_id: String, key: String) -> AppResult<()> {
    secrets::set_ai_key(&endpoint_id, &key)
}

/// Forget an AI endpoint's API key (on key clear or endpoint removal).
#[tauri::command]
fn forget_ai_key(endpoint_id: String) -> AppResult<()> {
    secrets::delete_ai_key(&endpoint_id)
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
// Tauri command: params arrive by name from JS (`invoke`), so they must stay as
// individual arguments — grouping them into a struct would change the wire
// contract with the frontend. (Terminal/host tunables are regrouped into
// `ssh::ConnectOptions` before hitting the backend.)
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

    // Resolve an optional proxy/jump host. Only the SSH jump kind is implemented;
    // socks5/http are accepted by the data model but rejected here (typed
    // `proxy-unsupported`) until those transports land. The jump host's secret
    // lives in the keychain under the proxy-scoped id (entered via the form).
    let proxy = match &profile.proxy {
        None => None,
        Some(px) => {
            if !matches!(px.kind, ProxyKind::Jump) {
                return Err(AppError::ProxyUnsupported);
            }
            let cred = match px.auth_method {
                AuthMethod::Password => {
                    let password = secrets::get_proxy_password(&server_id).ok_or_else(|| {
                        "proxy password required — set it in the server form".to_string()
                    })?;
                    Credential::Password(password)
                }
                AuthMethod::Key => {
                    let path = ssh::resolve_key_path(px.key_path.as_deref()).ok_or_else(|| {
                        "no proxy SSH key set and none found in ~/.ssh — pick a private key file"
                            .to_string()
                    })?;
                    let passphrase = secrets::get_proxy_passphrase(&server_id);
                    Credential::Key { path, passphrase }
                }
            };
            Some(ProxyJump {
                host: px.host.clone(),
                port: px.port,
                username: px.username.clone(),
                cred,
            })
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
        cols,
        rows,
        proxy,
    };

    let session = ssh::connect(
        app,
        session_id.clone(),
        &profile.host,
        profile.port,
        &profile.username,
        cred,
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
    state.metrics_samples.clear_session(&session_id);
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

    let rec = recording::Recorder::start(recording::RecorderConfig {
        path: path.clone(),
        cols,
        rows,
        title: &title,
        prompt: &prompt,
        env_json: &env,
        mask_enabled: mask_passwords,
        mode: recording::RecordMode::parse(&mode),
    })?;
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

/// Result of an AI agent command execution (17.8), returned to the dialog loop.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiExecResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
}

/// Execute a single command for the AI dialog/agent loop (17.8) on a dedicated
/// exec channel, capturing stdout/stderr/exit code. The step is mirrored into the
/// live terminal (`term://out`) and the active recording so the agent's actions
/// stay visible and audited. SSH sessions only; the frontend gates this by mode
/// and bars it on prod/`noAi` servers.
#[tauri::command]
async fn ai_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    timeout_secs: u64,
) -> AppResult<AiExecResult> {
    let session = session_arc(&state, &session_id).await?;
    let outcome = session.exec_captured(&command, timeout_secs).await?;

    // Mirror the step into the live terminal + recording so it stays visible + audited.
    let mirror = ai::agent_mirror(
        &command,
        &outcome.stdout,
        &outcome.stderr,
        outcome.exit_code,
        outcome.timed_out,
        timeout_secs,
    );
    let _ = app.emit(&ssh::output_event(&session_id), mirror.clone().into_bytes());
    session.record_output(mirror.as_bytes());

    Ok(AiExecResult {
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exit_code: outcome.exit_code,
        timed_out: outcome.timed_out,
    })
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
// Tauri command: args arrive by name from JS (`invoke`), so they must stay as
// individual parameters — grouping them into one struct would change the wire
// contract with the frontend. The cohesive write payload is regrouped internally
// into `sftp::TextWrite` before hitting the backend helpers.
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
    let req = sftp::TextWrite {
        path: &path,
        content: &content,
        eol: &eol,
        expected_sha256: expected_sha256.as_deref(),
        backup: backup.unwrap_or(false),
    };
    if sudo == Some(true) {
        let session = session_arc(&state, &session_id).await?;
        let sftp = session.sftp().await?;
        return sync::sudo_write(
            &session,
            &sftp,
            &req,
            sudo_password.as_deref().unwrap_or(""),
        )
        .await;
    }
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::write_text(&sftp, &req).await
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
/// the password via stdin; non-sudo commands (pip/brew) run as-is. Streams output
/// live over `install://out/{id}` (Phase 20.14) so the dialog console fills in as the
/// install runs, and also returns the full output so the one-shot contract holds.
#[tauri::command]
async fn run_tool_install(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    sudo_password: Option<String>,
) -> AppResult<String> {
    let session = session_arc(&state, &session_id).await?;
    let cmd = format!("{} 2>&1", servertools::sudoize(&command));
    let mut pw = sudo_password.unwrap_or_default().into_bytes();
    pw.push(b'\n');
    let event = ssh::install_output_event(&session_id);
    session
        .run_command_stdin_streaming(&cmd, &pw, |chunk| {
            let _ = app.emit(&event, String::from_utf8_lossy(chunk).into_owned());
        })
        .await
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
        metrics_samples: metrics::MetricsSamples::default(),
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
            servers::list_servers,
            servers::add_server,
            servers::update_server,
            servers::delete_server,
            servers::forget_secrets,
            servers::save_proxy_secret,
            folders::list_folders,
            folders::add_folder,
            folders::delete_folder,
            folders::move_folder,
            folders::rename_folder,
            folders::set_server_group,
            export_backup,
            import_backup,
            connect_plan,
            connect_session,
            open_local_terminal,
            write_to_terminal,
            resize_pty,
            disconnect,
            metrics::fetch_metrics,
            metrics::fetch_metrics_detail,
            metrics::fetch_pending_updates,
            metrics::fetch_extras,
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
            import_recording,
            ai::ai_chat,
            ai::cancel_ai_chat,
            ai::ai_models,
            ai_exec,
            set_ai_key,
            forget_ai_key
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
