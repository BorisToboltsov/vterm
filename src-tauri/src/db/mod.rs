//! Databases (ADR 0080): PostgreSQL and MySQL spoken to from the backend.
//!
//! A database of a server is reached through that server's SSH connection — a
//! `direct-tcpip` channel to the address the server sees, or `direct-streamlocal`
//! to its socket — so nothing listens or connects on this computer for it. A
//! database of this computer is reached at its loopback or its socket and at
//! nothing further: the one exception to "offline" this module adds
//! (INVARIANTS, principle 6).
//!
//! The window names a tab and a database id; the address, the password and
//! whether it may write are the backend's. A prod server's databases open
//! read-only; a statement the user agreed to may lift that for itself alone
//! (`writable`). What runs without that is decided here ([`sql`], [`admit`]),
//! whatever the window made of it. Read-only is a fuse, not a wall: a function
//! of the database's own may write — the wall is the role the database gave.
//!
//! What a statement says and what it returns never reach the diagnostics: only
//! that it ran, how long and how many rows; an error — by its code.

pub mod my;
pub mod net;
pub mod pg;
pub mod relay;
pub mod sql;

use crate::diag::Logged;
use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use net::Target;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The most rows a statement may bring back.
pub const MAX_ROWS: usize = 10_000;
/// A cell longer than this (bytes of text) is cut, and the answer says which.
pub const MAX_CELL: usize = 64 * 1024;
/// Rows stop once the answer holds this much text: a wide table of long values
/// would otherwise fill memory before reaching its row count.
pub const MAX_RESULT_BYTES: usize = 32 * 1024 * 1024;

/// The rows a statement may bring back, as asked: never none, never over [`MAX_ROWS`].
pub fn row_cap(asked: u32) -> usize {
    (asked as usize).clamp(1, MAX_ROWS)
}

/// Whether a database opens read-only: always on a prod server, otherwise as
/// its profile says.
pub fn opens_read_only(prod: bool, profile_read_only: bool) -> bool {
    prod || profile_read_only
}

/// A column of an answer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// The type as the database names it (`int4`, `varchar`, `LONGLONG`…).
    pub type_name: String,
    /// A number: drawn right-aligned and compared as one.
    pub numeric: bool,
    /// Where the value comes from, when it is a table's column: PostgreSQL —
    /// the table's oid and the column's number; MySQL — `schema.table` and the
    /// column's name. None — computed.
    pub table: Option<String>,
    pub column: Option<String>,
    /// Part of the table's primary key, when the database says (MySQL does).
    pub key: bool,
}

/// What the database said was wrong with a statement.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SqlError {
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// SQLSTATE (PostgreSQL) or the error number (MySQL).
    pub code: String,
    /// 1-based character in the statement, when the database names one.
    pub position: Option<u32>,
}

/// Where a connection stands in a transaction of the user's.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Tx {
    #[default]
    None,
    Open,
    /// PostgreSQL after an error inside one: only a rollback goes on from here.
    Aborted,
}

/// The answer to one statement: its rows, or what the database said was wrong.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Option<String>>>,
    /// The cells cut at [`MAX_CELL`]: `[row, column]`.
    pub cut: Vec<[u32; 2]>,
    /// More rows were there; the statement was stopped after the ones shown.
    pub truncated: bool,
    /// Rows a statement without rows changed.
    pub affected: Option<u64>,
    pub elapsed_ms: u64,
    /// What the database said along the way (PostgreSQL notices, MySQL warnings).
    pub notices: Vec<String>,
    pub error: Option<SqlError>,
    /// The backend took it for a read: its rows may be edited, and it run again.
    pub read: bool,
    /// The transaction, as it stands after it.
    pub tx: Tx,
    /// `\\` escapes inside a string now: how a value is written as a literal.
    pub backslash_escapes: bool,
}

/// What applying edits came to: every row's count, or the one that stopped it.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub changed: Vec<u64>,
    pub failure: Option<ApplyFailure>,
}

/// Why nothing was applied. A value of an answer rather than a refusal: the
/// database's words may quote the row's values, and a refused command is
/// written to the diagnostics.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyFailure {
    /// The 1-based statement; none — the transaction itself.
    pub statement: Option<u32>,
    /// It changed this many rows instead of one.
    pub changed: Option<u64>,
    pub error: Option<SqlError>,
}

impl Applied {
    pub(crate) fn failed(index: Option<usize>, error: SqlError) -> Applied {
        Applied {
            changed: Vec::new(),
            failure: Some(ApplyFailure {
                statement: index.map(|i| i as u32 + 1),
                changed: None,
                error: Some(error),
            }),
        }
    }

    pub(crate) fn not_one(index: usize, changed: u64) -> Applied {
        Applied {
            changed: Vec::new(),
            failure: Some(ApplyFailure {
                statement: Some(index as u32 + 1),
                changed: Some(changed),
                error: None,
            }),
        }
    }
}

impl Outcome {
    pub fn failed(error: SqlError, started: std::time::Instant) -> Outcome {
        Outcome {
            error: Some(error),
            elapsed_ms: started.elapsed().as_millis() as u64,
            ..Outcome::default()
        }
    }
}

/// Rows as they arrive, kept within the cap and the byte budget.
pub(crate) struct Rows {
    pub rows: Vec<Vec<Option<String>>>,
    pub cut: Vec<[u32; 2]>,
    bytes: usize,
    cap: usize,
    pub truncated: bool,
}

impl Rows {
    pub fn new(cap: usize) -> Rows {
        Rows {
            rows: Vec::new(),
            cut: Vec::new(),
            bytes: 0,
            cap,
            truncated: false,
        }
    }

    /// Take a row; false — the cap or the budget is reached and the row was not
    /// taken: the statement should be stopped.
    pub fn push<'a>(
        &mut self,
        cells: impl IntoIterator<Item = Option<std::borrow::Cow<'a, str>>>,
    ) -> bool {
        if self.rows.len() >= self.cap || self.bytes >= MAX_RESULT_BYTES {
            self.truncated = true;
            return false;
        }
        let r = self.rows.len() as u32;
        let row: Vec<Option<String>> = cells
            .into_iter()
            .enumerate()
            .map(|(c, cell)| {
                cell.map(|v| {
                    self.bytes += v.len();
                    if v.len() > MAX_CELL {
                        self.cut.push([r, c as u32]);
                        let mut end = MAX_CELL;
                        while !v.is_char_boundary(end) {
                            end -= 1;
                        }
                        v[..end].to_string()
                    } else {
                        v.into_owned()
                    }
                })
            })
            .collect();
        self.rows.push(row);
        true
    }
}

/// A driver of one connection.
pub(crate) enum Driver {
    Pg(pg::Pg),
    My(my::My),
}

/// How a running statement is stopped: a connection of its own to the same place.
#[derive(Clone)]
pub(crate) enum Canceller {
    Pg(tokio_postgres::CancelToken, Target),
    My(my::Killer),
}

impl Canceller {
    pub async fn cancel(&self) -> AppResult<()> {
        match self {
            Canceller::Pg(token, target) => {
                let stream = target.open().await?;
                token
                    .cancel_query_raw(stream, tokio_postgres::NoTls)
                    .await
                    .map_err(|e| AppError::Message(format!("the statement was not stopped: {e}")))
            }
            Canceller::My(killer) => killer.kill().await,
        }
    }
}

