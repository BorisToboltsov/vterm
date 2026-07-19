//! Directory synchronisation (Phase 12.5): hash both sides, diff on the frontend,
//! then apply only the changed files. Remote hashing runs `sha256sum` over the
//! SSH exec channel (no download); the diff itself is pure TS (`sync.ts`). This
//! module owns the remote-hash shell command + parser and the apply step.

use crate::error::{AppError, AppResult};
use crate::sftp::{self, apply_eol, detect_eol, looks_binary, sha256_hex, TextFile, WriteResult};
use crate::ssh::SshSession;
use crate::textenc;
use russh_sftp::client::SftpSession;
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

/// A real linter to run on the server for a given language (Phase 12.7).
pub struct LintTool {
    pub bin: &'static str,
    pub args: &'static str,
    /// Output-format id the frontend parser switches on (`colon`/`nginx`/`sshd`/
    /// `visudo`/`haproxy`/`systemd`).
    pub format: &'static str,
    /// Run under `sudo -S` — the validator needs root (`sshd -t` reads host keys).
    pub sudo: bool,
    /// The temp file must carry the source file's suffix for the tool to recognise
    /// its type (`systemd-analyze verify` infers the unit type from the extension).
    pub suffix: bool,
}

/// Result of a server-side lint run, sent to the frontend.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LintResult {
    pub tool: String,
    /// False when no linter maps to the language, or the tool isn't installed.
    pub found: bool,
    /// Combined stdout+stderr with the temp path replaced by `FILE`.
    pub output: String,
    pub format: String,
}

/// The linter for an editor language kind, or `None` if none is wired. `sudo`/`suffix`
/// flags: daemon validators (Phase A) may need root (`sshd -t`) or a typed temp file
/// (`systemd-analyze`).
pub fn lint_tool(kind: &str) -> Option<LintTool> {
    let (bin, args, format, sudo, suffix) = match kind {
        "yaml" => ("yamllint", "-f parsable", "colon", false, false),
        "shell" => ("shellcheck", "-f gcc", "colon", false, false),
        "dockerfile" => ("hadolint", "--no-color", "colon", false, false),
        "python" => (
            "ruff",
            "check --quiet --output-format concise",
            "colon",
            false,
            false,
        ),
        "nginx" => ("nginx", "-t -c", "nginx", false, false),
        // Daemon config validators — shipped with their daemon (no install needed).
        "sshdconfig" => ("sshd", "-t -f", "sshd", true, false),
        "sudoers" => ("visudo", "-c -f", "visudo", false, false),
        "haproxy" => ("haproxy", "-c -f", "haproxy", false, false),
        "bind" => ("named-checkconf", "", "colon", false, false),
        "systemd" => ("systemd-analyze", "verify", "systemd", false, true),
        // YAML-family dialects (Phase B). `{}` marks where the file goes when it isn't
        // the trailing arg (docker compose wants `-f FILE config`).
        "compose" => ("docker", "compose -f {} config -q", "generic", false, false),
        "ghactions" => ("actionlint", "-no-color", "colon", false, false),
        "prometheus" => ("promtool", "check config", "generic", false, false),
        "ansible" => ("ansible-lint", "--nocolor -f pep8", "colon", false, false),
        "k8s" => (
            "kubeconform",
            "-ignore-missing-schemas",
            "generic",
            false,
            false,
        ),
        _ => return None,
    };
    Some(LintTool {
        bin,
        args,
        format,
        sudo,
        suffix,
    })
}

/// Dirs prepended to `PATH` so daemon validators in `sbin` (sshd, haproxy, visudo)
/// are found in a non-login shell. Under sudo, `secure_path` already covers these.
const LINT_PATH: &str = "/usr/sbin:/sbin:/usr/local/sbin:$PATH";

/// Probe whether a linter binary exists on the server (`sbin` included).
pub fn lint_check_command(tool: &LintTool) -> String {
    format!(
        "PATH=\"{LINT_PATH}\" command -v {} >/dev/null 2>&1 && echo __VTERM_OK__",
        tool.bin
    )
}

