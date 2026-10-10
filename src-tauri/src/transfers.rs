//! Transfers the backend owns (v1.12, ADR 0025).
//!
//! A transfer used to live in the window that started it: the loop over the
//! files of a batch ran in that window's JavaScript, which session a transfer
//! belonged to was a map in its memory, and its progress went to that window
//! and no other. So a tab with a transfer under way could not be moved to
//! another window, and a transfer between two sessions — whose tabs may stand
//! in two windows — had nowhere to live at all.
//!
//! Here a transfer is a **job**: started by one command that returns at once,
//! carried out by the backend, and told to whichever window shows the tab of
//! each session it touches *at that moment*. A window is a view of the jobs of
//! its sessions; it awaits none of them.
//!
//! One job moves a list of files and folders from one side to the other. A side
//! is a session's server (over its SFTP), or this machine. That gives four
//! kinds from one loop: upload, download, a copy between two servers — through
//! this process, never through the disk — and a local copy.

use crate::error::{AppError, AppResult};
use crate::localfile;
use crate::sftp::{self, Report};
use crate::ssh::SshSession;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager};

/// The event a job's state travels in. Same family as `sftp://progress` (a
/// file of a sync run); a different kind of thing — a whole job, with the
/// sessions it touches — so a name of its own.
pub const EVENT: &str = "sftp://job";

/// A byte count inside a file is told no more often than this.
const TELL_EVERY_MS: u64 = 100;

/// How many paths the recording lists before it sums up the rest.
const AUDIT_BODY_LIMIT: usize = 50;

/// One side of a transfer.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Side {
    /// The tab this side belongs to — an SSH session, or a local tab. None: a
    /// path on this machine named outside any tab (a file dialog, a file
    /// dropped from the desktop).
    pub session: Option<String>,
    /// The files are on this machine, not on the session's server.
    pub local: bool,
    /// What the user calls that tab. Shown, and written into the other side's
    /// recording; never used to find anything.
    pub label: String,
}

/// One file or folder to move.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub from: String,
    /// Where it lands — the full path, name included.
    pub to: String,
    #[serde(default)]
    pub is_dir: bool,
    /// What is already at `to` may go (for a folder: it is merged into, and the
    /// files in it replaced). Without it an existing `to` is refused.
    #[serde(default)]
    pub replace: bool,
}

/// What the frontend asks for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    /// Chosen by the frontend, so that it knows the job before the first event.
    pub id: String,
    pub src: Side,
    pub dst: Side,
    pub items: Vec<Item>,
    /// The folder the items land in — a panel showing it re-lists when the job
    /// ends.
    pub dest_dir: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Running,
    Done,
    /// It ran to the end, and at least one file did not make it.
    Failed,
    Cancelled,
}

/// A job as its windows see it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub src: Side,
    pub dst: Side,
    pub dest_dir: String,
    /// The file being moved now.
    pub name: String,
    /// Files finished, of `file_count`. Zero of zero while the tree is walked.
    pub file_index: u32,
    pub file_count: u32,
    /// Bytes moved, of `total`, across the whole job.
    pub transferred: u64,
    pub total: u64,
    pub state: State,
    /// The first thing that went wrong.
    pub error: Option<String>,
    /// Files and folders that did not make it.
    pub failed: u32,
    /// Symbolic links and unreadable sub-folders left out.
    pub skipped: u32,
}

impl JobView {
    pub fn start(spec: &Spec) -> Self {
        Self {
            id: spec.id.clone(),
            src: spec.src.clone(),
            dst: spec.dst.clone(),
            dest_dir: spec.dest_dir.clone(),
            name: spec
                .items
                .first()
                .map(|i| base_name(&i.from))
                .unwrap_or_default(),
            file_index: 0,
            file_count: 0,
            transferred: 0,
            total: 0,
            state: State::Running,
            error: None,
            failed: 0,
            skipped: 0,
        }
    }

    fn touches(&self, session_id: &str) -> bool {
        [&self.src, &self.dst]
            .iter()
            .any(|side| side.session.as_deref() == Some(session_id))
    }
}

// ── The registry ────────────────────────────────────────────────────────────

struct Entry {
    view: JobView,
    cancel: Arc<AtomicBool>,
    /// The window that started the job.
    origin: String,
}

/// The jobs under way. No Tauri types: every rule here is unit-tested.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Entry>>);

impl Jobs {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Take a new job in. False — and nothing changes — when its id is taken:
    /// the id is the frontend's, and one job must not be able to answer to
    /// another's cancel.
    pub fn add(&self, view: JobView, cancel: Arc<AtomicBool>, origin: &str) -> bool {
        let mut jobs = self.lock();
        if jobs.contains_key(&view.id) {
            return false;
        }
        jobs.insert(
            view.id.clone(),
            Entry {
                view,
                cancel,
                origin: origin.to_string(),
            },
        );
        true
    }

    fn put(&self, view: &JobView) {
        if let Some(entry) = self.lock().get_mut(&view.id) {
            entry.view = view.clone();
        }
    }

