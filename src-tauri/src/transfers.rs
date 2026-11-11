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
//!
//! A job cut off before it was through — the connection dropped, its session
//! was replaced — is kept (v1.36, ADR 0060): what it had left to do, and the
//! partial copy of the file it was in the middle of ([`crate::partial`]). Its
//! row offers to go on; going on is a job again, under the same id, that copies
//! only what was left and the cut-off file from its last checkpoint. A job the
//! user stopped is not kept, and neither is one whose tab has closed.

use crate::diag::Logged;
use crate::error::{AppError, AppResult};
use crate::localfile;
use crate::partial::{Keep, Partial};
use crate::sftp::{self, Report};
use crate::ssh::SshSession;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    /// Waiting for an earlier job of one of its sessions to end (v1.35).
    Queued,
    Running,
    Done,
    /// It ran to the end, and at least one file did not make it.
    Failed,
    /// Stopped by the user.
    Cancelled,
    /// Cut off by its session ending under it — a reconnect, a closed tab
    /// (v1.36, ADR 0060).
    Interrupted,
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
    /// Unreadable sub-folders, and links the destination cannot hold or the source would not read, left out.
    pub skipped: u32,
    /// It ended with something left to do, and is kept to go on with it
    /// (v1.36, ADR 0060): `transfer_resume`, or `transfer_forget`.
    pub resumable: bool,
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
            resumable: false,
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
    /// Its session ended under it (`cancel_session`): cut off, not stopped.
    interrupted: bool,
}

/// An interrupted job, kept to be gone on with (v1.36, ADR 0060).
pub struct Held {
    /// Its last word, `resumable`.
    pub view: JobView,
    pub spec: Spec,
    pub left: Left,
    /// The window that started it — told of it when no tab of its shows.
    pub origin: String,
}

/// The jobs under way, the turn each session gives them (v1.35): the jobs of
/// one session run one at a time, in the order they were started — and the
/// interrupted ones kept to be gone on with (v1.36). No Tauri types: every
/// rule here is unit-tested.
#[derive(Default)]
pub struct Jobs {
    running: Mutex<HashMap<String, Entry>>,
    turns: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    held: Mutex<HashMap<String, Held>>,
    /// Sessions whose tab has closed: nothing is kept for them any more. A
    /// session id is a tab's, and a closed tab never comes back under it.
    closed: Mutex<HashSet<String>>,
}

