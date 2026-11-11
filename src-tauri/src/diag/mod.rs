//! Diagnostics (ADR 0063): what the app did, not what it said — the journal's
//! second layer. Events of four levels go to one append-only file of the
//! backend, rotated by size; the journal's window reads them back by page.
//!
//! - **One writer.** Windows are separate WebViews, and an event is needed before
//!   any of them exists (start-up, WebView2, the update helper). Rust writes with
//!   `tracing` — `tracing::warn!(source = "storage", path = %p, "…")` — and a
//!   window through `diag_write`; both go into one bounded queue that a thread of
//!   its own empties to disk ([`writer`]). Nobody waits for the disk.
//! - **The threshold is the user's.** «Only errors», «warnings», «information»
//!   (the default) or «verbose»: below it an event is written nowhere — the
//!   subscriber turns it away at its call site. It is kept here, in `diag.json`,
//!   because the first events come before any window could say it.
//! - **Never written:** secrets and content. Hosts, logins and paths are written
//!   openly. The writer masks every line on its way to the disk ([`mask`]) — the
//!   last line of defence, not the way.
//! - **A panic** is an `error` written at once by the hook, and the windows are
//!   told: the main one says «internal error» once a minute at most.

mod mask;
mod query;
mod writer;

pub use mask::mask;

use crate::error::AppResult;
use crate::locks::Locked;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, WebviewWindow};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::subscriber::Interest;
use tracing::{Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use writer::{Fields, Files, Msg, Shared};

/// Heard by every window when the threshold changed or a panic was written.
pub const EVENT: &str = "window://diag";

/// Events waiting for the writer at most; past it they are counted, not kept.
const QUEUE: usize = 4096;

/// A text longer than this is cut (an error can carry a whole stderr).
pub const MAX_TEXT: usize = 4000;

/// How long a reader waits for the writer to put what it holds on disk.
const FLUSH_WAIT: Duration = Duration::from_secs(2);

/// The parts of the app an event comes from: the journal's sources
/// (`notifications/journal.ts`, `JOURNAL_SOURCES`), `app` and `storage` —
/// mirrored by `DIAG_SOURCES` in `diag/diag.ts` (gate `diag.guard`).
pub const SOURCES: [&str; 19] = [
    "connection",
    "terminal",
    "files",
    "editor",
    "transfer",
    "sync",
    "git",
    "docker",
    "k8s",
    "recording",
    "ai",
    "netcheck",
    "monitoring",
    "servers",
    "settings",
    "update",
    "windows",
    "app",
    "storage",
];

/// Words that make a field name a secret's (`db_password`, `access_token`) —
/// read as words, so `tokens_in` (a count) is not one. Mirror of
/// `isSecretName` in `lint/vterm.js`.
const SECRET_WORDS: [&str; 9] = [
    "password",
    "passwd",
    "passphrase",
    "secret",
    "secrets",
    "token",
    "credential",
    "credentials",
    "cookie",
];

/// How much an event matters. The order is the threshold's: an event is
/// written when it is at or above the threshold (`Error` the highest).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
    /// A development build's, by `VTERM_DIAG=trace`; never a threshold to pick.
    Trace = 5,
}

impl Level {
    fn from_u8(n: u8) -> Level {
        match n {
            1 => Level::Error,
            2 => Level::Warn,
            4 => Level::Debug,
            5 => Level::Trace,
            _ => Level::Info,
        }
    }

    fn of(level: &tracing::Level) -> Level {
        match *level {
            tracing::Level::ERROR => Level::Error,
            tracing::Level::WARN => Level::Warn,
            tracing::Level::INFO => Level::Info,
            tracing::Level::DEBUG => Level::Debug,
            _ => Level::Trace,
        }
    }

    /// A threshold the settings offer: `Trace` is not one of them.
    fn offered(self) -> Level {
        self.min(Level::Debug)
    }
}

/// The threshold when nothing was picked.
pub const DEFAULT_THRESHOLD: Level = Level::Info;

/// The sizes on disk the settings offer, in MB — mirror of `DIAG_SIZES_MB`.
pub const SIZES_MB: [u32; 6] = [5, 10, 25, 50, 100, 250];

/// The size when nothing was picked.
pub const DEFAULT_SIZE_MB: u32 = 25;

const MB: u64 = 1024 * 1024;

/// A size as the settings take it: the offered size nearest to `mb`.
fn offered_size(mb: u32) -> u32 {
    SIZES_MB
        .into_iter()
        .min_by_key(|s| s.abs_diff(mb))
        .unwrap_or(DEFAULT_SIZE_MB)
}

