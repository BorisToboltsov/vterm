//! Where a session's terminal output goes (ADR 0017).
//!
//! Normally straight to the windows, as a `term://out/{id}` event. While the
//! session's tab is being handed to another window the gate **holds** the bytes
//! instead: the window giving the tab up snapshots its terminal, the window
//! taking it restores the snapshot, and only then does the held output flow —
//! so nothing printed in between is lost or shown twice.
//!
//! Both session kinds ([`crate::ssh`], [`crate::pty`]) and the assistant's
//! mirrored steps write through the gate, and nothing else knows the event
//! names — the guard `terminal_output_goes_only_through_the_gate` keeps it so.
//!
//! The gate itself is plain logic over a sink closure, so holding, handing over
//! and overflowing are tested without a Tauri runtime.

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Event name carrying raw terminal output bytes for a session.
fn output_event(session_id: &str) -> String {
    format!("term://out/{session_id}")
}

/// Event name signalling the remote shell/connection closed.
fn closed_event(session_id: &str) -> String {
    format!("term://closed/{session_id}")
}

/// How much output a handoff may hold. A terminal printing faster than this
/// while a window starts up cannot be moved right now: the hold gives way (the
/// bytes go to the window that still has the tab) rather than grow without bound.
pub const HOLD_CAP: usize = 16 * 1024 * 1024;

/// What the gate passes on.
#[derive(Debug, PartialEq, Eq)]
pub enum Emit {
    Output(Vec<u8>),
    Closed,
}

type Sink = Box<dyn Fn(Emit) + Send + Sync>;

#[derive(Default)]
struct State {
    /// `Some` while output is held for a handoff.
    held: Option<Vec<u8>>,
    /// Output events passed on since the current listener started counting:
    /// since the session began, or since it was handed over.
    sent: u64,
    /// The session ended.
    closed: bool,
    /// It ended while held — the close still has to be announced.
    closed_pending: bool,
    /// The held output outgrew [`HOLD_CAP`] and was let through.
    overflowed: bool,
    /// The session was dropped: nothing more may be emitted under its id.
    shut: bool,
}

/// Why a hold cannot be handed over.
#[derive(Debug, PartialEq, Eq)]
pub enum HandOverError {
    /// Nothing is held (never was, or the handoff was already rolled back).
    NotHeld,
    /// The held output outgrew [`HOLD_CAP`]; it went to the old window.
    Overflowed,
}

pub struct OutputGate {
    sink: Sink,
    cap: usize,
    state: Mutex<State>,
}

impl OutputGate {
    /// A gate over an arbitrary sink (tests) with the default hold limit.
    pub fn new(sink: Sink) -> Self {
        Self::with_cap(sink, HOLD_CAP)
    }

    fn with_cap(sink: Sink, cap: usize) -> Self {
        Self {
            sink,
            cap,
            state: Mutex::new(State::default()),
        }
    }

    /// The gate of a live session: emits its `term://out` / `term://closed` events.
    pub fn for_session(app: AppHandle, session_id: &str) -> Arc<Self> {
        let out = output_event(session_id);
        let closed = closed_event(session_id);
        Arc::new(Self::new(Box::new(move |emit| {
            let _ = match emit {
                Emit::Output(bytes) => app.emit(&out, bytes),
                Emit::Closed => app.emit(&closed, ()),
            };
        })))
    }

    /// The emit is made under the lock on purpose: the order the sink sees is the
    /// order of the calls, and a hold starts exactly between two chunks.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Terminal output: passed on, or kept while held.
    pub fn output(&self, bytes: Vec<u8>) {
        let mut guard = self.lock();
        let s = &mut *guard;
        if s.shut {
            return;
        }
        let Some(held) = s.held.as_mut() else {
            s.sent += 1;
            (self.sink)(Emit::Output(bytes));
            return;
        };
        held.extend_from_slice(&bytes);
        if held.len() > self.cap {
            // Too much to keep: the hold gives way and the handoff fails.
            s.overflowed = true;
            self.flush(s);
        }
    }

    /// The session ended: announced now, or once the hold is over.
    pub fn closed(&self) {
        let mut s = self.lock();
        if s.shut || s.closed {
            return;
        }
        s.closed = true;
        if s.held.is_some() {
            s.closed_pending = true;
        } else {
            (self.sink)(Emit::Closed);
        }
    }

