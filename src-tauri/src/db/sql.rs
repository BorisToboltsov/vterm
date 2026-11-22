//! What a statement is, judged where it runs (ADR 0080).
//!
//! The window classifies to ask its question before a run; whether a statement
//! may run on a read-only connection without the lock lifted is decided here,
//! so a mistake of the window costs a question and not a write. A reader of
//! tokens, not a parser: what it does not know is a change. It is still a fuse
//! (INVARIANTS, principle 7) — a function of the database's own may write — and
//! stands over the server's read-only transaction, not instead of it.
//!
//! The recording's line comes from here too: a verb from this file's lists and
//! table names, never a literal, never a word this file does not know.

use crate::model::DbKind;

/// How the server reads quotes now: it follows the session's `sql_mode` and
/// `standard_conforming_strings`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mode {
    /// `\` escapes inside a plain string.
    pub backslash: bool,
    /// MySQL's `ANSI_QUOTES`: "…" is a name.
    pub ansi_quotes: bool,
}

impl Mode {
    pub fn of(kind: DbKind) -> Mode {
        Mode {
            backslash: kind == DbKind::Mysql,
            ansi_quotes: false,
        }
    }

    /// From `sql_mode` (MySQL) or `standard_conforming_strings` (PostgreSQL).
    pub fn parse(kind: DbKind, setting: &str) -> Mode {
        match kind {
            DbKind::Mysql => {
                let has = |name: &str| setting.split(',').any(|m| m.eq_ignore_ascii_case(name));
                Mode {
                    backslash: !has("NO_BACKSLASH_ESCAPES"),
                    ansi_quotes: has("ANSI_QUOTES") || has("ANSI"),
                }
            }
            DbKind::Postgres => Mode {
                backslash: setting == "off",
                ansi_quotes: false,
            },
        }
    }
}

/// What a statement does to the transaction it runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Keep,
    Open,
    Close,
    /// `ROLLBACK TO`: an aborted transaction goes on.
    Recover,
}

/// What the backend needs to know of a statement before it runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checked {
    /// Statements in the text.
    pub count: usize,
    /// A read: it may be stopped at the row cap and run again.
    pub read: bool,
    /// Runs on a read-only connection as it is: a read, a transaction's own
    /// statement, a setting that changes no right.
    pub safe: bool,
    /// Would make the lock's lifting outlast this one statement.
    pub outlasts: bool,
    /// The way the server reads quotes may differ after it.
    pub remode: bool,
    pub effect: Effect,
    /// One UPDATE or DELETE: all that applying edits takes.
    pub edit: bool,
    /// The recording's line.
    pub audit: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Tok {
    Word(String),
    Name(String),
    Text(String),
    Punct(char),
}

impl Tok {
    fn word(&self, w: &str) -> bool {
        matches!(self, Tok::Word(s) if s.eq_ignore_ascii_case(w))
    }

    fn any_word(&self, list: &[&str]) -> bool {
        list.iter().any(|w| self.word(w))
    }

    /// A word or a quoted name, lower-case: what names a function or a setting.
    fn named(&self) -> Option<String> {
        match self {
            Tok::Word(s) | Tok::Name(s) => Some(s.to_ascii_lowercase()),
            _ => None,
        }
    }
}

/// One reading of a text.
#[derive(Default)]
struct Lexed {
    statements: Vec<Vec<Tok>>,
    /// A string, name or comment without its end.
    open: bool,
    /// MySQL's `/*! … */`: code for some servers, a comment for others.
    executable: bool,
    /// `U&"…"`: names spelled in escapes, which this does not read.
    opaque: bool,
}

fn ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$' || !c.is_ascii()
}

