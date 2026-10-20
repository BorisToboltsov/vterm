// What a backup import writes (v1.20). The backend shows what a backup holds
// (`read_backup`) and writes the catalog it is given (`import_backup`); how the
// backup's servers are changed on the way is decided here:
//  - logins and key paths are replaced by value, across every server and jump
//    host that uses them — a backup made for someone else carries the logins
//    and the home directory of whoever exported it. A value left empty stays;
//  - "saved password" is true only where this keychain holds a secret for that
//    server: secrets are kept by server id and never travel with a backup;
//  - the servers replace the current ones, or are added to them. Added, a
//    server already here — the same id, or the same host, port and login — is
//    skipped: the user's own profile, with its keychain entry, is not touched.

import type { ImportCatalog } from "./api/servers";
import type { ServerProfile } from "./types";

export type ImportMode = "replace" | "merge";

/** A value used in the backup's servers (a login or a key path) and by how many. */
export interface UsageRow {
  value: string;
  /** Servers that use it themselves. */
  servers: number;
  /** Servers whose jump host uses it. */
  jumps: number;
}

function usage(
  servers: readonly ServerProfile[],
  own: (s: ServerProfile) => string | null,
  jump: (s: ServerProfile) => string | null,
): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  const row = (value: string) => {
    let r = rows.get(value);
    if (!r) rows.set(value, (r = { value, servers: 0, jumps: 0 }));
    return r;
  };
  for (const s of servers) {
    const a = own(s);
    if (a) row(a).servers++;
    const b = jump(s);
    if (b) row(b).jumps++;
  }
  // The most used first: that is the login the backup was made with.
  return [...rows.values()].sort(
    (x, y) => y.servers + y.jumps - (x.servers + x.jumps) || x.value.localeCompare(y.value),
  );
}

const present = (v: string | null | undefined): string | null => (v && v.trim() !== "" ? v : null);

/** The logins of the backup's servers and jump hosts. */
export const loginRows = (servers: readonly ServerProfile[]): UsageRow[] =>
  usage(
    servers,
    (s) => present(s.username),
    (s) => present(s.proxy?.username),
  );

/** The key paths of the backup's servers and jump hosts. */
export const keyPathRows = (servers: readonly ServerProfile[]): UsageRow[] =>
  usage(
    servers,
    (s) => present(s.keyPath),
    (s) => present(s.proxy?.keyPath),
  );

/** Replacements by original value; an empty or missing replacement leaves it. */
export type Remap = Readonly<Record<string, string>>;

function replaced(value: string, remap: Remap): string {
  const next = remap[value]?.trim();
  return next ? next : value;
}

const replacedPath = (value: string | null, remap: Remap): string | null =>
  value === null || value.trim() === "" ? value : replaced(value, remap);

/**
 * The backup's servers with logins and key paths replaced, and the saved
 * password hint set from this machine: kept where a current server of the same
 * id has it (the keychain holds secrets by id), false everywhere else.
 */
export function remapServers(
  servers: readonly ServerProfile[],
  logins: Remap,
  keys: Remap,
  current: readonly ServerProfile[],
): ServerProfile[] {
  const here = new Map(current.map((s) => [s.id, s]));
  return servers.map((s) => {
    const mine = here.get(s.id);
    return {
      ...s,
      username: s.username.trim() === "" ? s.username : replaced(s.username, logins),
      keyPath: replacedPath(s.keyPath, keys),
      hasSavedPassword: mine?.hasSavedPassword ?? false,
      proxy: s.proxy
        ? {
            ...s.proxy,
            username:
              s.proxy.username.trim() === "" ? s.proxy.username : replaced(s.proxy.username, logins),
            keyPath: replacedPath(s.proxy.keyPath, keys),
            hasSavedPassword: mine?.proxy?.hasSavedPassword ?? false,
          }
        : null,
    };
  });
}

/** One server, as far as "already here" goes: where it connects and as whom. */
const endpoint = (s: ServerProfile): string =>
  `${s.host.trim().toLowerCase()}\n${s.port}\n${s.username.trim()}`;

/** The catalog an import writes, and what it does to the current one. */
export interface ImportPlan {
  catalog: ImportCatalog;
  /** Servers of the backup that are written. */
  added: number;
  /** Servers of the backup skipped as already here (adding only). */
  skipped: number;
  /** Current servers the import removes (replacing only). */
  removed: number;
}

/**
 * The catalog to write: the backup's servers (already remapped) in place of
 * the current ones, or after them without those already here.
 */
export function planImport(
  mode: ImportMode,
  current: readonly ServerProfile[],
  currentFolders: readonly string[],
  incoming: readonly ServerProfile[],
  incomingFolders: readonly string[],
): ImportPlan {
  if (mode === "replace") {
    return {
      catalog: { servers: [...incoming], folders: [...incomingFolders] },
      added: incoming.length,
      skipped: 0,
      removed: current.length,
    };
  }
  const ids = new Set(current.map((s) => s.id));
  const endpoints = new Set(current.map(endpoint));
  const fresh = incoming.filter((s) => !ids.has(s.id) && !endpoints.has(endpoint(s)));
  return {
    catalog: {
      servers: [...current, ...fresh],
      folders: [...new Set([...currentFolders, ...incomingFolders])].sort(),
    },
    added: fresh.length,
    skipped: incoming.length - fresh.length,
    removed: 0,
  };
}
