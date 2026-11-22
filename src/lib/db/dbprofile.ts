// Database profiles (ADR 0080): what a new one starts as, how one is named,
// what a container of the Docker panel suggests, and the console command the
// user's own client runs in the terminal — never with the password in it.

import type { DbKind, DbProfile } from "../types";

export const DEFAULT_PORT: Record<DbKind, number> = { postgres: 5432, mysql: 3306 };

/** A new profile of `kind`: the server's own loopback, the usual port. */
export function newProfile(kind: DbKind, id: string): DbProfile {
  return {
    id,
    name: "",
    kind,
    host: "127.0.0.1",
    port: DEFAULT_PORT[kind],
    database: kind === "postgres" ? "postgres" : "",
    user: kind === "postgres" ? "postgres" : "root",
    hasSavedPassword: false,
    readOnly: false,
    container: null,
  };
}

/** The name a profile is shown by: its own, else its database, else its address. */
export function profileTitle(p: DbProfile): string {
  return p.name.trim() || p.database.trim() || `${p.host}:${p.port}`;
}

/** Where it is, in one line: `postgres · 127.0.0.1:5432`. */
export function profileAddress(p: DbProfile): string {
  const where = p.host.startsWith("/") ? p.host : `${p.host}:${p.port}`;
  return `${p.kind === "postgres" ? "PostgreSQL" : "MySQL"} · ${where}`;
}

/** Whether an address is this computer's own: its loopback or a socket (decided again by the backend). */
export function isThisComputer(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h.startsWith("/") || h === "localhost" || h === "::1") return true;
  const octets = h.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((o) => /^(0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255);
}

/** What is wrong with a profile the form holds; null — nothing. `here` — a database of this computer. */
export type ProfileIssue = "host" | "port" | "user" | "name" | "notLocal" | "container";
export function profileIssue(p: DbProfile, here = false): ProfileIssue | null {
  const oneLine = (v: string) => !/[\r\n\0]/.test(v);
  // A leading `-` would be an option of the user's own client.
  const value = (v: string) => oneLine(v) && !v.trim().startsWith("-");
  const host = p.host.trim();
  if (!host || !value(p.host) || (!host.startsWith("/") && /\s/.test(host))) return "host";
  if (here && !isThisComputer(host)) return "notLocal";
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) return "port";
  if (!p.user.trim() || !value(p.user)) return "user";
  if (!oneLine(p.name) || !value(p.database)) return "name";
  if (p.container !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p.container)) return "container";
  return null;
}

/** What the Docker panel knows of a container — enough to suggest a profile. */
export interface ContainerSeen {
  name: string;
  image: string;
  /** Its address on its network, if it has one. */
  ip: string | null;
  /** Ports it publishes on the host: container port → host port. */
  published: Record<number, number>;
  /** The host's address each is published on; absent — every address. */
  bound?: Record<number, string>;
  /** Its environment's names and the values of names that are not secrets. */
  env: Record<string, string>;
}

/** Which database an image runs, if it is one vterm speaks to. */
export function kindOfImage(image: string): DbKind | null {
  // The last part first: a registry's port is a colon too.
  const name = (image.toLowerCase().split("@")[0].split("/").pop() ?? "").split(":")[0];
  // What stands beside a database is not one.
  if (/exporter|operator|backup|postgrest|toolkit|router|proxy|client|myadmin|adminer/.test(name)) return null;
  if (/^(postgres|postgis|timescaledb|timescaledb-ha|pgvector|supabase-postgres|citus|cloudnative-pg)/.test(name)) return "postgres";
  if (/^(mysql|mariadb|percona|percona-server|mysql-server)/.test(name)) return "mysql";
  return null;
}

/** The address a port published on `bound` answers the host itself at. */
function loopbackFor(bound: string | undefined): string {
  if (!bound || bound === "0.0.0.0") return "127.0.0.1";
  const plain = bound.replace(/^\[|\]$/g, "");
  return plain === "::" ? "127.0.0.1" : plain;
}

/**
 * A profile for a database container, as the server reaches it: its published
 * port on the host's loopback when it has one, else its own address. The user
 * from its environment (`POSTGRES_USER`, `MYSQL_USER`) — the password never.
 */
export function profileFromContainer(c: ContainerSeen, id: string): DbProfile | null {
  const kind = kindOfImage(c.image);
  if (!kind) return null;
  const inner = DEFAULT_PORT[kind];
  const published = c.published[inner];
  // With neither a port nor an address it shares the host's network, or is
  // stopped: the host's loopback, for the form to correct.
  const host = published ? loopbackFor(c.bound?.[inner]) : (c.ip ?? "127.0.0.1");
  const user =
    kind === "postgres"
      ? c.env.POSTGRES_USER || "postgres"
      : c.env.MYSQL_USER || c.env.MARIADB_USER || "root";
  const database =
    kind === "postgres"
      ? c.env.POSTGRES_DB || c.env.POSTGRES_USER || "postgres"
      : c.env.MYSQL_DATABASE || c.env.MARIADB_DATABASE || "";
  return {
    ...newProfile(kind, id),
    name: c.name,
    host,
    port: published ?? inner,
    user,
    database,
    container: c.name,
  };
}

/**
 * The console the user's own client opens in the terminal: `psql` / `mysql`
 * against the profile's address — or inside its container. The client asks
 * the password itself; it is never on the command line.
 */
export function consoleArgv(p: DbProfile): string[] {
  const client =
    p.kind === "postgres"
      ? ["psql", "-U", p.user, ...(p.database ? ["-d", p.database] : [])]
      : ["mysql", "-u", p.user, "-p", ...(p.database ? [p.database] : [])];
  if (p.container) return ["docker", "exec", "-it", p.container, ...client];
  const at =
    p.kind === "postgres"
      ? ["-h", p.host, ...(p.host.startsWith("/") ? [] : ["-p", String(p.port)])]
      : p.host.startsWith("/")
        ? [`--socket=${p.host}`]
        : ["-h", p.host, "-P", String(p.port)];
  return [client[0], ...at, ...client.slice(1)];
}
