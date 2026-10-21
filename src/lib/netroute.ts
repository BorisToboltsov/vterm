// Utilities → access check: which server checks what (v1.21, ADR 0032). A rule's
// source is no longer just a note to compare against: it names the server the
// check runs FROM. A source is matched against the servers the app knows — by
// name, by the address in the profile, by the addresses an open session reported
// (multi-homed hosts), by its hostname, a subnet by the servers inside it. A rule
// without a source runs from the servers picked above the table — the tab the
// tool was opened on, until the user picks others (v1.22, ADR 0033); a source no
// server matches runs from them too, and says so. A row can name its server by
// hand. Picking never moves a rule whose source names a server: the request asks
// for access from that one.
//
// From that: the run plan (rules per server, connects per server, servers that
// must be connected first) and the result matrix (target:port × server).
//
// Pure (INVARIANTS "чистая логика в .ts").

import {
  checkCount,
  cidrContains,
  egressDiffers,
  isCidr,
  isIpv4,
  MAX_CHECKS,
  parseCidr,
  rowsFor,
  serviceName,
  tally,
  type NetReport,
  type NetRule,
  type PortStatus,
  type Proto,
} from "./netcheck";

/** A server (or this machine) that can run checks. */
export interface NetHost {
  /** "local", or the profile's address — the key history and probe methods use. */
  key: string;
  /** The profile's alias; "" for this machine (the UI names it). */
  name: string;
  kind: "ssh" | "local";
  serverId: string | null;
  /** The profile's address ("" for this machine). */
  address: string;
  /** An open session to it: live, or still connecting. */
  sessionId: string | null;
  live: boolean;
  connecting: boolean;
  isProd: boolean;
  /** A tab to it is open — live, connecting or not: it gets a chip to pick. */
  hasTab: boolean;
}

/** What a live session reported about its host (the identity probe). */
export interface HostFacts {
  hostname: string;
  /** Visible addresses only — no loopback, no link-local: every host has those. */
  addrs: string[];
}

/** The fields of a server profile this module reads. */
export interface HostServer {
  id: string;
  alias: string;
  host: string;
  isProd: boolean;
}

/** The fields of a tab this module reads. */
export interface HostTab {
  sessionId: string;
  kind: "ssh" | "local";
  serverId: string;
  live: boolean;
  connecting: boolean;
}

export const LOCAL_KEY = "local";

/** The key a tab's checks are filed under — the server's address, or "local". */
export function hostKeyOf(tab: Pick<HostTab, "kind" | "serverId">, servers: readonly HostServer[]): string {
  if (tab.kind === "local") return LOCAL_KEY;
  return servers.find((s) => s.id === tab.serverId)?.host ?? "";
}

/**
 * Every place a check can run from: this machine (when a local tab is open) and
 * every server in the catalog, with its session if a tab to it is open — the
 * tab the tool was opened on first, then a live one, then one still connecting.
 * Two profiles of one address are one host (the first with a session wins).
 */
export function buildHosts(
  servers: readonly HostServer[],
  tabs: readonly HostTab[],
  homeSession: string | null = null,
): NetHost[] {
  const pick = (cands: HostTab[]) =>
    cands.find((t) => t.sessionId === homeSession) ??
    cands.find((t) => t.live) ??
    cands.find((t) => t.connecting) ??
    null;
  const out: NetHost[] = [];
  const locals = tabs.filter((t) => t.kind === "local");
  const local = pick(locals);
  if (locals.length) {
    out.push({
      key: LOCAL_KEY,
      name: "",
      kind: "local",
      serverId: null,
      address: "",
      sessionId: local?.sessionId ?? null,
      live: !!local?.live,
      connecting: !!local?.connecting && !local.live,
      isProd: false,
      hasTab: true,
    });
  }
  const byKey = new Map<string, NetHost>();
  for (const srv of servers) {
    if (!srv.host) continue;
    const own = tabs.filter((t) => t.kind === "ssh" && t.serverId === srv.id);
    const tab = pick(own);
    const host: NetHost = {
      key: srv.host,
      name: srv.alias,
      kind: "ssh",
      serverId: srv.id,
      address: srv.host,
      sessionId: tab?.sessionId ?? null,
      live: !!tab?.live,
      connecting: !!tab?.connecting && !tab.live,
      isProd: srv.isProd,
      hasTab: own.length > 0,
    };
    const seen = byKey.get(srv.host);
    if (!seen) {
      byKey.set(srv.host, host);
      out.push(host);
    } else {
      // One address, one chip: the tab of either profile counts.
      const merged = !seen.sessionId && host.sessionId ? host : seen;
      merged.hasTab = seen.hasTab || host.hasTab;
      if (merged !== seen) {
        out[out.indexOf(seen)] = merged;
        byKey.set(srv.host, merged);
      }
    }
  }
  return out;
}

