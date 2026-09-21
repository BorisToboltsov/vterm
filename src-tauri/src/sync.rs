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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
    /// The run was stopped by the user before working through the whole plan
    /// (Phase 39.8). Counts above are then partial — the caller reports
    /// "moved N of M", not a green "done".
    pub stopped: bool,
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

/// Hashes of one side of a sync, plus how many items under it could not be read.
/// `skipped` is surfaced to the user: those files are simply absent from the plan,
/// and a plan that silently omits files reads as "nothing to do" for them.
#[derive(Serialize, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HashTree {
    pub entries: Vec<HashEntry>,
    pub skipped: u32,
    /// Files and folders the walk left out by an exclude pattern (a pruned folder
    /// counts once — its contents were never visited, which is the point).
    pub excluded: u32,
}

/// The exclude patterns a walk can apply **without** changing what the frontend
/// keeps. `compileExclude` in sync.ts still filters the result; pruning here only
/// saves the time spent hashing `node_modules` and `.git` just to throw them away.
/// So only patterns whose meaning is identical on both sides are taken:
///
/// * no slash — a glob matched against one path segment (`*`/`?`, the rest
///   literal): a folder whose name matches is pruned (every path below it has
///   that segment), a file whose name matches is skipped;
/// * with a slash — only a literal path (no wildcards), pruned when it matches
///   exactly. A globbed path is left to the frontend: `find -path` lets `*` cross
///   `/`, and pruning more than the frontend excludes would make those files look
///   "missing on this side" — an upload, or a delete with delete-extraneous on.
#[derive(Debug, Default, Clone)]
pub struct ExcludeSet {
    names: Vec<String>,
    paths: Vec<String>,
}

impl ExcludeSet {
    pub fn new(patterns: &[String]) -> Self {
        let mut set = ExcludeSet::default();
        for p in patterns.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
            if !p.contains('/') {
                set.names.push(p.to_string());
            } else {
                let lit = p.trim_start_matches('/').trim_end_matches('/');
                if !lit.is_empty() && !lit.contains(['*', '?']) {
                    set.paths.push(lit.to_string());
                }
            }
        }
        set
    }

    /// Whether the walk may leave out `rel` (a `/`-separated path under the root).
    pub fn skips(&self, rel: &str) -> bool {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        self.names.iter().any(|g| glob_match(g, name)) || self.paths.iter().any(|p| p == rel)
    }

    /// The `find` prefix that prunes the same set and prints each pruned path
    /// (counted as `excluded`), or "" when there is nothing to prune.
    pub fn find_prune(&self) -> String {
        let mut tests: Vec<String> = self
            .names
            .iter()
            .map(|g| format!("-name {}", shell_quote(&find_literal(g))))
            .collect();
        tests.extend(
            self.paths
                .iter()
                .map(|p| format!("-path {}", shell_quote(&find_literal(&format!("./{p}"))))),
        );
        if tests.is_empty() {
            return String::new();
        }
        format!("\\( {} \\) -prune -print -o", tests.join(" -o "))
    }
}

