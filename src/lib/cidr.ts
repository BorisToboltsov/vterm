// Pure IPv4 CIDR / subnet math (Phase 33). DOM-free and offline — plain 32-bit
// integer arithmetic, unit-tested without a component. The panel maps CidrError
// to an i18n message and renders CidrInfo.

export type CidrError = "empty" | "invalidAddress" | "invalidPrefix";

export interface CidrInfo {
  /** Normalised `network/prefix` (the block, not the entered host). */
  cidr: string;
  /** The address as entered (dotted quad). */
  address: string;
  prefix: number;
  netmask: string;
  wildcard: string;
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  /** Total addresses in the block (2^(32−prefix)). */
  hostCount: number;
  /** Assignable hosts (block minus network+broadcast; /31 and /32 special-cased). */
  usableHosts: number;
  /** True when the block is in a private (RFC 1918) range. */
  isPrivate: boolean;
}

export type CidrResult = { ok: true; info: CidrInfo } | { ok: false; error: CidrError };

/** Parse a dotted-quad into an unsigned 32-bit int, or null when malformed. */
export function parseIpv4(text: string): number | null {
  const parts = text.trim().split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    acc = (acc << 8) | n;
  }
  return acc >>> 0;
}

/** Format an unsigned 32-bit int as a dotted quad. */
export function intToIpv4(n: number): string {
  const u = n >>> 0;
  return `${(u >>> 24) & 0xff}.${(u >>> 16) & 0xff}.${(u >>> 8) & 0xff}.${u & 0xff}`;
}

function isPrivateV4(net: number): boolean {
  const u = net >>> 0;
  const a = (u >>> 24) & 0xff;
  const b = (u >>> 16) & 0xff;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Parse `a.b.c.d[/prefix]` (prefix defaults to 32) and compute block details.
 */
export function parseCidr(input: string): CidrResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "empty" };

  const slash = raw.indexOf("/");
  const addrPart = slash === -1 ? raw : raw.slice(0, slash);
  const prefixPart = slash === -1 ? "32" : raw.slice(slash + 1);

  const addr = parseIpv4(addrPart);
  if (addr === null) return { ok: false, error: "invalidAddress" };

  if (!/^\d{1,2}$/.test(prefixPart.trim())) return { ok: false, error: "invalidPrefix" };
  const prefix = Number(prefixPart.trim());
  if (prefix > 32) return { ok: false, error: "invalidPrefix" };

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (addr & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hostCount = 2 ** (32 - prefix);

  let firstHost: number;
  let lastHost: number;
  let usableHosts: number;
  if (prefix >= 31) {
    // /31 (RFC 3021 point-to-point) and /32 (single host): every address usable.
    firstHost = network;
    lastHost = broadcast;
    usableHosts = hostCount;
  } else {
    firstHost = (network + 1) >>> 0;
    lastHost = (broadcast - 1) >>> 0;
    usableHosts = hostCount - 2;
  }

  return {
    ok: true,
    info: {
      cidr: `${intToIpv4(network)}/${prefix}`,
      address: intToIpv4(addr),
      prefix,
      netmask: intToIpv4(mask),
      wildcard: intToIpv4(~mask >>> 0),
      network: intToIpv4(network),
      broadcast: intToIpv4(broadcast),
      firstHost: intToIpv4(firstHost),
      lastHost: intToIpv4(lastHost),
      hostCount,
      usableHosts,
      isPrivate: isPrivateV4(network),
    },
  };
}

/** Whether `ip` falls inside `cidr`. Returns null when either input is malformed. */
export function ipInCidr(cidr: string, ip: string): boolean | null {
  const parsed = parseCidr(cidr);
  const addr = parseIpv4(ip);
  if (!parsed.ok || addr === null) return null;
  const net = parseIpv4(parsed.info.network)!;
  const bcast = parseIpv4(parsed.info.broadcast)!;
  return addr >= net && addr <= bcast;
}
