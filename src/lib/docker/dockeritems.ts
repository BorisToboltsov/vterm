// The details of an image, a network and a volume (v1.33, stage 4): what the
// panel shows beside its list when one of them is picked in the column of
// names. Pure (ADR 0003): what to ask docker and how to read its answer; the
// commands are read-only and pass the backend's policy (`container::check_args`).
//
// Who uses an image or a volume is asked of docker by filter (`ps --filter
// ancestor=…`, `--filter volume=…`), not guessed from names: a container made
// from `nginx` before a new `pull` runs the old image, and its `Image` field
// says `nginx` all the same.

const US = "\x1f";

const lines = (raw: string): string[][] =>
  raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.split(US));

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The first object of an `inspect` answer (a JSON array of one); null — not that. */
function inspected(raw: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(raw) as unknown;
    const it = Array.isArray(doc) ? doc[0] : doc;
    return it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const labelsOf = (v: unknown): { key: string; value: string }[] =>
  Object.entries(obj(v))
    .map(([key, value]) => ({ key, value: text(value) }))
    .sort((a, b) => a.key.localeCompare(b.key));

// ── Who uses it ──────────────────────────────────────────────────────────────

/** A container that uses an image or a volume, as `ps` names it. */
export interface UserContainer {
  id: string;
  name: string;
  state: string;
}

const PS_FORMAT = ["{{.ID}}", "{{.Names}}", "{{.State}}"].join(US);

/** The containers made from an image (by id — what it runs, not what it was called). */
export function imageUsersArgs(imageId: string): string[] {
  return ["docker", "ps", "-a", "--filter", `ancestor=${imageId}`, "--format", PS_FORMAT];
}

/** The containers that mount a volume. */
export function volumeUsersArgs(name: string): string[] {
  return ["docker", "ps", "-a", "--filter", `volume=${name}`, "--format", PS_FORMAT];
}

export function parseUsers(raw: string): UserContainer[] {
  return lines(raw)
    .map((f) => ({ id: (f[0] ?? "").trim(), name: (f[1] ?? "").trim(), state: (f[2] ?? "").trim().toLowerCase() }))
    .filter((c) => c.id)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── An image ─────────────────────────────────────────────────────────────────

/** An image's layers, newest first, with the step that made each. */
export function imageHistoryArgs(imageId: string): string[] {
  const fmt = ["{{.CreatedBy}}", "{{.Size}}", "{{.CreatedSince}}"].join(US);
  return ["docker", "history", "--no-trunc", "--format", fmt, imageId];
}

export interface ImageLayer {
  /** The build step, as docker recorded it (`/bin/sh -c #(nop)` taken off). */
  step: string;
  /** docker's own figure (`0B`, `85.2MB`). */
  size: string;
  /** Whether it adds bytes — a metadata step (`ENV`, `CMD`) adds none. */
  adds: boolean;
}

/** `docker history` → layers; a step's shell prefix is dropped, it is the same on every line. */
export function parseHistory(raw: string): ImageLayer[] {
  return lines(raw).map((f) => {
    const step = (f[0] ?? "")
      .trim()
      .replace(/^\/bin\/sh -c #\(nop\)\s*/, "")
      .replace(/^\/bin\/sh -c\s+/, "RUN ")
      // BuildKit writes the shell into the step and tags it.
      .replace(/^RUN \/bin\/sh -c\s+/, "RUN ")
      .replace(/\s+# buildkit$/, "");
    const size = (f[1] ?? "").trim();
    return { step, size, adds: size !== "" && !/^0(\.0+)?\s*B$/i.test(size) };
  });
}

// ── A network ────────────────────────────────────────────────────────────────

export function networkInspectArgs(name: string): string[] {
  return ["docker", "network", "inspect", name];
}

/** A container attached to a network, with the address the network gave it. */
export interface NetworkMember {
  id: string;
  name: string;
  /** `172.20.0.5` — the prefix length taken off; "" — none of that family. */
  ipv4: string;
  ipv6: string;
}

export interface NetworkDetail {
  name: string;
  driver: string;
  scope: string;
  /** No way out of the docker host (`--internal`). */
  internal: boolean;
  /** Its address ranges and gateways, as IPAM configured them. */
  subnets: { subnet: string; gateway: string }[];
  members: NetworkMember[];
  labels: { key: string; value: string }[];
}

const bare = (cidr: string): string => cidr.replace(/\/\d+$/, "");

/** `docker network inspect <name>` → its details; null — not a network answer. */
export function parseNetworkDetail(raw: string): NetworkDetail | null {
  const it = inspected(raw);
  if (!it || typeof it.Name !== "string" || !("IPAM" in it)) return null;
  const ipam = obj(it.IPAM);
  const subnets = (Array.isArray(ipam.Config) ? (ipam.Config as unknown[]).map(obj) : [])
    .map((c) => ({ subnet: text(c.Subnet), gateway: text(c.Gateway) }))
    .filter((c) => c.subnet || c.gateway);
  const members = Object.entries(obj(it.Containers))
    .map(([id, v]) => {
      const m = obj(v);
      return { id, name: text(m.Name), ipv4: bare(text(m.IPv4Address)), ipv6: bare(text(m.IPv6Address)) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    name: it.Name,
    driver: text(it.Driver),
    scope: text(it.Scope),
    internal: it.Internal === true,
    subnets,
    members,
    labels: labelsOf(it.Labels),
  };
}

/**
 * Subnets of every network at once, for the topology: one `inspect` of all of
 * them, a line per network (`name␟subnet subnet␟internal`).
 */
export function networkSubnetsArgs(names: readonly string[]): string[] {
  const fmt = ["{{.Name}}", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", "{{.Internal}}"].join(US);
  return ["docker", "network", "inspect", "--format", fmt, ...names];
}

export function parseNetworkSubnets(raw: string): Map<string, { subnets: string[]; internal: boolean }> {
  const out = new Map<string, { subnets: string[]; internal: boolean }>();
  for (const f of lines(raw)) {
    const name = (f[0] ?? "").trim();
    if (!name) continue;
    out.set(name, { subnets: (f[1] ?? "").trim().split(/\s+/).filter(Boolean), internal: (f[2] ?? "").trim() === "true" });
  }
  return out;
}

// ── A volume ─────────────────────────────────────────────────────────────────

export function volumeInspectArgs(name: string): string[] {
  return ["docker", "volume", "inspect", name];
}

export interface VolumeDetail {
  name: string;
  driver: string;
  scope: string;
  /** Where its data lives on the docker host (inside the VM on Docker Desktop). */
  mountpoint: string;
  /** epoch ms; null — not reported. */
  created: number | null;
  /** Made by docker for a container that named no volume (`com.docker.volume.anonymous`). */
  anonymous: boolean;
  labels: { key: string; value: string }[];
}

/** `docker volume inspect <name>` → its details; null — not a volume answer. */
export function parseVolumeDetail(raw: string): VolumeDetail | null {
  const it = inspected(raw);
  if (!it || typeof it.Name !== "string" || !("Mountpoint" in it)) return null;
  const created = Date.parse(text(it.CreatedAt));
  const labels = labelsOf(it.Labels);
  return {
    name: it.Name,
    driver: text(it.Driver),
    scope: text(it.Scope),
    mountpoint: text(it.Mountpoint),
    created: Number.isFinite(created) ? created : null,
    anonymous: labels.some((l) => l.key === "com.docker.volume.anonymous"),
    labels,
  };
}

// ── What stands beside the list ──────────────────────────────────────────────

/** An image, a network or a volume picked in the column of names (a container has its own details). */
export type DockerItem =
  | { kind: "image"; id: string; label: string }
  | { kind: "network"; name: string }
  | { kind: "volume"; name: string };

/** The same item, picked again — the poll hands over new objects every few seconds. */
export function sameItem(a: DockerItem | null, b: DockerItem | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "image" && b.kind === "image") return a.id === b.id;
  return (a as { name: string }).name === (b as { name: string }).name;
}
