// sudo commands of the bridge layer (ADR 0073): what is known of sudo on a
// session before any password is tried, the check that takes a typed password
// once (and saves it in the keychain when asked), and the one helper every sudo
// step of a session gets its password from. The reading of sudo's answers and
// the order of the saved passwords are `sudo.rs`'s.

use crate::diag::Logged;
use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use crate::model::AuthMethod;
use crate::ssh::SshSession;
use crate::sudo::{Route, Saved, Tried, Via};
use crate::{secrets, session_arc, store, AppState};
use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

/// The saved passwords sudo may be offered on this session: the sudo password
/// of the login it logged in as, and that login's password when it logs in with
/// one (ADR 0074 — each login its own; a one-off login has none). Read from the
/// keychain here and nowhere else in the bridge.
fn saved_for(state: &AppState, session_id: &str) -> Saved {
    let Some(scope) = state.session_login(session_id).and_then(|l| {
        let password = l.auth_method == AuthMethod::Password;
        l.scope.map(|s| (s, password))
    }) else {
        return Saved::default();
    };
    let (scope, password) = scope;
    Saved {
        sudo: secrets::get_sudo_password(&scope),
        login: password.then(|| secrets::get_password(&scope)).flatten(),
    }
}

/// Whether those saved passwords exist — the hint of the editor, before any try.
fn has_saved(state: &AppState, session_id: &str) -> (bool, bool) {
    let saved = saved_for(state, session_id);
    (saved.sudo.is_some(), saved.login.is_some())
}

/// The password every sudo step of a session runs with: what sudo took before,
/// none, the saved sudo password, the login password — or why none (ADR 0073).
pub(crate) async fn sudo_password(
    state: &AppState,
    session_id: &str,
    session: &SshSession,
) -> AppResult<Option<Zeroizing<String>>> {
    let res = session
        .sudo_resolve(|| saved_for(state, session_id), None)
        .await;
    tell(session_id, &res);
    res.map(|(pw, _)| pw)
}

/// A sudo step turned down the password the session remembered (it was changed
/// meanwhile): forget it, so the next step asks.
pub(crate) async fn forget_refused(session: &SshSession, res: &AppError) {
    if matches!(res, AppError::SudoPasswordRejected) {
        session.sudo_drop_taken().await;
    }
}

/// What the diagnostics say of a resolve: who took it, or why not. Never a password.
fn tell(session_id: &str, res: &AppResult<(Option<Zeroizing<String>>, Via)>) {
    match res {
        Ok((_, via)) => tracing::debug!(
            source = "editor",
            code = "sudo-ready",
            sid = session_id,
            via = ?via,
            "sudo agreed"
        ),
        Err(AppError::SudoPasswordRequired(Tried::Saved)) => tracing::warn!(
            source = "editor",
            code = "sudo-saved-stale",
            sid = session_id,
            "the sudo password saved in the keychain was turned down: it was changed on the server, and sudo asks for the new one"
        ),
        Err(AppError::SudoPasswordRejected) => tracing::info!(
            source = "editor",
            code = "sudo-wrong-password",
            sid = session_id,
            "sudo did not take the password typed for it"
        ),
        Err(AppError::SudoRefused { why, said }) => tracing::warn!(
            source = "editor",
            code = "sudo-refused",
            sid = session_id,
            why = %why,
            "sudo refused, whatever the password: {said}"
        ),
        Err(_) => {}
    }
}

/// What is known of sudo on a session before any password is tried: ready, a
/// saved password to try, a password wanted, or refused and why.
#[tauri::command]
pub async fn sudo_route(state: State<'_, AppState>, session_id: String) -> AppResult<Route> {
    let session = session_arc(&state, &session_id).await?;
    let route = session
        .sudo_route(|| has_saved(&state, &session_id))
        .await?;
    if let Route::Refused { why, said } = &route {
        tracing::warn!(
            source = "editor",
            code = "sudo-refused",
            sid = %session_id,
            why = %why,
            "sudo refused, whatever the password: {said}"
        );
    }
    Ok(route)
}

/// What a check came to: whose password sudo took, and whether saving the
/// typed one in the keychain failed — advice, never a failure of the check.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SudoChecked {
    pub via: Via,
    pub remember_failed: bool,
}

