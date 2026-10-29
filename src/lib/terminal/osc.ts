// Terminal shell-integration escape sequences. OSC 7 carries the shell's current
// working directory as a file URI (many shells emit it on `cd`, e.g. via vte.sh /
// PROMPT_COMMAND); we parse it to a plain path so the file panels can follow the
// terminal. Pure and framework-free — unit-tested without a terminal.

/**
 * Parse an OSC 7 payload into an absolute filesystem path, URL-decoding
 * percent-escapes. Accepts `file://host/path` (host ignored) or a bare absolute
 * path; normalises a Windows file URI (`/C:/…` → `C:/…`). Returns null when the
 * payload isn't a usable path (empty, relative, or malformed encoding).
 */
export function parseOsc7(data: string): string | null {
  if (!data) return null;
  let s = data.trim();
  const m = /^file:\/\/[^/]*(\/.*)$/i.exec(s);
  if (m) s = m[1];
  else if (!s.startsWith("/")) return null; // not an absolute path we can use
  try {
    s = decodeURIComponent(s);
  } catch {
    return null; // malformed percent-encoding
  }
  // Windows file URI leaves a leading slash before the drive: "/C:/Users" → "C:/Users".
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  return s.length > 0 ? s : null;
}

/**
 * Parse an OSC 9;9 payload into a filesystem path (Phase 39.3).
 *
 * OSC 9;9 is the Windows convention for reporting the shell's cwd — Windows
 * Terminal's shell integration emits it, and PowerShell profiles copied from
 * Microsoft's docs use it — because OSC 7 wants a `file://` URI, which is awkward
 * to build for `C:\…`. The payload arrives here as `9;<path>` (xterm.js strips the
 * leading `9;` identifier), and the path is a plain native path, frequently
 * wrapped in double quotes by the emitting profile.
 *
 * Returns null for anything that isn't a usable absolute path, so a stray OSC 9
 * of another subtype (9;4 is a progress indicator, for instance) is ignored
 * rather than sending the panel somewhere arbitrary.
 */
export function parseOsc9(payload: string): string | null {
  // Only subtype 9 carries a working directory.
  if (!payload.startsWith("9;")) return null;
  let s = payload.slice(2).trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1).trim();
  if (!s) return null;
  // Some emitters send a file:// URI here too; reuse the OSC 7 parsing for those.
  if (/^file:\/\//i.test(s)) return parseOsc7(s);
  // Accept a POSIX absolute path, a Windows drive path, or a UNC path — anything
  // relative would be meaningless without knowing what it is relative to.
  if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(s)) return null;
  return s;
}
