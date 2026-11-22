//! Databases (ADR 0080): the commands over the shared state — a tab's SSH
//! connection or local shell, the server's profile, the keychain.
//!
//! The window names a tab and a database id. Which address that is, which
//! password, and whether the connection may write are decided here: a prod
//! server's databases open read-only, and `writable` lifts that for one
//! statement the user agreed to. A statement's text and rows never reach the
//! diagnostics; its recording line is built by the backend (`db::sql`).

use crate::db::net::{Addr, Target, Via};
use crate::db::{self, Applied, Canceller, Conn, Dbs, Driver, NotOpened, Outcome, SqlError};
use crate::diag::Logged;
use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use crate::model::{DbKind, DbProfile, ServerProfile};
use crate::{exec, secrets, session_arc, store, AppState};
use serde::Serialize;
use std::sync::Arc;
use std::time::Instant;
use tauri::{Manager, State};
use zeroize::Zeroizing;

/// A database connection opened.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbOpened {
    pub conn_id: String,
    pub version: String,
    pub read_only: bool,
    pub prod: bool,
    pub kind: DbKind,
    /// "Remember the password" was asked and the keychain did not take it: the
    /// connection stands, the next one asks again.
    pub remember_failed: bool,
}

/// What connecting came to: a connection, or the database's refusal in its
/// own words — an answer, for the screen. A refused command is written to the
/// diagnostics; this is not one.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnect {
    pub opened: Option<DbOpened>,
    pub refused: Option<SqlError>,
}

fn kind_name(k: DbKind) -> &'static str {
    match k {
        DbKind::Postgres => "postgres",
        DbKind::Mysql => "mysql",
    }
}

/// The databases of this computer (ADR 0080).
#[tauri::command]
pub fn db_local_list() -> Vec<DbProfile> {
    store::load_local_databases()
}

/// Keep the databases of this computer as the window lists them. A database
/// that left takes its saved password with it.
#[tauri::command]
pub fn db_save_local(databases: Vec<DbProfile>) -> AppResult<Vec<DbProfile>> {
    let old = store::load_local_databases();
    for d in &databases {
        Addr::of(d.kind, &d.host, d.port).on_this_computer()?;
    }
    let (kept, gone) = db::merge_profiles(&old, databases)?;
    store::save_local_databases(&kept)?;
    for id in gone {
        secrets::delete_db_password(&secrets::db_scope(None, &id)).log_warn(
            "db",
            "the saved password of a database that left or moved stayed in the keychain",
        );
    }
    Ok(kept)
}

/// Keep a server's databases as the window lists them (ADR 0080). As with the
/// path-sync mode, memory changes only after the file does.
#[tauri::command]
pub fn set_server_databases(
    id: String,
    databases: Vec<DbProfile>,
    state: State<AppState>,
) -> AppResult<ServerProfile> {
    let (updated, gone) = {
        let mut servers = state.servers.locked();
        let mut next = servers.clone();
        let server = next
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or(AppError::UnknownServer)?;
        let (kept, gone) = db::merge_profiles(&server.databases, databases)?;
        server.databases = kept;
        let updated = server.clone();
        store::save_servers(&next)?;
        *servers = next;
        (updated, gone)
    };
    for db_id in gone {
        secrets::delete_db_password(&secrets::db_scope(Some(&id), &db_id)).log_warn(
            "db",
            "the saved password of a database that left or moved stayed in the keychain",
        );
    }
    Ok(updated)
}

/// Forget a database's saved password (the form's "Forget").
#[tauri::command]
pub fn db_forget_password(
    place: Option<String>,
    db_id: String,
    state: State<AppState>,
) -> AppResult<()> {
    secrets::delete_db_password(&secrets::db_scope(place.as_deref(), &db_id))?;
    mark_saved(&state, place.as_deref(), &db_id, false)
}