    fn remove(&self, id: &str) {
        self.lock().remove(id);
    }

    /// The jobs window `label` shows: those it would be told about now.
    pub fn shown_in(&self, label: &str, owner_of: impl Fn(&str) -> Option<String>) -> Vec<JobView> {
        let mut shown: Vec<JobView> = self
            .lock()
            .values()
            .filter(|e| {
                audience(&e.view, &e.origin, &owner_of)
                    .iter()
                    .any(|l| l == label)
            })
            .map(|e| e.view.clone())
            .collect();
        shown.sort_by(|a, b| a.id.cmp(&b.id));
        shown
    }

    /// A session is ending: stop every job that reads from it or writes to it.
    /// The job holds the session open until it notices, so it must be told —
    /// and what it staged on the other side is cleaned up by its own exit.
    pub fn cancel_session(&self, session_id: &str) -> usize {
        let jobs = self.lock();
        let hit: Vec<&Entry> = jobs
            .values()
            .filter(|e| e.view.touches(session_id))
            .collect();
        for entry in &hit {
            entry.cancel.store(true, Ordering::Relaxed);
        }
        hit.len()
    }
}

/// The windows a job is told to: whichever shows the tab of each session it
/// touches, right now. A job none of whose sessions has a tab — a download
/// whose tab was closed is cancelled, but its last word still has to land —
/// is told to the window that started it.
pub fn audience(
    view: &JobView,
    origin: &str,
    owner_of: impl Fn(&str) -> Option<String>,
) -> Vec<String> {
    let mut labels: Vec<String> = [&view.src, &view.dst]
        .iter()
        .filter_map(|side| side.session.as_deref())
        .filter_map(owner_of)
        .collect();
    if labels.is_empty() {
        labels.push(origin.to_string());
    }
    labels.sort();
    labels.dedup();
    labels
}

// ── The two ends ────────────────────────────────────────────────────────────

/// Where files are read from, or written to.
pub enum End {
    Local,
    Remote(Arc<SftpSession>),
}

/// An end, and the SSH session behind it — the one whose recording is told what
/// was done.
pub struct Party {
    pub end: End,
    pub ssh: Option<Arc<SshSession>>,
}

impl End {
    async fn list(&self, dir: &str) -> AppResult<Vec<sftp::FileEntry>> {
        match self {
            End::Local => localfile::list(dir).await,
            End::Remote(s) => sftp::list(s, dir).await,
        }
    }

    async fn exists(&self, path: &str) -> bool {
        match self {
            End::Local => tokio::fs::symlink_metadata(path).await.is_ok(),
            End::Remote(s) => s.metadata(path).await.is_ok(),
        }
    }

    async fn size(&self, path: &str) -> u64 {
        match self {
            End::Local => tokio::fs::metadata(path)
                .await
                .map(|m| m.len())
                .unwrap_or(0),
            End::Remote(s) => s
                .metadata(path)
                .await
                .ok()
                .and_then(|m| m.size)
                .unwrap_or(0),
        }
    }

