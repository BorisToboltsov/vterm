// Terminal session commands of the bridge layer: connecting over SSH, the local
// shell, input, resize, disconnect and what the local shell reports (cwd).

use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use crate::model::{AuthMethod, ProxyKind};
use crate::ssh::{ConnectOptions, Credential, HostKeyPolicy, Proxy, ProxyJump, ProxyTcpAuth};
use crate::{appwin, end_session, localfile, pty, secrets, session_arc, ssh, store, AppState};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};

/// Tells the frontend whether it must prompt for a secret before connecting.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectPlan {
    needs_secret: bool,
    secret_label: String,
}

#[tauri::command]
pub fn connect_plan(id: String, state: State<AppState>) -> AppResult<ConnectPlan> {
    let profile = state
        .servers
        .locked()
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

/// What happened besides the connection itself. The session is up either way.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOutcome {
    /// Why "remember" did not persist the secret, if it did not.
    remember_failed: Option<String>,
}

/// A secret save after login is advisory: its failure becomes a reason to show,
/// not an error that would tear down the live session.
fn remember_failure(saved: AppResult<()>) -> Option<String> {
    saved.err().map(|e| e.to_string())
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
pub async fn connect_session(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    windows: State<'_, appwin::Windows>,
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
) -> AppResult<ConnectOutcome> {
    let profile = {
        let servers = state.servers.locked();
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

    // Replace any existing session with the same session id — and release a
    // previous attempt still waiting on login questions for it. The tab is this
    // window's from here on.
    end_session(&app, &session_id).await;
    windows.claim(&session_id, window.label());

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
    // secret is never written to the keychain). By now the session is live, so a
    // failed save is reported, never returned as an error: `?` here dropped an
    // authenticated connection whenever the keychain was unavailable (Linux
    // without a Secret Service), and the user could not connect at all.
    let mut outcome = ConnectOutcome::default();
    if remember {
        if let Some(s) = &secret {
            let saved = match profile.auth_method {
                AuthMethod::Password => secrets::set_password(&server_id, s).and_then(|()| {
                    let snapshot = {
                        let mut servers = state.servers.locked();
                        if let Some(p) = servers.iter_mut().find(|p| p.id == server_id) {
                            p.has_saved_password = true;
                        }
                        servers.clone()
                    };
                    store::save_servers(&snapshot)
                }),
                AuthMethod::Key => secrets::set_passphrase(&server_id, s),
            };
            outcome.remember_failed = remember_failure(saved);
        }
    }

    // The tab was closed while we were logging in: nobody would ever end this
    // session, so it ends here instead of being registered.
    if !windows.owns(&session_id, window.label()) {
        drop(session);
        return Err(AppError::NoSession);
    }
    state
        .session_servers
        .locked()
        .insert(session_id.clone(), server_id);
    state
        .sessions
        .lock()
        .await
        .insert(session_id, Arc::new(session));
    Ok(outcome)
}

/// Open a local-shell terminal (PTY on the machine running vterm) under the
/// per-tab `session_id`. Output/close events reuse the `term://…` channels, so
/// the frontend terminal widget drives it exactly like an SSH session.
#[tauri::command]
// Same as `connect_session`: the params are the wire contract with the frontend.
#[allow(clippy::too_many_arguments)]
pub async fn open_local_terminal(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    windows: State<'_, appwin::Windows>,
    session_id: String,
    cols: u32,
    rows: u32,
    shell: Option<String>,
) -> AppResult<()> {
    // Replace any existing session registered under this id; the tab is this
    // window's from here on.
    end_session(&app, &session_id).await;
    windows.claim(&session_id, window.label());

    let local = pty::open_local(app, session_id.clone(), cols, rows, shell)?;
    state
        .local_ptys
        .locked()
        .insert(session_id, Arc::new(local));
    Ok(())
}

/// The host OS the app is running on (`std::env::consts::OS`: "windows"/"macos"/
/// "linux"/…). Lets the frontend gate OS-specific settings — e.g. the Windows
/// local-shell picker — without pulling a runtime OS plugin into the WebView.
#[tauri::command]
pub fn host_os() -> &'static str {
    std::env::consts::OS
}

/// Whether `program` resolves to an executable — used by the local-shell picker to
/// gray out pwsh when PowerShell 7 isn't installed and to validate a custom shell
/// path. A path (containing a separator) is checked directly; a bare name is
/// looked up across `PATH` (honouring `PATHEXT` on Windows). Never spawns.
#[tauri::command]
pub fn shell_exists(program: String) -> bool {
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
pub async fn write_to_terminal(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> AppResult<()> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        return session.write_input(data).await;
    }
    let local = state.local_pty(&session_id);
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
pub async fn read_shell_history(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<String> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        return session.run_command(HISTORY_CMD).await;
    }
    if state.local_ptys.locked().contains_key(&session_id) {
        return localfile::read_shell_history(5000).await;
    }
    Err(AppError::NoSession)
}

#[tauri::command]
pub async fn resize_pty(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        session.resize(cols, rows).await?;
        return Ok(());
    }
    let local = state.local_pty(&session_id);
    if let Some(pty) = local {
        pty.resize(cols, rows)?;
    }
    Ok(())
}

/// End the session of a tab this window is closing. A window that gave the tab
/// away to another one no longer owns the session and cannot end it (ADR 0017).
#[tauri::command]
pub async fn disconnect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    windows: State<'_, appwin::Windows>,
    session_id: String,
) -> AppResult<()> {
    if windows.release(&session_id, window.label()) {
        end_session(&app, &session_id).await;
    }
    Ok(())
}

/// The working directory of a LOCAL shell, read from the OS (Phase 39.3).
///
/// This is the transport-appropriate half of "follow the terminal": a local tab
/// has a pid we can inspect, so following works with any shell and no setup at
/// all. SSH tabs have no local pid and still depend on the remote shell emitting
/// OSC 7 / OSC 9;9. `None` means "couldn't tell" (unknown session, or the OS
/// declined) — the caller leaves the panel where it is rather than guessing.
#[tauri::command]
pub fn local_cwd(state: State<AppState>, session_id: String) -> Option<String> {
    let local = state.local_pty(&session_id);
    local?.cwd()
}

/// Start or stop noting the folder each line typed into a LOCAL shell runs in
/// (v1.24, ADR 0035) — on while the tab's terminal shows file links. False
/// when there is no such session (yet).
#[tauri::command]
pub fn watch_local_submits(state: State<AppState>, session_id: String, on: bool) -> bool {
    let local = state.local_pty(&session_id);
    local.map(|pty| pty.watch_submits(on)).is_some()
}

/// The folder the last line typed into a LOCAL shell ran in, noted as it was
/// sent: `None` when the shell was running a program then (`ssh`, a REPL) —
/// the line was that program's — or the OS would not say.
#[tauri::command]
pub fn local_submitted_cwd(state: State<AppState>, session_id: String) -> Option<String> {
    let local = state.local_pty(&session_id);
    local?.submitted_cwd()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── connect_session: remembering a secret ─────────────────────────────────
    #[test]
    fn remember_failure_reports_the_reason_and_nothing_on_success() {
        assert_eq!(remember_failure(Ok(())), None);
        let err: AppError = "keychain write failed: No default store".to_string().into();
        assert_eq!(
            remember_failure(Err(err)).as_deref(),
            Some("keychain write failed: No default store")
        );
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
}
