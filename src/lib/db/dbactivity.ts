// A database's activity, the way an SRE looks at it (ADR 0080): who is
// connected and doing what, who waits on whose lock, the replicas' lag, the
// statements that cost the most — read with the database's own views
// (`pg_stat_activity`, `PROCESSLIST`, …) and judged against thresholds the user
// sets. What cannot be read is "not available", never an empty list: an
// extension that is not installed, a privilege the role lacks.

import type { DbKind, DbOutcome } from "../types";

export type SessionState = "active" | "idle" | "idleTx" | "idleTxAborted" | "other";

export interface DbSession {
  id: string;
  user: string;
  app: string;
  client: string;
  db: string;
  state: SessionState;
  /** What it waits on (PostgreSQL's wait event, MySQL's state). */
  wait: string;
  /** How long its transaction, its statement and its state have lasted (s). */
  xactS: number | null;
  queryS: number | null;
  stateS: number | null;
  /** Sessions whose locks it waits for. */
  blockedBy: string[];
  query: string;
}

export interface DbStatement {
  query: string;
  calls: number;
  meanMs: number;
  totalS: number;
  /** Its share of all the statements' time, %. */
  share: number;
}

export interface DbReplica {
  name: string;
  client: string;
  state: string;
  lagS: number | null;
}

export interface Activity {
  conns: number | null;
  maxConns: number | null;
  /** Buffer cache hits, %. */
  hitPct: number | null;
  /** This server is a replica, and how far behind its primary (s). */
  replica: boolean;
  replayLagS: number | null;
  replicas: DbReplica[] | null;
  sessions: DbSession[];
  /** Null — not available: no extension, no `performance_schema`, no privilege. */
  statements: DbStatement[] | null;
}

/** MySQL or MariaDB: their catalogs differ where lock waits live. */
export const isMariaDb = (version: string): boolean => /mariadb/i.test(version);

/** PostgreSQL's major version, from `server_version`. */
export const pgMajor = (version: string): number => Number(/^(\d+)/.exec(version)?.[1] ?? 0);

export interface ActivityQueries {
  sessions: string;
  /** Who waits for whom (MySQL; PostgreSQL's sessions query says it itself). */
  locks: string | null;
  stats: string;
  /** MySQL's status counters. */
  status: string | null;
  replicas: string;
  statements: string;
}

export function activityQueries(kind: DbKind, version: string): ActivityQueries {
  if (kind === "postgres") {
    const time = pgMajor(version) >= 13 ? "exec_time" : "time";
    return {
      sessions:
        "SELECT pid::text, usename, application_name, coalesce(client_addr::text, 'local'), coalesce(datname, ''), state, coalesce(wait_event_type || ': ' || wait_event, ''), " +
        "EXTRACT(EPOCH FROM (now() - xact_start))::int, EXTRACT(EPOCH FROM (now() - query_start))::int, EXTRACT(EPOCH FROM (now() - state_change))::int, " +
        "array_to_string(pg_blocking_pids(pid), ','), left(query, 400) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY query_start NULLS LAST LIMIT 500",
      locks: null,
      stats:
        "SELECT (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'), current_setting('max_connections')::int, " +
        "(SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 1) FROM pg_stat_database), pg_is_in_recovery(), " +
        // A replica that replayed all it received is not behind, however old the last transaction.
        "CASE WHEN NOT pg_is_in_recovery() THEN NULL WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() AND EXISTS (SELECT 1 FROM pg_stat_wal_receiver) THEN 0 ELSE EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int END",
      status: null,
      replicas: "SELECT coalesce(application_name, ''), coalesce(client_addr::text, ''), coalesce(state, ''), round(EXTRACT(EPOCH FROM replay_lag)::numeric, 1) FROM pg_stat_replication",
      statements:
        `SELECT left(query, 300), calls, round(mean_${time}::numeric, 2), round((total_${time} / 1000)::numeric, 1), ` +
        `round((100 * total_${time} / nullif(sum(total_${time}) OVER (), 0))::numeric, 1) FROM pg_stat_statements ORDER BY total_${time} DESC LIMIT 10`,
    };
  }
  const maria = isMariaDb(version);
  return {
    sessions:
      "SELECT p.ID, p.USER, '', p.HOST, coalesce(p.DB, ''), p.COMMAND, coalesce(p.STATE, ''), TIMESTAMPDIFF(SECOND, t.trx_started, NOW()), p.TIME, p.TIME, '', LEFT(coalesce(p.INFO, ''), 400) " +
      "FROM information_schema.PROCESSLIST p LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = p.ID WHERE p.ID <> CONNECTION_ID() AND p.COMMAND NOT IN ('Daemon', 'Binlog Dump') ORDER BY p.TIME DESC LIMIT 500",
    locks: maria
      ? "SELECT r.trx_mysql_thread_id, b.trx_mysql_thread_id FROM information_schema.INNODB_LOCK_WAITS w JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id"
      : "SELECT r.PROCESSLIST_ID, b.PROCESSLIST_ID FROM performance_schema.data_lock_waits w JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID",
    stats: "SELECT (SELECT COUNT(*) FROM information_schema.PROCESSLIST), @@max_connections, NULL, NULL, NULL",
    status: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads')",
    replicas: "SHOW REPLICA STATUS",
    statements:
      "SELECT LEFT(DIGEST_TEXT, 300), COUNT_STAR, ROUND(AVG_TIMER_WAIT / 1000000000, 2), ROUND(SUM_TIMER_WAIT / 1000000000000, 1), " +
      "ROUND(100 * SUM_TIMER_WAIT / NULLIF(SUM(SUM_TIMER_WAIT) OVER (), 0), 1) FROM performance_schema.events_statements_summary_by_digest WHERE DIGEST_TEXT IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 10",
  };
}

