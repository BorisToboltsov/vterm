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
//! - **the handoff** of a tab: the packet with its state waits here for the new
//!   window, and the session's output is held ([`crate::outgate`]) until that
//!   window says it has taken over;
//! - **what each window would lose** on quit, so the main window's confirmation
//!   lists the whole application.
//!
//! [`Registry`] is the bookkeeping — plain data, tested without a Tauri runtime.
//! The commands below wire it to real windows.

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

/// How long a new window has to load and take the tab over before the handoff
/// is rolled back. Generous: a cold WebView start on a slow disk takes seconds.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(15);

/// Size of a new window when the source window cannot be measured.
const FALLBACK_SIZE: (f64, f64) = (1100.0, 720.0);
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

/// How a handoff ended for the window waiting on it.
type HandoffResult = Result<(), HandoffFailure>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffFailure {
    /// The new window never took the tab (did not load, was closed, timed out).
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

/// A tab on its way to a new window.
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
    /// Number of the last secondary window opened.
    seq: u32,
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

    /// Take the handoff addressed to `label`, if it carries `session_id`.
    fn take_pending(&mut self, label: &str, session_id: &str) -> Option<Pending> {
        if self.pending.get(label)?.session_id != session_id {
            return None;
        }
        self.pending.remove(label)
    }

    /// A window is gone. Returns the sessions it owned (to end them) and, if it
    /// was the target of a handoff, the waker of the window still waiting on it.
    fn forget_window(
        &mut self,
        label: &str,
    ) -> (Vec<String>, Option<oneshot::Sender<HandoffResult>>) {
        self.armed.remove(label);
        self.summaries.remove(label);
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
        (sessions, waker)
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

    /// See [`Registry::release`].
    pub fn release(&self, session_id: &str, label: &str) -> bool {
        self.lock().release(session_id, label)
    }

    fn armed(&self, label: &str) -> bool {
        self.lock().armed.contains(label)
    }
}

// ── Events addressed to one window ──────────────────────────────────────────

/// Progress of work one window started — a transfer, a sync run, a tree hash —
/// goes to that window and no other: each window keeps its own list of what it
/// is doing, and its close confirmation counts from that list.
#[derive(Clone)]
pub struct WindowSink {
    app: AppHandle,
    label: String,
}

impl WindowSink {
    /// The sink of the window that invoked the command.
    pub fn of(window: &WebviewWindow) -> Self {
        Self {
            app: window.app_handle().clone(),
            label: window.label().to_string(),
        }
    }

    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        let _ = self.app.emit_to(self.label.as_str(), event, payload);
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
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    let _ = app.emit_to(MAIN, "menu://quit", ());
}

/// Send a native-menu command to the window the user is working in.
pub fn emit_to_focused<R: tauri::Runtime>(app: &AppHandle<R>, event: &str) {
    // The registry lock is let go of before asking Tauri about its windows.
    let focused = app
        .try_state::<Windows>()
        .and_then(|w| w.lock().focused.clone());
    let target = menu_target(focused, |label| app.get_webview_window(label).is_some());
    let _ = app.emit_to(target, event, ());
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
                let _ = app.emit_to(label, "window://close", ());
            }
            true
        }
        tauri::WindowEvent::Destroyed => {
            let (sessions, waker) = windows.lock().forget_window(label);
            if let Some(done) = waker {
                let _ = done.send(Err(HandoffFailure::NotTaken));
            }
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

/// The user confirmed quitting: disarm every guard and exit.
#[tauri::command]
pub fn quit_app(app: AppHandle, windows: State<Windows>) {
    windows.lock().armed.clear();
    app.exit(0);
}

/// The user confirmed closing a secondary window (or it has nothing left to
/// show): its sessions end with it — see [`on_window_event`].
#[tauri::command]
pub fn close_window(window: WebviewWindow, windows: State<Windows>) -> AppResult<()> {
    if window.label() == MAIN {
        return Ok(());
    }
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

// ── Handoff of a tab to a new window ────────────────────────────────────────

/// Where and how the new window opens.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachOpts {
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
    builder.build()
}

/// Step 1: start holding the session's output. Returns how many output events
/// were sent before the hold — the window waits for that many, then snapshots
/// its terminal.
#[tauri::command]
pub async fn detach_begin(
    window: WebviewWindow,
    state: State<'_, AppState>,
    windows: State<'_, Windows>,
    session_id: String,
) -> AppResult<u64> {
    if !windows.owns(&session_id, window.label()) {
        return Err(AppError::NoSession);
    }
    let gate = crate::session_gate(&state, &session_id)
        .await
        .ok_or(AppError::NoSession)?;
    gate.hold().ok_or(AppError::NoSession)
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
    if let Some(gate) = crate::session_gate(&state, &session_id).await {
        gate.resume();
    }
    Ok(())
}

/// Step 2: open the new window, leave the tab's packet for it and wait until it
/// has taken the tab over. Returns the new window's label. Any failure rolls
/// the hold back — the caller keeps its tab exactly as it was.
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
    let packet = Zeroizing::new(packet);
    if !windows.owns(&session_id, window.label()) {
        return Err(AppError::NoSession);
    }
    let gate = crate::session_gate(&state, &session_id)
        .await
        .ok_or(AppError::NoSession)?;
    if !gate.is_held() {
        // The hold already gave way (the terminal printed past the limit).
        return Err(AppError::HandoffOverflowed);
    }

    let (done, mut taken) = oneshot::channel::<HandoffResult>();
    let label = {
        let mut reg = windows.lock();
        let label = reg.next_label();
        reg.pending.insert(
            label.clone(),
            Pending {
                session_id: session_id.clone(),
                packet: Some(packet),
                done,
            },
        );
        label
    };

    if let Err(e) = build_window(&app, &window, &label, &opts) {
        windows.lock().pending.remove(&label);
        gate.resume();
        return Err(AppError::Message(format!("open window: {e}")));
    }

    let result = match tokio::time::timeout(HANDOFF_TIMEOUT, &mut taken).await {
        Ok(result) => result.unwrap_or(Err(HandoffFailure::NotTaken)),
        Err(_elapsed) => {
            // Out of time — unless the new window took the packet this very
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
            // the tab, and the window that never took it is closed.
            gate.resume();
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
            Err(failure.into())
        }
    }
}