/// `*` and `?` stay wildcards for `find`; `[`, `]` and `\\` are literal on our side
/// (sync.ts escapes them), so escape them for `find` too.
fn find_literal(glob: &str) -> String {
    let mut out = String::with_capacity(glob.len());
    for c in glob.chars() {
        if matches!(c, '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Match one path segment against a glob: `*` any run, `?` one char, all else literal.
fn glob_match(pat: &str, s: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pat.chars().collect(), s.chars().collect());
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(sp) = star {
            pi = sp + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// How many files a sync-tree hash has got through, for the dialog's counter.
/// Its own channel (`sync://scan`): a file count with no total is not a transfer,
/// and on `sftp://progress` it would show up in the transfers list.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress<'a> {
    pub id: &'a str,
    pub files: u64,
}

pub fn emit_scan(app: &AppHandle, id: &str, files: u64) {
    use tauri::Emitter;
    let _ = app.emit("sync://scan", ScanProgress { id, files });
}

/// Printed by the remote hash script when `cd` into the folder (or reading it) fails.
const HASH_NO_DIR: &str = "__VTERM_NODIR__";
/// Printed when the server has neither `sha256sum` nor `shasum`.
const HASH_NO_TOOL: &str = "__VTERM_NOHASH__";
/// Prefix of every stderr line of `find`/the hasher (an unreadable file or folder).
const HASH_ERR: &str = "__VTERM_ERR__";
/// Last line of a listing that ran to completion.
const HASH_DONE: &str = "__VTERM_HASH_OK__";

/// Shell command that prints `<sha256>  ./relative/path` for every file under
/// `dir`, preferring `sha256sum` (coreutils) and falling back to `shasum -a 256`.
///
/// Every way this can fail is **said out loud** with a marker, because the exec
/// channel collects stdout only and an empty stdout otherwise reads as an empty
/// folder — which plans "upload everything" and, with delete-extraneous, "delete
/// everything on the other side". Unreadable items come back as prefixed stderr
/// lines (`2>&1 1>&3` swaps the streams so only stderr goes through `sed`), and a
/// completion marker closes the listing so a cut-short run is distinguishable
/// from a short tree. Runs under `sh -c` so a fish/csh login shell can't change
/// the syntax.
pub fn remote_hash_command(dir: &str, excludes: &ExcludeSet) -> String {
    let d = shell_quote(dir);
    let prune = excludes.find_prune();
    let script = format!(
        "cd -- {d} 2>/dev/null && test -r . || {{ echo {HASH_NO_DIR}; exit 0; }}; \
         if command -v sha256sum >/dev/null 2>&1; then h='sha256sum'; \
         elif command -v shasum >/dev/null 2>&1; then h='shasum -a 256'; \
         else echo {HASH_NO_TOOL}; exit 0; fi; \
         {{ find . {prune} -type f -exec $h {{}} + 2>&1 1>&3 | sed 's/^/{HASH_ERR} /'; }} 3>&1; \
         echo {HASH_DONE}"
    );
    format!("sh -c {}", shell_quote(&script))
}

/// Await `fut`, giving up with [`AppError::Cancelled`] as soon as `cancel` is set
/// (checked every 100 ms). Dropping the future closes the exec channel, so a
/// remote `find | sha256sum` over a huge tree stops instead of running on after
/// the user closed the dialog.
pub async fn until_cancelled<T>(
    fut: impl std::future::Future<Output = AppResult<T>>,
    cancel: &AtomicBool,
) -> AppResult<T> {
    tokio::pin!(fut);
    loop {
        tokio::select! {
            r = &mut fut => return r,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::Cancelled);
                }
            }
        }
    }
}

