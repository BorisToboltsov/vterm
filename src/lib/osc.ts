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
