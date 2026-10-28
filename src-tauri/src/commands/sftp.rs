// File commands of the bridge layer: SFTP browsing and editing, directory sync,
// search, server tools and the transfer jobs (`transfers.rs`).

use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use crate::sftp::FileEntry;
use crate::ssh::SshSession;
use crate::{
    appwin, git, localfile, register_cancel, servertools, session_arc, sftp, ssh, sync, transfers,
    uuid_like, AppState, IdNames,
};
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Per-session uid→name / gid→name maps (fetched once from passwd/group and
/// cached) so the SFTP listing can show owner names. Returns empty maps if the
/// lookup fails (the frontend then falls back to numeric uid/gid).
async fn ensure_id_names(state: &State<'_, AppState>, session_id: &str) -> IdNames {
    if let Some(cached) = state.id_names.locked().get(session_id) {
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
        .locked()
        .insert(session_id.to_string(), maps.clone());
    maps
}

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
        // A user stop, not a failure — the same `exit 130` a stopped sync records.
        Err(e @ AppError::Cancelled) => (130, e.to_string()),
        Err(e) => (1, e.to_string()),
    };
    session.record_output(sftp::sftp_mirror(op, code, &detail).as_bytes());
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, session_id: String) -> AppResult<String> {
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::home(&sftp).await
}

