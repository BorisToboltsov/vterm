//! SFTP operations (listing, mkdir, delete, upload/download with progress)
//! on top of an open `SftpSession`.

use crate::error::{AppError, AppResult};
use crate::textenc;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const CHUNK: usize = 32 * 1024;
/// Throttle progress events to roughly one per this many transferred bytes.
const PROGRESS_STEP: u64 = 256 * 1024;
/// Default cap (bytes) for opening a file in the in-app editor when the frontend
/// passes no explicit limit. Anything bigger (or binary) should be downloaded
/// instead — the whole content lives in memory and the CodeMirror buffer.
pub const MAX_EDIT_SIZE: u64 = 2 * 1024 * 1024;
/// Hard ceiling (bytes) the configurable editor open-size is clamped to, so a bad
/// setting can't try to slurp a gigantic file into memory. Matches the frontend
/// `MAX_OPEN_MB_LIMIT` (64 MB).
pub const HARD_MAX_EDIT_SIZE: u64 = 64 * 1024 * 1024;

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
    /// Unix permission bits (the entry's own, like `ls -l`), if reported.
    pub mode: Option<u32>,
    /// Windows DOS attributes as an `attrib`-style flag string (`-ar--`), filled
    /// only by the local panel on Windows, where `mode` is meaningless. Always
    /// `None` over SFTP, which is POSIX. See `localfile::dos_attr_string`.
    #[serde(default)]
    pub attrs: Option<String>,
    /// Owner user/group ids.
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    /// Resolved owner names (filled by the command from a cached passwd/group map;
    /// SFTP attrs rarely carry names, so the backend looks them up by uid/gid).
    pub user: Option<String>,
    pub group: Option<String>,
    /// Set only for the synthetic drive rows of the Windows "This PC" level
    /// (Phase 39.1, `drives.rs`). Always `None` for real filesystem entries and
    /// over SFTP, which is POSIX and has no such level.
    #[serde(default)]
    pub drive: Option<crate::drives::DriveInfo>,
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

/// Render a mutating SFTP-panel op for the session recording (audit): a magenta
/// `[sftp] $ <op>` header, the error text (only on failure), and a `[sftp] exit N`
/// footer. Mirrors [`crate::container::container_mirror`]/[`crate::git::git_mirror`]
/// — recorded ONLY (never emitted to the live terminal). SFTP ops have no stdout,
/// so the body carries just the error detail; success leaves it empty. `op` is a
/// shell-like description with paths already quoted (`git::shell_quote`), e.g.
/// `mv '/a' '/b'`, `rm -r '/tmp/x'`, `put '/local' -> '/remote'`.
pub fn sftp_mirror(op: &str, exit_code: i32, detail: &str) -> String {
    let body = if detail.is_empty() {
        String::new()
    } else {
        format!("{}\r\n", detail.replace('\n', "\r\n"))
    };
    format!(
        "\r\n\u{1b}[35m[sftp] $ {op}\u{1b}[0m\r\n{body}\u{1b}[35m[sftp] exit {exit_code}\u{1b}[0m\r\n"
    )
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
            mode: meta.permissions,
            attrs: None, // SFTP is POSIX; DOS attributes are a local-Windows concept.
            drive: None,
            uid: meta.uid,
            gid: meta.gid,
            user: meta.user,
            group: meta.group,
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

/// A `SSH_FXP_SETSTAT` payload that changes **only** the permission bits.
///
/// **Never build `FileAttributes` with `..Default::default()`.** russh-sftp's
/// `Default` is not a blank struct — it is a "new directory" template
/// (`size: Some(0)`, `uid`/`gid: Some(0)`, `atime`/`mtime: Some(0)`,
/// `permissions: Some(0o40777)`), and its `Serialize` impl raises the attribute
/// flag for every `Some` field. So `..Default::default()` asks the server for
/// `ATTR_SIZE = 0` — i.e. `truncate(path, 0)` — plus a chown to root and an epoch
/// mtime, none of which the caller meant.
///
/// That is exactly how the editor's SFTP save destroyed files (Phase 39.6): the
/// content reached the staging temp intact, this call truncated the temp to zero,
/// and the empty temp was then renamed over the user's file. The write reported
/// success because `WriteResult` hashes the bytes we *intended* to send. Fixing
/// it means spelling every field out as `None`; the guard test below keeps it that
/// way. Same trap applies to `sync::sudo_write`'s staging file.
pub(crate) fn chmod_attrs(permissions: u32) -> FileAttributes {
    FileAttributes {
        size: None,
        uid: None,
        user: None,
        gid: None,
        group: None,
        permissions: Some(permissions),
        atime: None,
        mtime: None,
    }
}

/// Write bytes to a new (or truncated) remote file. **Always go through `create`**:
/// russh-sftp's `SftpSession::write` opens WRITE-only without `CREATE`, so it fails
/// with "No such file" on a fresh path (staging temps, `.bak` copies, sudo temp).
pub(crate) async fn write_bytes(sftp: &SftpSession, path: &str, data: &[u8]) -> AppResult<()> {
    let mut f = sftp
        .create(path.to_string())
        .await
        .map_err(|e| format!("create {path}: {e}"))?;
    f.write_all(data)
        .await
        .map_err(|e| format!("write {path}: {e}"))?;
    f.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// A text file opened in the in-app editor.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    /// Detected line-ending style, `"lf"` or `"crlf"` — re-applied on save so we
    /// don't silently rewrite a CRLF config to LF.
    pub eol: &'static str,
    pub size: u64,
    /// Unix permission bits, if the server reported them (preserved on save).
    pub mode: Option<u32>,
    /// Modification time, epoch seconds.
    pub mtime: Option<u64>,
    /// SHA-256 of the on-server bytes when opened — passed back on save for
    /// conflict detection (best-effort guard against overwriting prod blindly).
    pub sha256: String,
    /// Best-effort read-only hint: the file has no write bit set for anyone
    /// (e.g. mode `0444`). The authoritative check is the write itself.
    pub read_only: bool,
    /// Encoding the file was decoded from (`utf-8`, `utf-16le-bom`,
    /// `windows-1251`…). Passed back on save so we re-encode in the SAME
    /// encoding instead of silently rewriting the file as UTF-8 — see textenc.rs.
    #[serde(default)]
    pub encoding: String,
}

/// Result of a successful text save — fresh metadata for the editor to adopt.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub sha256: String,
    pub size: u64,
    pub mtime: Option<u64>,
}

