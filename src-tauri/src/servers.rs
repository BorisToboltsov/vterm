//! Server-profile CRUD commands: list/add/update/delete plus `forget_secrets`.
//! Profiles persist as JSON via `store`; secrets live only in the keychain
//! (`secrets`) and are dropped alongside a deleted server. Extracted from
//! `lib.rs` in Phase 18.2.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::model::{NewServerProfile, ServerProfile};
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

/// Forget any stored password/passphrase for a server.
#[tauri::command]
pub fn forget_secrets(id: String, state: State<AppState>) -> AppResult<()> {
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
