//! Local-filesystem text read/write for the in-app editor — the local-host
//! counterpart of [`crate::sftp`]'s `read_text`/`write_text` (Phase 12.4, the
//! "Open with vterm" flow). Reuses sftp.rs's pure transforms (binary/eol/sha) so
//! the editor contract is identical; only the I/O backend differs (std/tokio fs
//! vs the SFTP session).

use crate::error::{AppError, AppResult};
use crate::sftp::{
    apply_eol, detect_eol, is_read_only, looks_binary, sha256_hex, FileEntry, TextFile, WriteResult,
};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The user's home directory (starting point for the local file browser).
pub fn home() -> AppResult<String> {
    directories::UserDirs::new()
        .map(|u| u.home_dir().to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Message("no home directory".into()))
}

/// List a local directory (dirs first, then case-insensitive by name) — the local
/// counterpart of `sftp::list`, same `FileEntry` shape.
pub async fn list(path: &str) -> AppResult<Vec<FileEntry>> {
    let mut rd = tokio::fs::read_dir(path)
        .await
        .map_err(|e| format!("read_dir {path}: {e}"))?;
    let mut out = Vec::new();
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| format!("read_dir {path}: {e}"))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        let full = entry.path().to_string_lossy().into_owned();
        let ftype = entry.file_type().await.ok();
        let is_symlink = ftype.map(|t| t.is_symlink()).unwrap_or(false);
        // Follow symlinks only to decide navigability (symlink-to-dir).
        let is_dir = if is_symlink {
            tokio::fs::metadata(&full)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            ftype.map(|t| t.is_dir()).unwrap_or(false)
        };
        let meta = entry.metadata().await.ok();
        let (uid, gid) = meta.as_ref().map(file_owner).unwrap_or((None, None));
        out.push(FileEntry {
            path: full,
            is_dir,
            is_symlink,
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified: meta.as_ref().and_then(mtime_secs),
            mode: meta.as_ref().and_then(file_mode),
            uid,
            gid,
            user: None,
            group: None,
            name,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub async fn mkdir(path: &str) -> AppResult<()> {
    tokio::fs::create_dir(path)
        .await
        .map_err(|e| e.to_string().into())
}

/// Create an empty file, failing if it already exists (so we never clobber).
pub async fn create_file(path: &str) -> AppResult<()> {
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string().into())
}

pub async fn remove(path: &str, is_dir: bool) -> AppResult<()> {
    let r = if is_dir {
        tokio::fs::remove_dir(path).await
    } else {
        tokio::fs::remove_file(path).await
    };
    r.map_err(|e| e.to_string().into())
}

/// Move (rename) `from` to `to` on the local filesystem. Refuses if `to` already
/// exists so a drag-move never clobbers an unrelated file — the frontend maps
/// `DestinationExists` to a name-conflict toast. `rename` is atomic within one
/// filesystem; a cross-device move (EXDEV) surfaces as a plain error toast.
pub async fn rename(from: &str, to: &str) -> AppResult<()> {
    if tokio::fs::symlink_metadata(to).await.is_ok() {
        return Err(AppError::DestinationExists);
    }
    tokio::fs::rename(from, to)
        .await
        .map_err(|e| e.to_string().into())
}

/// Copy a local file/folder to `to` (recursively). Refuses if `to` already exists.
/// Symlinks inside a tree are skipped (parity with the SFTP copy).
pub async fn copy(from: &str, to: &str) -> AppResult<()> {
    if tokio::fs::symlink_metadata(to).await.is_ok() {
        return Err(AppError::DestinationExists);
    }
    copy_recursive(Path::new(from), Path::new(to)).await
}

async fn copy_recursive(from: &Path, to: &Path) -> AppResult<()> {
    let meta = tokio::fs::symlink_metadata(from).await?;
    if meta.is_dir() {
        tokio::fs::create_dir(to).await?;
        let mut rd = tokio::fs::read_dir(from).await?;
        while let Some(entry) = rd.next_entry().await? {
            if entry.file_type().await?.is_symlink() {
                continue;
            }
            Box::pin(copy_recursive(&entry.path(), &to.join(entry.file_name()))).await?;
        }
        Ok(())
    } else {
        tokio::fs::copy(from, to)
            .await
            .map(|_| ())
            .map_err(Into::into)
    }
}

/// SHA-256 every file under `root` (skipping symlinks), returning `/`-separated
/// relative paths sorted by path — the local side of directory sync (Phase 12.5).
pub async fn hash_tree(root: &str) -> AppResult<Vec<crate::sync::HashEntry>> {
    let root_path = Path::new(root);
    let mut out = Vec::new();
    let mut stack = vec![root_path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(r) => r,
            Err(_) => continue, // unreadable sub-dir: skip, don't fail the whole sync
        };
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let Ok(ft) = entry.file_type().await else {
                continue;
            };
            if ft.is_symlink() {
                continue; // don't follow symlinks (cycles / surprising targets)
            }
            let p = entry.path();
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                let Ok(bytes) = tokio::fs::read(&p).await else {
                    continue;
                };
                let rel = p
                    .strip_prefix(root_path)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(crate::sync::HashEntry {
                    path: rel,
                    sha256: sha256_hex(&bytes),
                });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Unix permission bits of a file (None on non-unix or when unavailable).
fn file_mode(meta: &std::fs::Metadata) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode() & 0o7777)
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}

