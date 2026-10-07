// Pure connectivity logic for the Docker panel's "Networks & volumes" sub-tab
// (v1.5): what a published port is reachable from, who shares a network with
// whom, and the layout of the membership graph. DOM/network free, like docker.ts,
// whose `ps` and `network ls` snapshots are all it reads — no extra call.
//
// Two things here are deliberately modest. A port token this file does not
// recognize is kept verbatim (`kind: "raw"`), never dropped: docker's own string
// is more useful than a hole. And a shared network is reported as "can reach in
// principle", never as "connected" — the graph knows membership, not whether
// anything listens.

import { isRunning, type DockerContainer, type DockerNetwork } from "./docker";

// ── Published ports ──────────────────────────────────────────────────────────

/**
 * Where a published port accepts connections from: every interface of the host,
 * loopback only, or one specific host address. `0.0.0.0:5432` and
 * `127.0.0.1:5432` read alike in `docker ps` and mean the opposite.
 */
export type PortReach = "all" | "loopback" | "address";

/** One token of docker's `Ports` field, as printed. */
export interface DockerPort {
  /** The token exactly as docker printed it. */
  raw: string;
  /** `published` is mapped to the host, `exposed` is declared only, `raw` is unrecognized. */
  kind: "published" | "exposed" | "raw";
  /** Host address of a published port (brackets stripped), else "". */
  hostIp: string;
  /** Host port or range (`8080`, `8000-8002`), else "". */
  hostPort: string;
  /** Container port or range, "" when unrecognized. */
  containerPort: string;
  /** `tcp` · `udp` · `sctp`, "" when unrecognized. */
  proto: string;
}

const PORT = String.raw`\d+(?:-\d+)?`;
const PUBLISHED = new RegExp(String.raw`^(.+):(${PORT})->(${PORT})\/([a-z]+)$`);
const EXPOSED = new RegExp(String.raw`^(${PORT})\/([a-z]+)$`);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Host address of a published token, or null when it is not an address at all. */
function hostAddress(part: string): string | null {
  const bare = part.startsWith("[") && part.endsWith("]") ? part.slice(1, -1) : part;
  if (IPV4.test(bare)) return bare;
  // IPv6: `[::]:8080` on docker 29, `:::8080` on older daemons — the greedy host
  // group leaves `::` for both. Anything else with a colon is taken as IPv6 too.
  if (/^[0-9a-f:]+$/i.test(bare) && bare.includes(":")) return bare;
  return null;
}

/**
 * Parse docker's `Ports` field (`{{.Ports}}`, comma-separated tokens). Shapes
 * seen on a real daemon: `0.0.0.0:8080->80/tcp`, `[::]:8080->80/tcp` (older:
 * `:::8080->80/tcp`), `127.0.0.1:5432->5432/tcp`, `0.0.0.0:53->53/udp`, a range
 * `0.0.0.0:8000-8002->8000-8002/tcp`, and a declared-only `7000/tcp`. Whatever
 * else docker prints (a Swarm `*:80->80/tcp`, a format this file predates) comes
 * back as `raw` rather than vanishing.
 */
export function parsePorts(field: string): DockerPort[] {
  const out: DockerPort[] = [];
  for (const token of (field ?? "").split(",")) {
    const raw = token.trim();
    if (!raw) continue;
    const pub = PUBLISHED.exec(raw);
    const hostIp = pub ? hostAddress(pub[1]) : null;
    if (pub && hostIp !== null) {
      out.push({ raw, kind: "published", hostIp, hostPort: pub[2], containerPort: pub[3], proto: pub[4] });
      continue;
    }
    const exp = EXPOSED.exec(raw);
    if (exp) {
      out.push({ raw, kind: "exposed", hostIp: "", hostPort: "", containerPort: exp[1], proto: exp[2] });
      continue;
    }
    out.push({ raw, kind: "raw", hostIp: "", hostPort: "", containerPort: "", proto: "" });
  }
  return out;
}

/** Classify the host address a port is bound to. */
export function portReach(hostIp: string): PortReach {
  if (hostIp === "0.0.0.0" || hostIp === "::") return "all";
  if (hostIp.startsWith("127.") || hostIp === "::1") return "loopback";
  return "address";
}

/** One line of the ports list: a mapping with every host address it is bound to. */
export interface PortRow {
  kind: DockerPort["kind"];
  /** Host addresses of a published mapping (deduped, docker's order), else empty. */
  hostIps: string[];
  hostPort: string;
  containerPort: string;
  proto: string;
  /** Null unless published. */
  reach: PortReach | null;
  /** Docker's own text for the row — shown as is when `kind` is `raw`. */
  raw: string;
}

const single = (p: string): number | null => (/^\d+$/.test(p) ? Number(p) : null);
const lastOf = (p: string): number | null => single(p.split("-").at(-1) ?? "");
const firstOf = (p: string): string => p.split("-")[0];