/// One event, as the file keeps it — a line of JSON.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Unix ms.
    pub at: u64,
    pub level: Level,
    /// The part of the app, one of [`SOURCES`]; none — whoever wrote it did not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Technical English: data, not interface text — searched and forwarded as is.
    pub text: String,
    /// Flat: strings, numbers, booleans.
    #[serde(default, skip_serializing_if = "Fields::is_empty")]
    pub fields: Fields,
    /// The session it happened in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    /// Its server, and the server's name at the time — readable after a rename.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    /// The window it happened in (`main`, `win-2`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub win: Option<String>,
    /// How many times it happened: a repeat line counts its series.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub count: u32,
    /// It was a message the user saw (ADR 0062).
    #[serde(default, skip_serializing_if = "is_false")]
    pub shown: bool,
    /// Written at every threshold (a change of the threshold itself).
    #[serde(skip)]
    always: bool,
}

fn one() -> u32 {
    1
}
fn is_one(n: &u32) -> bool {
    *n == 1
}
fn is_false(b: &bool) -> bool {
    !*b
}

impl Event {
    pub fn new(level: Level, source: Option<&str>, text: String) -> Event {
        Event {
            at: now_ms(),
            level,
            source: source.map(Into::into),
            text,
            fields: Fields::new(),
            sid: None,
            server_id: None,
            server: None,
            win: None,
            count: 1,
            shown: false,
            always: false,
        }
    }

    /// Kept short and clean: a known source or none, one cut text.
    fn cleaned(mut self) -> Event {
        self.source = self.source.filter(|s| SOURCES.contains(&s.as_str()));
        self.text = cut(self.text.trim(), MAX_TEXT);
        for (name, value) in &mut self.fields {
            if is_secret_field(name) {
                *value = mask::REDACTED.into();
            }
        }
        self
    }
}

/// Whether a field's name says it holds a secret: one of [`SECRET_WORDS`], or
/// `api key` / `private key`, among its words (`camelCase` and `snake_case`).
fn is_secret_field(name: &str) -> bool {
    let mut snake = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        if c.is_ascii_uppercase() && prev_lower {
            snake.push('_');
        }
        prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        snake.push(c.to_ascii_lowercase());
    }
    let words: Vec<&str> = snake
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    words.iter().any(|w| SECRET_WORDS.contains(w))
        || words
            .windows(2)
            .any(|p| (p[0] == "api" || p[0] == "private") && p[1] == "key")
}

fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => s[..at].to_owned(),
        None => s.to_owned(),
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── The threshold ────────────────────────────────────────────────────────────

static THRESHOLD: AtomicU8 = AtomicU8::new(DEFAULT_THRESHOLD as u8);

/// What is written now: events at this level and above.
pub fn threshold() -> Level {
    Level::from_u8(THRESHOLD.load(Ordering::SeqCst))
}

fn set_threshold(level: Level) {
    THRESHOLD.store(level as u8, Ordering::SeqCst);
    // russh writes through `log`, bridged only at «verbose».
    log::set_max_level(if level >= Level::Debug {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Off
    });
}

/// What `diag.json` keeps: the threshold and the size the user picked.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub level: Option<Level>,
    #[serde(default)]
    pub size_mb: Option<u32>,
}

impl Settings {
    fn size_mb(&self) -> u32 {
        self.size_mb.map_or(DEFAULT_SIZE_MB, offered_size)
    }
}

/// The threshold of `diag.json`, read before the first event.
fn saved_threshold() -> Level {
    crate::store::load_diag()
        .level
        .map_or(DEFAULT_THRESHOLD, Level::offered)
}

// ── The writer ───────────────────────────────────────────────────────────────

struct Diag {
    tx: SyncSender<Msg>,
    shared: Arc<Shared>,
    files: Files,
}

static DIAG: OnceLock<Diag> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static PANICS: AtomicU64 = AtomicU64::new(0);

/// Where the diagnostics live: the data folder, as recordings do — not settings.
pub fn dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("su", "vcore", "vterm").map(|d| d.data_dir().join("diag"))
}

/// Start the writer, the subscriber, the `log` bridge and the panic hook —
/// first thing in `run()`, before anything can happen worth writing.
pub fn start() {
    let mut level = saved_threshold();
    #[cfg(debug_assertions)]
    if std::env::var("VTERM_DIAG").as_deref() == Ok("trace") {
        level = Level::Trace;
    }
    set_threshold(level);
    let Some(dir) = dir() else {
        return;
    };
    let files = Files::new(dir, u64::from(crate::store::load_diag().size_mb()) * MB);
    let shared = Arc::new(Shared::default());
    let (tx, rx) = sync_channel(QUEUE);
    let diag = Diag {
        tx,
        shared: Arc::clone(&shared),
        files: files.clone(),
    };
    if DIAG.set(diag).is_err() {
        return;
    }
    // Without its thread the queue fills and turns events away, counted: the
    // app goes on, its diagnostics do not.
    match std::thread::Builder::new()
        .name("diag-writer".into())
        .spawn(move || writer::run(&rx, &files, &shared, &tell_windows))
    {
        Ok(_) | Err(_) => {}
    }
    match tracing::subscriber::set_global_default(tracing_subscriber::registry().with(DiagLayer)) {
        Ok(()) | Err(_) => {}
    }
    match log::set_logger(&LOG_BRIDGE) {
        Ok(()) | Err(_) => {}
    }
    install_panic_hook();
    tracing::info!(
        source = "app",
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        "vterm started"
    );
}

