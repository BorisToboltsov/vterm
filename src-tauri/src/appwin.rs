//! Application windows (ADR 0017).
//!
//! A tab can be moved out into a window of its own. A window is a separate
//! WebView with its own memory, so everything windows have to agree on lives
//! here, in the backend:
//!
//! - **who owns a session** — the window that shows its tab. Only the owner may
//!   end it, and a destroyed window's sessions are ended for it: a closed WebView
//!   never runs its teardown;
//! - **the close confirmation**, armed per window once its frontend can answer;
//! - **the handoff** of a tab: the packet with its state waits here for the
//!   window taking it — a new one, or one already open (ADR 0018) — and the
//!   session's output is held ([`crate::outgate`]) until that window says it has
//!   taken over;
//! - **which windows take tabs**: each announces itself once its frontend can
//!   answer an offer, and the others list it as a place to move a tab to;
//! - **a tab dragged between windows**: the window it is over hears nothing of
//!   the drag, so it is told here — and brought to the front; over none of the
//!   app's windows the tab is drawn by a window of its own ([`crate::dragghost`]);
//! - **what each window would lose** on quit, so the main window's confirmation
//!   lists the whole application.
//!
//! [`Registry`] is the bookkeeping — plain data, tested without a Tauri runtime.
//! The commands below wire it to real windows.

use crate::diag::{Logged, Unheard};
use crate::error::{AppError, AppResult};
use crate::outgate::HandOverError;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

/// Label of the window the app starts with. Closing it quits the app.
pub const MAIN: &str = "main";
/// Labels of windows a tab was moved out to: `win-2`, `win-3`, …
const SECONDARY_PREFIX: &str = "win-";

/// How long a window has to take the tab over before the handoff is rolled
/// back. Generous: a cold WebView start on a slow disk takes seconds.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(15);

/// Tells a window that is already open that a tab waits for it (`take_handoff`).
const HANDOFF_EVENT: &str = "window://handoff";
/// The windows that take tabs changed; the payload is the whole list.
const ROSTER_EVENT: &str = "window://windows";
/// A tab of another window is held over this one, was let go of here, or left.
const DRAG_EVENT: &str = "window://drag";

/// Size of a new window when the source window cannot be measured.
const FALLBACK_SIZE: (f64, f64) = (1100.0, 720.0);
/// The narrowest a window can be: both side docks at their minimum and the
/// centre at its own (`WINDOW_MIN_WIDTH` in docklayout.ts, and `minWidth` of the
/// main window in tauri.conf.json — `windowmin.guard` keeps the three equal).
/// No minimum height: only the width squeezed the terminal between the docks.
const WINDOW_MIN_WIDTH: f64 = 640.0;
/// Offset of a new window from the one it came from (menu / palette command).
const CASCADE: f64 = 32.0;
/// A window dropped at the pointer keeps its tab strip under it.
const DROP_GRIP: (f64, f64) = (80.0, 16.0);

/// Which window a native menu command is for: the one that last had the focus
/// while it still exists, the main window otherwise.
fn menu_target(focused: Option<String>, exists: impl Fn(&str) -> bool) -> String {
    match focused {
        Some(label) if exists(&label) => label,
        _ => MAIN.to_string(),
    }
}

/// One row of "what closing this window would cut off" (mirror of `QuitRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryRow {
    pub key: String,
    pub count: u32,
}

/// A window that takes tabs, as the others list it (mirror of `WindowEntry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WindowEntry {
    pub label: String,
    /// Title of the tab its focused pane shows — what tells windows apart.
    pub title: String,
    /// Tabs open in it.
    pub tabs: u32,
}

/// Position of a window in every list of them: the main one, then the others in
/// the order they were opened.
fn window_order(label: &str) -> (u32, &str) {
    let number = if label == MAIN {
        1
    } else {
        label
            .strip_prefix(SECONDARY_PREFIX)
            .and_then(|n| n.parse().ok())
            .unwrap_or(u32::MAX)
    };
    (number, label)
}

/// How a handoff ended for the window waiting on it.
type HandoffResult = Result<(), HandoffFailure>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffFailure {
    /// The other window never took the tab (did not load, was closed, was busy
    /// with another one, timed out).
    NotTaken,
    /// The terminal printed more than a handoff may hold.
    Overflowed,
}

impl From<HandoffFailure> for AppError {
    fn from(f: HandoffFailure) -> Self {
        match f {
            HandoffFailure::NotTaken => AppError::HandoffNotTaken,
            HandoffFailure::Overflowed => AppError::HandoffOverflowed,
        }
    }
}

/// A tab on its way to another window.
struct Pending {
    session_id: String,
    /// The tab's state, opaque to the backend. Holds the tab's typed password and
    /// editors' sudo passwords, hence wiped on drop and handed out exactly once.
    packet: Option<Zeroizing<String>>,
    /// Wakes the source window's `detach_commit`.
    done: oneshot::Sender<HandoffResult>,
}

/// What windows agree on. No Tauri types: every rule here is unit-tested.
#[derive(Default)]
struct Registry {
    /// session id → label of the window showing its tab.
    owners: HashMap<String, String>,
    /// Windows whose close asks first (their frontend listens for the question).
    armed: HashSet<String>,
    /// The window that last had the focus — native menu commands go to it.
    focused: Option<String>,
    /// What each secondary window would lose if the app quit now.
    summaries: HashMap<String, Vec<SummaryRow>>,
    /// Handoffs in progress, by the label of the window that will take the tab.
    pending: HashMap<String, Pending>,
    /// Windows that take tabs — each announced itself once its frontend listens
    /// for an offer — with what the others show of them: (title, tabs).
    roster: HashMap<String, (String, u32)>,
    /// The sessions each window offers as a place to copy files to, as its
    /// frontend described them (v1.13). Passed on to the other windows as it is.
    copy_targets: HashMap<String, serde_json::Value>,
    /// Labels of windows that are gone. A label is never given out twice, so
    /// whatever still arrives under one of these is a closed window's last word.
    gone: HashSet<String>,
    /// A tab being dragged out of one window (first) is held over another
    /// (second), which draws it. There is one pointer, so one such pair.
    hover: Option<(String, String)>,
    /// The window a drag last brought to the front — so that it is done once
    /// per visit, not on every move over it.
    raised: Option<String>,
    /// Number of the last secondary window opened.
    seq: u32,
    /// The tabs of the previous launch each reopened window brings back (v1.36,
    /// ADR 0057), as the main window read them — handed out once, like a packet.
    restoring: HashMap<String, String>,
}

impl Registry {
    fn next_label(&mut self) -> String {
        // The main window is the first; secondary ones count from two.
        self.seq = self.seq.max(1) + 1;
        format!("{SECONDARY_PREFIX}{}", self.seq)
    }

    /// `label` shows the tab of `session_id` from now on.
    fn claim(&mut self, session_id: &str, label: &str) {
        self.owners
            .insert(session_id.to_string(), label.to_string());
    }

    fn owns(&self, session_id: &str, label: &str) -> bool {
        self.owners.get(session_id).is_some_and(|o| o == label)
    }

    /// Let go of a session `label` is ending. False — and nothing changes —
    /// when another window owns it: a window that gave a tab away must not be
    /// able to end the session behind the new owner's back.
    fn release(&mut self, session_id: &str, label: &str) -> bool {
        match self.owners.get(session_id) {
            Some(owner) if owner != label => false,
            _ => {
                self.owners.remove(session_id);
                true
            }
        }
    }

    /// Rows of every window but `label`, concatenated (the frontend sums them).
    fn other_summaries(&self, label: &str) -> Vec<SummaryRow> {
        let mut labels: Vec<&String> = self.summaries.keys().filter(|l| *l != label).collect();
        labels.sort();
        labels
            .into_iter()
            .flat_map(|l| self.summaries[l].iter().cloned())
            .collect()
    }

