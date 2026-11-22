//! MySQL and MariaDB (ADR 0080).
//!
//! `mysql_async` reaches a database of this computer by itself, at its loopback
//! or its socket; one behind an SSH server — through `relay`, a door into the
//! channel. Rows come through the text protocol: every type reads the way the
//! `mysql` client prints it.

use super::net::{Addr, Target, Via, OPEN_TIMEOUT};
use super::{
    relay, text_of, Applied, Canceller, CapStop, Column, Outcome, Rows, Run, SqlError, Tx,
};
use crate::diag::Logged;
use crate::error::{AppError, AppResult};
use crate::model::DbProfile;
use mysql_async::consts::{ColumnFlags, ColumnType, StatusFlags};
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, OptsBuilder, Value};
use std::time::Instant;
use zeroize::Zeroizing;

/// The server refused the user or the password.
const ACCESS_DENIED: [u16; 2] = [1045, 1698];
/// The statement was stopped (`KILL QUERY`).
const INTERRUPTED: u16 = 1317;

/// Whom the connections log in as — the main one and each that stops a statement.
#[derive(Clone)]
struct Login {
    user: String,
    password: Option<Zeroizing<String>>,
    database: Option<String>,
    read_only: bool,
}

impl Login {
    fn opts(&self) -> OptsBuilder {
        let mut init: Vec<String> = Vec::new();
        if self.read_only {
            init.push("SET SESSION TRANSACTION READ ONLY".into());
        }
        OptsBuilder::default()
            .user(Some(self.user.clone()))
            .pass(self.password.as_ref().map(|p| p.as_str().to_string()))
            .db_name(self.database.clone())
            // Never switch to a socket the server names: the address is ours.
            .prefer_socket(false)
            .stmt_cache_size(0)
            // "Changed" counts the rows matched: an edit that sets a value it
            // already had still changed its one row.
            .client_found_rows(true)
            .init(init)
    }
}

/// A connection to the place, through whatever reaches it.
async fn reach(target: &Target, login: &Login) -> AppResult<Conn> {
    let opts = match (&target.via, &target.addr) {
        (Via::Here, Addr::Tcp { host, port }) => {
            login.opts().ip_or_hostname(host.clone()).tcp_port(*port)
        }
        (Via::Here, Addr::Unix(path)) => login.opts().socket(Some(path.clone())),
        (Via::Ssh(_), _) => {
            let door = relay::open(target.open().await?).await?;
            match door {
                #[cfg(unix)]
                relay::Door::Socket(path) => login.opts().socket(Some(path)),
                #[cfg(not(unix))]
                relay::Door::Port(port) => login.opts().ip_or_hostname("127.0.0.1").tcp_port(port),
            }
        }
    };
    match tokio::time::timeout(OPEN_TIMEOUT, mysql_async::Conn::new(opts)).await {
        Err(_) => Err(format!(
            "the database did not answer in {} s",
            OPEN_TIMEOUT.as_secs()
        )
        .into()),
        Ok(Err(e)) => Err(connect_error(&e)),
        Ok(Ok(conn)) => Ok(conn),
    }
}

fn connect_error(e: &mysql_async::Error) -> AppError {
    match e {
        mysql_async::Error::Server(s) if ACCESS_DENIED.contains(&s.code) => {
            AppError::DbAuthRejected
        }
        mysql_async::Error::Server(s) => AppError::Message(format!("{} ({})", s.message, s.code)),
        other => AppError::Message(other.to_string()),
    }
}

fn sql_error(e: &mysql_async::Error) -> SqlError {
    match e {
        mysql_async::Error::Server(s) => SqlError {
            message: s.message.clone(),
            code: s.code.to_string(),
            detail: (!s.state.is_empty()).then(|| format!("SQLSTATE {}", s.state)),
            ..SqlError::default()
        },
        other => SqlError {
            message: other.to_string(),
            ..SqlError::default()
        },
    }
}