/// Read a remote file as UTF-8 text for the editor. Rejects files larger than
/// `max_bytes` or binary (NUL byte / invalid UTF-8) — the caller should download
/// those. `max_bytes` is the configured editor open-size (see lib.rs clamping).
pub async fn read_text(sftp: &SftpSession, path: &str, max_bytes: u64) -> AppResult<TextFile> {
    let meta = sftp
        .metadata(path)
        .await
        .map_err(|e| format!("stat {path}: {e}"))?;
    if meta.is_dir() {
        return Err(AppError::Message(format!("{path} is a directory")));
    }
    if let Some(size) = meta.size {
        if size > max_bytes {
            return Err(AppError::Message(format!(
                "file too large to edit ({size} bytes, limit {max_bytes})"
            )));
        }
    }

    let bytes = sftp
        .read(path)
        .await
        .map_err(|e| format!("read {path}: {e}"))?;
    if (bytes.len() as u64) > max_bytes {
        return Err(AppError::Message("file too large to edit".into()));
    }
    // Decode by BOM/sniff/detector rather than assuming UTF-8; `decode` also
    // subsumes the old `looks_binary` check, because UTF-16's interleaved NULs
    // would otherwise read as binary (textenc.rs).
    let decoded = textenc::decode(&bytes)
        .ok_or_else(|| AppError::Message("file appears to be binary".into()))?;
    let content = decoded.text;

    // Hash the raw on-server bytes, not the decoded text: `write_text` compares
    // against the bytes it reads back, and for a non-UTF-8 file the two differ.
    let sha256 = sha256_hex(&bytes);
    let eol = detect_eol(&content);
    Ok(TextFile {
        eol,
        size: meta.size.unwrap_or(bytes.len() as u64),
        mode: meta.permissions,
        mtime: meta.mtime.map(|m| m as u64),
        read_only: is_read_only(meta.permissions),
        encoding: decoded.encoding,
        sha256,
        // Normalize to LF for the editor; the original style is carried in `eol`.
        content: content.replace("\r\n", "\n"),
    })
}

/// A text-write request: the target path, the content plus its line-ending style,
/// an optional expected-hash conflict guard, and whether to keep a `.bak`. Shared
/// by the direct [`write_text`] and the privileged [`crate::sync::sudo_write`].
pub(crate) struct TextWrite<'a> {
    pub path: &'a str,
    pub content: &'a str,
    pub eol: &'a str,
    /// Encoding to write back in — the one `read_text` reported. Empty means
    /// UTF-8 (new file, or a caller with nothing recorded).
    pub encoding: &'a str,
    pub expected_sha256: Option<&'a str>,
    pub backup: bool,
}