    /// Start holding output. Returns how many output events were passed on
    /// before the hold — the window giving the tab up waits until it has seen
    /// that many, and its terminal then holds everything up to this point.
    /// `None` when there is nothing to hand over: the session ended or was
    /// dropped, or a handoff is already in progress.
    pub fn hold(&self) -> Option<u64> {
        let mut s = self.lock();
        if s.shut || s.closed || s.held.is_some() {
            return None;
        }
        s.held = Some(Vec::new());
        s.overflowed = false;
        Some(s.sent)
    }

    /// Roll a hold back: what was held goes to the window that still has the
    /// tab, and its count simply continues. A no-op when nothing is held.
    pub fn resume(&self) {
        self.flush(&mut self.lock());
    }

    /// Complete a handoff: the new window listens from here on, so the count
    /// starts over and the held output is the first thing it sees.
    pub fn hand_over(&self) -> Result<(), HandOverError> {
        let mut s = self.lock();
        if s.held.is_none() {
            return Err(if s.overflowed {
                HandOverError::Overflowed
            } else {
                HandOverError::NotHeld
            });
        }
        s.sent = 0;
        self.flush(&mut s);
        Ok(())
    }

    /// Pass the held output on (as one event) and announce a close that waited.
    fn flush(&self, s: &mut State) {
        let Some(held) = s.held.take() else { return };
        if !held.is_empty() {
            s.sent += 1;
            (self.sink)(Emit::Output(held));
        }
        if std::mem::take(&mut s.closed_pending) {
            (self.sink)(Emit::Closed);
        }
    }

    /// Whether a handoff currently holds the output.
    pub fn is_held(&self) -> bool {
        self.lock().held.is_some()
    }