    /// `label` takes tabs, and shows this now. Not a window that is gone: a
    /// closing window's last announcement can arrive after it was forgotten, and
    /// the others would be offered a window that no longer exists — for good.
    fn announce(&mut self, label: &str, title: String, tabs: u32) {
        if !self.gone.contains(label) {
            self.roster.insert(label.to_string(), (title, tabs));
        }
    }

    /// `label` offers these sessions to copy files to. Not a window that is
    /// gone — as with [`Registry::announce`], its last word may come late.
    fn share_targets(&mut self, label: &str, targets: serde_json::Value) {
        if !self.gone.contains(label) {
            self.copy_targets.insert(label.to_string(), targets);
        }
    }

    /// What every window offers, in [`window_order`].
    fn shared_targets(&self) -> Vec<SharedTargets> {
        let mut list: Vec<SharedTargets> = self
            .copy_targets
            .iter()
            .map(|(label, targets)| SharedTargets {
                window: label.clone(),
                targets: targets.clone(),
            })
            .collect();
        list.sort_by(|a, b| window_order(&a.window).cmp(&window_order(&b.window)));
        list
    }

    /// The windows that take tabs, in [`window_order`].
    fn roster(&self) -> Vec<WindowEntry> {
        let mut list: Vec<WindowEntry> = self
            .roster
            .iter()
            .map(|(label, (title, tabs))| WindowEntry {
                label: label.clone(),
                title: title.clone(),
                tabs: *tabs,
            })
            .collect();
        list.sort_by(|a, b| window_order(&a.label).cmp(&window_order(&b.label)));
        list
    }

    /// Whether `source` may hand a tab to the open window `target` right now:
    /// another window, one that answers offers, and not in the middle of taking
    /// a tab already (a handoff is kept by its target's label — one at a time).
    fn takes_tabs(&self, target: &str, source: &str) -> bool {
        target != source && self.roster.contains_key(target) && !self.pending.contains_key(target)
    }

    /// The drag is over the window `label`. True when that window has to be
    /// brought to the front — it is not the one brought there last.
    fn raise(&mut self, label: &str) -> bool {
        if self.raised.as_deref() == Some(label) {
            return false;
        }
        self.raised = Some(label.to_string());
        true
    }

    /// The tab `source` drags is over `target` now — or over none of the app's
    /// windows. Returns the window that has to be told the tab left it: the one
    /// it was over, when that is no longer where it is.
    fn hover(&mut self, source: &str, target: Option<&str>) -> Option<String> {
        let next = target.map(|t| (source.to_string(), t.to_string()));
        let was = std::mem::replace(&mut self.hover, next);
        was.map(|(_, over)| over)
            .filter(|over| Some(over.as_str()) != target)
    }

    /// `source` no longer drags a tab over another window. Returns the window
    /// that drew it, to be told. Nothing — and nothing changes — when the tab
    /// held over a window is somebody else's.
    fn end_hover(&mut self, source: &str) -> Option<String> {
        match &self.hover {
            Some((from, _)) if from == source => self.hover.take().map(|(_, over)| over),
            _ => None,
        }
    }

    /// The tab held over `target` arrived there: nobody is told anything.
    fn landed(&mut self, target: &str) {
        if self.hover.as_ref().is_some_and(|(_, over)| over == target) {
            self.hover = None;
        }
    }

    /// Take the handoff addressed to `label`, if it carries `session_id`.
    fn take_pending(&mut self, label: &str, session_id: &str) -> Option<Pending> {
        if self.pending.get(label)?.session_id != session_id {
            return None;
        }
        self.pending.remove(label)
    }

    /// A window is gone, and with it the drag it was part of. Returns the window
    /// still drawing a tab the gone one was dragging, to be told.
    fn hover_gone(&mut self, label: &str) -> Option<String> {
        let (from, over) = self.hover.take()?;
        if over == label {
            return None;
        }
        if from == label {
            return Some(over);
        }
        self.hover = Some((from, over));
        None
    }

    /// A window is gone. Returns the sessions it owned (to end them) and, if it
    /// was the target of a handoff, the waker of the window still waiting on it.
    fn forget_window(
        &mut self,
        label: &str,
    ) -> (Vec<String>, Option<oneshot::Sender<HandoffResult>>) {
        self.armed.remove(label);
        self.summaries.remove(label);
        self.roster.remove(label);
        self.copy_targets.remove(label);
        self.gone.insert(label.to_string());
        if self.focused.as_deref() == Some(label) {
            self.focused = None;
        }
        let mut sessions: Vec<String> = self
            .owners
            .iter()
            .filter(|(_, owner)| *owner == label)
            .map(|(id, _)| id.clone())
            .collect();
        sessions.sort();
        for id in &sessions {
            self.owners.remove(id);
        }
        let waker = self.pending.remove(label).map(|p| p.done);
        self.restoring.remove(label);
        (sessions, waker)
    }

    /// Open window `label` again — one of the previous launch, reopened with
    /// its tabs: it holds `record` until it asks for it, and a window opened
    /// later is numbered after it. False when `label` is not one to reopen or
    /// was given out in this launch already.
    fn reopening(&mut self, label: &str, record: String) -> bool {
        let Some(n) = label
            .strip_prefix(SECONDARY_PREFIX)
            .filter(|_| crate::winplace::kept_label(label))
            .and_then(|n| n.parse::<u32>().ok())
        else {
            return false;
        };
        if self.gone.contains(label) || self.restoring.contains_key(label) {
            return false;
        }
        self.seq = self.seq.max(n);
        self.restoring.insert(label.to_string(), record);
        true
    }
}

/// The registry as Tauri-managed state.
#[derive(Default)]
pub struct Windows(Mutex<Registry>);

impl Windows {
    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `label` shows the tab of `session_id` (it is connecting it).
    pub fn claim(&self, session_id: &str, label: &str) {
        self.lock().claim(session_id, label);
    }

    pub fn owns(&self, session_id: &str, label: &str) -> bool {
        self.lock().owns(session_id, label)
    }

    /// The window showing the tab of `session_id` right now, if any — where
    /// what happens to that session is to be told (a transfer's progress).
    pub fn owner_of(&self, session_id: &str) -> Option<String> {
        self.lock().owners.get(session_id).cloned()
    }

    /// See [`Registry::release`].
    pub fn release(&self, session_id: &str, label: &str) -> bool {
        self.lock().release(session_id, label)
    }

    fn armed(&self, label: &str) -> bool {
        self.lock().armed.contains(label)
    }
}

// ── Events addressed to one window ──────────────────────────────────────────

/// Progress of work one window started — a tree hash, a download it waits for —
/// goes to that window and no other: each window keeps its own list of what it
/// is doing, and its close confirmation counts from that list. Work that
/// belongs to a session rather than to a window — a sync run since v1.36 (ADR
/// 0058) — follows the session's tab instead (`following`).
#[derive(Clone)]
pub struct WindowSink {
    app: AppHandle,
    to: SinkTarget,
}

#[derive(Clone)]
enum SinkTarget {
    Window(String),
    /// Whichever window shows the session's tab when the event is sent; the
    /// window that started the work when none does.
    Session {
        session: String,
        origin: String,
    },
}

impl WindowSink {
    /// The sink of the window that invoked the command.
    pub fn of(window: &WebviewWindow) -> Self {
        Self {
            app: window.app_handle().clone(),
            to: SinkTarget::Window(window.label().to_string()),
        }
    }

    /// The sink of a session's work: each event goes to the window that shows
    /// its tab at that moment — the tab can move to another window mid-run.
    pub fn following(app: &AppHandle, session: &str, origin: &str) -> Self {
        Self {
            app: app.clone(),
            to: SinkTarget::Session {
                session: session.to_string(),
                origin: origin.to_string(),
            },
        }
    }

    /// The window an event goes to now.
    pub fn label(&self) -> String {
        match &self.to {
            SinkTarget::Window(label) => label.clone(),
            SinkTarget::Session { session, origin } => self
                .app
                .try_state::<Windows>()
                .and_then(|w| w.owner_of(session))
                .unwrap_or_else(|| origin.clone()),
        }
    }

    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        self.app
            .emit_to(self.label().as_str(), event, payload)
            .log_debug("windows", "the window was not told");
    }
}

