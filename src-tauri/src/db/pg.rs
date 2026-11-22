//! PostgreSQL over a stream the backend opened (ADR 0080).
//!
//! The connection runs over whatever `Target::open` gave — an SSH channel or a
//! socket of this computer — with no TLS: to a server the traffic is inside SSH.
//! A statement is prepared first (its columns and where they come from, without
//! running it), then run through the simple protocol, whose rows come as text:
//! every type reads the way `psql` prints it, with no decoder per type.

use super::net::{Io, Target, OPEN_TIMEOUT};
use super::{
    no_answer, Applied, Canceller, CapStop, Column, NotOpened, Outcome, Rows, Run, SqlError,
};
use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use crate::model::DbProfile;
use futures_util::StreamExt;
use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio_postgres::config::SslMode;
use tokio_postgres::error::{ErrorPosition, SqlState};
use tokio_postgres::{AsyncMessage, Client, Config, NoTls, SimpleQueryMessage};

/// The most notices one statement keeps.
const MAX_NOTICES: usize = 100;

pub struct Pg {
    client: Client,
    notices: Arc<Mutex<Vec<String>>>,
    /// Read-only could not be put back after a lifted statement: the connection
    /// takes no more statements.
    broken: bool,
}

/// A connection made: its driver, how to stop its statements, the server's version.
pub struct Opened {
    pub pg: Pg,
    pub cancel: tokio_postgres::CancelToken,
    pub version: String,
}

