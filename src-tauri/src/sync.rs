//! Directory synchronisation (Phase 12.5): hash both sides, diff on the frontend,
//! then apply only the changed files. Remote hashing runs `sha256sum` over the
//! SSH exec channel (no download); the diff itself is pure TS (`sync.ts`). This
//! module owns the remote-hash shell command + parser and the apply step.

use crate::error::AppResult;
use crate::sftp;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// One file's hash, relative to the synced root (path uses `/` separators).
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HashEntry {
    pub path: String,
    pub sha256: String,
}

/// A single sync operation chosen by the frontend diff.
#[derive(Deserialize, Debug, Clone)]
pub struct SyncAction {
    /// Relative path (`/`-separated) under both roots.
    pub path: String,
    /// `upload` | `download` | `deleteRemote` | `deleteLocal` (others are skipped).
    pub op: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
}

/// Single-quote a path for `sh`, escaping embedded single quotes.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Shell command that prints `<sha256>  ./relative/path` for every file under
/// `dir`, preferring `sha256sum` (coreutils) and falling back to `shasum -a 256`.
pub fn remote_hash_command(dir: &str) -> String {
    let d = shell_quote(dir);
    format!(
        "cd -- {d} 2>/dev/null && {{ command -v sha256sum >/dev/null 2>&1 \
         && find . -type f -exec sha256sum {{}} + \
         || find . -type f -exec shasum -a 256 {{}} + ; }} 2>/dev/null"
    )
}

/// Parse `sha256sum`/`shasum` output into hash entries. Each line is a 64-char hex
/// digest, whitespace (and an optional `*` binary marker), then the path (which may
/// contain spaces); leading `./` is stripped. Malformed lines are skipped.
pub fn parse_hashsum(out: &str) -> Vec<HashEntry> {
    let mut entries = Vec::new();
    for line in out.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.len() < 66 {
            continue;
        }
        let (hash, rest) = line.split_at(64);
        if !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let path = rest.trim_start().trim_start_matches('*');
        let path = path.strip_prefix("./").unwrap_or(path);
        if path.is_empty() {
            continue;
        }
        entries.push(HashEntry {
            path: path.to_string(),
            sha256: hash.to_lowercase(),
        });
    }
    entries
}

/// Join a `/`-separated relative path onto a remote root (always `/`).
fn remote_join(root: &str, rel: &str) -> String {
    let root = root.trim_end_matches('/');
    format!("{root}/{rel}")
}

/// Join a `/`-separated relative path onto a local root using OS separators.
fn local_join(root: &str, rel: &str) -> std::path::PathBuf {
    let mut p = std::path::PathBuf::from(root);
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(seg);
    }
    p
}

/// Create every parent directory of a remote file path (mkdir -p), ignoring
/// "already exists" errors.
async fn ensure_remote_dirs(sftp: &SftpSession, remote_file: &str) {
    let Some(idx) = remote_file.rfind('/') else {
        return;
    };
    let dir = &remote_file[..idx];
    let mut cur = String::new();
    for seg in dir.split('/') {
        if seg.is_empty() {
            cur.push('/');
            continue;
        }
        if !cur.is_empty() && !cur.ends_with('/') {
            cur.push('/');
        }
        cur.push_str(seg);
        let _ = sftp.create_dir(cur.clone()).await; // ignore "exists"
    }
}

/// Apply a diff: upload/download changed files (creating parent dirs) and delete
/// extraneous ones. Reuses `sftp::upload`/`download` (per-file progress events).
pub async fn apply(
    app: &AppHandle,
    sftp: &SftpSession,
    local_root: &str,
    remote_root: &str,
    actions: Vec<SyncAction>,
) -> AppResult<SyncStats> {
    let mut stats = SyncStats::default();
    for a in actions {
        let remote = remote_join(remote_root, &a.path);
        let local = local_join(local_root, &a.path);
        let local_str = local.to_string_lossy().into_owned();
        match a.op.as_str() {
            "upload" => {
                ensure_remote_dirs(sftp, &remote).await;
                sftp::upload(app, crate::uuid_like(), sftp, &local_str, &remote).await?;
                stats.uploaded += 1;
            }
            "download" => {
                if let Some(parent) = local.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                sftp::download(app, crate::uuid_like(), sftp, &remote, &local_str).await?;
                stats.downloaded += 1;
            }
            "deleteRemote" => {
                let _ = sftp.remove_file(remote).await;
                stats.deleted += 1;
            }
            "deleteLocal" => {
                let _ = tokio::fs::remove_file(&local).await;
                stats.deleted += 1;
            }
            _ => {} // conflict / unknown → skip
        }
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("/tmp/a"), "'/tmp/a'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn remote_hash_command_quotes_and_falls_back() {
        let cmd = remote_hash_command("/etc/nginx");
        assert!(cmd.contains("cd -- '/etc/nginx'"));
        assert!(cmd.contains("sha256sum"));
        assert!(cmd.contains("shasum -a 256"));
    }

    #[test]
    fn parse_hashsum_reads_hash_and_relative_path() {
        let h = "a".repeat(64);
        let g = "b".repeat(64);
        let out =
            format!("{h}  ./conf/app.yaml\n{g} *./bin/data\nshort line\n{h}  ./with space/x.txt\n");
        let entries = parse_hashsum(&out);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "conf/app.yaml");
        assert_eq!(entries[0].sha256, h);
        // Binary marker `*` is stripped.
        assert_eq!(entries[1].path, "bin/data");
        // Paths with spaces survive.
        assert_eq!(entries[2].path, "with space/x.txt");
    }

    #[test]
    fn parse_hashsum_skips_non_hex_and_empty() {
        let bad = format!("{}  ./x\n", "z".repeat(64));
        assert!(parse_hashsum(&bad).is_empty());
    }

    #[test]
    fn joins_respect_separators() {
        assert_eq!(remote_join("/srv/app/", "a/b.txt"), "/srv/app/a/b.txt");
        let l = local_join("/home/me", "a/b.txt");
        assert!(l.ends_with("b.txt") && l.to_string_lossy().contains("a"));
    }
}