/// Write "password saved" for a database, where its profile lives.
fn mark_saved(
    state: &State<AppState>,
    place: Option<&str>,
    db_id: &str,
    saved: bool,
) -> AppResult<()> {
    let set = |d: &mut DbProfile| d.has_saved_password = saved;
    edit_profile(state, place, db_id, set)
}

fn edit_profile(
    state: &State<AppState>,
    place: Option<&str>,
    db_id: &str,
    set: impl FnOnce(&mut DbProfile),
) -> AppResult<()> {
    match place {
        Some(server_id) => {
            let mut servers = state.servers.locked();
            let mut next = servers.clone();
            if let Some(d) = next
                .iter_mut()
                .find(|s| s.id == server_id)
                .and_then(|s| s.databases.iter_mut().find(|d| d.id == db_id))
            {
                set(d);
            }
            store::save_servers(&next)?;
            *servers = next;
            Ok(())
        }
        None => {
            let mut dbs = store::load_local_databases();
            if let Some(d) = dbs.iter_mut().find(|d| d.id == db_id) {
                set(d);
            }
            store::save_local_databases(&dbs)
        }
    }
}

/// Connect to a database of the tab's server (an SSH tab) or of this computer
/// (a local tab). `password` — typed now; none — the saved one, if any.
#[tauri::command]
pub async fn db_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    db_id: String,
    password: Option<String>,
    remember: bool,
) -> AppResult<DbConnect> {
    let password = password.filter(|p| !p.is_empty()).map(Zeroizing::new);
    let (profile, place, prod, via) = if let Ok(session) = session_arc(&state, &session_id).await {
        let server = state
            .session_server(&session_id)
            .ok_or(AppError::UnknownServer)?;
        let profile = server
            .databases
            .iter()
            .find(|d| d.id == db_id)
            .cloned()
            .ok_or(AppError::UnknownDatabase)?;
        (
            profile,
            Some(server.id.clone()),
            server.is_prod(),
            Via::Ssh(session as Arc<dyn crate::db::net::Tunnel>),
        )
    } else if state.local_pty(&session_id).is_some() {
        let profile = store::load_local_databases()
            .into_iter()
            .find(|d| d.id == db_id)
            .ok_or(AppError::UnknownDatabase)?;
        (profile, None, false, Via::Here)
    } else {
        return Err(AppError::NoSession);
    };
    let scope = secrets::db_scope(place.as_deref(), &db_id);
    let typed = password.is_some();
    let secret = password.or_else(|| {
        profile
            .has_saved_password
            .then(|| secrets::get_db_password(&scope))
            .flatten()
    });
    db::check_profile(&profile)?;
    let addr = Addr::of(profile.kind, &profile.host, profile.port);
    let addr = match via {
        Via::Here => addr.on_this_computer()?,
        Via::Ssh(_) => addr,
    };
    let target = Target { via, addr };
    let read_only = db::opens_read_only(prod, profile.read_only);
    let started = Instant::now();
    let opened = open(&target, &profile, secret.clone(), read_only).await;
    let (driver, canceller, version) = match opened {
        Ok(parts) => parts,
        Err(not) => {
            let auth = matches!(not, NotOpened::App(AppError::DbAuthRejected));
            if auth && !typed && secret.is_some() {
                // The saved password was turned down: forget it, ask next time.
                secrets::delete_db_password(&scope).log_warn(
                    "db",
                    "a database's rejected password stayed in the keychain",
                );
                mark_saved(&state, place.as_deref(), &db_id, false).log_warn(
                    "db",
                    "\"password saved\" stayed on a database whose password was rejected",
                );
            }
            return not_opened(&session_id, &profile, &target, not);
        }
    };
    let mut remember_failed = false;
    if remember && typed {
        // Only for the place and the user it was typed for: the profile may
        // have been edited while this connected.
        let still = profile_now(&state, place.as_deref(), &db_id)
            .is_some_and(|now| db::same_endpoint(&now, &profile));
        if let (true, Some(pw)) = (still, secret.as_ref()) {
            let saved = secrets::set_db_password(&scope, pw)
                .and_then(|_| mark_saved(&state, place.as_deref(), &db_id, true));
            let kept = saved.log_warn("db", "a database's password was not saved");
            remember_failed = kept.is_none();
        }
    }
    let conn = Conn::open(session_id.clone(), read_only, prod, driver, canceller).await;
    let conn_id = format!("db-{}", crate::uuid_like().trim_start_matches("srv-"));
    let dbs = app.state::<Dbs>();
    dbs.insert(conn_id.clone(), Arc::new(conn));
    // Its tab closed while it connected: nothing else would close it.
    if session_arc(&state, &session_id).await.is_err() && state.local_pty(&session_id).is_none() {
        dbs.remove(&conn_id);
        return Err(AppError::NoSession);
    }
    tracing::info!(
        source = "db",
        sid = %session_id,
        conn = %conn_id,
        kind = kind_name(profile.kind),
        addr = %target.addr.label(),
        database = %profile.database,
        read_only,
        ms = started.elapsed().as_millis() as u64,
        "database connected"
    );
    Ok(DbConnect {
        opened: Some(DbOpened {
            conn_id,
            version,
            read_only,
            prod,
            kind: profile.kind,
            remember_failed,
        }),
        refused: None,
    })
}

