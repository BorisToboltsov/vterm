//! What a tab held, kept across a restart — only when the user asked for it
//! (v1.36, ADR 0057).
//!
//! A tab comes back after a restart as the tab, not the session (ADR 0019):
//! what it was and where it stood live in the WebView's `localStorage`. Its
//! terminal output and its conversation with the assistant are another matter —
//! they hold whatever was printed and typed, so they are kept only under the
//! setting `restoreOutput` (off by default) and never for a production server:
//! the frontend decides what is written, this module only keeps it.
//!
//! Kept here, not in `localStorage`: a scrollback runs to megabytes, and the
//! storage of a WebView is a few. One file per tab, named by its session id, in
//! `data_dir/tabs/`, readable by the user alone (`0600` in a `0700` folder, as
//! the private keys `keygen` writes). The content is the frontend's JSON,
//! passed through: it is read back by the frontend as untrusted.
//!
//! The boundary: a session id names the file, so it is checked — the same
//! alphabet the frontend allows (`tabrestore.ts`) — and nothing outside the
//! folder is ever read, written or removed.

use crate::error::{AppError, AppResult};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// More than this for one tab is not something the frontend writes: its
/// snapshot is cut to `RESTORE_SCROLLBACK` lines first.
pub const MAX_CONTENT: usize = 16 * 1024 * 1024;

const EXT: &str = "json";

/// Where the kept content lives.
fn content_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("su", "vcore", "vterm").map(|d| d.data_dir().join("tabs"))
}

/// A session id as the frontend makes them (`crypto.randomUUID()`), and as its
/// reader of saved tabs accepts them: it becomes a file name, so nothing else.
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The file of `id` inside `dir`, or None when `id` is not one.
fn file_in(dir: &Path, id: &str) -> Option<PathBuf> {
    valid_id(id).then(|| dir.join(format!("{id}.{EXT}")))
}

