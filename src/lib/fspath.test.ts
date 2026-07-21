import { describe, expect, it } from "vitest";
import {
  resolveRelative,
  baseName,
  DRIVES_ROOT,
  isDriveRoot,
  isRoot,
  isUnder,
  isWindowsPath,
  joinPath,
  navParent,
  normalizeInputPath,
  parentOf,
  sep,
  trimTrailing,
} from "./fspath";

describe("isWindowsPath", () => {
  it("recognises drive-absolute, bare-drive and UNC paths", () => {
    expect(isWindowsPath("C:\\Users\\bob")).toBe(true);
    expect(isWindowsPath("C:/Users/bob")).toBe(true);
    expect(isWindowsPath("C:\\")).toBe(true);
    expect(isWindowsPath("C:")).toBe(true);
    expect(isWindowsPath("\\\\server\\share\\dir")).toBe(true);
  });

  it("treats POSIX and relative paths as non-Windows", () => {
    expect(isWindowsPath("/etc/nginx")).toBe(false);
    expect(isWindowsPath("relative/dir")).toBe(false);
    expect(isWindowsPath("")).toBe(false);
  });
});

describe("sep", () => {
  it("keeps whichever separator a Windows path already uses", () => {
    expect(sep("C:\\Users")).toBe("\\");
    expect(sep("C:/Users")).toBe("/");
  });

  it("defaults Windows roots and UNC paths to a backslash", () => {
    expect(sep("C:")).toBe("\\");
    expect(sep("\\\\server\\share")).toBe("\\");
  });

  it("is POSIX for everything else", () => {
    expect(sep("/etc")).toBe("/");
    expect(sep("relative")).toBe("/");
  });
});

describe("isRoot", () => {
  it("is true at POSIX root", () => {
    expect(isRoot("/")).toBe(true);
  });

  // The Phase 39 bug: `C:\` was not "/" so the panel kept offering "..".
  it("is true at a Windows drive root in every spelling", () => {
    expect(isRoot("C:\\")).toBe(true);
    expect(isRoot("C:/")).toBe(true);
    expect(isRoot("C:")).toBe(true);
    expect(isRoot("d:\\")).toBe(true);
  });

  it("is true at a UNC share root, with or without a trailing separator", () => {
    expect(isRoot("\\\\server\\share")).toBe(true);
    expect(isRoot("\\\\server\\share\\")).toBe(true);
  });

  it("is false below a root", () => {
    expect(isRoot("/etc")).toBe(false);
    expect(isRoot("C:\\Users")).toBe(false);
    expect(isRoot("\\\\server\\share\\dir")).toBe(false);
  });

  it("treats an empty path as a root (nothing to navigate up to)", () => {
    expect(isRoot("")).toBe(true);
  });
});

describe("trimTrailing", () => {
  it("strips trailing separators below a root", () => {
    expect(trimTrailing("/etc/")).toBe("/etc");
    expect(trimTrailing("C:\\Users\\")).toBe("C:\\Users");
  });

  it("leaves roots intact", () => {
    expect(trimTrailing("/")).toBe("/");
    expect(trimTrailing("C:\\")).toBe("C:\\");
    expect(trimTrailing("\\\\server\\share")).toBe("\\\\server\\share");
  });
});

describe("parentOf", () => {
  it("walks up a POSIX path", () => {
    expect(parentOf("/a/b")).toBe("/a");
    expect(parentOf("/a")).toBe("/");
    expect(parentOf("/a/b/")).toBe("/a");
  });

  it("walks up a Windows path and stops at the drive root", () => {
    expect(parentOf("C:\\Users\\bob\\docs")).toBe("C:\\Users\\bob");
    expect(parentOf("C:\\Users")).toBe("C:\\");
    expect(parentOf("C:/Users")).toBe("C:/");
  });

  it("stops at a UNC share root", () => {
    expect(parentOf("\\\\server\\share\\dir")).toBe("\\\\server\\share");
  });

  // Regression: the old panel-local copy returned a bare separator here, which
  // the path bar then displayed as "/" on a Windows machine.
  it("keeps a root as its own parent instead of yielding a bare separator", () => {
    expect(parentOf("/")).toBe("/");
    expect(parentOf("C:\\")).toBe("C:\\");
    expect(parentOf("\\\\server\\share")).toBe("\\\\server\\share");
  });

  it("has no parent for a bare relative name", () => {
    expect(parentOf("file.txt")).toBe("");
  });
});

describe("baseName", () => {
  it("returns the last segment for both separators", () => {
    expect(baseName("/a/b.txt")).toBe("b.txt");
    expect(baseName("C:\\a\\b.txt")).toBe("b.txt");
    expect(baseName("/a/")).toBe("a");
  });

  it("returns a root unchanged", () => {
    expect(baseName("C:\\")).toBe("C:\\");
    expect(baseName("/")).toBe("/");
  });
});