/** Whether `next` continues `prev` as the following port of the same mapping. */
function continues(prev: PortRow, next: PortRow): boolean {
  if (prev.kind !== "published" || next.kind !== "published") return false;
  if (prev.proto !== next.proto || prev.reach !== next.reach) return false;
  if (prev.hostIps.join() !== next.hostIps.join()) return false;
  const host = single(next.hostPort);
  const inner = single(next.containerPort);
  if (host === null || inner === null) return false;
  return lastOf(prev.hostPort) === host - 1 && lastOf(prev.containerPort) === inner - 1;
}

/**
 * The `Ports` field as display rows. `-p 8080:80` is printed twice by docker
 * (IPv4 and IPv6), so mappings that differ only by host address of the same
 * reach collapse into one row; a published range, which docker 29 prints one
 * port at a time, folds back into `8000-8002 → 9000-9002`. Order is docker's.
 */
export function portRows(field: string): PortRow[] {
  const merged: PortRow[] = [];
  const byKey = new Map<string, PortRow>();
  for (const p of parsePorts(field)) {
    if (p.kind !== "published") {
      merged.push({
        kind: p.kind,
        hostIps: [],
        hostPort: "",
        containerPort: p.containerPort,
        proto: p.proto,
        reach: null,
        raw: p.raw,
      });
      continue;
    }
    const reach = portReach(p.hostIp);
    const key = `${p.hostPort}>${p.containerPort}/${p.proto}|${reach}`;
    const seen = byKey.get(key);
    if (seen) {
      if (!seen.hostIps.includes(p.hostIp)) seen.hostIps.push(p.hostIp);
      seen.raw += `, ${p.raw}`;
      continue;
    }
    const row: PortRow = {
      kind: "published",
      hostIps: [p.hostIp],
      hostPort: p.hostPort,
      containerPort: p.containerPort,
      proto: p.proto,
      reach,
      raw: p.raw,
    };
    byKey.set(key, row);
    merged.push(row);
  }

  const out: PortRow[] = [];
  for (const row of merged) {
    const prev = out.at(-1);
    if (prev && continues(prev, row)) {
      prev.hostPort = `${firstOf(prev.hostPort)}-${row.hostPort}`;
      prev.containerPort = `${firstOf(prev.containerPort)}-${row.containerPort}`;
      prev.raw += `, ${row.raw}`;
    } else {
      out.push({ ...row, hostIps: [...row.hostIps] });
    }
  }
  return out;
}

/** A container with the ports it publishes or declares. */
export interface ContainerPorts {
  container: DockerContainer;
  rows: PortRow[];
  /**
   * Whether the mappings are live. A stopped container prints no ports at all on
   * docker 29; a daemon that still prints them is describing configuration, and
   * nothing listens behind it.
   */
  live: boolean;
  /**
   * The container runs on the host's own network stack. It publishes nothing —
   * and listens on the host's interfaces all the same, which is exactly why it
   * belongs in a list of what is reachable: without it the list would be silently
   * incomplete.
   */
  hostMode: boolean;
}

/** Containers that have a port to show or sit on the host's network, in the order given. */
export function containerPorts(containers: readonly DockerContainer[]): ContainerPorts[] {
  const out: ContainerPorts[] = [];
  for (const container of containers) {
    const rows = portRows(container.ports);
    const hostMode = container.networks.includes(HOST_NETWORK);
    if (rows.length > 0 || hostMode) out.push({ container, rows, live: isRunning(container), hostMode });
  }
  return out;
}

// ── Network membership ───────────────────────────────────────────────────────

/** `--network host`: the container uses the host's stack — no mapping, no isolation. */
export const HOST_NETWORK = "host";
/** `--network none`: no network at all. */
export const NONE_NETWORK = "none";

/**
 * Whether `name` is a network containers can meet on. `host` and `none` are
 * modes docker lists among networks: two containers "in" `host` share the host,
 * not a network of their own, and two in `none` share nothing.
 */
export function isSharedNetwork(name: string): boolean {
  return name !== HOST_NETWORK && name !== NONE_NETWORK;
}

/**
 * Docker's built-in bridge. Containers on it reach each other by IP only — the
 * embedded DNS that resolves container names exists on user-defined networks,
 * not here — so "same network" promises even less than usual.
 */
export function isDefaultBridge(network: Pick<DockerNetwork, "name" | "driver">): boolean {
  return network.name === "bridge" && network.driver === "bridge";
}

const byName = (a: DockerContainer, b: DockerContainer) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Containers attached to each network, by network name, each list sorted by name. */
export function membersByNetwork(containers: readonly DockerContainer[]): Map<string, DockerContainer[]> {
  const out = new Map<string, DockerContainer[]>();
  for (const c of [...containers].sort(byName)) {
    for (const name of c.networks) {
      const list = out.get(name);
      if (list) list.push(c);
      else out.set(name, [c]);
    }
  }
  return out;
}

// ── Membership graph ─────────────────────────────────────────────────────────

/** Containers drawn before the graph says "and N more" — past this it is a hairball. */
export const GRAPH_MAX_CONTAINERS = 40;

export interface GraphNetwork {
  name: string;
  /** Row of the left column this network sits on. */
  row: number;
  /** Containers attached to it — all of them, drawn or not. */
  members: number;
}

