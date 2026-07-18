import { describe, expect, it } from "vitest";
import { parseOsc7, parseOsc9 } from "./osc";

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

describe("parseOsc9 (Windows OSC 9;9 cwd)", () => {
  it("accepts a plain Windows path", () => {
    expect(parseOsc9("9;C:\\Users\\bob")).toBe("C:\\Users\\bob");
    expect(parseOsc9("9;C:/Users/bob")).toBe("C:/Users/bob");
  });

  // PowerShell profiles from Microsoft's docs quote the path.
  it("strips the quotes emitters usually add", () => {
    expect(parseOsc9('9;"C:\\Program Files"')).toBe("C:\\Program Files");
    expect(parseOsc9('9; "C:\\Users\\bob" ')).toBe("C:\\Users\\bob");
  });

  it("accepts POSIX and UNC paths", () => {
    expect(parseOsc9("9;/home/me")).toBe("/home/me");
    expect(parseOsc9("9;\\\\server\\share")).toBe("\\\\server\\share");
  });

  it("accepts a file:// URI here too, reusing the OSC 7 parsing", () => {
    expect(parseOsc9("9;file:///home/me")).toBe("/home/me");
  });

  // OSC 9 has other subtypes; 9;4 is a progress indicator. Sending the panel to
  // "4;3;70" would be worse than ignoring it.
  it("ignores OSC 9 subtypes that are not a working directory", () => {
    expect(parseOsc9("4;3;70")).toBeNull();
    expect(parseOsc9("1;some notification")).toBeNull();
  });

  it("rejects relative or empty payloads", () => {
    expect(parseOsc9("9;")).toBeNull();
    expect(parseOsc9("9;   ")).toBeNull();
    expect(parseOsc9("9;relative/dir")).toBeNull();
    expect(parseOsc9('9;""')).toBeNull();
  });
});
