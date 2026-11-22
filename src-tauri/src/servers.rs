//! Server-profile CRUD commands: list/add/update/delete plus `forget_secrets`.
//! Profiles persist as JSON via `store`; secrets live only in the keychain
//! (`secrets`) and are dropped alongside a deleted server. Extracted from
//! `lib.rs` in Phase 18.2.

use tauri::State;
use zeroize::Zeroizing;

use crate::diag::Logged;
use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use crate::model::{AuthMethod, NewServerProfile, ServerProfile};
use crate::{secrets, store, uuid_like, AppState};

#[tauri::command]
pub fn list_servers(state: State<AppState>) -> Vec<ServerProfile> {
    state.servers.locked().clone()
}

/// A rejected disk write must not leave a server visible only in this process.
fn add_persisted(
    servers: &mut Vec<ServerProfile>,
    created: ServerProfile,
    persist: impl FnOnce(&[ServerProfile]) -> AppResult<()>,
) -> AppResult<ServerProfile> {
    let mut next = servers.clone();
    next.push(created.clone());
    persist(&next)?;
    *servers = next;
    Ok(created)
}

#[tauri::command]
pub fn add_server(profile: NewServerProfile, state: State<AppState>) -> AppResult<ServerProfile> {
    let (logins, _) = crate::model::merge_logins(&[], profile.logins)?;
    let created = ServerProfile {
        id: uuid_like(),
        alias: profile.alias,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        auth_method: profile.auth_method,
        key_path: profile.key_path,
        has_saved_password: false,
        has_saved_sudo: false,
        group: profile.group,
        tags: profile.tags,
        prod: profile.prod,
        auto_record: profile.auto_record,
        no_ai: profile.no_ai,
        chat_prompt_id: profile.chat_prompt_id,
        exec_mode: profile.exec_mode,
        proxy: profile.proxy,
        path_sync: profile.path_sync,
        notes: String::new(),
        icon: profile.icon,
        icon_color: profile.icon_color,
        logins,
        default_login: profile.default_login,
        ask_login: profile.ask_login,
        databases: Vec::new(),
    };
    let mut servers = state.servers.locked();
    add_persisted(&mut servers, created, store::save_servers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::srcscan::shipped_code;

    /// The body of `fn name` in `src`, up to its closing brace.
    fn body<'a>(src: &'a str, name: &str) -> &'a str {
        let at = src.find(&format!("fn {name}(")).expect(name);
        let rest = &src[at..];
        &rest[..rest.find("\n}\n").map_or(rest.len(), |e| e + 2)]
    }

    /// What makes a refused login forget other than the login's secret (ADR 0073):
    /// the sudo password it was never asked about stays, so does the jump host's.
    fn forget_faults(secrets: &str, servers: &str) -> Vec<&'static str> {
        let (secrets, servers) = (shipped_code(secrets), shipped_code(servers));
        let login = body(&secrets, "delete_login");
        let mut faults = Vec::new();
        if !login.contains("delete_password(id)") || !login.contains("delete_passphrase(id)") {
            faults.push("a refused login keeps its password or its passphrase");
        }
        if login.contains("sudo") || login.contains("proxy") {
            faults.push("a refused login forgets sudo's or the jump host's");
        }
        if !body(&secrets, "delete_all").contains("delete_sudo_password(id)") {
            faults.push("the form's «Forget» keeps sudo's");
        }
        let cmd = body(&servers, "forget_login_secret");
        if !cmd.contains("secrets::delete_login(") || cmd.contains("delete_all") {
            faults.push("the command forgets more than the login");
        }
        if cmd.contains("has_saved_sudo") {
            faults.push("the command marks sudo's as forgotten");
        }
        faults
    }

    #[test]
    fn a_refused_login_forgets_only_the_login_secret() {
        // The keychain module's source text — code, not a secret (CodeQL #496
        // took the old name `secrets_src` for one).
        let module_src = include_str!("secrets.rs").replace("\r\n", "\n");
        let servers = include_str!("servers.rs").replace("\r\n", "\n");
        assert_eq!(forget_faults(&module_src, &servers), Vec::<&str>::new());
        // …and the check catches what it is for: naming a step is not taking it.
        let kept = module_src.replacen(
            "    delete_password(id)?;\n    delete_passphrase(id)\n}",
            "    delete_password(id) // and delete_passphrase(id)\n}",
            1,
        );
        assert_ne!(kept, module_src, "the mutation no longer applies");
        assert_eq!(
            forget_faults(&kept, &servers),
            ["a refused login keeps its password or its passphrase"]
        );
        let all = module_src.replacen(
            "    delete_sudo_password(id)?;\n    for login in logins {",
            "    // delete_sudo_password(id)?;\n    for login in logins {",
            1,
        );
        assert_ne!(all, module_src, "the mutation no longer applies");
        assert_eq!(
            forget_faults(&all, &servers),
            ["the form's «Forget» keeps sudo's"]
        );
    }

    fn sample(id: &str) -> ServerProfile {
        serde_json::from_value(serde_json::json!({
            "id": id, "alias": id, "host": "example.com", "port": 22, "username": "root"
        }))
        .unwrap()
    }

    #[test]
    fn failed_profile_write_does_not_create_a_memory_only_server() {
        let mut servers = vec![sample("old")];
        let result = add_persisted(&mut servers, sample("new"), |_| {
            Err(AppError::Message("disk full".into()))
        });
        assert!(result.is_err());
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].id, "old");

        let saved = add_persisted(&mut servers, sample("new"), |snapshot| {
            assert_eq!(snapshot.len(), 2);
            Ok(())
        })
        .unwrap();
        assert_eq!(saved.id, "new");
        assert_eq!(servers.len(), 2);
    }

    #[test]
    fn path_sync_changes_only_its_field_and_only_once_written() {
        let mut servers = vec![sample("a"), sample("b")];
        servers[0].notes = "keep".into();
        let failed = path_sync_persisted(&mut servers, "a", Some("auto".into()), |_| {
            Err(AppError::Message("disk full".into()))
        });
        assert!(failed.is_err());
        assert_eq!(
            servers[0].path_sync, None,
            "an unwritten choice stays unsaved"
        );

        let saved = path_sync_persisted(&mut servers, "a", Some("auto".into()), |snapshot| {
            assert_eq!(snapshot[0].path_sync.as_deref(), Some("auto"));
            Ok(())
        })
        .unwrap();
        assert_eq!(saved.path_sync.as_deref(), Some("auto"));
        assert_eq!(servers[0].path_sync.as_deref(), Some("auto"));
        assert_eq!(servers[0].notes, "keep");
        assert_eq!(servers[1].path_sync, None);

        path_sync_persisted(&mut servers, "a", None, |_| Ok(())).unwrap();
        assert_eq!(servers[0].path_sync, None);
        assert!(matches!(
            path_sync_persisted(&mut servers, "gone", None, |_| Ok(())),
            Err(AppError::UnknownServer)
        ));
    }
}