/// The windows can be told from now on.
pub fn attach(app: AppHandle) {
    match APP.set(app) {
        Ok(()) | Err(_) => {}
    }
}

/// What every window is told: the threshold, the size, and how many panics were written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct News {
    pub level: Level,
    pub size_mb: u32,
    pub panics: u64,
}

/// The size in force, in MB.
fn size_mb() -> u32 {
    DIAG.get().map_or(DEFAULT_SIZE_MB, |d| {
        u32::try_from(d.files.total() / MB).unwrap_or(DEFAULT_SIZE_MB)
    })
}

fn news() -> News {
    News {
        level: threshold().offered(),
        size_mb: size_mb(),
        panics: PANICS.load(Ordering::SeqCst),
    }
}

fn tell_windows() {
    if let Some(app) = APP.get() {
        match app.emit(EVENT, news()) {
            Ok(()) | Err(_) => {}
        }
    }
}

thread_local! {
    /// A test's events, kept instead of written (`capture`).
    #[cfg(test)]
    static CAPTURED: std::cell::RefCell<Option<Vec<Event>>> = const { std::cell::RefCell::new(None) };
}

/// Hand an event to the writer — when the threshold lets it through.
pub fn submit(e: Event) {
    if e.level > threshold() && !e.always {
        return;
    }
    let e = e.cleaned();
    #[cfg(test)]
    if CAPTURED.with(|c| {
        c.borrow_mut()
            .as_mut()
            .map(|events| events.push(e.clone()))
            .is_some()
    }) {
        return;
    }
    let Some(diag) = DIAG.get() else {
        return;
    };
    match diag.tx.try_send(Msg::Event(Box::new(e))) {
        Err(TrySendError::Full(_)) => {
            diag.shared.dropped.fetch_add(1, Ordering::SeqCst);
        }
        Ok(()) | Err(TrySendError::Disconnected(_)) => {}
    }
}

/// The app is on its way out: said, and what the writer holds put on disk.
pub fn shutdown() {
    tracing::info!(source = "app", "vterm exiting");
    flush();
}

/// Ask the writer to put what it holds on disk, and wait a little for it.
fn flush() {
    let Some(diag) = DIAG.get() else {
        return;
    };
    let (ack, done) = sync_channel(1);
    if diag.tx.try_send(Msg::Flush(ack)).is_ok() {
        match done.recv_timeout(FLUSH_WAIT) {
            Ok(()) | Err(_) => {}
        }
    }
}

/// A message the user was shown (`journal_note`), as an event: error for an
/// error, information for the rest.
pub fn shown(
    kind: crate::journal::Kind,
    text: &str,
    source: Option<&str>,
    server: (Option<&str>, Option<&str>),
    win: &str,
) {
    let level = match kind {
        crate::journal::Kind::Error => Level::Error,
        crate::journal::Kind::Success | crate::journal::Kind::Info => Level::Info,
    };
    let mut e = Event::new(level, source, text.to_owned());
    e.server_id = server.0.map(Into::into);
    e.server = server.1.map(Into::into);
    e.win = Some(win.to_owned());
    e.shown = true;
    submit(e);
}

/// An event of the update helper — a process of its own, with no writer
/// thread: written at once to its own file, at the threshold of `diag.json`.
pub fn helper(level: Level, text: String) {
    if level > saved_threshold() {
        return;
    }
    let Some(dir) = dir() else {
        return;
    };
    let line = writer::line(Event::new(level, Some("update"), text).cleaned());
    if std::fs::create_dir_all(&dir).is_ok() {
        match writer::append_to(&dir.join(writer::HELPER_FILE), &line) {
            Ok(()) | Err(_) => {}
        }
    }
}

// ── Nothing is dropped in silence ────────────────────────────────────────────