/// Write text back to `path`. Writes a sibling temp file then renames over the
/// target (so a failed/partial write never truncates the original), preserving
/// the original permission bits. When `expected_sha256` is given and the file
/// still exists, a mismatch means it changed on the server → `FileChangedOnServer`.
pub async fn write_text(sftp: &SftpSession, req: &TextWrite<'_>) -> AppResult<WriteResult> {
    let TextWrite {
        path,
        content,
        eol,
        encoding,
        expected_sha256,
        backup,
    } = *req;
    // Existing file: capture mode + verify it hasn't changed under us.
    let existing = sftp.metadata(path).await.ok();
    let mode = existing.as_ref().and_then(|m| m.permissions);
    if let Some(expected) = expected_sha256 {
        if existing.is_some() {
            let current = sftp
                .read(path)
                .await
                .map_err(|e| format!("read {path}: {e}"))?;
            if sha256_hex(&current) != expected {
                return Err(AppError::FileChangedOnServer);
            }
        }
    }

    // Optional backup of the current file before overwriting: a `<path>.bak`
    // sibling in the same directory, one generation (the next save overwrites it).
    //
    // Failure here **aborts the save**, and does so while the target is still
    // untouched: the user asked for a copy before the overwrite, so overwriting
    // without one is the exact outcome the setting exists to prevent. Reporting
    // success over an unbacked overwrite would be the same silent-failure shape
    // that made the truncation bug so damaging.
    //
    // The copy MUST also carry the original's permission bits. `write_bytes`
    // creates with the server's default (0644 under a typical umask), so a `0600`
    // config full of credentials was being backed up into a world-readable
    // sibling. If the bits cannot be applied the copy is removed rather than left
    // over-permissive — a leaked backup is worse than a refused save. The sudo
    // path gets this for free via `cp -p`; here it has to be asked for.
    if backup && existing.is_some() {
        let bak = format!("{path}.bak");
        let cur = sftp
            .read(path)
            .await
            .map_err(|e| AppError::BackupFailed(format!("read {path}: {e}")))?;
        write_bytes(sftp, &bak, &cur)
            .await
            .map_err(|e| AppError::BackupFailed(e.to_string()))?;
        if let Some(perm) = mode {
            if let Err(e) = sftp.set_metadata(bak.clone(), chmod_attrs(perm)).await {
                let _ = sftp.remove_file(bak).await;
                return Err(AppError::BackupFailed(format!(
                    "could not restrict {path}.bak to the original permissions: {e}"
                )));
            }
        }
    }

    // Re-impose the file's original line endings, then its original encoding.
    let out = apply_eol(content, eol);
    let encoded = textenc::encode(&out, encoding);
    let bytes = &encoded[..];

    let tmp = temp_sibling(path);
    write_bytes(sftp, &tmp, bytes).await?;
    // Preserve the original permission bits on the replacement. Best-effort: a
    // non-owner may legitimately be refused the chmod, and the content matters
    // more than the mode. NOTE the `chmod_attrs` builder — see its doc comment;
    // `..Default::default()` here silently truncated every saved file to zero.
    if let Some(perm) = mode {
        let _ = sftp.set_metadata(tmp.clone(), chmod_attrs(perm)).await;
    }
    // SSH_FXP_RENAME fails if the target exists (OpenSSH), so drop it first.
    // This is the only non-atomic window; the temp already holds the full content.
    if existing.is_some() {
        let _ = sftp.remove_file(path).await;
    }
    if let Err(e) = sftp.rename(tmp.clone(), path).await {
        let _ = sftp.remove_file(tmp).await;
        return Err(format!("rename onto {path}: {e}").into());
    }

    let after = sftp.metadata(path).await.ok();
    Ok(WriteResult {
        sha256: sha256_hex(bytes),
        size: bytes.len() as u64,
        mtime: after.and_then(|m| m.mtime).map(|m| m as u64),
    })
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

/// Move (rename) `from` to `to` on the remote host. Refuses if `to` already
/// exists so a drag-move never clobbers an unrelated file — the frontend maps
/// `DestinationExists` to a name-conflict toast. Both paths must be on the same
/// SFTP session (same host); a plain `rename` is atomic within one filesystem.
pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> AppResult<()> {
    if sftp.metadata(to.to_string()).await.is_ok() {
        return Err(AppError::DestinationExists);
    }
    sftp.rename(from.to_string(), to.to_string())
        .await
        .map_err(|e| e.to_string().into())
}

/// Copy a remote file/folder to `to` (recursively), entirely inside the SFTP
/// subsystem — no shell exec, so there's no command-injection surface. Refuses if
/// `to` exists (frontend maps `DestinationExists` to a conflict toast). Symlinks
/// inside a tree are skipped to avoid following link targets / cycles.
pub async fn copy(sftp: &SftpSession, from: &str, to: &str) -> AppResult<()> {
    if sftp.metadata(to.to_string()).await.is_ok() {
        return Err(AppError::DestinationExists);
    }
    copy_recursive(sftp, from, to).await
}

async fn copy_recursive(sftp: &SftpSession, from: &str, to: &str) -> AppResult<()> {
    let meta = sftp
        .metadata(from.to_string())
        .await
        .map_err(|e| format!("stat {from}: {e}"))?;
    if meta.is_dir() {
        sftp.create_dir(to)
            .await
            .map_err(|e| format!("create dir {to}: {e}"))?;
        for entry in list(sftp, from).await? {
            if entry.is_symlink {
                continue;
            }
            let child_to = join(to, &entry.name);
            Box::pin(copy_recursive(sftp, &entry.path, &child_to)).await?;
        }
        Ok(())
    } else {
        let mut src = sftp
            .open(from)
            .await
            .map_err(|e| format!("open {from}: {e}"))?;
        let mut dst = sftp
            .create(to)
            .await
            .map_err(|e| format!("create {to}: {e}"))?;
        tokio::io::copy(&mut src, &mut dst)
            .await
            .map_err(|e| format!("copy {from} → {to}: {e}"))?;
        dst.shutdown().await.map_err(|e| e.to_string())?;
        Ok(())
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
    let t = Transfer {
        app,
        id: &id,
        name: &name,
        direction: "upload",
        total,
    };
    copy_with_progress(&t, &mut src, &mut dst, true).await?;
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
        Transfer {
            app,
            id: &id,
            name: &base_name(remote),
            direction: "download",
            total,
        }
        .emit(done, false, true);
        download_file(app, &id, sftp, remote, local, false).await?;
        done += 1;
    }
    Transfer {
        app,
        id: &id,
        name: &folder,
        direction: "download",
        total,
    }
    .emit(done, true, true);
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
    let t = Transfer {
        app,
        id,
        name: &name,
        direction: "download",
        total,
    };
    copy_with_progress(&t, &mut src, &mut dst, report).await?;
    dst.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// The invariant descriptor of one transfer, shared by the copy loop and its
/// progress events: `app`/`id`/`name`/`direction`/`total` don't change mid-copy.
struct Transfer<'a> {
    app: &'a AppHandle,
    id: &'a str,
    name: &'a str,
    direction: &'static str,
    total: u64,
}

impl Transfer<'_> {
    /// Emit one `sftp://progress` event for this transfer.
    fn emit(&self, transferred: u64, done: bool, is_folder: bool) {
        let _ = self.app.emit(
            "sftp://progress",
            Progress {
                id: self.id.to_string(),
                name: self.name.to_string(),
                direction: self.direction,
                transferred,
                total: self.total,
                done,
                is_folder,
            },
        );
    }
}

