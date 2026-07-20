mod ai;
mod backup;
mod container;
mod drives;
mod error;
mod folders;
mod git;
mod keygen;
mod kube;
mod localenv;
mod localfile;
mod metrics;
mod model;
mod netprobe;
mod proccwd;
mod pty;
mod recording;
mod secrets;
mod servers;
mod servertools;
mod sftp;
mod ssh;
mod store;
mod sync;
mod textenc;

use error::{AppError, AppResult};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use model::{AuthMethod, ProxyKind, ServerProfile};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use sftp::FileEntry;
use ssh::{ConnectOptions, Credential, HostKeyPolicy, Proxy, ProxyJump, ProxyTcpAuth, SshSession};
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

    // Resolve an optional proxy to reach the server through. The jump host uses
    // SSH credentials (password/passphrase in the keychain under the proxy-scoped
    // id); SOCKS5/HTTP use optional basic auth (a username on the profile + an
    // optional password in the keychain, same proxy-scoped id).
    let proxy = match &profile.proxy {
        None => None,
        Some(px) => Some(match px.kind {
            ProxyKind::Jump => {
                let cred = match px.auth_method {
                    AuthMethod::Password => {
                        let password =
                            secrets::get_proxy_password(&server_id).ok_or_else(|| {
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
                Proxy::Jump(ProxyJump {
                    host: px.host.clone(),
                    port: px.port,
                    username: px.username.clone(),
                    cred,
                })
            }
            ProxyKind::Socks5 | ProxyKind::Http => {
                // Basic auth is optional: only send a username (and read its
                // password from the keychain) when the profile carries one.
                let username = Some(px.username.trim())
                    .filter(|u| !u.is_empty())
                    .map(str::to_string);
                let password = if username.is_some() {
                    secrets::get_proxy_password(&server_id)
                } else {
                    None
                };
                let auth = ProxyTcpAuth { username, password };
                let (host, port) = (px.host.clone(), px.port);
                if matches!(px.kind, ProxyKind::Socks5) {
                    Proxy::Socks5 { host, port, auth }
                } else {
                    Proxy::Http { host, port, auth }
                }
            }
        }),
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
    shell: Option<String>,
) -> AppResult<()> {
    // Replace any existing session registered under this id.
    state.sessions.lock().await.remove(&session_id);
    state.local_ptys.lock().unwrap().remove(&session_id);

    let local = pty::open_local(app, session_id.clone(), cols, rows, shell)?;
    state
        .local_ptys
        .lock()
        .unwrap()
        .insert(session_id, Arc::new(local));
    Ok(())
}

/// The host OS the app is running on (`std::env::consts::OS`: "windows"/"macos"/
/// "linux"/…). Lets the frontend gate OS-specific settings — e.g. the Windows
/// local-shell picker — without pulling a runtime OS plugin into the WebView.
#[tauri::command]
fn host_os() -> &'static str {
    std::env::consts::OS
}

/// Whether `program` resolves to an executable — used by the local-shell picker to
/// gray out pwsh when PowerShell 7 isn't installed and to validate a custom shell
/// path. A path (containing a separator) is checked directly; a bare name is
/// looked up across `PATH` (honouring `PATHEXT` on Windows). Never spawns.
#[tauri::command]
fn shell_exists(program: String) -> bool {
    program_on_path(program.trim())
}

/// True when `prog` names an existing executable file: an explicit path is
/// checked as-is, a bare name is searched on each `PATH` entry (with `PATHEXT`
/// fallbacks on Windows).
fn program_on_path(prog: &str) -> bool {
    if prog.is_empty() {
        return false;
    }
    let path = std::path::Path::new(prog);
    if path.is_absolute() || path.components().count() > 1 {
        return executable_candidate(path);
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| executable_candidate(&dir.join(prog)))
}

/// Whether `path` (or, on Windows, a `PATHEXT` variant of it) is an existing file.
fn executable_candidate(path: &std::path::Path) -> bool {
    if path.is_file() {
        return true;
    }
    #[cfg(windows)]
    if path.extension().is_none() {
        if let Some(exts) = std::env::var_os("PATHEXT") {
            return std::env::split_paths(&exts).any(|ext| {
                let ext = ext.to_string_lossy();
                let ext = ext.trim().trim_start_matches('.');
                !ext.is_empty() && path.with_extension(ext).is_file()
            });
        }
    }
    false
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

/// POSIX-sh one-liner that prints the interactive shell's history file (zsh
/// preferred, then bash), bounded to the most recent lines. Wrapped in `sh -c` so
/// it parses the same way regardless of the login shell (fish, etc.). Runs on a
/// one-shot exec channel for the Ctrl+R history overlay (Phase 23).
const HISTORY_CMD: &str = "sh -c 'case \"$SHELL\" in *zsh*) F=\"$HOME/.zsh_history\";; *) F=\"$HOME/.bash_history\";; esac; [ -f \"$F\" ] || F=\"$HOME/.zsh_history\"; [ -f \"$F\" ] || F=\"$HOME/.bash_history\"; tail -n 5000 \"$F\" 2>/dev/null'";

/// Read the current session's shell history file (raw text) for the Ctrl+R
/// command-history overlay. SSH sessions run [`HISTORY_CMD`] on a dedicated exec
/// channel (not disturbing the interactive shell); local shell tabs read the
/// on-disk history directly. Parsing happens on the frontend (`history.ts`).
#[tauri::command]
async fn read_shell_history(state: State<'_, AppState>, session_id: String) -> AppResult<String> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        return session.run_command(HISTORY_CMD).await;
    }
    if state.local_ptys.lock().unwrap().contains_key(&session_id) {
        return localfile::read_shell_history(5000).await;
    }
    Err(AppError::NoSession)
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
    /// Broadcast batch id (group recording) — set only for recordings made as
    /// part of a synchronous-input group; absent for ordinary recordings.
    #[serde(skip_serializing_if = "Option::is_none")]
    batch_id: Option<String>,
    /// User-given name of the broadcast bundle, written to every member on stop.
    #[serde(skip_serializing_if = "Option::is_none")]
    batch_label: Option<String>,
}

/// Read the broadcast batch id from an asciicast header's `vterm.batch` (a plain
/// string written by the frontend's recording env). Pure → unit-tested.
fn batch_id_from_header(header: &serde_json::Value) -> Option<String> {
    header["vterm"]["batch"].as_str().map(str::to_owned)
}

/// Read the broadcast bundle name from `vterm.batchLabel` (set when the user
/// names the group recording after stopping it).
fn batch_label_from_header(header: &serde_json::Value) -> Option<String> {
    header["vterm"]["batchLabel"].as_str().map(str::to_owned)
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
        batch_id: batch_id_from_header(&header),
        batch_label: batch_label_from_header(&header),
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

/// Run one `git` command in `cwd` for the Git panel (Phase 29). Dispatches by
/// session kind exactly like [`read_shell_history`]: SSH tabs execute remotely
/// on a dedicated exec channel, local shell tabs spawn `git` locally. Argument
/// building and output parsing are pure frontend logic (`git.ts`); this only
/// executes and captures. `timed_out` from the SSH path collapses into a
/// non-zero exit + stderr note so the frontend sees a uniform `GitOutput`.
/// `mirror` (mutating ops only) audits the command into the active session
/// recording as `[git] $ …` output — never emitted to the live terminal, so the
/// GUI stays clean while the recording keeps a complete audit trail.
#[tauri::command]
async fn git_run(
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
    args: Vec<String>,
    timeout_secs: u64,
    mirror: bool,
) -> AppResult<git::GitOutput> {
    if args.is_empty() {
        return Err(AppError::Message("git: no arguments".into()));
    }
    if let Ok(session) = session_arc(&state, &session_id).await {
        let outcome = session
            .exec_captured(&git::ssh_command(&cwd, &args), timeout_secs.max(1))
            .await?;
        let (stderr, exit_code) = if outcome.timed_out {
            (format!("git timed out after {}s", timeout_secs.max(1)), -1)
        } else {
            (outcome.stderr, outcome.exit_code)
        };
        if mirror {
            let cmd = format!("git {}", args.join(" "));
            session.record_output(
                git::git_mirror(&cmd, &outcome.stdout, &stderr, exit_code).as_bytes(),
            );
        }
        return Ok(git::GitOutput {
            stdout: outcome.stdout,
            stderr,
            exit_code,
        });
    }
    let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
    if let Some(pty) = local {
        let out = git::run_local(&cwd, &args, timeout_secs).await?;
        if mirror {
            let cmd = format!("git {}", args.join(" "));
            pty.record_output(
                git::git_mirror(&cmd, &out.stdout, &out.stderr, out.exit_code).as_bytes(),
            );
        }
        return Ok(out);
    }
    Err(AppError::NoSession)
}

/// Run one network-diagnostic command for the Utilities panel (Phase 34). SSH
/// only (variant A): the probe runs on the user's server via a dedicated exec
/// channel, so the traffic originates from that server — never from the app. A
/// local tab has no session here; the frontend runs it in the PTY instead
/// (variant B), so a missing SSH session collapses to `NoSession`. Argument
/// building and output parsing are pure frontend logic; this only executes and
/// captures. A timeout collapses into a non-zero exit + stderr note so the
/// frontend sees a uniform `ProbeOutput`. `mirror` audits the command into the
/// active session recording as `[util] $ …` output — never emitted to the live
/// terminal, exactly like `git_run`/`container_run`.
#[tauri::command]
async fn probe_run(
    state: State<'_, AppState>,
    session_id: String,
    args: Vec<String>,
    timeout_secs: u64,
    mirror: bool,
) -> AppResult<netprobe::ProbeOutput> {
    if args.is_empty() {
        return Err(AppError::Message("probe: no arguments".into()));
    }
    let session = session_arc(&state, &session_id).await?;
    let cmd = netprobe::probe_command(&args);
    let outcome = session.exec_captured(&cmd, timeout_secs.max(1)).await?;
    let (stderr, exit_code) = if outcome.timed_out {
        (
            format!("probe timed out after {}s", timeout_secs.max(1)),
            -1,
        )
    } else {
        (outcome.stderr, outcome.exit_code)
    };
    if mirror {
        session.record_output(
            netprobe::probe_mirror(&cmd, &outcome.stdout, &stderr, exit_code).as_bytes(),
        );
    }
    Ok(netprobe::ProbeOutput {
        stdout: outcome.stdout,
        stderr,
        exit_code,
    })
}

/// Run one `docker` command for the Docker panel (Phase 35). Dispatches by
/// session kind exactly like [`git_run`]: SSH tabs execute remotely on a
/// dedicated exec channel, local shell tabs spawn `docker` locally. `args[0]` is
/// the program (`docker`), the rest its arguments; argument building and output
/// parsing are pure frontend logic (`docker.ts`), this only executes and
/// captures. A timeout collapses into a non-zero exit + stderr note so the
/// frontend sees a uniform `ContainerOutput`. `mirror` (mutating ops only, set by
/// the frontend) audits the command into the active session recording as
/// `[docker] $ …` output — never emitted to the live terminal, exactly like
/// `git_run`. Reads/polls pass `mirror = false`; registry login goes through the
/// dedicated `docker_login` (secret on stdin) and is never mirrored.
#[tauri::command]
async fn container_run(
    state: State<'_, AppState>,
    session_id: String,
    args: Vec<String>,
    timeout_secs: u64,
    mirror: bool,
) -> AppResult<container::ContainerOutput> {
    if args.is_empty() {
        return Err(AppError::Message("container: no arguments".into()));
    }
    if let Ok(session) = session_arc(&state, &session_id).await {
        let outcome = session
            .exec_captured(&container::container_command(&args), timeout_secs.max(1))
            .await?;
        let (stderr, exit_code) = if outcome.timed_out {
            (
                format!("docker timed out after {}s", timeout_secs.max(1)),
                -1,
            )
        } else {
            (outcome.stderr, outcome.exit_code)
        };
        if mirror {
            let cmd = args.join(" ");
            session.record_output(
                container::container_mirror(&cmd, &outcome.stdout, &stderr, exit_code).as_bytes(),
            );
        }
        return Ok(container::ContainerOutput {
            stdout: outcome.stdout,
            stderr,
            exit_code,
        });
    }
    let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
    if let Some(pty) = local {
        let out = container::run_local(&args, timeout_secs).await?;
        if mirror {
            let cmd = args.join(" ");
            pty.record_output(
                container::container_mirror(&cmd, &out.stdout, &out.stderr, out.exit_code)
                    .as_bytes(),
            );
        }
        return Ok(out);
    }
    Err(AppError::NoSession)
}

/// Store a Docker registry password in the OS keychain, keyed by registry url
/// (Phase 36). The non-secret half (url + username) lives in frontend settings;
/// the password is only ever here and fed to `docker login --password-stdin`.
#[tauri::command]
fn set_registry_secret(url: String, secret: String) -> AppResult<()> {
    let secret = zeroize::Zeroizing::new(secret);
    secrets::set_registry_password(&url, &secret)
}

/// Forget a stored Docker registry password (Phase 36).
#[tauri::command]
fn delete_registry_secret(url: String) -> AppResult<()> {
    secrets::delete_registry_password(&url)
}

/// Log the session's docker into a registry (Phase 36). Reads the password from
/// the keychain (never crossing the JS boundary at login time) and feeds it to
/// `docker login --password-stdin` so it never appears on a command line, in
/// `ps`, or in the recording. Dispatches by session kind like `container_run`;
/// the network call originates from the user's host, keeping the offline
/// invariant intact. `args` is built by the frontend (`docker.ts loginArgs`).
#[tauri::command]
async fn docker_login(
    state: State<'_, AppState>,
    session_id: String,
    url: String,
    args: Vec<String>,
) -> AppResult<container::ContainerOutput> {
    if args.is_empty() {
        return Err(AppError::Message("docker login: no arguments".into()));
    }
    let Some(secret) = secrets::get_registry_password(&url) else {
        return Err(AppError::Message(
            "no saved password for this registry".into(),
        ));
    };
    if let Ok(session) = session_arc(&state, &session_id).await {
        let outcome = session
            .exec_captured_stdin(&container::container_command(&args), secret.as_bytes(), 30)
            .await?;
        let (stderr, exit_code) = if outcome.timed_out {
            ("docker login timed out after 30s".to_string(), -1)
        } else {
            (outcome.stderr, outcome.exit_code)
        };
        return Ok(container::ContainerOutput {
            stdout: outcome.stdout,
            stderr,
            exit_code,
        });
    }
    let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
    if local.is_some() {
        return container::run_local_stdin(&args, secret.as_bytes(), 30).await;
    }
    Err(AppError::NoSession)
}

/// Run one `kubectl` command for the Kubernetes panel (Phase 37). Dispatches by
/// session kind exactly like [`container_run`]: SSH tabs execute remotely on a
/// dedicated exec channel, local shell tabs spawn `kubectl` locally. `args` is a
/// full argv whose leading token(s) are the program (`kubectl`, or a configured
/// wrapper like `k3s kubectl`) with the `--context`/`--namespace`/`-A` scope
/// already baked in by the frontend (`k8s.ts`); argument building and output
/// parsing are pure frontend logic, this only executes and captures. A timeout
/// collapses into a non-zero exit + stderr note so the frontend sees a uniform
/// `KubeOutput`. `mirror` (mutating ops only, set by the frontend) audits the
/// command into the active session recording as `[k8s] $ …` output — never
/// emitted to the live terminal, exactly like `container_run`. Reads/polls pass
/// `mirror = false`.
#[tauri::command]
async fn kubectl_run(
    state: State<'_, AppState>,
    session_id: String,
    args: Vec<String>,
    timeout_secs: u64,
    mirror: bool,
) -> AppResult<kube::KubeOutput> {
    if args.is_empty() {
        return Err(AppError::Message("kube: no arguments".into()));
    }
    if let Ok(session) = session_arc(&state, &session_id).await {
        let outcome = session
            .exec_captured(&kube::kube_command(&args), timeout_secs.max(1))
            .await?;
        let (stderr, exit_code) = if outcome.timed_out {
            (
                format!("kubectl timed out after {}s", timeout_secs.max(1)),
                -1,
            )
        } else {
            (outcome.stderr, outcome.exit_code)
        };
        if mirror {
            let cmd = args.join(" ");
            session.record_output(
                kube::kube_mirror(&cmd, &outcome.stdout, &stderr, exit_code).as_bytes(),
            );
        }
        return Ok(kube::KubeOutput {
            stdout: outcome.stdout,
            stderr,
            exit_code,
        });
    }
    let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
    if let Some(pty) = local {
        let out = kube::run_local(&args, timeout_secs).await?;
        if mirror {
            let cmd = args.join(" ");
            pty.record_output(
                kube::kube_mirror(&cmd, &out.stdout, &out.stderr, out.exit_code).as_bytes(),
            );
        }
        return Ok(out);
    }
    Err(AppError::NoSession)
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

/// Name a broadcast bundle: write `label` into `vterm.batchLabel` of every
/// recording that shares `batch_id`. Used by the "name this broadcast" prompt
/// after stopping a group recording.
#[tauri::command]
fn set_batch_label(batch_id: String, label: String) -> AppResult<()> {
    let Some(dir) = recording::recordings_dir() else {
        return Ok(());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().is_none_or(|e| e != "cast") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&p) else {
            continue;
        };
        let matches = content
            .lines()
            .next()
            .and_then(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .and_then(|h| batch_id_from_header(&h))
            .is_some_and(|id| id == batch_id);
        if !matches {
            continue;
        }
        if let Some(updated) = recording::with_batch_label(&content, &label) {
            let _ = std::fs::write(&p, updated);
        }
    }
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

/// Audit a mutating SFTP op into the session recording (like `container_run`'s
/// mirror): `op` is a shell-like description with paths quoted; a successful
/// outcome records `[sftp] $ … / [sftp] exit 0`, a failure adds the error text and
/// `exit 1`. Record-only — never emitted to the live terminal. Reads (list/read/
/// grep/hash) are NOT audited. Generic over the outcome type so it covers both the
/// `()` ops and `write_text`'s `WriteResult`.
fn record_sftp<T>(session: &SshSession, op: &str, res: &AppResult<T>) {
    let (code, detail) = match res {
        Ok(_) => (0, String::new()),
        Err(e) => (1, e.to_string()),
    };
    session.record_output(sftp::sftp_mirror(op, code, &detail).as_bytes());
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
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    let res = sftp::mkdir(&sftp, &path).await;
    record_sftp(
        &session,
        &format!("mkdir {}", git::shell_quote(&path)),
        &res,
    );
    res
}

#[tauri::command]
async fn sftp_create_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    let res = sftp::create_file(&sftp, &path).await;
    record_sftp(
        &session,
        &format!("touch {}", git::shell_quote(&path)),
        &res,
    );
    res
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
    encoding: Option<String>,
    expected_sha256: Option<String>,
    sudo: Option<bool>,
    sudo_password: Option<String>,
    backup: Option<bool>,
) -> AppResult<sftp::WriteResult> {
    // The editor echoes back the encoding `read_text` reported, so the file is
    // rewritten in the encoding it arrived in. An older/absent value means UTF-8.
    let encoding = encoding.unwrap_or_else(|| textenc::default_encoding().into());
    let req = sftp::TextWrite {
        path: &path,
        content: &content,
        eol: &eol,
        encoding: &encoding,
        expected_sha256: expected_sha256.as_deref(),
        backup: backup.unwrap_or(false),
    };
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    let res = if sudo == Some(true) {
        sync::sudo_write(
            &session,
            &sftp,
            &req,
            sudo_password.as_deref().unwrap_or(""),
        )
        .await
    } else {
        sftp::write_text(&sftp, &req).await
    };
    // Audit the edit as a byte-sized save (the content itself is never recorded).
    record_sftp(
        &session,
        &format!("save {} ({} B)", git::shell_quote(&path), content.len()),
        &res,
    );
    res
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
    encoding: Option<String>,
    expected_sha256: Option<String>,
) -> AppResult<sftp::WriteResult> {
    let encoding = encoding.unwrap_or_else(|| textenc::default_encoding().into());
    localfile::write_text(&path, &content, &eol, &encoding, expected_sha256.as_deref()).await
}

/// The working directory of a LOCAL shell, read from the OS (Phase 39.3).
///
/// This is the transport-appropriate half of "follow the terminal": a local tab
/// has a pid we can inspect, so following works with any shell and no setup at
/// all. SSH tabs have no local pid and still depend on the remote shell emitting
/// OSC 7 / OSC 9;9. `None` means "couldn't tell" (unknown session, or the OS
/// declined) — the caller leaves the panel where it is rather than guessing.
#[tauri::command]
fn local_cwd(state: State<AppState>, session_id: String) -> Option<String> {
    let local = state.local_ptys.lock().unwrap().get(&session_id).cloned();
    local?.cwd()
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

/// Move a local file/folder to a new path (drag-to-move within the local panel).
/// Refuses if `to` already exists.
#[tauri::command]
async fn local_rename(from: String, to: String) -> AppResult<()> {
    localfile::rename(&from, &to).await
}

/// Copy a local file/folder to a new path (paste after copy in the local panel).
/// Refuses if `to` already exists.
#[tauri::command]
async fn local_copy(from: String, to: String) -> AppResult<()> {
    localfile::copy(&from, &to).await
}

// ── SSH key generation utility (Phase 32) ──────────────────────────────────────

/// Generate an OpenSSH key pair (local, offline) and write it under the chosen
/// path. RSA generation is CPU-heavy, so it runs on a blocking thread to keep the
/// UI responsive.
#[tauri::command]
async fn generate_ssh_key(req: keygen::GenerateRequest) -> AppResult<keygen::GeneratedKey> {
    tokio::task::spawn_blocking(move || keygen::generate(req))
        .await
        .map_err(|e| AppError::Message(e.to_string()))?
}

/// Whether a key file already exists at `path` (`~` expanded). Backs the live
/// collision hint in the generate dialog.
#[tauri::command]
fn key_path_exists(path: String) -> bool {
    keygen::path_exists(&path)
}

/// (Re)write the public key to `<path>.pub` — the explicit "Save .pub" button.
#[tauri::command]
fn save_public_key(path: String, public_key: String) -> AppResult<String> {
    keygen::save_public_key(&path, &public_key)
}

// ── known_hosts manager utility (Phase 33) ─────────────────────────────────────

/// One entry of the vterm-managed known_hosts store, for the manager utility.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KnownHostEntry {
    /// `host:port` identifier.
    id: String,
    /// Recorded SHA256 host-key fingerprint.
    fingerprint: String,
}

/// List every recorded host key (`host:port` → fingerprint). Local file read only.
#[tauri::command]
fn list_known_hosts() -> Vec<KnownHostEntry> {
    store::list_host_keys()
        .into_iter()
        .map(|(id, fingerprint)| KnownHostEntry { id, fingerprint })
        .collect()
}

/// Forget the recorded host key for `id`. Returns whether an entry was removed.
#[tauri::command]
fn remove_known_host(id: String) -> bool {
    store::forget_host_key(&id)
}

/// Config files that failed to parse during the startup load and were moved
/// aside. Drains the list, so the frontend shows each warning exactly once.
#[tauri::command]
fn take_store_warnings() -> Vec<store::StoreWarning> {
    store::take_warnings()
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

/// List every config file nginx actually loads on the server, via `nginx -T` (it
/// resolves `include` globs/recursion itself). Used by the editor to recognise nginx
/// configs that live outside the `/etc/nginx/` tree. Best-effort: empty list when
/// nginx is absent or its config isn't readable. When a `sudo_password` is supplied
/// (reused from an open-as-root, never a fresh prompt) the dump runs under sudo, so a
/// root-only config tree is still resolved; otherwise the caller falls back to path
/// detection without interrupting the user.
#[tauri::command]
async fn nginx_config_files(
    state: State<'_, AppState>,
    session_id: String,
    sudo_password: Option<String>,
) -> AppResult<Vec<String>> {
    let session = session_arc(&state, &session_id).await?;
    if let Some(pw) = sudo_password.filter(|p| !p.is_empty()) {
        return sync::nginx_config_files_sudo(&session, &pw).await;
    }
    let out = session
        .run_command(sync::nginx_config_dump_command())
        .await
        .unwrap_or_default();
    Ok(sync::parse_nginx_config_files(&out))
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
    name: Option<String>,
    sudo_password: Option<String>,
) -> AppResult<sync::LintResult> {
    let Some(tool) = sync::lint_tool(&kind) else {
        return Ok(sync::LintResult::default());
    };
    let session = session_arc(&state, &session_id).await?;
    // Is the tool installed? (sbin is on PATH for daemon validators.)
    let chk = session
        .run_command(&sync::lint_check_command(&tool))
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
    // Suffix-sensitive tools (systemd-analyze) keep the source file's unit extension.
    let sftp = session.sftp().await?;
    let home = sftp
        .canonicalize(".")
        .await
        .map_err(|e| format!("home dir: {e}"))?;
    let mut tmp = format!("{}/.vterm-lint-{}", home.trim_end_matches('/'), uuid_like());
    if tool.suffix {
        tmp = format!(
            "{tmp}.{}",
            sync::lint_tmp_ext(name.as_deref().unwrap_or(""))
        );
    }
    sftp::write_bytes(&sftp, &tmp, content.as_bytes()).await?;
    let out = sync::run_lint(&session, &tool, &tmp, sudo_password.as_deref()).await;
    let _ = sftp.remove_file(tmp.clone()).await;
    // Replace both the full temp path and its basename with `FILE`, since validators
    // vary in which they print.
    let base = tmp.rsplit('/').next().unwrap_or(&tmp).to_string();
    let output = out.replace(&tmp, "FILE").replace(&base, "FILE");
    Ok(sync::LintResult {
        tool: tool.bin.to_string(),
        found: true,
        output,
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
///
/// `run_id` registers the run in the shared cancel map, so `sftp_cancel` stops it
/// the same way it stops a folder download — no second cancellation mechanism.
/// The run lands in the session recording as ONE `[sftp] $ sync …` entry (audit
/// contract, Phase 37.2), not one per file; `exit 130` marks a user stop.
#[tauri::command]
async fn sftp_sync_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    run_id: String,
    local_root: String,
    remote_root: String,
    actions: Vec<sync::SyncAction>,
) -> AppResult<sync::SyncStats> {
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    let op = sync::sync_mirror_op(&local_root, &remote_root, actions.len());
    let body = sync::sync_mirror_body(&actions);

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .unwrap()
        .insert(run_id.clone(), cancel.clone());
    let res = sync::apply(&app, &sftp, &local_root, &remote_root, actions, cancel).await;
    state.cancels.lock().unwrap().remove(&run_id);

    let (code, detail) = match &res {
        Ok(stats) if stats.stopped => (130, format!("{body}\nstopped by user")),
        Ok(_) => (0, body),
        Err(e) => (1, format!("{body}\n{e}")),
    };
    session.record_output(sftp::sftp_mirror(&op, code, &detail).as_bytes());
    res
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
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    let res = sftp::remove(&sftp, &path, is_dir).await;
    let op = if is_dir {
        format!("rm -r {}", git::shell_quote(&path))
    } else {
        format!("rm {}", git::shell_quote(&path))
    };
    record_sftp(&session, &op, &res);
    res
}

/// Move a remote file/folder to a new path (drag-to-move within the SFTP panel).
/// Refuses if `to` already exists; both paths are on the same session.
#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    let res = sftp::rename(&sftp, &from, &to).await;
    record_sftp(
        &session,
        &format!("mv {} {}", git::shell_quote(&from), git::shell_quote(&to)),
        &res,
    );
    res
}

/// Copy a remote file/folder to a new path (paste after copy in the SFTP panel).
/// Refuses if `to` already exists; both paths are on the same session.
#[tauri::command]
async fn sftp_copy(
    state: State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    let res = sftp::copy(&sftp, &from, &to).await;
    record_sftp(
        &session,
        &format!("cp {} {}", git::shell_quote(&from), git::shell_quote(&to)),
        &res,
    );
    res
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
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    let res = sftp::upload(&app, transfer_id, &sftp, &local_path, &remote_path).await;
    record_sftp(
        &session,
        &format!(
            "put {} -> {}",
            git::shell_quote(&local_path),
            git::shell_quote(&remote_path)
        ),
        &res,
    );
    res
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
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    let res = if is_dir {
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
    };
    record_sftp(
        &session,
        &format!(
            "get {} -> {}",
            git::shell_quote(&remote_path),
            git::shell_quote(&local_path)
        ),
        &res,
    );
    res
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
            servers::set_server_notes,
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
            host_os,
            shell_exists,
            write_to_terminal,
            read_shell_history,
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
            local_cwd,
            take_pending_opens,
            generate_ssh_key,
            key_path_exists,
            save_public_key,
            list_known_hosts,
            remove_known_host,
            take_store_warnings,
            local_home,
            local_list,
            local_mkdir,
            local_create_file,
            local_delete,
            local_rename,
            local_copy,
            sftp_hash_tree,
            local_hash_tree,
            sftp_sync_apply,
            sftp_grep,
            lint_remote,
            nginx_config_files,
            server_tools_status,
            run_tool_install,
            sftp_delete,
            sftp_rename,
            sftp_copy,
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
            set_batch_label,
            read_recording,
            export_recording,
            import_recording,
            ai::ai_chat,
            ai::cancel_ai_chat,
            ai::ai_models,
            ai_exec,
            git_run,
            probe_run,
            container_run,
            kubectl_run,
            docker_login,
            set_registry_secret,
            delete_registry_secret,
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

    // ── program_on_path ───────────────────────────────────────────────────────
    #[test]
    fn program_on_path_finds_current_exe_by_absolute_path() {
        let exe = std::env::current_exe().unwrap();
        assert!(program_on_path(exe.to_str().unwrap()));
    }

    #[test]
    fn program_on_path_rejects_empty_and_missing() {
        assert!(!program_on_path(""));
        assert!(!program_on_path("   "));
        assert!(!program_on_path("vterm-definitely-not-a-real-program-xyz"));
        // An explicit path that does not exist is not resolved.
        assert!(!program_on_path("/no/such/dir/nope-shell"));
    }

    // ── batch_id_from_header ──────────────────────────────────────────────────
    #[test]
    fn batch_id_read_from_vterm() {
        let h = serde_json::json!({ "vterm": { "batch": "bcast-42" } });
        assert_eq!(batch_id_from_header(&h), Some("bcast-42".to_owned()));
    }

    #[test]
    fn batch_id_absent_for_ordinary_recordings() {
        assert_eq!(
            batch_id_from_header(&serde_json::json!({ "vterm": {} })),
            None
        );
        assert_eq!(batch_id_from_header(&serde_json::json!({})), None);
        // A non-string batch is ignored, not coerced.
        let h = serde_json::json!({ "vterm": { "batch": 5 } });
        assert_eq!(batch_id_from_header(&h), None);
    }

    #[test]
    fn batch_label_read_from_vterm() {
        let h = serde_json::json!({ "vterm": { "batchLabel": "Nightly deploy" } });
        assert_eq!(
            batch_label_from_header(&h),
            Some("Nightly deploy".to_owned())
        );
        assert_eq!(
            batch_label_from_header(&serde_json::json!({ "vterm": {} })),
            None
        );
    }
}