    /// Make a folder that may be there already.
    async fn mkdir(&self, dir: &str) {
        match self {
            End::Local => {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
            End::Remote(s) => {
                let _ = s.create_dir(dir).await;
            }
        }
    }

    fn is_local(&self) -> bool {
        matches!(self, End::Local)
    }
}

/// `dir`/`name` on the destination, for a `name` the source listed. The source
/// may be a server, and a server's word is not to be trusted with a path —
/// neither on this disk nor on another server (see `localfile::safe_child`).
/// The only way a destination path is built from a listed name.
fn child_path(local: bool, dir: &str, name: &str) -> AppResult<String> {
    if local {
        Ok(localfile::safe_child(Path::new(dir), name)?
            .to_string_lossy()
            .into_owned())
    } else {
        sftp::safe_child(dir, name)
    }
}

// ── Carrying a job out ──────────────────────────────────────────────────────

struct Planned {
    from: String,
    to: String,
    size: u64,
    replace: bool,
}

#[derive(Default)]
struct Plan {
    /// Folders to make on the destination, a parent before its children.
    dirs: Vec<String>,
    files: Vec<Planned>,
    skipped: u32,
    /// Items that could not be taken at all, with why.
    refused: Vec<String>,
    /// The walk was stopped before it had seen everything.
    cut: bool,
}

/// Walk what was asked for: every file to move, with its size, and every folder
/// to make. Nothing is written here — a name that would leave the destination
/// stops the job before its first byte.
async fn plan(spec: &Spec, src: &End, dst: &End, cancel: &AtomicBool) -> AppResult<Plan> {
    let mut plan = Plan::default();
    for item in &spec.items {
        if cancel.load(Ordering::Relaxed) {
            plan.cut = true;
            break;
        }
        if !item.is_dir {
            plan.files.push(Planned {
                from: item.from.clone(),
                to: item.to.clone(),
                size: src.size(&item.from).await,
                replace: item.replace,
            });
            continue;
        }
        if !item.replace && dst.exists(&item.to).await {
            plan.refused
                .push(format!("{}: {}", item.to, AppError::DestinationExists));
            continue;
        }
        let mut stack = vec![(item.from.clone(), item.to.clone())];
        let mut root = true;
        while let Some((from_dir, to_dir)) = stack.pop() {
            if cancel.load(Ordering::Relaxed) {
                plan.cut = true;
                break;
            }
            let entries = match src.list(&from_dir).await {
                Ok(entries) => entries,
                // The folder asked for must be readable; one inside it that is
                // not is left out, and counted.
                Err(e) if root => {
                    plan.refused.push(e.to_string());
                    break;
                }
                Err(_) => {
                    plan.skipped += 1;
                    continue;
                }
            };
            root = false;
            plan.dirs.push(to_dir.clone());
            for entry in entries {
                // Reading a link as a file fails, and following one to a folder
                // risks a cycle.
                if entry.is_symlink {
                    plan.skipped += 1;
                    continue;
                }
                let to = child_path(dst.is_local(), &to_dir, &entry.name)?;
                if entry.is_dir {
                    stack.push((entry.path, to));
                } else {
                    plan.files.push(Planned {
                        from: entry.path,
                        to,
                        size: entry.size,
                        replace: item.replace,
                    });
                }
            }
        }
    }
    Ok(plan)
}

/// Move one file, staged at its destination and put in place only when whole.
async fn move_file(
    src: &End,
    dst: &End,
    file: &Planned,
    report: &Report<'_>,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let (from, to, replace, cancel) = (&file.from, &file.to, file.replace, Some(cancel));
    match (src, dst) {
        (End::Local, End::Remote(d)) => {
            sftp::upload_staged(report, d, from, to, replace, cancel).await
        }
        (End::Remote(s), End::Local) => {
            sftp::download_file(report, s, from, to, replace, cancel).await
        }
        (End::Remote(s), End::Remote(d)) => {
            sftp::relay_staged(report, s, d, from, to, replace, cancel).await
        }
        (End::Local, End::Local) => localfile::copy_staged(report, from, to, replace, cancel).await,
    }
}

/// Carry a job out and return how it ended. `tell` hears every change of the
/// view; `true` marks a byte count inside a file — the kind a listener may drop.
/// One file failing does not stop the rest: the job says how many did not make
/// it, and why the first one did not.
pub(crate) async fn carry_out(
    start: JobView,
    spec: &Spec,
    src: &End,
    dst: &End,
    cancel: &AtomicBool,
    tell: &(dyn Fn(&JobView, bool) + Send + Sync),
) -> JobView {
    let view = Mutex::new(start);
    let change = |minor: bool, apply: &dyn Fn(&mut JobView)| {
        let mut v = view.lock().unwrap_or_else(|e| e.into_inner());
        apply(&mut v);
        tell(&v, minor);
    };
    change(false, &|_| {});

    let planned = plan(spec, src, dst, cancel).await;
    // A walk that failed as a whole — a listed name that would leave the
    // destination — fails every item, with nothing written.
    let (mut failed, mut error) = match &planned {
        Err(e) => (spec.items.len() as u32, Some(e.to_string())),
        Ok(plan) => (plan.refused.len() as u32, plan.refused.first().cloned()),
    };
    let mut cancelled = false;
    if let Ok(plan) = planned {
        // Stopped while the tree was being walked: what was found is not moved.
        cancelled = plan.cut;
        let total: u64 = plan.files.iter().map(|f| f.size).sum();
        let count = plan.files.len() as u32;
        change(false, &|v| {
            v.file_count = count;
            v.total = total;
            v.skipped = plan.skipped;
            v.failed = failed;
        });
        if !cancelled {
            for dir in &plan.dirs {
                dst.mkdir(dir).await;
            }
        }
        let mut moved: u64 = 0;
        for (index, file) in plan.files.iter().enumerate() {
            if cancelled || cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            change(false, &|v| {
                v.name = base_name(&file.to);
                v.file_index = index as u32;
                v.transferred = moved;
            });
            let before = moved;
            let within = |bytes: u64| {
                change(true, &|v| v.transferred = (before + bytes).min(total));
            };
            match move_file(src, dst, file, &Report::Job(&within), cancel).await {
                Ok(()) => {}
                Err(AppError::Cancelled) => {
                    cancelled = true;
                    break;
                }
                Err(e) => {
                    failed += 1;
                    error.get_or_insert(e.to_string());
                }
            }
            moved += file.size;
            change(false, &|v| {
                v.file_index = index as u32 + 1;
                v.transferred = moved;
                v.failed = failed;
            });
        }
    }

    let mut done = view.into_inner().unwrap_or_else(|e| e.into_inner());
    done.failed = failed;
    done.error = error;
    done.state = if cancelled {
        State::Cancelled
    } else if failed > 0 {
        State::Failed
    } else {
        State::Done
    };
    done
}

// ── What a session's recording is told ──────────────────────────────────────

/// A tab's name as it goes into a recording: nothing that could pass for
/// terminal control or split the line.
fn audit_label(label: &str) -> String {
    let clean: String = label
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "._@-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    if clean.is_empty() {
        "session".to_string()
    } else {
        clean
    }
}

