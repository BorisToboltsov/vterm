// Utilities → access check: the rule builder above the rules box and the
// per-line delete beside it (v1.0.37). Pure (INVARIANTS "чистая логика в .ts"):
// the component only binds these to inputs and the textarea.
//
// The builder never has its own idea of a valid rule — it writes one line and
// asks `parseRules`, so a rule the box would reject can't be added through it.

import { parseRules, type ParseError, type Proto } from "./netcheck";

export interface BuilderFields {
  /** The checking host's address the traffic should come from; "" = none. */
  source: string;
  target: string;
  /** As typed: `22`, `22, 443`, `8000-8010`. */
  ports: string;
  proto: Proto;
}

/** Ports as the rule syntax writes them: one bare, several in brackets. */
function portsPart(raw: string): string {
  const toks = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return toks.length === 1 ? toks[0] : `[${toks.join(", ")}]`;
}

/** The rule line the builder would add, e.g. `10.0.0.1 -> db:[22, 443]/tcp`. */
export function buildRuleLine(f: BuilderFields): string {
  const src = f.source.trim();
  const body = `${f.target.trim()}:${portsPart(f.ports)}/${f.proto}`;
  return src ? `${src} -> ${body}` : body;
}

/** Whether both required fields hold something — the Add button's gate. */
export function builderFilled(f: BuilderFields): boolean {
  return f.target.trim() !== "" && f.ports.trim() !== "";
}

/** Why the builder's line would be rejected, or null when it parses. Only asked
 *  once both fields are filled: a half-typed rule isn't an error yet. */
export function builderError(f: BuilderFields): ParseError | null {
  if (!builderFilled(f)) return null;
  return parseRules(buildRuleLine(f)).errors[0] ?? null;
}

/**
 * A pasted/typed `host:ports` in the address field — split it across the two
 * fields. Null when there's no port part (then the text stays as typed).
 */
export function splitHostPort(raw: string): { target: string; ports: string } | null {
  const m = /^\s*([^\s:[\]]+)\s*:\s*\[?([\d\s,;-]+?)\]?\s*$/.exec(raw);
  if (!m) return null;
  return { target: m[1], ports: m[2].trim() };
}

/** Append `line` to the rules text on a line of its own. */
export function appendRuleLine(text: string, line: string): string {
  if (!text.trim()) return line;
  return text.endsWith("\n") ? `${text}${line}` : `${text}\n${line}`;
}

/**
 * Which text line sits at a pointer offset. `y` is measured from the textarea's
 * content-box top (border and top padding already taken off); the box doesn't
 * wrap (`wrap="off"`), so every line is exactly `lineHeight` tall.
 */
export function lineAtY(y: number, scrollTop: number, lineHeight: number): number {
  if (lineHeight <= 0) return -1;
  const i = Math.floor((y + scrollTop) / lineHeight);
  return i < 0 ? -1 : i;
}

/** Whether line `index` exists and has something to delete. */
export function isDeletableLine(text: string, index: number): boolean {
  const lines = text.split("\n");
  return index >= 0 && index < lines.length && lines[index].trim() !== "";
}

/**
 * The character range that removes line `index` whole — its text plus one line
 * break (the following one, or the preceding one for the last line), so no blank
 * line is left behind. Null for a line that doesn't exist.
 */
export function lineRange(text: string, index: number): { start: number; end: number } | null {
  const lines = text.split("\n");
  if (index < 0 || index >= lines.length) return null;
  let start = 0;
  for (let i = 0; i < index; i++) start += lines[i].length + 1;
  let end = start + lines[index].length;
  if (index < lines.length - 1) end += 1;
  else if (index > 0) start -= 1;
  return { start, end };
}

/** `text` without line `index` — the fallback when the editor can't record undo. */
export function removeLine(text: string, index: number): string {
  const r = lineRange(text, index);
  return r ? text.slice(0, r.start) + text.slice(r.end) : text;
}
