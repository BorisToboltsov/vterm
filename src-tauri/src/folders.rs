//! Folder tree + server-grouping commands. Folders are explicit paths (incl.
//! empty/nested) persisted as JSON; moving/renaming a folder rewrites its whole
//! subtree across both the folder list and server `group` fields. `set_server_group`
//! assigns a server to a folder. Pure helpers (`normalize_path`, `reprefixed`) are
//! unit-tested. Extracted from `lib.rs` in Phase 18.2.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::model::ServerProfile;
use crate::{store, AppState};

/// Normalize a folder path: trim, collapse repeated/edge slashes, drop blanks.
fn normalize_path(path: &str) -> String {
    path.split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

#[tauri::command]
pub fn list_folders(state: State<AppState>) -> Vec<String> {
    let mut folders = state.folders.lock().unwrap().clone();
    folders.sort();
    folders
}

/// Create a folder (and implicitly any missing ancestors).
#[tauri::command]
pub fn add_folder(path: String, state: State<AppState>) -> AppResult<Vec<String>> {
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
pub fn delete_folder(path: String, state: State<AppState>) -> AppResult<()> {
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
pub fn move_folder(
    path: String,
    new_parent: Option<String>,
    state: State<AppState>,
) -> AppResult<()> {
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
pub fn rename_folder(path: String, new_name: String, state: State<AppState>) -> AppResult<()> {
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
pub fn set_server_group(
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
}
