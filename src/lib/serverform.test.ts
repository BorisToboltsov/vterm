import { describe, expect, it } from "vitest";
import { isValidHost, isValidPort } from "./serverform";

describe("isValidPort", () => {
  it("accepts integers in 1…65535", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(22)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it("rejects null, out-of-range and non-integers", () => {
    expect(isValidPort(null)).toBe(false);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(22.5)).toBe(false);
    expect(isValidPort(NaN)).toBe(false);
  });
});

describe("isValidHost — IPv4", () => {
  it("accepts well-formed dotted quads", () => {
    for (const ip of ["192.168.1.10", "10.0.0.1", "0.0.0.0", "255.255.255.255", "8.8.8.8"]) {
      expect(isValidHost(ip)).toBe(true);
    }
  });

  it("rejects malformed IPv4", () => {
    for (const ip of [
      "256.1.1.1", // octet > 255
      "192.168.1", // only three octets
      "192.168.1.1.1", // five octets
      "192.168.01.1", // leading zero
      "192.168.1.", // trailing dot with empty octet
      "1.2.3.999",
    ]) {
      expect(isValidHost(ip)).toBe(false);
    }
  });
});

describe("isValidHost — IPv6", () => {
  it("accepts common IPv6 forms", () => {
    for (const ip of [
      "::1",
      "::",
      "2001:db8::1",
      "2001:0db8:0000:0000:0000:0000:0000:0001",
      "fe80::1%eth0",
      "::ffff:192.168.1.1",
    ]) {
      expect(isValidHost(ip)).toBe(true);
    }
  });

  it("rejects malformed IPv6", () => {
    for (const ip of [
      "2001::db8::1", // two "::"
      "1:2:3:4:5:6:7:8:9", // too many groups
      "12345::1", // group too long
      "gggg::1", // non-hex
      ":1:2", // stray leading colon
    ]) {
      expect(isValidHost(ip)).toBe(false);
    }
  });
});

describe("isValidHost — host names", () => {
  it("accepts valid host names / FQDNs", () => {
    for (const h of [
      "localhost",
      "my-server",
      "example.com",
      "sub.domain.co.uk",
      "server01",
      "example.com.", // trailing dot (FQDN)
    ]) {
      expect(isValidHost(h)).toBe(true);
    }
  });

  it("rejects malformed host names", () => {
    for (const h of [
      "-bad.com", // label starts with hyphen
      "bad-.com", // label ends with hyphen
      "has space.com",
      "under_score.com",
      "exa..mple.com", // empty label
      "999.1.1.1", // looks like an IP but is not a valid one
    ]) {
      expect(isValidHost(h)).toBe(false);
    }
  });
});

describe("isValidHost — general", () => {
  it("rejects empty / whitespace and trims input", () => {
    expect(isValidHost("")).toBe(false);
    expect(isValidHost("   ")).toBe(false);
    expect(isValidHost("  10.0.0.1  ")).toBe(true);
  });
});
