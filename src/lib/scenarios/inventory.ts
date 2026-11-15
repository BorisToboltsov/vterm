// The hosts of an Ansible project (ADR 0071): read from what `ansible-inventory
// --list` answers — the inventory as Ansible itself sees it, with group_vars,
// ranges and plugins — or, where Ansible is not installed, from an INI file by
// hand (named as such); matched to the servers of the catalog, so a prod server
// is known whichever way it was written; and the servers picked from the catalog
// written as a temporary inventory. Pure.
import type { ServerProfile } from "../types";
import { isProdServer } from "../ai/aiexec";
import { defaultLoginId, loginById, serverLogins } from "../servers/logins";

export interface InvHost {
  name: string;
  /** Where Ansible connects: `ansible_host`, else the name. */
  address: string;
  port: number | null;
  user: string | null;
}

export interface Inventory {
  /** Group → its hosts (direct and through children), in the order read. */
  groups: { name: string; hosts: string[] }[];
  hosts: InvHost[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

/**
 * The answer of `ansible-inventory --list`: `_meta.hostvars` and groups with
 * `hosts`/`children`. Null when the text is not that.
 */
export function parseInventoryJson(text: string): Inventory | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const root = doc as Record<string, { hosts?: unknown; children?: unknown; hostvars?: unknown }>;
  const hostvars = (root._meta?.hostvars ?? {}) as Record<string, Record<string, unknown>>;
  const direct = (g: string): string[] => (Array.isArray(root[g]?.hosts) ? (root[g].hosts as unknown[]).filter((h): h is string => typeof h === "string") : []);
  const children = (g: string): string[] =>
    Array.isArray(root[g]?.children) ? (root[g].children as unknown[]).filter((c): c is string => typeof c === "string") : [];
  const all = (g: string, seen = new Set<string>()): string[] => {
    if (seen.has(g)) return [];
    seen.add(g);
    const out = [...direct(g)];
    for (const c of children(g)) for (const h of all(c, seen)) if (!out.includes(h)) out.push(h);
    return out;
  };
  const groupNames = Object.keys(root).filter((k) => k !== "_meta" && k !== "all");
  const groups = groupNames.map((name) => ({ name, hosts: all(name) })).filter((g) => g.hosts.length > 0);
  const names: string[] = [];
  for (const g of [...groups, { name: "all", hosts: all("all") }]) for (const h of g.hosts) if (!names.includes(h)) names.push(h);
  for (const h of Object.keys(hostvars)) if (!names.includes(h)) names.push(h);
  const hosts = names.map((name) => {
    const v = hostvars[name] ?? {};
    return { name, address: str(v.ansible_host) ?? name, port: num(v.ansible_port), user: str(v.ansible_user) };
  });
  return { groups, hosts };
}

/** `web[01:03]` → web01, web02, web03; `db-[a:c]` → db-a, db-b, db-c. */
export function expandRange(pattern: string): string[] {
  const m = /^(.*?)\[([0-9]+|[a-z]):([0-9]+|[a-z])\](.*)$/.exec(pattern);
  if (!m) return [pattern];
  const [, head, from, to, tail] = m;
  const out: string[] = [];
  if (/^\d+$/.test(from) && /^\d+$/.test(to)) {
    const width = from.length;
    for (let i = Number(from); i <= Number(to) && out.length < 1000; i++) out.push(`${head}${String(i).padStart(width, "0")}${tail}`);
  } else if (/^[a-z]$/.test(from) && /^[a-z]$/.test(to)) {
    for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) out.push(`${head}${String.fromCharCode(c)}${tail}`);
  } else return [pattern];
  return out.flatMap(expandRange);
}