/// The `[sftp] $ …` line for one side's recording. One line per job, not per
/// file (the audit contract of a mass operation): a single file reads as before
/// — `put 'local' -> 'remote'`, `get 'remote' -> 'local'` — and a copy between
/// two servers names the other one, `scp`-style.
pub fn audit_op(spec: &Spec, on_src: bool) -> String {
    let q = crate::git::shell_quote;
    let other = if on_src { &spec.dst } else { &spec.src };
    let peer = (!other.local).then(|| audit_label(&other.label));
    let verb = match (&peer, on_src) {
        (Some(_), _) => "copy",
        (None, true) => "get",
        (None, false) => "put",
    };
    let at = |side_is_peer: bool, path: &str| match (&peer, side_is_peer) {
        (Some(name), true) => format!("{name}:{}", q(path)),
        _ => q(path),
    };
    match spec.items.as_slice() {
        [one] => format!(
            "{verb} {} -> {}",
            at(!on_src, &one.from),
            at(on_src, &one.to)
        ),
        many => {
            let from = match (&peer, on_src) {
                (Some(name), false) => format!(" from {name}"),
                _ => String::new(),
            };
            format!(
                "{verb} {} items{from} -> {}",
                many.len(),
                at(on_src, &spec.dest_dir)
            )
        }
    }
}

/// What the recording lists under that line: the paths of a job of several
/// items, capped; then what was left out or went wrong.
pub fn audit_body(spec: &Spec, done: &JobView) -> String {
    let mut lines: Vec<String> = Vec::new();
    if spec.items.len() > 1 {
        for item in spec.items.iter().take(AUDIT_BODY_LIMIT) {
            lines.push(crate::git::shell_quote(&item.from));
        }
        if spec.items.len() > AUDIT_BODY_LIMIT {
            lines.push(format!(
                "… and {} more",
                spec.items.len() - AUDIT_BODY_LIMIT
            ));
        }
    }
    if done.skipped > 0 {
        lines.push(format!(
            "{} links or unreadable folders skipped",
            done.skipped
        ));
    }
    if done.failed > 0 {
        lines.push(format!("{} failed", done.failed));
    }
    if let Some(error) = &done.error {
        lines.push(error.clone());
    }
    if done.state == State::Cancelled {
        lines.push("stopped by user".to_string());
    }
    lines.join("\n")
}

fn audit_exit(done: &JobView) -> i32 {
    match done.state {
        State::Cancelled => 130,
        State::Failed => 1,
        State::Running | State::Done => 0,
    }
}

fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

// ── The job, as the app runs it ─────────────────────────────────────────────

fn send(app: &AppHandle, view: &JobView, origin: &str) {
    let windows = app.state::<crate::appwin::Windows>();
    for label in audience(view, origin, |session| windows.owner_of(session)) {
        let _ = app.emit_to(label.as_str(), EVENT, view);
    }
}