/// How a driver is to run an admitted statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Run {
    pub cap: usize,
    /// Read-only lifted for it alone.
    pub lift: bool,
    /// Read-only said again first: whatever a statement before it did.
    pub hold: bool,
    /// Stopped at the cap — a read outside a transaction alone: stopping a
    /// change rolls it back, stopping inside a transaction aborts that.
    pub stop_at_cap: bool,
}

/// Whether a statement runs on this connection, and how.
pub(crate) fn admit(
    kind: crate::model::DbKind,
    read_only: bool,
    writable: bool,
    tx: Tx,
    cap: usize,
    c: &sql::Checked,
) -> AppResult<Run> {
    // PostgreSQL's prepare takes one statement by itself; MySQL's text protocol
    // takes as many as it is given.
    if kind == crate::model::DbKind::Mysql && c.count > 1 {
        return Err(AppError::DbManyStatements);
    }
    let outside = tx == Tx::None;
    let mut lift = false;
    if read_only && !c.safe {
        if c.count > 1 {
            return Err(AppError::DbManyStatements);
        }
        if !writable {
            return Err(AppError::DbReadOnly);
        }
        if c.outlasts {
            return Err(AppError::DbLiftScope);
        }
        if !outside {
            return Err(AppError::DbTxOpen);
        }
        lift = true;
    }
    Ok(Run {
        cap,
        lift,
        hold: read_only && outside && !lift,
        stop_at_cap: c.read && outside,
    })
}

/// Where PostgreSQL's transaction stands after a statement (MySQL says itself).
pub(crate) fn tx_after(before: Tx, c: &sql::Checked, ok: bool) -> Tx {
    use sql::Effect;
    match c.effect {
        // A COMMIT that failed ended it as well; a malformed one did not.
        Effect::Close if ok || c.safe => return Tx::None,
        Effect::Open if ok => return Tx::Open,
        Effect::Recover if ok && before != Tx::None => return Tx::Open,
        _ => {}
    }
    if !ok && before != Tx::None {
        Tx::Aborted
    } else {
        before
    }
}

/// A stop sent at the row cap. It is waited for before the next statement:
/// arriving late, it would stop that one instead.
pub(crate) struct CapStop(tokio::task::JoinHandle<()>);

impl CapStop {
    pub fn send(canceller: &Canceller) -> CapStop {
        let canceller = canceller.clone();
        // In the background, reading on: a cancel is a channel of its own, and
        // an SSH connection whose channel is not read opens no other one.
        CapStop(tokio::spawn(async move {
            canceller.cancel().await.log_warn(
                "db",
                "a statement past the row limit was not stopped: its other rows are read and dropped",
            );
        }))
    }

    pub async fn settle(self) {
        let CapStop(mut sent) = self;
        match tokio::time::timeout(net::OPEN_TIMEOUT, &mut sent).await {
            Ok(done) => {
                done.log_debug("db", "the stop at the row limit did not finish");
            }
            Err(_) => sent.abort(),
        }
    }
}

impl Driver {
    fn kind(&self) -> crate::model::DbKind {
        match self {
            Driver::Pg(_) => crate::model::DbKind::Postgres,
            Driver::My(_) => crate::model::DbKind::Mysql,
        }
    }
}

/// What a connection is spoken to with, and how it stands.
struct Inner {
    driver: Driver,
    mode: sql::Mode,
    tx: Tx,
}

impl Inner {
    /// How the server reads quotes, asked of it.
    async fn learn(&mut self) {
        let setting = match &mut self.driver {
            Driver::Pg(pg) => pg.quote_setting().await,
            Driver::My(my) => my.quote_setting().await,
        };
        if let Some(v) = setting {
            self.mode = sql::Mode::parse(self.driver.kind(), &v);
        }
        if let Driver::My(my) = &self.driver {
            if let Some(tx) = my.tx() {
                self.tx = tx;
            }
        }
    }
}

/// One open database connection, tied to the tab it was opened from.
pub struct Conn {
    pub session: String,
    pub read_only: bool,
    pub prod: bool,
    inner: tokio::sync::Mutex<Inner>,
    canceller: Canceller,
    busy: AtomicBool,
}

/// Clears `busy` however the statement ends.
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Conn {
    pub(crate) async fn open(
        session: String,
        read_only: bool,
        prod: bool,
        driver: Driver,
        canceller: Canceller,
    ) -> Conn {
        let mut inner = Inner {
            mode: sql::Mode::of(driver.kind()),
            driver,
            tx: Tx::None,
        };
        inner.learn().await;
        Conn {
            session,
            read_only,
            prod,
            inner: tokio::sync::Mutex::new(inner),
            canceller,
            busy: AtomicBool::new(false),
        }
    }

    fn take(&self) -> AppResult<Busy<'_>> {
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err(AppError::DbBusy);
        }
        Ok(Busy(&self.busy))
    }

    /// Run one statement. `writable` lifts read-only for it alone. With it —
    /// the recording's line, when it changed something or was let to: built
    /// here, not taken from the window.
    pub async fn run(
        &self,
        text: &str,
        cap: usize,
        writable: bool,
    ) -> (Option<String>, AppResult<Outcome>) {
        let _busy = match self.take() {
            Ok(b) => b,
            Err(e) => return (None, Err(e)),
        };
        let mut inner = self.inner.lock().await;
        let kind = inner.driver.kind();
        let checked = sql::check(kind, inner.mode, text);
        let how = match admit(kind, self.read_only, writable, inner.tx, cap, &checked) {
            Ok(how) => how,
            Err(e) => return (None, Err(e)),
        };
        let said = (!checked.safe).then(|| checked.audit.clone());
        let mut out = match &mut inner.driver {
            Driver::Pg(pg) => pg.run(text, how, &self.canceller).await,
            Driver::My(my) => my.run(text, how, &self.canceller).await,
        };
        if let Ok(o) = &mut out {
            inner.tx = match &inner.driver {
                Driver::Pg(_) => tx_after(inner.tx, &checked, o.error.is_none()),
                Driver::My(my) => my.tx().unwrap_or(inner.tx),
            };
            // A rollback takes a setting back as well.
            let ends = matches!(checked.effect, sql::Effect::Close | sql::Effect::Recover);
            if (checked.remode || ends) && inner.tx != Tx::Aborted {
                inner.learn().await;
            }
            o.read = checked.read;
            o.tx = inner.tx;
            o.backslash_escapes = inner.mode.backslash;
        }
        (said, out)
    }

    /// Apply edits in one transaction: each statement must change exactly one
    /// row, or nothing is applied.
    pub async fn apply(
        &self,
        statements: &[String],
        writable: bool,
    ) -> (Option<String>, AppResult<Applied>) {
        let _busy = match self.take() {
            Ok(b) => b,
            Err(e) => return (None, Err(e)),
        };
        let mut inner = self.inner.lock().await;
        let kind = inner.driver.kind();
        let checked: Vec<sql::Checked> = statements
            .iter()
            .map(|s| sql::check(kind, inner.mode, s))
            .collect();
        if let Err(e) = admit_edits(self.read_only, writable, inner.tx, &checked) {
            return (None, Err(e));
        }
        let mut lines: Vec<&str> = Vec::new();
        for c in &checked {
            if !lines.contains(&c.audit.as_str()) {
                lines.push(&c.audit);
            }
        }
        let said = Some(lines.join("; "));
        let out = match &mut inner.driver {
            Driver::Pg(pg) => pg.apply(statements, self.read_only).await,
            Driver::My(my) => my.apply(statements, self.read_only).await,
        };
        (said, out)
    }

    /// Stop the statement running now (nothing — when none is).
    pub async fn cancel(&self) -> AppResult<()> {
        if !self.busy.load(Ordering::Acquire) {
            return Ok(());
        }
        self.canceller.cancel().await
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }
}

