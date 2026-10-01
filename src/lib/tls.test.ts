import { describe, it, expect } from "vitest";
import { tlsArgs, tlsSteps, tlsTerminalCommand, tlsAudit, parseTlsCert, expiryLevel } from "./tls";

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

describe("tlsSteps (local tab, no shell)", () => {
  it("splits the pipeline into s_client then x509, argv verbatim", () => {
    const [client, x509] = tlsSteps(" example.com ", 8443);
    expect(client).toEqual(["openssl", "s_client", "-connect", "example.com:8443", "-servername", "example.com"]);
    expect(x509.slice(0, 3)).toEqual(["openssl", "x509", "-noout"]);
    // Same fields as the SSH pipeline, so one parser reads both.
    expect(tlsArgs("example.com")[2]).toContain(x509.join(" "));
  });
});

describe("tlsTerminalCommand", () => {
  it("closes stdin and drops stderr in each shell's own syntax", () => {
    expect(tlsTerminalCommand("example.com", 443, "posix")).toMatch(/^echo \| openssl s_client -connect example\.com:443 -servername example\.com 2>\/dev\/null \| openssl x509 -noout /);
    expect(tlsTerminalCommand("example.com", 443, "powershell")).toMatch(/^\$null \| openssl s_client .* 2>\$null \| openssl x509 /);
    expect(tlsTerminalCommand("example.com", 443, "cmd")).toMatch(/^echo\.\| openssl s_client .* 2>NUL \| openssl x509 /);
  });
  it("never types a POSIX redirect into cmd.exe or PowerShell", () => {
    for (const sh of ["powershell", "cmd"] as const) {
      expect(tlsTerminalCommand("h.test", 443, sh)).not.toContain("/dev/null");
    }
  });
  it("refuses a host it can't write bare", () => {
    expect(tlsTerminalCommand("a b", 443, "posix")).toBeNull();
    expect(tlsTerminalCommand("h;rm -rf /", 443, "cmd")).toBeNull();
    expect(tlsTerminalCommand("h&calc", 443, "cmd")).toBeNull();
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

describe("tlsAudit", () => {
  const now = Date.UTC(2026, 6, 1);
  it("records the cert's fields, not the PEM", () => {
    const a = tlsAudit(" example.com ", 443, { stdout: SAMPLE, stderr: "", exitCode: 0 }, now);
    expect(a.op).toBe("tls example.com:443");
    expect(a.exitCode).toBe(0);
    expect(a.body).toContain("subject=CN=example.com");
    expect(a.body).toMatch(/notAfter=Sep {2}1 00:00:00 2026 GMT \(\d+ d\)/);
    expect(a.body).not.toContain("BEGIN CERTIFICATE");
  });
  it("records why a fetch failed, with a non-zero exit", () => {
    const a = tlsAudit("h", 8443, { stdout: "", stderr: "unable to load certificate\nmore", exitCode: 1 }, now);
    expect(a).toEqual({ op: "tls h:8443", body: "unable to load certificate", exitCode: 1 });
    expect(tlsAudit("h", 443, { stdout: "garbage", stderr: "", exitCode: 0 }, now).exitCode).toBe(1);
  });
});