/** How a source found its server. */
export type MatchHow = "name" | "address" | "hostname" | "subnet";

/**
 * The hosts a rule's source names: by alias, by the profile's address, by an
 * address a session reported, by hostname (or its first label), a subnet by
 * every host with an address inside it.
 */
export function sourceHosts(
  source: string,
  hosts: readonly NetHost[],
  facts: Readonly<Record<string, HostFacts>>,
): { host: NetHost; how: MatchHow }[] {
  const s = source.trim().toLowerCase();
  if (!s) return [];
  const net = parseCidr(s);
  const out: { host: NetHost; how: MatchHow }[] = [];
  for (const host of hosts) {
    const f = host.sessionId ? facts[host.sessionId] : undefined;
    const addrs = [...(isIpv4(host.address) ? [host.address] : []), ...(f?.addrs ?? [])];
    let how: MatchHow | null = null;
    if (net) {
      if (addrs.some((a) => cidrContains(net, a))) how = "subnet";
    } else if (host.name && host.name.toLowerCase() === s) how = "name";
    else if (host.address.toLowerCase() === s || addrs.includes(s)) how = "address";
    else if (f?.hostname) {
      const hn = f.hostname.toLowerCase();
      if (hn === s || hn.split(".")[0] === s) how = "hostname";
    }
    if (how) out.push({ host, how });
  }
  return out;
}

/**
 * picked — no source: the servers picked above the table. source — the source
 * named a server. fallback — no server matches the source, so it runs from the
 * picked servers (the answer may not be the one asked for). override — the row
 * names its server by hand.
 */
export type RouteHow = "picked" | "source" | "fallback" | "override";

export interface RowRoute {
  /** Host keys, in the order the row's sources name them; empty when the row
   *  goes to the picked servers and none is picked. */
  hosts: string[];
  how: RouteHow;
  /** Sources no server matched. */
  unmatched: string[];
}

/** One row of the rules table as planning sees it: its rules and its pick. */
export interface PlanRow {
  rules: NetRule[];
  /** The host key picked by hand, or null to go by the source. */
  via: string | null;
}

/** The picked keys that name a known host, in the order given. */
function pickedHosts(picked: readonly string[], hosts: readonly NetHost[]): string[] {
  return picked.filter((k, i) => picked.indexOf(k) === i && hosts.some((h) => h.key === k));
}

/** Where one rule runs: the servers its source names, else the picked ones. */
function ruleHosts(
  rule: NetRule,
  hosts: readonly NetHost[],
  facts: Readonly<Record<string, HostFacts>>,
  picked: readonly string[],
): { keys: string[]; matched: boolean } {
  if (!rule.source) return { keys: pickedHosts(picked, hosts), matched: false };
  const found = sourceHosts(rule.source, hosts, facts).map((m) => m.host.key);
  return found.length ? { keys: found, matched: true } : { keys: pickedHosts(picked, hosts), matched: false };
}

