//! Server-profile CRUD commands: list/add/update/delete plus `forget_secrets`.
//! Profiles persist as JSON via `store`; secrets live only in the keychain
//! (`secrets`) and are dropped alongside a deleted server. Extracted from
//! `lib.rs` in Phase 18.2.

use tauri::State;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::model::{AuthMethod, NewServerProfile, ServerProfile};
use crate::{secrets, store, uuid_like, AppState};

#[tauri::command]
pub fn list_servers(state: State<AppState>) -> Vec<ServerProfile> {
    state.servers.lock().unwrap().clone()
}

#[tauri::command]
pub fn add_server(profile: NewServerProfile, state: State<AppState>) -> AppResult<ServerProfile> {
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
        no_ai: profile.no_ai,
        chat_prompt_id: profile.chat_prompt_id,
        exec_mode: profile.exec_mode,
        proxy: profile.proxy,
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
pub fn update_server(
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
                server.no_ai = profile.no_ai;
                server.chat_prompt_id = profile.chat_prompt_id;
                server.exec_mode = profile.exec_mode;
                server.proxy = profile.proxy;
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
pub async fn delete_server(id: String, state: State<'_, AppState>) -> AppResult<()> {
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

/// Forget any stored password/passphrase for a server — including its proxy's.
#[tauri::command]
pub fn forget_secrets(id: String, state: State<AppState>) -> AppResult<()> {
    secrets::delete_all(&id)?;
    let snapshot = {
        let mut servers = state.servers.lock().unwrap();
        if let Some(p) = servers.iter_mut().find(|p| p.id == id) {
            p.has_saved_password = false;
            if let Some(px) = p.proxy.as_mut() {
                px.has_saved_password = false;
            }
        }
        servers.clone()
    };
    store::save_servers(&snapshot)
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
        let mut servers = state.servers.lock().unwrap();
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