/// Connect over `stream`. `read_only` makes every transaction of the session
/// read-only (`default_transaction_read_only`), from the first statement on.
pub async fn connect(
    stream: Io,
    profile: &DbProfile,
    password: Option<&str>,
    read_only: bool,
) -> Result<Opened, NotOpened> {
    let mut cfg = Config::new();
    cfg.user(&profile.user);
    if !profile.database.trim().is_empty() {
        cfg.dbname(profile.database.trim());
    }
    if let Some(pw) = password {
        cfg.password(pw);
    }
    cfg.application_name("vterm");
    cfg.ssl_mode(SslMode::Disable);
    if read_only {
        cfg.options("-c default_transaction_read_only=on");
    }
    let (client, mut connection) =
        match tokio::time::timeout(OPEN_TIMEOUT, cfg.connect_raw(stream, NoTls)).await {
            Err(_) => return Err(no_answer().into()),
            Ok(Err(e)) => return Err(connect_error(&e)),
            Ok(Ok(pair)) => pair,
        };
    let notices = Arc::new(Mutex::new(Vec::new()));
    let sink = notices.clone();
    // The connection is driven here; what it says on its own (notices) is kept
    // for the statement that caused it. It ends when the client is dropped.
    tokio::spawn(async move {
        let mut messages = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
        while let Some(message) = messages.next().await {
            match message {
                Ok(AsyncMessage::Notice(n)) => {
                    let mut kept = sink.locked();
                    if kept.len() < MAX_NOTICES {
                        kept.push(format!("{}: {}", n.severity(), n.message()));
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::debug!(
                        source = "db",
                        code = %code(&e),
                        "a PostgreSQL connection ended"
                    );
                    break;
                }
            }
        }
    });
    let version = match client.simple_query("SHOW server_version").await {
        Ok(msgs) => msgs
            .iter()
            .find_map(|m| match m {
                SimpleQueryMessage::Row(r) => r.get(0).map(str::to_string),
                _ => None,
            })
            .unwrap_or_default(),
        Err(e) => {
            tracing::debug!(source = "db", code = %code(&e), "the server's version was not read");
            String::new()
        }
    };
    let cancel = client.cancel_token();
    Ok(Opened {
        pg: Pg {
            client,
            notices,
            broken: false,
        },
        cancel,
        version,
    })
}

/// What a failed connection is: the password (asked again), or the database's
/// answer — its words go to the screen.
fn connect_error(e: &tokio_postgres::Error) -> NotOpened {
    let asks = match e.as_db_error() {
        Some(db) => *db.code() == SqlState::INVALID_PASSWORD,
        // The server asked for a password and none was given.
        None => in_words(e).contains("password missing"),
    };
    if asks {
        return NotOpened::App(AppError::DbAuthRejected);
    }
    NotOpened::Refused(sql_error(e))
}

/// A SQLSTATE is five letters and digits. It comes from the server as text,
/// and it is written where the server's text is not.
fn sql_state(sent: &str) -> String {
    if sent.len() == 5 && sent.chars().all(|c| c.is_ascii_alphanumeric()) {
        sent.to_string()
    } else {
        "?".to_string()
    }
}

/// What may be written of an error: its SQLSTATE, or that it is the driver's.
fn code(e: &tokio_postgres::Error) -> String {
    e.code()
        .map_or_else(|| "driver".to_string(), |c| sql_state(c.code()))
}

/// Stop the statement running on a connection, from one of its own.
pub(crate) async fn cancel(token: &tokio_postgres::CancelToken, target: &Target) -> AppResult<()> {
    let stream = target.open().await?;
    token
        .cancel_query_raw(stream, NoTls)
        .await
        .map_err(|e| AppError::DbCancelFailed(code(&e)))
}

/// The driver prints a kind alone ("invalid configuration"); why is in its source.
fn in_words(e: &tokio_postgres::Error) -> String {
    match std::error::Error::source(e) {
        Some(cause) => format!("{e}: {cause}"),
        None => e.to_string(),
    }
}

/// What the database said was wrong, in its own words.
fn sql_error(e: &tokio_postgres::Error) -> SqlError {
    match e.as_db_error() {
        Some(db) => SqlError {
            message: db.message().to_string(),
            detail: db.detail().map(str::to_string),
            hint: db.hint().map(str::to_string),
            code: sql_state(db.code().code()),
            position: match db.position() {
                Some(ErrorPosition::Original(n)) => Some(*n),
                _ => None,
            },
        },
        None => SqlError {
            message: in_words(e),
            ..SqlError::default()
        },
    }
}

fn column(c: &tokio_postgres::Column) -> Column {
    let t = c.type_().name();
    Column {
        name: c.name().to_string(),
        type_name: t.to_string(),
        numeric: matches!(
            t,
            "int2" | "int4" | "int8" | "float4" | "float8" | "numeric" | "oid" | "money"
        ),
        table: c.table_oid().map(|o| o.to_string()),
        column: c.column_id().map(|n| n.to_string()),
        key: false,
    }
}

fn is_cancelled(e: &tokio_postgres::Error) -> bool {
    e.code() == Some(&SqlState::QUERY_CANCELED)
}

impl Pg {
    /// Past the policy — for the live tests of what the server itself refuses.
    #[cfg(test)]
    pub(crate) async fn raw_write(&mut self, text: &str) -> Result<(), String> {
        self.client
            .batch_execute(text)
            .await
            .map_err(|e| in_words(&e))
    }

    fn usable(&self) -> AppResult<()> {
        if self.broken || self.client.is_closed() {
            Err(AppError::DbClosed)
        } else {
            Ok(())
        }
    }

    async fn set_read_only(&self, on: bool) -> Result<(), tokio_postgres::Error> {
        self.client
            .batch_execute(if on {
                "SET default_transaction_read_only = on"
            } else {
                "SET default_transaction_read_only = off"
            })
            .await
    }

    /// An error that is not the statement's: the connection's, or the statement's
    /// when the connection is still there.
    fn failed(&self, e: &tokio_postgres::Error, started: Instant) -> AppResult<Outcome> {
        if self.client.is_closed() {
            return Err(AppError::DbClosed);
        }
        Ok(Outcome::failed(sql_error(e), started))
    }

    /// How the server reads quotes; none — it did not say.
    pub(crate) async fn quote_setting(&self) -> Option<String> {
        match self
            .client
            .simple_query("SHOW standard_conforming_strings")
            .await
        {
            Ok(msgs) => msgs.iter().find_map(|m| match m {
                SimpleQueryMessage::Row(r) => r.get(0).map(str::to_string),
                _ => None,
            }),
            Err(e) => {
                tracing::debug!(
                    source = "db",
                    code = %code(&e),
                    "how the server reads quotes was not read: the last known way stays"
                );
                None
            }
        }
    }

    /// Run one admitted statement.
    pub(crate) async fn run(
        &mut self,
        sql: &str,
        how: Run,
        canceller: &Canceller,
    ) -> AppResult<Outcome> {
        self.usable()?;
        let started = Instant::now();
        self.notices.locked().clear();
        if how.lift || how.hold {
            if let Err(e) = self.set_read_only(!how.lift).await {
                return self.failed(&e, started);
            }
        }
        let out = self.statement(sql, how, canceller, started).await;
        if how.lift {
            if let Err(e) = self.set_read_only(true).await {
                // Not back to read-only: no further statement may run on it.
                self.broken = true;
                tracing::warn!(
                    source = "db",
                    code = %code(&e),
                    "read-only was not put back after a lifted statement: the connection is closed"
                );
                return Err(AppError::DbClosed);
            }
        }
        out
    }

    async fn statement(
        &mut self,
        sql: &str,
        how: Run,
        canceller: &Canceller,
        started: Instant,
    ) -> AppResult<Outcome> {
        // Columns and where they come from, without running the statement.
        let columns: Vec<Column> = match self.client.prepare(sql).await {
            Ok(stmt) => stmt.columns().iter().map(column).collect(),
            Err(e) => return self.failed(&e, started),
        };
        let stream = match self.client.simple_query_raw(sql).await {
            Ok(s) => s,
            Err(e) => return self.failed(&e, started),
        };
        futures_util::pin_mut!(stream);
        let mut rows = Rows::new(how.cap);
        let mut affected = None;
        let mut full = false;
        let mut stop: Option<CapStop> = None;
        let mut failure = None;
        let mut dropped: u64 = 0;
        while let Some(message) = stream.next().await {
            match message {
                Ok(SimpleQueryMessage::Row(row)) => {
                    if full {
                        // Dropped: past the cap — letting a stop on its way go first.
                        dropped += 1;
                        if dropped.is_multiple_of(64) {
                            tokio::task::yield_now().await;
                        }
                        continue;
                    }
                    let cells = (0..row.len()).map(|i| row.get(i).map(Cow::Borrowed));
                    if !rows.push(cells) {
                        full = true;
                        stop = how.stop_at_cap.then(|| CapStop::send(canceller));
                    }
                }
                Ok(SimpleQueryMessage::CommandComplete(n)) => affected = Some(n),
                Ok(_) => {}
                Err(e) => {
                    if !(stop.is_some() && is_cancelled(&e)) {
                        failure = Some(e);
                    }
                    break;
                }
            }
        }
        if let Some(stop) = stop {
            stop.settle().await;
        }
        if let Some(e) = failure {
            return self.failed(&e, started);
        }
        let notices = std::mem::take(&mut *self.notices.locked());
        Ok(Outcome {
            affected: if columns.is_empty() { affected } else { None },
            columns,
            rows: rows.rows,
            cut: rows.cut,
            truncated: rows.truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
            notices,
            ..Outcome::default()
        })
    }

    /// Apply edits in one transaction; each must change exactly one row.
    pub(crate) async fn apply(&mut self, statements: &[String], lift: bool) -> AppResult<Applied> {
        self.usable()?;
        let begin = if lift { "BEGIN READ WRITE" } else { "BEGIN" };
        if let Err(e) = self.client.batch_execute(begin).await {
            return self.apply_failed(None, &e);
        }
        let mut changed = Vec::with_capacity(statements.len());
        for (i, s) in statements.iter().enumerate() {
            let failure = match self.client.execute(s.as_str(), &[]).await {
                Ok(1) => {
                    changed.push(1);
                    continue;
                }
                Ok(n) => Applied::not_one(i, n),
                Err(e) if self.client.is_closed() => return self.apply_failed(Some(i), &e),
                Err(e) => Applied::failed(Some(i), sql_error(&e)),
            };
            if let Err(e) = self.client.batch_execute("ROLLBACK").await {
                self.broken = true;
                tracing::warn!(
                    source = "db",
                    code = %code(&e),
                    "the edits' transaction was not rolled back: the connection is closed and the server ends it"
                );
            }
            return Ok(failure);
        }
        match self.client.batch_execute("COMMIT").await {
            Ok(()) => Ok(Applied {
                changed,
                failure: None,
            }),
            Err(e) => self.apply_failed(None, &e),
        }
    }

    fn apply_failed(&self, index: Option<usize>, e: &tokio_postgres::Error) -> AppResult<Applied> {
        if self.client.is_closed() {
            return Err(AppError::DbClosed);
        }
        Ok(Applied::failed(index, sql_error(e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The first connection has no password yet: the window must be told to ask.
    #[tokio::test]
    async fn a_server_that_wants_a_password_makes_the_window_ask_for_one() {
        let (near, mut far) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            let mut startup = [0u8; 512];
            if far.read(&mut startup).await.is_ok() {
                // AuthenticationCleartextPassword.
                if far.write_all(&[b'R', 0, 0, 0, 8, 0, 0, 0, 3]).await.is_ok() {
                    let mut rest = [0u8; 64];
                    while matches!(far.read(&mut rest).await, Ok(n) if n > 0) {}
                }
            }
        });
        let profile = DbProfile {
            id: "t".into(),
            name: String::new(),
            kind: crate::model::DbKind::Postgres,
            host: "127.0.0.1".into(),
            port: 5432,
            database: "app".into(),
            user: "app".into(),
            has_saved_password: false,
            read_only: false,
            container: None,
        };
        let got = connect(Box::new(near), &profile, None, false).await;
        match got {
            Err(NotOpened::App(AppError::DbAuthRejected)) => {}
            Err(NotOpened::App(e)) => {
                panic!("the window would show a failure, not the question: {e}")
            }
            Err(NotOpened::Refused(e)) => {
                panic!(
                    "the window would show a failure, not the question: {}",
                    e.message
                )
            }
            Ok(_) => panic!("connected without a password"),
        }
    }

    #[test]
    fn a_sqlstate_cannot_carry_a_servers_text() {
        assert_eq!(sql_state("3D000"), "3D000");
        for sent in ["LEAKMARK", "a b c", "", "12345 and more"] {
            assert_eq!(sql_state(sent), "?", "{sent}");
        }
    }
}