/// Whether quitting must ask first (the main window's frontend armed its guard).
pub fn quit_guarded<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Windows>().is_some_and(|w| w.armed(MAIN))
}

/// Ask the main window to confirm quitting — it lists what would be cut off in
/// every window. Unarmed (its frontend never loaded) the app just exits.
pub fn request_quit<R: tauri::Runtime>(app: &AppHandle<R>) {
    if !quit_guarded(app) {
        app.exit(0);
        return;
    }
    if let Some(main) = app.get_webview_window(MAIN) {
        // The question is asked in the main window: bring it up from wherever it is.
        main.unminimize()
            .log_debug("windows", "the window was not restored");
        main.set_focus()
            .log_debug("windows", "the window was not brought to the front");
    }
    app.emit_to(MAIN, "menu://quit", ())
        .log_debug("windows", "the main window was not asked to quit");
}

/// Send a native-menu command to the window the user is working in.
pub fn emit_to_focused<R: tauri::Runtime>(app: &AppHandle<R>, event: &str) {
    // The registry lock is let go of before asking Tauri about its windows.
    let focused = app
        .try_state::<Windows>()
        .and_then(|w| w.lock().focused.clone());
    let target = menu_target(focused, |label| app.get_webview_window(label).is_some());
    app.emit_to(target, event, ())
        .log_debug("windows", "the window was not given the menu command");
}

/// Window events the registry cares about. Returns true when a close request
/// was taken over (the caller must `prevent_close`).
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) -> bool {
    let app = window.app_handle();
    let label = window.label();
    let Some(windows) = app.try_state::<Windows>() else {
        return false;
    };
    match event {
        tauri::WindowEvent::Focused(true) => {
            windows.lock().focused = Some(label.to_string());
            false
        }
        // The window's close button, Alt+F4, the TitleBar's close and its
        // File → Exit / Close window all arrive here.
        tauri::WindowEvent::CloseRequested { .. } => {
            if !windows.armed(label) {
                return false;
            }
            if label == MAIN {
                request_quit(app);
            } else {
                app.emit_to(label, "window://close", ())
                    .log_debug("windows", "the window was not asked whether to close");
            }
            true
        }
        tauri::WindowEvent::Destroyed => {
            let (sessions, waker, left) = {
                let mut reg = windows.lock();
                let left = reg.hover_gone(label);
                let (sessions, waker) = reg.forget_window(label);
                (sessions, waker, left)
            };
            if let Some(done) = waker {
                done.send(Err(HandoffFailure::NotTaken))
                    .log_unheard("windows", "the answer about moving a tab");
            }
            if let Some(over) = left {
                // It was dragging a tab over another window, which still draws it.
                app.emit_to(over, DRAG_EVENT, DragEvent::Leave).log_debug(
                    "windows",
                    "the window under the pointer was not told about the drag",
                );
            }
            // It no longer takes tabs: the others stop offering it.
            broadcast_roster(app, &windows);
            if label == MAIN {
                // The app ends with its main window. (Closing it normally goes
                // through the quit confirmation, which exits by itself; this is
                // for a main window that went any other way.)
                if app.webview_windows().keys().any(|l| l != MAIN) {
                    app.exit(0);
                }
            } else if !sessions.is_empty() {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    for id in sessions {
                        crate::transfers::forget_session(&app, &id).await;
                        crate::end_session(&app, &id).await;
                    }
                });
            }
            false
        }
        _ => false,
    }
}

// ── Close confirmation ──────────────────────────────────────────────────────

/// Arm this window's close confirmation. Called by its frontend once the
/// listener for the question is in place, so there is always someone to answer.
#[tauri::command]
pub fn arm_close_guard(window: WebviewWindow, windows: State<Windows>) {
    windows.lock().armed.insert(window.label().to_string());
}

/// How long quitting waits for interrupted transfers' partial copies to go.
const DISCARD_ON_QUIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The user confirmed quitting: disarm every guard, write down where every
/// window stands (v1.36, ADR 0057), take the partial copies of interrupted
/// transfers off their destinations — they are not gone on with after a
/// restart (ADR 0060) — and exit.
#[tauri::command]
pub async fn quit_app(app: AppHandle) -> crate::error::AppResult<()> {
    app.state::<Windows>().lock().armed.clear();
    remember_places(&app);
    let kept = app.state::<crate::transfers::Jobs>().take_all_held();
    let discard = async {
        for held in kept {
            crate::transfers::discard_held(&app, held).await;
        }
    };
    if tokio::time::timeout(DISCARD_ON_QUIT, discard)
        .await
        .is_err()
    {
        tracing::warn!(
            source = "transfer",
            code = "transfers-not-discarded",
            "held transfers not discarded within {DISCARD_ON_QUIT:?}: their partial files stay"
        );
    }
    app.exit(0);
    Ok(())
}

// ── Where the windows stood (v1.36, ADR 0057) ──────────────────────────────

/// A window is not cut below this height when its place is given back.
const PLACE_MIN_HEIGHT: f64 = 240.0;

/// The smallest place a window is given back, in its physical px.
fn place_min(window: &WebviewWindow) -> (u32, u32) {
    let scale = window.scale_factor().unwrap_or(1.0);
    (
        (WINDOW_MIN_WIDTH * scale) as u32,
        (PLACE_MIN_HEIGHT * scale) as u32,
    )
}

/// Every window's place, written at quit: quitting is the one way out
/// (`quitting_always_goes_through_the_confirmation`), so it is the one moment
/// all of them still stand. The floating drag label is no window of ours.
fn remember_places(app: &AppHandle) {
    let places: crate::winplace::Places = app
        .webview_windows()
        .iter()
        .filter(|(label, _)| crate::winplace::kept_label(label))
        .filter_map(|(label, w)| crate::winplace::place_of(w).map(|p| (label.clone(), p)))
        .collect();
    crate::store::save_window_places(&places).log_warn(
        "windows",
        "window places were not saved: windows open where the system puts them",
    );
}

/// The main window, before it is shown: where it stood when the app last quit.
pub fn place_main(window: &WebviewWindow) -> bool {
    match crate::store::load_window_places().get(MAIN) {
        Some(saved) => crate::winplace::apply(window, *saved, place_min(window)),
        None => false,
    }
}

/// A window of the previous launch to open again, with what it brings back.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reopen {
    pub label: String,
    /// Its tabs, as the main window read them from the window's slot.
    pub record: String,
}

/// More than this is not a record the main window wrote (200 tabs, each a few
/// hundred bytes of facts and paths).
const MAX_RECORD: usize = 2 * 1024 * 1024;

/// Open again the windows of the previous launch that bring tabs back (v1.36,
/// ADR 0057), each under its old label and at its old place. Asked by the main
/// window alone, once it has read the slots; returns the labels opened — the
/// tabs of any other the main window keeps itself. Async: a window built in a
/// synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn reopen_windows(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, Windows>,
    reopen: Vec<Reopen>,
    background: Option<String>,
) -> AppResult<Vec<String>> {
    if window.label() != MAIN {
        return Ok(Vec::new());
    }
    let places = crate::store::load_window_places();
    let mut opened = Vec::new();
    for Reopen { label, record } in reopen {
        if record.len() > MAX_RECORD || app.get_webview_window(&label).is_some() {
            continue;
        }
        if !windows.lock().reopening(&label, record) {
            continue;
        }
        match build_reopened(
            &app,
            &window,
            &label,
            places.get(&label).copied(),
            background.as_deref(),
        ) {
            Ok(()) => opened.push(label),
            Err(_) => {
                windows.lock().restoring.remove(&label);
            }
        }
    }
    Ok(opened)
}