/// The temp-file extension a suffix-sensitive linter needs. systemd-analyze infers
/// the unit type from it; unknown/absent → `service`. Returns a `&'static` so callers
/// can build the temp path without allocating the suffix.
pub fn lint_tmp_ext(name: &str) -> &'static str {
    const UNITS: &[&str] = &[
        "service",
        "timer",
        "socket",
        "mount",
        "automount",
        "swap",
        "target",
        "path",
        "slice",
        "scope",
    ];
    let ext = name.rsplit('.').next().unwrap_or("");
    UNITS
        .iter()
        .copied()
        .find(|u| ext.eq_ignore_ascii_case(u))
        .unwrap_or("service")
}

/// Run a linter on the staged temp file, returning combined stdout+stderr. sudo tools
/// (`sshd -t`) run under `sudo -S` when a password is supplied (falling back to a
/// best-effort non-root run otherwise); the rest run with `sbin` on `PATH`.
pub async fn run_lint(
    session: &SshSession,
    tool: &LintTool,
    tmp: &str,
    password: Option<&str>,
) -> String {
    let core = lint_command(tool, tmp);
    let res = match (tool.sudo, password) {
        (true, Some(pw)) if !pw.is_empty() => sudo_run(session, &core, pw).await,
        _ => {
            session
                .run_command(&format!("PATH=\"{LINT_PATH}\" {core}"))
                .await
        }
    };
    res.unwrap_or_default()
}

/// Command to lint the staged temp file (stderr merged into stdout for capture). A
/// `{}` in `args` is replaced by the quoted path (for tools where the file isn't the
/// trailing arg, e.g. `docker compose -f FILE config`); otherwise it's appended.
pub fn lint_command(tool: &LintTool, tmp: &str) -> String {
    let q = shell_quote(tmp);
    if tool.args.contains("{}") {
        format!("{} {} 2>&1", tool.bin, tool.args.replace("{}", &q))
    } else {
        format!("{} {} {} 2>&1", tool.bin, tool.args, q)
    }
}

/// Shell command listing every config file nginx actually loads. `nginx -T` dumps
/// the fully-resolved config (it expands `include` globs and recursion itself) and
/// prefixes each source file with `# configuration file <path>:`; we keep only those
/// markers. Guarded on nginx being installed and best-effort without sudo — stderr is
/// dropped and `|| true` keeps a non-zero exit (permission/parse error) from failing
/// the channel, so callers get an empty list and fall back to path-based detection.
pub fn nginx_config_dump_command() -> &'static str {
    "command -v nginx >/dev/null 2>&1 && \
     nginx -T 2>/dev/null | grep -a '^# configuration file ' || true"
}

/// The pipeline that extracts loaded-config markers from `nginx -T`, run under sudo.
/// Only `nginx` runs as root; `grep` filters its output as the user. `|| true` keeps a
/// wrong password / missing binary from failing the channel (→ empty list, fall back).
const NGINX_DUMP_PIPE: &str = "nginx -T 2>/dev/null | grep -a '^# configuration file ' || true";

/// Parse `nginx -T` markers (`# configuration file <path>:`) into a de-duplicated
/// list of absolute config paths. Blank/prefix-less lines are skipped.
pub fn parse_nginx_config_files(out: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for line in out.lines() {
        let Some(rest) = line.strip_prefix("# configuration file ") else {
            continue;
        };
        let path = rest.trim().trim_end_matches(':').trim();
        if path.is_empty() || files.iter().any(|f| f == path) {
            continue;
        }
        files.push(path.to_string());
    }
    files
}