describe("joinPath", () => {
  it("uses the native separator", () => {
    expect(joinPath("/etc", "nginx")).toBe("/etc/nginx");
    expect(joinPath("C:\\Users", "bob")).toBe("C:\\Users\\bob");
    expect(joinPath("C:/Users", "bob")).toBe("C:/Users/bob");
  });

  it("does not double a separator already present", () => {
    expect(joinPath("/etc/", "nginx")).toBe("/etc/nginx");
    expect(joinPath("C:\\", "Users")).toBe("C:\\Users");
  });
});

describe("isUnder", () => {
  it("detects descendants on POSIX", () => {
    expect(isUnder("/a/b/c", "/a")).toBe(true);
    expect(isUnder("/a", "/a")).toBe(false);
    expect(isUnder("/ab", "/a")).toBe(false);
  });

  // Drag-to-move into your own subtree must be rejected on Windows too; the
  // POSIX-only check used to miss it because it compared against "/" separators.
  it("detects descendants on Windows across mixed separators and case", () => {
    expect(isUnder("C:\\a\\b", "C:\\a")).toBe(true);
    expect(isUnder("C:/a/b", "C:\\a")).toBe(true);
    expect(isUnder("c:\\A\\b", "C:\\a")).toBe(true);
    expect(isUnder("C:\\ab", "C:\\a")).toBe(false);
  });

  it("is case-sensitive on POSIX", () => {
    expect(isUnder("/A/b", "/a")).toBe(false);
  });
});

describe("isDriveRoot", () => {
  it("matches a drive root in every spelling", () => {
    expect(isDriveRoot("C:\\")).toBe(true);
    expect(isDriveRoot("C:/")).toBe(true);
    expect(isDriveRoot("C:")).toBe(true);
    expect(isDriveRoot("z:\\")).toBe(true);
  });

  it("does not match paths below a drive, POSIX or UNC", () => {
    expect(isDriveRoot("C:\\Users")).toBe(false);
    expect(isDriveRoot("/")).toBe(false);
    expect(isDriveRoot("\\\\server\\share")).toBe(false);
    expect(isDriveRoot("")).toBe(false);
  });
});

describe("navParent", () => {
  // Phase 39.1: the panel's path bar is read-only text, so with no ".." at C:\
  // there was NO way to reach D:. ".." now leads to the drive list.
  it("leads from a drive root up to the drives level", () => {
    expect(navParent("C:\\")).toBe(DRIVES_ROOT);
    expect(navParent("C:/")).toBe(DRIVES_ROOT);
    expect(navParent("C:")).toBe(DRIVES_ROOT);
  });

  it("has nowhere to go above the drives level", () => {
    expect(navParent(DRIVES_ROOT)).toBeNull();
  });

  it("walks ordinary directories exactly like parentOf", () => {
    expect(navParent("C:\\Users\\bob")).toBe("C:\\Users");
    expect(navParent("C:\\Users")).toBe("C:\\");
    expect(navParent("/etc/nginx")).toBe("/etc");
  });

  // POSIX is untouched: no synthetic level, "/" is genuinely the top.
  it("stops at POSIX root", () => {
    expect(navParent("/")).toBeNull();
  });

  // Enumerating a server's shares needs NetShareEnum — deliberately out of scope.
  it("stops at a UNC share root", () => {
    expect(navParent("\\\\server\\share")).toBeNull();
    expect(navParent("\\\\server\\share\\")).toBeNull();
  });

  it("has no parent for an empty path (panel state before the first load)", () => {
    expect(navParent("")).toBeNull();
  });

  it("keeps the drives sentinel distinct from an empty path", () => {
    expect(DRIVES_ROOT).not.toBe("");
    // The sentinel must never look like a real path to the rest of the module.
    expect(isWindowsPath(DRIVES_ROOT)).toBe(false);
    expect(isDriveRoot(DRIVES_ROOT)).toBe(false);
  });
});