/// Unix owner uid/gid of a file (None on non-unix).
fn file_owner(meta: &std::fs::Metadata) -> (Option<u32>, Option<u32>) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (Some(meta.uid()), Some(meta.gid()))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        (None, None)
    }
}

/// Modification time as epoch seconds (best-effort).
fn mtime_secs(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// A hidden, time-stamped sibling path used as the atomic-write staging file —
/// path-aware (handles both `/` and `\` separators), unlike the SFTP variant.
fn local_temp(path: &str) -> PathBuf {
    let p = Path::new(path);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "vterm".into());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = format!(".{name}.vterm-tmp-{nanos:x}");
    match p.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(tmp),
        _ => PathBuf::from(tmp),
    }
}

/// Read a local file as UTF-8 text for the editor (same guards as SFTP).
pub async fn read_text(path: &str, max_bytes: u64) -> AppResult<TextFile> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("stat {path}: {e}"))?;
    if meta.is_dir() {
        return Err(AppError::Message(format!("{path} is a directory")));
    }
    if meta.len() > max_bytes {
        return Err(AppError::Message(format!(
            "file too large to edit ({} bytes, limit {max_bytes})",
            meta.len()
        )));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("read {path}: {e}"))?;
    if looks_binary(&bytes) {
        return Err(AppError::Message("file appears to be binary".into()));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| AppError::Message("file is not valid UTF-8 text".into()))?;
    let mode = file_mode(&meta);
    Ok(TextFile {
        eol: detect_eol(&content),
        size: meta.len(),
        mode,
        mtime: mtime_secs(&meta),
        read_only: is_read_only(mode),
        sha256: sha256_hex(content.as_bytes()),
        content: content.replace("\r\n", "\n"),
    })
}

