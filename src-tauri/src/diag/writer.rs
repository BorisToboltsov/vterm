//! The one writer of the diagnostics files (ADR 0063): a thread of its own that
//! takes events from a bounded queue and appends them to `vterm.jsonl` in
//! batches. Whoever writes an event never waits for the disk — the lesson of
//! session recording, where file I/O on the PTY's drain stalled ConPTY.
//!
//! A repeat is a count, not a line: the first event of a series is written at
//! once, the same event again within [`MERGE_MS`] is counted, and the count is
//! one line when the series ends or another event comes. Files rotate by size:
//! [`KEEP`] of them, together no bigger than the size the user picked — made
//! smaller, the oldest events go at once ([`Files::trim`]).

use super::{mask, Event, Level};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::locks::Locked;

/// The file events are appended to; rotated ones are `vterm.1.jsonl` … older.
pub const FILE: &str = "vterm.jsonl";

/// The update helper's own file: a process of its own, before any WebView.
pub const HELPER_FILE: &str = "update-helper.jsonl";

/// Files kept, the current one included; each rotates at a `KEEP`th of the size.
pub const KEEP: usize = 5;

/// The same event again within this long of the first is counted.
pub const MERGE_MS: u64 = 10_000;

/// How often the writer looks at a series that may have ended.
const TICK: Duration = Duration::from_millis(500);

/// What the writer is asked to do.
pub enum Msg {
    Event(Box<Event>),
    /// Put everything held on disk, then answer.
    Flush(SyncSender<()>),
    /// Remove every file, then answer.
    Clear(SyncSender<()>),
    /// Hold the files to this many bytes from now on — and now — then answer.
    Resize(u64, SyncSender<()>),
    /// A panic was written by the hook: the windows are told.
    Panic,
}

/// What the writer and the commands share.
#[derive(Default)]
pub struct Shared {
    /// Events the full queue turned away since the last batch.
    pub dropped: AtomicU64,
    /// Why the last write failed; none — it did not.
    pub error: Mutex<Option<String>>,
}

/// The diagnostics folder and its files. Clones share the size: the writer's
/// copy and the commands' see one number.
#[derive(Clone)]
pub struct Files {
    pub dir: PathBuf,
    total: Arc<AtomicU64>,
}

impl Files {
    /// The files of `dir`, together no bigger than `total` bytes.
    pub fn new(dir: PathBuf, total: u64) -> Self {
        Files {
            dir,
            total: Arc::new(AtomicU64::new(total)),
        }
    }

    pub fn total(&self) -> u64 {
        self.total.load(Ordering::SeqCst)
    }

    fn set_total(&self, total: u64) {
        self.total.store(total, Ordering::SeqCst);
    }

    /// Where a file rotates: a `KEEP`th of the size.
    fn per_file(&self) -> u64 {
        (self.total() / KEEP as u64).max(1)
    }

    fn current(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    fn rotated(&self, n: usize) -> PathBuf {
        self.dir.join(format!("vterm.{n}.jsonl"))
    }

    /// Every file of events, oldest first; the helper's last.
    pub fn oldest_first(&self) -> Vec<PathBuf> {
        let mut all: Vec<PathBuf> = (1..KEEP).rev().map(|n| self.rotated(n)).collect();
        all.push(self.current());
        all.push(self.dir.join(HELPER_FILE));
        all.into_iter().filter(|p| p.is_file()).collect()
    }

    /// Bytes on disk.
    pub fn size(&self) -> u64 {
        self.oldest_first()
            .iter()
            .filter_map(|p| fs::metadata(p).ok())
            .map(|m| m.len())
            .sum()
    }

    /// Append `text`, rotating first when the current file would pass the cap.
    pub fn append(&self, text: &str) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let current = self.current();
        let size = fs::metadata(&current).map_or(0, |m| m.len());
        if size > 0 && size + text.len() as u64 > self.per_file() {
            self.rotate()?;
        }
        append_to(&current, text)
    }