/// A reopened window: built hidden, put at its place, then shown — unlike a
/// window opened for a tab, nothing waits for it, and it should not be seen
/// jumping from where the window system put it.
fn build_reopened(
    app: &AppHandle,
    main: &WebviewWindow,
    label: &str,
    place: Option<crate::winplace::Place>,
    background: Option<&str>,
) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("vterm")
        .inner_size(FALLBACK_SIZE.0, FALLBACK_SIZE.1)
        .min_inner_size(WINDOW_MIN_WIDTH, 0.0)
        .visible(false)
        .focused(false)
        .shadow(true);
    if let Some(color) = background.and_then(|c| c.parse::<tauri::window::Color>().ok()) {
        builder = builder.background_color(color);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }
    let win = builder.build()?;
    tracing::info!(
        source = "windows",
        code = "window-reopened",
        window = label,
        "window of the last launch reopened"
    );
    let maximize = match place {
        Some(saved) => crate::winplace::apply(&win, saved, place_min(&win)),
        None => {
            // No place written down (the app did not quit through the
            // confirmation last time): beside the main window, as a new one.
            if let Ok(pos) = main.outer_position() {
                let step = (CASCADE * main.scale_factor().unwrap_or(1.0)) as i32;
                win.set_position(tauri::PhysicalPosition::new(pos.x + step, pos.y + step))
                    .log_debug("windows", "the window was not moved to its place");
            }
            false
        }
    };
    win.show()?;
    if maximize {
        win.maximize()
            .log_debug("windows", "the window was not maximized");
    }
    Ok(())
}

/// The tabs this window was reopened with — asked once by a window on load;
/// `None` for a window opened for a tab, or asked a second time.
#[tauri::command]
pub fn take_restore(window: WebviewWindow, windows: State<Windows>) -> Option<String> {
    windows.lock().restoring.remove(window.label())
}

/// The user confirmed closing a secondary window (or it has nothing left to
/// show): its sessions end with it — see [`on_window_event`].
#[tauri::command]
pub fn close_window(window: WebviewWindow, windows: State<Windows>) -> AppResult<()> {
    if window.label() == MAIN {
        return Ok(());
    }
    tracing::info!(
        source = "windows",
        code = "window-closed",
        window = window.label(),
        "window closed"
    );
    windows.lock().armed.remove(window.label());
    window
        .destroy()
        .map_err(|e| AppError::Message(format!("close window: {e}")))
}

/// What this window would lose if the app quit now (secondary windows report it
/// as it changes; the main window asks for the sum).
#[tauri::command]
pub fn report_window_summary(
    window: WebviewWindow,
    windows: State<Windows>,
    rows: Vec<SummaryRow>,
) {
    windows
        .lock()
        .summaries
        .insert(window.label().to_string(), rows);
}

/// Rows reported by every other window.
#[tauri::command]
pub fn other_windows_summary(window: WebviewWindow, windows: State<Windows>) -> Vec<SummaryRow> {
    windows.lock().other_summaries(window.label())
}

// ── Which windows take tabs ─────────────────────────────────────────────────

/// Send every window the list of those that take tabs — and, with it, what
/// each of them offers as a place to copy files to: a window that is gone
/// offers nothing any more.
fn broadcast_roster<R: tauri::Runtime>(app: &AppHandle<R>, windows: &Windows) {
    let roster = windows.lock().roster();
    app.emit(ROSTER_EVENT, roster)
        .log_debug("windows", "the windows were not told the list of windows");
    broadcast_targets(app, windows);
}

/// One window's word on where files can be copied to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedTargets {
    window: String,
    targets: serde_json::Value,
}

const TARGETS_EVENT: &str = "window://targets";

fn broadcast_targets<R: tauri::Runtime>(app: &AppHandle<R>, windows: &Windows) {
    let shared = windows.lock().shared_targets();
    app.emit(TARGETS_EVENT, shared).log_debug(
        "windows",
        "the windows were not told where files can be copied",
    );
}

/// The sessions this window offers as a place to copy files to (v1.13) — told
/// to every window, this one included, as `window://targets`. A file is copied
/// to a session whichever window shows its tab: the transfer is the backend's
/// (ADR 0025), so the menu of one window can name the sessions of another.
/// The description is the frontend's and is passed on unread.
#[tauri::command]
pub fn announce_copy_targets(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<Windows>,
    targets: serde_json::Value,
) {
    windows.lock().share_targets(window.label(), targets);
    broadcast_targets(&app, &windows);
}

/// This window takes tabs, and this is what the others show of it. Called by
/// its frontend once it listens for an offer, and again whenever the title or
/// the count changes. The answer is the whole list, sent to every window — the
/// one that asked included, which is how a window that has just loaded learns
/// of the others.
#[tauri::command]
pub fn announce_window(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<Windows>,
    title: String,
    tabs: u32,
) {
    windows.lock().announce(window.label(), title, tabs);
    broadcast_roster(&app, &windows);
}

// ── A tab dragged over another window ───────────────────────────────────────

/// What the window a tab is held over is told (mirror of `DragMessage`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DragEvent {
    /// The tab is over this window, at (`x`, `y`) of its page.
    Over {
        x: f64,
        y: f64,
        tab: serde_json::Value,
    },
    /// It was let go of here: keep its place until the tab itself arrives.
    Drop {
        x: f64,
        y: f64,
        tab: serde_json::Value,
    },
    /// It is no longer over this window, or the drop came to nothing.
    Leave,
}

/// The window of the app the mouse pointer is over — any of them, the one the
/// drag began in included — and the pointer's place in it. The OS is asked
/// ([`crate::winhit`]); where it cannot say, the answer is `None`, never a
/// guess from window rectangles. The floating label is never the answer.
async fn pointer_window(app: &AppHandle) -> AppResult<Option<crate::winhit::Hit>> {
    // AppKit answers on the main thread only; a command runs on a worker.
    let (answer, hit) = oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        answer
            .send(crate::winhit::app_window_at_pointer(&handle))
            .log_unheard("windows", "the answer about moving a tab");
    })
    .map_err(|e| AppError::Message(format!("window under pointer: {e}")))?;
    let hit = hit.await.ok().flatten();
    Ok(hit.filter(|hit| hit.label != crate::dragghost::LABEL))
}

/// Bring the window a dragged tab is over to the front, and make it the
/// active one: a tab cannot be aimed at a strip that another window covers,
/// and a window that is not active draws the tab over it a beat late.
fn raise_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        window
            .set_focus()
            .log_debug("windows", "the window was not brought to the front");
    }
}

// ── Files in a system drag, over a window of the app (v1.14) ────────────────
// Once the system has taken a drag over — files promised to the desktop — the
// page that began it hears nothing more of the pointer. The drag's source does
// (the system tells it where the pointer is, and where it was let go of), and
// says here what a page used to say through `drag_over` / `drag_drop`: the
// window under the pointer draws the files and, let go of there, takes them.
// The window the drag began in is such a window too. Main thread only.

/// The window of the app under the pointer that hears of drags, if any.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn drag_hearer(app: &AppHandle, windows: &Windows) -> Option<crate::winhit::Hit> {
    crate::winhit::app_window_at_pointer(app)
        .filter(|hit| hit.label != crate::dragghost::LABEL)
        .filter(|hit| windows.lock().roster.contains_key(&hit.label))
}

/// The pointer of a system drag begun in `source` has moved. True when it is
/// over a window of the app — which draws the files itself.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub(crate) fn system_drag_moved(app: &AppHandle, source: &str, what: &serde_json::Value) -> bool {
    let windows = app.state::<Windows>();
    let hit = drag_hearer(app, &windows);
    let left = windows
        .lock()
        .hover(source, hit.as_ref().map(|hit| hit.label.as_str()));
    if let Some(left) = left {
        app.emit_to(left, DRAG_EVENT, DragEvent::Leave).log_debug(
            "windows",
            "the window was not told that the dragged tab left it",
        );
    }
    let Some(hit) = hit else { return false };
    let (x, y, tab) = (hit.x, hit.y, what.clone());
    app.emit_to(
        hit.label.as_str(),
        DRAG_EVENT,
        DragEvent::Over { x, y, tab },
    )
    .log_debug(
        "windows",
        "the window under the pointer was not told about the drag",
    );
    true
}

