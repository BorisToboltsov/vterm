//! The journal of notifications (ADR 0062): every message the app showed
//! — a toast in some window, or a quiet note that was never a toast — kept in
//! one list for all the windows, so a message that flew by can be read later.
//!
//! The journal is the backend's: windows are separate WebViews, and "what was
//! said, how many times, and has anyone looked" must be one answer for all of
//! them. A window notes a message (`journal_note`), the journal merges it with
//! the same message said a moment ago (one entry, `count` up), and tells every
//! window that it changed (`window://journal`, a summary — the list itself is
//! asked for only by a window that shows it).
//!
//! Kept across launches unless the user said no (`journal_configure`), as a
//! store file of its own (`store::save_journal`: written whole, atomically,
//! quarantined when it does not parse). Written behind the notes, by a thread
//! of its own, a moment after the last change — a burst of thirty errors is one
//! write, not thirty — and once more on the way out (`flush`). Old entries go by
//! age and by count (`prune`). The text arrives masked: the window runs it
//! through the same masking the assistant's context gets before it notes it.

use crate::error::AppResult;
use crate::locks::Locked;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

/// The event every window hears when the journal changed: a [`Summary`].
pub const EVENT: &str = "window://journal";

/// No more entries than this are kept; the oldest go first.
pub const MAX_ENTRIES: usize = 1000;

/// A message longer than this is cut (an error can carry a whole stderr).
pub const MAX_TEXT: usize = 2000;

/// The same message said again within this long is the same entry, counted.
pub const MERGE_WINDOW_MS: u64 = 10 * 60 * 1000;

/// The ages the journal can keep, in days — the choice the settings offer.
pub const RETENTION_DAYS: [u32; 4] = [1, 7, 30, 90];

/// The age kept until a window says otherwise — the longest, so nothing goes
/// before the user's own choice is known.
const STARTUP_DAYS: u32 = 90;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// How long the writer waits after a change for the next one.
const WRITE_DELAY: Duration = Duration::from_secs(2);

/// What a message was: the tone of its toast.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Error,
    Success,
    Info,
}

/// One entry: a message, and the times it was said.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub kind: Kind,
    pub text: String,
    /// The part of the app that said it (`docker`, `files`, …) — an id the
    /// frontend translates; None when the caller did not say.
    #[serde(default)]
    pub source: Option<String>,
    /// The server of the session it was about, and its name at the time — the
    /// name stays readable after the server is renamed or deleted.
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub server: Option<String>,
    /// The window it was last said in (`main`, `win-2`).
    #[serde(default)]
    pub window: Option<String>,
    /// Unix ms: the first time and the last time it was said.
    pub first: u64,
    pub last: u64,
    pub count: u32,
    #[serde(default)]
    pub read: bool,
}

/// What a window asks the journal to keep.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Note {
    pub kind: Kind,
    pub text: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub server: Option<String>,
}

/// What every window is told after a change: enough for the bell's dot, and a
/// revision a window showing the list compares to know it must ask again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub rev: u64,
    pub total: usize,
    pub unread_errors: bool,
}

/// `s` cut to at most `max` characters, never inside one.
fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => s[..at].to_owned(),
        None => s.to_owned(),
    }
}

