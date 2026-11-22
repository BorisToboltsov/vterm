// Statements of a SQL text (ADR 0080): where one ends and the next begins, read
// the way the database reads them — a `;` inside a string, a quoted name, a
// comment or a PostgreSQL dollar-quoted body is not an end. The console runs
// the statement under the caret, the selection, or all of them one by one: the
// backend takes one statement at a time.

export type Dialect = "postgres" | "mysql";

/** A statement of the text: its words, and where they stand in it. */
export interface Piece {
  text: string;
  from: number;
  to: number;
}

/** A token of a statement, for whoever reads its words (`sqlclass.ts`). */
export interface Token {
  kind: "word" | "quoted" | "string" | "number" | "punct";
  text: string;
  /** Parenthesis depth it stands at. */
  depth: number;
}

const isIdentStart = (c: string): boolean => /[A-Za-z_\u0080-￿]/.test(c);
const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(c);

/** The end of a dollar quote's opening `$tag$` at `i`, or -1 — not one (`$1` is a parameter). */
function dollarTag(src: string, i: number): string | null {
  if (src[i] !== "$") return null;
  if (i > 0 && isIdentChar(src[i - 1])) return null;
  let j = i + 1;
  if (src[j] === "$") return "$$";
  if (!src[j] || !isIdentStart(src[j]) || /[0-9]/.test(src[j])) return null;
  while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
  return src[j] === "$" ? src.slice(i, j + 1) : null;
}

/**
 * Walk the text: `onCode(i)` for each character of plain code (not inside a
 * string, quoted name or comment), `onSkip(from, to, kind)` for each such span.
 */