/** The sessions query when the role may not read open transactions (MySQL's INNODB_TRX). */
export const MY_SESSIONS_PLAIN =
  "SELECT ID, USER, '', HOST, coalesce(DB, ''), COMMAND, coalesce(STATE, ''), NULL, TIME, TIME, '', LEFT(coalesce(INFO, ''), 400) FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() AND COMMAND NOT IN ('Daemon', 'Binlog Dump') ORDER BY TIME DESC LIMIT 500";

const cell = (o: DbOutcome, r: number, c: number): string => o.rows[r]?.[c] ?? "";
const numOr = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function pgState(state: string): SessionState {
  if (state === "active") return "active";
  if (state === "idle") return "idle";
  if (state === "idle in transaction") return "idleTx";
  if (state === "idle in transaction (aborted)") return "idleTxAborted";
  return "other";
}

function myState(command: string, xact: number | null): SessionState {
  if (command === "Query" || command === "Execute") return "active";
  if (command === "Sleep") return xact !== null ? "idleTx" : "idle";
  return "other";
}

/** Sessions; `locks` — MySQL's "who waits for whom" (waiting → blocking). */
export function parseSessions(kind: DbKind, o: DbOutcome, locks: DbOutcome | null): DbSession[] {
  const waits = new Map<string, string[]>();
  for (const row of locks?.rows ?? []) {
    const [waiting, blocking] = [row[0] ?? "", row[1] ?? ""];
    if (waiting && blocking) waits.set(waiting, [...(waits.get(waiting) ?? []), blocking]);
  }
  return o.rows.map((_, r) => {
    const id = cell(o, r, 0);
    const xact = numOr(o.rows[r][7]);
    return {
      id,
      user: cell(o, r, 1),
      app: cell(o, r, 2),
      client: cell(o, r, 3),
      db: cell(o, r, 4),
      state: kind === "postgres" ? pgState(cell(o, r, 5)) : myState(cell(o, r, 5), xact),
      wait: cell(o, r, 6),
      xactS: xact,
      queryS: numOr(o.rows[r][8]),
      stateS: numOr(o.rows[r][9]),
      // Once each: parallel workers of one query name their blocker again.
      blockedBy: [...new Set(kind === "postgres" ? cell(o, r, 10).split(",").filter(Boolean) : (waits.get(id) ?? []))],
      query: cell(o, r, 11),
    };
  });
}

export function parseStatements(o: DbOutcome): DbStatement[] {
  return o.rows.map((_, r) => ({
    query: cell(o, r, 0),
    calls: numOr(o.rows[r][1]) ?? 0,
    meanMs: numOr(o.rows[r][2]) ?? 0,
    totalS: numOr(o.rows[r][3]) ?? 0,
    share: numOr(o.rows[r][4]) ?? 0,
  }));
}

/** PostgreSQL's replicas (`pg_stat_replication`), or this MySQL's own place as one. */
export function parseReplicas(kind: DbKind, o: DbOutcome): { replicas: DbReplica[]; lagS: number | null; isReplica: boolean } {
  if (kind === "postgres") {
    return {
      replicas: o.rows.map((_, r) => ({ name: cell(o, r, 0), client: cell(o, r, 1), state: cell(o, r, 2), lagS: numOr(o.rows[r][3]) })),
      lagS: null,
      isReplica: false,
    };
  }
  if (o.rows.length === 0) return { replicas: [], lagS: null, isReplica: false };
  const col = o.columns.findIndex((c) => c.name === "Seconds_Behind_Source" || c.name === "Seconds_Behind_Master");
  return { replicas: [], lagS: col < 0 ? null : numOr(o.rows[0][col]), isReplica: true };
}

/** Connections, their limit, cache hits, and whether this is a replica — from the stats row. */
export function parseStats(
  o: DbOutcome,
  status: DbOutcome | null,
): Pick<Activity, "conns" | "maxConns" | "hitPct" | "replica" | "replayLagS"> {
  let hitPct = numOr(o.rows[0]?.[2]);
  if (status) {
    const v = (name: string) => numOr(status.rows.find((row) => row[0] === name)?.[1]);
    const requests = v("Innodb_buffer_pool_read_requests");
    const reads = v("Innodb_buffer_pool_reads");
    if (requests && reads !== null) hitPct = Math.round(1000 * (1 - reads / requests)) / 10;
  }
  return {
    conns: numOr(o.rows[0]?.[0]),
    maxConns: numOr(o.rows[0]?.[1]),
    hitPct,
    replica: o.rows[0]?.[3] === "t" || o.rows[0]?.[3] === "true",
    replayLagS: numOr(o.rows[0]?.[4]),
  };
}