/// Read the output of [`remote_hash_command`] for `dir`: the hashes, the count of
/// unreadable items, or the typed reason the tree could not be listed at all.
pub fn parse_hash_output(dir: &str, out: &str) -> AppResult<HashTree> {
    let mut skipped = 0u32;
    let mut excluded = 0u32;
    let mut done = false;
    for line in out.lines().map(|l| l.trim_end_matches('\r')) {
        if line == HASH_NO_DIR {
            return Err(AppError::SyncDirUnreadable(dir.to_string()));
        }
        if line == HASH_NO_TOOL {
            return Err(AppError::HashToolMissing);
        }
        if line.starts_with(HASH_ERR) {
            skipped += 1;
        } else if line.starts_with("./") {
            // A path `-prune -print` wrote: an excluded file or folder.
            excluded += 1;
        }
        done = line == HASH_DONE;
    }
    if !done {
        return Err(AppError::HashIncomplete);
    }
    Ok(HashTree {
        entries: parse_hashsum(out),
        skipped,
        excluded,
    })
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

/// Transfer id for one file of a sync run (Phase 39.8). Deriving it from the plan
/// path — instead of the random [`crate::uuid_like`] used before — is what lets the
/// sync dialog line each `sftp://progress` event up with the plan row it drew. The
/// event's `name` field can't do that job: it is the base name, so two files called
/// `config.yml` in different folders are indistinguishable.
///
/// Mirrored by `syncTransferId` in [`sync.ts`](../../src/lib/sync.ts) — the two must
/// agree byte for byte or every row stays stuck at "queued".
pub fn sync_transfer_id(path: &str) -> String {
    format!("sync:{path}")
}

/// How many plan lines the recording body lists before it summarises the rest.
const MIRROR_BODY_LIMIT: usize = 50;

/// The `[sftp] $ …` header for a whole sync run (Phase 39.8). One entry per run,
/// not per file: a 200-file push would otherwise bury the terminal recording it is
/// supposed to document.
pub fn sync_mirror_op(local_root: &str, remote_root: &str, count: usize) -> String {
    format!(
        "sync {} <-> {} ({count} actions)",
        crate::git::shell_quote(local_root),
        crate::git::shell_quote(remote_root)
    )
}

/// The body listing what the run touched, capped at [`MIRROR_BODY_LIMIT`] lines
/// with a `… and N more` tail. Skipped actions (conflicts) are left out — the
/// recording documents what happened, not what was considered.
pub fn sync_mirror_body(actions: &[SyncAction]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut shown = 0usize;
    let mut skipped = 0usize;
    for a in actions {
        let verb = match a.op.as_str() {
            "upload" => "put",
            "download" => "get",
            "deleteRemote" => "rm remote",
            "deleteLocal" => "rm local",
            _ => continue,
        };
        if shown == MIRROR_BODY_LIMIT {
            skipped += 1;
            continue;
        }
        shown += 1;
        lines.push(format!("{verb} {}", crate::git::shell_quote(&a.path)));
    }
    if skipped > 0 {
        lines.push(format!("… and {skipped} more"));
    }
    lines.join("\n")
}

/// Apply a diff: upload/download changed files (creating parent dirs) and delete
/// extraneous ones. Reuses `sftp::upload`/`download` (per-file progress events).
///
/// `cancel` is checked **between files**, exactly like [`sftp::download_dir`]: the
/// file in flight is finished rather than abandoned. Cutting a copy mid-stream would
/// leave a truncated file where the user's working one used to be — the same class of
/// damage as the `SETSTAT` truncation fixed in 0.39.6. Stopping costs one more file;
/// tearing costs the file.
pub async fn apply(
    app: &AppHandle,
    sftp: &SftpSession,
    local_root: &str,
    remote_root: &str,
    actions: Vec<SyncAction>,
    cancel: Arc<AtomicBool>,
) -> AppResult<SyncStats> {
    let mut stats = SyncStats::default();
    for a in actions {
        if cancel.load(Ordering::Relaxed) {
            stats.stopped = true;
            break;
        }
        let remote = remote_join(remote_root, &a.path);
        let local = local_join(local_root, &a.path);
        let local_str = local.to_string_lossy().into_owned();
        let id = sync_transfer_id(&a.path);
        match a.op.as_str() {
            "upload" => {
                ensure_remote_dirs(sftp, &remote).await;
                sftp::upload(app, id, sftp, &local_str, &remote).await?;
                stats.uploaded += 1;
            }
            "download" => {
                if let Some(parent) = local.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                sftp::download(app, id, sftp, &remote, &local_str).await?;
                stats.downloaded += 1;
            }
            "deleteRemote" => {
                let _ = sftp.remove_file(remote).await;
                stats.deleted += 1;
                sftp::emit_done(app, &id, &a.path, "upload");
            }
            "deleteLocal" => {
                let _ = tokio::fs::remove_file(&local).await;
                stats.deleted += 1;
                sftp::emit_done(app, &id, &a.path, "download");
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

    fn act(path: &str, op: &str) -> SyncAction {
        SyncAction {
            path: path.into(),
            op: op.into(),
        }
    }

    #[test]
    fn sync_transfer_id_is_derived_from_the_full_path() {
        // Must match `syncTransferId` in sync.ts, and must distinguish same-named
        // files in different folders (the progress event's `name` cannot).
        assert_eq!(sync_transfer_id("app/config.yml"), "sync:app/config.yml");
        assert_ne!(
            sync_transfer_id("a/config.yml"),
            sync_transfer_id("b/config.yml")
        );
    }

    #[test]
    fn sync_mirror_op_quotes_both_roots() {
        let op = sync_mirror_op("/home/me/it's mine", "/srv/app", 5);
        assert!(op.starts_with("sync '/home/me/it'\\''s mine' <-> '/srv/app'"));
        assert!(op.ends_with("(5 actions)"));
    }

    #[test]
    fn sync_mirror_body_lists_ops_and_skips_conflicts() {
        let body = sync_mirror_body(&[
            act("a.py", "upload"),
            act("b.py", "download"),
            act("c.cfg", "deleteRemote"),
            act("d.cfg", "deleteLocal"),
            act("e.yml", "conflict"),
        ]);
        assert_eq!(
            body,
            "put 'a.py'\nget 'b.py'\nrm remote 'c.cfg'\nrm local 'd.cfg'"
        );
    }

    #[test]
    fn sync_mirror_body_caps_long_plans() {
        // A 200-file push must not bury the recording it is meant to document.
        let actions: Vec<SyncAction> = (0..MIRROR_BODY_LIMIT + 12)
            .map(|i| act(&format!("f{i}.txt"), "upload"))
            .collect();
        let body = sync_mirror_body(&actions);
        assert_eq!(body.lines().count(), MIRROR_BODY_LIMIT + 1);
        assert!(body.ends_with("… and 12 more"));
    }

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
        let cmd = remote_hash_command("/etc/nginx", &ExcludeSet::default());
        assert!(cmd.starts_with("sh -c "));
        // The script is itself one quoted `sh -c` token, so the path's own quotes
        // come out escaped; the live `hash_script_*` tests prove it still resolves.
        assert!(cmd.contains(r"cd -- '\''/etc/nginx'\''"));
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

    #[tokio::test]
    async fn until_cancelled_stops_a_pending_future() {
        let flag = Arc::new(AtomicBool::new(false));
        let f2 = flag.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            f2.store(true, Ordering::Relaxed);
        });
        let never = std::future::pending::<AppResult<()>>();
        assert!(matches!(
            until_cancelled(never, &flag).await.unwrap_err(),
            AppError::Cancelled
        ));
        // A finished future wins over an unset flag.
        let ok = until_cancelled(async { Ok(7) }, &AtomicBool::new(false)).await;
        assert_eq!(ok.unwrap(), 7);
    }

    #[test]
    fn parse_hash_output_reports_failures_instead_of_an_empty_tree() {
        // Each of these used to come back as `[]` — an "empty folder" that plans a
        // full upload, or a full delete with delete-extraneous on.
        let dir = parse_hash_output("/srv/x", &format!("{HASH_NO_DIR}\n")).unwrap_err();
        assert!(matches!(dir, AppError::SyncDirUnreadable(ref d) if d == "/srv/x"));
        let tool = parse_hash_output("/srv/x", &format!("{HASH_NO_TOOL}\n")).unwrap_err();
        assert!(matches!(tool, AppError::HashToolMissing));
        // No completion marker: the run was cut short, not the tree.
        let h = "a".repeat(64);
        let cut = parse_hash_output("/srv/x", &format!("{h}  ./a\n")).unwrap_err();
        assert!(matches!(cut, AppError::HashIncomplete));
        assert!(matches!(
            parse_hash_output("/srv/x", "").unwrap_err(),
            AppError::HashIncomplete
        ));
    }

    #[test]
    fn parse_hash_output_counts_unreadable_items() {
        let h = "a".repeat(64);
        let out = format!(
            "{h}  ./a.txt\n{HASH_ERR} find: './secret': Permission denied\n\
             {HASH_ERR} sha256sum: ./b: Permission denied\n{HASH_DONE}\n"
        );
        let tree = parse_hash_output("/srv/x", &out).unwrap();
        assert_eq!(tree.entries.len(), 1);
        assert_eq!(tree.entries[0].path, "a.txt");
        assert_eq!(tree.skipped, 2);
        // A genuinely empty folder is a success with nothing in it.
        let empty = parse_hash_output("/srv/x", &format!("{HASH_DONE}\r\n")).unwrap();
        assert_eq!(empty, HashTree::default());
    }

    /// Run the real script through a real `sh` — the stream swap, the `test -r`
    /// precedence and the quoting are exactly the parts a string assertion can't see.
    #[cfg(unix)]
    fn run_hash_script(dir: &str, excl: &[String]) -> AppResult<HashTree> {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(remote_hash_command(dir, &ExcludeSet::new(excl)))
            .output()
            .expect("sh runs");
        parse_hash_output(dir, &String::from_utf8_lossy(&out.stdout))
    }

    #[cfg(unix)]
    #[test]
    fn hash_script_lists_files_and_tells_empty_from_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("it's here");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.txt"), b"hello").unwrap();
        std::fs::write(root.join("sub/with space.txt"), b"x").unwrap();
        let tree = run_hash_script(root.to_str().unwrap(), &[]).unwrap();
        let mut paths: Vec<_> = tree.entries.iter().map(|e| e.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["a.txt", "sub/with space.txt"]);
        assert_eq!(
            tree.entries
                .iter()
                .find(|e| e.path == "a.txt")
                .unwrap()
                .sha256,
            sha256_hex(b"hello")
        );
        assert_eq!(tree.skipped, 0);

        let empty = tmp.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        assert_eq!(
            run_hash_script(empty.to_str().unwrap(), &[]).unwrap(),
            HashTree::default()
        );

        let missing = tmp.path().join("nope");
        assert!(matches!(
            run_hash_script(missing.to_str().unwrap(), &[]).unwrap_err(),
            AppError::SyncDirUnreadable(_)
        ));
    }

    fn pats(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exclude_set_takes_only_patterns_that_mean_the_same_on_both_sides() {
        let x = ExcludeSet::new(&pats(&[
            ".git",
            "*.tfstate",
            "/build/out/",
            "a/*",
            " ",
            "a?c",
        ]));
        assert!(x.skips(".git"));
        assert!(x.skips("sub/.git")); // any segment
        assert!(x.skips("env/prod.tfstate"));
        assert!(x.skips("build/out"));
        assert!(!x.skips("build/out2"));
        assert!(x.skips("abc") && !x.skips("abbc"));
        // A globbed path is the frontend's job — find's `*` would cross `/`.
        assert!(!x.skips("a/b"));
        // Brackets are literal, as in sync.ts.
        assert!(ExcludeSet::new(&pats(&["[x]"])).skips("[x]"));
        assert!(!ExcludeSet::new(&pats(&["[x]"])).skips("x"));
        assert_eq!(ExcludeSet::new(&[]).find_prune(), "");
    }

    #[test]
    fn glob_match_handles_stars_and_marks() {
        assert!(glob_match("*", ""));
        assert!(glob_match("*.log", "a.log"));
        assert!(!glob_match("*.log", "a.logx"));
        assert!(glob_match("a*b*c", "axxbyyc"));
        assert!(!glob_match("a*b*c", "axxbyy"));
        assert!(glob_match("?.txt", "a.txt") && !glob_match("?.txt", "ab.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn hash_script_prunes_excluded_folders_and_counts_them() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        for d in [
            "node_modules/pkg",
            ".git/objects",
            "src",
            "build/out",
            "a/b",
            "[x]",
        ] {
            std::fs::create_dir_all(r.join(d)).unwrap();
        }
        for f in [
            "node_modules/pkg/i.js",
            ".git/objects/o",
            "src/main.rs",
            "src/debug.log",
            "build/out/app",
            "a/b/c",
            "[x]/y",
        ] {
            std::fs::write(r.join(f), b"x").unwrap();
        }
        let excl = pats(&["node_modules", ".git", "*.log", "build/out", "a/*", "[x]"]);
        let tree = run_hash_script(r.to_str().unwrap(), &excl).unwrap();
        let mut paths: Vec<_> = tree.entries.iter().map(|e| e.path.as_str()).collect();
        paths.sort();
        // `a/*` is globbed with a slash: not pruned here, filtered by the frontend.
        assert_eq!(paths, ["a/b/c", "src/main.rs"]);
        // node_modules, .git, debug.log, build/out, [x] — one each.
        assert_eq!(tree.excluded, 5);
    }

    #[cfg(unix)]
    #[test]
    fn hash_script_counts_an_unreadable_subfolder() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let locked = tmp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("f"), b"x").unwrap();
        std::fs::write(tmp.path().join("ok"), b"y").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let tree = run_hash_script(tmp.path().to_str().unwrap(), &[]);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tree = tree.unwrap();
        // Root can read everything anyway; only assert when the lock actually held.
        if tree.entries.iter().all(|e| e.path != "locked/f") {
            assert_eq!(tree.skipped, 1);
        }
        assert!(tree.entries.iter().any(|e| e.path == "ok"));
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