/// A connection that was not made: the event, and the window's answer.
fn not_opened(
    session_id: &str,
    profile: &DbProfile,
    target: &Target,
    not: NotOpened,
) -> AppResult<DbConnect> {
    match &not {
        // The question, not a failure: the first connection has none yet.
        NotOpened::App(AppError::DbAuthRejected) => tracing::info!(
            source = "db",
            sid = %session_id,
            kind = kind_name(profile.kind),
            addr = %target.addr.label(),
            "the database asked for a password"
        ),
        NotOpened::App(refused) => tracing::warn!(
            source = "db",
            code = "db-connect-failed",
            sid = %session_id,
            kind = kind_name(profile.kind),
            addr = %target.addr.label(),
            database = %profile.database,
            refused = %marker(refused),
            "database connection failed"
        ),
        NotOpened::Refused(refused) => tracing::warn!(
            source = "db",
            code = "db-connect-failed",
            sid = %session_id,
            kind = kind_name(profile.kind),
            addr = %target.addr.label(),
            database = %profile.database,
            server_code = %refused.code,
            "the database refused the connection"
        ),
    }
    match not {
        NotOpened::App(refused) => Err(refused),
        NotOpened::Refused(refused) => Ok(DbConnect {
            opened: None,
            refused: Some(refused),
        }),
    }
}

fn profile_now(state: &State<AppState>, place: Option<&str>, db_id: &str) -> Option<DbProfile> {
    let of = |list: &[DbProfile]| list.iter().find(|d| d.id == db_id).cloned();
    match place {
        Some(id) => state
            .servers
            .locked()
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| of(&s.databases)),
        None => of(&store::load_local_databases()),
    }
}

async fn open(
    target: &Target,
    profile: &DbProfile,
    secret: Option<Zeroizing<String>>,
    read_only: bool,
) -> Result<(Driver, Canceller, String), NotOpened> {
    match profile.kind {
        DbKind::Postgres => {
            let stream = target.open().await?;
            let o = db::pg::connect(
                stream,
                profile,
                secret.as_ref().map(|s| s.as_str()),
                read_only,
            )
            .await?;
            Ok((
                Driver::Pg(o.pg),
                Canceller::Pg(o.cancel, target.clone()),
                o.version,
            ))
        }
        DbKind::Mysql => {
            let o = db::my::connect(target, profile, secret, read_only).await?;
            Ok((Driver::My(o.my), Canceller::My(o.killer), o.version))
        }
    }
}