/// The session id a file of the folder belongs to, or None for anything else
/// (a temp file of an unfinished write, a file someone put there).
fn id_of(path: &Path) -> Option<String> {
    if path.extension().is_none_or(|e| e != EXT) {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    valid_id(stem).then(|| stem.to_owned())
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// A file only its owner reads — created so from the start: a temp file opened
/// with the default mode and narrowed afterwards could be read in between.
fn create_private(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Write `content` as the file of `id`, never leaving a half-written one at its
/// name: temp sibling → `sync_all` → `rename` (the form of `store::write_atomic`).
pub fn save_in(dir: &Path, id: &str, content: &str) -> AppResult<()> {
    let path =
        file_in(dir, id).ok_or_else(|| AppError::Message(format!("not a session id: {id:?}")))?;
    if content.len() > MAX_CONTENT {
        return Err(AppError::Message(format!(
            "tab content of {} bytes is over the limit of {MAX_CONTENT}",
            content.len()
        )));
    }
    create_private_dir(dir)
        .map_err(|e| AppError::Message(format!("create {}: {e}", dir.display())))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{id}.vterm-tmp-{nanos:x}"));
    let written = (|| -> std::io::Result<()> {
        let mut f = create_private(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Message(format!("write {}: {e}", tmp.display())));
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Message(format!(
            "rename onto {}: {e}",
            path.display()
        )));
    }
    Ok(())
}

/// The content kept for `id`; None when there is none (or `id` is not one).
pub fn load_in(dir: &Path, id: &str) -> Option<String> {
    let path = file_in(dir, id)?;
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_CONTENT as u64 {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// Remove what is kept for these tabs.
pub fn forget_in(dir: &Path, ids: &[String]) {
    for path in ids.iter().filter_map(|id| file_in(dir, id)) {
        let _ = fs::remove_file(path);
    }
}

/// Remove every kept file but those of `keep` — a tab of the previous launch that
/// did not come back has nothing to come back to. `keep` empty clears the folder.
/// Leftover temp files of a write that never finished go too.
pub fn keep_only_in(dir: &Path, keep: &[String]) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let stale = match id_of(&path) {
            Some(id) => !keep.contains(&id),
            None => path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.') && n.contains(".vterm-tmp-")),
        };
        if stale {
            let _ = fs::remove_file(&path);
        }
    }
}

fn dir() -> AppResult<PathBuf> {
    content_dir().ok_or_else(|| AppError::Message("could not resolve the data directory".into()))
}

/// Keep what tab `session_id` holds — its terminal and its conversation, as the
/// frontend wrote them down.
#[tauri::command]
pub fn tab_content_save(session_id: String, content: String) -> AppResult<()> {
    save_in(&dir()?, &session_id, &content)
}

/// What was kept for tab `session_id`, if anything.
#[tauri::command]
pub fn tab_content_load(session_id: String) -> Option<String> {
    load_in(&content_dir()?, &session_id)
}

/// The tabs closed (or no longer kept): their content goes.
#[tauri::command]
pub fn tab_content_forget(session_ids: Vec<String>) {
    if let Some(dir) = content_dir() {
        forget_in(&dir, &session_ids);
    }
}

/// Everything but the content of `session_ids` goes (empty — all of it).
#[tauri::command]
pub fn tab_content_keep_only(session_ids: Vec<String>) {
    if let Some(dir) = content_dir() {
        keep_only_in(&dir, &session_ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("vterm-tabcontent-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_session_id_is_the_frontends_alphabet_and_nothing_else() {
        for ok in ["0b7c6a1e-9f2d-4e8a-8c1b-2d3e4f5a6b7c", "s1", "a_b-C"] {
            assert!(valid_id(ok), "{ok}");
        }
        let long = "a".repeat(65);
        for bad in [
            "",
            "../x",
            "a/b",
            "a\\b",
            "a.json",
            "a b",
            "é",
            "..",
            long.as_str(),
        ] {
            assert!(!valid_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn what_is_kept_comes_back_and_nothing_outside_the_folder_is_touched() {
        let dir = scratch("roundtrip");
        save_in(&dir, "s1", r#"{"v":1}"#).unwrap();
        assert_eq!(load_in(&dir, "s1").as_deref(), Some(r#"{"v":1}"#));
        // Written again, the new content replaces the old.
        save_in(&dir, "s1", r#"{"v":2}"#).unwrap();
        assert_eq!(load_in(&dir, "s1").as_deref(), Some(r#"{"v":2}"#));
        assert_eq!(load_in(&dir, "s2"), None);
        // A name that is not a session id is never a path.
        let outside = dir.parent().unwrap().join("vterm-tabcontent-outside.json");
        fs::write(&outside, "x").unwrap();
        assert!(save_in(&dir, "../vterm-tabcontent-outside", "y").is_err());
        assert_eq!(load_in(&dir, "../vterm-tabcontent-outside"), None);
        forget_in(&dir, &["../vterm-tabcontent-outside".into()]);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "x");
        fs::remove_file(outside).unwrap();
        // No temp file is left behind by a finished write.
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["s1.json".to_string()]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_file_and_its_folder_are_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("mode");
        save_in(&dir, "s1", "{}").unwrap();
        let file = fs::metadata(dir.join("s1.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let folder = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!((file, folder), (0o600, 0o700));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn content_over_the_limit_is_refused_not_cut() {
        let dir = scratch("limit");
        let big = "x".repeat(MAX_CONTENT + 1);
        assert!(save_in(&dir, "s1", &big).is_err());
        assert_eq!(load_in(&dir, "s1"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeping_only_some_tabs_removes_the_rest_and_stray_temp_files() {
        let dir = scratch("keep");
        for id in ["a", "b", "c"] {
            save_in(&dir, id, "{}").unwrap();
        }
        fs::write(dir.join(".a.vterm-tmp-1f"), "half").unwrap();
        fs::write(dir.join("notes.txt"), "mine").unwrap();
        keep_only_in(&dir, &["b".into()]);
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        // A file that is no tab's is not this module's to remove.
        assert_eq!(names, vec!["b.json".to_string(), "notes.txt".to_string()]);
        keep_only_in(&dir, &[]);
        assert!(load_in(&dir, "b").is_none());
        fs::remove_dir_all(&dir).unwrap();
    }
}