/// A `Result` whose error is written rather than dropped (ADR 0063): `debug`
/// when it was expected — a window already gone, a temporary file already
/// removed — `warn` when the user lost something — a setting not saved, a
/// file's mode not applied. Returns the value, if there was one.
pub trait Logged<T> {
    fn log_debug(self, source: &'static str, what: &str) -> Option<T>;
    fn log_warn(self, source: &'static str, what: &str) -> Option<T>;
}

impl<T, E: std::fmt::Display> Logged<T> for Result<T, E> {
    fn log_debug(self, source: &'static str, what: &str) -> Option<T> {
        self.map_err(|e| tracing::debug!(source = source, "{what}: {e}"))
            .ok()
    }

    fn log_warn(self, source: &'static str, what: &str) -> Option<T> {
        self.map_err(|e| tracing::warn!(source = source, "{what}: {e}"))
            .ok()
    }
}

/// A send nobody waited for any more — a oneshot, a `OnceLock` already set:
/// the error is the value itself, so the event says only that it went unheard.
pub trait Unheard {
    fn log_unheard(self, source: &'static str, what: &str);
}

impl<E> Unheard for Result<(), E> {
    fn log_unheard(self, source: &'static str, what: &str) {
        if self.is_err() {
            tracing::debug!(source = source, "{what}: nobody was waiting");
        }
    }
}

/// A failure that would repeat per chunk (an emit of terminal output, a
/// recorder's write): the first is written, the rest only counted — the hot
/// path writes no event per chunk.
pub struct FirstFailure {
    source: &'static str,
    what: &'static str,
    failed: AtomicU64,
}

impl FirstFailure {
    pub const fn new(source: &'static str, what: &'static str) -> Self {
        FirstFailure {
            source,
            what,
            failed: AtomicU64::new(0),
        }
    }

    pub fn note<T, E: std::fmt::Display>(&self, result: Result<T, E>) {
        if let Err(e) = result {
            if self.failed.fetch_add(1, Ordering::Relaxed) == 0 {
                tracing::debug!(
                    source = self.source,
                    "{}: {e} (later failures are not written)",
                    self.what
                );
            }
        }
    }
}

// ── tracing ──────────────────────────────────────────────────────────────────

/// The crate's own events only: a library's `tracing` (hyper, h2, tokio) is not
/// ours to keep, and russh speaks through `log` ([`LogBridge`]).
fn ours(meta: &Metadata<'_>) -> bool {
    meta.target().starts_with("vterm")
}

/// The session a span stands for (`sid`, `server_id`, `server`).
#[derive(Default, Clone)]
struct SpanSession {
    sid: Option<String>,
    server_id: Option<String>,
    server: Option<String>,
}

/// Reads an event's or a span's fields into an [`Event`].
struct Reader<'a> {
    event: &'a mut Event,
}

impl Reader<'_> {
    fn put(&mut self, field: &Field, value: serde_json::Value) {
        let text = || match &value {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        match field.name() {
            "message" => self.event.text = text(),
            "source" => self.event.source = Some(text()),
            "sid" => self.event.sid = Some(text()),
            "server_id" => self.event.server_id = Some(text()),
            "server" => self.event.server = Some(text()),
            name => {
                self.event.fields.insert(name.to_owned(), value);
            }
        }
    }
}

impl Visit for Reader<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, value.into());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, value.into());
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, value.into());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, value.into());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field, value.into());
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, format!("{value:?}").into());
    }
}

/// The subscriber's one layer: the threshold at the call site, the event into
/// the queue, the session of the spans around it.
struct DiagLayer;

impl<S> Layer<S> for DiagLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn register_callsite(&self, meta: &'static Metadata<'static>) -> Interest {
        // Ours are asked each time — the threshold moves; a library's never.
        if ours(meta) {
            Interest::sometimes()
        } else {
            Interest::never()
        }
    }

    fn enabled(&self, meta: &Metadata<'_>, _: Context<'_, S>) -> bool {
        // A span is the session around an event: kept at every threshold.
        ours(meta) && (meta.is_span() || Level::of(meta.level()) <= threshold())
    }

    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let mut e = Event::new(Level::Info, None, String::new());
        attrs.record(&mut Reader { event: &mut e });
        if e.sid.is_none() && e.server_id.is_none() && e.server.is_none() {
            return;
        }
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(SpanSession {
                sid: e.sid,
                server_id: e.server_id,
                server: e.server,
            });
        }
    }

    fn on_event(&self, event: &tracing::Event<'_>, ctx: Context<'_, S>) {
        let mut e = Event::new(Level::of(event.metadata().level()), None, String::new());
        event.record(&mut Reader { event: &mut e });
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope {
                if let Some(s) = span.extensions().get::<SpanSession>() {
                    e.sid = e.sid.or_else(|| s.sid.clone());
                    e.server_id = e.server_id.or_else(|| s.server_id.clone());
                    e.server = e.server.or_else(|| s.server.clone());
                }
            }
        }
        submit(e);
    }
}

/// russh's `log` records, at «verbose» only: key exchange, the methods a server
/// offers — the steps of a login that fails.
struct LogBridge;

static LOG_BRIDGE: LogBridge = LogBridge;

impl log::Log for LogBridge {
    fn enabled(&self, meta: &log::Metadata<'_>) -> bool {
        threshold() >= Level::Debug
            && meta.level() <= log::Level::Debug
            && meta.target().starts_with("russh")
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let level = match record.level() {
            log::Level::Error => Level::Error,
            log::Level::Warn => Level::Warn,
            log::Level::Info => Level::Info,
            log::Level::Debug | log::Level::Trace => Level::Debug,
        };
        let mut e = Event::new(level, Some("connection"), record.args().to_string());
        e.fields
            .insert("target".into(), record.target().to_owned().into());
        submit(e);
    }

    fn flush(&self) {}
}

// ── Panics ───────────────────────────────────────────────────────────────────