/// Put a block into the tab's recording (an SSH session or a local shell).
async fn record(state: &State<'_, AppState>, session_id: &str, block: &str) {
    if let Ok(session) = session_arc(state, session_id).await {
        session.record_output(block.as_bytes());
    } else if let Some(pty) = state.local_pty(session_id) {
        pty.record_output(block.as_bytes());
    }
}

/// The recording's block for a statement: what it was, what came of it — its
/// row count or the error's code, never its values.
fn audit_block(said: &str, result: &Result<String, String>) -> String {
    let (stdout, code) = match result {
        Ok(summary) => (summary.clone(), 0),
        Err(failed) => (failed.clone(), 1),
    };
    exec::mirror(
        "sql",
        &db::audit_line(said),
        &exec::ExecOutput {
            stdout,
            stderr: String::new(),
            exit_code: code,
        },
    )
}

/// A refusal's marker: all of it that the diagnostics and the recording keep.
/// One without a marker keeps nothing.
fn marker(refused: &AppError) -> String {
    let full = refused.to_string();
    let head = full.split(':').next().unwrap_or_default();
    if head.starts_with("db-") && head.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        head.to_string()
    } else {
        "refused".to_string()
    }
}

/// The code a statement failed with; empty — it did not.
fn failed_code(o: &Outcome) -> &str {
    o.error
        .as_ref()
        .map(|f| f.code.as_str())
        .unwrap_or_default()
}

/// Why edits were not applied, as the diagnostics and the recording keep it.
fn apply_outcome(out: &AppResult<Applied>) -> String {
    match out {
        Ok(Applied { failure: None, .. }) => "applied".to_string(),
        Ok(Applied {
            failure: Some(f), ..
        }) => match &f.error {
            Some(failed) => format!("nothing applied: error {}", failed.code),
            None => "nothing applied: not one row".to_string(),
        },
        Err(refused) => marker(refused),
    }
}

/// The connection of an id; a closed one leaves the registry.
fn conn_of(app: &tauri::AppHandle, conn_id: &str) -> AppResult<Arc<Conn>> {
    app.state::<Dbs>().get(conn_id)
}

fn forget_if_closed<T>(app: &tauri::AppHandle, conn_id: &str, r: &AppResult<T>) {
    if matches!(r, Err(AppError::DbClosed)) {
        app.state::<Dbs>().remove(conn_id);
        tracing::info!(source = "db", conn = %conn_id, "a database connection was found closed");
    }
}

/// Run one statement. `rows` — the most to bring back; `writable` — read-only
/// lifted for this statement (the user agreed). A changing statement goes into
/// the recording by its verb and the table after it.
#[tauri::command]
pub async fn db_query(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    rows: u32,
    writable: bool,
) -> AppResult<Outcome> {
    let conn = conn_of(&app, &conn_id)?;
    let (said, out) = conn.run(&sql, db::row_cap(rows), writable).await;
    forget_if_closed(&app, &conn_id, &out);
    if writable && conn.read_only && said.is_some() {
        tracing::info!(
            source = "db",
            conn = %conn_id,
            prod = conn.prod,
            "read-only lifted for one statement"
        );
    }
    match &out {
        Ok(o) => tracing::debug!(
            source = "db",
            conn = %conn_id,
            ms = o.elapsed_ms,
            rows = o.rows.len(),
            affected = o.affected.unwrap_or(0),
            truncated = o.truncated,
            failed = %failed_code(o),
            "statement finished"
        ),
        Err(AppError::DbReadOnly) => tracing::info!(
            source = "db",
            conn = %conn_id,
            "a changing statement waits for consent to lift read-only"
        ),
        Err(refused) => tracing::warn!(
            source = "db",
            conn = %conn_id,
            refused = %marker(refused),
            "statement did not run"
        ),
    }
    if let Some(said) = said {
        let summary = match &out {
            Ok(o) => match &o.error {
                Some(f) => Err(format!("error {}", f.code)),
                None => Ok(match o.affected {
                    Some(n) => format!("{n} rows changed"),
                    None if o.truncated => format!("more than {} rows", o.rows.len()),
                    None => format!("{} rows", o.rows.len()),
                }),
            },
            Err(refused) => Err(marker(refused)),
        };
        record(&state, &conn.session, &audit_block(&said, &summary)).await;
    }
    out
}