/// Copy with optional progress reporting. When `report` is false (used for the
/// individual files inside a folder download) no per-file events are emitted —
/// the caller emits an aggregate file-count progress instead.
async fn copy_with_progress<R, W>(
    t: &Transfer<'_>,
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
            .map_err(|e| format!("read {}: {e}", t.name))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| format!("write {}: {e}", t.name))?;
        transferred += n as u64;
        if report && transferred - last_emit >= PROGRESS_STEP {
            last_emit = transferred;
            t.emit(transferred, false, false);
        }
    }
    if report {
        t.emit(transferred, true, false);
    }
    Ok(())
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

/// Parse `/etc/passwd` or `/etc/group` (or `getent` output) into an id→name map.
/// Both share the `name:x:id:…` layout (field 0 = name, field 2 = numeric id), so
/// one parser serves users and groups. First name per id wins.
pub(crate) fn parse_id_names(text: &str) -> std::collections::HashMap<u32, String> {
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        let mut it = line.split(':');
        let name = it.next().unwrap_or("");
        let _ = it.next(); // password placeholder
        if let Some(id) = it.next().and_then(|s| s.trim().parse::<u32>().ok()) {
            if !name.is_empty() {
                map.entry(id).or_insert_with(|| name.to_string());
            }
        }
    }
    map
}

/// A hidden, time-stamped sibling path used as the atomic-write staging file.
fn temp_sibling(path: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let (dir, name) = match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    };
    if dir.is_empty() {
        format!(".{name}.vterm-tmp-{nanos:x}")
    } else {
        format!("{dir}/.{name}.vterm-tmp-{nanos:x}")
    }
}

/// Heuristic binary detection: a NUL byte in the first chunk. Good enough to keep
/// the editor from choking on images/executables; valid UTF-8 text has none.
/// Shared with the local-file editor ([`crate::localfile`]).
pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    let scan = bytes.len().min(CHUNK);
    bytes[..scan].contains(&0)
}

/// `"crlf"` if any CRLF is present, else `"lf"`.
pub(crate) fn detect_eol(s: &str) -> &'static str {
    if s.contains("\r\n") {
        "crlf"
    } else {
        "lf"
    }
}

