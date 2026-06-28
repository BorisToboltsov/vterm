//! Session recording in **asciicast v2** format (the asciinema standard): an
//! NDJSON file with a header line then `[t, "o"|"i", data]` event lines for
//! output and input, with relative timings. Both stdin and stdout pass through
//! Rust (see [`crate::ssh`] / [`crate::pty`]), so a `Recorder` lives inside each
//! session and is fed from the reader task (output) and `write_input` (input).
//!
//! Privacy: input is recorded too (so the transcript can show *commands*, useful
//! for later AI analysis), but a best-effort heuristic redacts the line typed
//! right after a `password:`-style prompt — the secret is replaced by a marker.
//! The SSH auth password never reaches this stream (it goes through `connect`).

use crate::error::AppResult;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Marker written in place of a redacted (password) input line.
const REDACTED: &str = "\u{2039}redacted\u{203a}";

/// Per-event gap (seconds) for "typing" in untimed modes — the per-char command
/// echo in commands mode and the per-keystroke input in fullNoTiming. Fixed, so
/// typing replays at the same constant speed in both modes regardless of how fast
/// the user actually typed.
const TYPING_STEP: f64 = 0.05;

/// Directory where recordings (`*.cast`) are stored.
pub fn recordings_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("su", "vcore", "vterm").map(|d| d.data_dir().join("recordings"))
}

/// Current unix time in seconds (0 if the clock is before the epoch).
fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The asciicast v2 header line (no trailing newline). `timed` is a vterm
/// extension flag (custom header keys are allowed by the format): `false` marks
/// a synthetic-timing recording (commands / fullNoTiming) so the player can play
/// it back at a calmer, slowed-down speed scale. `title` at creation is the server
/// name, so it's also stored as a separate `server` field that survives a later
/// rename (the user can retitle a recording, but the source server is preserved).
pub fn asciicast_header(cols: u32, rows: u32, timestamp: u64, title: &str, timed: bool) -> String {
    serde_json::json!({
        "version": 2,
        "width": cols.max(1),
        "height": rows.max(1),
        "timestamp": timestamp,
        "title": title,
        "server": title,
        "timed": timed,
        "env": { "TERM": "xterm-256color" },
    })
    .to_string()
}

/// Rewrite the asciicast header's `title` and `description` (a vterm custom
/// field), preserving every event line and all other header fields. Returns the
/// updated file content, or `None` if the first line isn't a JSON object header.
pub fn with_updated_meta(content: &str, title: &str, description: &str) -> Option<String> {
    let nl = content.find('\n')?;
    let (first, rest) = content.split_at(nl); // `rest` keeps the leading '\n'
    let mut header: serde_json::Value = serde_json::from_str(first.trim()).ok()?;
    if !header.is_object() {
        return None;
    }
    header["title"] = serde_json::json!(title);
    header["description"] = serde_json::json!(description);
    Some(format!("{header}{rest}"))
}

/// Record the wall-clock end time into the header's `vterm.endedAt` (added on
/// stop, since the header is written at start). Preserves events and other fields.
pub fn with_ended_at(content: &str, ended_at: u64) -> Option<String> {
    let nl = content.find('\n')?;
    let (first, rest) = content.split_at(nl);
    let mut header: serde_json::Value = serde_json::from_str(first.trim()).ok()?;
    if !header.is_object() {
        return None;
    }
    if !header.get("vterm").is_some_and(|v| v.is_object()) {
        header["vterm"] = serde_json::json!({});
    }
    header["vterm"]["endedAt"] = serde_json::json!(ended_at);
    Some(format!("{header}{rest}"))
}

/// One asciicast event line `[t, kind, data]` (no trailing newline). `t` is
/// rounded to microseconds; `data` is JSON-escaped by serde.
pub fn event_line(t: f64, kind: char, data: &str) -> String {
    let t = (t * 1_000_000.0).round() / 1_000_000.0;
    serde_json::to_string(&(t, kind.to_string(), data)).unwrap_or_default()
}

/// Make a filesystem-safe slug from a recording title (keeps a-z0-9-_, caps len).
pub fn sanitize_title(title: &str) -> String {
    let mut out: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    if out.trim_matches('_').is_empty() {
        out = "session".into();
    }
    out
}

/// Previous UTF-8 character boundary before byte index `i` in `buf` (0 if none).
/// Used to move the per-line edit cursor left by a whole character, not a byte.
fn prev_char_boundary(buf: &[u8], i: usize) -> usize {
    let mut j = i.min(buf.len());
    if j == 0 {
        return 0;
    }
    j -= 1;
    while j > 0 && (buf[j] & 0xc0) == 0x80 {
        j -= 1; // step over UTF-8 continuation bytes
    }
    j
}

/// Next UTF-8 character boundary after byte index `i` in `buf` (len if none).
fn next_char_boundary(buf: &[u8], i: usize) -> usize {
    let mut j = i;
    if j >= buf.len() {
        return buf.len();
    }
    j += 1;
    while j < buf.len() && (buf[j] & 0xc0) == 0x80 {
        j += 1;
    }
    j
}

