import { describe, it, expect } from "vitest";
import { tlsArgs, parseTlsCert, expiryLevel } from "./tls";

describe("tlsArgs", () => {
  it("builds an sh -c openssl pipeline with SNI", () => {
    const [sh, flag, pipeline] = tlsArgs("example.com");
    expect(sh).toBe("sh");
    expect(flag).toBe("-c");
    expect(pipeline).toContain("s_client -connect example.com:443");
    expect(pipeline).toContain("-servername example.com");
    expect(pipeline).toContain("x509 -noout");
  });
  it("honours a custom port and quotes odd hosts", () => {
    expect(tlsArgs("h.test", 8443)[2]).toContain(":8443");
    expect(tlsArgs("a b")[2]).toContain("'a b'");
  });
});

const SAMPLE = `subject=CN=example.com
issuer=C=US, O=Let's Encrypt, CN=R3
serial=03A1B2
notBefore=Jun  1 00:00:00 2026 GMT
notAfter=Sep  1 00:00:00 2026 GMT
SHA256 Fingerprint=AA:BB:CC
X509v3 Subject Alternative Name:
    DNS:example.com, DNS:www.example.com, IP Address:1.2.3.4`;

describe("parseTlsCert", () => {
  it("parses fields, SANs and day-count", () => {
    const now = Date.parse("Aug  2 00:00:00 2026 GMT"); // 30 days before notAfter
    const cert = parseTlsCert(SAMPLE, now)!;
    expect(cert.subject).toBe("CN=example.com");
    expect(cert.issuer).toContain("Let's Encrypt");
    expect(cert.serial).toBe("03A1B2");
    expect(cert.fingerprint).toBe("AA:BB:CC");
    expect(cert.sans).toEqual(["example.com", "www.example.com", "1.2.3.4"]);
    expect(cert.daysRemaining).toBe(30);
    expect(cert.expiresAt).not.toBeNull();
  });

  it("returns null when there is no cert", () => {
    expect(parseTlsCert("connect: Connection refused")).toBeNull();
  });

  it("handles a missing/unparseable notAfter", () => {
    const cert = parseTlsCert("subject=CN=x")!;
    expect(cert.daysRemaining).toBeNull();
    expect(cert.expiresAt).toBeNull();
    expect(cert.sans).toEqual([]);
    expect(cert.fingerprint).toBe("");
  });
});

describe("expiryLevel", () => {
  it("buckets by days remaining", () => {
    expect(expiryLevel(null)).toBe("unknown");
    expect(expiryLevel(-1)).toBe("expired");
    expect(expiryLevel(3)).toBe("critical");
    expect(expiryLevel(20)).toBe("warning");
    expect(expiryLevel(90)).toBe("ok");
  });
});