describe("normalizeInputPath", () => {
  it("passes a clean path through unchanged", () => {
    expect(normalizeInputPath("/etc/nginx")).toBe("/etc/nginx");
    expect(normalizeInputPath("C:\\Users\\bob")).toBe("C:\\Users\\bob");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeInputPath("  /etc/nginx \n")).toBe("/etc/nginx");
  });

  // Explorer's "Copy as path" wraps the result in double quotes — the single most
  // likely paste on Windows, and it must not become a literal directory name.
  it("strips quotes left by Explorer's 'Copy as path' and shell pastes", () => {
    expect(normalizeInputPath('"C:\\Program Files\\nginx"')).toBe("C:\\Program Files\\nginx");
    expect(normalizeInputPath("'/etc/my app'")).toBe("/etc/my app");
    // An unmatched quote is left alone rather than mangling the path.
    expect(normalizeInputPath('"C:\\Users')).toBe('"C:\\Users');
  });

  it("expands ~ against home when one is known", () => {
    expect(normalizeInputPath("~", "/home/me")).toBe("/home/me");
    expect(normalizeInputPath("~/.ssh", "/home/me")).toBe("/home/me/.ssh");
    expect(normalizeInputPath("~\\Documents", "C:\\Users\\me")).toBe("C:\\Users\\me\\Documents");
  });

  it("leaves ~ alone when home is unknown", () => {
    expect(normalizeInputPath("~/.ssh")).toBe("~/.ssh");
  });

  it("drops a trailing separator but keeps a root intact", () => {
    expect(normalizeInputPath("/etc/nginx/")).toBe("/etc/nginx");
    expect(normalizeInputPath("C:\\Users\\")).toBe("C:\\Users");
    expect(normalizeInputPath("/")).toBe("/");
    expect(normalizeInputPath("C:\\")).toBe("C:\\");
  });

  // A bare drive letter means "that drive's root" for navigation purposes.
  it("turns a bare drive letter into its root", () => {
    expect(normalizeInputPath("C:")).toBe("C:\\");
    expect(normalizeInputPath("d:")).toBe("d:\\");
  });

  it("collapses repeated separators", () => {
    expect(normalizeInputPath("/etc//nginx///conf.d")).toBe("/etc/nginx/conf.d");
    expect(normalizeInputPath("C:\\\\Users\\\\bob")).toBe("C:\\Users\\bob");
  });

  // The leading `\\` of a UNC path is load-bearing and must survive collapsing.
  it("preserves the UNC prefix while still collapsing inside it", () => {
    expect(normalizeInputPath("\\\\server\\share\\dir")).toBe("\\\\server\\share\\dir");
    expect(normalizeInputPath("\\\\server\\\\share")).toBe("\\\\server\\share");
  });

  it("returns null for input with nothing in it", () => {
    expect(normalizeInputPath("")).toBeNull();
    expect(normalizeInputPath("   ")).toBeNull();
    expect(normalizeInputPath('""')).toBeNull();
  });
});

// Phase 44.4: the arithmetic behind the markdown preview's inline images —
// `![x](./docs/a.png)` inside `/srv/app/README.md` names `/srv/app/docs/a.png`.
describe("resolveRelative", () => {
  it("resolves a relative reference against the directory", () => {
    expect(resolveRelative("/srv/app", "docs/a.png")).toBe("/srv/app/docs/a.png");
    expect(resolveRelative("/srv/app", "./docs/a.png")).toBe("/srv/app/docs/a.png");
    expect(resolveRelative("/srv/app/x", "../a.png")).toBe("/srv/app/a.png");
    expect(resolveRelative("/srv/app", "a/./b/../c.png")).toBe("/srv/app/a/c.png");
  });

  it("ignores the directory when the reference is itself absolute", () => {
    expect(resolveRelative("/srv/app", "/var/a.png")).toBe("/var/a.png");
    expect(resolveRelative("/srv/app", "/var/../etc/a.png")).toBe("/etc/a.png");
  });

  it("keeps Windows spellings native, drive root intact", () => {
    expect(resolveRelative("C:\\proj", "docs\\a.png")).toBe("C:\\proj\\docs\\a.png");
    expect(resolveRelative("C:\\proj\\x", "..\\a.png")).toBe("C:\\proj\\a.png");
    expect(resolveRelative("C:\\proj", "..\\a.png")).toBe("C:\\a.png");
    expect(resolveRelative("C:/proj", "docs/a.png")).toBe("C:/proj/docs/a.png");
  });

  it("never eats a UNC share root", () => {
    expect(resolveRelative("\\\\srv\\share\\a", "..\\b.png")).toBe("\\\\srv\\share\\b.png");
  });

  it("returns null rather than clamping a climb past the root", () => {
    // Clamping (the tempting no-op) would resolve to a different, existing file —
    // worse than refusing, because it looks like success.
    expect(resolveRelative("/a", "../../x.png")).toBeNull();
    expect(resolveRelative("C:\\", "..\\x.png")).toBeNull();
  });

  it("returns null when there is nothing usable to resolve against", () => {
    expect(resolveRelative("/srv", "")).toBeNull();
    expect(resolveRelative("/srv", "   ")).toBeNull();
    expect(resolveRelative("relative/dir", "a.png")).toBeNull();
    expect(resolveRelative("", "a.png")).toBeNull();
  });
});