/// Strip ANSI/VT escape sequences from raw output, keeping printable bytes and
/// CR/LF. Used to recover the visible text of a history-recall redraw and to
/// track the current prompt line.
fn strip_ansi(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut st = EscState::None;
    for &b in raw {
        match st {
            EscState::None => {
                if b == 0x1b {
                    st = EscState::AfterEsc;
                } else {
                    out.push(b);
                }
            }
            EscState::AfterEsc => {
                st = match b {
                    b'[' => EscState::Csi,
                    b'O' => EscState::Ss3,
                    _ => EscState::None,
                };
            }
            EscState::Ss3 => st = EscState::None,
            EscState::Csi => {
                if (0x40..=0x7e).contains(&b) {
                    st = EscState::None;
                }
            }
        }
    }
    out
}

/// The last visible line of already-ANSI-stripped output: the text after the
/// final CR/LF, with control bytes dropped and trailing blanks trimmed. A shell
/// redraws a recalled history line as `CR prompt command <clear>`, so this yields
/// `prompt command`.
fn last_visible_line(stripped: &[u8]) -> String {
    let start = stripped
        .iter()
        .rposition(|&b| b == b'\r' || b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    String::from_utf8_lossy(&stripped[start..])
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Heuristic: does the recent output tail look like a password/passphrase prompt?
pub fn is_password_prompt(tail: &str) -> bool {
    let t = tail.trim_end().to_lowercase();
    t.ends_with("password:")
        || t.ends_with("passphrase:")
        || t.contains("[sudo] password")
        || t.contains("password for ")
}

/// What a recorder captures. `timed` controls whether event timestamps are real
/// (replayable) or zeroed; `per_line` records input as one committed line per
/// Enter (collapsing keystrokes/editing) instead of every keystroke.
#[derive(Clone, Copy)]
pub struct RecordMode {
    pub timed: bool,
    pub per_line: bool,
}

impl RecordMode {
    /// The frontend id this mode round-trips to (stored in the header metadata).
    pub fn label(&self) -> &'static str {
        match (self.timed, self.per_line) {
            (false, true) => "commands",
            (false, false) => "fullNoTiming",
            _ => "full",
        }
    }

    /// Parse the frontend mode id; unknown → full (timed, per-keystroke).
    pub fn parse(mode: &str) -> RecordMode {
        match mode {
            "fullNoTiming" => RecordMode {
                timed: false,
                per_line: false,
            },
            "commands" => RecordMode {
                timed: false,
                per_line: true,
            },
            _ => RecordMode {
                timed: true,
                per_line: false,
            },
        }
    }
}

/// State of the small ANSI escape-sequence parser used to drop arrow keys and
/// other control sequences from a `per_line` command buffer.
#[derive(Clone, Copy, PartialEq)]
enum EscState {
    None,
    AfterEsc, // just saw ESC — the next byte selects the sequence form
    Csi,      // inside ESC[ (CSI) — collect params until the final byte
    Ss3,      // inside ESC O (SS3) — the next single byte is the final
}

/// A live recorder writing asciicast events for one session.
pub struct Recorder {
    writer: BufWriter<File>,
    start: Instant,
    path: PathBuf,
    mode: RecordMode,
    mask_enabled: bool,
    mask_input: bool,               // inside a password line right now
    mask_marked: bool,              // already emitted the redaction marker for this line
    tail: String,                   // recent output, for prompt detection
    line_buf: Vec<u8>,              // accumulated input line (per_line mode)
    cursor: usize,                  // per_line: insertion point within line_buf (byte index)
    typing: bool,                   // per_line: user is editing a line → suppress echo output
    esc: EscState,     // per_line: ANSI escape-sequence parser (interprets arrows etc.)
    esc_seq: Vec<u8>,  // per_line: CSI parameter bytes collected between '[' and the final
    out_line: Vec<u8>, // per_line: current visible line of *recorded* output (to know the prompt)
    cur_prompt: String, // per_line: the prompt the current command line started with
    pending_edit: bool, // per_line: a shell-side line edit (history/tab) is in flight
    pending_raw: Vec<u8>, // per_line: captured redraw/echo output of that edit
    synthetic: f64,    // synthetic clock for untimed modes (advances per event step)
    paused: bool,      // recording paused (tab switched away / idle) → drop output
    pause_started: Option<Instant>, // when the current pause began (timed offset)
    paused_total: Duration, // accumulated paused time, subtracted from timed stamps
}

impl Recorder {
    /// Create the file, write the header, and start the clock. `prompt` is the
    /// shell prompt line currently on screen (captured by the frontend at REC
    /// time): it's printed *before* recording begins, so the first command would
    /// otherwise have no prompt in front of it. We seed it as the first output
    /// event so every recorded command — in all modes — is preceded by a prompt.
    #[allow(clippy::too_many_arguments)] // cohesive recorder construction
    pub fn start(
        path: PathBuf,
        cols: u32,
        rows: u32,
        title: &str,
        prompt: &str,
        env_json: &str,
        mask_enabled: bool,
        mode: RecordMode,
    ) -> AppResult<Recorder> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create recordings dir: {e}"))?;
        }
        let file = File::create(&path).map_err(|e| format!("create recording: {e}"))?;
        let mut writer = BufWriter::new(file);
        let now = now_unix();
        // Build the header, then attach a `vterm` metadata object: the host/env info
        // gathered by the frontend (hostname/ip/user/os/kernel/appVersion) plus the
        // record mode and start time. `endedAt` is added on stop.
        let mut header: serde_json::Value =
            serde_json::from_str(&asciicast_header(cols, rows, now, title, mode.timed))
                .unwrap_or_else(|_| serde_json::json!({}));
        let mut vterm = serde_json::from_str::<serde_json::Value>(env_json)
            .ok()
            .filter(serde_json::Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}));
        vterm["recordMode"] = serde_json::json!(mode.label());
        vterm["startedAt"] = serde_json::json!(now);
        header["vterm"] = vterm;
        writeln!(writer, "{header}").map_err(|e| format!("write recording header: {e}"))?;
        if !prompt.is_empty() {
            writeln!(writer, "{}", event_line(0.0, 'o', prompt))
                .map_err(|e| format!("write recording prompt: {e}"))?;
        }
        writer.flush().ok();
        Ok(Recorder {
            writer,
            start: Instant::now(),
            path,
            mode,
            mask_enabled,
            mask_input: false,
            mask_marked: false,
            tail: String::new(),
            line_buf: Vec::new(),
            cursor: 0,
            typing: false,
            esc: EscState::None,
            esc_seq: Vec::new(),
            out_line: prompt.as_bytes().to_vec(),
            cur_prompt: prompt.to_string(),
            pending_edit: false,
            pending_raw: Vec::new(),
            synthetic: 0.0,
            paused: false,
            pause_started: None,
            paused_total: Duration::ZERO,
        })
    }

    /// Emit one event. For untimed modes the synthetic clock advances by `step`
    /// (so different events — typing vs gaps — can have different paces). For timed
    /// recordings, paused spans are subtracted so playback has no long idle gaps.
    fn emit_step(&mut self, kind: char, data: &str, step: f64) {
        let t = if self.mode.timed {
            self.start
                .elapsed()
                .saturating_sub(self.paused_total)
                .as_secs_f64()
        } else {
            let v = self.synthetic;
            self.synthetic += step;
            v
        };
        let _ = writeln!(self.writer, "{}", event_line(t, kind, data));
        let _ = self.writer.flush();
    }

    /// Pause/resume recording. While paused, output is dropped (don't waste disk on
    /// background streams when the tab is unwatched or idle); input always resumes
    /// it (see `input`). The paused duration is tracked to keep timed playback gapless.
    pub fn set_paused(&mut self, paused: bool) {
        if paused && !self.paused {
            self.paused = true;
            self.pause_started = Some(Instant::now());
        } else if !paused && self.paused {
            self.paused = false;
            if let Some(started) = self.pause_started.take() {
                self.paused_total += started.elapsed();
            }
        }
    }

    fn emit(&mut self, kind: char, data: &str) {
        self.emit_step(kind, data, TYPING_STEP);
    }

    /// Record an audit annotation (e.g. an in-app config edit) as a visible cyan
    /// output line. Written even while paused — these are deliberate, low-volume
    /// events worth keeping in the audit trail.
    pub fn annotate(&mut self, text: &str) {
        let line = format!("\r\n\u{1b}[36m[vterm] {text}\u{1b}[0m\r\n");
        self.emit_step('o', &line, 0.0);
    }

    /// Record an output chunk and update password-prompt detection. In `per_line`
    /// mode, output produced while the user is typing (the shell's echo of the
    /// line being edited) is suppressed — only command results are kept.
    pub fn output(&mut self, data: &[u8]) {
        if self.paused {
            return; // paused (tab unwatched / idle): drop output to save disk
        }
        let s = String::from_utf8_lossy(data);
        if !(self.mode.per_line && self.typing) {
            // Output appears at once (step 0), never dribbled out line by line: in
            // untimed modes the pacing comes only from the typed *input*, both paced
            // by TYPING_STEP — the per-char command echo in commands mode, the
            // per-keystroke input events in fullNoTiming — so both modes play back
            // identically: command "types" at the same speed, result shows at once.
            // emit_step ignores the step for real-timed recordings (real elapsed).
            self.emit_step('o', &s, 0.0);
            if self.mode.per_line {
                // Track the current visible line of recorded output: when the user
                // starts a command its content is the shell prompt (used to strip
                // the prompt off a history-recall redraw).
                for &b in &strip_ansi(data) {
                    match b {
                        b'\n' | b'\r' => self.out_line.clear(),
                        b if b >= 0x20 && b != 0x7f => self.out_line.push(b),
                        _ => {}
                    }
                }
            }
        } else if self.pending_edit {
            // Suppressed output while a history/tab edit is in flight is the shell
            // redrawing/completing the line — capture it to reconstruct the command.
            self.pending_raw.extend_from_slice(data);
        }
        if self.mask_enabled {
            self.tail.push_str(&s);
            if self.tail.len() > 256 {
                let cut = self.tail.len() - 256;
                self.tail.drain(..cut);
            }
            if !self.mask_input && is_password_prompt(&self.tail) {
                self.mask_input = true;
                self.mask_marked = false;
            }
        }
    }

    /// Record an input chunk, redacting it while inside a password line. In
    /// `per_line` mode keystrokes are buffered and emitted as one event per Enter
    /// (editing/backspaces collapse), so the recording reads as commands.
    pub fn input(&mut self, data: &[u8]) {
        // Any input is "activity" → resume immediately so the output it triggers is
        // captured (the frontend also re-arms its idle timer on input).
        if self.paused {
            self.set_paused(false);
        }
        if self.mask_enabled && self.mask_input {
            if !self.mask_marked {
                self.emit('i', REDACTED);
                self.mask_marked = true;
            }
            // The Enter key ends the password line; record it and resume.
            if data.contains(&b'\r') || data.contains(&b'\n') {
                self.emit('i', "\r");
                self.mask_input = false;
                self.tail.clear();
            }
            return;
        }
        if self.mode.per_line {
            // Starting a fresh command line: the current output line is the prompt
            // (remember it so a history-recall redraw can be stripped down to the
            // command). `typing` is sticky across bare Enters, so guard on it.
            if !self.typing && self.line_buf.is_empty() {
                self.cur_prompt = String::from_utf8_lossy(&self.out_line).into_owned();
                self.pending_edit = false; // fresh line — drop any stale pending edit
                self.pending_raw.clear();
            }
            // A shell-side line edit (history recall / tab-completion) flagged in the
            // previous chunk has by now had its redraw captured — fold it in before
            // processing this keystroke. One sync per chunk: the capture window is
            // exactly between the triggering keystroke and this next input, so normal
            // typing echo (a different window) is never mistaken for a redraw.
            self.sync_pending();
            // The user is editing a line now → suppress echo output until Enter.
            self.typing = true;
            for &b in data {
                match b {
                    0x1b => {
                        self.esc = EscState::AfterEsc; // ESC: start of a sequence
                        self.esc_seq.clear();
                    }
                    _ if self.esc == EscState::AfterEsc => {
                        // The byte after ESC picks the form: `[` (CSI) or `O` (SS3)
                        // introduce a longer sequence ending on a final byte (e.g.
                        // the A/B/C/D of an arrow); both `[` and `O` are themselves
                        // in 0x40..=0x7e, so they must NOT be taken as the terminator
                        // (the old bug that leaked the `C`/`D` of arrow keys). SS3's
                        // final byte comes next; any other byte is a 2-byte ESC.
                        self.esc = match b {
                            b'[' => EscState::Csi,
                            b'O' => EscState::Ss3,
                            _ => EscState::None,
                        };
                    }
                    _ if self.esc == EscState::Ss3 => {
                        self.cursor_key(b); // ESC O <key>: the byte is the final
                        self.esc = EscState::None;
                    }
                    _ if self.esc == EscState::Csi => {
                        // Parameter/intermediate bytes (0x20..=0x3f) collect; a final
                        // byte (0x40..=0x7e) ends the sequence and we act on it.
                        if (0x40..=0x7e).contains(&b) {
                            self.apply_csi(b);
                            self.esc = EscState::None;
                            self.esc_seq.clear();
                        } else {
                            self.esc_seq.push(b);
                        }
                    }
                    b'\r' | b'\n' => {
                        // Bare Enter (nothing typed): skip it entirely. Leaving
                        // `typing` set keeps the blank line + reprinted prompt the
                        // shell echoes back suppressed, so mashing Enter doesn't
                        // litter the recording with empty lines and dup prompts.
                        if self.line_buf.is_empty() {
                            continue;
                        }
                        let line = String::from_utf8_lossy(&self.line_buf).into_owned();
                        self.emit_step('i', &line, 0.0); // export metadata, no playback gap
                                                         // Echo the command as output, one char at a time, so it
                                                         // appears to be typed at a constant speed during playback.
                        for ch in line.chars() {
                            self.emit_step('o', &ch.to_string(), TYPING_STEP);
                        }
                        self.emit_step('o', "\r\n", TYPING_STEP);
                        self.line_buf.clear();
                        self.cursor = 0;
                        self.typing = false; // committed → record the command's output
                    }
                    0x09 => self.pending_edit = true, // Tab: shell completes via output
                    0x01 => self.cursor = 0,          // Ctrl+A: start of line
                    0x05 => self.cursor = self.line_buf.len(), // Ctrl+E: end of line
                    0x7f | 0x08 => {
                        // Backspace: delete the character *before* the cursor.
                        if self.cursor > 0 {
                            let p = prev_char_boundary(&self.line_buf, self.cursor);
                            self.line_buf.drain(p..self.cursor);
                            self.cursor = p;
                        }
                    }
                    0x15 => {
                        self.line_buf.clear(); // Ctrl+U: kill whole line
                        self.cursor = 0;
                    }
                    0x17 => {
                        // Ctrl+W: kill the word before the cursor.
                        let mut p = self.cursor;
                        while p > 0 && self.line_buf[p - 1] == b' ' {
                            p -= 1;
                        }
                        while p > 0 && self.line_buf[p - 1] != b' ' {
                            p -= 1;
                        }
                        self.line_buf.drain(p..self.cursor);
                        self.cursor = p;
                    }
                    b if b >= 0x20 => {
                        // Printable byte: insert at the cursor, not at the end (so
                        // moving back with arrows and typing inserts mid-line). UTF-8
                        // multi-byte chars arrive byte-by-byte and stay contiguous.
                        self.line_buf.insert(self.cursor, b);
                        self.cursor += 1;
                    }
                    _ => {} // ignore other control bytes
                }
            }
            return;
        }
        self.emit('i', &String::from_utf8_lossy(data));
    }

    /// Handle a cursor-key final byte (from CSI `ESC[` or SS3 `ESC O`). Up/Down
    /// (A/B) recall shell history — flag it so the redraw is captured; the rest
    /// move the cursor. Any pending shell edit was already folded in at the top of
    /// this input chunk, so cursor moves apply to the up-to-date line.
    fn cursor_key(&mut self, key: u8) {
        if key == b'A' || key == b'B' {
            self.pending_edit = true;
            return;
        }
        self.cursor = match key {
            b'C' => next_char_boundary(&self.line_buf, self.cursor), // →
            b'D' => prev_char_boundary(&self.line_buf, self.cursor), // ←
            b'H' => 0,                                               // Home
            b'F' => self.line_buf.len(),                             // End
            _ => self.cursor,
        };
    }

    /// Act on a completed CSI sequence (`ESC[ <params> <final>`): cursor keys plus
    /// the `~`-style Home/End/Delete keys, whose number is in `esc_seq`.
    fn apply_csi(&mut self, final_byte: u8) {
        if final_byte != b'~' {
            self.cursor_key(final_byte);
            return;
        }
        let param: &[u8] = &self.esc_seq;
        let home = matches!(param, b"1" | b"7");
        let end = matches!(param, b"4" | b"8");
        let del = param == b"3";
        if home {
            self.cursor = 0;
        } else if end {
            self.cursor = self.line_buf.len();
        } else if del && self.cursor < self.line_buf.len() {
            // Delete: remove the character *at* the cursor.
            let nx = next_char_boundary(&self.line_buf, self.cursor);
            self.line_buf.drain(self.cursor..nx);
        }
    }

    /// Fold a pending shell-side line edit (history recall or tab-completion) into
    /// the buffer. After Up/Down/Tab the shell changes the line and echoes the
    /// result; that (otherwise-suppressed) output was captured in `pending_raw`.
    /// A full redraw (`CR prompt command`, e.g. recall or a completion listing) is
    /// rebuilt as the whole line minus the prompt; a plain echo with no CR/LF
    /// (a simple completion appending characters) is inserted at the cursor.
    /// No-op unless an edit is pending. Empty capture (e.g. Tab with no match, or
    /// Up with no history) just clears the flag.
    fn sync_pending(&mut self) {
        if !self.pending_edit {
            return;
        }
        self.pending_edit = false;
        let raw = std::mem::take(&mut self.pending_raw);
        if raw.is_empty() {
            return;
        }
        let stripped = strip_ansi(&raw);
        if stripped.iter().any(|&b| b == b'\r' || b == b'\n') {
            let visible = last_visible_line(&stripped);
            let cmd = visible
                .strip_prefix(self.cur_prompt.as_str())
                .or_else(|| visible.strip_prefix(self.cur_prompt.trim_end()))
                .unwrap_or(&visible)
                .trim_start();
            self.line_buf = cmd.as_bytes().to_vec();
            self.cursor = self.line_buf.len();
        } else {
            for &b in &stripped {
                if b >= 0x20 && b != 0x7f {
                    self.line_buf.insert(self.cursor, b);
                    self.cursor += 1;
                }
            }
        }
    }

    /// Path of the recording file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_is_valid_asciicast_v2() {
        let h = asciicast_header(120, 40, 1_700_000_000, "web — host", true);
        let v: serde_json::Value = serde_json::from_str(&h).unwrap();
        assert_eq!(v["version"], 2);
        assert_eq!(v["width"], 120);
        assert_eq!(v["height"], 40);
        assert_eq!(v["timestamp"], 1_700_000_000_u64);
        assert_eq!(v["title"], "web — host");
        assert_eq!(v["server"], "web — host"); // server captured from the creation title
        assert_eq!(v["timed"], true);
    }

    #[test]
    fn header_carries_timed_flag_for_synthetic_recordings() {
        let v: serde_json::Value =
            serde_json::from_str(&asciicast_header(80, 24, 0, "x", false)).unwrap();
        assert_eq!(v["timed"], false);
    }

    #[test]
    fn updates_title_and_description_preserving_events() {
        let content = format!(
            "{}\n{}\n{}\n",
            asciicast_header(80, 24, 1_700_000_000, "old", false),
            event_line(0.0, 'o', "hi"),
            event_line(0.1, 'o', "bye"),
        );
        let updated = with_updated_meta(&content, "My session", "what it does").unwrap();
        let header: serde_json::Value =
            serde_json::from_str(updated.lines().next().unwrap()).unwrap();
        assert_eq!(header["title"], "My session");
        assert_eq!(header["description"], "what it does");
        assert_eq!(header["server"], "old"); // server survives a title rename
        assert_eq!(header["timed"], false); // other fields preserved
        assert_eq!(header["width"], 80);
        // Event lines are untouched.
        assert!(updated.contains(r#"[0.0,"o","hi"]"#));
        assert!(updated.contains(r#"[0.1,"o","bye"]"#));
    }

    #[test]
    fn update_meta_rejects_non_header() {
        assert!(with_updated_meta("not json\n[0,\"o\",\"x\"]\n", "t", "d").is_none());
        assert!(with_updated_meta("", "t", "d").is_none());
    }

    #[test]
    fn header_embeds_vterm_env_metadata_and_end_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let rec = Recorder::start(
            path.clone(),
            80,
            24,
            "web",
            "",
            r#"{"hostname":"web-1","ip":"10.0.0.5","username":"root","os":"Ubuntu 22.04","kernel":"5.15.0"}"#,
            false,
            RecordMode {
                timed: false,
                per_line: true,
            },
        )
        .unwrap();
        drop(rec);

        let content = std::fs::read_to_string(&path).unwrap();
        let header: serde_json::Value =
            serde_json::from_str(content.lines().next().unwrap()).unwrap();
        // Frontend-supplied env is merged in; backend adds recordMode + startedAt.
        assert_eq!(header["vterm"]["hostname"], "web-1");
        assert_eq!(header["vterm"]["ip"], "10.0.0.5");
        assert_eq!(header["vterm"]["os"], "Ubuntu 22.04");
        assert_eq!(header["vterm"]["recordMode"], "commands");
        assert!(header["vterm"]["startedAt"].as_u64().is_some());

        // Stop stamps endedAt and leaves the rest intact.
        let updated = with_ended_at(&content, 1_700_000_999).unwrap();
        let h2: serde_json::Value = serde_json::from_str(updated.lines().next().unwrap()).unwrap();
        assert_eq!(h2["vterm"]["endedAt"], 1_700_000_999_u64);
        assert_eq!(h2["vterm"]["hostname"], "web-1");
    }

    #[test]
    fn header_vterm_survives_blank_env() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        // Local shells / failed probes pass no env — recordMode/startedAt still set.
        let rec = Recorder::start(
            path.clone(),
            80,
            24,
            "x",
            "",
            "",
            false,
            RecordMode::parse("full"),
        )
        .unwrap();
        drop(rec);
        let content = std::fs::read_to_string(&path).unwrap();
        let header: serde_json::Value =
            serde_json::from_str(content.lines().next().unwrap()).unwrap();
        assert_eq!(header["vterm"]["recordMode"], "full");
        assert!(header["vterm"]["hostname"].is_null());
    }

    #[test]
    fn annotate_writes_a_visible_audit_event() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "x",
            "",
            "",
            false,
            RecordMode::parse("full"),
        )
        .unwrap();
        rec.annotate("edited /etc/nginx.conf (2 lines changed)");
        // Annotations are recorded even while paused (deliberate audit events).
        rec.set_paused(true);
        rec.annotate("saved /etc/hosts");
        drop(rec);
        let content = std::fs::read_to_string(&path).unwrap();
        let outs: Vec<serde_json::Value> = content
            .lines()
            .skip(1)
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|v| v[1] == "o")
            .collect();
        assert_eq!(outs.len(), 2);
        assert!(outs[0][2]
            .as_str()
            .unwrap()
            .contains("[vterm] edited /etc/nginx.conf"));
        assert!(outs[1][2].as_str().unwrap().contains("saved /etc/hosts"));
    }

    #[test]
    fn record_mode_label_roundtrips() {
        assert_eq!(RecordMode::parse("commands").label(), "commands");
        assert_eq!(RecordMode::parse("fullNoTiming").label(), "fullNoTiming");
        assert_eq!(RecordMode::parse("full").label(), "full");
    }

    #[test]
    fn header_clamps_zero_dimensions() {
        let v: serde_json::Value =
            serde_json::from_str(&asciicast_header(0, 0, 0, "", true)).unwrap();
        assert_eq!(v["width"], 1);
        assert_eq!(v["height"], 1);
    }

    #[test]
    fn event_line_is_json_array_with_escaping() {
        let line = event_line(1.2345678, 'o', "hi\t\"x\"");
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v[0], 1.234568); // rounded to microseconds
        assert_eq!(v[1], "o");
        assert_eq!(v[2], "hi\t\"x\"");
    }

    #[test]
    fn record_mode_parsing() {
        assert!(matches!(
            RecordMode::parse("full"),
            RecordMode {
                timed: true,
                per_line: false
            }
        ));
        assert!(matches!(
            RecordMode::parse("fullNoTiming"),
            RecordMode {
                timed: false,
                per_line: false
            }
        ));
        assert!(matches!(
            RecordMode::parse("commands"),
            RecordMode {
                timed: false,
                per_line: true
            }
        ));
        // unknown → full
        assert!(matches!(
            RecordMode::parse("???"),
            RecordMode {
                timed: true,
                per_line: false
            }
        ));
    }

    #[test]
    fn sanitizes_titles() {
        assert_eq!(sanitize_title("web — prod (eu)"), "web___prod__eu_");
        assert_eq!(sanitize_title(""), "session");
        assert_eq!(sanitize_title("///"), "session");
        assert_eq!(sanitize_title("ok-name_1"), "ok-name_1");
    }

    /// Read back a recording's event lines as `(time, kind, data)` (skips header).
    fn read_events(path: &std::path::Path) -> Vec<(f64, String, String)> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .skip(1)
            .filter_map(|l| serde_json::from_str::<(f64, String, String)>(l).ok())
            .collect()
    }

    #[test]
    fn commands_mode_types_command_then_dumps_output_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "t",
            "root@host:~# ", // captured prompt, seeded before the first command
            "{}",
            false,
            RecordMode {
                timed: false,
                per_line: true,
            },
        )
        .unwrap();
        rec.input(b"ls\r"); // typed command (echoed char by char)
        rec.output(b"file1\r\n"); // its result, in two chunks
        rec.output(b"file2\r\n");
        drop(rec); // flush

        let events = read_events(&path);
        let outs: Vec<&(f64, String, String)> = events.iter().filter(|e| e.1 == "o").collect();
        // The seeded prompt is the very first output event (precedes the command).
        assert_eq!(outs[0].2, "root@host:~# ", "prompt is seeded first");
        assert_eq!(outs[0].0, 0.0, "prompt seeded at t=0");
        // The command is "typed": each echoed char advances the clock (TYPING_STEP).
        let l = outs.iter().position(|e| e.2 == "l").unwrap();
        let s = outs.iter().position(|e| e.2 == "s").unwrap();
        assert!(outs[l].0 < outs[s].0, "command chars are paced");
        // The output chunks appear at once: same timestamp, no per-line gap.
        let a = outs.iter().find(|e| e.2 == "file1\r\n").unwrap();
        let b = outs.iter().find(|e| e.2 == "file2\r\n").unwrap();
        assert_eq!(a.0, b.0, "output is immediate (single timestamp)");
        assert!(a.0 >= outs[s].0, "output follows the typed command");
    }

    #[test]
    fn full_no_timing_dumps_output_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "t",
            "", // no captured prompt → nothing seeded
            "{}",
            false,
            RecordMode {
                timed: false,
                per_line: false,
            },
        )
        .unwrap();
        // Per-keystroke typing (input + its echo), then a multi-chunk result.
        rec.input(b"l");
        rec.output(b"l");
        rec.input(b"s");
        rec.output(b"s");
        rec.input(b"\r");
        rec.output(b"\r\n");
        rec.output(b"file1\r\n");
        rec.output(b"file2\r\n");
        drop(rec);

        let events = read_events(&path);
        let outs: Vec<&(f64, String, String)> = events.iter().filter(|e| e.1 == "o").collect();
        // Typing echo is paced at TYPING_STEP — the same speed as commands mode.
        let l = outs.iter().find(|e| e.2 == "l").unwrap();
        let s = outs.iter().find(|e| e.2 == "s").unwrap();
        assert!(
            (s.0 - l.0 - TYPING_STEP).abs() < 1e-6,
            "typing pace matches commands mode"
        );
        // The result appears at once — same as commands mode (no per-line gap).
        let a = outs.iter().find(|e| e.2 == "file1\r\n").unwrap();
        let b = outs.iter().find(|e| e.2 == "file2\r\n").unwrap();
        assert_eq!(a.0, b.0, "output is immediate (single timestamp)");
    }

    #[test]
    fn commands_mode_ignores_bare_enter() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "t",
            "root@host:~# ",
            "{}",
            false,
            RecordMode {
                timed: false,
                per_line: true,
            },
        )
        .unwrap();
        // User mashes Enter on an empty line; the shell echoes a blank line and
        // reprints the prompt each time — none of it should be recorded.
        rec.input(b"\r");
        rec.output(b"\r\nroot@host:~# ");
        rec.input(b"\r");
        rec.output(b"\r\nroot@host:~# ");
        // Then a real command with output.
        rec.input(b"ls\r");
        rec.output(b"file1\r\n");
        drop(rec);

        let events = read_events(&path);
        let ins: Vec<&(f64, String, String)> = events.iter().filter(|e| e.1 == "i").collect();
        let outs: Vec<&(f64, String, String)> = events.iter().filter(|e| e.1 == "o").collect();
        // Only the real command is recorded as input — bare Enters are dropped.
        assert_eq!(ins.len(), 1, "bare Enters produce no input events");
        assert_eq!(ins[0].2, "ls");
        // The echoed blank-line/reprinted-prompt is suppressed (not in output).
        assert!(
            !outs.iter().any(|e| e.2.contains("\r\nroot@host")),
            "bare-enter blank lines and dup prompts are suppressed"
        );
        // Seed prompt and the real command's result are still there.
        assert_eq!(outs[0].2, "root@host:~# ");
        assert!(outs.iter().any(|e| e.2 == "file1\r\n"));
    }

    #[test]
    fn commands_mode_ignores_arrow_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "t",
            "",
            "{}",
            false,
            RecordMode {
                timed: false,
                per_line: true,
            },
        )
        .unwrap();
        // Type a command then move around with arrow keys before pressing Enter.
        rec.input(b"cd /etc/systemd");
        rec.input(b"\x1b[D\x1b[D\x1b[C\x1b[C"); // ← ← → → (CSI, ESC[D / ESC[C)
        rec.input(b"\x1bOD\x1bOC"); // ← → (SS3 / application cursor mode)
        rec.input(b"\x1b[1;5C"); // ctrl+→ (CSI with parameters)
        rec.input(b"\r");
        drop(rec);

        let events = read_events(&path);
        let cmd = events.iter().find(|e| e.1 == "i").unwrap();
        // None of the arrow escapes leak their final letters into the command.
        assert_eq!(cmd.2, "cd /etc/systemd");
    }

    /// Read back the single recorded command from a per-line edit sequence.
    fn recorded_command(input: &[&[u8]]) -> String {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "t",
            "",
            "{}",
            false,
            RecordMode {
                timed: false,
                per_line: true,
            },
        )
        .unwrap();
        for chunk in input {
            rec.input(chunk);
        }
        rec.input(b"\r");
        drop(rec);
        read_events(&path)
            .into_iter()
            .find(|e| e.1 == "i")
            .map(|e| e.2)
            .unwrap_or_default()
    }

    #[test]
    fn commands_mode_inserts_at_cursor() {
        // Type a command, move left past "md" with arrows, then insert "X" — it
        // goes in at the cursor, not appended to the end (the reported bug).
        assert_eq!(
            recorded_command(&[b"cd /etc/systemd", b"\x1b[D\x1b[D", b"X"]),
            "cd /etc/systeXmd"
        );
    }

    #[test]
    fn commands_mode_home_end_delete_backspace() {
        // Ctrl+A → home, prepend "sudo "; Ctrl+E → end, backspace drops the 'd';
        // ESC O C (SS3 right) and ESC[3~ (Delete) edit mid-line.
        assert_eq!(
            recorded_command(&[
                b"cd /etc/systemd",
                b"\x01",    // Ctrl+A: home
                b"sudo ",   // prepend
                b"\x05",    // Ctrl+E: end
                b"\x7f",    // backspace: drop trailing 'd'
                b"\x1b[H",  // Home
                b"\x1bOC",  // SS3 right (past 's')
                b"\x1b[3~", // Delete: drop 'u'
            ]),
            "sdo cd /etc/system"
        );
    }

    #[test]
    fn commands_mode_history_recall_then_enter() {
        // Up arrow recalls a command (the shell redraws it); pressing Enter records
        // exactly the recalled line, even though no keystrokes spelled it out.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "t",
            "root@host:~# ",
            "{}",
            false,
            RecordMode {
                timed: false,
                per_line: true,
            },
        )
        .unwrap();
        rec.input(b"\x1bOA"); // Up (SS3 form, application cursor mode)
        rec.output(b"\rroot@host:~# ls -la /var\x1b[K"); // shell redraws the recalled line
        rec.input(b"\r");
        drop(rec);
        let cmd = read_events(&path).into_iter().find(|e| e.1 == "i").unwrap();
        assert_eq!(cmd.2, "ls -la /var");
    }

    #[test]
    fn commands_mode_history_recall_then_edit() {
        // Up recalls "cd /etc/systemd"; the user then backspaces "md" and types "X".
        // The edits apply to the recalled line, not an empty buffer.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "t",
            "root@host:~# ",
            "{}",
            false,
            RecordMode {
                timed: false,
                per_line: true,
            },
        )
        .unwrap();
        rec.input(b"\x1b[A"); // Up (CSI form)
        rec.output(b"\rroot@host:~# cd /etc/systemd\x1b[K");
        rec.input(b"\x7f\x7f"); // backspace twice → drop "md"
        rec.input(b"X");
        rec.input(b"\r");
        drop(rec);
        let cmd = read_events(&path).into_iter().find(|e| e.1 == "i").unwrap();
        assert_eq!(cmd.2, "cd /etc/systeX");
    }

    /// Drive a per-line session with interleaved input/output, return the command.
    fn recorded_with_io(steps: &[(&str, &[u8])]) -> String {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "t",
            "root@host:~# ",
            "{}",
            false,
            RecordMode {
                timed: false,
                per_line: true,
            },
        )
        .unwrap();
        for (kind, bytes) in steps {
            match *kind {
                "i" => rec.input(bytes),
                _ => rec.output(bytes),
            }
        }
        rec.input(b"\r");
        drop(rec);
        read_events(&path)
            .into_iter()
            .find(|e| e.1 == "i")
            .map(|e| e.2)
            .unwrap_or_default()
    }

    #[test]
    fn commands_mode_tab_completion_append() {
        // Simple unique completion: the shell echoes the completing chars ("c/")
        // with no redraw — they're inserted at the cursor.
        assert_eq!(
            recorded_with_io(&[("i", b"cd /et"), ("i", b"\t"), ("o", b"c/")]),
            "cd /etc/"
        );
    }

    #[test]
    fn commands_mode_tab_completion_redraw() {
        // Ambiguous completion that lists candidates then redraws the whole line:
        // reconstructed from the last visible row, minus the prompt.
        assert_eq!(
            recorded_with_io(&[
                ("i", b"ec"),
                ("i", b"\t"),
                ("o", b"\r\necho   echoboard\r\nroot@host:~# echo"),
            ]),
            "echo"
        );
    }

    #[test]
    fn paused_drops_output_and_input_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.cast");
        let mut rec = Recorder::start(
            path.clone(),
            80,
            24,
            "t",
            "",
            "{}",
            false,
            RecordMode::parse("full"),
        )
        .unwrap();
        rec.output(b"before\r\n"); // recorded
        rec.set_paused(true);
        rec.output(b"BACKGROUND STREAM\r\n"); // dropped while paused
        rec.output(b"MORE NOISE\r\n"); // dropped
        rec.input(b"x"); // activity → auto-resumes
        rec.output(b"after\r\n"); // recorded again
        drop(rec);

        let events = read_events(&path);
        let outs: Vec<&str> = events
            .iter()
            .filter(|e| e.1 == "o")
            .map(|e| e.2.as_str())
            .collect();
        assert!(outs.contains(&"before\r\n"));
        assert!(outs.contains(&"after\r\n"));
        assert!(
            !outs
                .iter()
                .any(|o| o.contains("BACKGROUND") || o.contains("NOISE")),
            "paused output is dropped"
        );
        // The resuming input is captured (full mode records it as an `i` event).
        assert!(events.iter().any(|e| e.1 == "i" && e.2 == "x"));
    }

    #[test]
    fn detects_password_prompts() {
        assert!(is_password_prompt("[sudo] password for bob: "));
        assert!(is_password_prompt("root@host's password:"));
        assert!(is_password_prompt("Enter passphrase:"));
        assert!(!is_password_prompt("just some output"));
        assert!(!is_password_prompt("the password is hunter2 and it works"));
    }
}