fn is_interrupted(e: &mysql_async::Error) -> bool {
    matches!(e, mysql_async::Error::Server(s) if s.code == INTERRUPTED)
}

/// Whether the error is the connection's, not the statement's.
fn is_link(e: &mysql_async::Error) -> bool {
    matches!(e, mysql_async::Error::Io(_))
        || matches!(
            e,
            mysql_async::Error::Driver(mysql_async::DriverError::ConnectionClosed)
        )
}

fn type_name(t: ColumnType) -> (&'static str, bool) {
    use ColumnType::*;
    match t {
        MYSQL_TYPE_TINY => ("TINYINT", true),
        MYSQL_TYPE_SHORT => ("SMALLINT", true),
        MYSQL_TYPE_INT24 => ("MEDIUMINT", true),
        MYSQL_TYPE_LONG => ("INT", true),
        MYSQL_TYPE_LONGLONG => ("BIGINT", true),
        MYSQL_TYPE_FLOAT => ("FLOAT", true),
        MYSQL_TYPE_DOUBLE => ("DOUBLE", true),
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => ("DECIMAL", true),
        MYSQL_TYPE_YEAR => ("YEAR", true),
        MYSQL_TYPE_BIT => ("BIT", false),
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => ("DATE", false),
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => ("TIME", false),
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => ("DATETIME", false),
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => ("TIMESTAMP", false),
        MYSQL_TYPE_JSON => ("JSON", false),
        MYSQL_TYPE_ENUM => ("ENUM", false),
        MYSQL_TYPE_SET => ("SET", false),
        MYSQL_TYPE_GEOMETRY => ("GEOMETRY", false),
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            ("BLOB", false)
        }
        MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING => ("VARCHAR", false),
        MYSQL_TYPE_STRING => ("CHAR", false),
        MYSQL_TYPE_NULL => ("NULL", false),
        _ => ("UNKNOWN", false),
    }
}

/// The character set of bytes: what tells a BLOB from a TEXT.
const BINARY_SET: u16 = 63;

/// The protocol has one type for text and for bytes of each size.
fn text_or_bytes(name: &'static str, binary: bool) -> &'static str {
    match (name, binary) {
        ("BLOB", false) => "TEXT",
        ("VARCHAR", true) => "VARBINARY",
        ("CHAR", true) => "BINARY",
        _ => name,
    }
}

fn column(c: &mysql_async::Column) -> Column {
    let (type_name, numeric) = type_name(c.column_type());
    let type_name = text_or_bytes(type_name, c.character_set() == BINARY_SET);
    let table = c.org_table_str();
    let schema = c.schema_str();
    Column {
        name: c.name_str().into_owned(),
        type_name: type_name.to_string(),
        numeric,
        table: (!table.is_empty()).then(|| format!("{schema}.{table}")),
        column: (!table.is_empty()).then(|| c.org_name_str().into_owned()),
        key: c.flags().contains(ColumnFlags::PRI_KEY_FLAG),
    }
}

fn cell(v: &Value) -> Option<std::borrow::Cow<'_, str>> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(text_of(b)),
        // The text protocol sends bytes only; anything else is printed as is.
        other => Some(std::borrow::Cow::Owned(
            other.as_sql(true).trim_matches('\'').to_string(),
        )),
    }
}

pub struct My {
    conn: Conn,
    broken: bool,
}

/// Stops a running statement: `KILL QUERY` from a connection of its own.
#[derive(Clone)]
pub struct Killer {
    target: Target,
    login: Login,
    id: u32,
}

impl Killer {
    pub async fn kill(&self) -> AppResult<()> {
        let mut conn = reach(&self.target, &self.login).await?;
        let done = conn
            .query_drop(format!("KILL QUERY {}", self.id))
            .await
            .map_err(|e| {
                AppError::Message(format!(
                    "the statement was not stopped: {}",
                    sql_error(&e).message
                ))
            });
        conn.disconnect().await.log_debug(
            "db",
            "the connection that stopped a statement did not close cleanly",
        );
        done
    }
}

