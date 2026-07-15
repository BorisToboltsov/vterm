// Pure Base64 / URL / Hex encode-decode logic (Phase 33). DOM-free: uses the
// standard btoa/atob + TextEncoder/TextDecoder available in both the browser and
// the vitest (jsdom) environment, so it is unit-tested without a component.
// Callers map CodecError to an i18n message.

export type CodecKind = "base64" | "base64url" | "url" | "hex";
export type CodecDir = "encode" | "decode";
export type CodecError = "invalidBase64" | "invalidHex" | "invalidUrl";

export type CodecResult =
  | { ok: true; value: string }
  | { ok: false; error: CodecError };

const enc = new TextEncoder();
// Non-fatal decoder: arbitrary bytes decode to replacement chars rather than
// throwing, so decoding binary data still shows *something* useful.
const dec = new TextDecoder();

function bytesToBinary(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function binaryToBytes(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-8 text → Base64 (standard, or URL-safe unpadded when `url`). */
export function encodeBase64(text: string, url = false): string {
  const b64 = btoa(bytesToBinary(enc.encode(text)));
  return url ? b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b64;
}

/** Base64 (standard or URL-safe, padded or not) → UTF-8 text. Throws on a bad alphabet. */
export function decodeBase64(input: string, url = false): string {
  let s = input.trim();
  if (url) s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad); // re-pad URL-safe / unpadded input
  return dec.decode(binaryToBytes(atob(s)));
}

/** UTF-8 text → lowercase hex (two chars per byte). */
export function encodeHex(text: string): string {
  return [...enc.encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hex → UTF-8 text. Tolerates `0x`, whitespace and `:` separators. Throws when malformed. */
export function decodeHex(input: string): string {
  const cleaned = input.trim().replace(/^0x/i, "").replace(/[\s:]/g, "");
  if (cleaned.length % 2 !== 0 || /[^0-9a-fA-F]/.test(cleaned)) {
    throw new Error("invalid hex");
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return dec.decode(bytes);
}

/** Run one codec operation. Empty input is a valid empty result (not an error). */
export function runCodec(kind: CodecKind, dir: CodecDir, input: string): CodecResult {
  if (input === "") return { ok: true, value: "" };
  try {
    const value =
      kind === "base64"
        ? dir === "encode"
          ? encodeBase64(input)
          : decodeBase64(input)
        : kind === "base64url"
          ? dir === "encode"
            ? encodeBase64(input, true)
            : decodeBase64(input, true)
          : kind === "url"
            ? dir === "encode"
              ? encodeURIComponent(input)
              : decodeURIComponent(input)
            : dir === "encode"
              ? encodeHex(input)
              : decodeHex(input);
    return { ok: true, value };
  } catch {
    const error: CodecError =
      kind === "hex" ? "invalidHex" : kind === "url" ? "invalidUrl" : "invalidBase64";
    return { ok: false, error };
  }
}