impl Jobs {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn held(&self) -> MutexGuard<'_, HashMap<String, Held>> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn closed(&self) -> MutexGuard<'_, HashSet<String>> {
        self.closed.lock().unwrap_or_else(|e| e.into_inner())
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
                interrupted: false,
            },
        );
        true
    }

    /// Whether the job's session ended under it — as opposed to the user's stop.
    fn interrupted(&self, id: &str) -> bool {
        self.lock().get(id).is_some_and(|e| e.interrupted)
    }

    /// Keep an interrupted job. Refused — and handed back, for its partial
    /// copies to be cleaned up — when a tab it touches has closed meanwhile.
    pub fn hold(&self, held: Held) -> Result<(), Box<Held>> {
        let closed = self.closed();
        let gone = [&held.spec.src, &held.spec.dst]
            .iter()
            .filter_map(|side| side.session.as_deref())
            .any(|session| closed.contains(session));
        if gone {
            return Err(Box::new(held));
        }
        self.held().insert(held.view.id.clone(), held);
        Ok(())
    }

    /// Take a kept job out — to go on with it, or to drop it.
    pub fn take_held(&self, id: &str) -> Option<Held> {
        self.held().remove(id)
    }

    /// Every kept job, taken out: the app is quitting.
    pub fn take_all_held(&self) -> Vec<Held> {
        self.held().drain().map(|(_, held)| held).collect()
    }

    /// A tab has closed: the kept jobs that touch it go — handed back for their
    /// partial copies to be cleaned up — and none is kept for it from now on.
    pub fn close_session(&self, session_id: &str) -> Vec<Held> {
        let mut closed = self.closed();
        closed.insert(session_id.to_string());
        let mut held = self.held();
        let ids: Vec<String> = held
            .values()
            .filter(|h| h.view.touches(session_id))
            .map(|h| h.view.id.clone())
            .collect();
        ids.iter().filter_map(|id| held.remove(id)).collect()
    }

    fn put(&self, view: &JobView) {
        if let Some(entry) = self.lock().get_mut(&view.id) {
            entry.view = view.clone();
        }
    }

    fn remove(&self, id: &str) {
        self.lock().remove(id);
    }

    /// The jobs window `label` shows: those it would be told about now — the
    /// kept ones too.
    pub fn shown_in(&self, label: &str, owner_of: impl Fn(&str) -> Option<String>) -> Vec<JobView> {
        let shows = |view: &JobView, origin: &str| {
            audience(view, origin, &owner_of).iter().any(|l| l == label)
        };
        let mut shown: Vec<JobView> = self
            .lock()
            .values()
            .filter(|e| shows(&e.view, &e.origin))
            .map(|e| e.view.clone())
            .collect();
        shown.extend(
            self.held()
                .values()
                .filter(|h| shows(&h.view, &h.origin))
                .map(|h| h.view.clone()),
        );
        shown.sort_by(|a, b| a.id.cmp(&b.id));
        shown
    }

    /// The turn of `session`: held by the job of it that runs now.
    fn turn_of(&self, session: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut turns = self.turns.lock().unwrap_or_else(|e| e.into_inner());
        turns.entry(session.to_string()).or_default().clone()
    }

    /// Wait until every session `spec` touches is free, in the order jobs came:
    /// `Queued` is told while it waits. None — it was stopped before its turn.
    /// The sessions are taken in one order, so two jobs never hold one each.
    pub async fn wait_turn(
        &self,
        spec: &Spec,
        view: &mut JobView,
        cancel: &AtomicBool,
        tell: &(dyn Fn(&JobView, bool) + Send + Sync),
    ) -> Option<Vec<tokio::sync::OwnedMutexGuard<()>>> {
        let mut sessions: Vec<&str> = [&spec.src, &spec.dst]
            .iter()
            .filter_map(|side| side.session.as_deref())
            .collect();
        sessions.sort_unstable();
        sessions.dedup();
        let mut held = Vec::new();
        for session in sessions {
            let turn = self.turn_of(session);
            if let Ok(guard) = turn.clone().try_lock_owned() {
                held.push(guard);
                continue;
            }
            if view.state != State::Queued {
                view.state = State::Queued;
                tell(view, false);
            }
            // One future for the whole wait: a new one would lose its place.
            let wait = turn.lock_owned();
            tokio::pin!(wait);
            let guard = loop {
                tokio::select! {
                    guard = &mut wait => break guard,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                        if cancel.load(Ordering::Relaxed) {
                            return None;
                        }
                    }
                }
            };
            held.push(guard);
        }
        view.state = State::Running;
        Some(held)
    }

    /// A session is ending: stop every job that reads from it or writes to it.
    /// The job holds the session open until it notices, so it must be told. It
    /// ends cut off, not stopped (v1.36): kept to go on with — unless its tab
    /// has closed, and then what it staged is cleaned up by its own exit.
    pub fn cancel_session(&self, session_id: &str) -> usize {
        let mut jobs = self.lock();
        let mut hit = 0;
        for entry in jobs.values_mut().filter(|e| e.view.touches(session_id)) {
            entry.interrupted = true;
            entry.cancel.store(true, Ordering::Relaxed);
            hit += 1;
        }
        hit
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
                tokio::fs::create_dir_all(dir)
                    .await
                    .log_debug("transfer", "create the destination folder");
            }
            End::Remote(s) => {
                s.create_dir(dir)
                    .await
                    .log_debug("transfer", "create the destination folder");
            }
        }
    }

    fn is_local(&self) -> bool {
        matches!(self, End::Local)
    }

    /// Where a link points, as the link says it (not resolved).
    async fn read_link(&self, path: &str) -> AppResult<String> {
        match self {
            End::Local => Ok(tokio::fs::read_link(path)
                .await
                .map_err(|e| format!("readlink {path}: {e}"))?
                .to_string_lossy()
                .into_owned()),
            End::Remote(s) => Ok(s
                .read_link(path)
                .await
                .map_err(|e| format!("readlink {path}: {e}"))?),
        }
    }

    /// Whether this end can hold a link the source had. Windows makes one only
    /// with a privilege a user rarely has: a link is not offered there at all.
    fn takes_links(&self) -> bool {
        !(self.is_local() && cfg!(windows))
    }

    /// Make `link` a symlink to `target` — what the source's link said, word for
    /// word (v1.34). A name already there is replaced only when the item says so.
    async fn make_link(&self, target: &str, link: &str, replace: bool) -> AppResult<()> {
        if self.exists(link).await {
            if !replace {
                return Err(AppError::DestinationExists);
            }
            self.remove(link).await;
        }
        match self {
            End::Local => {
                #[cfg(unix)]
                {
                    tokio::fs::symlink(target, link)
                        .await
                        .map_err(|e| AppError::from(format!("symlink {link}: {e}")))
                }
                #[cfg(not(unix))]
                {
                    let _ = target;
                    Err(format!("symlink {link}: links are not made on this system").into())
                }
            }
            End::Remote(s) => sftp::make_symlink(s, target, link).await,
        }
    }

    /// Take a name off, file or link (not a folder): what a replaced link stands on.
    async fn remove(&self, path: &str) {
        match self {
            End::Local => {
                tokio::fs::remove_file(path)
                    .await
                    .log_debug("transfer", "remove the file");
            }
            End::Remote(s) => {
                s.remove_file(path)
                    .await
                    .log_debug("transfer", "remove the file");
            }
        }
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

#[derive(Debug, Clone)]
pub struct Planned {
    from: String,
    to: String,
    size: u64,
    replace: bool,
    /// A symlink inside a folder (v1.34): made again at `to` with this target,
    /// not followed — what it points to is not copied, and a link to a parent
    /// folder is not a cycle.
    link: Option<String>,
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

/// What an interrupted job had left to do (v1.36, ADR 0060).
#[derive(Debug, Clone)]
pub enum Left {
    /// It was cut off before its walk had seen everything — or before its
    /// turn: walked again, nothing having been written.
    Walk,
    /// The files that did not make it, each with its partial copy.
    Files(LeftFiles),
}

#[derive(Debug, Clone)]
pub struct LeftFiles {
    /// The folders, made again (they may well be there).
    dirs: Vec<String>,
    files: Vec<(Planned, Option<Partial>)>,
    /// The whole job's count and size: what its row counts against.
    file_count: u32,
    total: u64,
    skipped: u32,
}

impl LeftFiles {
    fn done_files(&self) -> u32 {
        self.file_count.saturating_sub(self.files.len() as u32)
    }

    fn done_bytes(&self) -> u64 {
        let left: u64 = self.files.iter().map(|(f, _)| f.size).sum();
        self.total.saturating_sub(left)
    }
}

impl Left {
    /// The partial copies it keeps on the destination.
    pub fn partials(&self) -> Vec<Partial> {
        match self {
            Left::Walk => Vec::new(),
            Left::Files(left) => left.files.iter().filter_map(|(_, p)| p.clone()).collect(),
        }
    }
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
                link: None,
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
                let to = child_path(dst.is_local(), &to_dir, &entry.name)?;
                // A link goes over as a link (v1.34): following one to a folder
                // risks a cycle, and its target is not part of the folder. Where
                // the destination cannot hold one, or it cannot be read, it is
                // left out and counted.
                if entry.is_symlink {
                    match (dst.takes_links(), src.read_link(&entry.path).await) {
                        (true, Ok(target)) => plan.files.push(Planned {
                            from: entry.path,
                            to,
                            size: 0,
                            replace: item.replace,
                            link: Some(target),
                        }),
                        _ => plan.skipped += 1,
                    }
                    continue;
                }
                if entry.is_dir {
                    stack.push((entry.path, to));
                } else {
                    plan.files.push(Planned {
                        from: entry.path,
                        to,
                        size: entry.size,
                        replace: item.replace,
                        link: None,
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
    keep: &Keep<'_>,
) -> AppResult<()> {
    let (from, to, replace, cancel) = (&file.from, &file.to, file.replace, Some(cancel));
    if let Some(target) = &file.link {
        return dst.make_link(target, to, replace).await;
    }
    let keep = Some(keep);
    match (src, dst) {
        (End::Local, End::Remote(d)) => {
            sftp::upload_staged(report, d, from, to, replace, cancel, keep).await
        }
        (End::Remote(s), End::Local) => {
            sftp::download_file(report, s, from, to, replace, cancel, keep).await
        }
        (End::Remote(s), End::Remote(d)) => {
            sftp::relay_staged(report, s, d, from, to, replace, cancel, keep).await
        }
        (End::Local, End::Local) => {
            localfile::copy_staged(report, from, to, replace, cancel, keep).await
        }
    }
}

/// Take a kept job's partial copies off its destination. Best effort: a server
/// gone with its connection keeps its temp.
pub async fn discard(dst: &End, left: &Left) {
    for partial in left.partials() {
        dst.remove(&partial.tmp).await;
    }
}

/// Carry a job out and return how it ended, and what it had left to do. `tell`
/// hears every change of the view; `true` marks a byte count inside a file —
/// the kind a listener may drop. One file failing does not stop the rest: the
/// job says how many did not make it, and why the first one did not.
///
/// `from` — the rest of an interrupted job (v1.36, ADR 0060): its files and none
/// other, each partial copy continued from its checkpoint, the row counting on
/// from where it stood. A file refused because its name was taken is not left:
/// going on would be refused again.
pub(crate) async fn carry_out_from(
    start: JobView,
    spec: &Spec,
    src: &End,
    dst: &End,
    cancel: &AtomicBool,
    tell: &(dyn Fn(&JobView, bool) + Send + Sync),
    from: Option<LeftFiles>,
) -> (JobView, Option<Left>) {
    let view = Mutex::new(start);
    let change = |minor: bool, apply: &dyn Fn(&mut JobView)| {
        let mut v = view.lock().unwrap_or_else(|e| e.into_inner());
        apply(&mut v);
        tell(&v, minor);
    };
    change(false, &|_| {});

    // What to do: the walk of what was asked for, or what an interrupted run left.
    let (planned, held, base, whole) = match from {
        Some(left) => {
            let base = (left.done_files(), left.done_bytes());
            let whole = (left.file_count, left.total);
            let (files, held): (Vec<Planned>, Vec<Option<Partial>>) =
                left.files.into_iter().unzip();
            let plan = Plan {
                dirs: left.dirs,
                files,
                skipped: left.skipped,
                ..Plan::default()
            };
            (Ok(plan), held, base, Some(whole))
        }
        None => (plan(spec, src, dst, cancel).await, Vec::new(), (0, 0), None),
    };
    // A walk that failed as a whole — a listed name that would leave the
    // destination — fails every item, with nothing written.
    let (mut failed, mut error) = match &planned {
        Err(e) => (spec.items.len() as u32, Some(e.to_string())),
        Ok(plan) => (plan.refused.len() as u32, plan.refused.first().cloned()),
    };
    let mut cancelled = false;
    let mut left: Option<Left> = None;
    if let Ok(plan) = planned {
        let Plan {
            dirs,
            files,
            skipped,
            cut,
            ..
        } = plan;
        // Stopped while the tree was being walked: what was found is not moved.
        cancelled = cut;
        let (count, total) =
            whole.unwrap_or((files.len() as u32, files.iter().map(|f| f.size).sum()));
        let (done_files, done_bytes) = base;
        change(false, &|v| {
            v.file_count = count;
            v.total = total;
            v.skipped = skipped;
            v.failed = failed;
            v.file_index = done_files;
            v.transferred = done_bytes;
        });
        if !cancelled {
            for dir in &dirs {
                dst.mkdir(dir).await;
            }
        }
        let mut held = held.into_iter();
        let mut rest: Vec<(Planned, Option<Partial>)> = Vec::new();
        let mut moved: u64 = done_bytes;
        for (index, file) in files.into_iter().enumerate() {
            let partial = held.next().flatten();
            if cancelled || cancel.load(Ordering::Relaxed) {
                cancelled = true;
                rest.push((file, partial));
                continue;
            }
            let at = done_files + index as u32;
            change(false, &|v| {
                v.name = base_name(&file.to);
                v.file_index = at;
                v.transferred = moved;
            });
            let before = moved;
            let within = |bytes: u64| {
                change(true, &|v| v.transferred = (before + bytes).min(total));
            };
            // Where the copy is known to stand, as it goes.
            let current = Mutex::new(partial.clone());
            let mark = |p: Partial| *current.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
            let keep = Keep {
                resume: partial,
                mark: &mark,
            };
            let ended = move_file(src, dst, &file, &Report::Job(&within), cancel, &keep).await;
            let partial = current.into_inner().unwrap_or_else(|e| e.into_inner());
            match ended {
                Ok(()) => {}
                Err(AppError::Cancelled) => {
                    cancelled = true;
                    rest.push((file, partial));
                    continue;
                }
                Err(e) => {
                    failed += 1;
                    error.get_or_insert(e.to_string());
                    if !matches!(e, AppError::DestinationExists) {
                        rest.push((file.clone(), partial));
                    }
                }
            }
            moved += file.size;
            change(false, &|v| {
                v.file_index = at + 1;
                v.transferred = moved;
                v.failed = failed;
            });
        }
        left = if cut {
            Some(Left::Walk)
        } else if rest.is_empty() {
            None
        } else {
            Some(Left::Files(LeftFiles {
                dirs,
                files: rest,
                file_count: count,
                total,
                skipped,
            }))
        };
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
    (done, left)
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
    if done.state == State::Interrupted {
        lines.push("interrupted: the session ended".to_string());
    }
    lines.join("\n")
}

fn audit_exit(done: &JobView) -> i32 {
    match done.state {
        State::Cancelled | State::Interrupted => 130,
        State::Failed => 1,
        State::Queued | State::Running | State::Done => 0,
    }
}

fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

// ── The job, as the app runs it ─────────────────────────────────────────────

pub(crate) fn send(app: &AppHandle, view: &JobView, origin: &str) {
    let windows = app.state::<crate::appwin::Windows>();
    for label in audience(view, origin, |session| windows.owner_of(session)) {
        app.emit_to(label.as_str(), EVENT, view)
            .log_debug("transfer", "tell a window about a transfer job");
    }
}

/// Run a registered job to its end: tell its windows as it goes, take it off
/// the registry, keep it if it was cut off with something left (v1.36), say the
/// last word, and write it into the recordings of the SSH sessions it touched.
/// Returns how it ended — for the one caller that has someone waiting on the
/// file (a promise made to the system, `dragout`). `resumed` — what an
/// interrupted run of it left ([`Left`]); None, a new job.
#[allow(clippy::too_many_arguments)] // a job, its two ends, and how it is run
pub async fn run(
    app: &AppHandle,
    spec: Spec,
    src: Party,
    dst: Party,
    cancel: Arc<AtomicBool>,
    origin: String,
    queued: bool,
    resumed: Option<Left>,
) -> JobView {
    let started = std::time::Instant::now();
    tracing::info!(
        source = "transfer",
        job = %spec.id,
        items = spec.items.len(),
        resumed = resumed.is_some(),
        "transfer started: {}",
        audit_op(&spec, true)
    );
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
    // Its turn first (v1.35) — except for a file promised to the system, which
    // is waited for right now (`dragout`). Held until the job ends.
    let mut start = JobView::start(&spec);
    let turn = if queued {
        app.state::<Jobs>()
            .wait_turn(&spec, &mut start, &cancel, &tell)
            .await
    } else {
        Some(Vec::new())
    };
    let from = match &resumed {
        Some(Left::Files(left)) => Some(left.clone()),
        _ => None,
    };
    let (mut done, left) = match turn {
        Some(_held) => carry_out_from(start, &spec, &src.end, &dst.end, &cancel, &tell, from).await,
        // Stopped while it waited: nothing was moved — what it had to do is
        // still all there.
        None => (
            JobView {
                state: State::Cancelled,
                ..start
            },
            Some(resumed.clone().unwrap_or(Left::Walk)),
        ),
    };
    let jobs = app.state::<Jobs>();
    if done.state == State::Cancelled && jobs.interrupted(&done.id) {
        done.state = State::Interrupted;
    }
    // Off the registry first: a window that asks for the list on hearing the
    // last word must not be handed a job that has ended.
    jobs.remove(&done.id);
    // Cut off with something left: kept to go on with — unless a tab of it has
    // closed. Stopped by the user, or not kept: its partial copies go.
    if let Some(left) = left {
        let keeps = matches!(done.state, State::Failed | State::Interrupted);
        done.resumable = keeps;
        let held = Held {
            view: done.clone(),
            spec: spec.clone(),
            left,
            origin: origin.clone(),
        };
        let refused = if keeps {
            jobs.hold(held).err()
        } else {
            Some(Box::new(held))
        };
        if let Some(held) = refused {
            done.resumable = false;
            discard(&dst.end, &held.left).await;
        }
    }
    send(app, &done, &origin);
    note_end(&spec, &done, started.elapsed().as_millis() as u64);

    let mut body = audit_body(&spec, &done);
    if resumed.is_some() {
        body.push_str(if body.is_empty() {
            "resumed"
        } else {
            "\nresumed"
        });
    }
    for (party, on_src) in [(&src, true), (&dst, false)] {
        if let Some(session) = &party.ssh {
            let line = sftp::sftp_mirror(&audit_op(&spec, on_src), audit_exit(&done), &body);
            session.record_output(line.as_bytes());
        }
    }
    done
}

/// How a job's end is written: a failure the user must look at is a warning,
/// a stop of theirs or a finished job information.
fn end_verdict(done: &JobView) -> (crate::diag::Level, &'static str) {
    use crate::diag::Level;
    match done.state {
        State::Done if done.failed == 0 => (Level::Info, "transfer done"),
        State::Done | State::Failed => (Level::Warn, "transfer ended with failed files"),
        State::Interrupted => (Level::Warn, "transfer cut off by its session"),
        State::Cancelled => (Level::Info, "transfer stopped"),
        State::Queued | State::Running => (Level::Warn, "transfer ended unfinished"),
    }
}

/// The end of a job, as the diagnostics keep it.
fn note_end(spec: &Spec, done: &JobView, ms: u64) {
    let (level, what) = end_verdict(done);
    let error = done.error.as_deref().unwrap_or("");
    match level {
        crate::diag::Level::Warn => tracing::warn!(
            source = "transfer",
            job = %spec.id,
            bytes = done.transferred,
            files = done.file_count,
            failed = done.failed,
            skipped = done.skipped,
            resumable = done.resumable,
            ms,
            "{what}: {error}"
        ),
        _ => tracing::info!(
            source = "transfer",
            job = %spec.id,
            bytes = done.transferred,
            files = done.file_count,
            skipped = done.skipped,
            ms,
            "{what}"
        ),
    }
}

/// A kept job is dropped: its partial copies are taken off its destination,
/// if that is still reachable — this machine, or a session still open.
pub async fn discard_held(app: &AppHandle, held: Held) {
    let dst = if held.spec.dst.local {
        Some(End::Local)
    } else {
        match held.spec.dst.session.as_deref() {
            Some(id) => match crate::session_arc_of(app, id).await {
                Ok(session) => session.sftp().await.ok().map(End::Remote),
                Err(_) => None,
            },
            None => None,
        }
    };
    if let Some(dst) = dst {
        discard(&dst, &held.left).await;
    }
}

/// A tab has closed (v1.36): the kept jobs that touch it go, and their partial
/// copies with them. Called before its session ends, while it can still reach
/// its server.
pub async fn forget_session(app: &AppHandle, session_id: &str) {
    let dropped = app.state::<Jobs>().close_session(session_id);
    for held in dropped {
        discard_held(app, held).await;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_jobs_end_is_a_warning_only_when_the_user_must_look() {
        use super::{end_verdict, JobView, State};
        use crate::diag::Level;
        let spec = super::Spec {
            id: "j1".into(),
            src: super::Side {
                session: None,
                local: true,
                label: String::new(),
            },
            dst: super::Side {
                session: Some("s".into()),
                local: false,
                label: String::new(),
            },
            items: Vec::new(),
            dest_dir: "/srv".into(),
        };
        let at = |state: State, failed: u32| JobView {
            state,
            failed,
            ..JobView::start(&spec)
        };
        assert_eq!(end_verdict(&at(State::Done, 0)).0, Level::Info);
        assert_eq!(end_verdict(&at(State::Done, 2)).0, Level::Warn);
        assert_eq!(end_verdict(&at(State::Failed, 1)).0, Level::Warn);
        assert_eq!(end_verdict(&at(State::Interrupted, 0)).0, Level::Warn);
        assert_eq!(end_verdict(&at(State::Cancelled, 0)).0, Level::Info);
        let (_, events) =
            crate::diag::capture(|| super::note_end(&spec, &at(State::Failed, 1), 1200));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].source.as_deref(), Some("transfer"));
        assert_eq!(events[0].fields["failed"], 1);
        assert_eq!(events[0].fields["ms"], 1200);
    }

    use super::*;

    /// A job carried out as `run` ends it: stopped by the user, it leaves no
    /// partial copy behind.
    pub(super) async fn carry_out(
        start: JobView,
        spec: &Spec,
        src: &End,
        dst: &End,
        cancel: &AtomicBool,
        tell: &(dyn Fn(&JobView, bool) + Send + Sync),
    ) -> JobView {
        let (done, left) = carry_out_from(start, spec, src, dst, cancel, tell, None).await;
        if let Some(left) = &left {
            if done.state == State::Cancelled {
                discard(dst, left).await;
            }
        }
        done
    }

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

    /// A job's turn (v1.35): one job of a session at a time, in the order they came.
    #[tokio::test]
    async fn the_jobs_of_one_session_take_turns() {
        let jobs = Jobs::default();
        let told = Mutex::new(Vec::new());
        let tell = |v: &JobView, _minor: bool| told.lock().unwrap().push((v.id.clone(), v.state));
        let up = |id: &str, session: &str| {
            spec(
                id,
                disk(),
                remote(session, "web"),
                vec![item("/a", "/b", false, false)],
                "/",
            )
        };
        let first = up("j1", "s1");
        let mut first_view = JobView::start(&first);
        let held = jobs
            .wait_turn(&first, &mut first_view, &AtomicBool::new(false), &tell)
            .await
            .expect("the first job runs at once");
        assert_eq!(first_view.state, State::Running);
        assert!(
            told.lock().unwrap().is_empty(),
            "nothing to wait for, nothing told"
        );

        // Another session's job does not wait for it.
        let other = up("j2", "s2");
        let mut other_view = JobView::start(&other);
        let other_held = jobs
            .wait_turn(&other, &mut other_view, &AtomicBool::new(false), &tell)
            .await;
        assert!(other_held.is_some());

        // The same session's next job waits, says so, and runs when the first ends.
        let second = up("j3", "s1");
        let waiting = async {
            let mut v = JobView::start(&second);
            let turn = jobs
                .wait_turn(&second, &mut v, &AtomicBool::new(false), &tell)
                .await;
            (v.state, turn.is_some())
        };
        let release = async {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            assert_eq!(
                told.lock().unwrap().as_slice(),
                &[("j3".to_string(), State::Queued)]
            );
            drop(held);
        };
        let ((state, ran), ()) = tokio::join!(waiting, release);
        assert_eq!(state, State::Running);
        assert!(ran);
    }

    #[tokio::test]
    async fn a_job_stopped_while_queued_never_runs() {
        let jobs = Jobs::default();
        let tell = |_: &JobView, _: bool| {};
        let up = |id: &str| {
            spec(
                id,
                remote("s1", "web"),
                disk(),
                vec![item("/a", "/b", false, false)],
                "/",
            )
        };
        let first = up("j1");
        let mut v1 = JobView::start(&first);
        let _held = jobs
            .wait_turn(&first, &mut v1, &AtomicBool::new(false), &tell)
            .await;
        let second = up("j2");
        let mut v2 = JobView::start(&second);
        let cancel = AtomicBool::new(false);
        let stop = async {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            cancel.store(true, Ordering::Relaxed);
        };
        let (turn, ()) = tokio::join!(jobs.wait_turn(&second, &mut v2, &cancel, &tell), stop);
        assert!(turn.is_none());
        assert_eq!(v2.state, State::Queued);
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
    async fn links_go_over_as_links_and_a_link_up_the_tree_is_not_walked() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        std::fs::create_dir_all(src.join("d")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("d/real"), b"r").unwrap();
        // A relative link stays relative: it points where it pointed, next to it.
        std::os::unix::fs::symlink("real", src.join("d/link")).unwrap();
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
        assert_eq!(done.skipped, 0);
        assert_eq!(done.file_count, 3);
        assert_eq!(std::fs::read(dst.join("d/real")).unwrap(), b"r");
        assert_eq!(
            std::fs::read_link(dst.join("d/link")).unwrap(),
            Path::new("real")
        );
        assert_eq!(std::fs::read(dst.join("d/link")).unwrap(), b"r");
        // The loop is a link to the source again — not a copy of the whole tree.
        assert_eq!(std::fs::read_link(dst.join("d/loop")).unwrap(), src);
        assert!(std::fs::symlink_metadata(dst.join("d/loop"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_link_already_at_the_destination_is_replaced_only_when_told_to() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        std::fs::create_dir_all(src.join("d")).unwrap();
        std::fs::create_dir_all(dst.join("d")).unwrap();
        std::os::unix::fs::symlink("new", src.join("d/link")).unwrap();
        std::os::unix::fs::symlink("old", dst.join("d/link")).unwrap();
        let job = |replace: bool| {
            spec(
                "j",
                disk(),
                disk(),
                vec![item(&path(&src, "d"), &path(&dst, "d"), true, replace)],
                &path(&dst, ""),
            )
        };
        // Not told to: the folder itself is already there, nothing is touched.
        let kept = local_job(&job(false), &AtomicBool::new(false), &Heard::default()).await;
        assert_eq!(kept.failed, 1);
        assert_eq!(
            std::fs::read_link(dst.join("d/link")).unwrap(),
            Path::new("old")
        );
        let done = local_job(&job(true), &AtomicBool::new(false), &Heard::default()).await;
        assert_eq!(done.state, State::Done, "{:?}", done.error);
        assert_eq!(
            std::fs::read_link(dst.join("d/link")).unwrap(),
            Path::new("new")
        );
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

    // ── Going on with an interrupted job (v1.36, ADR 0060) ────────────────

    const MIB: usize = 1024 * 1024;

    /// A file whose every byte says where it is — a copy started over, or one
    /// stitched at the wrong place, does not come out equal.
    fn patterned(len: usize, xor_mask: u8) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8 ^ xor_mask).collect()
    }

    fn temps(dir: &Path) -> Vec<String> {
        walk(dir)
            .into_iter()
            .filter(|p| p.contains(".vterm-tmp-"))
            .collect()
    }

    /// `a` (small), `big` (20 MiB), `c` — cut off inside `big`, past its first
    /// checkpoint. Returns the job, its folders and what it left.
    async fn cut_inside_big(
        tmp: &Path,
    ) -> (Spec, std::path::PathBuf, std::path::PathBuf, LeftFiles) {
        let (src, dst) = (tmp.join("src"), tmp.join("dst"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("a"), b"alpha").unwrap();
        std::fs::write(src.join("big"), patterned(20 * MIB, 0)).unwrap();
        std::fs::write(src.join("c"), b"gamma").unwrap();
        let items = ["a", "big", "c"]
            .iter()
            .map(|n| item(&path(&src, n), &path(&dst, n), false, false))
            .collect();
        let job = spec("j", disk(), disk(), items, &path(&dst, ""));
        let cancel = AtomicBool::new(false);
        // The connection "drops" 9 MiB into `big`: one checkpoint behind it.
        let tell = |view: &JobView, _minor: bool| {
            if view.name == "big" && view.transferred >= 5 + 9 * MIB as u64 {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        let (done, left) = carry_out_from(
            JobView::start(&job),
            &job,
            &End::Local,
            &End::Local,
            &cancel,
            &tell,
            None,
        )
        .await;
        assert_eq!(done.state, State::Cancelled);
        let Some(Left::Files(left)) = left else {
            panic!("a job cut off inside a file leaves what it had to do: {left:?}");
        };
        (job, src, dst, left)
    }

    #[tokio::test]
    async fn an_interrupted_job_keeps_what_it_left_and_the_partial_copy_at_its_checkpoint() {
        let tmp = tempfile::tempdir().unwrap();
        let (_job, src, dst, left) = cut_inside_big(tmp.path()).await;
        assert_eq!(std::fs::read(dst.join("a")).unwrap(), b"alpha");
        assert!(!dst.join("big").exists() && !dst.join("c").exists());
        // What was left: `big` with its partial copy, and `c` not begun.
        let names: Vec<(String, Option<u64>)> = left
            .files
            .iter()
            .map(|(f, p)| (base_name(&f.to), p.as_ref().map(|p| p.at)))
            .collect();
        assert_eq!(
            names,
            [
                ("big".to_string(), Some(crate::partial::CHECKPOINT_STEP)),
                ("c".to_string(), None)
            ]
        );
        assert_eq!((left.done_files(), left.done_bytes()), (1, 5));
        // The partial copy is there, holding at least its checkpoint.
        let partial = left.files[0].1.clone().unwrap();
        let held = std::fs::metadata(&partial.tmp).unwrap().len();
        assert!(held >= partial.at, "{held} < {}", partial.at);
        assert_eq!(partial.source.size, 20 * MIB as u64);
        assert_eq!(temps(&dst), std::slice::from_ref(&partial.tmp));
        // Stopped by the user instead, nothing is left behind (`run` drops it).
        discard(&End::Local, &Left::Files(left)).await;
        assert!(temps(&dst).is_empty());
        drop(src);
    }

    #[tokio::test]
    async fn going_on_copies_what_was_left_and_the_cut_file_from_its_checkpoint() {
        let tmp = tempfile::tempdir().unwrap();
        let (job, src, dst, left) = cut_inside_big(tmp.path()).await;
        let partial = left.files[0].1.clone().unwrap();
        // Mark a byte before the checkpoint: a copy that went on from there
        // leaves it as it is; one started over would write it back.
        let mut bytes = std::fs::read(&partial.tmp).unwrap();
        bytes[0] ^= 0xff;
        std::fs::write(&partial.tmp, &bytes).unwrap();
        let heard = Heard::default();
        let tell = |view: &JobView, minor: bool| heard.lock().unwrap().push((view.clone(), minor));
        let (done, rest) = carry_out_from(
            JobView::start(&job),
            &job,
            &End::Local,
            &End::Local,
            &AtomicBool::new(false),
            &tell,
            Some(left),
        )
        .await;
        assert_eq!(done.state, State::Done, "{:?}", done.error);
        assert!(rest.is_none());
        let copied = std::fs::read(dst.join("big")).unwrap();
        let source = std::fs::read(src.join("big")).unwrap();
        assert_eq!(copied.len(), source.len());
        assert_eq!(
            copied[0],
            source[0] ^ 0xff,
            "the bytes before the checkpoint are not copied again"
        );
        assert_eq!(copied[1..], source[1..]);
        assert_eq!(std::fs::read(dst.join("c")).unwrap(), b"gamma");
        assert!(temps(&dst).is_empty());
        // The row counts on from where it stood: the whole job, the file done,
        // and `big` from its checkpoint.
        let heard = heard.lock().unwrap();
        assert_eq!((heard[1].0.file_count, heard[1].0.file_index), (3, 1));
        assert_eq!(done.total, 5 + 20 * MIB as u64 + 5);
        assert!(heard
            .iter()
            .filter(|(v, minor)| *minor && v.name == "big")
            .all(|(v, _)| v.transferred >= 5 + crate::partial::CHECKPOINT_STEP));
        assert_eq!((done.file_index, done.transferred), (3, done.total));
    }

    #[tokio::test]
    async fn a_partial_copy_of_a_source_that_changed_is_copied_again() {
        let tmp = tempfile::tempdir().unwrap();
        let (job, src, dst, left) = cut_inside_big(tmp.path()).await;
        let partial = left.files[0].1.clone().unwrap();
        let mut bytes = std::fs::read(&partial.tmp).unwrap();
        bytes[0] ^= 0xff;
        std::fs::write(&partial.tmp, &bytes).unwrap();
        // The source is rewritten meanwhile — same size, a later time.
        let changed = patterned(20 * MIB, 7);
        std::fs::write(src.join("big"), &changed).unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(src.join("big"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        let (done, _) = carry_out_from(
            JobView::start(&job),
            &job,
            &End::Local,
            &End::Local,
            &AtomicBool::new(false),
            &|_, _| {},
            Some(left),
        )
        .await;
        assert_eq!(done.state, State::Done, "{:?}", done.error);
        assert_eq!(std::fs::read(dst.join("big")).unwrap(), changed);
        assert!(temps(&dst).is_empty());
    }

    #[tokio::test]
    async fn a_file_that_failed_is_left_and_a_name_taken_meanwhile_is_not() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("ok"), b"1").unwrap();
        std::fs::write(src.join("taken"), b"2").unwrap();
        std::fs::write(dst.join("taken"), b"theirs").unwrap();
        let items = vec![
            item(&path(&src, "gone"), &path(&dst, "gone"), false, false),
            item(&path(&src, "taken"), &path(&dst, "taken"), false, false),
            item(&path(&src, "ok"), &path(&dst, "ok"), false, false),
        ];
        let job = spec("j", disk(), disk(), items, &path(&dst, ""));
        let (done, left) = carry_out_from(
            JobView::start(&job),
            &job,
            &End::Local,
            &End::Local,
            &AtomicBool::new(false),
            &|_, _| {},
            None,
        )
        .await;
        assert_eq!((done.state, done.failed), (State::Failed, 2));
        let Some(Left::Files(left)) = left else {
            panic!("a failed file is left to go on with");
        };
        let names: Vec<String> = left.files.iter().map(|(f, _)| base_name(&f.to)).collect();
        assert_eq!(names, ["gone"], "a refusal would be refused again");
    }

    #[test]
    fn a_kept_job_is_shown_where_its_tab_is_and_goes_with_its_closed_tab() {
        let jobs = Jobs::default();
        let job = spec(
            "j",
            disk(),
            remote("s1", "web"),
            vec![item("/a", "/b", false, false)],
            "/",
        );
        let kept = |id: &str| Held {
            view: JobView {
                resumable: true,
                state: State::Interrupted,
                ..JobView::start(&spec(id, disk(), remote("s1", "web"), vec![], "/"))
            },
            spec: job.clone(),
            left: Left::Walk,
            origin: "main".into(),
        };
        assert!(jobs.hold(kept("j")).is_ok());
        let owner = |s: &str| (s == "s1").then(|| "win-1".to_string());
        assert_eq!(jobs.shown_in("win-1", owner).len(), 1);
        assert!(jobs.shown_in("main", owner).is_empty());
        // Taken out to go on with, put back when that was refused.
        let back = jobs.take_held("j").unwrap();
        assert!(jobs.take_held("j").is_none());
        assert!(jobs.hold(back).is_ok());
        // Its tab closes: it goes, and nothing is kept for that tab any more.
        let gone = jobs.close_session("s1");
        assert_eq!(gone.len(), 1);
        assert!(jobs.shown_in("win-1", owner).is_empty());
        assert!(jobs.hold(kept("k")).is_err());
        // Quitting takes whatever is kept.
        assert!(jobs.take_all_held().is_empty());
    }

    #[test]
    fn a_job_whose_session_ends_under_it_is_cut_off_not_stopped() {
        let jobs = Jobs::default();
        let up = spec(
            "j",
            disk(),
            remote("s1", "web"),
            vec![item("/a", "/b", false, false)],
            "/",
        );
        let stop = Arc::new(AtomicBool::new(false));
        assert!(jobs.add(JobView::start(&up), stop.clone(), "main"));
        assert!(!jobs.interrupted("j"));
        assert_eq!(jobs.cancel_session("s1"), 1);
        assert!(stop.load(Ordering::Relaxed));
        assert!(jobs.interrupted("j"));
        let mut done = JobView::start(&up);
        done.state = State::Interrupted;
        assert_eq!(audit_exit(&done), 130);
        assert!(audit_body(&up, &done).ends_with("interrupted: the session ended"));
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
    use super::tests::carry_out;
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
            if let Err(e) = sftp::remove(&a, dir, true).await {
                eprintln!("cleanup: {e}");
            }
        }
    }

    /// A copy between two servers cut off mid-file goes on from its checkpoint
    /// (v1.36, ADR 0060): the client pipelines its writes, so this is where a
    /// point told too early would leave a hole — and where the reader and the
    /// writer are opened at an offset on a real `sftp-server`.
    #[tokio::test]
    #[ignore = "needs e2e/docker-compose.ssh.yml up -d"]
    async fn a_copy_between_servers_cut_off_mid_file_goes_on_from_its_checkpoint() {
        let (a, b) = (Arc::new(connect().await), Arc::new(connect().await));
        let from = path_for("resume-src");
        let to = path_for("resume-dst");
        let size = 20 * 1024 * 1024;
        let source: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        seed(&a, &from, &source).await;
        let job = Spec {
            id: "j".into(),
            src: remote("a", "web"),
            dst: remote("b", "db"),
            items: vec![Item {
                from: from.clone(),
                to: to.clone(),
                is_dir: false,
                replace: false,
            }],
            dest_dir: DIR.to_string(),
        };
        let (src, dst) = (End::Remote(a.clone()), End::Remote(b.clone()));
        let cancel = AtomicBool::new(false);
        let cut = |view: &JobView, _minor: bool| {
            if view.transferred >= 9 * 1024 * 1024 {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        let (_, left) =
            carry_out_from(JobView::start(&job), &job, &src, &dst, &cancel, &cut, None).await;
        let Some(Left::Files(left)) = left else {
            panic!("cut off mid-file, the job leaves the file: {left:?}");
        };
        let partial = left.files[0].1.clone().expect("a partial copy");
        assert_eq!(partial.at, crate::partial::CHECKPOINT_STEP);
        let mut staged = b.read(partial.tmp.clone()).await.expect("the temp is kept");
        assert!(staged.len() as u64 >= partial.at);
        assert_eq!(staged[..partial.at as usize], source[..partial.at as usize]);
        // Mark a byte before the checkpoint: going on leaves it as it is.
        staged[0] ^= 0xff;
        seed(&b, &partial.tmp, &staged).await;

        let (done, rest) = carry_out_from(
            JobView::start(&job),
            &job,
            &src,
            &dst,
            &AtomicBool::new(false),
            &|_, _| {},
            Some(left),
        )
        .await;
        assert_eq!(done.state, State::Done, "{:?}", done.error);
        assert!(rest.is_none());
        let copied = b.read(to.clone()).await.expect("read");
        assert_eq!(copied.len(), source.len());
        assert_eq!(copied[0], source[0] ^ 0xff);
        assert_eq!(copied[1..], source[1..]);
        assert!(
            b.metadata(partial.tmp.clone()).await.is_err(),
            "the temp became the file"
        );
        for path in [&from, &to] {
            if let Err(e) = a.remove_file(path.clone()).await {
                eprintln!("cleanup: {e}");
            }
        }
    }

    /// A link inside a folder is made again on the other server as the same link
    /// (v1.34) — the order OpenSSH reads `SSH_FXP_SYMLINK` in is what this checks
    /// — and a new file there takes the source's permission bits.
    #[tokio::test]
    #[ignore = "needs e2e/docker-compose.ssh.yml up -d"]
    async fn a_link_goes_over_as_a_link_and_a_new_file_keeps_its_mode() {
        let (a, b) = (Arc::new(connect().await), Arc::new(connect().await));
        let from = path_for("link-src").replace(".conf", "");
        let to = path_for("link-dst").replace(".conf", "");
        a.create_dir(from.clone()).await.expect("mkdir");
        seed(&a, &format!("{from}/key"), b"secret\n").await;
        a.set_metadata(format!("{from}/key"), sftp::chmod_attrs(0o100_600))
            .await
            .expect("chmod");
        sftp::make_symlink(&a, "key", &format!("{from}/key.link"))
            .await
            .expect("a link on the source");
        assert_eq!(
            a.read_link(format!("{from}/key.link"))
                .await
                .expect("readlink"),
            "key"
        );

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
        assert_eq!((done.file_count, done.skipped), (2, 0));
        assert_eq!(
            b.read_link(format!("{to}/key.link"))
                .await
                .expect("readlink"),
            "key"
        );
        assert_eq!(
            b.read(format!("{to}/key.link"))
                .await
                .expect("through the link"),
            b"secret\n"
        );
        let mode = b
            .metadata(format!("{to}/key"))
            .await
            .expect("stat")
            .permissions;
        assert_eq!(mode.map(|m| m & 0o777), Some(0o600));

        for dir in [&from, &to] {
            if let Err(e) = sftp::remove(&a, dir, true).await {
                eprintln!("cleanup: {e}");
            }
        }
    }
}