/// New window, on load: the packet of the tab moved into it. Handed out once;
/// `None` for a window that is not the target of a handoff.
#[tauri::command]
pub fn take_handoff(window: WebviewWindow, windows: State<Windows>) -> Option<String> {
    let mut reg = windows.lock();
    let packet = reg.pending.get_mut(window.label())?.packet.take()?;
    Some(packet.as_str().to_owned())
}

/// New window, once it has restored the tab and listens for its output: take
/// the session over. From here the held output flows to this window and it owns
/// the session.
#[tauri::command]
pub async fn attach_session(
    window: WebviewWindow,
    state: State<'_, AppState>,
    windows: State<'_, Windows>,
    session_id: String,
) -> AppResult<()> {
    let label = window.label().to_string();
    let Some(pending) = windows.lock().take_pending(&label, &session_id) else {
        return Err(AppError::HandoffNotTaken);
    };
    // From here every path answers the window waiting in `detach_commit`.
    let outcome: HandoffResult = match crate::session_gate(&state, &session_id).await {
        None => Err(HandoffFailure::NotTaken),
        Some(gate) => match gate.hand_over() {
            Ok(()) => {
                windows.claim(&session_id, &label);
                Ok(())
            }
            Err(HandOverError::Overflowed) => Err(HandoffFailure::Overflowed),
            Err(HandOverError::NotHeld) => Err(HandoffFailure::NotTaken),
        },
    };
    let _ = pending.done.send(outcome);
    outcome?;
    let _ = window.set_focus();
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

        let (sessions, waker) = reg.forget_window("win-2");
        assert_eq!(sessions, vec!["a".to_string(), "c".to_string()]);
        assert!(waker.is_none());
        assert!(reg.owns("b", MAIN));
        assert!(!reg.armed.contains("win-2"));
        assert_eq!(reg.focused, None);
        assert!(reg.summaries.is_empty());
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
        };
        assert_eq!(new_window_position(&nan, None), None);
    }
}