/// It was given up — Esc, or the system would not carry it: nobody takes the
/// files, and the window that was drawing them is told they are gone.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub(crate) fn system_drag_cancelled(app: &AppHandle, source: &str) {
    let left = app.state::<Windows>().lock().end_hover(source);
    if let Some(left) = left {
        app.emit_to(left, DRAG_EVENT, DragEvent::Leave).log_debug(
            "windows",
            "the window was not told that the dragged tab left it",
        );
    }
}

/// It was let go of. True when that was over a window of the app, which now
/// has the files; false — over the desktop, another program, or nothing.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub(crate) fn system_drag_ended(app: &AppHandle, source: &str, what: &serde_json::Value) -> bool {
    let windows = app.state::<Windows>();
    let hit = drag_hearer(app, &windows);
    let left = {
        let mut reg = windows.lock();
        let left = reg.hover(source, hit.as_ref().map(|hit| hit.label.as_str()));
        reg.end_hover(source);
        left
    };
    if let Some(left) = left {
        app.emit_to(left, DRAG_EVENT, DragEvent::Leave).log_debug(
            "windows",
            "the window was not told that the dragged tab left it",
        );
    }
    let Some(hit) = hit else { return false };
    let (x, y, tab) = (hit.x, hit.y, what.clone());
    app.emit_to(
        hit.label.as_str(),
        DRAG_EVENT,
        DragEvent::Drop { x, y, tab },
    )
    .log_debug(
        "windows",
        "the window under the pointer was not told about the drag",
    );
    true
}

/// What the window a tab is dragged out of learns about where the tab is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragAnswer {
    /// The other window of the app the tab is over — it draws the tab.
    window: Option<String>,
    /// Over none of the app's windows: the floating label draws it
    /// ([`crate::dragghost`]).
    floating: bool,
}

/// A tab of this window is being dragged. The window of the app under the
/// pointer comes to the front. If it is another window, it is told where the
/// tab is — it draws the tab — and the window the tab was over before is told
/// it left; over none of the app's windows the floating label draws it, looking
/// as `look` says. `tab` is what the other window needs to draw it, passed on
/// as it is.
#[tauri::command]
pub async fn drag_over(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, Windows>,
    tab: serde_json::Value,
    look: Option<crate::dragghost::Look>,
) -> AppResult<DragAnswer> {
    let source = window.label();
    let under = pointer_window(&app).await?;
    // The window under the pointer comes forward: the one the tab would land
    // in, and the one it came from when the pointer is back over it.
    if let Some(hit) = &under {
        if windows.lock().raise(&hit.label) {
            raise_window(&app, &hit.label);
        }
    }
    let hit = under
        .clone()
        .filter(|hit| windows.lock().takes_tabs(&hit.label, source));
    let target = hit.as_ref().map(|hit| hit.label.as_str());
    let left = windows.lock().hover(source, target);
    if let Some(left) = left {
        app.emit_to(left, DRAG_EVENT, DragEvent::Leave).log_debug(
            "windows",
            "the window was not told that the dragged tab left it",
        );
    }
    // Over none of the app's windows no page can draw the tab: a window of its
    // own does, kept next to the pointer.
    let floating = match &look {
        Some(look) if under.is_none() => crate::dragghost::show(&app, look),
        _ => {
            crate::dragghost::hide(&app);
            // Loaded while the tab is still over a window, ready for the desktop.
            crate::dragghost::prepare(&app);
            false
        }
    };
    let Some(hit) = hit else {
        return Ok(DragAnswer {
            window: None,
            floating,
        });
    };
    let (x, y) = (hit.x, hit.y);
    app.emit_to(
        hit.label.as_str(),
        DRAG_EVENT,
        DragEvent::Over { x, y, tab },
    )
    .log_debug(
        "windows",
        "the window under the pointer was not told about the drag",
    );
    Ok(DragAnswer {
        window: Some(hit.label),
        floating,
    })
}

/// The tab was let go of outside this window. Asked anew — the release is the
/// gesture, not the last move. Over another window of the app, that window is
/// told to keep the tab's place (the handoff follows) and its label is
/// returned; anywhere else the window that drew the tab is told it left.
#[tauri::command]
pub async fn drag_drop(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, Windows>,
    tab: serde_json::Value,
) -> AppResult<Option<String>> {
    let source = window.label();
    crate::dragghost::hide(&app);
    windows.lock().raised = None;
    let hit = pointer_window(&app)
        .await?
        .filter(|hit| windows.lock().takes_tabs(&hit.label, source));
    let target = hit.as_ref().map(|hit| hit.label.as_str());
    let left = windows.lock().hover(source, target);
    if let Some(left) = left {
        app.emit_to(left, DRAG_EVENT, DragEvent::Leave).log_debug(
            "windows",
            "the window was not told that the dragged tab left it",
        );
    }
    let Some(hit) = hit else { return Ok(None) };
    let (x, y) = (hit.x, hit.y);
    app.emit_to(
        hit.label.as_str(),
        DRAG_EVENT,
        DragEvent::Drop { x, y, tab },
    )
    .log_debug(
        "windows",
        "the window under the pointer was not told about the drag",
    );
    Ok(Some(hit.label))
}

/// The drag is over without the tab having moved: it came back into this
/// window, was cancelled, or the handoff that followed a drop failed. The
/// window that drew the tab is told it left.
#[tauri::command]
pub fn drag_end(app: AppHandle, window: WebviewWindow, windows: State<Windows>) {
    crate::dragghost::hide(&app);
    let left = {
        let mut reg = windows.lock();
        reg.raised = None;
        reg.end_hover(window.label())
    };
    if let Some(left) = left {
        app.emit_to(left, DRAG_EVENT, DragEvent::Leave).log_debug(
            "windows",
            "the window was not told that the dragged tab left it",
        );
    }
}

// ── Handoff of a tab to another window ──────────────────────────────────────

/// Where the tab goes, and how a new window opens for it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachOpts {
    /// Label of an open window to move the tab into; absent — a new window.
    #[serde(default)]
    target: Option<String>,
    /// Screen position of the pointer the tab was dropped at (logical px);
    /// absent for the menu / palette command.
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    /// The theme's panel colour (`#rrggbb`), so the window never flashes another.
    #[serde(default)]
    background: Option<String>,
}

/// Top-left corner of the new window, in logical px.
fn new_window_position(opts: &DetachOpts, source: Option<(f64, f64)>) -> Option<(f64, f64)> {
    match (opts.x, opts.y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
            Some((x - DROP_GRIP.0, (y - DROP_GRIP.1).max(0.0)))
        }
        _ => source.map(|(x, y)| (x + CASCADE, y + CASCADE)),
    }
}

fn build_window(
    app: &AppHandle,
    source: &WebviewWindow,
    label: &str,
    opts: &DetachOpts,
) -> tauri::Result<WebviewWindow> {
    let scale = source.scale_factor().unwrap_or(1.0);
    let (width, height) = source
        .inner_size()
        .map(|s| {
            let s = s.to_logical::<f64>(scale);
            (s.width, s.height)
        })
        .unwrap_or(FALLBACK_SIZE);
    let source_pos = source.outer_position().ok().map(|p| {
        let p = p.to_logical::<f64>(scale);
        (p.x, p.y)
    });

    // Shown at once, in the theme's colour: a hidden WebView is throttled like a
    // background page (timers down to once a second), and the tab would take
    // seconds to arrive instead of a blink.
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("vterm")
        .inner_size(width, height)
        .min_inner_size(WINDOW_MIN_WIDTH, 0.0)
        .shadow(true);
    if let Some((x, y)) = new_window_position(opts, source_pos) {
        builder = builder.position(x, y);
    }
    if let Some(color) = opts
        .background
        .as_deref()
        .and_then(|c| c.parse::<tauri::window::Color>().ok())
    {
        builder = builder.background_color(color);
    }
    // Same chrome as the main window: Windows/Linux draw their own (ADR 0011).
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }
    let built = builder.build();
    match &built {
        Ok(_) => tracing::info!(
            source = "windows",
            code = "window-opened",
            window = label,
            "window opened for a tab"
        ),
        Err(e) => tracing::warn!(
            source = "windows",
            code = "window-not-opened",
            window = label,
            "window not opened: {e}"
        ),
    }
    built
}