/// Normalize to LF, then apply the requested ending. The editor always hands us
/// LF content; this re-imposes the file's original style on save.
pub(crate) fn apply_eol(content: &str, eol: &str) -> String {
    let lf = content.replace("\r\n", "\n");
    if eol == "crlf" {
        lf.replace('\n', "\r\n")
    } else {
        lf
    }
}

/// Best-effort: no write bit set for owner/group/other (e.g. `0o444`).
pub(crate) fn is_read_only(mode: Option<u32>) -> bool {
    mode.map(|m| m & 0o222 == 0).unwrap_or(false)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sftp_mirror_success_has_no_body() {
        let m = sftp_mirror("mv '/a' '/b'", 0, "");
        assert!(m.contains("[sftp] $ mv '/a' '/b'"));
        assert!(m.contains("[sftp] exit 0"));
        // No error body between header and footer on success.
        assert!(m.contains("\u{1b}[0m\r\n\u{1b}[35m[sftp] exit 0"));
    }

    #[test]
    fn sftp_mirror_failure_carries_error_and_exit() {
        let m = sftp_mirror("rm '/etc/passwd'", 1, "permission denied");
        assert!(m.contains("[sftp] $ rm '/etc/passwd'"));
        assert!(m.contains("permission denied\r\n"));
        assert!(m.contains("[sftp] exit 1"));
    }

    #[test]
    fn sha256_matches_known_vector() {
        // Empty string and "abc" — standard SHA-256 test vectors.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn detects_eol_styles() {
        assert_eq!(detect_eol("a\nb\n"), "lf");
        assert_eq!(detect_eol("a\r\nb\r\n"), "crlf");
        assert_eq!(detect_eol("single line"), "lf");
    }

    #[test]
    fn apply_eol_round_trips() {
        // Editor content is LF; saving as crlf converts, saving as lf keeps it.
        assert_eq!(apply_eol("a\nb", "crlf"), "a\r\nb");
        assert_eq!(apply_eol("a\nb", "lf"), "a\nb");
        // Idempotent: crlf input normalized first, not doubled.
        assert_eq!(apply_eol("a\r\nb", "crlf"), "a\r\nb");
        assert_eq!(apply_eol("a\r\nb", "lf"), "a\nb");
    }

    #[test]
    fn binary_detection_flags_nul() {
        assert!(!looks_binary(b"plain text config\n"));
        assert!(looks_binary(b"ELF\0\0\0binary"));
        assert!(!looks_binary("конфиг = значение".as_bytes()));
    }

    #[test]
    fn read_only_from_mode_bits() {
        assert!(is_read_only(Some(0o444)));
        assert!(!is_read_only(Some(0o644)));
        assert!(!is_read_only(Some(0o600)));
        assert!(!is_read_only(None));
    }

    #[test]
    fn parse_id_names_reads_name_and_id() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\nboris:x:1000:1000:Boris:/home/boris:/bin/bash\n# comment\nbad line\n";
        let m = parse_id_names(passwd);
        assert_eq!(m.get(&0).map(String::as_str), Some("root"));
        assert_eq!(m.get(&1000).map(String::as_str), Some("boris"));
        assert_eq!(m.len(), 2);
        // Group format is identical (name:x:gid:...).
        let group = parse_id_names("docker:x:998:boris\n");
        assert_eq!(group.get(&998).map(String::as_str), Some("docker"));
    }

    #[test]
    fn temp_sibling_is_hidden_and_in_same_dir() {
        let t = temp_sibling("/etc/nginx/nginx.conf");
        assert!(t.starts_with("/etc/nginx/.nginx.conf.vterm-tmp-"));
        let t2 = temp_sibling("bare.txt");
        assert!(t2.starts_with(".bare.txt.vterm-tmp-"));
        assert!(!t2.contains('/'));
    }

    /// A chmod payload must carry the permission bits and NOTHING else. Any other
    /// `Some` field becomes an attribute flag on the wire — `size` in particular
    /// means `truncate`, which is how saved files were being emptied (Phase 39.6).
    #[test]
    fn chmod_attrs_sets_only_permissions() {
        let a = chmod_attrs(0o100_644);
        assert_eq!(a.permissions, Some(0o100_644));
        assert_eq!(a.size, None, "ATTR_SIZE would truncate the file");
        assert_eq!(a.uid, None);
        assert_eq!(a.gid, None);
        assert_eq!(a.user, None);
        assert_eq!(a.group, None);
        assert_eq!(a.atime, None);
        assert_eq!(a.mtime, None);
    }

    /// Documents *why* `chmod_attrs` spells out every field: russh-sftp's `Default`
    /// is a populated "new directory" template, not a blank struct. If a future
    /// upgrade ever makes `Default` blank, this test fails and the guard below can
    /// be relaxed deliberately rather than by accident.
    #[test]
    fn russh_sftp_default_attrs_are_not_blank() {
        let d = FileAttributes::default();
        assert_eq!(d.size, Some(0), "Default is a template, not a blank struct");
        assert_eq!(d.uid, Some(0));
        assert_eq!(d.gid, Some(0));
        assert_eq!(d.atime, Some(0));
        assert_eq!(d.mtime, Some(0));
    }

    /// Guard: no attribute literal in the tree may fill its rest from `Default`.
    /// Every construction must go through `chmod_attrs` (or spell out all fields),
    /// because `Default` silently requests a truncate-to-zero. Mirrors the frontend
    /// guard tests (`terminput.guard.test.ts`, `overlay.guard.test.ts`).
    #[test]
    fn no_file_attributes_built_from_default() {
        // Assembled at runtime so this file's own source does not contain the
        // literals it scans for — otherwise the guard reports itself.
        let open = format!("FileAttributes{}", " {");
        let spread = format!("..{}::default()", "Default");
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![dir];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d).expect("read src dir") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_some_and(|e| e == "rs") {
                    let src = std::fs::read_to_string(&path).expect("read source");
                    // Look inside each `FileAttributes { … }` literal only, so the
                    // doc comments above (which name the anti-pattern) don't trip it.
                    for (i, _) in src.match_indices(open.as_str()) {
                        let tail = &src[i..];
                        let end = tail.find('}').unwrap_or(tail.len());
                        if tail[..end].contains(spread.as_str()) {
                            offenders.push(path.display().to_string());
                        }
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "FileAttributes must not be built from Default (it sends ATTR_SIZE=0 \
             and truncates the file) — use sftp::chmod_attrs. Offenders: {offenders:?}"
        );
    }
}