/** Where one row's rules run. `picked` — the servers picked above the table. */
export function routeRow(
  row: PlanRow,
  hosts: readonly NetHost[],
  facts: Readonly<Record<string, HostFacts>>,
  picked: readonly string[],
): RowRoute {
  if (row.via && hosts.some((h) => h.key === row.via)) return { hosts: [row.via], how: "override", unmatched: [] };
  const keys: string[] = [];
  const unmatched: string[] = [];
  let how: RouteHow = "picked";
  for (const rule of row.rules) {
    const r = ruleHosts(rule, hosts, facts, picked);
    for (const k of r.keys) if (!keys.includes(k)) keys.push(k);
    if (r.matched) how = how === "fallback" ? "fallback" : "source";
    else if (rule.source) {
      unmatched.push(rule.source);
      how = "fallback";
    }
  }
  return { hosts: keys, how, unmatched };
}

/** One server's part of a run. */
export interface HostPlan {
  host: NetHost;
  rules: NetRule[];
  /** Connects it makes — what the cap is about. */
  checks: number;
  /** A subnet among its targets: the run asks first. */
  subnet: boolean;
}

export interface RunPlan {
  /** Servers with a live session, in the order rules first name them. */
  ready: HostPlan[];
  /** Servers rules route to that have no live session yet. */
  waiting: HostPlan[];
  /** Ready servers over the cap: the run doesn't start until they're under it. */
  overCap: HostPlan[];
  /** Rules with nowhere to run: no source and no server picked. The run
   *  doesn't start — they'd be silently left out. */
  unrouted: number;
  routes: RowRoute[];
}

/**
 * The run: each row's rules filed under the servers they route to. A rule with
 * several matching servers (a subnet source, or several picked) goes to each; a
 * source that names one server out of several rules goes only there.
 */
export function planRun(
  rows: readonly PlanRow[],
  hosts: readonly NetHost[],
  facts: Readonly<Record<string, HostFacts>>,
  picked: readonly string[],
): RunPlan {
  const routes = rows.map((r) => routeRow(r, hosts, facts, picked));
  const plans = new Map<string, HostPlan>();
  let unrouted = 0;
  rows.forEach((row, i) => {
    const route = routes[i];
    for (const rule of row.rules) {
      // A rule goes to the servers its own source names (or the picked ones),
      // unless the row picked its server: a two-source row doesn't cross its
      // servers.
      const keys = route.how === "override" ? route.hosts : ruleHosts(rule, hosts, facts, picked).keys;
      if (keys.length === 0) unrouted += 1;
      for (const key of keys) {
        const host = hosts.find((h) => h.key === key);
        if (!host) continue;
        const plan = plans.get(key) ?? { host, rules: [], checks: 0, subnet: false };
        plan.rules.push(rule);
        plans.set(key, plan);
      }
    }
  });
  const all = [...plans.values()];
  for (const p of all) {
    p.checks = checkCount(p.rules);
    p.subnet = p.rules.some((r) => r.proto === "tcp" && r.targets.some(isCidr));
  }
  const ready = all.filter((p) => p.host.live && p.host.sessionId);
  return {
    ready: ready.filter((p) => p.checks <= MAX_CHECKS),
    overCap: ready.filter((p) => p.checks > MAX_CHECKS),
    waiting: all.filter((p) => !(p.host.live && p.host.sessionId)),
    unrouted,
    routes,
  };
}

// ── Result matrix ────────────────────────────────────────────────────────────

/** One server's answer for one target:port. */
export interface MatrixCell {
  status: PortStatus;
  ms: number | null;
  detail: string;
  /** The address the route leaves from, and whether a firewall rule for the
   *  rule's source would miss it. */
  egress: { src: string; differs: boolean } | null;
}

/** A subnet's answers on one port from one server. */
export interface SubnetCell {
  open: { host: string; ms: number | null }[];
  counts: Partial<Record<PortStatus, number>>;
  total: number;
}

