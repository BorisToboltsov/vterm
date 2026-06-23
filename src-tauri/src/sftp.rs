//! SFTP operations (listing, mkdir, delete, upload/download with progress)
//! on top of an open `SftpSession`.

use crate::error::AppResult;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const CHUNK: usize = 32 * 1024;
/// Throttle progress events to roughly one per this many transferred bytes.
const PROGRESS_STEP: u64 = 256 * 1024;

/// A remote directory entry sent to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    /// True for real directories and symlinks pointing at a directory.
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Modification time, epoch seconds.
    pub modified: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    name: String,
    direction: &'static str,
    /// Bytes for single-file transfers; completed-file count for folders.
    transferred: u64,
    /// Total bytes for single-file transfers; total file count for folders.
    total: u64,
    done: bool,
    /// True when this is an aggregate folder transfer (`transferred`/`total` are
    /// file counts, and the transfer can be cancelled).
    is_folder: bool,
}

/// Resolve the user's home / starting directory.
pub async fn home(sftp: &SftpSession) -> AppResult<String> {
    sftp.canonicalize(".")
        .await
        .map_err(|e| e.to_string().into())
}

pub async fn list(sftp: &SftpSession, path: &str) -> AppResult<Vec<FileEntry>> {
    let dir = sftp
        .read_dir(path)
        .await
        .map_err(|e| format!("read_dir {path}: {e}"))?;
    let mut out = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let ftype = entry.file_type();
        let meta = entry.metadata();
        let full = join(path, &name);
        let is_symlink = ftype.is_symlink();
        // For symlinks, follow to find whether the target is a directory
        // (so symlink-to-dir is navigable); fall back to "file" if broken.
        let is_dir = if is_symlink {
            sftp.metadata(full.clone())
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            ftype.is_dir()
        };
        out.push(FileEntry {
            path: full,
            is_dir,
            is_symlink,
            size: meta.size.unwrap_or(0),
            modified: meta.mtime.map(|m| m as u64),
            name,
        });
    }
    // Directories first, then case-insensitive by name.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub async fn mkdir(sftp: &SftpSession, path: &str) -> AppResult<()> {
    sftp.create_dir(path)
        .await
        .map_err(|e| e.to_string().into())
}

/// Create an empty regular file at `path` (fails if it already exists is left
/// to the server; russh-sftp `create` truncates, so callers guard duplicates).
pub async fn create_file(sftp: &SftpSession, path: &str) -> AppResult<()> {
    let mut f = sftp.create(path).await.map_err(|e| e.to_string())?;
    f.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn remove(sftp: &SftpSession, path: &str, is_dir: bool) -> AppResult<()> {
    if is_dir {
        sftp.remove_dir(path)
            .await
            .map_err(|e| e.to_string().into())
    } else {
        sftp.remove_file(path)
            .await
            .map_err(|e| e.to_string().into())
    }
}

pub async fn upload(
    app: &AppHandle,
    id: String,
    sftp: &SftpSession,
    local: &str,
    remote: &str,
) -> AppResult<()> {
    let name = base_name(remote);
    let mut src = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("open {local}: {e}"))?;
    let total = src.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut dst = sftp
        .create(remote)
        .await
        .map_err(|e| format!("create {remote}: {e}"))?;
    copy_with_progress(app, &id, &name, "upload", total, &mut src, &mut dst, true).await?;
    dst.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Download a single remote file to `local`.
pub async fn download(
    app: &AppHandle,
    id: String,
    sftp: &SftpSession,
    remote: &str,
    local: &str,
) -> AppResult<()> {
    download_file(app, &id, sftp, remote, local, true).await
}

/// Download a remote directory tree into `local_parent`/<dir name>.
pub async fn download_dir(
    app: &AppHandle,
    id: String,
    sftp: &SftpSession,
    remote_root: &str,
    local_parent: &str,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let local_root = Path::new(local_parent)
        .join(base_name(remote_root))
        .to_string_lossy()
        .to_string();

    // Phase 1: walk the tree — create local dirs, collect files (skip symlinks).
    let mut files: Vec<(String, String)> = Vec::new();
    let mut stack = vec![(remote_root.to_string(), local_root)];
    let mut is_root = true;
    while let Some((rdir, ldir)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        tokio::fs::create_dir_all(&ldir)
            .await
            .map_err(|e| format!("create dir {ldir}: {e}"))?;
        let entries = match list(sftp, &rdir).await {
            Ok(entries) => entries,
            // The root directory must be readable; skip unreadable sub-folders.
            Err(e) if is_root => return Err(e),
            Err(_) => {
                is_root = false;
                continue;
            }
        };
        is_root = false;
        for entry in entries {
            // Skip symlinks: reading them as files fails, and following dir
            // symlinks risks cycles.
            if entry.is_symlink {
                continue;
            }
            let lpath = Path::new(&ldir)
                .join(&entry.name)
                .to_string_lossy()
                .to_string();
            if entry.is_dir {
                stack.push((entry.path, lpath));
            } else {
                files.push((entry.path, lpath));
            }
        }
    }

    // Phase 2: download files with a single aggregate (file-count) progress bar.
    let folder = base_name(remote_root);
    let total = files.len() as u64;
    let mut done: u64 = 0;
    for (remote, local) in &files {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        emit(
            app,
            &id,
            &base_name(remote),
            "download",
            done,
            total,
            false,
            true,
        );
        download_file(app, &id, sftp, remote, local, false).await?;
        done += 1;
    }
    emit(app, &id, &folder, "download", done, total, true, true);
    Ok(())
}

async fn download_file(
    app: &AppHandle,
    id: &str,
    sftp: &SftpSession,
    remote: &str,
    local: &str,
    report: bool,
) -> AppResult<()> {
    let name = base_name(remote);
    let total = sftp
        .metadata(remote)
        .await
        .map(|m| m.size.unwrap_or(0))
        .unwrap_or(0);
    let mut src = sftp
        .open(remote)
        .await
        .map_err(|e| format!("open {remote}: {e}"))?;
    let mut dst = tokio::fs::File::create(local)
        .await
        .map_err(|e| format!("create {local}: {e}"))?;
    copy_with_progress(
        app, id, &name, "download", total, &mut src, &mut dst, report,
    )
    .await?;
    dst.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy with optional progress reporting. When `report` is false (used for the
/// individual files inside a folder download) no per-file events are emitted —
/// the caller emits an aggregate file-count progress instead.
#[allow(clippy::too_many_arguments)]
async fn copy_with_progress<R, W>(
    app: &AppHandle,
    id: &str,
    name: &str,
    direction: &'static str,
    total: u64,
    src: &mut R,
    dst: &mut W,
    report: bool,
) -> AppResult<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let n = src
            .read(&mut buf)
            .await
            .map_err(|e| format!("read {name}: {e}"))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| format!("write {name}: {e}"))?;
        transferred += n as u64;
        if report && transferred - last_emit >= PROGRESS_STEP {
            last_emit = transferred;
            emit(app, id, name, direction, transferred, total, false, false);
        }
    }
    if report {
        emit(app, id, name, direction, transferred, total, true, false);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit(
    app: &AppHandle,
    id: &str,
    name: &str,
    direction: &'static str,
    transferred: u64,
    total: u64,
    done: bool,
    is_folder: bool,
) {
    let _ = app.emit(
        "sftp://progress",
        Progress {
            id: id.to_string(),
            name: name.to_string(),
            direction,
            transferred,
            total,
            done,
            is_folder,
        },
    );
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn base_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}