    /// The oldest file goes, every other moves one older, the current becomes `.1`.
    fn rotate(&self) -> std::io::Result<()> {
        remove_if_there(&self.rotated(KEEP - 1))?;
        for n in (1..KEEP - 1).rev() {
            let from = self.rotated(n);
            if from.is_file() {
                fs::rename(&from, self.rotated(n + 1))?;
            }
        }
        fs::rename(self.current(), self.rotated(1))
    }

    /// Hold the event files to the size: the oldest go whole while there is too
    /// much, and if the newest alone is bigger, only its last lines stay.
    pub fn trim(&self) -> std::io::Result<()> {
        let total = self.total();
        let mut files: Vec<(PathBuf, u64)> = (1..KEEP)
            .rev()
            .map(|n| self.rotated(n))
            .chain(std::iter::once(self.current()))
            .filter_map(|p| fs::metadata(&p).ok().map(|m| (p, m.len())))
            .collect();
        let mut sum: u64 = files.iter().map(|(_, len)| len).sum();
        while sum > total && files.len() > 1 {
            let (oldest, len) = files.remove(0);
            remove_if_there(&oldest)?;
            sum -= len;
        }
        match files.first() {
            Some((newest, _)) if sum > total => keep_tail(newest, total),
            _ => Ok(()),
        }
    }

    /// Every file gone — the helper's too.
    pub fn clear(&self) -> std::io::Result<()> {
        for path in self.oldest_first() {
            remove_if_there(&path)?;
        }
        Ok(())
    }
}

