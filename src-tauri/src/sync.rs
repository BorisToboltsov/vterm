//! Directory synchronisation (Phase 12.5): hash both sides, diff on the frontend,
//! then apply only the changed files. Remote hashing runs `sha256sum` over the
//! SSH exec channel (no download); the diff itself is pure TS (`sync.ts`). This
//! module owns the remote-hash shell command + parser and the apply step.

use crate::error::{AppError, AppResult};
use crate::sftp::{self, apply_eol, detect_eol, looks_binary, sha256_hex, TextFile, WriteResult};
use crate::ssh::SshSession;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Marker appended to a sudo command to confirm it succeeded (exit status isn't
/// captured over the exec channel, so a wrong password / failure is detected by
/// the marker's absence).
const OK_MARKER: &str = "__VTERM_OK__";

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

/// One content-search hit (Phase 12.6 grep-over-SSH): relative path, line, text.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

/// `grep -rnI` over SSH under `dir`. `-F` (fixed string) or `-E` (regex), optional
/// case-insensitivity; output capped so a broad search can't flood the channel.
pub fn grep_command(dir: &str, query: &str, case_insensitive: bool, fixed: bool) -> String {
    let d = shell_quote(dir);
    let q = shell_quote(query);
    let mut flags = String::from("-rnI");
    if case_insensitive {
        flags.push('i');
    }
    let mode = if fixed { "-F" } else { "-E" };
    format!("cd -- {d} 2>/dev/null && grep {flags} {mode} -e {q} -- . 2>/dev/null | head -n 1000")
}

/// Parse `grep -rn` output (`./path:line:text`) into matches; bad lines skipped.
pub fn parse_grep(out: &str) -> Vec<GrepMatch> {
    let mut matches = Vec::new();
    for line in out.lines() {
        let rest = line.strip_prefix("./").unwrap_or(line);
        let Some(c1) = rest.find(':') else { continue };
        let (path, after) = rest.split_at(c1);
        let after = &after[1..];
        let Some(c2) = after.find(':') else { continue };
        let (num, text) = after.split_at(c2);
        let Ok(line_no) = num.parse::<u32>() else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        matches.push(GrepMatch {
            path: path.to_string(),
            line: line_no,
            text: text[1..].chars().take(300).collect(),
        });
    }
    matches
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

// ── sudo edit (Phase 12.6) ─────────────────────────────────────────────────────

/// Run `inner` under `sudo -S`, feeding `password` on stdin (kept out of the
/// process list). Returns stdout.
async fn sudo_run(session: &SshSession, inner: &str, password: &str) -> AppResult<String> {
    let cmd = format!("sudo -S -p '' {inner}");
    let mut pw = password.as_bytes().to_vec();
    pw.push(b'\n');
    session.run_command_stdin(&cmd, &pw).await
}

/// Run `inner` under sudo and confirm success via [`OK_MARKER`].
async fn sudo_ok(session: &SshSession, inner: &str, password: &str) -> AppResult<bool> {
    let out = sudo_run(session, &format!("{inner} && printf {OK_MARKER}"), password).await?;
    Ok(out.contains(OK_MARKER))
}

/// Read a root-owned file as text via `sudo cat` (Phase 12.6 "edit as root").
pub async fn sudo_read(
    session: &SshSession,
    path: &str,
    max_bytes: u64,
    password: &str,
) -> AppResult<TextFile> {
    if !sudo_ok(session, "true", password).await? {
        return Err(AppError::Message("sudo authentication failed".into()));
    }
    let cmd = format!("cat -- {} | head -c {}", shell_quote(path), max_bytes + 1);
    let content = sudo_run(session, &cmd, password).await?;
    let bytes = content.as_bytes();
    if bytes.len() as u64 > max_bytes {
        return Err(AppError::Message("file too large to edit".into()));
    }
    if looks_binary(bytes) {
        return Err(AppError::Message("file appears to be binary".into()));
    }
    let sha256 = sha256_hex(bytes);
    Ok(TextFile {
        eol: detect_eol(&content),
        size: bytes.len() as u64,
        mode: None,
        mtime: None,
        read_only: false,
        sha256,
        content: content.replace("\r\n", "\n"),
    })
}

/// Write a root-owned file via sudo: stage a temp in the user's home (mode 0600),
/// optionally back up, then `sudo cp` over the target (preserving its owner/perms).
#[allow(clippy::too_many_arguments)]
pub async fn sudo_write(
    session: &SshSession,
    sftp: &SftpSession,
    path: &str,
    content: &str,
    eol: &str,
    expected_sha256: Option<&str>,
    backup: bool,
    password: &str,
) -> AppResult<WriteResult> {
    if !sudo_ok(session, "true", password).await? {
        return Err(AppError::Message("sudo authentication failed".into()));
    }
    // Conflict check (best-effort): hash the current content via sudo cat.
    if let Some(expected) = expected_sha256 {
        let cur = sudo_run(session, &format!("cat -- {}", shell_quote(path)), password)
            .await
            .unwrap_or_default();
        if !cur.is_empty() && sha256_hex(cur.as_bytes()) != expected {
            return Err(AppError::FileChangedOnServer);
        }
    }

    let out = apply_eol(content, eol);
    let bytes = out.as_bytes();
    let home = sftp
        .canonicalize(".")
        .await
        .map_err(|e| format!("home dir: {e}"))?;
    let tmp = format!(
        "{}/.vterm-sudo-{}",
        home.trim_end_matches('/'),
        crate::uuid_like()
    );
    sftp::write_bytes(sftp, &tmp, bytes)
        .await
        .map_err(|e| format!("stage {tmp}: {e}"))?;
    let attrs = FileAttributes {
        permissions: Some(0o600),
        ..Default::default()
    };
    let _ = sftp.set_metadata(tmp.clone(), attrs).await;

    if backup {
        let bak = shell_quote(&format!("{path}.bak"));
        let inner = format!("test -e {0} && cp -p -- {0} {bak}", shell_quote(path));
        let _ = sudo_ok(session, &inner, password).await; // best-effort
    }

    let cmd = format!("cp -- {} {}", shell_quote(&tmp), shell_quote(path));
    let ok = sudo_ok(session, &cmd, password).await?;
    let _ = sftp.remove_file(tmp).await;
    if !ok {
        return Err(AppError::Message(
            "sudo write failed (check password / permissions)".into(),
        ));
    }
    Ok(WriteResult {
        sha256: sha256_hex(bytes),
        size: bytes.len() as u64,
        mtime: None,
    })
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
    fn grep_command_builds_flags() {
        let c = grep_command("/srv", "TODO", true, true);
        assert!(c.contains("cd -- '/srv'"));
        assert!(c.contains("grep -rnIi -F -e 'TODO'"));
        let c2 = grep_command("/srv", "a.+b", false, false);
        assert!(c2.contains("grep -rnI -E -e 'a.+b'"));
    }

    #[test]
    fn parse_grep_reads_path_line_text() {
        let out = "./conf/app.yaml:12:  key: value\n./bad line\n./x:notnum:t\n./a:3:hit\n";
        let m = parse_grep(out);
        assert_eq!(m.len(), 2);
        assert_eq!(
            m[0],
            GrepMatch {
                path: "conf/app.yaml".into(),
                line: 12,
                text: "  key: value".into()
            }
        );
        assert_eq!(m[1].path, "a");
        assert_eq!(m[1].line, 3);
    }

    #[test]
    fn joins_respect_separators() {
        assert_eq!(remote_join("/srv/app/", "a/b.txt"), "/srv/app/a/b.txt");
        let l = local_join("/home/me", "a/b.txt");
        assert!(l.ends_with("b.txt") && l.to_string_lossy().contains("a"));
    }
}