#[tauri::command]
pub async fn sftp_list(
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
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<()> {
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
pub async fn sftp_create_file(
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
pub async fn sftp_read_text(
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

/// Advisory access to the directory used by the editor's staged SFTP save.
#[tauri::command]
pub async fn sftp_write_access(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<String> {
    let session = session_arc(&state, &session_id).await?;
    let outcome = session
        .exec_captured(&sftp::write_access_command(&path), 5)
        .await?;
    if outcome.timed_out || outcome.exit_code != 0 {
        return Ok("unknown".into());
    }
    match outcome.stdout.as_str() {
        "writable" | "restricted" => Ok(outcome.stdout),
        _ => Ok("unknown".into()),
    }
}

/// Check sudo credentials before editing, without touching the target file.
#[tauri::command]
pub async fn sftp_check_sudo(
    state: State<'_, AppState>,
    session_id: String,
    password: String,
) -> AppResult<bool> {
    let session = session_arc(&state, &session_id).await?;
    sync::check_sudo(&session, &password).await
}

/// Read a remote file as base64 bytes for the markdown preview's inline images
/// (Phase 44.4). `max_bytes` is clamped to a hard ceiling that is deliberately far
/// below the editor's: this path exists to show a screenshot next to a README, not
/// to move files — that is what the SFTP panel's download is for.
#[tauri::command]
pub async fn sftp_read_bytes(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    max_bytes: Option<u64>,
) -> AppResult<String> {
    let limit = max_bytes
        .unwrap_or(sftp::MAX_INLINE_IMAGE)
        .clamp(1, sftp::MAX_INLINE_IMAGE);
    let sftp = get_sftp(&state, &session_id).await?;
    sftp::read_bytes(&sftp, &path, limit).await
}

/// Save editor text back to a remote file (atomic temp+rename, conflict-checked).
/// `sudo` writes root-owned files via `sudo cp`; `backup` keeps a `.bak` copy.
#[tauri::command]
// Tauri command: args arrive by name from JS (`invoke`), so they must stay as
// individual parameters — grouping them into one struct would change the wire
// contract with the frontend. The cohesive write payload is regrouped internally
// into `sftp::TextWrite` before hitting the backend helpers.
#[allow(clippy::too_many_arguments)]
pub async fn sftp_write_text(
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
    let encoding = encoding.unwrap_or_else(|| crate::textenc::default_encoding().into());
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

/// Hash every file under a remote directory via `sha256sum` over the SSH exec
/// channel (no download). Returns `/`-relative path → sha256.
#[tauri::command]
pub async fn sftp_hash_tree(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    excludes: Vec<String>,
    cancel_id: String,
) -> AppResult<sync::HashTree> {
    let session = session_arc(&state, &session_id).await?;
    let cancel = register_cancel(&state, &cancel_id);
    let win = appwin::WindowSink::of(&window);
    let cmd = sync::remote_hash_command(&path, &sync::ExcludeSet::new(&excludes));
    // Count output lines as they stream in: one per file hashed (or unreadable).
    let mut out: Vec<u8> = Vec::new();
    let mut lines = 0u64;
    let mut last = std::time::Instant::now();
    let run = session.run_command_streaming(&cmd, |chunk| {
        out.extend_from_slice(chunk);
        lines += chunk.iter().filter(|&&b| b == b'\n').count() as u64;
        if last.elapsed() >= std::time::Duration::from_millis(150) {
            last = std::time::Instant::now();
            sync::emit_scan(&win, &cancel_id, lines);
        }
    });
    let res = sync::until_cancelled(run, &cancel).await;
    state.cancels.locked().remove(&cancel_id);
    res?;
    sync::parse_hash_output(&path, &String::from_utf8_lossy(&out))
}

/// Hash every file under a local directory (the local side of sync).
#[tauri::command]
pub async fn local_hash_tree(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    path: String,
    excludes: Vec<String>,
    cancel_id: String,
) -> AppResult<sync::HashTree> {
    use std::sync::atomic::AtomicU64;
    let cancel = register_cancel(&state, &cancel_id);
    let progress = Arc::new(AtomicU64::new(0));
    // Report the count every 200 ms until the walk ends.
    let ticker = {
        let win = appwin::WindowSink::of(&window);
        let (id, progress) = (cancel_id.clone(), progress.clone());
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                sync::emit_scan(&win, &id, progress.load(Ordering::Relaxed));
            }
        })
    };
    let res = localfile::hash_tree(&path, sync::ExcludeSet::new(&excludes), cancel, progress).await;
    ticker.abort();
    state.cancels.locked().remove(&cancel_id);
    res
}

/// List every config file nginx actually loads on the server, via `nginx -T` (it
/// resolves `include` globs/recursion itself). Used by the editor to recognise nginx
/// configs that live outside the `/etc/nginx/` tree. Best-effort: empty list when
/// nginx is absent or its config isn't readable. When a `sudo_password` is supplied
/// (reused from an open-as-root, never a fresh prompt) the dump runs under sudo, so a
/// root-only config tree is still resolved; otherwise the caller falls back to path
/// detection without interrupting the user.
#[tauri::command]
pub async fn nginx_config_files(
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
pub async fn lint_remote(
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
pub async fn server_tools_status(
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
pub async fn run_tool_install(
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
pub async fn sftp_sync_apply(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    run_id: String,
    local_root: String,
    remote_root: String,
    actions: Vec<sync::SyncAction>,
) -> AppResult<sync::SyncStats> {
    let session = session_arc(&state, &session_id).await?;
    let sftp = session.sftp().await?;
    // One run at a time, app-wide; the slot is freed however this command ends.
    let _slot = SyncRunSlot::take(&state.sync_run, &run_id)?;
    let op = sync::sync_mirror_op(&local_root, &remote_root, actions.len());
    let body = sync::sync_mirror_body(&actions);

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .locked()
        .insert(run_id.clone(), cancel.clone());
    let win = appwin::WindowSink::of(&window);
    let res = sync::apply(&win, &sftp, &local_root, &remote_root, actions, cancel).await;
    state.cancels.locked().remove(&run_id);

    let (code, detail) = match &res {
        Ok(stats) if stats.stopped => (130, format!("{body}\nstopped by user")),
        Ok(_) => (0, body),
        Err(e) => (1, format!("{body}\n{e}")),
    };
    session.record_output(sftp::sftp_mirror(&op, code, &detail).as_bytes());
    res
}

/// The app-wide "a sync run is applying" slot, held for the length of one run.
struct SyncRunSlot<'a>(&'a Mutex<Option<String>>);

impl<'a> SyncRunSlot<'a> {
    /// Take the slot for `run_id`, or refuse while another run holds it.
    fn take(slot: &'a Mutex<Option<String>>, run_id: &str) -> AppResult<Self> {
        let mut current = slot.lock().unwrap_or_else(|e| e.into_inner());
        if current.is_some() {
            return Err(AppError::SyncBusy);
        }
        *current = Some(run_id.to_string());
        Ok(Self(slot))
    }
}

impl Drop for SyncRunSlot<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Content search under a remote directory via `grep -rn` over SSH (Phase 12.6).
#[tauri::command]
pub async fn sftp_grep(
    state: State<'_, AppState>,
    session_id: String,
    dir: String,
    query: String,
    case_insensitive: bool,
    fixed: bool,
) -> AppResult<sync::GrepOutcome> {
    if query.trim().is_empty() {
        return Ok(sync::GrepOutcome {
            matches: vec![],
            truncated: false,
            failed: false,
        });
    }
    let session = session_arc(&state, &session_id).await?;
    let out = session
        .run_command(&sync::grep_command(&dir, &query, case_insensitive, fixed))
        .await?;
    Ok(sync::parse_grep_outcome(&out))
}

#[tauri::command]
pub async fn sftp_delete(
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
pub async fn sftp_rename(
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
pub async fn sftp_copy(
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

/// One side of a transfer, resolved: this machine, or a session's SFTP — with
/// the session itself, whose recording is told what was done.
async fn transfer_party(
    state: &State<'_, AppState>,
    side: &transfers::Side,
) -> AppResult<transfers::Party> {
    if side.local {
        return Ok(transfers::Party {
            end: transfers::End::Local,
            ssh: None,
        });
    }
    let id = side.session.as_deref().ok_or(AppError::NoSession)?;
    let session = session_arc(state, id).await?;
    let sftp = session.sftp().await?;
    Ok(transfers::Party {
        end: transfers::End::Remote(sftp),
        ssh: Some(session),
    })
}

/// Take a job into the registry and carry it out in the background. Resolves
/// at once with a receiver of how it ended — which the command drops (a window
/// awaits no transfer) and a promise made to the system keeps (`dragout`).
pub(crate) async fn launch_transfer(
    app: &AppHandle,
    origin: &str,
    spec: transfers::Spec,
) -> AppResult<tokio::sync::oneshot::Receiver<transfers::JobView>> {
    if spec.items.is_empty() {
        return Err("nothing to transfer".into());
    }
    let state = app.state::<AppState>();
    let src = transfer_party(&state, &spec.src).await?;
    let dst = transfer_party(&state, &spec.dst).await?;
    let id = spec.id.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let jobs = app.state::<transfers::Jobs>();
    if !jobs.add(transfers::JobView::start(&spec), cancel.clone(), origin) {
        return Err("a transfer with this id is already running".into());
    }
    // The shared cancel map, for the life of the job: `sftp_cancel` stops it as
    // it stops a sync run or a tree hash — a second way to cancel is not added.
    state.cancels.locked().insert(id.clone(), cancel.clone());
    let (ended, wait) = tokio::sync::oneshot::channel();
    let (app, origin) = (app.clone(), origin.to_string());
    tokio::spawn(async move {
        let done = transfers::run(&app, spec, src, dst, cancel, origin).await;
        app.state::<AppState>().cancels.locked().remove(&id);
        let _ = ended.send(done);
    });
    Ok(wait)
}

/// Start a transfer the backend owns (v1.12, ADR 0025) and return at once: an
/// upload, a download, a copy between two sessions or a local copy, by what the
/// two sides are. Its state travels in `sftp://job` to whichever window shows
/// the tab of each session it touches; `sftp_cancel` with its id stops it. The
/// window that asked awaits nothing — it may give the tab away meanwhile.
#[tauri::command]
pub async fn transfer_start(
    window: tauri::WebviewWindow,
    app: AppHandle,
    spec: transfers::Spec,
) -> AppResult<String> {
    let id = spec.id.clone();
    launch_transfer(&app, window.label(), spec).await?;
    Ok(id)
}

/// The transfers this window shows right now — asked when a window opens, and
/// when it takes a tab over: the job came with the session, its events from
/// now on come here.
#[tauri::command]
pub fn transfer_list(window: tauri::WebviewWindow, app: AppHandle) -> Vec<transfers::JobView> {
    let windows = app.state::<appwin::Windows>();
    app.state::<transfers::Jobs>()
        .shown_in(window.label(), |session| windows.owner_of(session))
}

#[tauri::command]
pub fn sftp_cancel(state: State<AppState>, transfer_id: String) {
    if let Some(flag) = state.cancels.locked().get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_sync_run_applies_at_a_time() {
        let slot = Mutex::new(None);
        let first = SyncRunSlot::take(&slot, "run-1").expect("free slot");
        assert!(matches!(
            SyncRunSlot::take(&slot, "run-2"),
            Err(AppError::SyncBusy)
        ));
        // However the run ends, the slot is free again.
        drop(first);
        assert!(SyncRunSlot::take(&slot, "run-2").is_ok());
    }
}