/// Run a registered job to its end: tell its windows as it goes, take it off
/// the registry, say the last word, and write it into the recordings of the
/// SSH sessions it touched.
pub async fn run(
    app: &AppHandle,
    spec: Spec,
    src: Party,
    dst: Party,
    cancel: Arc<AtomicBool>,
    origin: String,
) {
    let started = std::time::Instant::now();
    let last_told = AtomicU64::new(0);
    let tell = |view: &JobView, minor: bool| {
        app.state::<Jobs>().put(view);
        if minor {
            let now = started.elapsed().as_millis() as u64;
            if now.saturating_sub(last_told.load(Ordering::Relaxed)) < TELL_EVERY_MS {
                return;
            }
            last_told.store(now, Ordering::Relaxed);
        }
        send(app, view, &origin);
    };
    let done = carry_out(
        JobView::start(&spec),
        &spec,
        &src.end,
        &dst.end,
        &cancel,
        &tell,
    )
    .await;
    // Off the registry first: a window that asks for the list on hearing the
    // last word must not be handed a job that has ended.
    app.state::<Jobs>().remove(&done.id);
    send(app, &done, &origin);

    let body = audit_body(&spec, &done);
    for (party, on_src) in [(&src, true), (&dst, false)] {
        if let Some(session) = &party.ssh {
            let line = sftp::sftp_mirror(&audit_op(&spec, on_src), audit_exit(&done), &body);
            session.record_output(line.as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(session: Option<&str>, local: bool, label: &str) -> Side {
        Side {
            session: session.map(str::to_string),
            local,
            label: label.to_string(),
        }
    }

    fn item(from: &str, to: &str, is_dir: bool, replace: bool) -> Item {
        Item {
            from: from.to_string(),
            to: to.to_string(),
            is_dir,
            replace,
        }
    }

    fn spec(id: &str, src: Side, dst: Side, items: Vec<Item>, dest_dir: &str) -> Spec {
        Spec {
            id: id.to_string(),
            src,
            dst,
            items,
            dest_dir: dest_dir.to_string(),
        }
    }

    fn remote(session: &str, label: &str) -> Side {
        side(Some(session), false, label)
    }

    fn disk() -> Side {
        side(None, true, "")
    }

    fn view_of(id: &str, src: Side, dst: Side) -> JobView {
        JobView::start(&spec(
            id,
            src,
            dst,
            vec![item("/a", "/b", false, false)],
            "/",
        ))
    }

    fn owners<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |session| {
            pairs
                .iter()
                .find(|(s, _)| *s == session)
                .map(|(_, label)| label.to_string())
        }
    }

    #[test]
    fn a_job_is_told_to_the_windows_that_show_its_sessions_now() {
        let copy = view_of("j", remote("a", "web"), remote("b", "db"));
        // Both tabs in one window: told once.
        assert_eq!(
            audience(&copy, "main", owners(&[("a", "main"), ("b", "main")])),
            ["main"]
        );
        // The destination's tab was moved out: both windows hear of it — and
        // the window that started the job has no say in that.
        assert_eq!(
            audience(&copy, "win-3", owners(&[("a", "main"), ("b", "win-2")])),
            ["main", "win-2"]
        );
        // One tab closed: the window of the other.
        assert_eq!(
            audience(&copy, "main", owners(&[("b", "win-2")])),
            ["win-2"]
        );
        // No tab left at all: the last word goes to whoever started it.
        assert_eq!(audience(&copy, "win-2", owners(&[])), ["win-2"]);
        // An upload from the disk follows the tab of the server it goes to.
        let upload = view_of("u", disk(), remote("a", "web"));
        assert_eq!(
            audience(&upload, "main", owners(&[("a", "win-2")])),
            ["win-2"]
        );
    }

    #[test]
    fn the_registry_lists_a_window_its_jobs_and_stops_those_of_an_ending_session() {
        let jobs = Jobs::default();
        let flag = || Arc::new(AtomicBool::new(false));
        let (f1, f2, f3) = (flag(), flag(), flag());
        assert!(jobs.add(view_of("1", disk(), remote("a", "web")), f1.clone(), "main"));
        assert!(jobs.add(
            view_of("2", remote("a", "web"), remote("b", "db")),
            f2.clone(),
            "main"
        ));
        assert!(jobs.add(view_of("3", remote("c", "x"), disk()), f3.clone(), "main"));
        // The id is the frontend's: a second job may not take a first one's.
        assert!(!jobs.add(view_of("1", disk(), remote("z", "z")), flag(), "main"));

        let owner = owners(&[("a", "main"), ("b", "win-2"), ("c", "win-2")]);
        let ids = |label: &str| -> Vec<String> {
            jobs.shown_in(label, &owner)
                .into_iter()
                .map(|v| v.id)
                .collect()
        };
        assert_eq!(ids("main"), ["1", "2"]);
        assert_eq!(ids("win-2"), ["2", "3"]);
        assert!(ids("win-9").is_empty());

        // Session `a` ends: what reads from it or writes to it stops, the rest
        // goes on.
        assert_eq!(jobs.cancel_session("a"), 2);
        assert!(f1.load(Ordering::Relaxed) && f2.load(Ordering::Relaxed));
        assert!(!f3.load(Ordering::Relaxed));

        jobs.remove("2");
        assert_eq!(ids("win-2"), ["3"]);
    }

    #[test]
    fn the_recording_reads_a_single_file_as_before_and_names_the_other_server() {
        let up = spec(
            "j",
            disk(),
            remote("a", "web"),
            vec![item("/Users/me/a b.conf", "/etc/a b.conf", false, true)],
            "/etc",
        );
        assert_eq!(
            audit_op(&up, false),
            "put '/Users/me/a b.conf' -> '/etc/a b.conf'"
        );
        let down = spec(
            "j",
            remote("a", "web"),
            disk(),
            vec![item("/etc/x", "/Users/me/x", false, true)],
            "/Users/me",
        );
        assert_eq!(audit_op(&down, true), "get '/etc/x' -> '/Users/me/x'");

        let copy = spec(
            "j",
            remote("a", "web-01"),
            remote("b", "db 1;rm"),
            vec![item("/etc/x", "/srv/x", false, false)],
            "/srv",
        );
        // Each recording names the other side; a label cannot break the line.
        assert_eq!(audit_op(&copy, true), "copy '/etc/x' -> db_1_rm:'/srv/x'");
        assert_eq!(audit_op(&copy, false), "copy web-01:'/etc/x' -> '/srv/x'");
    }

    #[test]
    fn the_recording_sums_up_a_job_of_many_items() {
        let items: Vec<Item> = (0..60)
            .map(|i| item(&format!("/src/f{i}"), &format!("/dst/f{i}"), false, false))
            .collect();
        let copy = spec("j", remote("a", "web"), remote("b", "db"), items, "/dst");
        assert_eq!(audit_op(&copy, true), "copy 60 items -> db:'/dst'");
        assert_eq!(audit_op(&copy, false), "copy 60 items from web -> '/dst'");
        let up = spec(
            "j",
            disk(),
            remote("b", "db"),
            vec![
                item("/l/1", "/d/1", false, false),
                item("/l/2", "/d/2", true, false),
            ],
            "/d",
        );
        assert_eq!(audit_op(&up, false), "put 2 items -> '/d'");

        let mut done = JobView::start(&copy);
        done.state = State::Failed;
        done.failed = 2;
        done.skipped = 1;
        done.error = Some("open /src/f3: permission denied".into());
        let body = audit_body(&copy, &done);
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines[0], "'/src/f0'");
        assert_eq!(lines[AUDIT_BODY_LIMIT], "… and 10 more");
        assert_eq!(
            &lines[AUDIT_BODY_LIMIT + 1..],
            [
                "1 links or unreadable folders skipped",
                "2 failed",
                "open /src/f3: permission denied"
            ]
        );
        assert_eq!(audit_exit(&done), 1);
        done.state = State::Cancelled;
        assert_eq!(audit_exit(&done), 130);
        assert!(audit_body(&copy, &done).ends_with("stopped by user"));
    }

    #[test]
    fn a_destination_path_is_built_only_from_one_safe_name() {
        assert_eq!(
            child_path(false, "/srv/app", "a.conf").unwrap(),
            "/srv/app/a.conf"
        );
        assert_eq!(child_path(false, "/", "a").unwrap(), "/a");
        for bad in ["../../etc/cron.d/x", "/etc/passwd", "..", "", "a/b"] {
            assert!(child_path(false, "/srv/app", bad).is_err(), "{bad:?}");
            assert!(child_path(true, "/home/me/dl", bad).is_err(), "{bad:?}");
        }
        // A backslash is an ordinary character in a POSIX name, on any machine.
        assert_eq!(child_path(false, "/srv", "a\\b").unwrap(), "/srv/a\\b");
    }

    // ── A whole job, between two folders of this machine ──────────────────

    /// Everything `tell` heard, in order.
    type Heard = Mutex<Vec<(JobView, bool)>>;

    async fn local_job(spec: &Spec, cancel: &AtomicBool, heard: &Heard) -> JobView {
        let tell = |view: &JobView, minor: bool| {
            heard.lock().unwrap().push((view.clone(), minor));
        };
        carry_out(
            JobView::start(spec),
            spec,
            &End::Local,
            &End::Local,
            cancel,
            &tell,
        )
        .await
    }

    fn path(dir: &Path, rel: &str) -> String {
        dir.join(rel).to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn a_job_moves_files_and_a_folder_and_says_how_far_it_is() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        std::fs::create_dir_all(src.join("site/css")).unwrap();
        std::fs::create_dir_all(src.join("site/empty")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("a.txt"), b"alpha").unwrap();
        std::fs::write(src.join("site/index.html"), b"<html>").unwrap();
        std::fs::write(src.join("site/css/app.css"), vec![b'x'; 700 * 1024]).unwrap();

        let job = spec(
            "j",
            disk(),
            disk(),
            vec![
                item(&path(&src, "a.txt"), &path(&dst, "a.txt"), false, false),
                item(&path(&src, "site"), &path(&dst, "site"), true, false),
            ],
            &path(&dst, ""),
        );
        let heard = Heard::default();
        let done = local_job(&job, &AtomicBool::new(false), &heard).await;

        assert_eq!(done.state, State::Done, "{:?}", done.error);
        assert_eq!((done.file_index, done.file_count), (3, 3));
        assert_eq!(done.total, 5 + 6 + 700 * 1024);
        assert_eq!(done.transferred, done.total);
        assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(
            std::fs::read(dst.join("site/index.html")).unwrap(),
            b"<html>"
        );
        assert_eq!(
            std::fs::read(dst.join("site/css/app.css")).unwrap().len(),
            700 * 1024
        );
        // A folder with nothing in it is a folder all the same.
        assert!(dst.join("site/empty").is_dir());
        // No staging temp is left next to anything.
        let litter: Vec<_> = walk(&dst)
            .into_iter()
            .filter(|p| p.contains(".vterm-tmp-"))
            .collect();
        assert!(litter.is_empty(), "{litter:?}");

        let heard = heard.lock().unwrap();
        // The first word comes before anything is walked; the count never goes
        // back; a byte count inside a file is marked as one that may be dropped.
        assert_eq!(heard[0].0.file_count, 0);
        assert!(heard
            .windows(2)
            .all(|w| w[0].0.transferred <= w[1].0.transferred));
        assert!(heard
            .iter()
            .any(|(v, minor)| *minor && v.name == "app.css" && v.transferred < v.total));
        assert!(heard.iter().all(|(v, _)| v.state == State::Running));
    }

    fn walk(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d).unwrap() {
                let p = entry.unwrap().path();
                if p.is_dir() {
                    stack.push(p.clone());
                }
                out.push(p.to_string_lossy().into_owned());
            }
        }
        out
    }

    #[tokio::test]
    async fn a_taken_name_is_refused_and_the_rest_of_the_job_goes_on() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        std::fs::create_dir_all(src.join("conf")).unwrap();
        std::fs::create_dir_all(dst.join("conf")).unwrap();
        std::fs::write(src.join("a.txt"), b"mine").unwrap();
        std::fs::write(src.join("b.txt"), b"new").unwrap();
        std::fs::write(src.join("c.txt"), b"mine too").unwrap();
        std::fs::write(src.join("conf/x"), b"x").unwrap();
        std::fs::write(dst.join("a.txt"), b"theirs").unwrap();
        std::fs::write(dst.join("c.txt"), b"theirs too").unwrap();

        let job = spec(
            "j",
            disk(),
            disk(),
            vec![
                item(&path(&src, "a.txt"), &path(&dst, "a.txt"), false, false),
                item(&path(&src, "b.txt"), &path(&dst, "b.txt"), false, false),
                // Told it may replace: it does.
                item(&path(&src, "c.txt"), &path(&dst, "c.txt"), false, true),
                // A folder that is there, and no leave to merge into it.
                item(&path(&src, "conf"), &path(&dst, "conf"), true, false),
            ],
            &path(&dst, ""),
        );
        let done = local_job(&job, &AtomicBool::new(false), &Heard::default()).await;

        assert_eq!(done.state, State::Failed);
        assert_eq!(done.failed, 2);
        assert!(
            done.error.as_deref().unwrap().contains("dest-exists"),
            "{:?}",
            done.error
        );
        assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"theirs");
        assert_eq!(std::fs::read(dst.join("b.txt")).unwrap(), b"new");
        assert_eq!(std::fs::read(dst.join("c.txt")).unwrap(), b"mine too");
        assert!(!dst.join("conf/x").exists());
    }

    #[tokio::test]
    async fn a_folder_told_it_may_replace_is_merged_into() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        std::fs::create_dir_all(src.join("conf")).unwrap();
        std::fs::create_dir_all(dst.join("conf")).unwrap();
        std::fs::write(src.join("conf/x"), b"new x").unwrap();
        std::fs::write(dst.join("conf/x"), b"old x").unwrap();
        std::fs::write(dst.join("conf/kept"), b"kept").unwrap();

        let job = spec(
            "j",
            disk(),
            disk(),
            vec![item(&path(&src, "conf"), &path(&dst, "conf"), true, true)],
            &path(&dst, ""),
        );
        let done = local_job(&job, &AtomicBool::new(false), &Heard::default()).await;
        assert_eq!(done.state, State::Done, "{:?}", done.error);
        assert_eq!(std::fs::read(dst.join("conf/x")).unwrap(), b"new x");
        assert_eq!(std::fs::read(dst.join("conf/kept")).unwrap(), b"kept");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn links_are_left_out_and_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        std::fs::create_dir_all(src.join("d")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("d/real"), b"r").unwrap();
        std::os::unix::fs::symlink(src.join("d/real"), src.join("d/link")).unwrap();
        // A link back up the tree: following it would never end.
        std::os::unix::fs::symlink(&src, src.join("d/loop")).unwrap();

        let job = spec(
            "j",
            disk(),
            disk(),
            vec![item(&path(&src, "d"), &path(&dst, "d"), true, false)],
            &path(&dst, ""),
        );
        let done = local_job(&job, &AtomicBool::new(false), &Heard::default()).await;
        assert_eq!(done.state, State::Done, "{:?}", done.error);
        assert_eq!(done.skipped, 2);
        assert_eq!(done.file_count, 1);
        assert!(dst.join("d/real").exists());
        assert!(!dst.join("d/link").exists() && !dst.join("d/loop").exists());
    }

    #[tokio::test]
    async fn a_stopped_job_writes_nothing_more_and_says_it_was_stopped() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        for name in ["1", "2", "3"] {
            std::fs::write(src.join(name), b"data").unwrap();
        }
        let items = ["1", "2", "3"]
            .iter()
            .map(|n| item(&path(&src, n), &path(&dst, n), false, false))
            .collect();
        let job = spec("j", disk(), disk(), items, &path(&dst, ""));

        // Stopped before it began.
        let stopped = AtomicBool::new(true);
        let done = local_job(&job, &stopped, &Heard::default()).await;
        assert_eq!(done.state, State::Cancelled);
        assert!(std::fs::read_dir(&dst).unwrap().next().is_none());

        // Stopped as the first file ends: the second is never begun.
        let cancel = AtomicBool::new(false);
        let tell = |view: &JobView, _minor: bool| {
            if view.file_index == 1 {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        let done = carry_out(
            JobView::start(&job),
            &job,
            &End::Local,
            &End::Local,
            &cancel,
            &tell,
        )
        .await;
        assert_eq!(done.state, State::Cancelled);
        assert_eq!(done.file_index, 1);
        assert!(dst.join("1").exists());
        assert!(!dst.join("2").exists() && !dst.join("3").exists());
    }

    #[tokio::test]
    async fn a_folder_that_cannot_be_read_fails_the_job_instead_of_copying_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let dst = tmp.path().join("dst");
        std::fs::create_dir_all(&dst).unwrap();
        let job = spec(
            "j",
            disk(),
            disk(),
            vec![item(
                &path(tmp.path(), "nope"),
                &path(&dst, "nope"),
                true,
                false,
            )],
            &path(&dst, ""),
        );
        let done = local_job(&job, &AtomicBool::new(false), &Heard::default()).await;
        assert_eq!(done.state, State::Failed);
        assert_eq!(done.failed, 1);
        assert!(done.error.is_some());
        assert!(!dst.join("nope").exists());
    }

    /// Source of this module before its tests, line comments stripped.
    fn code() -> String {
        let src = include_str!("transfers.rs").replace("\r\n", "\n");
        src[..src.find("#[cfg(test)]").expect("tests")]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_job_is_told_only_to_the_windows_of_its_sessions() {
        // Guard (v1.12, ADR 0025). A job's state goes to whichever window shows
        // the tab of each session it touches at that moment — that is what lets
        // a tab move to another window with its transfer under way. Sent to the
        // window that started the job, or to every window, the row would stay
        // behind in a window that no longer has the tab.
        let code = code();
        // One place sends, and it sends to the audience.
        assert_eq!(code.matches("emit_to(").count(), 1, "one place sends a job");
        assert!(!code.contains(".emit("), "a job is never broadcast");
        let send = &code[code.find("fn send(").expect("send")..];
        let send = &send[..send.find("\n}\n").expect("end of send")];
        assert!(send.contains("audience(view, origin, |session| windows.owner_of(session))"));
        assert!(send.contains("emit_to(label.as_str(), EVENT, view)"));
        // And the job leaves the registry before its last word is said.
        let run = &code[code.find("pub async fn run(").expect("run")..];
        let gone = run.find(".remove(&done.id)").expect("leaves the registry");
        let last = run
            .find("send(app, &done, &origin)")
            .expect("says the last word");
        assert!(gone < last);
    }
}

