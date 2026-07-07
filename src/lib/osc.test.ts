import { describe, expect, it } from "vitest";
import { parseOsc7 } from "./osc";

describe("parseOsc7", () => {
  it("extracts the path from a file:// URI, ignoring the host", () => {
    expect(parseOsc7("file://myhost/var/www")).toBe("/var/www");
    expect(parseOsc7("file:///home/user")).toBe("/home/user"); // empty host
  });

  it("URL-decodes percent-escapes (spaces, unicode)", () => {
    expect(parseOsc7("file://h/var/my%20dir")).toBe("/var/my dir");
    expect(parseOsc7("file://h/%D0%BF%D1%83%D1%82%D1%8C")).toBe("/путь");
  });

  it("accepts a bare absolute path and the root", () => {
    expect(parseOsc7("/etc/nginx")).toBe("/etc/nginx");
    expect(parseOsc7("file://host/")).toBe("/"); // authority + root path
  });

  it("normalises a Windows file URI (drops the slash before the drive)", () => {
    expect(parseOsc7("file:///C:/Users/bob")).toBe("C:/Users/bob");
  });

  it("returns null for unusable payloads", () => {
    expect(parseOsc7("")).toBeNull();
    expect(parseOsc7("relative/path")).toBeNull();
    expect(parseOsc7("file://host/%ZZ")).toBeNull(); // malformed encoding
  });
});