/// Whether edits may be applied: only UPDATEs and DELETEs, each alone, outside
/// a transaction of the user's — its COMMIT would be theirs.
pub(crate) fn admit_edits(
    read_only: bool,
    writable: bool,
    tx: Tx,
    checked: &[sql::Checked],
) -> AppResult<()> {
    if checked.is_empty() || checked.len() > MAX_ROWS || !checked.iter().all(|c| c.edit) {
        return Err(AppError::DbNotAnEdit);
    }
    if read_only && !writable {
        return Err(AppError::DbReadOnly);
    }
    if tx != Tx::None {
        return Err(AppError::DbTxOpen);
    }
    Ok(())
}

/// A connection let go of with a statement running: the server is told to stop
/// it, or it would run on — and hold the tab's SSH connection — until its end.
pub fn let_go(conn: Arc<Conn>) {
    if conn.is_busy() {
        tauri::async_runtime::spawn(async move {
            conn.cancel().await.log_warn(
                "db",
                "a closed connection's statement was not stopped: it runs to its end on the server",
            );
        });
    }
}

/// The open connections, by id, each with the tab it dies with.
#[derive(Default)]
pub struct Dbs {
    inner: Mutex<HashMap<String, Arc<Conn>>>,
}

impl Dbs {
    pub fn insert(&self, id: String, conn: Arc<Conn>) {
        self.inner.locked().insert(id, conn);
    }

    pub fn get(&self, id: &str) -> AppResult<Arc<Conn>> {
        self.inner
            .locked()
            .get(id)
            .cloned()
            .ok_or(AppError::DbClosed)
    }

    pub fn remove(&self, id: &str) -> Option<Arc<Conn>> {
        self.inner.locked().remove(id)
    }

    /// Take every connection of a tab out (it closed): for [`let_go`].
    pub fn close_session(&self, session: &str) -> Vec<Arc<Conn>> {
        let mut map = self.inner.locked();
        let ids: Vec<String> = map
            .iter()
            .filter(|(_, c)| c.session == session)
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter().filter_map(|id| map.remove(id)).collect()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.locked().len()
    }
}

/// A profile as the window or an archive gave it, checked: an id, an address
/// and a user on one line each — they reach a keychain account, an SSH channel,
/// a login, and the argv of the user's own client, where a leading `-` would be
/// an option.
pub fn check_profile(p: &crate::model::DbProfile) -> AppResult<()> {
    let one_line = |s: &str| !s.contains(['\n', '\r', '\0']);
    let value = |s: &str| one_line(s) && !s.trim_start().starts_with('-');
    let host = p.host.trim();
    let ok = !p.id.is_empty()
        && p.id.len() <= 64
        && p.id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !host.is_empty()
        && p.host.len() <= 1024
        && value(&p.host)
        && (host.starts_with('/') || !host.contains(char::is_whitespace))
        && p.port > 0
        && !p.user.trim().is_empty()
        && p.user.len() <= 256
        && value(&p.user)
        && p.database.len() <= 256
        && value(&p.database)
        && p.name.len() <= 200
        && one_line(&p.name)
        && p.container.as_deref().is_none_or(|c| {
            c.len() <= 256
                && c.starts_with(|f: char| f.is_ascii_alphanumeric())
                && c.chars()
                    .all(|x| x.is_ascii_alphanumeric() || matches!(x, '_' | '.' | '-'))
        });
    if ok {
        Ok(())
    } else {
        Err(AppError::DbBadProfile)
    }
}

/// The same place and login: all a saved password was typed for.
pub fn same_endpoint(a: &crate::model::DbProfile, b: &crate::model::DbProfile) -> bool {
    a.kind == b.kind && a.host.trim() == b.host.trim() && a.port == b.port && a.user == b.user
}

/// The profiles to keep: the window's list, each checked, with "password saved"
/// as the backend knows it (the window cannot claim one, and it does not follow
/// a changed address or user); and the ids whose passwords go — of those that
/// left and those that moved.
pub fn merge_profiles(
    old: &[crate::model::DbProfile],
    new: Vec<crate::model::DbProfile>,
) -> AppResult<(Vec<crate::model::DbProfile>, Vec<String>)> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(new.len());
    let mut forget = Vec::new();
    for mut p in new {
        check_profile(&p)?;
        if !seen.insert(p.id.clone()) {
            return Err(format!("a database profile twice: {}", p.id).into());
        }
        let was = old.iter().find(|o| o.id == p.id);
        let same = was.is_some_and(|o| same_endpoint(o, &p));
        p.has_saved_password = same && was.is_some_and(|o| o.has_saved_password);
        if was.is_some() && !same {
            forget.push(p.id.clone());
        }
        out.push(p);
    }
    forget.extend(
        old.iter()
            .filter(|o| !seen.contains(&o.id))
            .map(|o| o.id.clone()),
    );
    Ok((out, forget))
}

/// A catalog about to be written by an import: "password saved" only where this
/// computer saved it, for that very place and login.
pub fn keep_password_flags(
    current: &[crate::model::ServerProfile],
    incoming: &mut [crate::model::ServerProfile],
) {
    for server in incoming {
        let here = current.iter().find(|s| s.id == server.id);
        for d in &mut server.databases {
            d.has_saved_password = here
                .and_then(|s| s.databases.iter().find(|o| o.id == d.id))
                .is_some_and(|o| o.has_saved_password && same_endpoint(o, d));
        }
    }
}

/// A line for the recording as one line, and short: a table's quoted name may
/// hold a line break.
pub fn audit_line(said: &str) -> String {
    let flat: String = said
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(200)
        .collect();
    flat.trim().to_string()
}