/// A connection made: its driver, how to stop its statements, the server's version.
pub struct Opened {
    pub my: My,
    pub killer: Killer,
    pub version: String,
}

pub async fn connect(
    target: &Target,
    profile: &DbProfile,
    password: Option<Zeroizing<String>>,
    read_only: bool,
) -> AppResult<Opened> {
    let login = Login {
        user: profile.user.clone(),
        password,
        database: Some(profile.database.trim().to_string()).filter(|d| !d.is_empty()),
        read_only,
    };
    let mut conn = reach(target, &login).await?;
    let version: String = match conn.query_first::<String, _>("SELECT VERSION()").await {
        Ok(v) => v.unwrap_or_default(),
        Err(e) => {
            tracing::debug!(
                source = "db",
                code = %sql_error(&e).code,
                "the server's version was not read"
            );
            String::new()
        }
    };
    let killer = Killer {
        target: target.clone(),
        login,
        id: conn.id(),
    };
    Ok(Opened {
        my: My {
            conn,
            broken: false,
        },
        killer,
        version,
    })
}

impl My {
    /// Past the policy — for the live tests of what the server itself refuses.
    #[cfg(test)]
    pub(crate) async fn raw_write(&mut self, text: &str) -> Result<(), String> {
        self.conn.query_drop(text).await.map_err(|e| e.to_string())
    }

    fn usable(&self) -> AppResult<()> {
        if self.broken {
            Err(AppError::DbClosed)
        } else {
            Ok(())
        }
    }

    fn failed(&self, e: &mysql_async::Error, started: Instant) -> AppResult<Outcome> {
        if is_link(e) {
            return Err(AppError::DbClosed);
        }
        Ok(Outcome::failed(sql_error(e), started))
    }

    async fn set_read_only(&mut self, on: bool) -> Result<(), mysql_async::Error> {
        self.conn
            .query_drop(if on {
                "SET SESSION TRANSACTION READ ONLY"
            } else {
                "SET SESSION TRANSACTION READ WRITE"
            })
            .await
    }