/// The list of nginx-loaded config files via `sudo nginx -T`, reusing a password the
/// user already entered to open a root-owned file. Best-effort: a wrong password or
/// missing nginx yields an empty list (caller falls back to path-based detection), so
/// this never surfaces an error just to decide syntax highlighting.
pub async fn nginx_config_files_sudo(
    session: &SshSession,
    password: &str,
) -> AppResult<Vec<String>> {
    let out = sudo_run(session, NGINX_DUMP_PIPE, password)
        .await
        .unwrap_or_default();
    Ok(parse_nginx_config_files(&out))
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

/// Shell snippet that copies `path` to `<path>.bak` as root, preserving mode,
/// owner and timestamps — the sudo counterpart of the `.bak` step in
/// [`crate::sftp::write_text`]. Pure so the shape below stays under test.
///
/// `if … then … fi`, deliberately NOT `test -e X && cp …`. With `&&` a missing
/// target — a brand-new file, nothing to copy — makes the whole command exit
/// non-zero, [`OK_MARKER`] never prints, and "nothing to back up" becomes
/// indistinguishable from "the copy failed". Since a failed backup now aborts the
/// save, that conflation would refuse every first save of a new root-owned file.
///
/// `cp -p` matters just as much: without it the copy lands at the caller's umask,
/// so a 0600 secret-bearing config would be backed up world-readable.
pub fn sudo_backup_command(path: &str) -> String {
    let quoted = shell_quote(path);
    let bak = shell_quote(&format!("{path}.bak"));
    format!("if test -e {quoted}; then cp -p -- {quoted} {bak}; fi")
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
        // The sudo path pipes the file through `cat` over SSH, so it is already a
        // decoded String by the time we see it — there are no raw bytes left to
        // sniff. Remote hosts reached this way are POSIX, where UTF-8 is the norm.
        encoding: textenc::UTF8.into(),
        sha256,
        content: content.replace("\r\n", "\n"),
    })
}

