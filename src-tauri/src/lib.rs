mod backup;
mod error;
mod model;
mod pty;
mod recording;
mod secrets;
mod sftp;
mod ssh;
mod store;

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
use tauri::{AppHandle, Emitter, State};

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
    /// Last cumulative (ctxt, intr) counters + instant per session, for rate deltas.
    ctxintr_samples: Mutex<HashMap<String, (u64, u64, Instant)>>,
}

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

/// Write a backup (servers + folders + UI settings) to `path` as JSON. Secrets
/// are never included (they live in the keychain). `settings` is the frontend's
/// opaque settings snapshot.
#[tauri::command]
fn export_backup(
    path: String,
    settings: Option<serde_json::Value>,
    state: State<AppState>,
) -> AppResult<()> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let servers = state.servers.lock().unwrap().clone();
    let folders = backup::normalize_folders(state.folders.lock().unwrap().clone());
    let exported_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let doc = backup::build(servers, folders, settings, exported_at);
    let json = backup::encode(&doc)?;
    std::fs::write(&path, json).map_err(|e| AppError::Message(format!("write {path}: {e}")))
}

/// Result of importing a backup: counts restored + the UI settings to apply.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    server_count: usize,
    folder_count: usize,
    settings: Option<serde_json::Value>,
}

/// Restore a backup from `path`, **replacing** the current servers and folders
/// (persisted). Returns counts and the UI settings for the frontend to apply.
#[tauri::command]
fn import_backup(path: String, state: State<AppState>) -> AppResult<ImportResult> {
    let bytes = std::fs::read(&path).map_err(|e| AppError::Message(format!("read {path}: {e}")))?;
    let doc = backup::decode(&bytes)?;

    let servers = doc.servers;
    let folders = backup::normalize_folders(doc.folders);
    store::save_servers(&servers)?;
    store::save_folders(&folders)?;

    let result = ImportResult {
        server_count: servers.len(),
        folder_count: folders.len(),
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
    state.ctxintr_samples.lock().unwrap().remove(&session_id);
    Ok(())
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
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let header = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| c.lines().next().map(str::to_owned))
            .and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok());
        let h = header.unwrap_or(serde_json::Value::Null);
        let title = h["title"].as_str().unwrap_or("").to_owned();
        out.push(RecordingMeta {
            path: path.to_string_lossy().into_owned(),
            // Older recordings have no `server` field → fall back to the title.
            server: h["server"].as_str().unwrap_or(&title).to_owned(),
            title,
            description: h["description"].as_str().unwrap_or("").to_owned(),
            width: h["width"].as_u64().unwrap_or(80) as u32,
            height: h["height"].as_u64().unwrap_or(24) as u32,
            timestamp: h["timestamp"].as_u64().unwrap_or(0),
            size,
        });
    }
    out.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
    Ok(out)
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
    sftp::list(&sftp, &path).await
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
fn uuid_like() -> String {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        ctxintr_samples: Mutex::new(HashMap::new()),
    };

    tauri::Builder::default()
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
            sftp_home,
            sftp_list,
            sftp_mkdir,
            sftp_create_file,
            sftp_delete,
            sftp_upload,
            sftp_download,
            sftp_cancel,
            read_clipboard_text,
            set_menu_language,
            start_recording,
            stop_recording,
            set_recording_paused,
            list_recordings,
            delete_recording,
            set_recording_meta,
            read_recording,
            export_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
