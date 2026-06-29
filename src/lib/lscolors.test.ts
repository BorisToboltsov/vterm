import { describe, expect, it } from "vitest";
import { isExecutable, lsColorKey, formatMode, ownerLabel, fileTooltip } from "./lscolors";

const e = (over: Partial<Parameters<typeof lsColorKey>[0]> = {}) => ({
  name: "f",
  isDir: false,
  isSymlink: false,
  mode: 0o644 as number | null,
  uid: 1000 as number | null,
  gid: 1000 as number | null,
  user: null as string | null,
  group: null as string | null,
  ...over,
});

describe("isExecutable", () => {
  it("checks any execute bit", () => {
    expect(isExecutable(0o755)).toBe(true);
    expect(isExecutable(0o644)).toBe(false);
    expect(isExecutable(null)).toBe(false);
  });
});

describe("lsColorKey", () => {
  it("colours by type/permission/extension (ls dircolors defaults)", () => {
    expect(lsColorKey(e({ isDir: true }))).toBe("brightBlue");
    expect(lsColorKey(e({ isSymlink: true }))).toBe("brightCyan");
    expect(lsColorKey(e({ name: "run.sh", mode: 0o755 }))).toBe("brightGreen");
    expect(lsColorKey(e({ name: "a.tar.gz" }))).toBe("brightRed");
    expect(lsColorKey(e({ name: "pic.png" }))).toBe("brightMagenta");
    expect(lsColorKey(e({ name: "notes.txt", mode: 0o644 }))).toBeNull();
  });

  it("symlink wins over dir; dir wins over executable", () => {
    expect(lsColorKey(e({ isDir: true, isSymlink: true }))).toBe("brightCyan");
    expect(lsColorKey(e({ isDir: true, mode: 0o755 }))).toBe("brightBlue");
  });
});

describe("formatMode", () => {
  it("renders ls -l permission strings", () => {
    expect(formatMode(0o755, true, false)).toBe("drwxr-xr-x");
    expect(formatMode(0o644, false, false)).toBe("-rw-r--r--");
    expect(formatMode(0o777, false, true)).toBe("lrwxrwxrwx");
    expect(formatMode(null, false, false)).toBe("-?????????");
  });

  it("renders setuid/setgid/sticky bits", () => {
    expect(formatMode(0o4755, false, false)).toBe("-rwsr-xr-x"); // setuid + exec
    expect(formatMode(0o4644, false, false)).toBe("-rwSr--r--"); // setuid, no exec
    expect(formatMode(0o1777, true, false)).toBe("drwxrwxrwt"); // sticky (e.g. /tmp)
  });
});

describe("ownerLabel / fileTooltip", () => {
  it("prefers names, falls back to numeric ids", () => {
    expect(ownerLabel(e({ user: "boris", group: "boris" }))).toBe("boris:boris");
    expect(ownerLabel(e({ user: null, group: null, uid: 0, gid: 0 }))).toBe("0:0");
    expect(ownerLabel(e({ uid: null, gid: null }))).toBe("?:?");
  });

  it("tooltip is perms + owner", () => {
    expect(fileTooltip(e({ mode: 0o644, user: "root", group: "root" }))).toBe(
      "-rw-r--r--  root:root",
    );
  });
});
