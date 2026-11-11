//! Where an answer of the assistant goes while its tab moves (v1.36, ADR 0058).
//!
//! A streaming answer is a chain of `ai://out|think|done|error/{stream}` events,
//! heard by the chat store of the window that asked. A tab used to wait for it
//! to finish before it could move to another window: tokens sent while it was
//! on its way would be heard by the window it left and lost to the one it went
//! to. Now the stream goes through a gate, as the terminal's output does
//! ([`crate::outgate`]): while the tab moves the gate **holds** the pieces, the
//! window giving the tab up waits until it has heard every piece sent before the
//! hold and packs the conversation, the window taking it listens — and only then
//! does the held part flow, to it.
//!
//! A stream is found by the session it answers in (`AiChatRequest.session_id`):
//! the handoff knows the session, not the stream.
//!
//! The gate is plain logic over a sink closure, tested without a Tauri runtime.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

/// How much of an answer a handoff may hold. A model does not write this much
/// while a window starts; past it the hold gives way and the handoff fails.
pub const HOLD_CAP: usize = 1024 * 1024;

/// A piece of a streaming answer, as it goes out.
#[derive(Debug, Clone, PartialEq)]
pub enum Piece {
    Out(String),
    Think(String),
    /// The end, with the token tally (or null) as JSON.
    Done(serde_json::Value),
    Error(String),
}

impl Piece {
    fn size(&self) -> usize {
        match self {
            Piece::Out(s) | Piece::Think(s) | Piece::Error(s) => s.len(),
            Piece::Done(_) => 64,
        }
    }

    fn ends(&self) -> bool {
        matches!(self, Piece::Done(_) | Piece::Error(_))
    }
}

type Sink = Box<dyn Fn(Piece) + Send + Sync>;

#[derive(Default)]
struct State {
    held: Option<Vec<Piece>>,
    held_bytes: usize,
    /// Pieces passed on since the current listener started counting.
    sent: u64,
    /// The last piece (done or error) has been passed on: nothing to hold.
    ended: bool,
    overflowed: bool,
}

/// Why a hold cannot be handed over.
#[derive(Debug, PartialEq, Eq)]
pub enum HandOverError {
    NotHeld,
    Overflowed,
}

impl std::fmt::Display for HandOverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            HandOverError::NotHeld => "the answer was not held",
            HandOverError::Overflowed => "the held answer overflowed",
        })
    }
}

pub struct StreamGate {
    sink: Sink,
    cap: usize,
    state: Mutex<State>,
}

impl StreamGate {
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

    /// Emitted under the lock: the order the sink sees is the order of the calls.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A piece of the answer: passed on, or kept while held.
    pub fn send(&self, piece: Piece) {
        let mut guard = self.lock();
        let s = &mut *guard;
        let Some(held) = s.held.as_mut() else {
            s.sent += 1;
            s.ended |= piece.ends();
            (self.sink)(piece);
            return;
        };
        s.held_bytes += piece.size();
        held.push(piece);
        if s.held_bytes > self.cap {
            s.overflowed = true;
            self.flush(s);
        }
    }

    /// Start holding. Returns how many pieces were passed on before — the window
    /// giving the tab up waits until it has heard that many. None when there is
    /// nothing to hold: the answer is over, or a handoff already holds it.
    pub fn hold(&self) -> Option<u64> {
        let mut s = self.lock();
        if s.ended || s.held.is_some() {
            return None;
        }
        s.held = Some(Vec::new());
        s.held_bytes = 0;
        s.overflowed = false;
        Some(s.sent)
    }

    /// Roll a hold back: what was held goes to the window that still has the tab.
    pub fn resume(&self) {
        self.flush(&mut self.lock());
    }

    /// Whether the hold gave way — a handoff over it must fail.
    pub fn overflowed(&self) -> bool {
        self.lock().overflowed
    }

    /// Complete a handoff: the new window listens now, the held pieces go to it.
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

    /// Whether the answer is over and nothing of it is held — the gate can go.
    fn spent(&self) -> bool {
        let s = self.lock();
        s.ended && s.held.is_none()
    }

    fn flush(&self, s: &mut State) {
        let Some(held) = s.held.take() else { return };
        s.held_bytes = 0;
        for piece in held {
            s.sent += 1;
            s.ended |= piece.ends();
            (self.sink)(piece);
        }
    }
}

// ── The streams under way, by the session they answer in ────────────────────

struct Entry {
    session: Option<String>,
    gate: Arc<StreamGate>,
}

fn streams() -> MutexGuard<'static, HashMap<String, Entry>> {
    static M: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    M.get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// A stream starts: its pieces go through `gate` from now on.