/// The end of a quoted span that opened at `from`: past it, and what it held.
fn quoted(s: &[char], from: usize, escapes: bool) -> (usize, String, bool) {
    let q = s[from];
    let mut out = String::new();
    let mut i = from + 1;
    while i < s.len() {
        let c = s[i];
        if escapes && c == '\\' && i + 1 < s.len() {
            out.push(s[i + 1]);
            i += 2;
        } else if c == q {
            if s.get(i + 1) == Some(&q) {
                out.push(q);
                i += 2;
            } else {
                return (i + 1, out, true);
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    (i, out, false)
}

/// `$tag$` at `i`, as its length.
fn dollar_tag(s: &[char], i: usize) -> Option<usize> {
    let first = *s.get(i + 1)?;
    if first == '$' {
        return Some(2);
    }
    if first.is_ascii_digit() || !ident(first) {
        return None;
    }
    let mut j = i + 1;
    while j < s.len() && s[j] != '$' && ident(s[j]) {
        j += 1;
    }
    (s.get(j) == Some(&'$')).then_some(j + 1 - i)
}

/// Read a text as the server does. `run_executable` — `/*! … */` as code.
fn lex(kind: DbKind, mode: Mode, text: &str, run_executable: bool) -> Lexed {
    let pg = kind == DbKind::Postgres;
    let s: Vec<char> = text.chars().collect();
    let at = |i: usize| s.get(i).copied().unwrap_or('\0');
    let mut out = Lexed::default();
    let mut toks: Vec<Tok> = Vec::new();
    let mut inside_executable = false;
    // PostgreSQL continues an E'…' over blanks and comments with its escapes.
    let mut continues = false;
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if c.is_ascii_whitespace() || c == '\u{b}' {
            i += 1;
            continue;
        }
        if inside_executable && c == '*' && at(i + 1) == '/' {
            inside_executable = false;
            i += 2;
            continue;
        }
        let dashes = c == '-'
            && at(i + 1) == '-'
            && (pg || i + 2 >= s.len() || at(i + 2) == ' ' || at(i + 2).is_ascii_control());
        if dashes || (!pg && c == '#') {
            // PostgreSQL ends such a comment at a carriage return as well.
            while i < s.len() && s[i] != '\n' && !(pg && s[i] == '\r') {
                i += 1;
            }
            continue;
        }
        if c == '/' && at(i + 1) == '*' {
            let bang = match (at(i + 2), at(i + 3)) {
                ('!', _) if !pg => Some(i + 3),
                ('M', '!') if !pg => Some(i + 4),
                _ => None,
            };
            if let Some(mut body) = bang {
                out.executable = true;
                if run_executable {
                    let digits = (0..6).take_while(|n| at(body + n).is_ascii_digit()).count();
                    if digits >= 5 {
                        body += digits;
                    }
                    inside_executable = true;
                    i = body;
                    continue;
                }
            }
            let mut depth = 1;
            i += 2;
            while i < s.len() && depth > 0 {
                if s[i] == '*' && at(i + 1) == '/' {
                    depth -= 1;
                    i += 2;
                } else if pg && s[i] == '/' && at(i + 1) == '*' {
                    depth += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            out.open |= depth > 0;
            continue;
        }
        let was_continuing = std::mem::take(&mut continues);
        if c == ';' {
            if !toks.is_empty() {
                out.statements.push(std::mem::take(&mut toks));
            }
            i += 1;
        } else if c == '\'' || (c == '"' && !pg && !mode.ansi_quotes) {
            let escapes = mode.backslash || was_continuing;
            let (to, held, closed) = quoted(&s, i, escapes);
            out.open |= !closed;
            continues = was_continuing;
            toks.push(Tok::Text(held));
            i = to;
        } else if c == '"' || (c == '`' && !pg) {
            let (to, held, closed) = quoted(&s, i, false);
            out.open |= !closed;
            toks.push(Tok::Name(held));
            i = to;
        } else if let Some(len) = (pg && c == '$').then(|| dollar_tag(&s, i)).flatten() {
            let tag = &s[i..i + len];
            let body = i + len;
            let end = (body..s.len()).find(|&j| s[j..].starts_with(tag));
            out.open |= end.is_none();
            let stop = end.unwrap_or(s.len());
            toks.push(Tok::Text(s[body..stop].iter().collect()));
            i = end.map_or(s.len(), |j| j + len);
        } else if ident(c) {
            let from = i;
            while i < s.len() && ident(s[i]) {
                i += 1;
            }
            let word: String = s[from..i].iter().collect();
            if pg && at(i) == '\'' && word.eq_ignore_ascii_case("e") {
                let (to, held, closed) = quoted(&s, i, true);
                out.open |= !closed;
                continues = true;
                toks.push(Tok::Text(held));
                i = to;
                continue;
            }
            out.opaque |= pg
                && word.eq_ignore_ascii_case("u")
                && at(i) == '&'
                && matches!(at(i + 1), '\'' | '"');
            toks.push(Tok::Word(word));
        } else {
            toks.push(Tok::Punct(c));
            i += 1;
        }
    }
    out.open |= inside_executable;
    if !toks.is_empty() {
        out.statements.push(toks);
    }
    out
}

/// Functions that change something a read-only transaction does not guard, or
/// run text this file never sees.
const ACTING: &[&str] = &[
    "set_config",
    "nextval",
    "setval",
    "pg_cancel_backend",
    "pg_terminate_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_promote",
    "pg_switch_wal",
    "pg_notify",
    "pg_export_snapshot",
    "pg_backup_start",
    "pg_backup_stop",
    "pg_start_backup",
    "pg_stop_backup",
    "pg_stat_statements_reset",
    "pg_import_system_collations",
    "pg_replication_slot_advance",
    "pg_sync_replication_slots",
    "pg_wal_replay_pause",
    "pg_wal_replay_resume",
    "lowrite",
    "ts_stat",
    "ts_rewrite",
    "crosstab",
    "connectby",
    "get_lock",
    "release_lock",
    "release_all_locks",
    "sys_exec",
    "sys_eval",
];

const ACTING_PREFIX: &[&str] = &[
    "dblink",
    "query_to_xml",
    "cursor_to_xml",
    "pg_advisory",
    "pg_try_advisory",
    "pg_create_",
    "pg_drop_",
    "pg_copy_",
    "pg_file_",
    "pg_logical_",
    "pg_replication_origin_",
    "pg_stat_reset",
    "pg_log_backend_",
    "lo_import",
    "lo_export",
    "lo_unlink",
    "lo_creat",
    "lo_open",
    "lo_put",
    "lo_from_bytea",
    "lo_truncate",
    "heap_force_",
];

/// Anywhere in the text, with or without brackets: `(1).pg_terminate_backend`
/// is a call too.
fn acts(t: &[Tok]) -> bool {
    t.iter()
        .filter_map(Tok::named)
        .any(|n| ACTING.contains(&n.as_str()) || ACTING_PREFIX.iter().any(|p| n.starts_with(p)))
}

/// No writing verb in a body that reads.
fn body_reads(t: &[Tok]) -> bool {
    !t.iter().enumerate().any(|(i, x)| {
        x.any_word(&["INTO", "UPDATE", "DELETE", "MERGE"])
            || (x.any_word(&["INSERT", "REPLACE"]) && t.get(i + 1) != Some(&Tok::Punct('(')))
    })
}

fn is_read(kind: DbKind, t: &[Tok]) -> bool {
    let Some(start) = t.iter().position(|x| *x != Tok::Punct('(')) else {
        return false;
    };
    if acts(t) {
        return false;
    }
    let head = &t[start];
    let my = kind == DbKind::Mysql;
    if head.any_word(&["SELECT", "WITH", "VALUES", "TABLE"]) {
        return body_reads(t);
    }
    if head.word("SHOW") || (my && head.word("HELP")) {
        return true;
    }
    if head.word("EXPLAIN") || (my && head.any_word(&["DESCRIBE", "DESC"])) {
        let rest = &t[start + 1..];
        let runs = rest.iter().any(|x| x.any_word(&["ANALYZE", "ANALYSE"]));
        return !runs
            || (body_reads(rest)
                && !rest
                    .iter()
                    .any(|x| x.any_word(&["EXECUTE", "CREATE", "DECLARE", "REFRESH", "CALL"])));
    }
    // MariaDB's `ANALYZE SELECT`: its EXPLAIN ANALYZE.
    my && head.word("ANALYZE")
        && t.get(start + 1)
            .is_some_and(|x| x.any_word(&["SELECT", "WITH", "FORMAT"]))
        && t.iter().any(|x| x.word("SELECT"))
        && body_reads(t)
}

fn read_write(t: &[Tok]) -> bool {
    t.windows(2)
        .any(|w| w[0].word("READ") && w[1].word("WRITE"))
}

/// A transaction's own statement, in one of its known forms.
fn tx_form(kind: DbKind, t: &[Tok]) -> Option<Effect> {
    let pg = kind == DbKind::Postgres;
    let (head, rest) = t.split_first()?;
    let only = |words: &[&str]| {
        rest.iter()
            .all(|x| *x == Tok::Punct(',') || x.any_word(words))
    };
    let a_name = |x: Option<&Tok>| matches!(x, Some(Tok::Word(_) | Tok::Name(_)));
    let starts = head.word("BEGIN")
        || (head.word("START") && rest.first().is_some_and(|x| x.word("TRANSACTION")));
    if starts {
        // MariaDB's `BEGIN NOT ATOMIC …` is a block of code, not a transaction.
        let known = only(&[
            "WORK",
            "TRANSACTION",
            "ISOLATION",
            "LEVEL",
            "READ",
            "ONLY",
            "COMMITTED",
            "UNCOMMITTED",
            "REPEATABLE",
            "SERIALIZABLE",
            "DEFERRABLE",
            "NOT",
            "WITH",
            "CONSISTENT",
            "SNAPSHOT",
        ]);
        return known.then_some(Effect::Open);
    }
    if head.word("SAVEPOINT") {
        return (rest.len() == 1 && a_name(rest.first())).then_some(Effect::Keep);
    }
    if head.word("RELEASE") {
        let named = rest.len() == 1 || (rest.len() == 2 && rest[0].word("SAVEPOINT"));
        return (named && a_name(rest.last())).then_some(Effect::Keep);
    }
    if head.word("ROLLBACK") {
        if let Some(to) = rest.iter().position(|x| x.word("TO")) {
            let before = rest[..to]
                .iter()
                .all(|x| x.any_word(&["WORK", "TRANSACTION"]));
            let after = &rest[to + 1..];
            let named = after.len() == 1 || (after.len() == 2 && after[0].word("SAVEPOINT"));
            return (before && named && a_name(after.last())).then_some(Effect::Recover);
        }
    }
    let ends = head.any_word(&["COMMIT", "ROLLBACK"]) || (pg && head.any_word(&["END", "ABORT"]));
    if ends && only(&["WORK", "TRANSACTION", "AND", "CHAIN", "NO", "RELEASE"]) {
        let chains = rest
            .windows(2)
            .any(|w| w[0].word("AND") && w[1].word("CHAIN"));
        return Some(if chains { Effect::Open } else { Effect::Close });
    }
    None
}

/// A setting that moves no right and no lock.
fn harmless_setting(kind: DbKind, t: &[Tok]) -> bool {
    let pg = kind == DbKind::Postgres;
    if !pg && t.len() == 2 && t[0].word("USE") {
        return t[1].named().is_some();
    }
    let reset = pg && t.first().is_some_and(|x| x.word("RESET"));
    if !reset && !t.first().is_some_and(|x| x.word("SET")) {
        return false;
    }
    let mut rest = &t[1..];
    if rest
        .first()
        .is_some_and(|x| x.word("SESSION") || (pg && x.word("LOCAL")))
    {
        rest = &rest[1..];
    }
    let Some(name) = rest.first().and_then(Tok::named) else {
        return false;
    };
    let known: &[&str] = if pg {
        &[
            "search_path",
            "statement_timeout",
            "lock_timeout",
            "idle_in_transaction_session_timeout",
            "timezone",
            "datestyle",
            "intervalstyle",
            "work_mem",
            "extra_float_digits",
            "random_page_cost",
            "application_name",
            "jit",
        ]
    } else {
        &[
            "max_execution_time",
            "max_statement_time",
            "time_zone",
            "sql_select_limit",
            "lock_wait_timeout",
            "innodb_lock_wait_timeout",
            "group_concat_max_len",
        ]
    };
    let zone = pg && name == "time" && rest.get(1).is_some_and(|x| x.word("ZONE"));
    if !(zone || known.contains(&name.as_str()) || (pg && name.starts_with("enable_"))) {
        return false;
    }
    let value = &rest[1..];
    if reset {
        return value.is_empty() || zone;
    }
    // A list is a value only for these two; anywhere else a comma starts a second setting.
    let list = pg && (name == "search_path" || name == "datestyle");
    let assigned = zone
        || value
            .first()
            .is_some_and(|x| *x == Tok::Punct('=') || (pg && x.word("TO")));
    assigned
        && value.iter().all(|x| match x {
            Tok::Punct(',') => list,
            Tok::Punct(p) => matches!(p, '=' | '-' | '+' | '.' | ':'),
            _ => true,
        })
}

/// Would carry the lifted lock past the statement.
fn outlasts(t: &[Tok]) -> bool {
    let Some(head) = t.first() else {
        return false;
    };
    if head.any_word(&["BEGIN", "XA"])
        || (head.word("START") && t.get(1).is_some_and(|x| x.word("TRANSACTION")))
    {
        // A lifted lock must not be what a transaction begins with.
        return tx_form(DbKind::Postgres, t).is_none();
    }
    let setting = head.any_word(&["SET", "RESET"]);
    if setting && read_write(t) {
        return true;
    }
    let by_function = t.iter().any(|x| x.named().as_deref() == Some("set_config"));
    (setting || by_function)
        && t.iter().any(|x| {
            let n = match x {
                Tok::Word(s) | Tok::Name(s) | Tok::Text(s) => s.to_ascii_lowercase(),
                Tok::Punct(_) => return false,
            };
            matches!(
                n.as_str(),
                "default_transaction_read_only"
                    | "transaction_read_only"
                    | "tx_read_only"
                    | "autocommit"
            )
        })
}

const VERBS: &[&str] = &[
    "SELECT",
    "WITH",
    "VALUES",
    "TABLE",
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "REPLACE",
    "COPY",
    "LOAD",
    "CALL",
    "DO",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "RENAME",
    "COMMENT",
    "GRANT",
    "REVOKE",
    "REFRESH",
    "VACUUM",
    "ANALYZE",
    "REINDEX",
    "CLUSTER",
    "CHECKPOINT",
    "KILL",
    "FLUSH",
    "OPTIMIZE",
    "REPAIR",
    "LOCK",
    "UNLOCK",
    "PURGE",
    "RESET",
    "SET",
    "NOTIFY",
    "LISTEN",
    "UNLISTEN",
    "DISCARD",
    "PREPARE",
    "EXECUTE",
    "DEALLOCATE",
    "EXPLAIN",
    "BEGIN",
    "START",
    "COMMIT",
    "ROLLBACK",
    "DECLARE",
    "FETCH",
    "HANDLER",
    "IMPORT",
    "SHUTDOWN",
];

const OBJECTS: &[&str] = &[
    "TABLE",
    "INDEX",
    "VIEW",
    "DATABASE",
    "SCHEMA",
    "USER",
    "ROLE",
    "FUNCTION",
    "PROCEDURE",
    "TRIGGER",
    "EVENT",
    "SEQUENCE",
    "TYPE",
    "EXTENSION",
    "SYSTEM",
    "UNIQUE",
    "MATERIALIZED",
];

/// The recording's line: a known verb and the tables named after it.
fn audit_of(t: &[Tok]) -> String {
    // The activity view's two actions say whom they were about.
    if let [head, Tok::Word(f), Tok::Punct('('), Tok::Word(id), Tok::Punct(')')] = t {
        if head.word("SELECT") && id.chars().all(|c| c.is_ascii_digit()) {
            if f.eq_ignore_ascii_case("pg_terminate_backend") {
                return format!("TERMINATE session {id}");
            }
            if f.eq_ignore_ascii_case("pg_cancel_backend") {
                return format!("CANCEL session {id}");
            }
        }
    }
    if let [head, middle @ .., Tok::Word(id)] = t {
        if head.word("KILL") && id.chars().all(|c| c.is_ascii_digit()) {
            match middle {
                [] => return format!("TERMINATE session {id}"),
                [q] if q.word("QUERY") => return format!("CANCEL session {id}"),
                _ => {}
            }
        }
    }
    let known = |list: &'static [&'static str], x: Option<&Tok>| {
        list.iter().copied().find(|w| x.is_some_and(|x| x.word(w)))
    };
    let Some(verb) = known(VERBS, t.iter().find(|x| **x != Tok::Punct('('))) else {
        return "SQL".into();
    };
    let mut out = verb.to_string();
    if matches!(verb, "CREATE" | "ALTER" | "DROP") {
        if let Some(what) = known(OBJECTS, t.get(1)) {
            out = format!("{out} {what}");
            if what == "UNIQUE" || what == "MATERIALIZED" {
                if let Some(next) = known(OBJECTS, t.get(2)) {
                    out = format!("{out} {next}");
                }
            }
        }
    }
    let skipped = [
        "ONLY",
        "IF",
        "EXISTS",
        "NOT",
        "LATERAL",
        "TABLE",
        "IGNORE",
        "LOW_PRIORITY",
        "QUICK",
        "DELAYED",
        "HIGH_PRIORITY",
        "CONCURRENTLY",
        "OUTFILE",
        "DUMPFILE",
    ];
    let mut tables: Vec<String> = Vec::new();
    for i in 0..t.len() {
        if !t[i].any_word(&["FROM", "JOIN", "UPDATE", "INTO", "TABLE", "TRUNCATE"]) {
            continue;
        }
        let mut j = i + 1;
        while t.get(j).is_some_and(|x| x.any_word(&skipped)) {
            j += 1;
        }
        let mut parts: Vec<String> = Vec::new();
        while let Some(Tok::Word(n) | Tok::Name(n)) = t.get(j) {
            // A number is a value, whatever stands before it.
            if n.starts_with(|c: char| c.is_ascii_digit() || c == '$') {
                break;
            }
            parts.push(n.chars().take(64).collect());
            j += 1;
            if t.get(j) != Some(&Tok::Punct('.')) {
                break;
            }
            j += 1;
        }
        if parts.is_empty()
            || t[i + 1].any_word(&["SELECT", "SET"])
            || (t[i].word("FROM") && t.get(j) == Some(&Tok::Punct('(')))
        {
            continue;
        }
        let name = parts.join(".");
        if !tables.contains(&name) {
            tables.push(name);
        }
        if tables.len() == 5 {
            break;
        }
    }
    if !tables.is_empty() {
        out = format!("{out} {}", tables.join(", "));
    }
    out
}

/// Judge a text about to run.
pub fn check(kind: DbKind, mode: Mode, text: &str) -> Checked {
    let lexed = lex(kind, mode, text, true);
    let other = lexed.executable.then(|| lex(kind, mode, text, false));
    let count = lexed
        .statements
        .len()
        .max(other.as_ref().map_or(0, |o| o.statements.len()));
    let t: &[Tok] = lexed.statements.first().map_or(&[], Vec::as_slice);
    // Which parts of `/*! … */` run is the server's version: never taken for a read.
    let plain = count == 1 && !lexed.open && !lexed.executable && !lexed.opaque;
    let form = tx_form(kind, t);
    let read = plain && is_read(kind, t);
    // (`READ WRITE` at a transaction's start falls out of `tx_form`'s words.)
    let safe = read || (plain && (form.is_some() || harmless_setting(kind, t)));
    let effect = if kind == DbKind::Postgres
        && t.first().is_some_and(|x| x.word("PREPARE"))
        && t.get(1).is_some_and(|x| x.word("TRANSACTION"))
    {
        Effect::Close
    } else if kind == DbKind::Postgres
        && t.first()
            .is_some_and(|x| x.word("BEGIN") || x.word("START"))
    {
        // `BEGIN READ WRITE` is not safe and still opens one.
        Effect::Open
    } else {
        form.unwrap_or(Effect::Keep)
    };
    Checked {
        count,
        read,
        safe,
        outlasts: lexed.statements.iter().any(|s| outlasts(s)),
        remode: !read
            && t.first()
                .is_some_and(|x| x.any_word(&["SET", "RESET", "DISCARD", "EXECUTE", "DO", "CALL"]))
            || t.iter().any(|x| x.named().as_deref() == Some("set_config")),
        effect,
        edit: plain && t.first().is_some_and(|x| x.any_word(&["UPDATE", "DELETE"])),
        audit: audit_of(t),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PG: DbKind = DbKind::Postgres;
    const MY: DbKind = DbKind::Mysql;

    fn of(kind: DbKind, text: &str) -> Checked {
        check(kind, Mode::of(kind), text)
    }

    #[test]
    fn what_reads_runs_without_the_lock_lifted() {
        for (kind, text) in [
            (PG, "select * from t where a = 'x;y' -- note\n"),
            (PG, "SELECT replace(a, 'x', 'y'), insert_count FROM t;"),
            (PG, "WITH r AS (SELECT 1) SELECT * FROM r"),
            (PG, "(SELECT 1) UNION (SELECT 2)"),
            (PG, "TABLE t"),
            (PG, "SHOW work_mem"),
            (PG, "EXPLAIN DELETE FROM t"),
            (PG, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1"),
            (PG, "SELECT \"update\" FROM t"),
            (PG, "SELECT $$ ; DROP TABLE t $$"),
            (MY, "SELECT INSERT('abc', 1, 1, 'x'), @@sql_mode"),
            (MY, "SELECT 'it\\'s; fine'"),
            (MY, "DESCRIBE t"),
            (MY, "ANALYZE SELECT * FROM t"),
            (MY, "SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1"),
            (MY, "SHOW REPLICA STATUS"),
        ] {
            let c = of(kind, text);
            assert!(c.read && c.safe && !c.outlasts, "{kind:?}: {text}");
        }
    }

    #[test]
    fn transactions_and_harmless_settings_pass_and_are_not_reads() {
        for (kind, text) in [
            (PG, "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY"),
            (PG, "SET statement_timeout = '5s'"),
            (PG, "SET search_path TO app, public"),
            (PG, "SET LOCAL enable_seqscan = off"),
            (PG, "SET TIME ZONE 'UTC'"),
            (PG, "RESET search_path"),
            (PG, "ROLLBACK TO SAVEPOINT s"),
            (PG, "COMMIT"),
            (MY, "START TRANSACTION WITH CONSISTENT SNAPSHOT"),
            (MY, "USE billing"),
            (MY, "SET SESSION max_execution_time = 5000"),
        ] {
            let c = of(kind, text);
            assert!(c.safe && !c.read && !c.outlasts, "{kind:?}: {text}");
        }
    }

    #[test]
    fn a_change_never_passes_for_a_read_however_it_is_dressed() {
        for (kind, text) in [
            (PG, "UPDATE t SET a = 1 RETURNING *"),
            (PG, "frobnicate"),
            (PG, ""),
            (
                PG,
                "WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone",
            ),
            (PG, "SELECT * INTO copy FROM t"),
            (PG, "EXPLAIN ANALYZE DELETE FROM t"),
            (PG, "EXPLAIN (ANALYZE) EXECUTE p"),
            (
                PG,
                "SELECT set_config('default_transaction_read_only', 'off', false)",
            ),
            (PG, "SELECT \"pg_terminate_backend\"(42)"),
            (PG, "SELECT (42).pg_terminate_backend"),
            (
                PG,
                "SELECT query_to_xml('select set_config(1)', true, true, '')",
            ),
            (PG, "SELECT dblink_exec('x', 'DROP TABLE t')"),
            (PG, "SELECT U&\"set\\005Fconfig\"('a', 'b', false)"),
            (PG, "SELECT 1 -- x\r, set_config('a.b', 'c', false)"),
            (PG, "SELECT E'a'\n'\\'', set_config('a.b', 'c', false) -- '"),
            (PG, "SELECT 1; DELETE FROM t"),
            (PG, "SELECT 'no end"),
            (PG, "BEGIN READ WRITE"),
            (PG, "ALTER SYSTEM SET work_mem = '1GB'"),
            (PG, "SET ROLE admin"),
            (PG, "SET work_mem = '1MB', role = admin"),
            (PG, "COMMIT PREPARED 'x'"),
            (PG, "COPY t TO PROGRAM 'id'"),
            (MY, "SELECT * FROM t INTO OUTFILE '/tmp/x'"),
            (MY, "SET GLOBAL max_connections = 10"),
            (MY, "SET time_zone = 'UTC', GLOBAL read_only = 0"),
            (MY, "SET autocommit = 0"),
            (MY, "START REPLICA"),
            (MY, "BEGIN NOT ATOMIC DELETE FROM t"),
            (MY, "WITH x AS (SELECT 1) UPDATE (t) SET a = 1"),
            (MY, "SELECT GET_LOCK('x', 1)"),
            (MY, "KILL 7"),
            (MY, "SELECT 1 /*! INTO OUTFILE '/tmp/x' */"),
            (MY, "/*!50000 DELETE*/ FROM t"),
        ] {
            let c = of(kind, text);
            assert!(!c.read && !c.safe, "{kind:?}: {text}");
        }
    }

    #[test]
    fn a_second_statement_is_seen_behind_quotes_and_comments() {
        assert_eq!(of(MY, "SELECT 1; DROP TABLE t").count, 2);
        // The comment is a comment for a server older than it names.
        assert_eq!(
            of(MY, "SELECT 1 /*!99999 ' */; DROP TABLE t; -- '").count,
            2
        );
        assert_eq!(of(MY, "SELECT 1 /*!50000 ; DROP TABLE t */").count, 2);
        // `--` without a blank is arithmetic in MySQL.
        assert_eq!(of(MY, "SELECT 1--1; DROP TABLE t").count, 2);
        assert_eq!(of(MY, "SELECT 'a\\'; DROP TABLE t'").count, 1);
        let plain = Mode::parse(MY, "STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES");
        assert_eq!(check(MY, plain, "SELECT 'a\\'; DROP TABLE t").count, 2);
        let ansi = Mode::parse(MY, "ANSI_QUOTES");
        assert_eq!(check(MY, ansi, "SELECT \"a\\\"; DROP TABLE t").count, 2);
        assert_eq!(of(MY, "SELECT 1; -- the end").count, 1);
        assert_eq!(of(MY, " -- nothing\n").count, 0);
    }

    #[test]
    fn what_would_keep_the_lock_open_is_named_even_when_the_user_agreed() {
        for (kind, text) in [
            (PG, "BEGIN READ WRITE"),
            (PG, "SET default_transaction_read_only = off"),
            (PG, "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE"),
            (PG, "SET TRANSACTION READ WRITE"),
            (PG, "RESET default_transaction_read_only"),
            (
                PG,
                "SELECT set_config('transaction_read_only', 'off', false)",
            ),
            (MY, "START TRANSACTION READ WRITE"),
            (MY, "SET @@session.transaction_read_only = 0"),
            (MY, "SET autocommit = 0"),
            (MY, "XA START 'x'"),
            (MY, "BEGIN NOT ATOMIC DELETE FROM t"),
        ] {
            assert!(of(kind, text).outlasts, "{kind:?}: {text}");
        }
        for text in [
            "DELETE FROM t WHERE id = 1",
            "SET ROLE admin",
            "ALTER ROLE r SET work_mem = '1MB'",
        ] {
            assert!(!of(PG, text).outlasts, "{text}");
        }
    }

    /// The window's own queries (`appsql.cases.json`, kept by `appsql.test.ts`):
    /// refused, a panel would be broken on every prod server; recorded, the
    /// recording would be the app talking to itself.
    #[test]
    fn the_apps_own_reads_pass_and_its_changes_ask() {
        #[derive(serde::Deserialize)]
        struct Cases {
            kind: DbKind,
            reads: Vec<String>,
            changes: Vec<String>,
        }
        let all: Vec<Cases> =
            serde_json::from_str(include_str!("../../../src/lib/db/appsql.cases.json"))
                .expect("the cases");
        assert_eq!(all.len(), 2);
        for cases in all {
            for text in &cases.reads {
                let c = of(cases.kind, text);
                assert!(c.read && c.safe && c.count == 1, "{text}");
            }
            for text in &cases.changes {
                let c = of(cases.kind, text);
                assert!(!c.safe && !c.outlasts, "{text}");
            }
        }
    }

    #[test]
    fn a_transaction_is_followed_through_its_statements() {
        for (text, effect) in [
            ("begin", Effect::Open),
            ("BEGIN READ WRITE", Effect::Open),
            ("SAVEPOINT a", Effect::Keep),
            ("RELEASE SAVEPOINT a", Effect::Keep),
            ("ROLLBACK TO a", Effect::Recover),
            ("COMMIT AND CHAIN", Effect::Open),
            ("COMMIT AND NO CHAIN", Effect::Close),
            ("END", Effect::Close),
            ("ROLLBACK WORK", Effect::Close),
            ("PREPARE TRANSACTION 'x'", Effect::Close),
            ("UPDATE t SET a = 1", Effect::Keep),
        ] {
            assert_eq!(of(PG, text).effect, effect, "{text}");
        }
    }

    #[test]
    fn only_one_update_or_delete_is_an_edit() {
        assert!(of(PG, "UPDATE \"t\" SET \"a\" = 'x' WHERE \"id\" = '1'").edit);
        assert!(of(MY, "DELETE FROM `t` WHERE `id` = '1'").edit);
        for text in [
            "COMMIT",
            "DROP TABLE t",
            "DELETE FROM t; DROP TABLE u",
            "INSERT INTO t VALUES (1)",
        ] {
            assert!(!of(MY, text).edit, "{text}");
        }
    }

    #[test]
    fn the_recordings_line_is_built_here_and_holds_no_value() {
        for (kind, text, line) in [
            (
                PG,
                "UPDATE public.invoices SET note = 'secret 42' WHERE id = 7",
                "UPDATE public.invoices",
            ),
            (
                PG,
                "DELETE FROM ONLY \"Order\" WHERE id IN (SELECT y FROM u)",
                "DELETE Order, u",
            ),
            (PG, "INSERT INTO t (a) VALUES ('hunter2')", "INSERT t"),
            (PG, "ALTER ROLE app PASSWORD 'hunter2'", "ALTER ROLE"),
            (PG, "create unique index i on t (a)", "CREATE UNIQUE INDEX"),
            (PG, "hunter2 is my password", "SQL"),
            (MY, "SET PASSWORD = \"hunter2\"", "SET"),
            (
                MY,
                "SELECT * FROM t INTO OUTFILE '/srv/hunter2'",
                "SELECT t",
            ),
            (
                PG,
                "SELECT pg_terminate_backend(42)",
                "TERMINATE session 42",
            ),
            (PG, "SELECT pg_cancel_backend(42)", "CANCEL session 42"),
            (MY, "KILL QUERY 7", "CANCEL session 7"),
            (MY, "KILL 7", "TERMINATE session 7"),
        ] {
            assert_eq!(of(kind, text).audit, line, "{text}");
        }
    }
}