    /// The session is gone: drop what is held and emit nothing more. A reader
    /// that outlives its session (a killed local shell reaching EOF) would
    /// otherwise announce a close under an id a new session may already use.
    pub fn shut(&self) {
        let mut s = self.lock();
        s.shut = true;
        s.held = None;
        s.closed_pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A gate that records what it passes on.
    fn recording(cap: usize) -> (OutputGate, Arc<Mutex<Vec<Emit>>>) {
        let log: Arc<Mutex<Vec<Emit>>> = Arc::default();
        let sink_log = log.clone();
        let gate = OutputGate::with_cap(Box::new(move |e| sink_log.lock().unwrap().push(e)), cap);
        (gate, log)
    }

    fn out(s: &str) -> Emit {
        Emit::Output(s.as_bytes().to_vec())
    }

    fn take(log: &Arc<Mutex<Vec<Emit>>>) -> Vec<Emit> {
        std::mem::take(&mut log.lock().unwrap())
    }

    #[test]
    fn event_names_match_the_frontend() {
        assert_eq!(output_event("abc"), "term://out/abc");
        assert_eq!(closed_event("abc"), "term://closed/abc");
    }

    #[test]
    fn an_open_gate_passes_output_straight_through() {
        let (gate, log) = recording(HOLD_CAP);
        gate.output(b"a".to_vec());
        gate.output(b"b".to_vec());
        gate.closed();
        assert_eq!(take(&log), vec![out("a"), out("b"), Emit::Closed]);
    }

    #[test]
    fn a_hold_reports_how_much_was_sent_and_keeps_what_follows() {
        let (gate, log) = recording(HOLD_CAP);
        gate.output(b"one".to_vec());
        gate.output(b"two".to_vec());
        assert_eq!(gate.hold(), Some(2));
        gate.output(b"three".to_vec());
        gate.output(b"four".to_vec());
        // Nothing after the hold reached the old listener.
        assert_eq!(take(&log), vec![out("one"), out("two")]);
        assert!(gate.is_held());

        gate.hand_over().unwrap();
        // The new listener gets the held bytes in order, as one event…
        assert_eq!(take(&log), vec![out("threefour")]);
        // …and counts from it: a second handoff waits for exactly that one.
        assert_eq!(gate.hold(), Some(1));
    }

    #[test]
    fn a_rollback_gives_the_held_output_back_and_keeps_counting() {
        let (gate, log) = recording(HOLD_CAP);
        gate.output(b"a".to_vec());
        assert_eq!(gate.hold(), Some(1));
        gate.output(b"b".to_vec());
        gate.resume();
        assert_eq!(take(&log), vec![out("a"), out("b")]);
        // The old listener has now seen two events; the next hold says so.
        assert_eq!(gate.hold(), Some(2));
        // Rolling back a hold that kept nothing emits nothing.
        gate.resume();
        assert_eq!(take(&log), vec![]);
        assert_eq!(gate.hold(), Some(2));
    }

    #[test]
    fn a_close_during_a_hold_is_announced_after_the_held_output() {
        let (gate, log) = recording(HOLD_CAP);
        gate.hold().unwrap();
        gate.output(b"bye".to_vec());
        gate.closed();
        assert_eq!(take(&log), vec![]);
        gate.hand_over().unwrap();
        assert_eq!(take(&log), vec![out("bye"), Emit::Closed]);
    }

    #[test]
    fn a_session_that_ended_cannot_be_handed_over() {
        let (gate, _log) = recording(HOLD_CAP);
        gate.closed();
        assert_eq!(gate.hold(), None);
        assert_eq!(gate.hand_over(), Err(HandOverError::NotHeld));
    }

    #[test]
    fn only_one_handoff_at_a_time() {
        let (gate, _log) = recording(HOLD_CAP);
        assert_eq!(gate.hold(), Some(0));
        assert_eq!(gate.hold(), None);
    }

    #[test]
    fn held_output_past_the_limit_goes_to_the_old_listener_and_fails_the_handoff() {
        let (gate, log) = recording(4);
        gate.hold().unwrap();
        gate.output(b"ab".to_vec());
        assert_eq!(take(&log), vec![]);
        gate.output(b"cde".to_vec());
        // Over the limit: everything held is let through, nothing is dropped.
        assert_eq!(take(&log), vec![out("abcde")]);
        assert!(!gate.is_held());
        gate.output(b"f".to_vec());
        assert_eq!(take(&log), vec![out("f")]);
        // The new window is told why it gets nothing.
        assert_eq!(gate.hand_over(), Err(HandOverError::Overflowed));
        // A later attempt starts clean and waits for both events.
        assert_eq!(gate.hold(), Some(2));
        gate.resume();
        assert_eq!(gate.hand_over(), Err(HandOverError::NotHeld));
    }

    #[test]
    fn a_shut_gate_emits_nothing_more() {
        let (gate, log) = recording(HOLD_CAP);
        gate.hold().unwrap();
        gate.output(b"held".to_vec());
        gate.shut();
        gate.output(b"late".to_vec());
        gate.closed();
        gate.resume();
        assert_eq!(take(&log), vec![]);
        assert_eq!(gate.hold(), None);
    }

    #[test]
    fn terminal_output_goes_only_through_the_gate() {
        // Guard (v1.3.0, ADR 0017): a session's output and its close reach the
        // windows through its gate and nothing else. An `emit` of these events
        // anywhere else skips the hold of a tab handoff: those bytes land in the
        // window giving the tab up, after its snapshot was taken, and are lost.
        // The event names are private to this file; the guard keeps anyone from
        // spelling them out again. (Lines are not cut at `//` here — the names
        // contain it.)
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs")
                    || path.file_name().and_then(|n| n.to_str()) == Some("outgate.rs")
                {
                    continue;
                }
                let src = std::fs::read_to_string(&path).unwrap();
                for (i, line) in src.lines().enumerate() {
                    if names_a_terminal_event(line) {
                        offenders.push(format!(
                            "{}:{}",
                            path.strip_prefix(&root).unwrap().display(),
                            i + 1
                        ));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "terminal output emitted past the gate: {offenders:?}"
        );
    }

    /// Whether a source line builds one of the gate's event names: a string
    /// literal starting with it. Prose mentions in comments are not literals.
    fn names_a_terminal_event(line: &str) -> bool {
        if line.trim_start().starts_with("//") {
            return false;
        }
        ["\"term://out", "\"term://closed"]
            .iter()
            .any(|name| line.contains(name))
    }

    #[test]
    fn the_guard_recognises_an_emit_past_the_gate() {
        assert!(names_a_terminal_event(
            r#"    let _ = app.emit(&format!("term://out/{id}"), bytes);"#
        ));
        assert!(names_a_terminal_event(
            r#"let closed = "term://closed/".to_string();"#
        ));
        assert!(!names_a_terminal_event("/// emitted on `term://out/{id}`"));
        assert!(!names_a_terminal_event(
            "    // \"term://out\" is the gate's"
        ));
        assert!(!names_a_terminal_event(r#"app.emit("term://phase/x", ())"#));
    }

    #[test]
    fn a_close_is_announced_once() {
        let (gate, log) = recording(HOLD_CAP);
        gate.closed();
        gate.closed();
        assert_eq!(take(&log), vec![Emit::Closed]);
    }
}