/// A panic is written at once — the writer may be the thread that panicked —
/// and the windows are told through the writer; then the previous hook runs.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        PANICS.fetch_add(1, Ordering::SeqCst);
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let mut e = Event::new(Level::Error, Some("app"), format!("panic: {what}"));
        if let Some(at) = info.location() {
            e.fields
                .insert("at".into(), format!("{}:{}", at.file(), at.line()).into());
        }
        if let Some(name) = std::thread::current().name() {
            e.fields.insert("thread".into(), name.to_owned().into());
        }
        if let Some(diag) = DIAG.get() {
            let line = writer::line(e.cleaned());
            match std::fs::create_dir_all(&diag.files.dir)
                .and_then(|()| writer::append_to(&diag.files.dir.join(writer::FILE), &line))
            {
                Ok(()) | Err(_) => {}
            }
            match diag.tx.try_send(Msg::Panic) {
                Ok(()) | Err(_) => {}
            }
        }
        previous(info);
    }));
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// What a window writes: the facade batches its events (`api/diag.ts`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontEvent {
    pub level: Level,
    #[serde(default)]
    pub source: Option<String>,
    pub text: String,
    #[serde(default)]
    pub fields: Fields,
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub server: Option<String>,
    /// Unix ms the window saw it: a batch arrives half a second later.
    #[serde(default)]
    pub at: Option<u64>,
}

/// Events a window wrote since its last batch.
#[tauri::command]
pub fn diag_write(window: WebviewWindow, events: Vec<FrontEvent>) {
    for f in events {
        let mut e = Event::new(f.level.offered(), f.source.as_deref(), f.text);
        e.at = f.at.unwrap_or(e.at);
        e.fields = f
            .fields
            .into_iter()
            .filter(|(_, v)| !v.is_object() && !v.is_array())
            .collect();
        e.sid = f.sid;
        e.server_id = f.server_id;
        e.server = f.server;
        e.win = Some(window.label().to_owned());
        submit(e);
    }
}

/// The threshold, the panics so far, the bytes on disk, and why the last
/// write failed — what Settings → Journal shows above the list.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub level: Level,
    /// The most the files take, in MB.
    pub size_mb: u32,
    pub panics: u64,
    pub bytes: u64,
    pub error: Option<String>,
    pub folder: Option<String>,
}

fn state() -> State {
    let diag = DIAG.get();
    State {
        level: threshold().offered(),
        size_mb: size_mb(),
        panics: PANICS.load(Ordering::SeqCst),
        bytes: diag.map_or(0, |d| d.files.size()),
        error: diag.and_then(|d| d.shared.error.locked().clone()),
        folder: dir().map(|d| d.display().to_string()),
    }
}

#[tauri::command]
pub fn diag_state() -> State {
    state()
}

/// The user picked a threshold: kept in `diag.json`, in force at once, written
/// as a line at every threshold — a gap in the file must read as «not
/// written», not as «nothing happened» — and told to every window.
#[tauri::command]
pub fn diag_set_level(level: Level) -> AppResult<State> {
    let level = level.offered();
    let was = threshold();
    let mut saved = crate::store::load_diag();
    saved.level = Some(level);
    crate::store::save_diag(&saved)?;
    set_threshold(level);
    if was != level {
        let mut e = Event::new(
            Level::Info,
            Some("settings"),
            format!("diagnostics threshold: {}", query_name(level)),
        );
        e.always = true;
        submit(e);
    }
    tell_windows();
    Ok(state())
}

/// The user picked a size: kept in `diag.json` and in force at once — made
/// smaller, the oldest events go now, not on the next rotations.
#[tauri::command]
pub fn diag_set_size(size_mb: u32) -> AppResult<State> {
    let size_mb = offered_size(size_mb);
    let was = self::size_mb();
    let mut saved = crate::store::load_diag();
    saved.size_mb = Some(size_mb);
    crate::store::save_diag(&saved)?;
    if let Some(diag) = DIAG.get() {
        let (ack, done) = sync_channel(1);
        diag.tx
            .try_send(Msg::Resize(u64::from(size_mb) * MB, ack))
            .map_err(|_| "diagnostics writer is busy, try again")?;
        done.recv_timeout(FLUSH_WAIT)
            .map_err(|_| "diagnostics writer did not answer")?;
    }
    if was != size_mb {
        let mut e = Event::new(
            Level::Info,
            Some("settings"),
            format!("diagnostics size: {size_mb} MB"),
        );
        e.fields.insert("sizeMb".into(), size_mb.into());
        e.always = true;
        submit(e);
    }
    tell_windows();
    Ok(state())
}

fn query_name(level: Level) -> String {
    format!("{level:?}").to_lowercase()
}

/// A page of events, newest first, narrowed here.
#[tauri::command]
pub async fn diag_query(query: query::Query) -> AppResult<query::Page> {
    tauri::async_runtime::spawn_blocking(move || {
        flush();
        let files = DIAG
            .get()
            .map(|d| d.files.oldest_first())
            .unwrap_or_default();
        let (events, unreadable) = query::read(&files);
        query::page(events, unreadable, &query)
    })
    .await
    .map_err(|e| format!("diagnostics read: {e}").into())
}