/// The text a database answered with, cut to what a statement may hold in a
/// cell — shared by both drivers.
pub(crate) fn text_of(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    match std::str::from_utf8(bytes) {
        Ok(s) => std::borrow::Cow::Borrowed(s),
        Err(_) => {
            // Not text: shown as hex, the way the clients print bytea and BLOBs.
            let mut out = String::with_capacity(2 + bytes.len().min(MAX_CELL) * 2);
            out.push_str("0x");
            for b in bytes.iter().take(MAX_CELL / 2) {
                out.push_str(&format!("{b:02x}"));
            }
            std::borrow::Cow::Owned(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DbKind;
    use std::borrow::Cow;

    #[test]
    fn a_prod_database_opens_read_only_whatever_its_profile_says() {
        assert!(opens_read_only(true, false));
        assert!(opens_read_only(true, true));
        assert!(opens_read_only(false, true));
        assert!(!opens_read_only(false, false));
    }

    #[test]
    fn the_row_cap_is_never_none_and_never_over_the_most() {
        assert_eq!(row_cap(0), 1);
        assert_eq!(row_cap(500), 500);
        assert_eq!(row_cap(u32::MAX), MAX_ROWS);
    }

    #[test]
    fn rows_stop_at_the_cap_and_a_long_cell_is_cut_and_named() {
        let mut rows = Rows::new(2);
        assert!(rows.push([Some(Cow::Borrowed("a")), None]));
        let long = "ж".repeat(MAX_CELL); // two bytes a char: the cut lands mid-char
        assert!(rows.push([Some(Cow::Owned(long)), Some(Cow::Borrowed("b"))]));
        assert!(!rows.push([Some(Cow::Borrowed("c")), None]));
        assert!(rows.truncated);
        assert_eq!(rows.rows.len(), 2);
        assert_eq!(rows.rows[0][1], None);
        assert_eq!(rows.cut, vec![[1, 0]]);
        let cut = rows.rows[1][0].as_ref().expect("cut cell");
        assert!(cut.len() <= MAX_CELL && cut.chars().all(|c| c == 'ж'));
    }

    #[test]
    fn bytes_that_are_not_text_are_shown_as_hex() {
        assert_eq!(text_of(b"abc"), "abc");
        assert_eq!(text_of(&[0xff, 0x00, 0x10]), "0xff0010");
    }

    fn profile(id: &str, saved: bool) -> crate::model::DbProfile {
        crate::model::DbProfile {
            id: id.into(),
            name: "billing".into(),
            kind: DbKind::Postgres,
            host: "127.0.0.1".into(),
            port: 5432,
            database: "billing".into(),
            user: "app".into(),
            has_saved_password: saved,
            read_only: false,
            container: None,
        }
    }

    #[test]
    fn the_window_cannot_claim_a_saved_password_and_a_profile_that_left_is_named() {
        let old = vec![profile("a", true), profile("b", false), profile("c", true)];
        let (kept, gone) = merge_profiles(
            &old,
            vec![profile("a", false), profile("b", true), profile("d", true)],
        )
        .expect("valid");
        let saved: Vec<bool> = kept.iter().map(|p| p.has_saved_password).collect();
        assert_eq!(saved, vec![true, false, false]);
        assert_eq!(gone, vec!["c".to_string()]);
        assert!(merge_profiles(&old, vec![profile("a", false), profile("a", false)]).is_err());
    }

    #[test]
    fn a_profile_holds_one_line_per_field_and_a_plain_id() {
        assert!(check_profile(&profile("db-1_x", false)).is_ok());
        for bad in [
            crate::model::DbProfile {
                id: "a::b".into(),
                ..profile("a", false)
            },
            crate::model::DbProfile {
                host: "h\nx".into(),
                ..profile("a", false)
            },
            crate::model::DbProfile {
                user: " ".into(),
                ..profile("a", false)
            },
            crate::model::DbProfile {
                port: 0,
                ..profile("a", false)
            },
            crate::model::DbProfile {
                container: Some("c\r".into()),
                ..profile("a", false)
            },
        ] {
            assert!(check_profile(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn an_audit_line_is_one_short_line() {
        assert_eq!(audit_line("UPDATE\ninvoices"), "UPDATE invoices");
        assert_eq!(audit_line(&"x".repeat(500)).len(), 200);
    }

    #[test]
    fn a_saved_password_never_follows_a_changed_place_or_user() {
        type Change = fn(&mut crate::model::DbProfile);
        let changes: [Change; 4] = [
            |p| p.host = "10.0.0.9".into(),
            |p| p.port = 6432,
            |p| p.user = "admin".into(),
            |p| p.kind = DbKind::Mysql,
        ];
        for change in changes {
            let mut moved = profile("a", true);
            change(&mut moved);
            let (kept, forget) =
                merge_profiles(&[profile("a", true)], vec![moved.clone()]).expect("valid");
            assert!(!kept[0].has_saved_password);
            assert_eq!(forget, vec!["a".to_string()]);

            let mut mine: crate::model::ServerProfile = serde_json::from_value(serde_json::json!({
                "id": "s", "alias": "s", "host": "example.com", "port": 22, "username": "root"
            }))
            .expect("a server");
            mine.databases = vec![profile("a", true)];
            let mut theirs = mine.clone();
            theirs.databases = vec![moved];
            let mut incoming = [theirs];
            keep_password_flags(&[mine.clone()], &mut incoming);
            assert!(!incoming[0].databases[0].has_saved_password);
            let mut same = [mine.clone()];
            keep_password_flags(&[mine], &mut same);
            assert!(same[0].databases[0].has_saved_password);
            let mut stranger = [same[0].clone()];
            keep_password_flags(&[], &mut stranger);
            assert!(!stranger[0].databases[0].has_saved_password);
        }
        let mut renamed = profile("a", false);
        renamed.name = "prod billing".into();
        let (kept, forget) = merge_profiles(&[profile("a", true)], vec![renamed]).expect("valid");
        assert!(kept[0].has_saved_password && forget.is_empty());
    }

    #[test]
    fn nothing_of_a_profile_can_be_an_option_of_the_users_client() {
        type Change = fn(&mut crate::model::DbProfile);
        let changes: [Change; 6] = [
            |p| p.host = "--defaults-file=/tmp/x".into(),
            |p| p.host = "db host".into(),
            |p| p.user = "-c".into(),
            |p| p.database = "--init-command=DROP DATABASE x".into(),
            |p| p.container = Some("--privileged".into()),
            |p| p.container = Some("db;id".into()),
        ];
        for change in changes {
            let mut p = profile("a", false);
            change(&mut p);
            assert!(check_profile(&p).is_err(), "{p:?}");
        }
    }

    fn judged(kind: DbKind, text: &str) -> sql::Checked {
        sql::check(kind, sql::Mode::of(kind), text)
    }

    #[test]
    fn read_only_is_held_by_the_backend_whatever_the_window_asked() {
        let pg = DbKind::Postgres;
        let go = |text: &str, writable: bool, tx: Tx| {
            admit(pg, true, writable, tx, 10, &judged(pg, text))
        };
        assert!(matches!(
            go("DELETE FROM t", false, Tx::None),
            Err(AppError::DbReadOnly)
        ));
        assert!(matches!(
            go("SET default_transaction_read_only = off", true, Tx::None),
            Err(AppError::DbLiftScope)
        ));
        assert!(matches!(
            go("DELETE FROM t", true, Tx::Open),
            Err(AppError::DbTxOpen)
        ));
        assert!(matches!(
            go("SELECT 1; DELETE FROM t", true, Tx::None),
            Err(AppError::DbManyStatements)
        ));
        let lifted = go("DELETE FROM t", true, Tx::None).expect("agreed to");
        assert!(lifted.lift && !lifted.hold && !lifted.stop_at_cap);
        // Agreeing lifts nothing for a statement that does not need it: a
        // transaction never begins with the lock off.
        let begin = go("BEGIN", true, Tx::None).expect("safe");
        assert!(!begin.lift && begin.hold);
        let two = judged(DbKind::Mysql, "SELECT 1; DROP TABLE t");
        assert!(matches!(
            admit(DbKind::Mysql, false, true, Tx::None, 10, &two),
            Err(AppError::DbManyStatements)
        ));
    }

    #[test]
    fn only_a_read_outside_a_transaction_is_stopped_at_the_row_cap() {
        let pg = DbKind::Postgres;
        let stops = |text: &str, tx: Tx| {
            admit(pg, false, false, tx, 10, &judged(pg, text))
                .expect("a connection that writes")
                .stop_at_cap
        };
        assert!(stops("SELECT * FROM t", Tx::None));
        assert!(!stops("SELECT * FROM t", Tx::Open));
        assert!(!stops("UPDATE t SET a = 1 RETURNING *", Tx::None));
    }

    #[test]
    fn edits_are_updates_and_deletes_outside_the_users_transaction() {
        let one = |text: &str| vec![judged(DbKind::Postgres, text)];
        let edit = one("UPDATE t SET a = '1' WHERE id = '1'");
        assert!(admit_edits(false, false, Tx::None, &edit).is_ok());
        assert!(matches!(
            admit_edits(true, false, Tx::None, &edit),
            Err(AppError::DbReadOnly)
        ));
        assert!(matches!(
            admit_edits(false, false, Tx::Open, &edit),
            Err(AppError::DbTxOpen)
        ));
        assert!(matches!(
            admit_edits(false, false, Tx::None, &[]),
            Err(AppError::DbNotAnEdit)
        ));
        assert!(matches!(
            admit_edits(true, true, Tx::None, &one("DROP TABLE t")),
            Err(AppError::DbNotAnEdit)
        ));
    }

    #[test]
    fn a_transaction_is_known_through_savepoints_and_errors() {
        let after =
            |tx: Tx, text: &str, ok: bool| tx_after(tx, &judged(DbKind::Postgres, text), ok);
        assert_eq!(after(Tx::None, "BEGIN", true), Tx::Open);
        assert_eq!(after(Tx::Open, "SAVEPOINT a", true), Tx::Open);
        assert_eq!(after(Tx::Open, "SELECT broken", false), Tx::Aborted);
        assert_eq!(after(Tx::Aborted, "ROLLBACK TO a", true), Tx::Open);
        assert_eq!(after(Tx::Open, "COMMIT", false), Tx::None);
        assert_eq!(after(Tx::Open, "COMMIT garbage", false), Tx::Aborted);
        assert_eq!(after(Tx::None, "SELECT broken", false), Tx::None);
    }

    /// INVARIANTS: what a statement says and what it returns never reach the
    /// diagnostics. A server's error message quotes both.
    #[test]
    fn sql_and_results_never_reach_the_diagnostics() {
        fn offences(src: &str) -> Vec<String> {
            let code = src.split("\n#[cfg(test)]\nmod").next().unwrap_or(src);
            let mut found = Vec::new();
            for (at, _) in code.match_indices("tracing::") {
                let rest = &code[at..];
                let Some(end) = rest.find(");") else { continue };
                let call: String = rest[..end].split_whitespace().collect::<Vec<_>>().join(" ");
                for bad in [
                    "%sql",
                    "?sql",
                    "{sql",
                    "%text",
                    "{text",
                    "%said",
                    "{said",
                    ".message",
                    "{e}",
                    "{e:",
                    "%e,",
                    "?e,",
                    ".detail",
                    ".hint",
                    "?o.rows",
                    "{rows:",
                    "%statement",
                    "{statement",
                ] {
                    // `%sql` is the text; `%sql_error(&e).code` is its code.
                    let whole = call.match_indices(bad).any(|(at, _)| {
                        let next = call[at + bad.len()..].chars().next().unwrap_or(' ');
                        let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
                        !(bad.ends_with(word) && word(next))
                    });
                    if whole {
                        found.push(format!("{bad}: {call}"));
                    }
                }
            }
            found
        }
        assert!(!offences("tracing::debug!(source = \"db\", \"failed: {e}\");").is_empty());
        assert!(!offences("tracing::debug!(source = \"db\", query = %sql, \"ran\");").is_empty());
        assert!(!offences(
            "tracing::warn!(source = \"db\", said = %sql_error(&e).message, \"no\");"
        )
        .is_empty());
        for (name, src) in [
            ("db/mod.rs", include_str!("mod.rs")),
            ("db/pg.rs", include_str!("pg.rs")),
            ("db/my.rs", include_str!("my.rs")),
            ("db/relay.rs", include_str!("relay.rs")),
            ("commands/db.rs", include_str!("../commands/db.rs")),
        ] {
            assert_eq!(offences(src), Vec::<String>::new(), "{name}");
        }
    }

    #[test]
    fn a_tab_takes_its_connections_with_it() {
        let dbs = Dbs::default();
        assert!(matches!(dbs.get("x"), Err(AppError::DbClosed)));
        assert!(dbs.close_session("s").is_empty());
        assert_eq!(dbs.len(), 0);
    }
}

/// Against real databases behind a real sshd (`e2e/docker-compose.db.yml`):
/// what the drivers ask of a server is what these hold, not a model of it.
#[cfg(test)]
mod live_db {
    use super::net::{Addr, Io, Target, Tunnel, Via};
    use super::*;
    use crate::model::{DbKind, DbProfile};
    use futures_util::future::BoxFuture;
    use russh::client;
    use zeroize::Zeroizing;

    struct AcceptAnyKey;

    impl Driver {
        /// Past the policy: what the server itself refuses.
        async fn raw_write(&mut self, text: &str) -> Result<(), String> {
            match self {
                Driver::Pg(pg) => pg.raw_write(text).await,
                Driver::My(my) => my.raw_write(text).await,
            }
        }
    }

    impl client::Handler for AcceptAnyKey {
        type Error = russh::Error;
        // Throwaway local container; its host key is regenerated on every `up`.
        async fn check_server_key(
            &mut self,
            _key: &russh::keys::PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    struct TestTunnel(client::Handle<AcceptAnyKey>);

    impl Tunnel for TestTunnel {
        fn tcp<'a>(&'a self, host: &'a str, port: u16) -> BoxFuture<'a, AppResult<Io>> {
            Box::pin(async move {
                let ch = self
                    .0
                    .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
                    .await
                    .map_err(|e| AppError::DbTunnelRefused(e.to_string()))?;
                Ok(Box::new(ch.into_stream()) as Io)
            })
        }
        fn unix<'a>(&'a self, path: &'a str) -> BoxFuture<'a, AppResult<Io>> {
            Box::pin(async move {
                let ch = self
                    .0
                    .channel_open_direct_streamlocal(path)
                    .await
                    .map_err(|e| AppError::DbTunnelRefused(e.to_string()))?;
                Ok(Box::new(ch.into_stream()) as Io)
            })
        }
    }

    async fn ssh() -> Via {
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            ("127.0.0.1", 2225),
            AcceptAnyKey,
        )
        .await
        .expect("no test sshd — docker compose -f e2e/docker-compose.db.yml up -d --build --wait");
        assert!(handle
            .authenticate_password("tester", "testpass")
            .await
            .expect("auth")
            .success());
        Via::Ssh(Arc::new(TestTunnel(handle)))
    }

    fn profile(kind: DbKind, host: &str, port: u16) -> DbProfile {
        DbProfile {
            id: "live".into(),
            name: "live".into(),
            kind,
            host: host.into(),
            port,
            database: "vterm".into(),
            user: "vterm".into(),
            has_saved_password: false,
            read_only: false,
            container: None,
        }
    }

    async fn open(via: Via, p: &DbProfile, password: &str, read_only: bool) -> AppResult<Conn> {
        let target = Target {
            via,
            addr: net::Addr::of(p.kind, &p.host, p.port),
        };
        let (driver, canceller) = match p.kind {
            DbKind::Postgres => {
                let given = (!password.is_empty()).then_some(password);
                let o = pg::connect(target.open().await?, p, given, read_only).await?;
                assert!(!o.version.is_empty());
                (Driver::Pg(o.pg), Canceller::Pg(o.cancel, target.clone()))
            }
            DbKind::Mysql => {
                let given = (!password.is_empty()).then(|| Zeroizing::new(password.into()));
                let o = my::connect(&target, p, given, read_only).await?;
                assert!(!o.version.is_empty());
                (Driver::My(o.my), Canceller::My(o.killer))
            }
        };
        Ok(Conn::open("live".into(), read_only, false, driver, canceller).await)
    }

    async fn ok(conn: &Conn, sql: &str) -> Outcome {
        let out = conn.run(sql, 1000, false).await.1.expect("ran");
        assert!(out.error.is_none(), "{sql}: {:?}", out.error);
        out
    }

    fn postgres() -> DbProfile {
        profile(DbKind::Postgres, "postgres", 5432)
    }
    fn mysql() -> DbProfile {
        profile(DbKind::Mysql, "mysql", 3306)
    }
    fn mariadb() -> DbProfile {
        profile(DbKind::Mysql, "mariadb", 3306)
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn postgres_through_a_channel_reads_every_type_as_text_with_its_origin() {
        let conn = open(ssh().await, &postgres(), "vtermpass", false)
            .await
            .expect("connect");
        ok(&conn, "DROP TABLE IF EXISTS live_types").await;
        ok(&conn, "CREATE TABLE live_types (id int PRIMARY KEY, n numeric(10,2), t text, j jsonb, ts timestamptz, b bytea, f bool)").await;
        ok(&conn, "INSERT INTO live_types VALUES (1, 12.50, 'жук', '{\"a\":1}', '2026-11-17 10:00:00+00', '\\x00ff', true), (2, NULL, NULL, NULL, NULL, NULL, NULL)").await;
        let out = ok(
            &conn,
            "SELECT id, n, t, j, ts, b, f, id * 2 AS twice FROM live_types ORDER BY id",
        )
        .await;
        let names: Vec<&str> = out.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["id", "n", "t", "j", "ts", "b", "f", "twice"]);
        assert!(out.columns[0].numeric && out.columns[1].numeric && !out.columns[2].numeric);
        assert!(out.columns[0].table.is_some() && out.columns[0].column.as_deref() == Some("1"));
        assert!(
            out.columns[7].table.is_none(),
            "a computed column comes from no table"
        );
        assert_eq!(out.rows[0][1].as_deref(), Some("12.50"));
        assert_eq!(out.rows[0][2].as_deref(), Some("жук"));
        assert_eq!(out.rows[0][3].as_deref(), Some("{\"a\": 1}"));
        assert_eq!(out.rows[0][5].as_deref(), Some("\\x00ff"));
        assert_eq!(out.rows[0][6].as_deref(), Some("t"));
        assert_eq!(out.rows[1][1], None);
        let changed = ok(&conn, "UPDATE live_types SET t = 'x' WHERE id IN (1, 2)").await;
        assert!(changed.columns.is_empty());
        assert_eq!(changed.affected, Some(2));
        let bad = conn.run("SELEC 1", 10, false).await.1.expect("ran");
        let e = bad.error.expect("a syntax error");
        assert_eq!(e.code, "42601");
        assert_eq!(e.position, Some(1));
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn a_statement_past_the_row_cap_is_stopped_not_read_to_its_end() {
        for p in [postgres(), mysql()] {
            let conn = open(ssh().await, &p, "vtermpass", false)
                .await
                .expect("connect");
            let sql = match p.kind {
                DbKind::Postgres => "SELECT g FROM generate_series(1, 50000000) g",
                DbKind::Mysql => {
                    // A billion rows that start coming at once (information_schema
                    // views are built whole before their first row).
                    ok(&conn, "DROP TABLE IF EXISTS live_n").await;
                    ok(&conn, "CREATE TABLE live_n (n int)").await;
                    ok(&conn, "INSERT INTO live_n WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 1000) SELECT n FROM s").await;
                    "SELECT a.n FROM live_n a, live_n b, live_n c"
                }
            };
            let started = std::time::Instant::now();
            let out = conn.run(sql, 100, false).await.1.expect("ran");
            assert!(out.error.is_none(), "{:?}: {:?}", p.kind, out.error);
            assert_eq!(out.rows.len(), 100);
            assert!(out.truncated);
            assert!(
                started.elapsed().as_secs() < 20,
                "{:?} read to its end",
                p.kind
            );
            let after = ok(&conn, "SELECT 1").await;
            assert_eq!(
                after.rows[0][0].as_deref(),
                Some("1"),
                "the connection still works"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn read_only_holds_and_a_lifted_statement_writes_once() {
        for p in [postgres(), mysql(), mariadb()] {
            let rw = open(ssh().await, &p, "vtermpass", false)
                .await
                .expect("connect");
            ok(&rw, "DROP TABLE IF EXISTS live_ro").await;
            ok(&rw, "CREATE TABLE live_ro (id int PRIMARY KEY)").await;
            let ro = open(ssh().await, &p, "vtermpass", true)
                .await
                .expect("connect");
            let refused = ro.run("INSERT INTO live_ro VALUES (1)", 10, false).await.1;
            assert!(
                matches!(refused, Err(AppError::DbReadOnly)),
                "{:?} wrote while read-only",
                p.kind
            );
            // Under the policy the server holds it too.
            let server = ro
                .inner
                .lock()
                .await
                .driver
                .raw_write("INSERT INTO live_ro VALUES (4)")
                .await;
            assert!(server.is_err(), "{:?}: the server let it through", p.kind);
            let lifted = ro
                .run("INSERT INTO live_ro VALUES (2)", 10, true)
                .await
                .1
                .expect("ran");
            assert!(lifted.error.is_none(), "{:?}: {:?}", p.kind, lifted.error);
            let again = ro
                .inner
                .lock()
                .await
                .driver
                .raw_write("INSERT INTO live_ro VALUES (3)")
                .await;
            assert!(again.is_err(), "{:?}: read-only was not put back", p.kind);
            let rows = ok(&rw, "SELECT id FROM live_ro ORDER BY id").await;
            assert_eq!(rows.rows, vec![vec![Some("2".to_string())]]);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn edits_apply_together_or_not_at_all() {
        for p in [postgres(), mysql()] {
            let conn = open(ssh().await, &p, "vtermpass", false)
                .await
                .expect("connect");
            ok(&conn, "DROP TABLE IF EXISTS live_edit").await;
            ok(
                &conn,
                "CREATE TABLE live_edit (id int PRIMARY KEY, v varchar(10))",
            )
            .await;
            ok(&conn, "INSERT INTO live_edit VALUES (1, 'a'), (2, 'b')").await;
            let mixed = conn
                .apply(
                    &[
                        "UPDATE live_edit SET v = 'x' WHERE id = 1".into(),
                        "UPDATE live_edit SET v = 'y' WHERE id = 99".into(),
                    ],
                    false,
                )
                .await
                .1
                .expect("answered");
            let why = mixed.failure.expect("a statement that changed nothing");
            assert_eq!((why.statement, why.changed), (Some(2), Some(0)));
            let rows = ok(&conn, "SELECT v FROM live_edit ORDER BY id").await;
            assert_eq!(
                rows.rows[0][0].as_deref(),
                Some("a"),
                "{:?}: the first edit was kept",
                p.kind
            );
            let same = conn
                .apply(&["UPDATE live_edit SET v = 'b' WHERE id = 2".into()], false)
                .await;
            assert_eq!(same.1.expect("a value set to itself").changed, vec![1]);
            let both = conn
                .apply(
                    &[
                        "UPDATE live_edit SET v = 'x' WHERE id = 1".into(),
                        "DELETE FROM live_edit WHERE id = 2".into(),
                    ],
                    false,
                )
                .await;
            assert_eq!(both.1.expect("applied").changed, vec![1, 1]);
            let rows = ok(&conn, "SELECT id, v FROM live_edit ORDER BY id").await;
            assert_eq!(rows.rows, vec![vec![Some("1".into()), Some("x".into())]]);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn a_running_statement_is_stopped_on_the_server() {
        for p in [postgres(), mysql()] {
            let conn = Arc::new(
                open(ssh().await, &p, "vtermpass", false)
                    .await
                    .expect("connect"),
            );
            let sql = match p.kind {
                DbKind::Postgres => "SELECT pg_sleep(30)",
                DbKind::Mysql => "SELECT COUNT(*) FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c, information_schema.COLUMNS d",
            };
            let running = {
                let conn = conn.clone();
                tokio::spawn(async move { conn.run(sql, 10, false).await.1 })
            };
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            assert!(conn.is_busy());
            conn.cancel().await.expect("cancel sent");
            let out = tokio::time::timeout(std::time::Duration::from_secs(10), running)
                .await
                .expect("stopped in time")
                .expect("joined")
                .expect("ran");
            let code = out.error.expect("stopped").code;
            assert!(code == "57014" || code == "1317", "{:?}: {code}", p.kind);
            assert!(!conn.is_busy());
            ok(&conn, "SELECT 1").await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn postgres_through_its_socket_on_the_server_and_at_an_address_of_this_computer() {
        let socket = profile(DbKind::Postgres, "/var/run/postgresql", 5432);
        let conn = open(ssh().await, &socket, "vtermpass", false)
            .await
            .expect("socket");
        assert_eq!(ok(&conn, "SELECT 1").await.rows[0][0].as_deref(), Some("1"));
        let here = profile(DbKind::Postgres, "127.0.0.1", 15432);
        let conn = open(Via::Here, &here, "vtermpass", false)
            .await
            .expect("here");
        assert_eq!(
            ok(&conn, "SELECT current_user").await.rows[0][0].as_deref(),
            Some("vterm")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn a_wrong_password_asks_again_and_a_closed_port_is_the_tunnels_answer() {
        for p in [postgres(), mysql(), mariadb()] {
            let refused = open(ssh().await, &p, "wrong", false).await;
            assert!(
                matches!(refused, Err(AppError::DbAuthRejected)),
                "{:?}",
                p.kind
            );
        }
        let nowhere = profile(DbKind::Postgres, "postgres", 6000);
        let e = open(ssh().await, &nowhere, "vtermpass", false).await;
        assert!(matches!(e, Err(AppError::DbTunnelRefused(_))));
        let target = Target {
            via: Via::Here,
            addr: Addr::Tcp {
                host: "127.0.0.1".into(),
                port: 1,
            },
        };
        assert!(target.open().await.is_err());
    }

    /// The window's own SQL (`appsql.cases.json`), run where it is meant to.
    fn app_reads(kind: DbKind) -> Vec<String> {
        #[derive(serde::Deserialize)]
        struct Cases {
            kind: DbKind,
            reads: Vec<String>,
        }
        let all: Vec<Cases> =
            serde_json::from_str(include_str!("../../../src/lib/db/appsql.cases.json"))
                .expect("the cases");
        all.into_iter()
            .find(|c| c.kind == kind)
            .expect("the kind")
            .reads
    }

    fn the_one(reads: &[String], marks: &[&str]) -> String {
        reads
            .iter()
            .find(|q| marks.iter().all(|m| q.contains(m)))
            .unwrap_or_else(|| panic!("no query with {marks:?}"))
            .clone()
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn the_first_connection_is_asked_for_a_password() {
        for p in [postgres(), mysql(), mariadb()] {
            let asked = open(ssh().await, &p, "", false).await;
            assert!(
                matches!(asked, Err(AppError::DbAuthRejected)),
                "{:?}",
                p.host
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn the_windows_own_sql_reads_keys_schema_and_activity() {
        let conn = open(ssh().await, &postgres(), "vtermpass", true)
            .await
            .expect("connect");
        let rw = open(ssh().await, &postgres(), "vtermpass", false)
            .await
            .expect("connect");
        ok(&rw, "DROP TABLE IF EXISTS live_key").await;
        ok(&rw, "CREATE TABLE live_key (a int, b int, note text, extra int, PRIMARY KEY (b, a) INCLUDE (extra))").await;
        let oid = ok(&rw, "SELECT 'live_key'::regclass::oid::text").await.rows[0][0]
            .clone()
            .expect("oid");
        let reads = app_reads(DbKind::Postgres);
        let meta =
            the_one(&reads, &["pg_attribute a ON a.attrelid = c.oid"]).replace("16384", &oid);
        let got = ok(&conn, &meta).await;
        let keys: Vec<(String, String, String)> = got
            .rows
            .iter()
            .map(|r| {
                let of = |i: usize| r[i].clone().unwrap_or_default();
                (of(3), of(4), of(5))
            })
            .collect();
        let expected = [("a", "2"), ("b", "1"), ("note", "0"), ("extra", "0")];
        assert_eq!(
            keys,
            expected
                .iter()
                .map(|(n, k)| (n.to_string(), k.to_string(), "1".to_string()))
                .collect::<Vec<_>>(),
            "the first key column read as not a key"
        );
        let indexes = the_one(&reads, &["indexrelid::regclass"])
            .replace("\"app\"", "\"public\"")
            .replace("\"orders\"", "\"live_key\"");
        assert!(ok(&conn, &indexes).await.rows[0][1]
            .as_deref()
            .is_some_and(|c| c.starts_with("b,a")));
        for q in &reads {
            // Other versions' and other databases' objects are not this stand's.
            let foreign = [
                "pg_stat_statements",
                "16384",
                "\"app\"",
                "\"update\"",
                "FROM t",
            ];
            if !foreign.iter().any(|m| q.contains(m)) {
                ok(&conn, q).await;
            }
        }

        for p in [mysql(), mariadb()] {
            let rw = open(ssh().await, &p, "vtermpass", false)
                .await
                .expect("connect");
            let conn = open(ssh().await, &p, "vtermpass", true)
                .await
                .expect("connect");
            ok(&rw, "DROP TABLE IF EXISTS live_key").await;
            ok(&rw, "CREATE TABLE live_key (a int, b int, note text, raw blob, PRIMARY KEY (b, a)) ENGINE=InnoDB").await;
            let reads = app_reads(DbKind::Mysql);
            let meta = the_one(&reads, &["KEY_COLUMN_USAGE"])
                .replace("'shop'", "'vterm'")
                .replace("'orders'", "'live_key'");
            let got = ok(&conn, &meta).await;
            let keys: Vec<&str> = got
                .rows
                .iter()
                .map(|r| r[4].as_deref().unwrap_or(""))
                .collect();
            assert_eq!(keys, ["2", "1", "0", "0"], "{}", p.host);
            assert!(got.rows.iter().all(|r| r[5].as_deref() == Some("1")));
            let types = ok(&conn, "SELECT note, raw FROM live_key").await;
            assert_eq!(types.columns[0].type_name, "TEXT", "{}", p.host);
            assert_eq!(types.columns[1].type_name, "BLOB", "{}", p.host);
            for mark in [
                "FROM information_schema.TABLES WHERE",
                "FROM information_schema.ROUTINES",
                "FROM information_schema.COLUMNS WHERE",
                "@@max_connections",
                "Innodb_buffer_pool",
            ] {
                ok(&conn, &the_one(&reads, &[mark])).await;
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn a_change_past_the_row_cap_is_kept_and_a_stop_never_hits_the_next_statement() {
        let conn = open(ssh().await, &postgres(), "vtermpass", false)
            .await
            .expect("connect");
        ok(&conn, "DROP TABLE IF EXISTS live_cap").await;
        ok(
            &conn,
            "CREATE TABLE live_cap AS SELECT g AS id, 0 AS v FROM generate_series(1, 5000) g",
        )
        .await;
        let changed = conn
            .run("UPDATE live_cap SET v = 1 RETURNING id", 100, false)
            .await
            .1
            .expect("ran");
        assert!(changed.error.is_none() && changed.truncated && !changed.read);
        let kept = ok(&conn, "SELECT count(*) FROM live_cap WHERE v = 1").await;
        assert_eq!(
            kept.rows[0][0].as_deref(),
            Some("5000"),
            "rolled back and shown as done"
        );

        ok(&conn, "BEGIN").await;
        let cut = conn
            .run("SELECT g FROM generate_series(1, 50000) g", 100, false)
            .await
            .1
            .expect("ran");
        assert!(cut.error.is_none() && cut.truncated && cut.tx == Tx::Open);
        ok(&conn, "UPDATE live_cap SET v = 2 WHERE id = 1").await;
        assert_eq!(ok(&conn, "COMMIT").await.tx, Tx::None);
        let committed = ok(&conn, "SELECT v FROM live_cap WHERE id = 1").await;
        assert_eq!(committed.rows[0][0].as_deref(), Some("2"));

        for p in [postgres(), mysql()] {
            let conn = open(ssh().await, &p, "vtermpass", true)
                .await
                .expect("connect");
            let (long, next) = match p.kind {
                DbKind::Postgres => (
                    "SELECT g FROM generate_series(1, 3000000) g",
                    "SELECT pg_sleep(0.3), 1",
                ),
                DbKind::Mysql => (
                    "SELECT * FROM information_schema.COLUMNS",
                    "SELECT SLEEP(0.3), 1",
                ),
            };
            for _ in 0..8 {
                let cut = conn.run(long, 10, false).await.1.expect("ran");
                assert!(cut.error.is_none() && cut.truncated, "{:?}", p.kind);
                let after = ok(&conn, next).await;
                assert_eq!(
                    after.rows[0][1].as_deref(),
                    Some("1"),
                    "{:?}: a late stop",
                    p.kind
                );
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn a_transaction_and_the_way_quotes_are_read_follow_the_server() {
        let pg = open(ssh().await, &postgres(), "vtermpass", false)
            .await
            .expect("connect");
        assert_eq!(ok(&pg, "BEGIN").await.tx, Tx::Open);
        assert_eq!(ok(&pg, "SAVEPOINT s").await.tx, Tx::Open);
        let failed = pg
            .run("SELECT no_such_column", 10, false)
            .await
            .1
            .expect("ran");
        assert_eq!(failed.tx, Tx::Aborted);
        assert_eq!(ok(&pg, "ROLLBACK TO s").await.tx, Tx::Open);
        let edit = pg
            .apply(&["DELETE FROM live_nothing WHERE id = 1".into()], false)
            .await
            .1;
        assert!(
            matches!(edit, Err(AppError::DbTxOpen)),
            "apply would commit the user's transaction"
        );
        assert_eq!(ok(&pg, "ROLLBACK").await.tx, Tx::None);

        for p in [mysql(), mariadb()] {
            let my = open(ssh().await, &p, "vtermpass", false)
                .await
                .expect("connect");
            assert_eq!(
                ok(&my, "START TRANSACTION").await.tx,
                Tx::Open,
                "{}",
                p.host
            );
            assert_eq!(ok(&my, "ROLLBACK").await.tx, Tx::None, "{}", p.host);
            assert_eq!(
                ok(&my, "SET autocommit = 0").await.tx,
                Tx::Open,
                "{}",
                p.host
            );
            assert_eq!(
                ok(&my, "SET autocommit = 1").await.tx,
                Tx::None,
                "{}",
                p.host
            );
            assert!(ok(&my, "SELECT 1").await.backslash_escapes);
            let plain = ok(&my, "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'").await;
            assert!(!plain.backslash_escapes, "{}", p.host);
            let hidden = my.run("SELECT 'a\\'; SELECT 2", 10, false).await.1;
            assert!(
                matches!(hidden, Err(AppError::DbManyStatements)),
                "{}",
                p.host
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn edits_on_a_read_only_connection_apply_once_agreed_and_leave_it_read_only() {
        for p in [postgres(), mysql(), mariadb()] {
            let rw = open(ssh().await, &p, "vtermpass", false)
                .await
                .expect("connect");
            ok(&rw, "DROP TABLE IF EXISTS live_lift").await;
            ok(&rw, "CREATE TABLE live_lift (id int PRIMARY KEY, v int)").await;
            ok(&rw, "INSERT INTO live_lift VALUES (1, 0)").await;
            let ro = open(ssh().await, &p, "vtermpass", true)
                .await
                .expect("connect");
            let edit = ["UPDATE live_lift SET v = 1 WHERE id = 1".to_string()];
            assert!(matches!(
                ro.apply(&edit, false).await.1,
                Err(AppError::DbReadOnly)
            ));
            let (said, done) = ro.apply(&edit, true).await;
            assert_eq!(done.expect("answered").changed, vec![1], "{}", p.host);
            assert_eq!(said.as_deref(), Some("UPDATE live_lift"));
            let after = ro
                .inner
                .lock()
                .await
                .driver
                .raw_write("INSERT INTO live_lift VALUES (2, 0)")
                .await;
            assert!(after.is_err(), "{}: writes after the edits", p.host);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs docker compose -f e2e/docker-compose.db.yml up"]
    async fn the_stands_sshd_forwards_to_its_databases_alone() {
        let Via::Ssh(tunnel) = ssh().await else {
            panic!("not a tunnel")
        };
        for (host, port) in [
            ("example.com", 80),
            ("host.docker.internal", 22),
            ("postgres", 22),
        ] {
            assert!(
                matches!(
                    tunnel.tcp(host, port).await,
                    Err(AppError::DbTunnelRefused(_))
                ),
                "{host}:{port}"
            );
        }
        assert!(matches!(
            tunnel.unix("/var/run/sshd.pid").await,
            Err(AppError::DbTunnelRefused(_))
        ));
    }
}