export interface MatrixRow {
  port: number;
  service: string;
  /** Per column; null = this server wasn't asked. */
  cells: (MatrixCell | null)[];
  /** Per column, for a subnet target. */
  subnet: (SubnetCell | null)[] | null;
}

export interface MatrixGroup {
  /** As written: a host, an address or a subnet. */
  target: string;
  proto: Proto;
  labels: string[];
  /** What the name resolved to, per column ("" = didn't resolve). */
  resolved: (string | null)[];
  isSubnet: boolean;
  rows: MatrixRow[];
}

/** A column: one server's run. */
export interface MatrixColumn {
  key: string;
  rules: NetRule[];
  report: NetReport | null;
}

/**
 * The results as target:port × server. Groups keep the order targets first
 * appear in; a target several servers checked is one group with a cell each.
 */
export function buildMatrix(columns: readonly MatrixColumn[]): MatrixGroup[] {
  const groups: MatrixGroup[] = [];
  const find = (target: string, proto: Proto) => groups.find((g) => g.target === target && g.proto === proto);
  for (const col of columns) {
    for (const rule of col.rules) {
      for (const target of rule.targets) {
        let g = find(target, rule.proto);
        if (!g) {
          g = {
            target,
            proto: rule.proto,
            labels: [],
            resolved: columns.map(() => null),
            isSubnet: isCidr(target),
            rows: [],
          };
          groups.push(g);
        }
        if (rule.label && !g.labels.includes(rule.label)) g.labels.push(rule.label);
        for (const port of rule.ports) {
          if (!g.rows.some((r) => r.port === port)) {
            g.rows.push({
              port,
              service: serviceName(port),
              cells: columns.map(() => null),
              subnet: g.isSubnet ? columns.map(() => null) : null,
            });
          }
        }
      }
    }
  }
  columns.forEach((col, c) => {
    for (const g of groups) {
      const rules = col.rules.filter((r) => r.proto === g.proto && r.targets.includes(g.target));
      if (rules.length === 0) continue;
      if (col.report && !g.isSubnet && g.target in col.report.resolved) g.resolved[c] = col.report.resolved[g.target];
      for (const row of g.rows) {
        const rule = rules.find((r) => r.ports.includes(row.port));
        if (!rule) continue;
        const results = rowsFor({ ...rule, ports: [row.port] }, g.target, col.report);
        if (g.isSubnet) {
          const counts: Partial<Record<PortStatus, number>> = {};
          for (const r of results) if (r.status !== "open") counts[r.status] = (counts[r.status] ?? 0) + 1;
          row.subnet![c] = {
            open: results.filter((r) => r.status === "open").map((r) => ({ host: r.host, ms: r.ms })),
            counts,
            total: results.length,
          };
          continue;
        }
        const r = results[0];
        const src = col.report?.routeSrc[g.target];
        row.cells[c] = {
          status: r.status,
          ms: r.ms,
          detail: r.detail,
          egress: src && col.report ? { src, differs: egressDiffers(rule.source, g.target, col.report) } : null,
        };
      }
    }
  });
  return groups;
}

/** Open / checked over everything a column asked — its header's count. */
export function columnTally(col: MatrixColumn): { open: number; checked: number } {
  return tally(col.rules.flatMap((rule) => rule.targets.flatMap((t) => rowsFor(rule, t, col.report))));
}

/** A subnet's hosts on one port that didn't open, every one, for the expanded view. */
export function subnetMisses(
  col: MatrixColumn,
  target: string,
  port: number,
): { host: string; status: PortStatus; ms: number | null; detail: string }[] {
  const rule = col.rules.find((r) => r.targets.includes(target) && r.ports.includes(port));
  if (!rule) return [];
  return rowsFor({ ...rule, ports: [port] }, target, col.report)
    .filter((r) => r.status !== "open")
    .map((r) => ({ host: r.host, status: r.status, ms: r.ms, detail: r.detail }));
}