function walk(
  src: string,
  dialect: Dialect,
  onCode: (i: number) => void,
  onSkip: (from: number, to: number, kind: "string" | "quoted" | "comment") => void,
): void {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // Line comment: `--` (MySQL wants a space or the end after it), `#` in MySQL.
    if ((c === "-" && next === "-" && (dialect === "postgres" || !src[i + 2] || src[i + 2] <= " ")) || (c === "#" && dialect === "mysql")) {
      // PostgreSQL ends such a comment at a carriage return as well.
      let to = i;
      while (to < n && src[to] !== "\n" && !(dialect === "postgres" && src[to] === "\r")) to++;
      onSkip(i, to, "comment");
      i = to;
      continue;
    }
    // Block comment; PostgreSQL's nest.
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
        } else if (dialect === "postgres" && src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else j++;
      }
      onSkip(i, j, "comment");
      i = j;
      continue;
    }
    // Strings: '…' ('' inside); MySQL also "…" and backslash escapes; PostgreSQL E'…' too.
    if (c === "'" || (c === '"' && dialect === "mysql")) {
      const escapes = dialect === "mysql" || (i > 0 && /[eE]/.test(src[i - 1]) && (i < 2 || !isIdentChar(src[i - 2])));
      let j = i + 1;
      while (j < n) {
        if (escapes && src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          if (src[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const to = Math.min(n, j + 1);
      onSkip(i, to, "string");
      i = to;
      continue;
    }
    // Quoted names: "…" in PostgreSQL, `…` in MySQL; doubled to escape.
    if ((c === '"' && dialect === "postgres") || (c === "`" && dialect === "mysql")) {
      let j = i + 1;
      while (j < n) {
        if (src[j] === c) {
          if (src[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const to = Math.min(n, j + 1);
      onSkip(i, to, "quoted");
      i = to;
      continue;
    }
    if (dialect === "postgres" && c === "$") {
      const tag = dollarTag(src, i);
      if (tag) {
        const end = src.indexOf(tag, i + tag.length);
        const to = end < 0 ? n : end + tag.length;
        onSkip(i, to, "string");
        i = to;
        continue;
      }
    }
    onCode(i);
    i++;
  }
}

/** Whether a span holds anything but blanks and comments. */
function hasCode(src: string, from: number, to: number, dialect: Dialect): boolean {
  let found = false;
  const part = src.slice(from, to);
  walk(
    part,
    dialect,
    (i) => {
      if (!/\s/.test(part[i])) found = true;
    },
    (f, _t, kind) => {
      // MySQL's `/*! … */` is code.
      if (kind !== "comment" || (dialect === "mysql" && /^\/\*M?!/.test(part.slice(f, f + 4)))) found = true;
    },
  );
  return found;
}

/** The statements of a text, each without its `;`, blanks around it trimmed. */
export function splitSql(src: string, dialect: Dialect): Piece[] {
  const ends: number[] = [];
  walk(
    src,
    dialect,
    (i) => {
      if (src[i] === ";") ends.push(i);
    },
    () => {},
  );
  ends.push(src.length);
  const out: Piece[] = [];
  let start = 0;
  for (const end of ends) {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(src[from])) from++;
    while (to > from && /\s/.test(src[to - 1])) to--;
    if (to > from && hasCode(src, from, to, dialect)) out.push({ text: src.slice(from, to), from, to });
    start = end + 1;
  }
  return out;
}

/**
 * The statement a caret at `pos` stands in: the one around it, or the one it
 * just left (after its `;`, on blanks after it); before the first — the first.
 */
export function statementAt(pieces: readonly Piece[], pos: number): Piece | null {
  if (pieces.length === 0) return null;
  let best: Piece | null = null;
  for (const p of pieces) {
    if (p.from <= pos && pos <= p.to + 1) return p;
    if (p.to < pos) best = p;
  }
  return best ?? pieces[0];
}

/** A name as written, as its parts: `public."Order"` → public, Order. */
export function nameParts(written: string): string[] {
  const parts = written.match(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|[^."`]+/g) ?? [];
  return parts.map((part) =>
    part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part.startsWith("`") ? part.slice(1, -1).replaceAll("``", "`") : part,
  );
}

/**
 * Where a character the database counted (1-based, by code points) stands in a
 * JS string, which counts UTF-16 units: an emoji before it is two.
 */
export function offsetOfChar(text: string, pos: number): number {
  let at = 0;
  for (let n = 1; n < pos && at < text.length; n++) at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
  return at;
}

/** The tokens of one statement: words, quoted names, strings, numbers, punctuation. */
export function tokens(src: string, dialect: Dialect): Token[] {
  const out: Token[] = [];
  let depth = 0;
  let word = "";
  let wordKind: "word" | "number" = "word";
  const flush = () => {
    if (word) out.push({ kind: wordKind, text: word, depth });
    word = "";
  };
  walk(
    src,
    dialect,
    (i) => {
      const c = src[i];
      // A dot continues a name — after a word, or right after a quoted name.
      if (isIdentChar(c) || (c === "." && (word !== "" || src[i - 1] === '"' || src[i - 1] === "`"))) {
        if (!word) wordKind = /[0-9]/.test(c) ? "number" : "word";
        word += c;
        return;
      }
      flush();
      if (/\s/.test(c)) return;
      if (c === "(") {
        out.push({ kind: "punct", text: c, depth });
        depth++;
        return;
      }
      if (c === ")") {
        depth = Math.max(0, depth - 1);
        out.push({ kind: "punct", text: c, depth });
        return;
      }
      out.push({ kind: "punct", text: c, depth });
    },
    (from, to, kind) => {
      if (kind === "comment") {
        flush();
        return;
      }
      // A quoted name glued to a word with a dot is one name: `public."Order"`.
      const text = src.slice(from, to);
      if (kind === "quoted" && word.endsWith(".")) {
        word += text;
        return;
      }
      flush();
      out.push({ kind: kind === "quoted" ? "quoted" : "string", text, depth });
    },
  );
  flush();
  // A dot after a quoted name continues it: `"Sales".orders`.
  const merged: Token[] = [];
  for (const t of out) {
    const last = merged[merged.length - 1];
    if (last && last.kind === "quoted" && t.kind === "word" && t.text.startsWith(".")) {
      last.text += t.text;
      continue;
    }
    merged.push(t);
  }
  return merged;
}