/// Apply edits of a table in one transaction: each statement must change one
/// row, or none is applied. Why none was is in the answer, not a refusal.
#[tauri::command]
pub async fn db_apply(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    statements: Vec<String>,
    writable: bool,
) -> AppResult<Applied> {
    let conn = conn_of(&app, &conn_id)?;
    let started = Instant::now();
    let (said, out) = conn.apply(&statements, writable).await;
    forget_if_closed(&app, &conn_id, &out);
    let summary = match &out {
        Ok(Applied {
            failure: None,
            changed,
        }) => Ok(format!("{} rows changed", changed.len())),
        _ => Err(apply_outcome(&out)),
    };
    match &summary {
        Ok(_) => tracing::info!(
            source = "db",
            conn = %conn_id,
            count = statements.len(),
            lifted = conn.read_only,
            ms = started.elapsed().as_millis() as u64,
            "edits applied"
        ),
        Err(_) => tracing::warn!(
            source = "db",
            conn = %conn_id,
            count = statements.len(),
            outcome = %apply_outcome(&out),
            "edits were not applied"
        ),
    }
    if let Some(said) = said {
        record(&state, &conn.session, &audit_block(&said, &summary)).await;
    }
    out
}

/// Stop the statement running on a connection.
#[tauri::command]
pub async fn db_cancel(app: tauri::AppHandle, conn_id: String) -> AppResult<()> {
    let conn = conn_of(&app, &conn_id)?;
    let busy = conn.is_busy();
    conn.cancel().await?;
    if busy {
        tracing::info!(source = "db", conn = %conn_id, "statement stopped by the user");
    }
    Ok(())
}

/// Close a connection (its console closed).
#[tauri::command]
pub fn db_close(app: tauri::AppHandle, conn_id: String) {
    if let Some(conn) = app.state::<Dbs>().remove(&conn_id) {
        db::let_go(conn);
        tracing::info!(source = "db", conn = %conn_id, "database connection closed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A refused command is written by the window's `call()`, whatever it says:
    /// the database's words come back as an answer, and the event has the code.
    #[test]
    fn a_database_that_refuses_puts_none_of_its_words_into_a_refusal() {
        for (kind, sent, code) in [
            (DbKind::Postgres, "3D000", "3D000"),
            (DbKind::Postgres, "LEAKMARK", "?"),
            (DbKind::Mysql, "", "1130"),
        ] {
            let (answer, events) = crate::diag::capture(|| {
                db::fake::block_on(async {
                    let (target, profile) = db::fake::refusing(kind, sent);
                    match open(&target, &profile, None, false).await {
                        Ok(_) => panic!("connected to a server that refuses"),
                        Err(not) => not_opened("sid", &profile, &target, not),
                    }
                })
            });
            let answer = match answer {
                Ok(answer) => answer,
                Err(refusal) => panic!("a refused command, which call() writes: {refusal}"),
            };
            let refused = answer.refused.expect("the database's refusal");
            assert!(
                refused.message.contains("LEAKMARK"),
                "the screen has the words"
            );
            assert_eq!(refused.code, code);
            let written = format!("{events:?}");
            assert!(!written.contains("LEAKMARK"), "{written}");
            assert!(
                written.contains("db-connect-failed") && written.contains(code),
                "{written}"
            );
        }
    }

    #[test]
    fn a_refusal_without_a_marker_keeps_none_of_its_text() {
        assert_eq!(marker(&AppError::DbClosed), "db-closed");
        assert_eq!(
            marker(&AppError::Message("db-x LEAKMARK".into())),
            "refused"
        );
        assert_eq!(marker(&AppError::Message("LEAKMARK: no".into())), "refused");
    }
}
