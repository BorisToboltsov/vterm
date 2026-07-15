// Pure JWT decoding (Phase 33). Splits the token and base64url-decodes the header
// and payload — it does NOT verify the signature (offline, no keys). Reuses the
// codec's base64url decoder so there is one implementation. DOM-free.
import { decodeBase64 } from "./codec";

export type JwtError = "empty" | "structure" | "invalidBase64" | "invalidJson";

export interface JwtParts {
  header: unknown;
  payload: unknown;
  /** Raw base64url signature segment (empty for `alg: none`). */
  signature: string;
}

export type JwtResult = { ok: true; parts: JwtParts } | { ok: false; error: JwtError };

/** Decode a `header.payload.signature` JWT without verifying it. */
export function decodeJwt(token: string): JwtResult {
  const t = token.trim();
  if (!t) return { ok: false, error: "empty" };

  const segs = t.split(".");
  if (segs.length !== 3) return { ok: false, error: "structure" };

  let headerJson: string;
  let payloadJson: string;
  try {
    headerJson = decodeBase64(segs[0], true);
    payloadJson = decodeBase64(segs[1], true);
  } catch {
    return { ok: false, error: "invalidBase64" };
  }

  try {
    return {
      ok: true,
      parts: {
        header: JSON.parse(headerJson),
        payload: JSON.parse(payloadJson),
        signature: segs[2],
      },
    };
  } catch {
    return { ok: false, error: "invalidJson" };
  }
}

/** Interpret a NumericDate claim (seconds since epoch) as a Date, or null. */
export function claimDate(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000);
}

/** Validity by `exp` claim: "expired" / "valid", or null when there is no exp. */
export function expiryStatus(payload: unknown, now: Date = new Date()): "valid" | "expired" | null {
  if (typeof payload !== "object" || payload === null) return null;
  const d = claimDate((payload as Record<string, unknown>).exp);
  if (!d) return null;
  return d.getTime() < now.getTime() ? "expired" : "valid";
}
