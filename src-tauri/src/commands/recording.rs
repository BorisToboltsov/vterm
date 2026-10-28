// Session recording commands of the bridge layer (asciicast v2, `recording.rs`):
// start/stop/pause, audit annotations and the recordings library.

use crate::error::{AppError, AppResult};
use crate::{netprobe, recording, session_arc, AppState};
use tauri::State;

/// Metadata about a stored recording, read from its asciicast header + file stat.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMeta {
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
pub fn unique_recording_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
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
pub async fn start_recording(
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
        state.local_pty(&session_id)
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
pub async fn stop_recording(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Option<String>> {
    let path = if let Ok(session) = session_arc(&state, &session_id).await {
        session.end_recording()
    } else {
        let local = state.local_pty(&session_id);
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
pub async fn set_recording_paused(
    state: State<'_, AppState>,
    session_id: String,
    paused: bool,
) -> AppResult<()> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        session.set_recording_paused(paused);
    } else {
        let local = state.local_pty(&session_id);
        if let Some(pty) = local {
            pty.set_recording_paused(paused);
        }
    }
    Ok(())
}

/// Write an audit annotation (e.g. "edited /etc/nginx.conf") into the session's
/// active recording. No-op if the session isn't recording.
#[tauri::command]
pub async fn annotate_recording(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> AppResult<()> {
    if let Ok(session) = session_arc(&state, &session_id).await {
        session.annotate_recording(&text);
    } else {
        let local = state.local_pty(&session_id);
        if let Some(pty) = local {
            pty.annotate_recording(&text);
        }
    }
    Ok(())
}

/// Record a network utility's run into the session's active recording as a
/// `[util] $ <op> … [util] exit N` block — the record-only shape of the sftp/git
/// mirrors (`netprobe::audit_block`). The frontend builds `op`/`body` from the
/// parsed result with secrets masked (tls.ts/http.ts/netcheck.ts), because only
/// it knows which tokens are header values and which output is a response body.
/// Like the other mirrors it goes through `record_output`, so a paused recording
/// drops it. No-op without a session or a recording.
#[tauri::command]
pub async fn record_audit(
    state: State<'_, AppState>,
    session_id: String,
    op: String,
    body: String,
    exit_code: i32,
) -> AppResult<()> {
    let block = netprobe::audit_block(&op, &body, exit_code);
    if let Ok(session) = session_arc(&state, &session_id).await {
        session.record_output(block.as_bytes());
    } else if let Some(pty) = state.local_pty(&session_id) {
        pty.record_output(block.as_bytes());
    }
    Ok(())
}

/// List stored recordings (newest first), reading metadata from each header.
#[tauri::command]
pub fn list_recordings() -> AppResult<Vec<RecordingMeta>> {
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
pub fn import_recording(src_path: String) -> AppResult<RecordingMeta> {
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
pub fn delete_recording(path: String) -> AppResult<()> {
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
pub fn set_recording_meta(path: String, title: String, description: String) -> AppResult<()> {
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
pub fn set_batch_label(batch_id: String, label: String) -> AppResult<()> {
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
pub fn read_recording(path: String) -> AppResult<String> {
    let p = std::path::PathBuf::from(&path);
    if !is_recording_path(&p) {
        return Err(AppError::Message("not a recording".into()));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("read recording: {e}").into())
}

/// Write exported text (a transcript or a copied .cast) to a user-chosen path.
/// The destination comes from a native save dialog, so the user intends it.
#[tauri::command]
pub fn export_recording(path: String, content: String) -> AppResult<()> {
    std::fs::write(&path, content).map_err(|e| format!("export recording: {e}").into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