/// Jobs between two servers, against a real sshd — the relay cannot be seen to
/// work without one. Named `live_sftp` so the documented command runs it too:
/// `cargo test --lib live_sftp -- --ignored` (see docs/TESTS.md).
#[cfg(test)]
mod live_sftp {
    use super::*;
    use crate::sftp::live_sftp::{connect, path_for, seed, DIR};

    fn remote(session: &str, label: &str) -> Side {
        Side {
            session: Some(session.to_string()),
            local: false,
            label: label.to_string(),
        }
    }

    /// A folder copied from one connection to another: the bytes arrive, the
    /// tree is rebuilt, and nothing is staged on this machine on the way.
    #[tokio::test]
    #[ignore = "needs e2e/docker-compose.ssh.yml up -d"]
    async fn a_folder_goes_from_one_session_to_another() {
        let (a, b) = (Arc::new(connect().await), Arc::new(connect().await));
        let from = path_for("relay-src").replace(".conf", "");
        let to = path_for("relay-dst").replace(".conf", "");
        a.create_dir(from.clone()).await.expect("mkdir");
        a.create_dir(format!("{from}/sub")).await.expect("mkdir");
        seed(&a, &format!("{from}/one.txt"), b"one\n").await;
        seed(&a, &format!("{from}/sub/two.bin"), &vec![7u8; 300 * 1024]).await;

        let job = Spec {
            id: "j".into(),
            src: remote("a", "web"),
            dst: remote("b", "db"),
            items: vec![Item {
                from: from.clone(),
                to: to.clone(),
                is_dir: true,
                replace: false,
            }],
            dest_dir: DIR.to_string(),
        };
        let done = carry_out(
            JobView::start(&job),
            &job,
            &End::Remote(a.clone()),
            &End::Remote(b.clone()),
            &AtomicBool::new(false),
            &|_, _| {},
        )
        .await;

        assert_eq!(done.state, State::Done, "{:?}", done.error);
        assert_eq!((done.file_index, done.file_count), (2, 2));
        assert_eq!(done.transferred, 4 + 300 * 1024);
        assert_eq!(
            b.read(format!("{to}/one.txt")).await.expect("read"),
            b"one\n"
        );
        assert_eq!(
            b.read(format!("{to}/sub/two.bin"))
                .await
                .expect("read")
                .len(),
            300 * 1024
        );

        for dir in [&from, &to] {
            let _ = sftp::remove(&a, dir, true).await;
        }
    }
}