/// Live round-trip tests against a real SFTP server — the shared test container
/// (`docker compose -f e2e/docker-compose.ssh.yml up -d`), same one the E2E suite
/// uses. See docs/TESTS.md.
///
/// These are `#[ignore]`d: they need that listener, so a plain `cargo test` stays
/// hermetic. Run them with
/// `cargo test --manifest-path src-tauri/Cargo.toml --lib live_sftp -- --ignored`.
///
/// They exist because the whole pure-function suite above was green while the
/// editor destroyed every file it saved (Phase 39.6). The defect was in what we
/// asked the server to do, not in any value we computed — a class of bug that is
/// invisible without a server on the other end. Anything that changes the SFTP
/// wire conversation (attributes, rename/remove ordering, encodings) belongs here.
#[cfg(test)]
mod live_sftp {
    use super::*;
    use russh::client;
    use std::sync::Arc;

    /// Connection details, overridable exactly like the E2E suite's.
    fn env_or(key: &str, fallback: &str) -> String {
        std::env::var(key).unwrap_or_else(|_| fallback.into())
    }
    fn host() -> String {
        env_or("VTERM_TEST_SSH_HOST", "127.0.0.1")
    }
    fn port() -> u16 {
        env_or("VTERM_TEST_SSH_PORT", "2222")
            .parse()
            .unwrap_or(2222)
    }

    /// Writable home in the linuxserver/openssh-server image.
    const DIR: &str = "/config";

    struct AcceptAnyKey;