/// Every file gone. The threshold stays.
#[tauri::command]
pub fn diag_clear() -> AppResult<State> {
    let diag = DIAG.get().ok_or("diagnostics are not running")?;
    let (ack, done) = sync_channel(1);
    diag.tx
        .try_send(Msg::Clear(ack))
        .map_err(|_| "diagnostics writer is busy, try again")?;
    done.recv_timeout(FLUSH_WAIT)
        .map_err(|_| "diagnostics writer did not answer")?;
    Ok(state())
}

/// The files as they are, oldest first, after one line naming the build — to
/// `path`, which the user picked in the save dialog. Nothing leaves the machine
/// any other way (ADR 0004).
#[tauri::command]
pub async fn diag_export(path: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        flush();
        let header = serde_json::json!({
            "vterm": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "exportedAt": now_ms(),
            "threshold": query_name(threshold()),
        });
        let mut out = header.to_string() + "\n";
        for file in DIAG
            .get()
            .map(|d| d.files.oldest_first())
            .unwrap_or_default()
        {
            out.push_str(&std::fs::read_to_string(&file)?);
        }
        std::fs::write(&path, out)?;
        Ok(())
    })
    .await
    .map_err(|e| crate::error::AppError::from(format!("diagnostics export: {e}")))?
}

/// Show the folder in the system's file manager.
#[tauri::command]
pub fn diag_reveal() -> AppResult<()> {
    let dir = dir().ok_or("could not resolve the data folder")?;
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(writer::FILE);
    let target = if file.is_file() { file } else { dir };
    tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| e.to_string().into())
}

/// One test at a time moves the global threshold.
#[cfg(test)]
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run `f` with the diagnostics heard on this thread — at «verbose», through
/// the real subscriber — and return what it wrote: a test of a failure path
/// checks the event it leaves (DoD, ADR 0063).
#[cfg(test)]
pub fn capture<R>(f: impl FnOnce() -> R) -> (R, Vec<Event>) {
    let _held = TEST_LOCK.locked();
    let was = threshold();
    set_threshold(Level::Debug);
    let c = Capture::start();
    let r = tracing::subscriber::with_default(tracing_subscriber::registry().with(DiagLayer), f);
    let events = c.events();
    set_threshold(was);
    (r, events)
}

/// A test's events: kept on this thread instead of written, until dropped.
#[cfg(test)]
pub struct Capture;

#[cfg(test)]
impl Capture {
    pub fn start() -> Capture {
        CAPTURED.with(|c| *c.borrow_mut() = Some(Vec::new()));
        Capture
    }

    pub fn events(&self) -> Vec<Event> {
        CAPTURED.with(|c| c.borrow().clone().unwrap_or_default())
    }
}

