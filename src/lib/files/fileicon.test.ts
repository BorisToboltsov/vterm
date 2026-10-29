import { describe, expect, it } from "vitest";
import { fileIconName } from "./fileicon";

const e = (name: string, over: Partial<{ isDir: boolean; isSymlink: boolean }> = {}) => ({
  name,
  isDir: false,
  isSymlink: false,
  ...over,
});

describe("fileIconName", () => {
  it("keeps folder/symlink icons", () => {
    expect(fileIconName(e("etc", { isDir: true }))).toBe("folder");
    expect(fileIconName(e("link", { isSymlink: true }))).toBe("symlink");
    // Symlink wins even over a dir target.
    expect(fileIconName(e("d", { isDir: true, isSymlink: true }))).toBe("symlink");
  });

  it("maps by extension category", () => {
    expect(fileIconName(e("app.ts"))).toBe("code");
    expect(fileIconName(e("main.go"))).toBe("code");
    expect(fileIconName(e("values.yaml"))).toBe("braces");
    expect(fileIconName(e("Config.JSON"))).toBe("braces");
    expect(fileIconName(e("deploy.sh"))).toBe("terminal");
    expect(fileIconName(e("logo.png"))).toBe("image");
    expect(fileIconName(e("bundle.tar.gz"))).toBe("archive");
    expect(fileIconName(e("server.pem"))).toBe("lock");
  });

  it("falls back to the generic file icon", () => {
    expect(fileIconName(e("notes"))).toBe("file");
    expect(fileIconName(e("data.unknownext"))).toBe("file");
  });
});