pub fn open(stream_id: &str, session: Option<String>, gate: Arc<StreamGate>) {
    streams().insert(stream_id.to_string(), Entry { session, gate });
}

/// The stream's request ended. Its gate stays while a handoff holds something
/// of it — the end is among the held pieces — and goes with the hold.
pub fn close(stream_id: &str) {
    let mut all = streams();
    if all
        .get(stream_id)
        .is_some_and(|e| e.gate.lock().held.is_none())
    {
        all.remove(stream_id);
    }
}

fn of_session(session: &str) -> Vec<(String, Arc<StreamGate>)> {
    streams()
        .iter()
        .filter(|(_, e)| e.session.as_deref() == Some(session))
        .map(|(id, e)| (id.clone(), e.gate.clone()))
        .collect()
}

fn drop_spent() {
    streams().retain(|_, e| !e.gate.spent());
}

/// The answer under way in `session`, held for a handoff: its stream id and how
/// many pieces were passed on before the hold. None — no answer is streaming.
pub fn hold_session(session: &str) -> Option<(String, u64)> {
    of_session(session)
        .into_iter()
        .find_map(|(id, gate)| gate.hold().map(|sent| (id, sent)))
}

/// Roll back: the held pieces go to the window that still has the tab.
pub fn resume_session(session: &str) {
    for (_, gate) in of_session(session) {
        gate.resume();
    }
    drop_spent();
}

/// Whether a hold in `session` gave way — the handoff has to fail.
pub fn overflowed_in(session: &str) -> bool {
    of_session(session)
        .iter()
        .any(|(_, gate)| gate.overflowed())
}