#[tauri::command]
pub fn update_server(
    id: String,
    profile: NewServerProfile,
    state: State<AppState>,
) -> AppResult<ServerProfile> {
    let gone;
    let snapshot = {
        let mut servers = state.servers.locked();
        match servers.iter_mut().find(|s| s.id == id) {
            Some(server) => {
                let (logins, removed) = crate::model::merge_logins(&server.logins, profile.logins)?;
                gone = removed;
                server.logins = logins;
                server.default_login = profile.default_login;
                server.ask_login = profile.ask_login;
                server.alias = profile.alias;
                server.host = profile.host;
                server.port = profile.port;
                server.username = profile.username;
                server.auth_method = profile.auth_method;
                server.key_path = profile.key_path;
                server.group = profile.group;
                server.tags = profile.tags;
                server.prod = profile.prod;
                server.auto_record = profile.auto_record;
                server.no_ai = profile.no_ai;
                server.chat_prompt_id = profile.chat_prompt_id;
                server.exec_mode = profile.exec_mode;
                server.proxy = profile.proxy;
                server.path_sync = profile.path_sync;
                server.icon = profile.icon;
                server.icon_color = profile.icon_color;
            }
            None => return Err(AppError::UnknownServer),
        }
        servers.clone()
    };
    store::save_servers(&snapshot)?;
    // A login taken out of the profile takes its secrets with it.
    for login in &gone {
        secrets::delete_login_all(&id, login).log_warn(
            "servers",
            "a removed login's saved passwords were not removed from the keychain",
        );
    }
    snapshot
        .into_iter()
        .find(|s| s.id == id)
        .ok_or(AppError::UnknownServer)
}