/// Write a root-owned file via sudo: stage a temp in the user's home (mode 0600),
/// optionally back up, then `sudo cp` over the target (preserving its owner/perms).
pub async fn sudo_write(
    session: &SshSession,
    sftp: &SftpSession,
    req: &sftp::TextWrite<'_>,
    password: &str,
) -> AppResult<WriteResult> {
    let sftp::TextWrite {
        path,
        content,
        eol,
        encoding,
        expected_sha256,
        backup,
    } = *req;
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
    let encoded = textenc::encode(&out, encoding);
    let bytes = &encoded[..];
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
    // Tighten the staging file to 0600 before it is copied into place as root.
    // Goes through `sftp::chmod_attrs` — `..Default::default()` would send
    // `ATTR_SIZE = 0` and truncate the staged content away (see its doc comment).
    let _ = sftp
        .set_metadata(tmp.clone(), sftp::chmod_attrs(0o600))
        .await;

    // Backup before the root overwrite. Failure aborts the save while the target
    // is untouched — same contract as the ordinary path in `sftp::write_text`.
    //
    // `if … then … fi`, NOT `test -e X && cp …`: with `&&` a missing target (a
    // brand-new file, nothing to copy) makes the whole command exit non-zero, so
    // the OK marker is absent and "nothing to back up" is indistinguishable from
    // "the copy failed". Now the absent-file case succeeds and a false marker
    // means the `cp` really did fail. `cp -p` carries mode/owner/timestamps, so
    // the copy is never more readable than what it copied.
    if backup && !sudo_ok(session, &sudo_backup_command(path), password).await? {
        let _ = sftp.remove_file(tmp).await;
        return Err(AppError::BackupFailed(format!(
            "sudo cp -p {path} {path}.bak"
        )));
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
    fn sudo_backup_command_survives_a_missing_target() {
        let cmd = sudo_backup_command("/etc/nginx/nginx.conf");
        // `if … fi`, never `test -e … && cp`: with `&&` a first save of a new file
        // exits non-zero, and — now that a failed backup aborts the save — every
        // such save would be refused for a backup that was never needed.
        assert!(cmd.starts_with("if test -e "), "got: {cmd}");
        assert!(
            !cmd.contains("&&"),
            "`&&` conflates 'nothing to copy' with failure"
        );
        assert!(cmd.ends_with("; fi"), "got: {cmd}");
        // Mode/owner/timestamps preserved, or the copy is more readable than the
        // original it was meant to protect.
        assert!(cmd.contains("cp -p -- "));
        assert!(cmd.contains("'/etc/nginx/nginx.conf' '/etc/nginx/nginx.conf.bak'"));
    }

    #[test]
    fn sudo_backup_command_quotes_hostile_paths() {
        // A quote in the name must not break out of the snippet.
        let cmd = sudo_backup_command("/tmp/a'b c.conf");
        assert!(cmd.contains(r#"'/tmp/a'\''b c.conf'"#), "got: {cmd}");
        assert!(cmd.contains(r#"'/tmp/a'\''b c.conf.bak'"#), "got: {cmd}");
    }

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
    fn lint_tool_and_command() {
        assert!(lint_tool("rust").is_none());
        let t = lint_tool("yaml").unwrap();
        assert_eq!(t.bin, "yamllint");
        assert_eq!(t.format, "colon");
        assert_eq!(
            lint_command(&t, "/home/u/.vterm-lint-1"),
            "yamllint -f parsable '/home/u/.vterm-lint-1' 2>&1"
        );
        assert_eq!(lint_tool("nginx").unwrap().format, "nginx");
    }

    #[test]
    fn lint_tool_daemon_validators() {
        // sshd needs root; systemd needs a typed temp file.
        let sshd = lint_tool("sshdconfig").unwrap();
        assert_eq!(
            (sshd.bin, sshd.format, sshd.sudo, sshd.suffix),
            ("sshd", "sshd", true, false)
        );
        let sd = lint_tool("systemd").unwrap();
        assert_eq!(
            (sd.bin, sd.format, sd.sudo, sd.suffix),
            ("systemd-analyze", "systemd", false, true)
        );
        assert_eq!(lint_tool("sudoers").unwrap().bin, "visudo");
        assert_eq!(lint_tool("haproxy").unwrap().format, "haproxy");
        // BIND reuses the generic colon parser.
        assert_eq!(lint_tool("bind").unwrap().format, "colon");
        // The command shape holds for empty-args tools too.
        assert_eq!(
            lint_command(&lint_tool("bind").unwrap(), "/t/f"),
            "named-checkconf  '/t/f' 2>&1"
        );
        assert_eq!(lint_command(&sshd, "/t/f"), "sshd -t -f '/t/f' 2>&1");
    }

    #[test]
    fn lint_tool_yaml_dialects() {
        // docker compose puts the file mid-command via the `{}` placeholder.
        let compose = lint_tool("compose").unwrap();
        assert_eq!((compose.bin, compose.format), ("docker", "generic"));
        assert_eq!(
            lint_command(&compose, "/t/f"),
            "docker compose -f '/t/f' config -q 2>&1"
        );
        // The rest append the file as the trailing arg.
        assert_eq!(lint_tool("ghactions").unwrap().bin, "actionlint");
        assert_eq!(lint_tool("ghactions").unwrap().format, "colon");
        assert_eq!(lint_tool("prometheus").unwrap().bin, "promtool");
        assert_eq!(lint_tool("ansible").unwrap().format, "colon");
        assert_eq!(lint_tool("k8s").unwrap().bin, "kubeconform");
        assert_eq!(
            lint_command(&lint_tool("ansible").unwrap(), "/t/f"),
            "ansible-lint --nocolor -f pep8 '/t/f' 2>&1"
        );
    }

    #[test]
    fn lint_check_command_includes_sbin() {
        let cmd = lint_check_command(&lint_tool("haproxy").unwrap());
        assert!(cmd.contains("/usr/sbin"));
        assert!(cmd.contains("command -v haproxy"));
        assert!(cmd.contains("__VTERM_OK__"));
    }

    #[test]
    fn lint_tmp_ext_maps_unit_types() {
        assert_eq!(lint_tmp_ext("web.service"), "service");
        assert_eq!(lint_tmp_ext("backup.TIMER"), "timer"); // case-insensitive
        assert_eq!(lint_tmp_ext("app.socket"), "socket");
        // Unknown/absent extension → the default unit type.
        assert_eq!(lint_tmp_ext("noext"), "service");
        assert_eq!(lint_tmp_ext("foo.conf"), "service");
    }

    #[test]
    fn parse_nginx_config_files_extracts_and_dedups() {
        let out = "# configuration file /etc/nginx/nginx.conf:\n\
                   worker_processes auto;\n\
                   # configuration file /srv/app/nginx/site.conf:\n\
                   server { listen 80; }\n\
                   # configuration file /etc/nginx/nginx.conf:\n\
                   # not a marker line\n";
        let files = parse_nginx_config_files(out);
        assert_eq!(
            files,
            vec![
                "/etc/nginx/nginx.conf".to_string(),
                "/srv/app/nginx/site.conf".to_string(),
            ]
        );
        assert!(parse_nginx_config_files("").is_empty());
        assert!(nginx_config_dump_command().contains("nginx -T"));
        assert!(NGINX_DUMP_PIPE.contains("nginx -T") && NGINX_DUMP_PIPE.contains("grep"));
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