/// What step 1 held: the terminal's output and, when the assistant is answering
/// in the session, its answer (v1.36, ADR 0058).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachBegun {
    /// Output events sent before the hold: the window waits for that many,
    /// then snapshots its terminal.
    pub output: u64,
    /// The answer streaming now, and how many of its pieces were sent before the
    /// hold: the chat waits for that many, then the conversation is packed.
    pub stream: Option<HeldStream>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldStream {
    pub id: String,
    pub sent: u64,
}

/// Step 1: start holding the session's output — and the assistant's answer
/// streaming in it.
#[tauri::command]
pub async fn detach_begin(
    window: WebviewWindow,
    state: State<'_, AppState>,
    windows: State<'_, Windows>,
    session_id: String,
) -> AppResult<DetachBegun> {
    if !windows.owns(&session_id, window.label()) {
        return Err(AppError::NoSession);
    }
    tracing::info!(
        source = "windows",
        code = "handoff-begun",
        sid = %session_id,
        from = window.label(),
        "tab hand-off begun"
    );
    let gate = crate::session_gate(&state, &session_id)
        .await
        .ok_or(AppError::NoSession)?;
    let output = gate.hold().ok_or(AppError::NoSession)?;
    let stream = crate::aigate::hold_session(&session_id).map(|(id, sent)| HeldStream { id, sent });
    Ok(DetachBegun { output, stream })
}

/// Roll step 1 back: the held output goes to the window that still has the tab.
#[tauri::command]
pub async fn detach_abort(
    window: WebviewWindow,
    state: State<'_, AppState>,
    windows: State<'_, Windows>,
    session_id: String,
) -> AppResult<()> {
    if !windows.owns(&session_id, window.label()) {
        return Ok(());
    }
    tracing::info!(
        source = "windows",
        code = "handoff-rolled-back",
        sid = %session_id,
        from = window.label(),
        "tab hand-off rolled back"
    );
    if let Some(gate) = crate::session_gate(&state, &session_id).await {
        gate.resume();
    }
    crate::aigate::resume_session(&session_id);
    Ok(())
}

/// Tell a window that is already open that a tab waits for it.
fn offer_tab(app: &AppHandle, label: &str) -> AppResult<()> {
    let target = app
        .get_webview_window(label)
        .ok_or(AppError::HandoffNotTaken)?;
    // A minimized WebView is throttled like a background page: brought up
    // first, or the tab would take seconds to arrive instead of a blink.
    target
        .unminimize()
        .log_debug("windows", "the window was not restored");
    app.emit_to(label, HANDOFF_EVENT, ())
        .map_err(|e| AppError::Message(format!("offer tab: {e}")))
}

/// Step 2: leave the tab's packet for the window that takes it — a new one, or
/// the open window `opts.target` — and wait until it has taken the tab over.
/// Returns that window's label. Any failure rolls the hold back — the caller
/// keeps its tab exactly as it was.
#[tauri::command]
pub async fn detach_commit(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    windows: State<'_, Windows>,
    session_id: String,
    packet: String,
    opts: DetachOpts,
) -> AppResult<String> {
    tracing::debug!(
        source = "windows",
        sid = %session_id,
        from = window.label(),
        "tab hand-off committing"
    );
    let packet = Zeroizing::new(packet);
    if !windows.owns(&session_id, window.label()) {
        return Err(AppError::NoSession);
    }
    let gate = crate::session_gate(&state, &session_id)
        .await
        .ok_or(AppError::NoSession)?;
    if !gate.is_held() || crate::aigate::overflowed_in(&session_id) {
        // The hold already gave way (the terminal printed, or the assistant
        // wrote, past the limit).
        crate::aigate::resume_session(&session_id);
        return Err(AppError::HandoffOverflowed);
    }

    let (done, mut taken) = oneshot::channel::<HandoffResult>();
    // A window opened for this tab goes with a failed handoff; one that was
    // already open stays, whatever happens.
    let created = opts.target.is_none();
    let label = {
        let mut reg = windows.lock();
        let label = match opts.target.as_deref() {
            None => Some(reg.next_label()),
            Some(target) => reg
                .takes_tabs(target, window.label())
                .then(|| target.to_string()),
        };
        if let Some(label) = &label {
            reg.pending.insert(
                label.clone(),
                Pending {
                    session_id: session_id.clone(),
                    packet: Some(packet),
                    done,
                },
            );
        }
        label
    };
    let Some(label) = label else {
        // That window is gone, has not loaded, or is taking another tab.
        gate.resume();
        crate::aigate::resume_session(&session_id);
        return Err(AppError::HandoffNotTaken);
    };

    let opened = if created {
        build_window(&app, &window, &label, &opts)
            .map(|_| ())
            .map_err(|e| AppError::Message(format!("open window: {e}")))
    } else {
        offer_tab(&app, &label)
    };
    if let Err(e) = opened {
        windows.lock().pending.remove(&label);
        gate.resume();
        crate::aigate::resume_session(&session_id);
        return Err(e);
    }

    let result = match tokio::time::timeout(HANDOFF_TIMEOUT, &mut taken).await {
        Ok(result) => result.unwrap_or(Err(HandoffFailure::NotTaken)),
        Err(_elapsed) => {
            // Out of time — unless the window took the tab over this very
            // moment: then its answer is on the way and is the one that counts.
            let still_waiting = windows.lock().pending.remove(&label).is_some();
            if still_waiting {
                Err(HandoffFailure::NotTaken)
            } else {
                taken.await.unwrap_or(Err(HandoffFailure::NotTaken))
            }
        }
    };
    match result {
        Ok(()) => Ok(label),
        Err(failure) => {
            // Roll back: the held output goes to this window, which still has
            // the tab. A window opened for the tab is closed with it; one that
            // was already open has tabs of its own and stays.
            gate.resume();
            crate::aigate::resume_session(&session_id);
            if created {
                if let Some(w) = app.get_webview_window(&label) {
                    w.destroy()
                        .log_debug("windows", "a window was not destroyed");
                }
            }
            Err(failure.into())
        }
    }
}

/// The packet of the tab being moved into this window — asked for by a new
/// window on load and by an open one when it is offered a tab. Handed out once;
/// `None` for a window that is not the target of a handoff.
#[tauri::command]
pub fn take_handoff(window: WebviewWindow, windows: State<Windows>) -> Option<String> {
    let mut reg = windows.lock();
    let packet = reg.pending.get_mut(window.label())?.packet.take()?;
    Some(packet.as_str().to_owned())
}

/// This window cannot take the tab it was offered — the packet was no use, or
/// its terminal failed before taking the session over. The window waiting in
/// `detach_commit` is answered now instead of at the timeout, and keeps its tab.
/// A no-op when nothing waits (the handoff has already ended either way).
/// `session_id` names the tab when the window got as far as knowing it — so a
/// late refusal cannot answer for a different tab offered since.
#[tauri::command]
pub fn decline_handoff(window: WebviewWindow, windows: State<Windows>, session_id: Option<String>) {
    let pending = {
        let mut reg = windows.lock();
        match session_id {
            Some(id) => reg.take_pending(window.label(), &id),
            None => reg.pending.remove(window.label()),
        }
    };
    if let Some(pending) = pending {
        pending
            .done
            .send(Err(HandoffFailure::NotTaken))
            .log_unheard("windows", "the answer about moving a tab");
    }
}