#[cfg(test)]
impl Drop for Capture {
    fn drop(&mut self) {
        CAPTURED.with(|c| *c.borrow_mut() = None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(level: Level, f: impl FnOnce()) {
        let _held = TEST_LOCK.locked();
        let was = threshold();
        set_threshold(level);
        f();
        set_threshold(was);
    }

    #[test]
    fn an_event_below_the_threshold_is_written_nowhere() {
        at(Level::Warn, || {
            let c = Capture::start();
            for level in [Level::Error, Level::Warn, Level::Info, Level::Debug] {
                submit(Event::new(level, Some("app"), format!("{level:?}")));
            }
            let kept: Vec<Level> = c.events().iter().map(|e| e.level).collect();
            assert_eq!(kept, [Level::Error, Level::Warn]);
        });
    }

    #[test]
    fn errors_and_a_threshold_change_pass_every_threshold() {
        at(Level::Error, || {
            let c = Capture::start();
            submit(Event::new(Level::Error, Some("app"), "boom".into()));
            let mut change = Event::new(Level::Info, Some("settings"), "threshold".into());
            change.always = true;
            submit(change);
            submit(Event::new(Level::Warn, Some("app"), "not this".into()));
            assert_eq!(c.events().len(), 2);
        });
    }

    #[test]
    fn a_tracing_call_goes_through_the_threshold_and_the_session_span() {
        at(Level::Info, || {
            let c = Capture::start();
            let subscriber = tracing_subscriber::registry().with(DiagLayer);
            tracing::subscriber::with_default(subscriber, || {
                let span = tracing::info_span!("session", sid = "tab-1", server = "prod-db");
                let _in = span.enter();
                tracing::warn!(
                    source = "storage",
                    path = "/etc/x",
                    count = 3,
                    "known_hosts not written"
                );
                tracing::debug!(source = "storage", "not at info");
            });
            let events = c.events();
            assert_eq!(events.len(), 1);
            let e = &events[0];
            assert_eq!(
                (e.level, e.source.as_deref(), e.text.as_str()),
                (Level::Warn, Some("storage"), "known_hosts not written")
            );
            assert_eq!(
                (e.sid.as_deref(), e.server.as_deref()),
                (Some("tab-1"), Some("prod-db"))
            );
            assert_eq!(e.fields["path"], "/etc/x");
            assert_eq!(e.fields["count"], 3);
        });
    }

    #[test]
    fn an_unknown_source_is_none_and_a_secret_field_carries_no_value() {
        at(Level::Info, || {
            let c = Capture::start();
            let mut e = Event::new(Level::Info, Some("Not A Source"), "x".into());
            e.fields.insert("db_password".into(), "hunter2".into());
            submit(e);
            let got = &c.events()[0];
            assert_eq!(got.source, None);
            assert_eq!(got.fields["db_password"], mask::REDACTED);
        });
    }

    #[test]
    fn russh_is_bridged_only_at_verbose() {
        let meta = |level| {
            log::Metadata::builder()
                .level(level)
                .target("russh::client")
                .build()
        };
        let other = log::Metadata::builder()
            .level(log::Level::Debug)
            .target("hyper::proto")
            .build();
        at(Level::Info, || {
            assert!(!log::Log::enabled(&LOG_BRIDGE, &meta(log::Level::Debug)));
        });
        at(Level::Debug, || {
            assert!(log::Log::enabled(&LOG_BRIDGE, &meta(log::Level::Debug)));
            assert!(!log::Log::enabled(&LOG_BRIDGE, &meta(log::Level::Trace)));
            assert!(!log::Log::enabled(&LOG_BRIDGE, &other));
        });
    }

    #[test]
    fn a_field_is_a_secret_by_its_words_not_by_a_letter_run() {
        for secret in [
            "password",
            "db_password",
            "accessToken",
            "api_key",
            "apiKey",
            "private_key",
            "cookie",
        ] {
            assert!(is_secret_field(secret), "{secret}");
        }
        for plain in ["tokens_in", "passed", "keys", "path", "bypass", "key_id"] {
            assert!(!is_secret_field(plain), "{plain}");
        }
    }

    #[test]
    fn a_dropped_error_is_written_and_a_per_chunk_one_only_once() {
        at(Level::Debug, || {
            let c = Capture::start();
            let subscriber = tracing_subscriber::registry().with(DiagLayer);
            tracing::subscriber::with_default(subscriber, || {
                assert_eq!(Ok::<u8, String>(7).log_warn("storage", "save"), Some(7));
                assert_eq!(
                    Err::<u8, _>("disk full").log_warn("storage", "save known_hosts"),
                    None
                );
                Err::<(), _>("gone").log_debug("windows", "emit window://close");
                Err::<(), u8>(1).log_unheard("windows", "answer the drop");
                let first = FirstFailure::new("terminal", "emit term://out");
                for _ in 0..3 {
                    first.note(Err::<(), _>("webview gone"));
                }
            });
            let got: Vec<(Level, String)> =
                c.events().into_iter().map(|e| (e.level, e.text)).collect();
            assert_eq!(
                got,
                [
                    (Level::Warn, "save known_hosts: disk full".to_owned()),
                    (Level::Debug, "emit window://close: gone".to_owned()),
                    (
                        Level::Debug,
                        "answer the drop: nobody was waiting".to_owned()
                    ),
                    (
                        Level::Debug,
                        "emit term://out: webview gone (later failures are not written)".to_owned()
                    ),
                ]
            );
        });
    }

    #[test]
    fn a_size_is_one_the_settings_offer() {
        assert_eq!(offered_size(25), 25);
        assert_eq!(offered_size(0), 5);
        assert_eq!(offered_size(30), 25);
        assert_eq!(offered_size(10_000), 250);
        assert!(SIZES_MB.contains(&DEFAULT_SIZE_MB));
        let saved: Settings = serde_json::from_str(r#"{"level":"warn"}"#).expect("parse");
        assert_eq!(saved.size_mb(), DEFAULT_SIZE_MB);
        let saved: Settings = serde_json::from_str(r#"{"sizeMb":100}"#).expect("parse");
        assert_eq!(saved.size_mb(), 100);
    }

    #[test]
    fn trace_is_never_a_threshold_to_pick() {
        assert_eq!(Level::Trace.offered(), Level::Debug);
        assert_eq!(Level::Warn.offered(), Level::Warn);
        let saved: Settings = serde_json::from_str(r#"{"level":"warn"}"#).expect("parse");
        assert_eq!(saved.level, Some(Level::Warn));
    }
}

/// The gates over the crate's source: what an event must carry and where the
/// diagnostics may be written. Each check is a function over text, shown first
/// to catch the violation it exists for.
#[cfg(test)]
mod gates {
    use super::is_secret_field;
    use std::path::{Path, PathBuf};

    const LEVELS: [&str; 5] = ["error", "warn", "info", "debug", "trace"];

    /// Every `.rs` file under `src/`, with its path relative to it.
    fn sources() -> Vec<(String, String)> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut out = Vec::new();
        let mut stack: Vec<PathBuf> = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("read src") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    let rel = path
                        .strip_prefix(&root)
                        .expect("under src")
                        .to_string_lossy()
                        .replace('\\', "/");
                    let mut text = std::fs::read_to_string(&path).expect("read source");
                    // These gates' own samples are violations on purpose.
                    if let Some(at) = text.find("\nmod gates {") {
                        text.truncate(at);
                    }
                    out.push((rel, without_comments(&text)));
                }
            }
        }
        out
    }

    /// The code of `src`, line comments cut (a doc line names macros freely).
    fn without_comments(src: &str) -> String {
        src.lines()
            .map(|l| {
                let t = l.trim_start();
                if t.starts_with("//") {
                    ""
                } else {
                    l
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The argument text of every `tracing::<level>!(…)` event in `src`.
    fn events(src: &str) -> Vec<String> {
        let mut out = Vec::new();
        for level in LEVELS {
            let head = format!("tracing::{level}!(");
            let mut from = 0;
            while let Some(at) = src[from..].find(&head) {
                let start = from + at + head.len();
                let mut depth = 1;
                let mut end = start;
                for (i, c) in src[start..].char_indices() {
                    match c {
                        '(' => depth += 1,
                        ')' => depth -= 1,
                        _ => {}
                    }
                    if depth == 0 {
                        end = start + i;
                        break;
                    }
                }
                out.push(src[start..end].to_owned());
                from = end.max(start);
            }
        }
        out
    }

    /// Events that do not say their source.
    fn untagged(src: &str) -> Vec<String> {
        events(src)
            .into_iter()
            .filter(|args| !args.contains("source ="))
            .collect()
    }

    /// Field names of events that would carry a secret (`password = …`, `%token`).
    fn secret_fields(src: &str) -> Vec<String> {
        let named = regex::Regex::new(
            r"(?:^|[,(\s])([A-Za-z_][A-Za-z0-9_.]*)\s*=[^=]|[%?]([A-Za-z_][A-Za-z0-9_]*)",
        )
        .expect("pattern");
        let mut out = Vec::new();
        for args in events(src) {
            for caps in named.captures_iter(&args) {
                let name = caps
                    .get(1)
                    .or_else(|| caps.get(2))
                    .map_or("", |m| m.as_str());
                if is_secret_field(name) {
                    out.push(format!("{name} in {args}"));
                }
            }
        }
        out
    }

    #[test]
    fn every_event_of_the_app_names_its_source_and_carries_no_secret() {
        // Shown on its own violations first.
        let bad = r#"tracing::warn!(path = %p, "no source"); tracing::info!(source = "app", password = %pw, "x"); tracing::debug!(source = "ai", %access_token, "y");"#;
        assert_eq!(untagged(bad).len(), 1);
        assert_eq!(secret_fields(bad).len(), 2);
        let good = r#"tracing::warn!(source = "storage", path = %p, tokens_in = 3, "known_hosts not written");"#;
        assert!(untagged(good).is_empty() && secret_fields(good).is_empty());

        let mut offenders = Vec::new();
        for (file, src) in sources() {
            for args in untagged(&src) {
                offenders.push(format!("{file}: event without `source =`: {args}"));
            }
            for found in secret_fields(&src) {
                offenders.push(format!("{file}: secret field: {found}"));
            }
        }
        assert!(offenders.is_empty(), "{offenders:#?}");
    }

    /// Where a module writes the diagnostics files or emits per chunk.
    fn misplaced(file: &str, src: &str) -> Vec<String> {
        let mut out = Vec::new();
        if !file.starts_with("diag/") && src.contains(".jsonl") {
            out.push(format!("{file}: names a diagnostics file outside diag/"));
        }
        // A gate's loop runs per chunk of output: an event there would be one per chunk.
        if matches!(file, "outgate.rs" | "aigate.rs") && src.contains("tracing::") {
            out.push(format!("{file}: writes events on the chunk path"));
        }
        // The diagnostics are this machine's history: a backup never carries them.
        if file == "backup.rs" && src.contains("diag") {
            out.push(format!("{file}: reaches into the diagnostics"));
        }
        out
    }

    #[test]
    fn the_diagnostics_are_written_only_by_diag_never_per_chunk_nor_backed_up() {
        assert_eq!(misplaced("store.rs", r#"let f = "vterm.jsonl";"#).len(), 1);
        assert_eq!(
            misplaced(
                "outgate.rs",
                "tracing::debug!(source = \"terminal\", \"chunk\")"
            )
            .len(),
            1
        );
        assert_eq!(misplaced("backup.rs", "crate::diag::dir()").len(), 1);
        assert!(misplaced("diag/writer.rs", r#"const FILE: &str = "vterm.jsonl";"#).is_empty());

        let offenders: Vec<String> = sources()
            .iter()
            .flat_map(|(file, src)| misplaced(file, src))
            .collect();
        assert!(offenders.is_empty(), "{offenders:#?}");
    }
}
