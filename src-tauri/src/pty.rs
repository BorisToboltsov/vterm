//! Local terminal sessions backed by a real OS pseudo-terminal (portable-pty,
//! which uses forkpty on Unix and ConPTY on Windows).
//!
//! Mirrors the event/command contract of [`crate::ssh`] so the same xterm.js
//! frontend drives both kinds of tab: output bytes are emitted on
//! `term://out/{id}` and the close event on `term://closed/{id}`. Input/resize
//! go through the same `write_to_terminal` / `resize_pty` commands, which route
//! by session id.

use crate::error::AppResult;
use crate::recording::Recorder;
use crate::ssh::{closed_event, output_event};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

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

/// A live local shell running in an OS pseudo-terminal.
pub struct LocalPty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Active session recorder, if recording (shared with the reader thread).
    recorder: Arc<Mutex<Option<Recorder>>>,
}

impl LocalPty {
    /// Send user keystrokes to the local shell (recording input first if active).
    pub fn write_input(&self, data: Vec<u8>) -> AppResult<()> {
        if let Ok(mut g) = self.recorder.lock() {
            if let Some(r) = g.as_mut() {
                r.input(&data);
            }
        }
        let mut w = self.writer.lock().unwrap();
        w.write_all(&data)
            .map_err(|e| format!("local write failed: {e}"))?;
        w.flush().map_err(|e| format!("local flush failed: {e}"))?;
        Ok(())
    }

    /// Begin recording on this session.
    pub fn begin_recording(&self, rec: Recorder) {
        *self.recorder.lock().unwrap() = Some(rec);
    }

    /// Stop recording; returns the file path if a recording was active.
    pub fn end_recording(&self) -> Option<PathBuf> {
        self.recorder
            .lock()
            .unwrap()
            .take()
            .map(|r| r.path().to_path_buf())
    }

    /// Pause or resume the active recording (no-op if not recording).
    pub fn set_recording_paused(&self, paused: bool) {
        if let Some(rec) = self.recorder.lock().unwrap().as_mut() {
            rec.set_paused(paused);
        }
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
        // reader thread (EOF) and lets it reap the process.
        let _ = self.killer.lock().unwrap().kill();
    }
}

/// Spawn the user's default shell in a fresh PTY and stream its output to the
/// frontend. The reader runs on a dedicated OS thread because portable-pty I/O
/// is blocking; it emits output chunks and a final close event on EOF.
pub fn open_local(app: AppHandle, session_id: String, cols: u32, rows: u32) -> AppResult<LocalPty> {
    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(|e| format!("could not open pty: {e}"))?;

    // Default shell: $SHELL on Unix, %ComSpec% on Windows (portable-pty picks it).
    let mut cmd = CommandBuilder::new_default_prog();
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

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read pty: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write pty: {e}"))?;

    let out = output_event(&session_id);
    let closed = closed_event(&session_id);
    let recorder: Arc<Mutex<Option<Recorder>>> = Arc::new(Mutex::new(None));
    let rec_for_reader = recorder.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut g) = rec_for_reader.lock() {
                        if let Some(r) = g.as_mut() {
                            r.output(&buf[..n]);
                        }
                    }
                    if app.emit(&out, buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app.emit(&closed, ());
        // Reap the child so it doesn't linger as a zombie.
        let _ = child.wait();
    });

    Ok(LocalPty {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        recorder,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_size_clamps_to_at_least_one() {
        let z = pty_size(0, 0);
        assert_eq!((z.cols, z.rows), (1, 1));
        let s = pty_size(120, 40);
        assert_eq!((s.cols, s.rows), (120, 40));
    }
}