/// Get sudo going on a session: with the password typed into the prompt (the one
/// way a typed sudo password reaches the backend), or — nothing typed — with
/// what the session took or has saved. `remember` saves a typed password sudo
/// took in the keychain, under the session's server.
#[tauri::command]
pub async fn sudo_check(
    state: State<'_, AppState>,
    session_id: String,
    password: Option<String>,
    remember: bool,
) -> AppResult<SudoChecked> {
    let typed = password.map(Zeroizing::new);
    let session = session_arc(&state, &session_id).await?;
    let res = session
        .sudo_resolve(|| saved_for(&state, &session_id), typed.clone())
        .await;
    tell(&session_id, &res);
    let (_, via) = res?;
    let mut checked = SudoChecked {
        via,
        remember_failed: false,
    };
    let login = state.session_login(&session_id);
    let place = login
        .as_ref()
        .and_then(|l| Some((l.scope.clone()?, l.login_id.clone()?)));
    if remember && via == Via::Typed {
        if let (Some(pw), Some(server), Some((scope, login_id))) =
            (&typed, state.session_server(&session_id), place)
        {
            let saved = secrets::set_sudo_password(&scope, pw).and_then(|()| {
                let snapshot = {
                    let mut servers = state.servers.locked();
                    if let Some((_, sudo)) = servers
                        .iter_mut()
                        .find(|p| p.id == server.id)
                        .and_then(|p| p.login_hints_mut(&login_id))
                    {
                        *sudo = true;
                    }
                    servers.clone()
                };
                store::save_servers(&snapshot)
            });
            checked.remember_failed = saved
                .log_warn(
                    "storage",
                    "the sudo password was not saved in the keychain: it will be asked for again",
                )
                .is_none();
        }
    }
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use crate::srcscan::shipped_code;

    /// The commands of a bridge source with a text parameter named for a password
    /// — each `#[tauri::command]`'s signature, up to its body. A flag about
    /// passwords (`mask_passwords: bool`) is no password.
    fn commands_taking_a_sudo_password(src: &str) -> Vec<String> {
        src.split("#[tauri::command]")
            .skip(1)
            .filter_map(|chunk| {
                let at = chunk.find("fn ")?;
                let sig = &chunk[at..chunk[at..].find('{').map_or(chunk.len(), |b| at + b)];
                let name = sig[3..].split(['(', '<']).next()?.trim().to_string();
                let takes = sig.split([',', '(']).any(|param| {
                    let (pname, ty) = param.split_once(':').unwrap_or(("", ""));
                    pname.to_lowercase().contains("password") && ty.contains("String")
                });
                takes.then_some(name)
            })
            .collect()
    }

    /// The files of the crate that read the saved sudo password from the keychain.
    fn readers_of_the_saved_sudo_password() -> Vec<String> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = Vec::new();
        let mut dirs = vec![root.clone()];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    let code = shipped_code(&text);
                    if code.contains("get_sudo_password(") && !path.ends_with("secrets.rs") {
                        let rel = path
                            .strip_prefix(&root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                        found.push(rel);
                    }
                }
            }
        }
        found
    }

    /// ADR 0073: the window never holds a sudo password. A typed one reaches the
    /// backend through `sudo_check` alone. A DB password belongs to `db_connect`;
    /// the login secret uses its own flow. The saved sudo password is read here
    /// alone.
    #[test]
    fn a_sudo_password_reaches_the_backend_only_through_the_check() {
        assert_eq!(
            commands_taking_a_sudo_password(&crate::commands::bridge_source()),
            ["db_connect", "sudo_check"]
        );
        assert_eq!(readers_of_the_saved_sudo_password(), ["commands/sudo.rs"]);
        // The check sees what it is for.
        let leaking = "#[tauri::command]\npub async fn sftp_write_text(\n    sudo_password: Option<String>,\n) -> AppResult<()> {\n}\n#[tauri::command]\npub fn other(mask_passwords: bool) {}";
        assert_eq!(
            commands_taking_a_sudo_password(leaking),
            ["sftp_write_text"]
        );
    }
}