fn remove_if_there(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Keep only the last `bytes` of `path`, from the start of a line — written
/// beside it and renamed over it, so a failure leaves the file as it was.
fn keep_tail(path: &Path, bytes: u64) -> std::io::Result<()> {
    let data = fs::read(path)?;
    let from = data
        .len()
        .saturating_sub(usize::try_from(bytes).unwrap_or(usize::MAX));
    let start = if from == 0 || data.get(from - 1) == Some(&b'\n') {
        from
    } else {
        data[from..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(data.len(), |i| from + i + 1)
    };
    let tmp = path.with_extension("jsonl.tmp");
    fs::write(&tmp, &data[start..])?;
    fs::rename(&tmp, path)
}

/// Append `text` to `path` — a single `write_all` on a file opened for appending.
pub fn append_to(path: &Path, text: &str) -> std::io::Result<()> {
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(text.as_bytes())
}

/// One line of the file: the event masked, as JSON, with its newline.
pub fn line(mut e: Event) -> String {
    e.text = mask(&e.text);
    for value in e.fields.values_mut() {
        if let serde_json::Value::String(s) = value {
            *s = mask(s);
        }
    }
    match serde_json::to_string(&e) {
        Ok(json) => json + "\n",
        // An event is strings, numbers and booleans: it always serialises.
        Err(_) => String::new(),
    }
}

/// What makes two events the same: their level, source, text and session.
fn same(a: &Event, b: &Event) -> bool {
    a.level == b.level && a.source == b.source && a.text == b.text && a.sid == b.sid
}

/// The series being counted: its first event (already written) and its repeats.
struct Series {
    first: Event,
    repeats: u32,
    last_at: u64,
}

/// The lines a batch writes, and the series a repeat counts on. Pure: the
/// times come with the events, so every rule is tested without a clock.
#[derive(Default)]
pub struct Batch {
    lines: String,
    series: Option<Series>,
}

impl Batch {
    /// Take an event: a repeat is counted, anything else is a line now.
    pub fn take(&mut self, e: Event) {
        if let Some(s) = &mut self.series {
            if same(&s.first, &e) && e.at.saturating_sub(s.first.at) < MERGE_MS {
                s.repeats += e.count.max(1);
                s.last_at = e.at;
                return;
            }
        }
        self.close();
        self.lines.push_str(&line(e.clone()));
        self.series = Some(Series {
            first: e,
            repeats: 0,
            last_at: 0,
        });
    }

    /// The series ends: its repeats — if it had any — are one line.
    pub fn close(&mut self) {
        if let Some(s) = self.series.take() {
            if s.repeats > 0 {
                let mut repeat = s.first;
                repeat.at = s.last_at;
                repeat.count = s.repeats;
                self.lines.push_str(&line(repeat));
            }
        }
    }

    /// Close a series that has run its window by `now`.
    pub fn close_if_over(&mut self, now: u64) {
        if self
            .series
            .as_ref()
            .is_some_and(|s| now.saturating_sub(s.first.at) >= MERGE_MS)
        {
            self.close();
        }
    }

    /// The lines so far, taken.
    pub fn drain(&mut self) -> String {
        std::mem::take(&mut self.lines)
    }

    /// Forget everything: the files are being cleared.
    pub fn reset(&mut self) {
        *self = Batch::default();
    }
}

/// Answer whoever asked: they may have stopped waiting, which is theirs.
fn answer(ack: SyncSender<()>) {
    match ack.send(()) {
        Ok(()) | Err(_) => {}
    }
}

/// The writer's loop, until every sender is gone.
pub fn run(rx: &Receiver<Msg>, files: &Files, shared: &Shared, on_panic: &dyn Fn()) {
    let mut batch = Batch::default();
    loop {
        let first = match rx.recv_timeout(TICK) {
            Ok(msg) => Some(msg),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => {
                batch.close();
                write(files, shared, &batch.drain());
                return;
            }
        };
        let mut acks = Vec::new();
        let mut panicked = false;
        for msg in first
            .into_iter()
            .chain(std::iter::from_fn(|| rx.try_recv().ok()))
        {
            match msg {
                Msg::Event(e) => batch.take(*e),
                Msg::Flush(ack) => {
                    batch.close();
                    acks.push(ack);
                }
                Msg::Clear(ack) => {
                    batch.reset();
                    let cleared = files.clear().map_err(|e| e.to_string());
                    *shared.error.locked() = cleared.err();
                    acks.push(ack);
                }
                Msg::Resize(total, ack) => {
                    batch.close();
                    write(files, shared, &batch.drain());
                    files.set_total(total);
                    let trimmed = files.trim().map_err(|e| e.to_string());
                    *shared.error.locked() = trimmed.err();
                    acks.push(ack);
                }
                Msg::Panic => panicked = true,
            }
        }
        let dropped = shared.dropped.swap(0, Ordering::SeqCst);
        if dropped > 0 {
            let mut e = Event::new(
                Level::Warn,
                Some("app"),
                format!("diagnostics queue was full: {dropped} events dropped"),
            );
            e.code = Some("dropped".into());
            e.fields.insert("dropped".into(), dropped.into());
            batch.take(e);
        }
        batch.close_if_over(super::now_ms());
        write(files, shared, &batch.drain());
        for ack in acks {
            answer(ack);
        }
        if panicked {
            on_panic();
        }
    }
}

/// Put `text` on disk; a failure is kept for the settings to say.
fn write(files: &Files, shared: &Shared, text: &str) {
    if text.is_empty() {
        return;
    }
    *shared.error.locked() = files.append(text).err().map(|e| e.to_string());
}

/// An event's fields, as the file keeps them.
pub type Fields = BTreeMap<String, serde_json::Value>;

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_700_000_000_000;

    fn event(text: &str, at: u64) -> Event {
        let mut e = Event::new(Level::Warn, Some("docker"), text.into());
        e.at = at;
        e
    }

    fn lines(text: &str) -> Vec<Event> {
        text.lines()
            .map(|l| serde_json::from_str(l).expect("a line is an event"))
            .collect()
    }

    #[test]
    fn a_repeat_is_counted_on_one_line_after_the_first() {
        let mut b = Batch::default();
        b.take(event("exec channel failed", T0));
        for i in 1..=13 {
            b.take(event("exec channel failed", T0 + i * 500));
        }
        b.take(event("something else", T0 + 8_000));
        let got = lines(&b.drain());
        let shape: Vec<(&str, u32)> = got.iter().map(|e| (e.text.as_str(), e.count)).collect();
        assert_eq!(
            shape,
            [
                ("exec channel failed", 1),
                ("exec channel failed", 13),
                ("something else", 1)
            ]
        );
        // The count line carries the time of the last repeat.
        assert_eq!(got[1].at, T0 + 13 * 500);
    }

    #[test]
    fn a_series_is_a_line_every_window_however_long_it_goes_on() {
        let mut b = Batch::default();
        b.take(event("x", T0));
        b.take(event("x", T0 + 1_000));
        b.take(event("x", T0 + MERGE_MS + 1));
        let got = lines(&b.drain());
        assert_eq!(got.iter().map(|e| e.count).collect::<Vec<_>>(), [1, 1, 1]);
    }

    #[test]
    fn a_quiet_series_is_closed_by_the_clock() {
        let mut b = Batch::default();
        b.take(event("x", T0));
        b.take(event("x", T0 + 100));
        assert_eq!(lines(&b.drain()).len(), 1);
        b.close_if_over(T0 + MERGE_MS - 1);
        assert!(b.drain().is_empty());
        b.close_if_over(T0 + MERGE_MS);
        assert_eq!(lines(&b.drain())[0].count, 1);
    }

    #[test]
    fn what_differs_by_session_is_another_event() {
        let mut b = Batch::default();
        let mut other = event("x", T0 + 1);
        other.sid = Some("tab-2".into());
        b.take(event("x", T0));
        b.take(other);
        assert_eq!(lines(&b.drain()).len(), 2);
    }

    #[test]
    fn a_line_is_masked_before_the_disk() {
        let mut e = event("login with PGPASSWORD=hunter2 failed", T0);
        e.fields
            .insert("url".into(), "https://u:pa55@h/x".to_owned().into());
        let written = line(e);
        assert!(!written.contains("hunter2") && !written.contains("pa55"));
        assert!(written.ends_with('\n'));
    }

    #[test]
    fn files_rotate_by_size_and_keep_at_most_their_number() {
        let dir = tempfile::tempdir().expect("temp dir");
        let files = Files::new(dir.path().to_path_buf(), 100 * KEEP as u64);
        for i in 0..40 {
            files
                .append(&format!("{{\"n\":{i:03},\"pad\":\"0123456789012345\"}}\n"))
                .expect("append");
        }
        let all = files.oldest_first();
        assert_eq!(all.len(), KEEP);
        assert!(all
            .iter()
            .all(|p| fs::metadata(p).map_or(0, |m| m.len()) <= 100));
        // The newest line is in the current file, the oldest kept one first.
        let newest = fs::read_to_string(dir.path().join(FILE)).expect("current");
        assert!(newest.contains("\"n\":039"));
        files.clear().expect("clear");
        assert!(files.oldest_first().is_empty());
    }

    #[test]
    fn a_smaller_size_takes_the_oldest_events_at_once_and_keeps_the_newest() {
        let dir = tempfile::tempdir().expect("temp dir");
        let files = Files::new(dir.path().to_path_buf(), 1000);
        for i in 0..40 {
            files
                .append(&format!("{{\"n\":{i:03},\"pad\":\"0123456789012345\"}}\n"))
                .expect("append");
        }
        assert!(files.size() > 300);
        files.set_total(300);
        files.trim().expect("trim");
        assert!(files.size() <= 300, "{} bytes left", files.size());
        let kept: String = files
            .oldest_first()
            .iter()
            .map(|p| fs::read_to_string(p).expect("read"))
            .collect();
        // Whole lines only, the newest among them.
        assert!(kept.lines().all(|l| l.starts_with('{') && l.ends_with('}')));
        assert!(kept.contains("\"n\":039"));
        assert!(!kept.contains("\"n\":000"));

        // Smaller than the newest file alone: its last lines stay.
        files.set_total(60);
        files.trim().expect("trim");
        let left = fs::read_to_string(dir.path().join(FILE)).expect("current");
        assert!(left.len() <= 60 && left.contains("\"n\":039") && left.starts_with('{'));
    }
}
