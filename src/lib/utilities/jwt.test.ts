import { describe, it, expect } from "vitest";
import { decodeJwt, claimDate, expiryStatus } from "./jwt";

// The canonical jwt.io HS256 example.
const SAMPLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
  ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" +
  ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("decodeJwt", () => {
  it("decodes header, payload and keeps the signature", () => {
    const r = decodeJwt(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parts.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(r.parts.payload).toEqual({ sub: "1234567890", name: "John Doe", iat: 1516239022 });
    expect(r.parts.signature).toBe("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
  });

  it("reports errors", () => {
    expect(decodeJwt("")).toEqual({ ok: false, error: "empty" });
    expect(decodeJwt("a.b")).toEqual({ ok: false, error: "structure" });
    // Valid base64url that isn't JSON.
    expect(decodeJwt("aGk.aGk.sig")).toEqual({ ok: false, error: "invalidJson" });
    // Not valid base64url in the header.
    expect(decodeJwt("@@@.@@@.sig")).toEqual({ ok: false, error: "invalidBase64" });
  });
});

describe("claim helpers", () => {
  it("claimDate converts NumericDate seconds", () => {
    expect(claimDate(1516239022)?.getTime()).toBe(1516239022000);
    expect(claimDate("nope")).toBeNull();
    expect(claimDate(undefined)).toBeNull();
  });

  it("expiryStatus reflects exp vs now", () => {
    const now = new Date("2020-01-01T00:00:00Z");
    expect(expiryStatus({ exp: 1893456000 }, now)).toBe("valid"); // 2030
    expect(expiryStatus({ exp: 946684800 }, now)).toBe("expired"); // 2000
    expect(expiryStatus({ sub: "x" }, now)).toBeNull();
    expect(expiryStatus(null, now)).toBeNull();
  });
});