/// Write editor text back to a local file: sibling temp + rename (non-truncating),
/// preserving the original permission bits; sha256 conflict check like SFTP.
pub async fn write_text(
    path: &str,
    content: &str,
    eol: &str,
    expected_sha256: Option<&str>,
) -> AppResult<WriteResult> {
    let existing = tokio::fs::metadata(path).await.ok();
    let mode = existing.as_ref().and_then(file_mode);
    if let Some(expected) = expected_sha256 {
        if existing.is_some() {
            let current = tokio::fs::read(path)
                .await
                .map_err(|e| format!("read {path}: {e}"))?;
            if sha256_hex(&current) != expected {
                return Err(AppError::FileChangedOnServer);
            }
        }
    }

    let out = apply_eol(content, eol);
    let bytes = out.as_bytes();
    let tmp = local_temp(path);
    tokio::fs::write(&tmp, bytes)
        .await
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    if let Some(m) = mode {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(m)).await;
    }
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("rename onto {path}: {e}").into());
    }

    let after = tokio::fs::metadata(path).await.ok();
    Ok(WriteResult {
        sha256: sha256_hex(bytes),
        size: bytes.len() as u64,
        mtime: after.as_ref().and_then(mtime_secs),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_temp_is_hidden_sibling() {
        let t = local_temp("/etc/nginx/nginx.conf");
        assert_eq!(t.parent().unwrap().to_str().unwrap(), "/etc/nginx");
        assert!(t
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with(".nginx.conf.vterm-tmp-"));
        // Bare filename → temp in the current dir, no parent components.
        let t2 = local_temp("bare.txt");
        assert!(t2.to_str().unwrap().starts_with(".bare.txt.vterm-tmp-"));
    }

    #[tokio::test]
    async fn read_write_round_trip_with_conflict_check() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.yaml");
        let p = path.to_str().unwrap();
        tokio::fs::write(&path, b"a: 1\nb: 2\n").await.unwrap();

        let tf = read_text(p, 1024).await.unwrap();
        assert_eq!(tf.content, "a: 1\nb: 2\n");
        assert_eq!(tf.eol, "lf");

        // Correct expected sha → writes; stale sha → FileChangedOnServer.
        let res = write_text(p, "a: 1\nb: 9\n", "lf", Some(&tf.sha256))
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "a: 1\nb: 9\n"
        );
        let err = write_text(p, "x", "lf", Some(&tf.sha256))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("file-changed"));
        // The successful write reported a fresh hash.
        assert_ne!(res.sha256, tf.sha256);
    }

    #[tokio::test]
    async fn rejects_binary_and_oversize() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("b.bin");
        tokio::fs::write(&bin, b"ELF\0\0data").await.unwrap();
        assert!(read_text(bin.to_str().unwrap(), 1024)
            .await
            .unwrap_err()
            .to_string()
            .contains("binary"));

        let big = dir.path().join("big.txt");
        tokio::fs::write(&big, vec![b'x'; 2048]).await.unwrap();
        assert!(read_text(big.to_str().unwrap(), 1024)
            .await
            .unwrap_err()
            .to_string()
            .contains("too large"));
    }

    #[tokio::test]
    async fn rename_moves_into_subdir_and_refuses_existing() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("note.txt");
        let sub = dir.path().join("sub");
        tokio::fs::write(&src, b"hi").await.unwrap();
        tokio::fs::create_dir(&sub).await.unwrap();
        let dest = sub.join("note.txt");

        // Moves the file into the subdirectory.
        rename(src.to_str().unwrap(), dest.to_str().unwrap())
            .await
            .unwrap();
        assert!(!src.exists());
        assert_eq!(tokio::fs::read_to_string(&dest).await.unwrap(), "hi");

        // A second file with the same target name is refused, not clobbered.
        let other = dir.path().join("note.txt");
        tokio::fs::write(&other, b"other").await.unwrap();
        let err = rename(other.to_str().unwrap(), dest.to_str().unwrap())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("dest-exists"));
        // The existing target is untouched.
        assert_eq!(tokio::fs::read_to_string(&dest).await.unwrap(), "hi");
        assert!(other.exists());
    }

    #[tokio::test]
    async fn copy_duplicates_tree_and_refuses_existing() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("proj");
        tokio::fs::create_dir(&src).await.unwrap();
        tokio::fs::write(src.join("a.txt"), b"A").await.unwrap();
        tokio::fs::create_dir(src.join("sub")).await.unwrap();
        tokio::fs::write(src.join("sub/b.txt"), b"B").await.unwrap();

        let dest = dir.path().join("proj-copy");
        copy(src.to_str().unwrap(), dest.to_str().unwrap())
            .await
            .unwrap();
        // Original is intact, and the whole tree was duplicated.
        assert_eq!(
            tokio::fs::read_to_string(src.join("a.txt")).await.unwrap(),
            "A"
        );
        assert_eq!(
            tokio::fs::read_to_string(dest.join("a.txt")).await.unwrap(),
            "A"
        );
        assert_eq!(
            tokio::fs::read_to_string(dest.join("sub/b.txt"))
                .await
                .unwrap(),
            "B"
        );

        // Copying onto an existing path is refused, not merged/clobbered.
        let err = copy(src.to_str().unwrap(), dest.to_str().unwrap())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("dest-exists"));
    }
}