/**
 * Who holds whom: each session that blocks others and waits on none, with the
 * ones waiting on it beneath — as deep as the chain goes, each once.
 */
export function blockingTree(sessions: DbSession[]): { session: DbSession; depth: number }[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const waitersOf = new Map<string, DbSession[]>();
  for (const s of sessions) for (const b of s.blockedBy) waitersOf.set(b, [...(waitersOf.get(b) ?? []), s]);
  const roots = sessions.filter((s) => waitersOf.has(s.id) && s.blockedBy.every((b) => !byId.has(b)));
  const out: { session: DbSession; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (s: DbSession, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ session: s, depth });
    for (const w of waitersOf.get(s.id) ?? []) walk(w, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // A cycle has no root: its members are listed flat rather than lost.
  for (const s of sessions) if (s.blockedBy.length && !seen.has(s.id)) walk(s, 0);
  return out;
}

/** Where activity turns into a problem. */
export interface DbThresholds {
  idleTxSec: number;
  lockWaitSec: number;
  replLagSec: number;
  connPct: number;
  cacheHitPct: number;
}

export const DEFAULT_DB_THRESHOLDS: DbThresholds = { idleTxSec: 60, lockWaitSec: 10, replLagSec: 5, connPct: 80, cacheHitPct: 95 };

export type DbProblemKind = "idleTx" | "lockWait" | "replLag" | "conns" | "cacheHit";

export interface DbProblem {
  kind: DbProblemKind;
  level: "warn" | "bad";
  value: number;
  session?: DbSession;
  /** How many wait on that session, for "holds N". */
  waiting?: number;
  replica?: string;
}

/** What needs attention, worst first. */
export function dbProblems(a: Activity, th: DbThresholds): DbProblem[] {
  const out: DbProblem[] = [];
  const waitersOf = (id: string) => a.sessions.filter((s) => s.blockedBy.includes(id)).length;
  for (const s of a.sessions) {
    const held = s.state === "idleTx" || s.state === "idleTxAborted" ? (s.xactS ?? s.stateS ?? 0) : 0;
    if (held >= th.idleTxSec) {
      const waiting = waitersOf(s.id);
      out.push({ kind: "idleTx", level: waiting > 0 || held >= th.idleTxSec * 5 ? "bad" : "warn", value: held, session: s, waiting });
    }
    if (s.blockedBy.length && (s.queryS ?? 0) >= th.lockWaitSec) out.push({ kind: "lockWait", level: (s.queryS ?? 0) >= th.lockWaitSec * 6 ? "bad" : "warn", value: s.queryS ?? 0, session: s });
  }
  for (const r of a.replicas ?? []) {
    if (r.lagS !== null && r.lagS >= th.replLagSec) out.push({ kind: "replLag", level: r.lagS >= th.replLagSec * 6 ? "bad" : "warn", value: r.lagS, replica: r.name || r.client });
  }
  if (a.replica && a.replayLagS !== null && a.replayLagS >= th.replLagSec) out.push({ kind: "replLag", level: a.replayLagS >= th.replLagSec * 6 ? "bad" : "warn", value: a.replayLagS });
  if (a.conns !== null && a.maxConns) {
    const pct = Math.round((100 * a.conns) / a.maxConns);
    if (pct >= th.connPct) out.push({ kind: "conns", level: pct >= 95 ? "bad" : "warn", value: pct });
  }
  if (a.hitPct !== null && a.hitPct < th.cacheHitPct) out.push({ kind: "cacheHit", level: a.hitPct < th.cacheHitPct - 10 ? "bad" : "warn", value: a.hitPct });
  const rank = (p: DbProblem) => (p.level === "bad" ? 0 : 1);
  return out.sort((x, y) => rank(x) - rank(y) || y.value - x.value);
}

/** Stop a session's statement, or end the session. */
export function cancelSql(kind: DbKind, id: string): string {
  const n = /^\d+$/.test(id) ? id : "0";
  return kind === "postgres" ? `SELECT pg_cancel_backend(${n})` : `KILL QUERY ${n}`;
}

export function terminateSql(kind: DbKind, id: string): string {
  const n = /^\d+$/.test(id) ? id : "0";
  return kind === "postgres" ? `SELECT pg_terminate_backend(${n})` : `KILL ${n}`;
}

/** Whether a session to stop was there: PostgreSQL answers false rather than failing. */
export const stopReached = (kind: DbKind, o: DbOutcome): boolean => kind === "mysql" || o.rows[0]?.[0] !== "f";