export interface GraphContainer {
  id: string;
  name: string;
  state: string;
  /** Row of the right column. */
  row: number;
  /** The shared networks it is attached to (sorted). */
  networks: string[];
  /** `host` / `none` when the container runs in that mode instead of a network. */
  mode: typeof HOST_NETWORK | typeof NONE_NETWORK | null;
}

export interface GraphEdge {
  network: string;
  container: string;
  fromRow: number;
  toRow: number;
}

/** A bipartite membership graph: networks on the left, containers on the right. */
export interface NetGraph {
  networks: GraphNetwork[];
  containers: GraphContainer[];
  edges: GraphEdge[];
  /** Height of the taller column, in rows. */
  rows: number;
  /** Containers left out by the cap. */
  hidden: number;
}

/**
 * Lay the membership graph out as two sorted columns — deterministic, so a
 * three-second poll never makes it jump the way a force-directed layout would.
 *
 * Networks are sorted by name. Containers are ordered by the first network they
 * belong to, then by name, so a network's containers sit together and each
 * network is placed beside its own group: the common case — one network per
 * container — draws as separate fans with no crossing at all. A container on two
 * networks is one node with two edges, which is the thing a list cannot show.
 */
export function buildNetGraph(
  networks: readonly DockerNetwork[],
  containers: readonly DockerContainer[],
  max: number = GRAPH_MAX_CONTAINERS,
): NetGraph {
  const members = membersByNetwork(containers);
  const names = new Set<string>();
  for (const n of networks) if (isSharedNetwork(n.name)) names.add(n.name);
  // A network a container names but `network ls` did not list (the two commands
  // are separate snapshots) still gets its node — an edge to nowhere would not.
  for (const name of members.keys()) if (isSharedNetwork(name)) names.add(name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const index = new Map(sorted.map((name, i) => [name, i]));

  const shared = (c: DockerContainer) => c.networks.filter(isSharedNetwork);
  const primary = (c: DockerContainer) => {
    const own = shared(c);
    return own.length > 0 ? Math.min(...own.map((n) => index.get(n) ?? Infinity)) : Infinity;
  };
  const ordered = [...containers].sort((a, b) => {
    const pa = primary(a);
    const pb = primary(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return byName(a, b);
  });
  const drawn = ordered.slice(0, Math.max(0, max));

  const graphContainers: GraphContainer[] = drawn.map((c, row) => ({
    id: c.id,
    name: c.name,
    state: c.state,
    row,
    networks: shared(c),
    mode: c.networks.includes(HOST_NETWORK)
      ? HOST_NETWORK
      : c.networks.includes(NONE_NETWORK)
        ? NONE_NETWORK
        : null,
  }));

  // Each network sits at the middle of the containers that name it first; one
  // with no such group takes the next free row. Rows only ever move down, so two
  // networks never share one.
  const groupRows = new Map<number, number[]>();
  drawn.forEach((c, row) => {
    const p = primary(c);
    if (p === Infinity) return;
    const rows = groupRows.get(p);
    if (rows) rows.push(row);
    else groupRows.set(p, [row]);
  });
  const graphNetworks: GraphNetwork[] = [];
  let free = 0;
  sorted.forEach((name, i) => {
    const rows = groupRows.get(i);
    const wanted = rows ? Math.floor((rows[0] + rows[rows.length - 1]) / 2) : free;
    const row = Math.max(wanted, free);
    free = row + 1;
    graphNetworks.push({ name, row, members: members.get(name)?.length ?? 0 });
  });

  const rowOf = new Map(graphNetworks.map((n) => [n.name, n.row]));
  const edges: GraphEdge[] = [];
  for (const c of graphContainers) {
    for (const network of c.networks) {
      edges.push({ network, container: c.id, fromRow: rowOf.get(network)!, toRow: c.row });
    }
  }

  return {
    networks: graphNetworks,
    containers: graphContainers,
    edges,
    rows: Math.max(graphContainers.length, free),
    hidden: ordered.length - drawn.length,
  };
}

/** What the user picked in the graph. */
export type GraphPick = { kind: "network"; name: string } | { kind: "container"; id: string };

/** The part of the graph a pick lights up. */
export interface GraphFocus {
  networks: Set<string>;
  containers: Set<string>;
}

/**
 * What a pick is related to. A network lights its members. A container lights
 * its networks and everything else on them — the containers it can reach in
 * principle, which is not the same as the ones that will answer.
 */
export function graphFocus(graph: NetGraph, pick: GraphPick | null): GraphFocus | null {
  if (!pick) return null;
  const networks = new Set<string>();
  const containers = new Set<string>();
  if (pick.kind === "network") {
    if (!graph.networks.some((n) => n.name === pick.name)) return null;
    networks.add(pick.name);
  } else {
    const own = graph.containers.find((c) => c.id === pick.id);
    if (!own) return null;
    containers.add(own.id);
    for (const n of own.networks) networks.add(n);
  }
  for (const e of graph.edges) if (networks.has(e.network)) containers.add(e.container);
  return { networks, containers };
}
