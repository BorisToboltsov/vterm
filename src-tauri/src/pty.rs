//! Local terminal sessions backed by a real OS pseudo-terminal (portable-pty,
//! which uses forkpty on Unix and ConPTY on Windows).
//!
//! Mirrors the event/command contract of [`crate::ssh`] so the same xterm.js
//! frontend drives both kinds of tab: output bytes and the close event go out
//! through the session's [`OutputGate`], on the same channels an SSH session
//! uses. Input/resize go through the same `write_to_terminal` / `resize_pty`
//! commands, which route by session id.

use crate::error::AppResult;
use crate::outgate::OutputGate;
use crate::recording::Recorder;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// Build a `PtySize` from terminal dimensions, clamping to at least 1×1 (a
/// zero-sized pty is rejected by the kernel).
fn pty_size(cols: u32, rows: u32) -> PtySize {
    PtySize {
        rows: rows.max(1) as u16,
        cols: cols.max(1) as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// A message to the per-session recorder thread. Recording file I/O runs on its
/// own thread, fed by an **unbounded** channel, so the sending side never blocks:
/// the PTY reader must keep draining ConPTY (on Windows a slow reader back-pressures
/// the pipe and the shell child stalls — the terminal freezes) and the input write
/// path must never wait on a disk flush. Previously the reader called
/// `Recorder::output` (a synchronous per-event file flush) inline under a shared
/// mutex, which is exactly what wedged local recording on Windows.
enum RecMsg {
    /// PTY output (from the reader thread) or a driver-panel audit mirror.
    Output(Vec<u8>),
    /// User keystrokes (from `write_input`).
    Input(Vec<u8>),
    /// A visible audit annotation (e.g. an in-app config edit).
    Annotate(String),
    /// Pause/resume (tab switched away / idle).
    SetPaused(bool),
    /// Finalize: flush to disk and reply with the recording's path.
    Stop(mpsc::Sender<PathBuf>),
}

/// Own the [`Recorder`] on a dedicated thread and apply messages in FIFO order —
/// the same order the reader/input paths produced them, so command reconstruction
/// (history recall, prompt tracking) is unaffected by the move off-thread. Exits
/// on an explicit `Stop` (flushing first, then replying with the path) or when all
/// senders drop (the `LocalPty` went away) — the `Recorder`/`BufWriter` flushes as
/// it drops at end of scope either way.
fn run_recorder(mut rec: Recorder, rx: mpsc::Receiver<RecMsg>) {
    while let Ok(msg) = rx.recv() {
        match msg {
            RecMsg::Output(d) => rec.output(&d),
            RecMsg::Input(d) => rec.input(&d),
            RecMsg::Annotate(t) => rec.annotate(&t),
            RecMsg::SetPaused(p) => rec.set_paused(p),
            RecMsg::Stop(reply) => {
                let path = rec.path().to_path_buf();
                drop(rec); // flush the BufWriter to disk before the caller reads the file
                let _ = reply.send(path);
                return;
            }
        }
    }
}

/// A live local shell running in an OS pseudo-terminal.
pub struct LocalPty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Sender to the active recorder thread, if recording (shared with the reader
    /// thread). Sending is non-blocking (unbounded channel) and the lock is held
    /// only for the send — never during file I/O — so neither the reader nor the
    /// input path can stall on recording. `None` when not recording.
    rec_tx: Arc<Mutex<Option<mpsc::Sender<RecMsg>>>>,
    /// Path of the active recording's file (`Some` while recording). Held here so
    /// `end_recording` can report the path even if the recorder thread has already
    /// gone — the file is created at start, so the post-stop dialog is never
    /// silently dropped (and we never falsely report "saved" with no path).
    rec_path: Mutex<Option<PathBuf>>,
    /// OS process id of the shell we spawned, used to read its working directory
    /// straight from the kernel (Phase 39.3). `None` when the platform didn't
    /// report one. See [`crate::proccwd`] for why we don't rely on OSC 7 here.
    pid: Option<u32>,
    /// Where the shell's output goes — the windows, or a handoff's hold (ADR 0017).
    gate: Arc<OutputGate>,
}

impl LocalPty {
    /// The gate this session's terminal output goes through.
    pub fn gate(&self) -> &Arc<OutputGate> {
        &self.gate
    }

    /// Fire-and-forget a message to the recorder thread (no-op if not recording).
    /// The lock is held only for the (non-blocking) channel send.
    fn record(&self, msg: RecMsg) {
        if let Ok(g) = self.rec_tx.lock() {
            if let Some(tx) = g.as_ref() {
                let _ = tx.send(msg);
            }
        }
    }

    /// Send user keystrokes to the local shell (recording input first if active).
    pub fn write_input(&self, data: Vec<u8>) -> AppResult<()> {
        // Queue the input to the recorder (cheap clone of a keystroke buffer) before
        // the echo it triggers can come back on the reader — keeps FIFO order.
        self.record(RecMsg::Input(data.clone()));
        let mut w = self.writer.lock().unwrap();
        w.write_all(&data)
            .map_err(|e| format!("local write failed: {e}"))?;
        w.flush().map_err(|e| format!("local flush failed: {e}"))?;
        Ok(())
    }

    /// Begin recording on this session: spawn the recorder thread and route future
    /// output/input/annotations to it. Replacing an active recorder drops its
    /// sender, so that thread finalizes and exits (the frontend guards against
    /// double-start regardless).
    pub fn begin_recording(&self, rec: Recorder) {
        *self.rec_path.lock().unwrap() = Some(rec.path().to_path_buf());
        let (tx, rx) = mpsc::channel::<RecMsg>();
        std::thread::spawn(move || run_recorder(rec, rx));
        *self.rec_tx.lock().unwrap() = Some(tx);
    }

    /// Stop recording and return the recording's file path. Asks the recorder
    /// thread to flush and prefers the path it confirms; but the file was created
    /// at start, so we fall back to the path we stored even if that thread has
    /// already gone (e.g. it panicked) — the stop must never silently swallow the
    /// post-stop dialog or report "saved" with no path. `None` only when nothing
    /// was recording.
    pub fn end_recording(&self) -> Option<PathBuf> {
        let tx = self.rec_tx.lock().unwrap().take();
        let known = self.rec_path.lock().unwrap().take();
        if let Some(tx) = tx {
            let (reply_tx, reply_rx) = mpsc::channel();
            if tx.send(RecMsg::Stop(reply_tx)).is_ok() {
                if let Ok(p) = reply_rx.recv() {
                    return Some(p);
                }
            }
        }
        known
    }

    /// Pause or resume the active recording (no-op if not recording).
    pub fn set_recording_paused(&self, paused: bool) {
        self.record(RecMsg::SetPaused(paused));
    }

    /// Write an audit annotation into the active recording (no-op if not recording).
    pub fn annotate_recording(&self, text: &str) {
        self.record(RecMsg::Annotate(text.to_string()));
    }

    /// Inject output bytes into the active recording (no-op if not recording).
    /// Used to audit git-panel mutations without writing to the live terminal.
    pub fn record_output(&self, data: &[u8]) {
        self.record(RecMsg::Output(data.to_vec()));
    }

    /// The shell's current working directory, read from the OS rather than from
    /// any escape sequence the shell may or may not emit (Phase 39.3).
    pub fn cwd(&self) -> Option<String> {
        crate::proccwd::process_cwd(self.pid?)
    }

    /// Inform the kernel (and the child) of a new terminal size.
    pub fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        self.master
            .lock()
            .unwrap()
            .resize(pty_size(cols, rows))
            .map_err(|e| format!("local resize failed: {e}").into())
    }
}

impl Drop for LocalPty {
    fn drop(&mut self) {
        // Terminate the child shell; its exit closes the pty, which ends the
        // reader thread (EOF) and lets it reap the process. That EOF must not be
        // announced: the id may already belong to a new session (a reconnect).
        self.gate.shut();
        let _ = self.killer.lock().unwrap().kill();
    }
}

/// Spawn the user's default shell in a fresh PTY and stream its output to the
/// frontend. The reader runs on a dedicated OS thread because portable-pty I/O
/// is blocking; it emits output chunks and a final close event on EOF.
pub fn open_local(
    app: AppHandle,
    session_id: String,
    cols: u32,
    rows: u32,
    shell: Option<String>,
) -> AppResult<LocalPty> {
    open_with_gate(OutputGate::for_session(app, &session_id), cols, rows, shell)
}

/// [`open_local`] over a given gate — the seam a test opens a real shell
/// through, with a gate that records instead of emitting to windows.
fn open_with_gate(
    gate: Arc<OutputGate>,
    cols: u32,
    rows: u32,
    shell: Option<String>,
) -> AppResult<LocalPty> {
    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(|e| format!("could not open pty: {e}"))?;

    // Explicit program (Windows cmd/PowerShell/pwsh preset or a custom path)
    // overrides the OS default; `None`/blank falls back to $SHELL on Unix and
    // %ComSpec% on Windows (portable-pty picks it). Program lookup honours PATH.
    let mut cmd = match shell
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(prog) => CommandBuilder::new(prog),
        None => CommandBuilder::new_default_prog(),
    };
    cmd.env("TERM", "xterm-256color");
    if let Some(dirs) = directories::UserDirs::new() {
        cmd.cwd(dirs.home_dir());
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start local shell: {e}"))?;
    // The child owns the slave now; drop our handle so EOF propagates on exit.
    drop(pair.slave);

    // Capture the pid before the reader thread takes ownership of `child`; it is
    // how we later ask the OS for the shell's cwd (Phase 39.3).
    let pid = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read pty: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write pty: {e}"))?;

    let gate_reader = gate.clone();
    let rec_tx: Arc<Mutex<Option<mpsc::Sender<RecMsg>>>> = Arc::new(Mutex::new(None));
    let rec_tx_reader = rec_tx.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // Hand the chunk to the recorder thread (if recording) — a
                    // non-blocking channel send, never a file write here — so the
                    // drain keeps up with ConPTY and the shell never back-pressures.
                    if let Ok(g) = rec_tx_reader.lock() {
                        if let Some(tx) = g.as_ref() {
                            let _ = tx.send(RecMsg::Output(buf[..n].to_vec()));
                        }
                    }
                    gate_reader.output(buf[..n].to_vec());
                }
            }
        }
        gate_reader.closed();
        // Reap the child so it doesn't linger as a zombie.
        let _ = child.wait();
    });

    Ok(LocalPty {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        rec_tx,
        rec_path: Mutex::new(None),
        pid,
        gate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording::{RecordMode, RecorderConfig};

    #[test]
    fn pty_size_clamps_to_at_least_one() {
        let z = pty_size(0, 0);
        assert_eq!((z.cols, z.rows), (1, 1));
        let s = pty_size(120, 40);
        assert_eq!((s.cols, s.rows), (120, 40));
    }

    /// A real shell behind a real PTY, its output held while its tab "moves":
    /// the reader thread, the gate and the kernel together. What the shell prints
    /// during the hold must not reach the old listener, and must reach the new
    /// one exactly once, before anything printed afterwards (ADR 0017).
    #[cfg(unix)]
    #[test]
    fn output_printed_during_a_handoff_arrives_once_and_in_order() {
        use crate::outgate::Emit;
        use std::time::{Duration, Instant};

        let log: Arc<Mutex<Vec<Emit>>> = Arc::default();
        let sink = log.clone();
        let gate = Arc::new(OutputGate::new(Box::new(move |e| {
            sink.lock().unwrap().push(e)
        })));
        let pty = match open_with_gate(gate.clone(), 80, 24, Some("/bin/sh".into())) {
            Ok(pty) => pty,
            // No pseudo-terminals in this environment (a locked-down container):
            // nothing to hold. Opening one is not what this test is about.
            Err(e) => {
                eprintln!("skipped: cannot open a pty here ({e})");
                return;
            }
        };
        let text = || -> String {
            let mut bytes = Vec::new();
            for e in log.lock().unwrap().iter() {
                if let Emit::Output(b) = e {
                    bytes.extend_from_slice(b);
                }
            }
            String::from_utf8_lossy(&bytes).into_owned()
        };
        let events = || log.lock().unwrap().len();
        let wait_for = |needle: &str| -> bool {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if text().contains(needle) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            false
        };
        // The tty echoes what is typed, so the commands spell their output as
        // arithmetic: only the shell's answer contains the number.
        pty.write_input(b"echo before-$((40+2))\n".to_vec())
            .unwrap();
        assert!(
            wait_for("before-42"),
            "the shell never answered: {}",
            text()
        );

        let sent = gate.hold().expect("a live session can be held");
        let seen = events();
        assert_eq!(
            sent as usize, seen,
            "the count the window waits for is the number of events it was sent"
        );
        pty.write_input(b"echo held-$((6*7))\n".to_vec()).unwrap();
        // Ample time for the shell to print — none of it may get through.
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(events(), seen, "output leaked past the hold: {}", text());

        gate.hand_over().expect("the hold is handed over");
        assert!(wait_for("held-42"), "held output never arrived: {}", text());
        // It came as the very next event, whole.
        match &log.lock().unwrap()[seen] {
            Emit::Output(first) => {
                assert!(String::from_utf8_lossy(first).contains("held-42"))
            }
            other => panic!("expected the held output, got {other:?}"),
        }
        pty.write_input(b"echo after-$((1+1))\n".to_vec()).unwrap();
        assert!(
            wait_for("after-2"),
            "the session went quiet after the handoff"
        );
        let all = text();
        assert_eq!(
            all.matches("held-42").count(),
            1,
            "held output repeated: {all}"
        );
        assert!(all.find("before-42") < all.find("held-42"));
        assert!(all.find("held-42") < all.find("after-2"));
    }

    /// A plain full-mode Recorder writing to `path` for the actor tests.
    fn recorder_at(path: &std::path::Path) -> Recorder {
        Recorder::start(RecorderConfig {
            path: path.to_path_buf(),
            cols: 80,
            rows: 24,
            title: "t",
            prompt: "",
            env_json: "{}",
            mask_enabled: false,
            mode: RecordMode::parse("full"),
        })
        .unwrap()
    }

    #[test]
    fn recorder_actor_records_then_flushes_and_returns_path_on_stop() {
        // The fix: recording runs on its own thread fed by a channel, so the reader
        // and input paths only *send* (never touch the file). This drives that
        // thread directly: queued output + input are recorded, and Stop flushes to
        // disk and hands back the path.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let (tx, rx) = mpsc::channel::<RecMsg>();
        let rec = recorder_at(&path);
        let handle = std::thread::spawn(move || run_recorder(rec, rx));

        tx.send(RecMsg::Input(b"whoami\r".to_vec())).unwrap();
        tx.send(RecMsg::Output(b"root\r\n".to_vec())).unwrap();
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(RecMsg::Stop(reply_tx)).unwrap();

        // Stop replies with the path only after the queue is drained and flushed.
        assert_eq!(reply_rx.recv().unwrap(), path);
        handle.join().unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content.contains("root"),
            "output should be on disk: {content}"
        );
        assert!(
            content.contains("\"i\""),
            "input event should be on disk: {content}"
        );
    }

    #[test]
    fn recorder_actor_flushes_on_sender_drop() {
        // When the LocalPty is dropped without an explicit Stop (tab closed abruptly),
        // all senders drop and the actor still finalizes the file (BufWriter flushes
        // as the Recorder drops at end of scope).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let (tx, rx) = mpsc::channel::<RecMsg>();
        let rec = recorder_at(&path);
        let handle = std::thread::spawn(move || run_recorder(rec, rx));

        tx.send(RecMsg::Output(b"orphaned\r\n".to_vec())).unwrap();
        drop(tx); // no Stop — mirrors LocalPty being dropped
        handle.join().unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content.contains("orphaned"),
            "output should survive an abrupt drop: {content}"
        );
    }
}
