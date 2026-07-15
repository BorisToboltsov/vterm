import { describe, it, expect } from "vitest";
import { parseIpv4, intToIpv4, parseCidr, ipInCidr } from "./cidr";

describe("parseIpv4 / intToIpv4", () => {
  it("round-trips", () => {
    expect(parseIpv4("192.168.1.1")).toBe(0xc0a80101);
    expect(intToIpv4(0xc0a80101)).toBe("192.168.1.1");
    expect(intToIpv4(parseIpv4("255.255.255.255")!)).toBe("255.255.255.255");
    expect(parseIpv4("0.0.0.0")).toBe(0);
  });

  it("rejects malformed input", () => {
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("1.2.3.256")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("a.b.c.d")).toBeNull();
    expect(parseIpv4("1.2.3.-1")).toBeNull();
  });
});

describe("parseCidr", () => {
  it("computes a /24 block", () => {
    const r = parseCidr("192.168.1.10/24");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.network).toBe("192.168.1.0");
    expect(r.info.broadcast).toBe("192.168.1.255");
    expect(r.info.netmask).toBe("255.255.255.0");
    expect(r.info.wildcard).toBe("0.0.0.255");
    expect(r.info.firstHost).toBe("192.168.1.1");
    expect(r.info.lastHost).toBe("192.168.1.254");
    expect(r.info.hostCount).toBe(256);
    expect(r.info.usableHosts).toBe(254);
    expect(r.info.cidr).toBe("192.168.1.0/24");
    expect(r.info.isPrivate).toBe(true);
  });

  it("defaults a bare address to /32 (single host, 1 usable)", () => {
    const r = parseCidr("8.8.8.8");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.prefix).toBe(32);
    expect(r.info.network).toBe("8.8.8.8");
    expect(r.info.broadcast).toBe("8.8.8.8");
    expect(r.info.hostCount).toBe(1);
    expect(r.info.usableHosts).toBe(1);
    expect(r.info.isPrivate).toBe(false);
  });

  it("treats /31 as point-to-point (2 usable, RFC 3021)", () => {
    const r = parseCidr("10.0.0.0/31");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.hostCount).toBe(2);
    expect(r.info.usableHosts).toBe(2);
    expect(r.info.firstHost).toBe("10.0.0.0");
    expect(r.info.lastHost).toBe("10.0.0.1");
  });

  it("handles /0 (whole space)", () => {
    const r = parseCidr("0.0.0.0/0");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.netmask).toBe("0.0.0.0");
    expect(r.info.broadcast).toBe("255.255.255.255");
    expect(r.info.hostCount).toBe(4294967296);
  });

  it("flags the 172.16/12 private range boundaries", () => {
    expect((parseCidr("172.16.5.5/24") as { info: { isPrivate: boolean } }).info.isPrivate).toBe(true);
    expect((parseCidr("172.32.5.5/24") as { info: { isPrivate: boolean } }).info.isPrivate).toBe(false);
  });

  it("reports errors", () => {
    expect(parseCidr("")).toEqual({ ok: false, error: "empty" });
    expect(parseCidr("999.1.1.1/24")).toEqual({ ok: false, error: "invalidAddress" });
    expect(parseCidr("10.0.0.0/33")).toEqual({ ok: false, error: "invalidPrefix" });
    expect(parseCidr("10.0.0.0/x")).toEqual({ ok: false, error: "invalidPrefix" });
  });
});

describe("ipInCidr", () => {
  it("tests membership", () => {
    expect(ipInCidr("192.168.1.0/24", "192.168.1.55")).toBe(true);
    expect(ipInCidr("192.168.1.0/24", "192.168.2.1")).toBe(false);
    expect(ipInCidr("192.168.1.0/24", "192.168.1.0")).toBe(true);
    expect(ipInCidr("192.168.1.0/24", "192.168.1.255")).toBe(true);
  });

  it("returns null on malformed input", () => {
    expect(ipInCidr("bad", "1.2.3.4")).toBeNull();
    expect(ipInCidr("192.168.1.0/24", "bad")).toBeNull();
  });
});