/// Add a login to a server — a user typed for one connection and kept with
/// "Add to the profile" (ADR 0074): it logs in with a password. Returns the
/// profile and the new login's id, to connect with it.
#[tauri::command]
pub fn add_server_login(
    server_id: String,
    username: String,
    state: State<AppState>,
) -> AppResult<AddedLogin> {
    if !crate::model::valid_login_user(&username) {
        return Err(AppError::Message(format!("not a user name: {username}")));
    }
    let login_id = uuid_like();
    let snapshot = {
        let mut servers = state.servers.locked();
        let server = servers
            .iter_mut()
            .find(|s| s.id == server_id)
            .ok_or(AppError::UnknownServer)?;
        server.logins.push(crate::model::ServerLogin {
            id: login_id.clone(),
            username: username.trim().to_string(),
            auth_method: AuthMethod::Password,
            key_path: None,
            has_saved_password: false,
            has_saved_sudo: false,
        });
        servers.clone()
    };
    store::save_servers(&snapshot)?;
    let server = snapshot
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or(AppError::UnknownServer)?;
    Ok(AddedLogin { server, login_id })
}

/// A login added to a server, and the server as it is now.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedLogin {
    pub server: ServerProfile,
    pub login_id: String,
}

/// Save the free-form notes for a server. A dedicated command (not part of
/// `update_server`) so editing notes in the notes window and editing the profile
/// in the server form never clobber each other, and the payload stays small.
#[tauri::command]
pub fn set_server_notes(
    id: String,
    notes: String,
    state: State<AppState>,
) -> AppResult<ServerProfile> {
    let snapshot = {
        let mut servers = state.servers.locked();
        match servers.iter_mut().find(|s| s.id == id) {
            Some(server) => server.notes = notes,
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

/// Save how path sync starts on a server (`pathsync.ts`). Its own command, like
/// the notes: the question asked when sync is turned on answers it, and writing
/// the whole profile back from there could undo an edit made in the server form
/// meanwhile. As with a new profile, memory changes only after the file does —
/// a choice that did not reach the disk must not look saved.
#[tauri::command]
pub fn set_server_path_sync(
    id: String,
    mode: Option<String>,
    state: State<AppState>,
) -> AppResult<ServerProfile> {
    let mut servers = state.servers.locked();
    path_sync_persisted(&mut servers, &id, mode, store::save_servers)
}

fn path_sync_persisted(
    servers: &mut Vec<ServerProfile>,
    id: &str,
    mode: Option<String>,
    persist: impl FnOnce(&[ServerProfile]) -> AppResult<()>,
) -> AppResult<ServerProfile> {
    let mut next = servers.clone();
    let server = next
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or(AppError::UnknownServer)?;
    server.path_sync = mode;
    let updated = server.clone();
    persist(&next)?;
    *servers = next;
    Ok(updated)
}

#[tauri::command]
pub async fn delete_server(id: String, state: State<'_, AppState>) -> AppResult<()> {
    let mut logins = Vec::new();
    let mut databases = Vec::new();
    let snapshot = {
        let mut servers = state.servers.locked();
        if let Some(gone) = servers.iter().find(|s| s.id == id) {
            logins = gone.login_ids();
            databases = gone.database_ids();
        }
        servers.retain(|s| s.id != id);
        servers.clone()
    };
    store::save_servers(&snapshot)?;
    secrets::delete_all(&id, &logins, &databases).log_warn(
        "servers",
        "the server's saved passwords were not removed from the keychain",
    );
    // Drop any live session for this server (Drop closes the connection).
    state.sessions.lock().await.remove(&id);
    Ok(())
}

/// Forget the login secret the server just turned down — its password or key
/// passphrase only, of the login it was (`login`, ADR 0074; none — the first).
/// The sudo password and the jump host's stay: a refused login says nothing of
/// them (ADR 0073); "Forget saved password" in the form (`forget_secrets`)
/// takes everything.
#[tauri::command]
pub fn forget_login_secret(
    id: String,
    login: Option<String>,
    state: State<AppState>,
) -> AppResult<()> {
    let login = login.unwrap_or_default();
    secrets::delete_login(&secrets::login_scope(&id, &login))?;
    let snapshot = {
        let mut servers = state.servers.locked();
        if let Some((password, _)) = servers
            .iter_mut()
            .find(|p| p.id == id)
            .and_then(|p| p.login_hints_mut(&login))
        {
            *password = false;
        }
        servers.clone()
    };
    store::save_servers(&snapshot)
}

/// Forget any stored password/passphrase for a server — its sudo password and
/// its proxy's too.
#[tauri::command]
pub fn forget_secrets(id: String, state: State<AppState>) -> AppResult<()> {
    let (logins, databases) = state
        .servers
        .locked()
        .iter()
        .find(|p| p.id == id)
        .map(|p| (p.login_ids(), p.database_ids()))
        .unwrap_or_default();
    secrets::delete_all(&id, &logins, &databases)?;
    let snapshot = {
        let mut servers = state.servers.locked();
        if let Some(p) = servers.iter_mut().find(|p| p.id == id) {
            p.has_saved_password = false;
            p.has_saved_sudo = false;
            for l in &mut p.logins {
                l.has_saved_password = false;
                l.has_saved_sudo = false;
            }
            for d in &mut p.databases {
                d.has_saved_password = false;
            }
            if let Some(px) = p.proxy.as_mut() {
                px.has_saved_password = false;
            }
        }
        servers.clone()
    };
    store::save_servers(&snapshot)
}

/// Store the server's own secret (password or key passphrase) in the keychain and
/// mark the profile as having one. The kind follows the server's auth method, so
/// the same field serves both — exactly as the connect-time prompt does.
///
/// Returns the updated profile rather than `()`: the saved-secret hint lives on
/// the profile, and the form has just written it, so handing the caller the row
/// the backend actually stored keeps the list from showing a stale "no secret".
#[tauri::command]
pub fn save_server_secret(
    server_id: String,
    secret: String,
    login: Option<String>,
    state: State<AppState>,
) -> AppResult<ServerProfile> {
    // Wrap so vterm's own in-memory copy is wiped on drop (keychain stays canonical).
    let secret = Zeroizing::new(secret);
    if secret.trim().is_empty() {
        return Err(AppError::Message(
            "refusing to store an empty secret".into(),
        ));
    }
    let snapshot = {
        let mut servers = state.servers.locked();
        let server = servers
            .iter_mut()
            .find(|s| s.id == server_id)
            .ok_or(AppError::UnknownServer)?;
        // The secret of one login (ADR 0074), of the kind its own auth method says.
        let resolved = server.resolve_login(Some(&crate::model::LoginChoice::Saved {
            id: login.clone().unwrap_or_default(),
        }))?;
        let scope = resolved.scope.unwrap_or_else(|| server_id.clone());
        match resolved.auth_method {
            AuthMethod::Password => secrets::set_password(&scope, &secret)?,
            AuthMethod::Key => secrets::set_passphrase(&scope, &secret)?,
        }
        if let Some((password, _)) = server.login_hints_mut(&login.unwrap_or_default()) {
            *password = true;
        }
        servers.clone()
    };
    store::save_servers(&snapshot)?;
    snapshot
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or(AppError::UnknownServer)
}

/// Store a proxy/jump host secret (password or key passphrase) in the keychain
/// and mark the proxy as having a saved secret. The kind of secret follows the
/// proxy's own auth method. Called by the server form after add/update when the
/// user typed a proxy secret (secrets are never persisted on the profile JSON).
#[tauri::command]
pub fn save_proxy_secret(
    server_id: String,
    secret: String,
    state: State<AppState>,
) -> AppResult<()> {
    // Wrap so vterm's own in-memory copy is wiped on drop (keychain stays canonical).
    let secret = Zeroizing::new(secret);
    let snapshot = {
        let mut servers = state.servers.locked();
        let server = servers
            .iter_mut()
            .find(|s| s.id == server_id)
            .ok_or(AppError::UnknownServer)?;
        let proxy = server
            .proxy
            .as_mut()
            .ok_or_else(|| AppError::Message("server has no proxy configured".to_string()))?;
        match proxy.auth_method {
            AuthMethod::Password => secrets::set_proxy_password(&server_id, &secret)?,
            AuthMethod::Key => secrets::set_proxy_passphrase(&server_id, &secret)?,
        }
        proxy.has_saved_password = true;
        servers.clone()
    };
    store::save_servers(&snapshot)
}