/// The window taking a tab, once it has restored it and listens for its output:
/// take the session over. From here the held output flows to this window and it
/// owns the session.
#[tauri::command]
pub async fn attach_session(
    window: WebviewWindow,
    state: State<'_, AppState>,
    windows: State<'_, Windows>,
    session_id: String,
) -> AppResult<()> {
    let label = window.label().to_string();
    let Some(pending) = windows.lock().take_pending(&label, &session_id) else {
        tracing::warn!(
            source = "windows",
            code = "handoff-not-taken",
            sid = %session_id,
            to = %label,
            "tab offered nowhere: not taken"
        );
        return Err(AppError::HandoffNotTaken);
    };
    // From here every path answers the window waiting in `detach_commit`.
    let outcome: HandoffResult = match crate::session_gate(&state, &session_id).await {
        None => Err(HandoffFailure::NotTaken),
        // An answer that outgrew its hold went to the old window: the tab stays there.
        Some(_) if crate::aigate::overflowed_in(&session_id) => {
            crate::aigate::resume_session(&session_id);
            Err(HandoffFailure::Overflowed)
        }
        Some(gate) => match gate.hand_over() {
            Ok(()) => {
                // The window listens for the answer too: what was held of it goes there.
                crate::aigate::hand_over_session(&session_id).log_debug(
                    "windows",
                    "the assistant's answer was not handed to the new window",
                );
                let mut reg = windows.lock();
                reg.claim(&session_id, &label);
                // The tab it was shown is the one it now has.
                reg.landed(&label);
                Ok(())
            }
            Err(HandOverError::Overflowed) => Err(HandoffFailure::Overflowed),
            Err(HandOverError::NotHeld) => Err(HandoffFailure::NotTaken),
        },
    };
    pending
        .done
        .send(outcome)
        .log_unheard("windows", "the answer about moving a tab");
    outcome?;
    window
        .set_focus()
        .log_debug("windows", "the window was not brought to the front");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(session: &str) -> (Pending, oneshot::Receiver<HandoffResult>) {
        let (done, rx) = oneshot::channel();
        (
            Pending {
                session_id: session.to_string(),
                packet: Some(Zeroizing::new("{}".to_string())),
                done,
            },
            rx,
        )
    }

    #[test]
    fn secondary_windows_are_numbered_from_two() {
        let mut reg = Registry::default();
        assert_eq!(reg.next_label(), "win-2");
        assert_eq!(reg.next_label(), "win-3");
    }

    #[test]
    fn a_window_of_the_previous_launch_opens_under_its_label_and_hands_its_tabs_out_once() {
        let mut reg = Registry::default();
        assert!(reg.reopening("win-5", "{\"v\":1}".into()));
        // A window opened for a tab later is numbered after it.
        assert_eq!(reg.next_label(), "win-6");
        // Not twice, not the main window, not a label of no window of ours.
        assert!(!reg.reopening("win-5", "{}".into()));
        for label in ["main", "drag-ghost", "win-", "win-x", "win-12345678901"] {
            assert!(!reg.reopening(label, "{}".into()), "{label}");
        }
        assert_eq!(reg.restoring.remove("win-5").as_deref(), Some("{\"v\":1}"));
        assert_eq!(reg.restoring.remove("win-5"), None);
        // A label given out and gone in this launch is never reopened.
        reg.forget_window("win-6");
        assert!(!reg.reopening("win-6", "{}".into()));
        // A window that goes before taking its tabs takes them with it.
        assert!(reg.reopening("win-7", "{}".into()));
        reg.forget_window("win-7");
        assert!(!reg.restoring.contains_key("win-7"));
    }

    #[test]
    fn only_the_owner_can_let_go_of_a_session() {
        let mut reg = Registry::default();
        reg.claim("s1", MAIN);
        assert!(reg.owns("s1", MAIN));
        // The tab moved: the old window's teardown must not end the session.
        reg.claim("s1", "win-2");
        assert!(!reg.owns("s1", MAIN));
        assert!(!reg.release("s1", MAIN));
        assert!(reg.owns("s1", "win-2"));
        assert!(reg.release("s1", "win-2"));
        assert!(!reg.owns("s1", "win-2"));
        // A session nobody claimed (never connected) can be let go of freely.
        assert!(reg.release("unknown", MAIN));
    }

    #[test]
    fn a_closed_window_gives_up_its_sessions_and_only_its_own() {
        let mut reg = Registry::default();
        reg.claim("a", "win-2");
        reg.claim("b", MAIN);
        reg.claim("c", "win-2");
        reg.armed.insert("win-2".into());
        reg.focused = Some("win-2".into());
        reg.summaries.insert("win-2".into(), vec![]);
        reg.announce("win-2", "web-01".into(), 2);

        let (sessions, waker) = reg.forget_window("win-2");
        assert_eq!(sessions, vec!["a".to_string(), "c".to_string()]);
        assert!(waker.is_none());
        assert!(reg.owns("b", MAIN));
        assert!(!reg.armed.contains("win-2"));
        assert_eq!(reg.focused, None);
        assert!(reg.summaries.is_empty());
        // Nobody is offered a window that is gone — not even when its last
        // announcement, sent on its way out, arrives after it was forgotten.
        assert!(reg.roster().is_empty());
        reg.announce("win-2", String::new(), 0);
        assert!(reg.roster().is_empty());
        assert!(!reg.takes_tabs("win-2", MAIN));
    }

    #[test]
    fn windows_are_listed_main_first_then_in_the_order_they_opened() {
        let mut reg = Registry::default();
        reg.announce("win-10", "db".into(), 1);
        reg.announce("win-2", "web-01".into(), 3);
        reg.announce(MAIN, "local".into(), 4);
        let labels: Vec<String> = reg.roster().into_iter().map(|w| w.label).collect();
        // By number, not by spelling: `win-10` comes after `win-2`.
        assert_eq!(labels, ["main", "win-2", "win-10"]);

        // Announcing again replaces what the others show of the window.
        reg.announce("win-2", "web-02".into(), 1);
        assert_eq!(
            reg.roster()[1],
            WindowEntry {
                label: "win-2".into(),
                title: "web-02".into(),
                tabs: 1,
            }
        );
    }

    #[test]
    fn a_tab_is_offered_only_to_another_window_that_answers_and_is_free() {
        let mut reg = Registry::default();
        reg.announce(MAIN, String::new(), 0);
        reg.announce("win-2", "web-01".into(), 1);
        assert!(reg.takes_tabs(MAIN, "win-2"));
        assert!(reg.takes_tabs("win-2", MAIN));
        // Not to itself.
        assert!(!reg.takes_tabs(MAIN, MAIN));
        // Not to a window whose frontend never said it listens (still loading,
        // or a label that names no window at all).
        assert!(!reg.takes_tabs("win-3", MAIN));
        // Not to a window in the middle of taking another tab: a handoff is
        // kept under its target's label, and a second one would replace it.
        let (p, _rx) = pending("s1");
        reg.pending.insert("win-2".into(), p);
        assert!(!reg.takes_tabs("win-2", MAIN));
        assert!(reg.take_pending("win-2", "s1").is_some());
        assert!(reg.takes_tabs("win-2", MAIN));
    }

    #[test]
    fn a_tab_held_over_a_window_is_drawn_by_one_window_at_a_time() {
        let mut reg = Registry::default();
        // Entering a window tells nobody anything; it is told by the caller.
        assert_eq!(reg.hover(MAIN, Some("win-2")), None);
        // Moving on within it changes nothing either.
        assert_eq!(reg.hover(MAIN, Some("win-2")), None);
        // On to another window: the first one is told the tab left.
        assert_eq!(reg.hover(MAIN, Some("win-3")), Some("win-2".to_string()));
        // Off every window: so is that one.
        assert_eq!(reg.hover(MAIN, None), Some("win-3".to_string()));
        assert_eq!(reg.hover(MAIN, None), None);
    }

    #[test]
    fn the_end_of_a_drag_is_told_to_the_window_that_drew_it_once() {
        let mut reg = Registry::default();
        reg.hover(MAIN, Some("win-2"));
        // Not by a window that is not the one dragging.
        assert_eq!(reg.end_hover("win-3"), None);
        assert_eq!(reg.end_hover(MAIN), Some("win-2".to_string()));
        assert_eq!(reg.end_hover(MAIN), None);
    }

    #[test]
    fn a_tab_that_arrived_is_not_announced_as_gone() {
        let mut reg = Registry::default();
        reg.hover(MAIN, Some("win-2"));
        // Another window taking a tab over is not this drag's business.
        reg.landed("win-3");
        assert_eq!(reg.hover, Some((MAIN.to_string(), "win-2".to_string())));
        reg.landed("win-2");
        assert_eq!(reg.end_hover(MAIN), None);
    }

    #[test]
    fn a_window_that_closes_mid_drag_takes_the_drag_with_it() {
        let mut reg = Registry::default();
        // The window dragging the tab is gone: the one drawing it is told.
        reg.hover("win-2", Some(MAIN));
        assert_eq!(reg.hover_gone("win-2"), Some(MAIN.to_string()));
        assert_eq!(reg.hover, None);
        // The window drawing it is gone: nobody is left to tell.
        reg.hover("win-2", Some("win-3"));
        assert_eq!(reg.hover_gone("win-3"), None);
        assert_eq!(reg.hover, None);
        // A third window closing changes nothing.
        reg.hover("win-2", Some(MAIN));
        assert_eq!(reg.hover_gone("win-4"), None);
        assert_eq!(reg.end_hover("win-2"), Some(MAIN.to_string()));
    }

    #[test]
    fn a_window_is_brought_forward_once_per_visit() {
        let mut reg = Registry::default();
        assert!(reg.raise("win-2"));
        // Still over it: nothing more to do.
        assert!(!reg.raise("win-2"));
        // Back over the window the drag began in: that one comes forward.
        assert!(reg.raise(MAIN));
        assert!(reg.raise("win-2"));
    }

    /// This file before its tests, line comments stripped.
    fn code() -> String {
        let src = include_str!("appwin.rs").replace("\r\n", "\n");
        src[..src.find("#[cfg(test)]").expect("tests")]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Body of the top-level `fn name` (to the next top-level item).
    fn body<'a>(code: &'a str, name: &str) -> &'a str {
        let at = code
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("no fn {name}"));
        let rest = &code[at..];
        &rest[..rest.find("\n}\n").expect("end of fn")]
    }

    #[test]
    fn a_window_offers_its_sessions_to_the_others_until_it_is_gone() {
        let mut reg = Registry::default();
        let web = serde_json::json!([{ "sessionId": "a", "title": "web-01" }]);
        let db = serde_json::json!([{ "sessionId": "b", "title": "db-01" }]);
        reg.share_targets("win-2", db.clone());
        reg.share_targets(MAIN, web.clone());
        // The main window first, whatever order they spoke in.
        assert_eq!(
            reg.shared_targets(),
            [
                SharedTargets {
                    window: MAIN.into(),
                    targets: web.clone()
                },
                SharedTargets {
                    window: "win-2".into(),
                    targets: db
                },
            ]
        );
        // A window's later word replaces its earlier one.
        reg.share_targets("win-2", serde_json::json!([]));
        assert_eq!(reg.shared_targets()[1].targets, serde_json::json!([]));
        // Gone, it offers nothing — and its last word, arriving late, is not taken.
        reg.forget_window("win-2");
        reg.share_targets("win-2", serde_json::json!([{ "sessionId": "b" }]));
        assert_eq!(reg.shared_targets().len(), 1);
        assert_eq!(reg.shared_targets()[0].window, MAIN);
    }

    #[test]
    fn a_failed_handoff_never_closes_a_window_that_was_already_open() {
        // Guard (v1.4.0, ADR 0018): a tab can be handed to a window that has
        // tabs of its own. Rolling a handoff back used to close "the window that
        // never took it" — right for a window opened for that tab, and the loss
        // of every session in a window that was merely offered one.
        let code = code();
        let commit = body(&code, "detach_commit");
        assert_eq!(commit.matches(".destroy()").count(), 1);
        let destroy = commit.find(".destroy()").expect("closes the new window");
        // …inside the nearest `if created {`, with no block closed in between.
        let guarded = commit[..destroy]
            .rfind("if created {")
            .expect("only its own window");
        assert!(!commit[guarded..destroy].contains('}'));
        assert!(commit.contains("let created = opts.target.is_none();"));
        // The window is chosen under the registry's rule, in the same lock that
        // records the handoff — not looked up first and trusted later.
        let lock = commit.find("let mut reg = windows.lock();").expect("lock");
        let rule = commit
            .find(".takes_tabs(target, window.label())")
            .expect("rule");
        let record = commit.find("reg.pending.insert(").expect("record");
        assert!(lock < rule && rule < record);
        // Nor does declining an offer, or being offered one, close anything.
        assert!(!body(&code, "decline_handoff").contains("destroy"));
        assert!(!body(&code, "offer_tab").contains("destroy"));
    }

    #[test]
    fn closing_the_target_of_a_handoff_wakes_the_window_waiting_on_it() {
        let mut reg = Registry::default();
        let (p, mut rx) = pending("s1");
        reg.pending.insert("win-2".into(), p);
        let (_, waker) = reg.forget_window("win-2");
        waker
            .expect("waker")
            .send(Err(HandoffFailure::NotTaken))
            .unwrap();
        assert_eq!(rx.try_recv().unwrap(), Err(HandoffFailure::NotTaken));
        assert!(reg.pending.is_empty());
    }

    #[test]
    fn a_handoff_is_taken_only_by_its_window_and_for_its_session() {
        let mut reg = Registry::default();
        let (p, _rx) = pending("s1");
        reg.pending.insert("win-2".into(), p);
        assert!(reg.take_pending("win-3", "s1").is_none());
        assert!(reg.take_pending("win-2", "other").is_none());
        // A wrong guess must not consume it.
        assert!(reg.take_pending("win-2", "s1").is_some());
        assert!(reg.take_pending("win-2", "s1").is_none());
    }

    #[test]
    fn menu_commands_go_to_the_focused_window_while_it_exists() {
        assert_eq!(menu_target(None, |_| true), MAIN);
        assert_eq!(menu_target(Some("win-2".into()), |_| true), "win-2");
        // Its window is gone (the focus has not landed anywhere yet).
        assert_eq!(menu_target(Some("win-2".into()), |l| l == MAIN), MAIN);
    }

    #[test]
    fn the_quit_summary_leaves_out_the_asking_window() {
        let mut reg = Registry::default();
        let row = |key: &str, count| SummaryRow {
            key: key.into(),
            count,
        };
        reg.summaries.insert("win-3".into(), vec![row("ssh", 1)]);
        reg.summaries
            .insert("win-2".into(), vec![row("ssh", 2), row("local", 1)]);
        reg.summaries.insert(MAIN.into(), vec![row("ssh", 9)]);
        assert_eq!(
            reg.other_summaries(MAIN),
            vec![row("ssh", 2), row("local", 1), row("ssh", 1)]
        );
    }

    #[test]
    fn a_dropped_window_keeps_the_tab_strip_under_the_pointer() {
        let dropped = DetachOpts {
            x: Some(500.0),
            y: Some(300.0),
            background: None,
            target: None,
        };
        assert_eq!(
            new_window_position(&dropped, Some((10.0, 10.0))),
            Some((420.0, 284.0))
        );
        // Near the top of the screen the window does not go above it.
        let top = DetachOpts {
            x: Some(500.0),
            y: Some(4.0),
            background: None,
            target: None,
        };
        assert_eq!(new_window_position(&top, None), Some((420.0, 0.0)));
        // The menu command cascades from the source window.
        assert_eq!(
            new_window_position(&DetachOpts::default(), Some((100.0, 50.0))),
            Some((132.0, 82.0))
        );
        // Nothing to go by: the OS places the window.
        assert_eq!(new_window_position(&DetachOpts::default(), None), None);
        let nan = DetachOpts {
            x: Some(f64::NAN),
            y: Some(1.0),
            background: None,
            target: None,
        };
        assert_eq!(new_window_position(&nan, None), None);
    }
}