/// A source as the frontend names them: a short lowercase id, or nothing.
fn clean_source(s: Option<String>) -> Option<String> {
    s.filter(|s| {
        (1..=32).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

/// A free-text field kept short and on one line; empty is none.
fn clean_field(s: Option<String>, max: usize) -> Option<String> {
    let s = s?;
    let one_line: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = one_line.trim();
    (!trimmed.is_empty()).then(|| cut(trimmed, max))
}

/// The entries, newest change first; the merging, the age and the count of them.
/// Pure — the times come in — so every rule is tested without a clock or a disk.
#[derive(Debug, Default)]
pub struct Book {
    entries: Vec<Entry>,
    rev: u64,
    seq: u64,
}

impl Book {
    /// The entries of a file as they were read: each id once, the order made
    /// right, what is too old or too many gone.
    pub fn from_saved(saved: Vec<Entry>, now: u64, days: u32) -> Self {
        let mut seen = std::collections::HashSet::new();
        let mut entries: Vec<Entry> = saved
            .into_iter()
            .filter(|e| !e.id.is_empty() && seen.insert(e.id.clone()))
            .map(|mut e| {
                e.text = cut(&e.text, MAX_TEXT);
                e.count = e.count.max(1);
                e.first = e.first.min(e.last);
                e
            })
            .collect();
        entries.sort_by_key(|e| std::cmp::Reverse(e.last));
        let mut book = Book {
            entries,
            rev: 0,
            seq: 0,
        };
        book.prune(now, days);
        book
    }

    /// Keep `note`, said in `window` at `now`: the same message said within
    /// [`MERGE_WINDOW_MS`] is counted on its entry, which comes to the top and
    /// is unread again; anything else is a new entry. An empty message is not
    /// kept. True when the journal changed.
    pub fn note(&mut self, note: Note, window: Option<String>, now: u64, days: u32) -> bool {
        let text = cut(note.text.trim(), MAX_TEXT);
        if text.is_empty() {
            return false;
        }
        let source = clean_source(note.source);
        let server_id = clean_field(note.server_id, 200);
        let server = clean_field(note.server, 200);
        let window = clean_field(window, 64);
        let same = self.entries.iter().position(|e| {
            e.kind == note.kind
                && e.text == text
                && e.source == source
                && e.server_id == server_id
                && now.saturating_sub(e.last) <= MERGE_WINDOW_MS
        });
        let entry = match same {
            Some(at) => {
                let mut e = self.entries.remove(at);
                e.count = e.count.saturating_add(1);
                e.last = now.max(e.last);
                e.read = false;
                e.window = window;
                if server.is_some() {
                    e.server = server;
                }
                e
            }
            None => {
                self.seq += 1;
                Entry {
                    id: format!("j{now:x}-{:x}", self.seq),
                    kind: note.kind,
                    text,
                    source,
                    server_id,
                    server,
                    window,
                    first: now,
                    last: now,
                    count: 1,
                    read: false,
                }
            }
        };
        self.entries.insert(0, entry);
        self.prune(now, days);
        self.rev += 1;
        true
    }

    /// Drop what is older than `days` and what is past [`MAX_ENTRIES`].
    /// True when anything went.
    pub fn prune(&mut self, now: u64, days: u32) -> bool {
        let before = self.entries.len();
        let oldest = now.saturating_sub(u64::from(days.max(1)) * DAY_MS);
        self.entries.retain(|e| e.last >= oldest);
        self.entries.truncate(MAX_ENTRIES);
        let changed = self.entries.len() != before;
        if changed {
            self.rev += 1;
        }
        changed
    }

    /// Mark these entries read — every one, given none. True when any was not.
    pub fn mark_read(&mut self, ids: Option<&[String]>) -> bool {
        let mut changed = false;
        for e in &mut self.entries {
            if !e.read && ids.is_none_or(|ids| ids.contains(&e.id)) {
                e.read = true;
                changed = true;
            }
        }
        if changed {
            self.rev += 1;
        }
        changed
    }

    /// Remove these entries. True when any was there.
    pub fn remove(&mut self, ids: &[String]) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| !ids.contains(&e.id));
        let changed = self.entries.len() != before;
        if changed {
            self.rev += 1;
        }
        changed
    }

    /// Remove every entry. True when there was one.
    pub fn clear(&mut self) -> bool {
        let changed = !self.entries.is_empty();
        self.entries.clear();
        if changed {
            self.rev += 1;
        }
        changed
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn summary(&self) -> Summary {
        Summary {
            rev: self.rev,
            total: self.entries.len(),
            unread_errors: self
                .entries
                .iter()
                .any(|e| !e.read && e.kind == Kind::Error),
        }
    }
}

/// The age the settings offer nearest to `days`: what the journal keeps is one
/// of the four, never what a hand-edited setting says.
pub fn retention(days: u32) -> u32 {
    RETENTION_DAYS
        .into_iter()
        .min_by_key(|d| d.abs_diff(days))
        .unwrap_or(STARTUP_DAYS)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Where the journal lives on disk: the store file, or — in tests — a path of
/// their own. A writer that does nothing when there is none.
pub trait Disk: Send + Sync + 'static {
    fn save(&self, entries: &[Entry]) -> AppResult<()>;
    fn remove(&self);
}

/// The journal's store file (`store::save_journal`).
struct StoreFile;

impl Disk for StoreFile {
    fn save(&self, entries: &[Entry]) -> AppResult<()> {
        crate::store::save_journal(entries)
    }
    fn remove(&self) {
        crate::store::remove_journal();
    }
}

struct Config {
    persist: bool,
    days: u32,
}

/// What the commands and the writer share.
struct Shared {
    book: Mutex<Book>,
    config: Mutex<Config>,
    /// A change not yet on disk.
    dirty: AtomicBool,
    disk: Box<dyn Disk>,
}

impl Shared {
    /// Put the journal on disk if it changed — or take it off, when it is not
    /// kept. The entries are copied out of the lock before the write.
    fn write(&self) {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        // Held over the write: a journal switched off meanwhile removes its file
        // after this write, never before it.
        let config = self.config.locked();
        if !config.persist {
            return;
        }
        let entries = self.book.locked().entries().to_vec();
        if self.disk.save(&entries).is_err() {
            // Tried again on the next change, or on the way out.
            self.dirty.store(true, Ordering::SeqCst);
        }
        drop(config);
    }
}

/// The journal, as the app manages it.
pub struct Journal {
    shared: Arc<Shared>,
    wake: Mutex<Sender<()>>,
}

impl Journal {
    /// The journal of the previous launch, read before any window asks — so a
    /// file that did not parse is quarantined in time for the main window to be
    /// told (`take_store_warnings`) — and its writer started.
    pub fn load() -> Self {
        let saved = crate::store::load_journal();
        Self::start(
            Book::from_saved(saved, now_ms(), STARTUP_DAYS),
            Box::new(StoreFile),
        )
    }

    fn start(book: Book, disk: Box<dyn Disk>) -> Self {
        let shared = Arc::new(Shared {
            book: Mutex::new(book),
            config: Mutex::new(Config {
                persist: true,
                days: STARTUP_DAYS,
            }),
            dirty: AtomicBool::new(false),
            disk,
        });
        let (tx, rx) = channel();
        let writer = Arc::clone(&shared);
        std::thread::spawn(move || write_behind(&writer, &rx, WRITE_DELAY));
        Journal {
            shared,
            wake: Mutex::new(tx),
        }
    }

    /// Something changed: mark it and wake the writer.
    fn changed(&self) {
        self.shared.dirty.store(true, Ordering::SeqCst);
        let _ = self.wake.locked().send(());
    }

    fn days(&self) -> u32 {
        self.shared.config.locked().days
    }

    pub fn note(&self, note: Note, window: Option<String>) -> Summary {
        let days = self.days();
        let mut book = self.shared.book.locked();
        let changed = book.note(note, window, now_ms(), days);
        let summary = book.summary();
        drop(book);
        if changed {
            self.changed();
        }
        summary
    }

    pub fn list(&self) -> Vec<Entry> {
        self.shared.book.locked().entries().to_vec()
    }

    pub fn summary(&self) -> Summary {
        self.shared.book.locked().summary()
    }

    /// Run `f` over the book; mark the journal changed when it says so.
    fn edit(&self, f: impl FnOnce(&mut Book) -> bool) -> Summary {
        let mut book = self.shared.book.locked();
        let changed = f(&mut book);
        let summary = book.summary();
        drop(book);
        if changed {
            self.changed();
        }
        summary
    }

    /// Kept across launches or not, and for how long. Not kept: the file goes
    /// now, and nothing is written until it is kept again.
    pub fn configure(&self, persist: bool, days: u32) -> Summary {
        let days = retention(days);
        let was = {
            let mut config = self.shared.config.locked();
            let was = config.persist;
            *config = Config { persist, days };
            if !persist {
                self.shared.dirty.store(false, Ordering::SeqCst);
                self.shared.disk.remove();
            }
            was
        };
        self.edit(|book| book.prune(now_ms(), days) || (persist && !was))
    }

    /// The last change on disk now — the app is on its way out.
    pub fn flush(&self) {
        self.shared.write();
    }
}

/// The writer: after a change, wait for the burst to end, then write once.
fn write_behind(shared: &Shared, wake: &Receiver<()>, delay: Duration) {
    while wake.recv().is_ok() {
        std::thread::sleep(delay);
        while wake.try_recv().is_ok() {}
        shared.write();
    }
}

/// Tell every window the journal changed.
fn announce(app: &AppHandle, summary: Summary) -> Summary {
    let _ = app.emit(EVENT, summary);
    summary
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Keep a message said in `window`.
#[tauri::command]
pub fn journal_note(
    app: AppHandle,
    window: WebviewWindow,
    journal: State<'_, Journal>,
    note: Note,
) -> Summary {
    // Every message is an event of the diagnostics too (ADR 0063): its layer is
    // the whole story — what was shown and what happened around it.
    crate::diag::shown(
        note.kind,
        &note.text,
        note.source.as_deref(),
        (note.server_id.as_deref(), note.server.as_deref()),
        window.label(),
    );
    let summary = journal.note(note, Some(window.label().to_owned()));
    announce(&app, summary)
}

/// Every entry, newest change first.
#[tauri::command]
pub fn journal_list(journal: State<'_, Journal>) -> Vec<Entry> {
    journal.list()
}

/// The bell's answer: is there an error nobody has read.
#[tauri::command]
pub fn journal_summary(journal: State<'_, Journal>) -> Summary {
    journal.summary()
}

/// These entries — or every one — have been seen.
#[tauri::command]
pub fn journal_mark_read(
    app: AppHandle,
    journal: State<'_, Journal>,
    ids: Option<Vec<String>>,
) -> Summary {
    let summary = journal.edit(|book| book.mark_read(ids.as_deref()));
    announce(&app, summary)
}

/// Remove these entries.
#[tauri::command]
pub fn journal_remove(app: AppHandle, journal: State<'_, Journal>, ids: Vec<String>) -> Summary {
    let summary = journal.edit(|book| book.remove(&ids));
    announce(&app, summary)
}

/// Remove every entry.
#[tauri::command]
pub fn journal_clear(app: AppHandle, journal: State<'_, Journal>) -> Summary {
    let summary = journal.edit(Book::clear);
    announce(&app, summary)
}

/// What the settings say: kept across launches or not, and for how many days.
#[tauri::command]
pub fn journal_configure(
    app: AppHandle,
    journal: State<'_, Journal>,
    persist: bool,
    days: u32,
) -> Summary {
    let summary = journal.configure(persist, days);
    announce(&app, summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_700_000_000_000;

    fn note(kind: Kind, text: &str) -> Note {
        Note {
            kind,
            text: text.into(),
            source: Some("docker".into()),
            server_id: Some("srv-1".into()),
            server: Some("prod-db".into()),
        }
    }

    fn texts(book: &Book) -> Vec<&str> {
        book.entries().iter().map(|e| e.text.as_str()).collect()
    }

    #[test]
    fn the_same_message_said_again_is_one_entry_counted_and_on_top() {
        let mut book = Book::default();
        book.note(note(Kind::Error, "exec channel failed"), None, T0, 30);
        book.note(note(Kind::Info, "something else"), None, T0 + 1, 30);
        book.mark_read(None);
        book.note(
            note(Kind::Error, "exec channel failed"),
            Some("win-2".into()),
            T0 + 5_000,
            30,
        );
        assert_eq!(texts(&book), ["exec channel failed", "something else"]);
        let e = &book.entries()[0];
        assert_eq!((e.count, e.first, e.last), (2, T0, T0 + 5_000));
        // Said again, it is news again — and where it was said last.
        assert!(!e.read);
        assert_eq!(e.window.as_deref(), Some("win-2"));
    }

    #[test]
    fn a_message_differs_by_tone_source_server_and_time() {
        let mut book = Book::default();
        book.note(note(Kind::Error, "x"), None, T0, 30);
        book.note(note(Kind::Info, "x"), None, T0, 30);
        let mut other_server = note(Kind::Error, "x");
        other_server.server_id = Some("srv-2".into());
        book.note(other_server, None, T0, 30);
        let mut other_source = note(Kind::Error, "x");
        other_source.source = Some("k8s".into());
        book.note(other_source, None, T0, 30);
        // Said again long after: a new entry, not a count on the old one.
        book.note(note(Kind::Error, "x"), None, T0 + MERGE_WINDOW_MS + 1, 30);
        assert_eq!(book.entries().len(), 5);
        assert!(book.entries().iter().all(|e| e.count == 1));
    }

    #[test]
    fn what_is_kept_is_cut_cleaned_and_never_empty() {
        let mut book = Book::default();
        assert!(!book.note(note(Kind::Error, "   "), None, T0, 30));
        assert_eq!(book.summary().rev, 0);
        let mut n = note(Kind::Error, &"й".repeat(MAX_TEXT + 10));
        n.source = Some("Not An Id!".into());
        n.server = Some("prod\ndb\t".into());
        book.note(n, Some(String::new()), T0, 30);
        let e = &book.entries()[0];
        assert_eq!(e.text.chars().count(), MAX_TEXT);
        assert_eq!(e.source, None);
        assert_eq!(e.server.as_deref(), Some("prod db"));
        assert_eq!(e.window, None);
    }

    #[test]
    fn old_and_surplus_entries_go() {
        let mut book = Book::default();
        book.note(note(Kind::Info, "old"), None, T0, 30);
        book.note(note(Kind::Info, "new"), None, T0 + 2 * DAY_MS, 30);
        assert!(book.prune(T0 + 2 * DAY_MS, 1));
        assert_eq!(texts(&book), ["new"]);
        for i in 0..MAX_ENTRIES + 5 {
            book.note(
                note(Kind::Info, &format!("m{i}")),
                None,
                T0 + 3 * DAY_MS + i as u64,
                30,
            );
        }
        assert_eq!(book.entries().len(), MAX_ENTRIES);
        // The newest stay.
        assert_eq!(book.entries()[0].text, format!("m{}", MAX_ENTRIES + 4));
    }

    #[test]
    fn the_bell_lights_for_an_unread_error_only() {
        let mut book = Book::default();
        book.note(note(Kind::Success, "saved"), None, T0, 30);
        book.note(note(Kind::Info, "fyi"), None, T0, 30);
        assert!(!book.summary().unread_errors);
        book.note(note(Kind::Error, "boom"), None, T0, 30);
        assert!(book.summary().unread_errors);
        let id = book.entries()[0].id.clone();
        assert!(book.mark_read(Some(std::slice::from_ref(&id))));
        assert!(!book.summary().unread_errors);
        assert!(!book.mark_read(Some(&[id])), "read twice changes nothing");
    }

    #[test]
    fn entries_are_removed_by_id_or_all_at_once() {
        let mut book = Book::default();
        book.note(note(Kind::Info, "a"), None, T0, 30);
        book.note(note(Kind::Info, "b"), None, T0, 30);
        let a = book.entries()[1].id.clone();
        let rev = book.summary().rev;
        assert!(book.remove(&[a]));
        assert_eq!(texts(&book), ["b"]);
        assert!(book.summary().rev > rev);
        assert!(!book.remove(&["nope".into()]));
        assert!(book.clear());
        assert!(!book.clear());
        assert_eq!(book.summary().total, 0);
    }

    #[test]
    fn a_saved_journal_is_read_back_whole_ordered_and_pruned() {
        let mut book = Book::default();
        book.note(note(Kind::Error, "a"), None, T0, 30);
        book.note(note(Kind::Info, "b"), None, T0 + 10, 30);
        let mut saved = book.entries().to_vec();
        saved.reverse();
        let mut dup = saved[0].clone();
        dup.text = "duplicate id".into();
        saved.push(dup);
        let mut stale = saved[0].clone();
        stale.id = "stale".into();
        stale.last = T0 - 40 * DAY_MS;
        stale.first = stale.last;
        saved.push(stale);
        let back = Book::from_saved(saved, T0 + 10, 30);
        assert_eq!(texts(&back), ["b", "a"]);
        // The file round-trips through serde as the frontend reads it.
        let json = serde_json::to_string(back.entries()).unwrap();
        assert!(json.contains("\"serverId\":\"srv-1\"") && json.contains("\"kind\":\"error\""));
        let again: Vec<Entry> = serde_json::from_str(&json).unwrap();
        assert_eq!(again, back.entries());
    }

    #[test]
    fn a_note_with_a_field_of_another_name_is_refused() {
        let ok: Result<Note, _> =
            serde_json::from_str(r#"{"kind":"info","text":"x","serverId":"s"}"#);
        assert!(ok.is_ok());
        let wrong: Result<Note, _> =
            serde_json::from_str(r#"{"kind":"info","text":"x","server_id":"s"}"#);
        assert!(wrong.is_err());
    }

    #[test]
    fn retention_is_one_of_the_offered_ages() {
        assert_eq!(retention(30), 30);
        assert_eq!(retention(0), 1);
        assert_eq!(retention(10), 7);
        assert_eq!(retention(10_000), 90);
    }

    /// A disk that remembers what it was given.
    #[derive(Default)]
    struct Memory {
        saved: Mutex<Vec<Vec<Entry>>>,
        removed: AtomicBool,
    }

    impl Disk for Arc<Memory> {
        fn save(&self, entries: &[Entry]) -> AppResult<()> {
            self.saved.locked().push(entries.to_vec());
            Ok(())
        }
        fn remove(&self) {
            self.removed.store(true, Ordering::SeqCst);
        }
    }

    fn journal_on(memory: &Arc<Memory>) -> Journal {
        Journal::start(Book::default(), Box::new(Arc::clone(memory)))
    }

    #[test]
    fn a_burst_is_written_once_and_the_last_change_on_the_way_out() {
        let memory = Arc::new(Memory::default());
        let journal = journal_on(&memory);
        for _ in 0..30 {
            journal.note(note(Kind::Error, "boom"), None);
        }
        assert_eq!(journal.summary().total, 1);
        // Nothing yet: the writer waits for the burst to end.
        assert!(memory.saved.locked().is_empty());
        journal.flush();
        assert_eq!(memory.saved.locked().len(), 1);
        assert_eq!(memory.saved.locked()[0][0].count, 30);
        // Nothing changed since: the way out writes nothing more.
        journal.flush();
        assert_eq!(memory.saved.locked().len(), 1);
    }

    #[test]
    fn a_journal_not_kept_leaves_the_disk_and_stays_off_it() {
        let memory = Arc::new(Memory::default());
        let journal = journal_on(&memory);
        journal.note(note(Kind::Info, "x"), None);
        journal.configure(false, 30);
        assert!(memory.removed.load(Ordering::SeqCst));
        journal.note(note(Kind::Info, "y"), None);
        journal.flush();
        assert!(memory.saved.locked().is_empty());
        // Kept again: what is in memory now goes to disk.
        journal.configure(true, 30);
        journal.flush();
        assert_eq!(memory.saved.locked().len(), 1);
        assert_eq!(memory.saved.locked()[0].len(), 2);
    }

    #[test]
    fn the_writer_writes_after_the_burst_by_itself() {
        let memory = Arc::new(Memory::default());
        let shared = Arc::new(Shared {
            book: Mutex::new(Book::default()),
            config: Mutex::new(Config {
                persist: true,
                days: 30,
            }),
            dirty: AtomicBool::new(true),
            disk: Box::new(Arc::clone(&memory)),
        });
        let (tx, rx) = channel();
        let writer = Arc::clone(&shared);
        let done = std::thread::spawn(move || write_behind(&writer, &rx, Duration::from_millis(5)));
        tx.send(()).unwrap();
        tx.send(()).unwrap();
        drop(tx);
        done.join().unwrap();
        assert_eq!(memory.saved.locked().len(), 1);
    }

    /// The body of `fn name(` in `src`, up to its closing brace at column 0.
    fn body_of<'a>(src: &'a str, name: &str) -> &'a str {
        let from = src.find(&format!("fn {name}(")).map_or("", |at| &src[at..]);
        from.find("\n}\n").map_or(from, |end| &from[..end])
    }

    /// What keeps the journal from being a store file like the others: a write
    /// of its own in `journal.rs`, a store function that is not atomic or not
    /// quarantined, a backup that carries it.
    fn store_violations(journal: &str, store: &str, backups: &[&str]) -> Vec<String> {
        let code = journal.split("#[cfg(test)]").next().unwrap_or(journal);
        let mut out: Vec<String> = ["fs::", "File::create", "OpenOptions"]
            .iter()
            .filter(|banned| code.contains(*banned))
            .map(|banned| format!("journal.rs writes by itself ({banned})"))
            .collect();
        if !code.contains("crate::store::save_journal(") {
            out.push("journal.rs saves through store::save_journal".into());
        }
        if !body_of(store, "save_journal").contains("write_atomic(") {
            out.push("save_journal writes atomically".into());
        }
        if !body_of(store, "load_journal").contains("read_store(") {
            out.push("load_journal quarantines what does not parse".into());
        }
        if backups.iter().any(|b| b.contains("journal")) {
            out.push("a backup carries the journal".into());
        }
        out
    }

    #[test]
    fn the_journal_is_written_only_through_the_store() {
        // Gate: the journal reaches the disk as a store file — atomic, and
        // quarantined when it does not parse — and nowhere else; a backup never
        // carries it: it is this machine's history.
        // A Windows checkout carries CRLF (core.autocrlf); the markers below are LF.
        let lf = |src: &str| src.replace("\r\n", "\n");
        let (journal, store) = (lf(include_str!("journal.rs")), lf(include_str!("store.rs")));
        let (journal, store) = (journal.as_str(), store.as_str());
        let backup_files = [
            lf(include_str!("backup.rs")),
            lf(include_str!("commands/backup.rs")),
        ];
        let backups = [backup_files[0].as_str(), backup_files[1].as_str()];
        assert_eq!(
            store_violations(journal, store, &backups),
            Vec::<String>::new()
        );

        // …and the check sees each of its violations.
        let own_write = journal.replacen(
            "crate::store::save_journal(entries)",
            "std::fs::write(\"j\", \"\")",
            1,
        );
        assert_eq!(store_violations(&own_write, store, &backups).len(), 2);
        let plain = store.replacen(
            "write_atomic(&path, &json)?;\n    Ok(())\n}\n\n/// Take",
            "std::fs::write(&path, &json)?;\n    Ok(())\n}\n\n/// Take",
            1,
        );
        assert_ne!(
            plain, store,
            "the store's journal writer is where the check looks"
        );
        assert_eq!(
            store_violations(journal, &plain, &backups),
            ["save_journal writes atomically"]
        );
        let unquarantined = store.replacen(
            "read_store(&path)\n}\n\n/// Write",
            "Vec::new()\n}\n\n/// Write",
            1,
        );
        assert_ne!(unquarantined, store);
        assert_eq!(
            store_violations(journal, &unquarantined, &backups),
            ["load_journal quarantines what does not parse"]
        );
        assert_eq!(
            store_violations(journal, store, &["journal: Vec<Entry>"]),
            ["a backup carries the journal"]
        );
    }
}
