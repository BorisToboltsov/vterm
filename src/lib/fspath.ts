// Separator-aware path primitives shared by the file panels (SftpPanel is always
// POSIX; LocalFilePanel gets native paths — `C:\Users\bob` on Windows). Kept pure
// and DOM-free so the rules are unit-tested without a panel (ADR 0003).
//
// Phase 39: extracted from duplicated `sep`/`join`/`parentOf` copies that lived
// inside both panels and only understood POSIX roots. The concrete bug: the ".."
// parent-nav row was shown at `C:\` (because the root test was literally
// `cwd !== "/"`), and following it produced a bare separator instead of staying
// put — the path bar then read `/` on a Windows machine.
//
// Phase 39.1: hiding ".." at `C:\` fixed the lie but closed the only door — the
// path bar is read-only text, so with no ".." there was no way whatsoever to reach
// `D:`. Windows has a level above a drive (Explorer calls it "This PC"), so ".."
// now leads there. That level is NOT a filesystem path, so it gets an explicit
// sentinel rather than an overloaded empty string (the panel's `cwd` is briefly
// "" during mount, and conflating the two would flash "This PC" on POSIX too).
//
// Note the deliberate split: `isRoot`/`parentOf` keep their original *filesystem*
// meaning (a drive root IS a filesystem root), while the new `navParent` answers
// the different question "where should the .. row go?". Overloading `isRoot` for
// navigation would have quietly changed `trimTrailing`/`baseName`, which build on
// it — hence two concepts, not one stretched concept.

/** Windows drive root: `C:`, `C:\`, `C:/`. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;
/** Windows drive-absolute path: `C:\…`, `C:/…`. */
const DRIVE_ABS = /^[A-Za-z]:[\\/]/;
/** UNC share root: `\\server\share`, with an optional trailing separator. */
const UNC_ROOT = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/;
/** UNC path: `\\server\share\…`. */
const UNC_ABS = /^\\\\[^\\/]+[\\/]/;

/**
 * The synthetic "list every drive letter" level that sits above a Windows drive
 * root — Explorer's "This PC". It is not a filesystem path, so it carries a
 * sentinel that cannot collide with one: `:` is illegal in a Windows path except
 * as the drive separator, and nothing on POSIX ever produces this string.
 *
 * Passed to the backend verbatim as the `local_list` argument; `localfile::list`
 * matches it exactly and answers with drive entries instead of a directory read.
 */
export const DRIVES_ROOT = "::drives";

/** True for a Windows-shaped path (drive-absolute or UNC). */
export function isWindowsPath(path: string): boolean {
  return DRIVE_ABS.test(path) || DRIVE_ROOT.test(path) || UNC_ABS.test(path);
}

/** True for a Windows drive root in any spelling: `C:`, `C:\`, `C:/`. */
export function isDriveRoot(path: string): boolean {
  return DRIVE_ROOT.test(path);
}

/**
 * The separator to use when extending `path`. Windows paths keep whichever
 * separator they already use (both are valid there) and default to `\`;
 * everything else is POSIX.
 */
export function sep(path: string): string {
  if (!isWindowsPath(path)) return "/";
  // A drive-absolute path states its separator in the 3rd character; UNC paths
  // and bare drives fall back to the backslash Windows tools print.
  const m = /^[A-Za-z]:([\\/])/.exec(path);
  if (m) return m[1];
  return path.slice(2).includes("/") && !path.slice(2).includes("\\") ? "/" : "\\";
}

/**
 * True when `path` has no parent to navigate to: POSIX `/`, a Windows drive root
 * (`C:\`), or a UNC share root (`\\server\share`). Above a share/drive there is
 * nothing meaningful for a file panel to list, so callers hide the ".." row.
 */
export function isRoot(path: string): boolean {
  if (!path) return true;
  if (path === "/") return true;
  if (DRIVE_ROOT.test(path)) return true;
  if (UNC_ROOT.test(path)) return true;
  return false;
}

/** Strip trailing separators, but keep a root (`/`, `C:\`, `\\srv\share`) intact. */
export function trimTrailing(path: string): string {
  if (isRoot(path)) return path;
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed === "" ? path : trimmed;
}

/**
 * The parent directory of `path`. Roots are their own parent (so a stray call
 * can't walk off the top), a bare relative name has none (`""`), and a Windows
 * drive keeps its trailing separator so `C:\Users` → `C:\`, never `\`.
 */
export function parentOf(path: string): string {
  if (isRoot(path)) return path;
  const p = trimTrailing(path);
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return ""; // bare relative name
  const head = p.slice(0, i);
  if (head === "") return "/"; // "/a" → "/"
  // "C:\Users" → "C:\" (the drive root, not the separator-less "C:").
  if (DRIVE_ROOT.test(head)) return head.length === 2 ? head + sep(p) : head;
  // "\\srv\share\a" → "\\srv\share" (already a root; don't strip further).
  if (UNC_ROOT.test(head)) return head;
  return head;
}

/**
 * Where the file panel's ".." row should navigate to, or `null` when there is
 * nowhere above. This is the *navigation* question, distinct from the filesystem
 * one `parentOf` answers:
 *
 *   * a Windows drive root (`C:\`) IS a filesystem root, but Explorer shows a
 *     level above it listing every drive — so `..` leads to {@link DRIVES_ROOT};
 *   * POSIX `/` genuinely has nothing above it;
 *   * a UNC share root (`\\server\share`) stops here by choice: enumerating a
 *     server's shares needs `NetShareEnum`, which is a different feature;
 *   * {@link DRIVES_ROOT} is the top of the Windows tree.
 *
 * The panel uses this for both `hasParent` and the ".." target, so the row is
 * shown exactly when following it would do something.
 */