/** `key=value key="a b"` → pairs. */
function hostVars(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g)) {
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * An INI inventory read by hand — for a project whose host has no Ansible:
 * groups, `:children`, `:vars` of `ansible_host`/`ansible_port`/`ansible_user`,
 * ranges. What Ansible would add (group_vars, plugins) is not known here.
 */
export function parseIniInventory(text: string): Inventory {
  const direct = new Map<string, string[]>();
  const kids = new Map<string, string[]>();
  const vars = new Map<string, Record<string, string>>();
  const groupVars = new Map<string, Record<string, string>>();
  const order: string[] = [];
  let section = "ungrouped";
  let kind: "hosts" | "children" | "vars" = "hosts";
  const touch = (g: string) => {
    if (!direct.has(g)) {
      direct.set(g, []);
      order.push(g);
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, "").trim();
    if (!line) continue;
    const sec = /^\[([^\]:]+)(?::(children|vars))?\]$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      kind = (sec[2] as "children" | "vars" | undefined) ?? "hosts";
      touch(section);
      continue;
    }
    if (kind === "children") {
      kids.set(section, [...(kids.get(section) ?? []), line.split(/\s+/)[0]]);
      continue;
    }
    if (kind === "vars") {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (kv) groupVars.set(section, { ...(groupVars.get(section) ?? {}), [kv[1]]: kv[2].replace(/^["']|["']$/g, "") });
      continue;
    }
    touch(section);
    const [first, ...rest] = line.split(/\s+/);
    for (const name of expandRange(first)) {
      direct.get(section)!.push(name);
      vars.set(name, { ...(vars.get(name) ?? {}), ...hostVars(rest.join(" ")) });
    }
  }
  const all = (g: string, seen = new Set<string>()): string[] => {
    if (seen.has(g)) return [];
    seen.add(g);
    const out = [...(direct.get(g) ?? [])];
    for (const c of kids.get(g) ?? []) for (const h of all(c, seen)) if (!out.includes(h)) out.push(h);
    return out;
  };
  const groups = order.map((name) => ({ name, hosts: all(name) })).filter((g) => g.hosts.length > 0);
  // A group's vars reach its hosts and its children's, under a host's own.
  const inherited = (host: string): Record<string, string> => {
    const merged: Record<string, string> = {};
    for (const g of order) if (all(g).includes(host)) Object.assign(merged, groupVars.get(g) ?? {});
    return { ...merged, ...(vars.get(host) ?? {}) };
  };
  const names: string[] = [];
  for (const g of groups) for (const h of g.hosts) if (!names.includes(h)) names.push(h);
  const hosts = names.map((name) => {
    const v = inherited(name);
    return { name, address: v.ansible_host || name, port: num(v.ansible_port), user: v.ansible_user || null };
  });
  return { groups, hosts };
}

/**
 * The server of the catalog a host of the inventory is — by address and port
 * (22 when the inventory says none), else by its name being the server's alias.
 * Several of one address: the one with the same user. Null: not in the catalog.
 */
export function matchServer(host: InvHost, servers: readonly ServerProfile[]): ServerProfile | null {
  const addr = host.address.toLowerCase();
  const port = host.port ?? 22;
  const byAddr = servers.filter((s) => s.host.toLowerCase() === addr && s.port === port);
  if (byAddr.length === 1) return byAddr[0];
  // Any login of the server counts (ADR 0074): the inventory may name any of them.
  if (byAddr.length > 1)
    return byAddr.find((s) => host.user !== null && serverLogins(s).some((l) => l.username === host.user)) ?? byAddr[0];
  const byName = servers.filter((s) => s.alias.toLowerCase() === host.name.toLowerCase());
  return byName.length === 1 ? byName[0] : null;
}

/** Each host with its server of the catalog (or null) and whether that one is prod. */
export function matchInventory(inv: Inventory, servers: readonly ServerProfile[]) {
  return inv.hosts.map((h) => {
    const server = matchServer(h, servers);
    return { host: h, server, prod: isProdServer(server) };
  });
}

/** A host name for the generated inventory: the alias, in Ansible's characters. */
export function inventoryName(alias: string): string {
  const n = alias
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return n || "host";
}

/** A YAML double-quoted string. */
const yq = (v: string): string => JSON.stringify(v);

export interface CatalogInventory {
  /** The YAML of the inventory. */
  text: string;
  /** Inventory name of each server, by id. */
  names: Record<string, string>;
  /** Servers that sign in with a password: Ansible asks it (`-k`, sshpass on the host of the run). */
  asksPassword: string[];
}

/**
 * The servers picked from the catalog as an inventory (group `vterm`): address,
 * port, user; the key file and the jump host only when the run is on this
 * computer — their paths are this computer's. No password is ever written:
 * a server that signs in with one is asked for it by Ansible (`-k`).
 */
export function catalogInventory(picked: readonly ServerProfile[], local: boolean): CatalogInventory {
  const names: Record<string, string> = {};
  const taken = new Set<string>();
  const lines = ["# vterm: servers picked from the catalog for this run", "all:", "  children:", "    vterm:", "      hosts:"];
  const asksPassword: string[] = [];
  for (const s of picked) {
    let name = inventoryName(s.alias);
    for (let i = 2; taken.has(name); i++) name = `${inventoryName(s.alias)}-${i}`;
    taken.add(name);
    names[s.id] = name;
    // The default login of each server (ADR 0074): whom a plain connect logs in as.
    const login = loginById(s, defaultLoginId(s)) ?? serverLogins(s)[0];
    lines.push(`        ${name}:`, `          ansible_host: ${yq(s.host)}`, `          ansible_port: ${s.port}`, `          ansible_user: ${yq(login.username)}`);
    if (login.authMethod === "password") asksPassword.push(s.id);
    if (local && login.authMethod === "key" && login.keyPath) lines.push(`          ansible_ssh_private_key_file: ${yq(login.keyPath)}`);
    if (local && s.proxy?.kind === "jump") {
      const p = s.proxy;
      const jump = `${p.username}@${p.host}:${p.port}`;
      const args =
        p.authMethod === "key" && p.keyPath
          ? `-o ProxyCommand="ssh -i ${p.keyPath} -p ${p.port} -W %h:%p ${p.username}@${p.host}"`
          : `-o ProxyJump=${jump}`;
      lines.push(`          ansible_ssh_common_args: ${yq(args)}`);
    }
  }
  return { text: `${lines.join("\n")}\n`, names, asksPassword };
}