    /// How the server reads quotes; none — it did not say.
    pub(crate) async fn quote_setting(&mut self) -> Option<String> {
        match self
            .conn
            .query_first::<String, _>("SELECT @@SESSION.sql_mode")
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(
                    source = "db",
                    code = %sql_error(&e).code,
                    "how the server reads quotes was not read: the last known way stays"
                );
                None
            }
        }
    }

    /// The transaction, in the server's own flags; none — it sent none.
    pub(crate) fn tx(&self) -> Option<Tx> {
        let flags = self.conn.last_ok_packet()?.status_flags();
        let open = flags.contains(StatusFlags::SERVER_STATUS_IN_TRANS)
            || !flags.contains(StatusFlags::SERVER_STATUS_AUTOCOMMIT);
        Some(if open { Tx::Open } else { Tx::None })
    }

    pub(crate) async fn run(
        &mut self,
        sql: &str,
        how: Run,
        canceller: &Canceller,
    ) -> AppResult<Outcome> {
        self.usable()?;
        let started = Instant::now();
        if how.lift || how.hold {
            if let Err(e) = self.set_read_only(!how.lift).await {
                return self.failed(&e, started);
            }
        }
        let out = self.statement(sql, how, canceller, started).await;
        if how.lift {
            if let Err(e) = self.set_read_only(true).await {
                self.broken = true;
                tracing::warn!(
                    source = "db",
                    code = %sql_error(&e).code,
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
        let mut result = match self.conn.query_iter(sql).await {
            Ok(r) => r,
            Err(e) => return self.failed(&e, started),
        };
        let columns: Vec<Column> = result
            .columns()
            .map(|cols| cols.iter().map(column).collect())
            .unwrap_or_default();
        let mut rows = Rows::new(how.cap);
        let mut full = false;
        let mut stop: Option<CapStop> = None;
        let mut failure = None;
        let mut dropped: u64 = 0;
        loop {
            match result.next().await {
                Ok(Some(row)) => {
                    if full {
                        // Dropped: past the cap — letting a stop on its way go first.
                        dropped += 1;
                        if dropped.is_multiple_of(64) {
                            tokio::task::yield_now().await;
                        }
                        continue;
                    }
                    let cells = (0..row.len()).map(|i| row.as_ref(i).and_then(cell));
                    if !rows.push(cells) {
                        full = true;
                        stop = how.stop_at_cap.then(|| CapStop::send(canceller));
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    if !(stop.is_some() && is_interrupted(&e)) {
                        failure = Some(e);
                    }
                    break;
                }
            }
        }
        let stopped = stop.is_some();
        let affected = result.affected_rows();
        let warnings = result.warnings();
        // Result sets after the first (a procedure's) are read and dropped.
        let rest = result.drop_result().await;
        if let Some(stop) = stop {
            stop.settle().await;
        }
        if let Some(e) = failure {
            return self.failed(&e, started);
        }
        if let Err(e) = rest {
            if !(stopped && is_interrupted(&e)) {
                return self.failed(&e, started);
            }
        }
        let mut notices = Vec::new();
        if warnings > 0 {
            notices.push(format!("{warnings} warning(s): SHOW WARNINGS lists them"));
        }
        Ok(Outcome {
            affected: if columns.is_empty() {
                Some(affected)
            } else {
                None
            },
            columns,
            rows: rows.rows,
            cut: rows.cut,
            truncated: rows.truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
            notices,
            ..Outcome::default()
        })
    }

    pub(crate) async fn apply(&mut self, statements: &[String], lift: bool) -> AppResult<Applied> {
        self.usable()?;
        let begin = if lift {
            "START TRANSACTION READ WRITE"
        } else {
            "START TRANSACTION"
        };
        if let Err(e) = self.conn.query_drop(begin).await {
            return self.apply_failed(None, &e);
        }
        let mut changed = Vec::with_capacity(statements.len());
        for (i, s) in statements.iter().enumerate() {
            let failure = match self.conn.query_drop(s.as_str()).await {
                Ok(()) if self.conn.affected_rows() == 1 => {
                    changed.push(1);
                    continue;
                }
                Ok(()) => Applied::not_one(i, self.conn.affected_rows()),
                Err(e) if is_link(&e) => return self.apply_failed(Some(i), &e),
                Err(e) => Applied::failed(Some(i), sql_error(&e)),
            };
            self.roll_back().await;
            return Ok(failure);
        }
        match self.conn.query_drop("COMMIT").await {
            Ok(()) => Ok(Applied {
                changed,
                failure: None,
            }),
            Err(e) => {
                let out = self.apply_failed(None, &e);
                if out.is_ok() {
                    self.roll_back().await;
                }
                out
            }
        }
    }

    async fn roll_back(&mut self) {
        if let Err(e) = self.conn.query_drop("ROLLBACK").await {
            self.broken = true;
            tracing::warn!(
                source = "db",
                code = %sql_error(&e).code,
                "the edits' transaction was not rolled back: the connection is closed and the server ends it"
            );
        }
    }

    fn apply_failed(&self, index: Option<usize>, e: &mysql_async::Error) -> AppResult<Applied> {
        if is_link(e) {
            return Err(AppError::DbClosed);
        }
        Ok(Applied::failed(index, sql_error(e)))
    }
}

#[cfg(test)]
mod tests {
    use super::text_or_bytes;

    #[test]
    fn text_is_not_bytes_though_the_protocol_calls_both_blob() {
        assert_eq!(text_or_bytes("BLOB", false), "TEXT");
        assert_eq!(text_or_bytes("BLOB", true), "BLOB");
        assert_eq!(text_or_bytes("VARCHAR", true), "VARBINARY");
        assert_eq!(text_or_bytes("JSON", true), "JSON");
    }
}