    impl client::Handler for AcceptAnyKey {
        type Error = russh::Error;
        // Throwaway local container; its host key is regenerated on every `up`.
        async fn check_server_key(
            &mut self,
            _key: &russh::keys::ssh_key::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    async fn connect() -> SftpSession {
        let config = Arc::new(client::Config::default());
        let (user, pass) = (
            env_or("VTERM_TEST_SSH_USER", "tester"),
            env_or("VTERM_TEST_SSH_PASS", "testpass"),
        );
        let mut handle = client::connect(config, (host(), port()), AcceptAnyKey)
            .await
            .expect("no test SSH server — docker compose -f e2e/docker-compose.ssh.yml up -d");
        assert!(
            handle
                .authenticate_password(&user, &pass)
                .await
                .expect("auth call failed")
                .success(),
            "test server rejected the credentials"
        );
        let channel = handle
            .channel_open_session()
            .await
            .expect("open session channel");
        channel
            .request_subsystem(true, "sftp")
            .await
            .expect("request sftp subsystem");
        SftpSession::new(channel.into_stream())
            .await
            .expect("sftp handshake")
    }

    /// Unique path per test so the cases stay independent when run in parallel.
    fn path_for(case: &str) -> String {
        format!("{DIR}/vterm-live-{case}-{}.conf", crate::uuid_like())
    }

    async fn seed(sftp: &SftpSession, path: &str, bytes: &[u8]) {
        write_bytes(sftp, path, bytes).await.expect("seed file");
    }

    /// THE Phase 39.6 regression: open a populated config, change one value, save.
    /// Before the fix the staging temp was truncated by the permission-preserving
    /// setstat and the empty temp was renamed over the user's file — while the
    /// write reported success, because `WriteResult` hashes the intended bytes.
    #[tokio::test]
    #[ignore = "needs e2e/docker-compose.ssh.yml up -d"]
    async fn save_keeps_the_content_it_reported_writing() {
        let sftp = connect().await;
        let path = path_for("roundtrip");
        let original = "listen = 80\nworkers = 4\nname = old\n";
        seed(&sftp, &path, original.as_bytes()).await;

        let opened = read_text(&sftp, &path, MAX_EDIT_SIZE).await.expect("open");
        assert_eq!(opened.content, original);

        let edited = "listen = 80\nworkers = 4\nname = NEW\n";
        let res = write_text(
            &sftp,
            &TextWrite {
                path: &path,
                content: edited,
                eol: opened.eol,
                encoding: &opened.encoding,
                expected_sha256: Some(&opened.sha256),
                backup: false,
            },
        )
        .await
        .expect("save");

        // What the server holds must match both the file and the receipt we gave
        // the editor — a green toast over an emptied file is the bug itself.
        let on_server = sftp.read(path.clone()).await.expect("read back");
        assert_eq!(String::from_utf8_lossy(&on_server), edited);
        assert_eq!(res.size, edited.len() as u64);
        assert_eq!(res.sha256, sha256_hex(&on_server));

        // And reopening shows the edit, which is how the user noticed.
        let reopened = read_text(&sftp, &path, MAX_EDIT_SIZE)
            .await
            .expect("reopen");
        assert_eq!(reopened.content, edited);

        let _ = sftp.remove_file(path).await;
    }

    /// The "keep a .bak on the server" setting: where the copy lands, what it
    /// holds, and — the part that was wrong — what it is readable by.
    ///
    /// A backup created with wider permissions than its original is a data leak
    /// dressed as a safety feature: `write_bytes` creates at the server's default,
    /// so a 0600 config full of credentials produced a 0644 `.bak` sibling.
    #[tokio::test]
    #[ignore = "needs e2e/docker-compose.ssh.yml up -d"]
    async fn backup_copy_is_a_sibling_that_keeps_the_original_mode() {
        let sftp = connect().await;
        let path = path_for("bak");
        let bak = format!("{path}.bak");
        seed(&sftp, &path, b"db_password = hunter2\n").await;
        sftp.set_metadata(path.clone(), chmod_attrs(0o600))
            .await
            .expect("lock the seed down");

        let opened = read_text(&sftp, &path, MAX_EDIT_SIZE).await.expect("open");
        write_text(
            &sftp,
            &TextWrite {
                path: &path,
                content: "db_password = rotated\n",
                eol: opened.eol,
                encoding: &opened.encoding,
                expected_sha256: Some(&opened.sha256),
                backup: true,
            },
        )
        .await
        .expect("save with backup");

        // Right next to the original, holding the pre-save content.
        let meta = sftp.metadata(bak.clone()).await.expect("no .bak sibling");
        assert_eq!(
            String::from_utf8_lossy(&sftp.read(bak.clone()).await.expect("read .bak")),
            "db_password = hunter2\n"
        );
        // And no more readable than what it copied.
        assert_eq!(
            meta.permissions.expect("mode reported") & 0o777,
            0o600,
            "the .bak widened access to the secrets it copied"
        );

        let _ = sftp.remove_file(bak).await;
        let _ = sftp.remove_file(path).await;
    }

    /// When the `.bak` cannot be made, the save must be ABANDONED — not completed
    /// without a backup. The user ticked "copy it first"; overwriting anyway is
    /// the one outcome the setting exists to prevent, and reporting success over
    /// it repeats the silent-failure shape that made the truncation bug so bad.
    ///
    /// The copy is sabotaged by parking a directory on the `.bak` name, which no
    /// amount of permission fiddling can turn into a writable file — and needs no
    /// root, so the test runs as the ordinary container user.
    #[tokio::test]
    #[ignore = "needs e2e/docker-compose.ssh.yml up -d"]
    async fn a_failed_backup_aborts_the_save_and_leaves_the_file_intact() {
        let sftp = connect().await;
        let path = path_for("bakfail");
        let bak = format!("{path}.bak");
        let original = "keep = this\n";
        seed(&sftp, &path, original.as_bytes()).await;
        sftp.create_dir(bak.clone())
            .await
            .expect("park a directory on the .bak name");

        let opened = read_text(&sftp, &path, MAX_EDIT_SIZE).await.expect("open");
        let err = write_text(
            &sftp,
            &TextWrite {
                path: &path,
                content: "clobbered = yes\n",
                eol: opened.eol,
                encoding: &opened.encoding,
                expected_sha256: Some(&opened.sha256),
                backup: true,
            },
        )
        .await
        .expect_err("save must refuse when the backup cannot be made");

        // Typed, and carrying the marker the frontend switches on.
        assert!(
            matches!(err, AppError::BackupFailed(_)),
            "expected BackupFailed, got {err:?}"
        );
        assert!(err.to_string().contains("backup-failed"));

        // The whole point: the server still holds the original, untouched.
        assert_eq!(
            String::from_utf8_lossy(&sftp.read(path.clone()).await.expect("read back")),
            original,
            "the file was overwritten despite the backup failing"
        );

        let _ = sftp.remove_dir(bak).await;
        let _ = sftp.remove_file(path).await;
    }

    /// The `.bak` step must not fail a save for a file that does not exist yet —
    /// there is nothing to copy, and "save a new file" is not a backup failure.
    #[tokio::test]
    #[ignore = "needs e2e/docker-compose.ssh.yml up -d"]
    async fn backup_is_skipped_for_a_file_that_does_not_exist_yet() {
        let sftp = connect().await;
        let path = path_for("bak-new");

        let res = write_text(
            &sftp,
            &TextWrite {
                path: &path,
                content: "fresh = 1\n",
                eol: "lf",
                encoding: textenc::UTF8,
                expected_sha256: None,
                backup: true,
            },
        )
        .await
        .expect("a brand-new file saves with backup enabled");
        assert_eq!(res.size, "fresh = 1\n".len() as u64);
        assert!(
            sftp.metadata(format!("{path}.bak")).await.is_err(),
            "nothing existed to back up, so no .bak should have appeared"
        );

        let _ = sftp.remove_file(path).await;
    }

    /// The truncation came from over-broad attributes, and the tempting overfix is
    /// to stop sending attributes at all. This pins the behaviour we actually want:
    /// content survives AND the original mode is carried onto the replacement.
    #[tokio::test]
    #[ignore = "needs e2e/docker-compose.ssh.yml up -d"]
    async fn save_preserves_permission_bits() {
        let sftp = connect().await;
        let path = path_for("mode");
        seed(&sftp, &path, b"secret = 1\n").await;
        sftp.set_metadata(path.clone(), chmod_attrs(0o600))
            .await
            .expect("chmod the seed");

        let opened = read_text(&sftp, &path, MAX_EDIT_SIZE).await.expect("open");
        write_text(
            &sftp,
            &TextWrite {
                path: &path,
                content: "secret = 2\n",
                eol: opened.eol,
                encoding: &opened.encoding,
                expected_sha256: Some(&opened.sha256),
                backup: false,
            },
        )
        .await
        .expect("save");

        let meta = sftp.metadata(path.clone()).await.expect("stat");
        assert_eq!(
            meta.permissions.expect("mode reported") & 0o777,
            0o600,
            "the replacement lost the original mode"
        );
        assert_eq!(
            String::from_utf8_lossy(&sftp.read(path.clone()).await.expect("read")),
            "secret = 2\n"
        );

        let _ = sftp.remove_file(path).await;
    }

    /// Phase 39's encoding contract, verified over the wire rather than in memory:
    /// a UTF-16LE config must come back UTF-16LE, CRLF intact. Decoding round-trips
    /// are unit-tested in textenc.rs; this proves the bytes survive the save path.
    #[tokio::test]
    #[ignore = "needs e2e/docker-compose.ssh.yml up -d"]
    async fn save_rewrites_in_the_original_encoding() {
        let sftp = connect().await;
        let path = path_for("utf16");
        let mut raw = vec![0xFF, 0xFE]; // UTF-16LE BOM
        for unit in "[main]\r\nkey=old\r\n".encode_utf16() {
            raw.extend_from_slice(&unit.to_le_bytes());
        }
        seed(&sftp, &path, &raw).await;

        let opened = read_text(&sftp, &path, MAX_EDIT_SIZE).await.expect("open");
        assert_eq!(opened.encoding, textenc::UTF16LE_BOM);
        assert_eq!(opened.eol, "crlf");
        // The editor buffer is always LF; the save re-imposes CRLF.
        assert_eq!(opened.content, "[main]\nkey=old\n");

        write_text(
            &sftp,
            &TextWrite {
                path: &path,
                content: "[main]\nkey=new\n",
                eol: opened.eol,
                encoding: &opened.encoding,
                expected_sha256: Some(&opened.sha256),
                backup: false,
            },
        )
        .await
        .expect("save");

        let mut expected = vec![0xFF, 0xFE];
        for unit in "[main]\r\nkey=new\r\n".encode_utf16() {
            expected.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(
            sftp.read(path.clone()).await.expect("read back"),
            expected,
            "the file was not rewritten in its original encoding"
        );

        let _ = sftp.remove_file(path).await;
    }
}
