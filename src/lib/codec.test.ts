import { describe, it, expect } from "vitest";
import {
  encodeBase64,
  decodeBase64,
  encodeHex,
  decodeHex,
  runCodec,
} from "./codec";

describe("base64", () => {
  it("round-trips ASCII", () => {
    expect(encodeBase64("hello")).toBe("aGVsbG8=");
    expect(decodeBase64("aGVsbG8=")).toBe("hello");
  });

  it("handles UTF-8 (multi-byte)", () => {
    const s = "Привет, 世界 🌍";
    expect(decodeBase64(encodeBase64(s))).toBe(s);
  });

  it("produces URL-safe, unpadded output and reads it back", () => {
    // A payload whose standard base64 contains + and / .
    const s = "\xff\xff\xff\xfe";
    const std = encodeBase64(s);
    const url = encodeBase64(s, true);
    expect(std).toContain("=");
    expect(url).not.toContain("=");
    expect(url).not.toMatch(/[+/]/);
    expect(decodeBase64(url, true)).toBe(s);
  });

  it("decodes unpadded standard input by re-padding", () => {
    expect(decodeBase64("aGVsbG8")).toBe("hello");
  });
});

describe("hex", () => {
  it("round-trips", () => {
    expect(encodeHex("hi")).toBe("6869");
    expect(decodeHex("6869")).toBe("hi");
  });

  it("tolerates 0x, spaces and colons", () => {
    expect(decodeHex("0x68 69")).toBe("hi");
    expect(decodeHex("68:69")).toBe("hi");
  });

  it("throws on odd length or bad chars", () => {
    expect(() => decodeHex("abc")).toThrow();
    expect(() => decodeHex("zz")).toThrow();
  });
});

describe("runCodec", () => {
  it("empty input is a valid empty result", () => {
    expect(runCodec("base64", "encode", "")).toEqual({ ok: true, value: "" });
  });

  it("url encode/decode", () => {
    expect(runCodec("url", "encode", "a b&c")).toEqual({ ok: true, value: "a%20b%26c" });
    expect(runCodec("url", "decode", "a%20b%26c")).toEqual({ ok: true, value: "a b&c" });
  });

  it("reports invalidHex", () => {
    expect(runCodec("hex", "decode", "zz")).toEqual({ ok: false, error: "invalidHex" });
  });

  it("reports invalidUrl on a malformed percent-escape", () => {
    expect(runCodec("url", "decode", "%zz")).toEqual({ ok: false, error: "invalidUrl" });
  });

  it("reports invalidBase64 on a bad alphabet", () => {
    const r = runCodec("base64", "decode", "@@@@");
    expect(r).toEqual({ ok: false, error: "invalidBase64" });
  });

  it("base64url round-trips through runCodec", () => {
    const enc = runCodec("base64url", "encode", "hi there");
    expect(enc.ok).toBe(true);
    if (enc.ok) expect(runCodec("base64url", "decode", enc.value)).toEqual({ ok: true, value: "hi there" });
  });
});