/// Complete a handoff: the window that took the tab listens; the held pieces go.
pub fn hand_over_session(session: &str) -> Result<(), HandOverError> {
    let mut result = Ok(());
    for (_, gate) in of_session(session) {
        match gate.hand_over() {
            Ok(()) | Err(HandOverError::NotHeld) => {}
            Err(e) => result = Err(e),
        }
    }
    drop_spent();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recording(cap: usize) -> (StreamGate, Arc<Mutex<Vec<Piece>>>) {
        let log: Arc<Mutex<Vec<Piece>>> = Arc::default();
        let sink = log.clone();
        let gate = StreamGate::with_cap(Box::new(move |p| sink.lock().unwrap().push(p)), cap);
        (gate, log)
    }

    fn take(log: &Arc<Mutex<Vec<Piece>>>) -> Vec<Piece> {
        std::mem::take(&mut log.lock().unwrap())
    }

    fn out(s: &str) -> Piece {
        Piece::Out(s.into())
    }

    #[test]
    fn what_is_sent_during_a_hold_reaches_the_new_window_once_and_in_order() {
        let (gate, log) = recording(HOLD_CAP);
        gate.send(out("Dis"));
        gate.send(Piece::Think("hmm".into()));
        // Two pieces were passed on: the old window waits until it heard both.
        assert_eq!(gate.hold(), Some(2));
        gate.send(out("k "));
        gate.send(out("full"));
        gate.send(Piece::Done(serde_json::Value::Null));
        assert_eq!(take(&log), vec![out("Dis"), Piece::Think("hmm".into())]);
        gate.hand_over().unwrap();
        assert_eq!(
            take(&log),
            vec![out("k "), out("full"), Piece::Done(serde_json::Value::Null)]
        );
        // Over: there is nothing left to hold.
        assert_eq!(gate.hold(), None);
    }

    #[test]
    fn a_rolled_back_hold_gives_the_pieces_to_the_window_that_kept_the_tab() {
        let (gate, log) = recording(HOLD_CAP);
        gate.send(out("a"));
        assert_eq!(gate.hold(), Some(1));
        assert_eq!(gate.hold(), None, "one handoff at a time");
        gate.send(out("b"));
        gate.resume();
        gate.send(out("c"));
        assert_eq!(take(&log), vec![out("a"), out("b"), out("c")]);
        assert_eq!(gate.hand_over(), Err(HandOverError::NotHeld));
    }

    #[test]
    fn a_hold_that_outgrows_its_limit_gives_way_and_the_handoff_fails() {
        let (gate, log) = recording(8);
        gate.hold().unwrap();
        gate.send(out("12345"));
        assert!(take(&log).is_empty());
        gate.send(out("67890"));
        // Let through, to the window that still has the tab, nothing lost.
        assert_eq!(take(&log), vec![out("12345"), out("67890")]);
        assert!(gate.overflowed());
        assert_eq!(gate.hand_over(), Err(HandOverError::Overflowed));
    }

    #[test]
    fn a_stream_is_found_by_its_session_and_goes_once_it_is_over() {
        let gate = Arc::new(StreamGate::new(Box::new(|_| {})));
        open("st-1", Some("sess-a".into()), gate.clone());
        assert_eq!(hold_session("sess-b"), None);
        assert_eq!(hold_session("sess-a"), Some(("st-1".into(), 0)));
        gate.send(Piece::Done(serde_json::Value::Null));
        // The request ended while held: the gate stays until the hold is over.
        close("st-1");
        assert!(!of_session("sess-a").is_empty());
        assert!(!overflowed_in("sess-a"));
        hand_over_session("sess-a").unwrap();
        assert!(of_session("sess-a").is_empty());
        // A stream that ends unheld goes with its request.
        let other = Arc::new(StreamGate::new(Box::new(|_| {})));
        open("st-2", Some("sess-c".into()), other);
        close("st-2");
        assert!(of_session("sess-c").is_empty());
        resume_session("nobody");
    }

    /// The source of `file` without its tests and its `//` comments.
    fn code(file: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(file);
        let src = std::fs::read_to_string(path).unwrap();
        let live = src.split("#[cfg(test)]").next().unwrap_or("");
        live.lines()
            .map(|l| l.split(" //").next().unwrap_or(l))
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The body of `fn name(` in `src`, up to the next item at the same depth.
    fn body<'a>(src: &'a str, name: &str) -> &'a str {
        let at = src
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("fn {name} is gone"));
        let rest = &src[at..];
        let end = rest[1..]
            .find("\n#[tauri::command]")
            .or_else(|| rest[1..].find("\nfn "))
            .or_else(|| rest[1..].find("\npub "))
            .map_or(rest.len(), |e| e + 1);
        &rest[..end]
    }

    /// Guard (v1.36, ADR 0058): the pieces of an answer reach the windows only
    /// through its gate. An emit of an `ai://…` event anywhere else would skip
    /// the hold of a tab handoff, and those tokens would land in the window the
    /// tab left, after its conversation was packed.
    pub(crate) fn emits_past_the_gate(ai: &str) -> Vec<String> {
        let gate = body(ai, "stream_gate");
        let rest = ai.replacen(gate, "", 1);
        ["out_event(", "think_event(", "done_event(", "error_event("]
            .iter()
            .filter(|name| rest.matches(*name).count() > 1)
            .map(|name| format!("{name}…) emitted past the gate"))
            .collect()
    }

    /// Guard (v1.36): a handoff holds the answer with the output, gives it back
    /// on every rollback, and hands it to the window that took the tab.
    pub(crate) fn handoffs_that_drop_the_answer(appwin: &str) -> Vec<String> {
        let mut out = Vec::new();
        if !body(appwin, "detach_begin").contains("aigate::hold_session(&session_id)") {
            out.push("detach_begin does not hold the answer".to_string());
        }
        if !body(appwin, "detach_abort").contains("aigate::resume_session(&session_id)") {
            out.push("detach_abort does not give the answer back".to_string());
        }
        let commit = body(appwin, "detach_commit");
        if commit
            .matches("aigate::resume_session(&session_id);")
            .count()
            < commit.matches("gate.resume();").count()
        {
            out.push(
                "a rollback of detach_commit gives the output back but not the answer".to_string(),
            );
        }
        if !body(appwin, "attach_session").contains("aigate::hand_over_session(&session_id)") {
            out.push("attach_session does not hand the answer over".to_string());
        }
        out
    }

    #[test]
    fn the_assistants_answer_goes_only_through_its_gate_and_moves_with_its_tab() {
        let ai = code("ai.rs");
        let appwin = code("appwin.rs");
        assert_eq!(emits_past_the_gate(&ai), Vec::<String>::new());
        assert_eq!(handoffs_that_drop_the_answer(&appwin), Vec::<String>::new());
        // And each check catches what it exists for.
        let leaky = ai.replacen(
            "gate.send(Piece::Out(t));",
            "let _ = app.emit(&out_event(&req.stream_id), t);",
            1,
        );
        assert_eq!(emits_past_the_gate(&leaky).len(), 1);
        let forgetful = appwin.replacen(
            "    crate::aigate::resume_session(&session_id);\n    Ok(())",
            "    Ok(())",
            1,
        );
        assert!(handoffs_that_drop_the_answer(&forgetful)
            .contains(&"detach_abort does not give the answer back".to_string()));
        let one = appwin.replacen("crate::aigate::resume_session(&session_id);", "", 2);
        assert!(!handoffs_that_drop_the_answer(&one).is_empty());
        let held = appwin.replacen(
            "crate::aigate::hold_session(&session_id)",
            "None::<(String, u64)>",
            1,
        );
        assert!(handoffs_that_drop_the_answer(&held)
            .contains(&"detach_begin does not hold the answer".to_string()));
    }
}