export function navParent(path: string): string | null {
  if (path === DRIVES_ROOT) return null;
  if (isDriveRoot(path)) return DRIVES_ROOT;
  if (isRoot(path)) return null; // POSIX "/", UNC share root, or empty
  return parentOf(path);
}

/** The last path segment: `/a/b.txt` → `b.txt`, `C:\a\b` → `b`, `C:\` → `C:\`. */
export function baseName(path: string): string {
  if (isRoot(path)) return path;
  const p = trimTrailing(path);
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

/** Join a directory and a name with exactly one native separator. */
export function joinPath(dir: string, name: string): string {
  const s = sep(dir);
  return /[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}${s}${name}`;
}

/**
 * True when `child` lives anywhere under `dir`. Separator-agnostic so a Windows
 * path mixing `\` and `/` still compares correctly; case-insensitive on Windows,
 * where `C:\Users` and `c:\users` are the same directory.
 */
export function isUnder(child: string, dir: string): boolean {
  const win = isWindowsPath(child) || isWindowsPath(dir);
  const norm = (p: string) => {
    const t = trimTrailing(p).replace(/\\/g, "/");
    return win ? t.toLowerCase() : t;
  };
  const c = norm(child);
  const d = norm(dir);
  return c !== d && c.startsWith(d.endsWith("/") ? d : `${d}/`);
}

/**
 * Resolve a document-relative reference against the directory the document lives
 * in, collapsing `.` and `..` — the arithmetic behind the markdown preview's
 * inline images (`![x](./docs/a.png)` inside `/srv/app/README.md` names
 * `/srv/app/docs/a.png`). Lives here rather than in the preview because it is
 * exactly the separator-aware path work this module exists to keep in one place.
 *
 * `rel` may itself be absolute (POSIX, drive-absolute or UNC), in which case `dir`
 * is ignored — the same rule a shell applies. Otherwise `dir` must be absolute:
 * resolving against a bare relative directory would invent a root.
 *
 * Returns null rather than a best guess when the reference cannot name a file:
 * empty input, a non-absolute `dir`, or a `..` chain climbing past the root.
 * Clamping `..` at the root (the tempting no-op) would silently resolve to a
 * *different, existing* file — the worst of the three outcomes, because it looks
 * like success.
 */
export function resolveRelative(dir: string, rel: string): string | null {
  const target = rel.trim();
  if (!target) return null;
  const absolute = target.startsWith("/") || isWindowsPath(target);
  if (!absolute && !(dir.startsWith("/") || isWindowsPath(dir))) return null;
  const base = absolute ? target : joinPath(trimTrailing(dir), target);

  // Split off the part that `..` must never eat. Each root shape keeps its own
  // spelling: `\\srv\share`, `C:` + separator, or POSIX `/`.
  const s = sep(base);
  const unc = /^(\\\\[^\\/]+[\\/][^\\/]+)(?:[\\/](.*))?$/.exec(base);
  const drive = /^([A-Za-z]:)[\\/]?(.*)$/.exec(base);
  let prefix: string;
  let rest: string;
  if (unc) {
    prefix = unc[1] + s;
    rest = unc[2] ?? "";
  } else if (drive) {
    prefix = drive[1] + s;
    rest = drive[2] ?? "";
  } else if (base.startsWith("/")) {
    prefix = "/";
    rest = base.slice(1);
  } else {
    return null;
  }

  const out: string[] = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // climbed above the root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length > 0 ? prefix + out.join(s) : prefix;
}

/**
 * Clean up a path the user typed or pasted into the panel's path bar (Phase 39.2),
 * returning null when there is nothing usable. Deliberately forgiving, because the
 * realistic inputs are pastes rather than careful typing:
 *
 *   * Explorer's "Copy as path" wraps the result in double quotes, and a shell
 *     copy-paste can arrive single-quoted — both are stripped, since no one means
 *     to open a directory whose name literally starts with a quote;
 *   * `~` and `~/x` expand against `home` when one is known (a habit users bring
 *     from the terminal next to the panel);
 *   * a trailing separator is dropped, except at a root where it is part of the
 *     path (`C:\`), so `C:\Users\` and `C:\Users` mean the same thing;
 *   * repeated separators collapse — except a leading `\\`, which is a UNC prefix
 *     and is load-bearing.
 *
 * Existence is NOT checked here: that needs the filesystem, and the panel's normal
 * load path already surfaces a failure as an inline error. This function's job is
 * only to turn plausible human input into a path worth attempting.
 */
export function normalizeInputPath(raw: string, home?: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  // Strip one matching pair of surrounding quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
    if (!s) return null;
  }
  // Tilde expansion, only when we know where home is.
  if (home && (s === "~" || s.startsWith("~/") || s.startsWith("~\\"))) {
    const rest = s.slice(1).replace(/^[\\/]/, "");
    s = rest ? joinPath(home, rest) : home;
  }
  // Collapse repeated separators, preserving a leading UNC `\\`.
  const uncPrefix = /^\\\\/.test(s);
  const body = uncPrefix ? s.slice(2) : s;
  const collapsed = body.replace(/\/{2,}/g, "/").replace(/\\{2,}/g, "\\");
  s = uncPrefix ? `\\\\${collapsed}` : collapsed;
  if (!s) return null;
  // A bare drive letter means that drive's root, not the current dir on it.
  if (/^[A-Za-z]:$/.test(s)) return `${s}\\`;
  return isRoot(s) ? s : trimTrailing(s);
}
