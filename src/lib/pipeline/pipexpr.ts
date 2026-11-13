// Conditions of a pipeline evaluated for an event (ADR 0068): GitHub's
// `if:` expressions and GitLab's `rules: if:`. Three-valued — a value the file
// does not decide (a secret, a project variable, the files a push changed) is
// UNKNOWN, and it stays unknown through `&&`/`||` unless the other side settles
// the answer (`false && ?` is false). Each unknown is named, so the reason can
// say what the answer hangs on. No `eval`, no `Function`: a hand-written parser.

export const UNKNOWN = Symbol("unknown");
export type ExprValue = string | number | boolean | null | typeof UNKNOWN | Record<string, unknown>;

export interface ExprResult {
  value: ExprValue;
  /** What the value hangs on, when it is unknown. */
  unknowns: string[];
  /** The text did not parse. */
  invalid: boolean;
}

/** True, false or unknown, the way an `if:` reads a value. */
export function truth(v: ExprValue): boolean | typeof UNKNOWN {
  if (v === UNKNOWN) return UNKNOWN;
  if (v === null || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v))) return false;
  return true;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

type Tok =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

function ghTokens(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) return null;
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ t: "str", v: s });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("()[].,!<>*".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    const num = /^(0x[0-9a-f]+|-?\d+(\.\d+)?(e[+-]?\d+)?)/i.exec(src.slice(i));
    if (num && !/[A-Za-z_]/.test(src[i + num[0].length] ?? "")) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (!id) return null;
    out.push({ t: "id", v: id[0] });
    i += id[0].length;
  }
  return out;
}

/** What a GitHub expression may ask of the run. */
export interface GhScope {
  /** A context value by path (`github.ref`, `env.X`, `needs.build.result`): UNKNOWN when not known. */
  lookup(path: string[]): ExprValue;
  /** `success()` — whether everything the job needs succeeded. */
  success: ExprValue;
}

const lower = (v: ExprValue): ExprValue => (typeof v === "string" ? v.toLowerCase() : v);

function toNum(v: ExprValue): number {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return Number.NaN;
}

/** GitHub's loose equality: strings ignoring case, other types as numbers. */
function ghEquals(a: ExprValue, b: ExprValue): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b;
  return toNum(a) === toNum(b);
}

/** Strip a wrapping `${{ … }}`. */
export const unwrapExpr = (src: string): string => {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(src);
  return m ? m[1] : src;
};

/** Whether an `if:` names a status function — then no implicit `success() &&` is added. */
export const hasStatusCheck = (src: string): boolean => /\b(always|success|failure|cancelled)\s*\(/.test(src);

export function evalGithub(src: string, scope: GhScope): ExprResult {
  const unknowns: string[] = [];
  const toks = ghTokens(unwrapExpr(src));
  if (!toks || toks.length === 0) return { value: UNKNOWN, unknowns: ["if"], invalid: true };
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => peek()?.t === "op" && peek()?.v === v;
  const fail = (): never => {
    throw new SyntaxError("bad expression");
  };
  const unknown = (what: string): ExprValue => {
    if (!unknowns.includes(what)) unknowns.push(what);
    return UNKNOWN;
  };
  const call = (name: string, args: ExprValue[]): ExprValue => {
    const fn = name.toLowerCase();
    if (fn === "always") return true;
    if (fn === "success") return scope.success;
    if (fn === "failure" || fn === "cancelled") return false;
    if (args.some((a) => a === UNKNOWN)) return UNKNOWN;
    const [a, b] = args;
    if (fn === "startswith") return String(lower(a)).startsWith(String(lower(b)));
    if (fn === "endswith") return String(lower(a)).endsWith(String(lower(b)));
    if (fn === "contains") {
      if (Array.isArray(a)) return a.some((x) => ghEquals(x as ExprValue, b));
      return String(lower(a)).includes(String(lower(b)));
    }
    if (fn === "format" && typeof a === "string") return a.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n) + 1] ?? ""));
    return unknown(`${name}()`);
  };
  const primary = (): ExprValue => {
    const tok = peek();
    if (!tok) fail();
    i++;
    if (tok.t === "str") return tok.v;
    if (tok.t === "num") return tok.v;
    if (tok.t === "op" && tok.v === "(") {
      const v = or();
      if (!isOp(")")) fail();
      i++;
      return v;
    }
    if (tok.t !== "id") fail();
    const name = (tok as { v: string }).v;
    if (name === "true") return true;
    if (name === "false") return false;
    if (name === "null") return null;
    if (isOp("(")) {
      i++;
      const args: ExprValue[] = [];
      while (!isOp(")")) {
        args.push(or());
        if (isOp(",")) i++;
        else if (!isOp(")")) fail();
      }
      i++;
      return call(name, args);
    }
    const path = [name];
    let dynamic = false;
    for (;;) {
      if (isOp(".")) {
        i++;
        const next = peek();
        if (next?.t === "id") path.push(next.v);
        else if (next?.t === "op" && next.v === "*") dynamic = true;
        else fail();
        i++;
      } else if (isOp("[")) {
        i++;
        const key = or();
        if (!isOp("]")) fail();
        i++;
        if (typeof key === "string" || typeof key === "number") path.push(String(key));
        else dynamic = true;
      } else break;
    }
    if (dynamic) return unknown(path.join("."));
    const v = scope.lookup(path);
    return v === UNKNOWN ? unknown(path.join(".")) : v;
  };
  const unary = (): ExprValue => {
    if (isOp("!")) {
      i++;
      const t = truth(unary());
      return t === UNKNOWN ? UNKNOWN : !t;
    }
    return primary();
  };
  const compare = (): ExprValue => {
    let left = unary();
    while (peek()?.t === "op" && ["<", ">", "<=", ">="].includes(peek()!.v as string)) {
      const op = (toks[i++] as { v: string }).v;
      const right = unary();
      if (left === UNKNOWN || right === UNKNOWN) left = UNKNOWN;
      else {
        const [a, b] = typeof left === "string" && typeof right === "string" ? [left.toLowerCase(), right.toLowerCase()] : [toNum(left), toNum(right)];
        left = op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
      }
    }
    return left;
  };
  const equality = (): ExprValue => {
    let left = compare();
    while (isOp("==") || isOp("!=")) {
      const op = (toks[i++] as { v: string }).v;
      const right = compare();
      left = left === UNKNOWN || right === UNKNOWN ? UNKNOWN : op === "==" ? ghEquals(left, right) : !ghEquals(left, right);
    }
    return left;
  };
  const and = (): ExprValue => {
    let left = equality();
    while (isOp("&&")) {
      i++;
      const right = equality();
      const l = truth(left);
      if (l === false) continue;
      left = l === UNKNOWN ? (truth(right) === false ? right : UNKNOWN) : right;
    }
    return left;
  };
  const or = (): ExprValue => {
    let left = and();
    while (isOp("||")) {
      i++;
      const right = and();
      const l = truth(left);
      if (l === true) continue;
      left = l === UNKNOWN ? (truth(right) === true ? right : UNKNOWN) : right;
    }
    return left;
  };
  try {
    const value = or();
    if (i < toks.length) fail();
    return { value, unknowns: value === UNKNOWN ? unknowns : [], invalid: false };
  } catch {
    return { value: UNKNOWN, unknowns: ["if"], invalid: true };
  }
}

// ── GitLab ───────────────────────────────────────────────────────────────────

type GlTok =
  | { t: "var"; v: string }
  | { t: "str"; v: string }
  | { t: "re"; v: string; flags: string }
  | { t: "null" }
  | { t: "op"; v: string };

/** A pattern longer than this, or one that nests quantifiers, is not run: the text is untrusted. */
const MAX_PATTERN = 200;
const RISKY_PATTERN = /\([^)]*[+*][^)]*\)\s*[+*{]/;

/**
 * Whether a pattern from the file is too risky to run: too long, or a group
 * with a quantifier inside that is itself quantified (`(a+)+`), the shape that
 * backtracks exponentially on a short name.
 */
export const riskyPattern = (body: string): boolean => body.length > MAX_PATTERN || RISKY_PATTERN.test(body);

/** A GitLab `/pattern/flags` as a RegExp, or null when it is too risky or not valid. */
export function safeRegex(body: string, flags: string): RegExp | null {
  if (riskyPattern(body)) return null;
  try {
    return new RegExp(body, flags.replace(/[^imsu]/g, ""));
  } catch {
    return null;
  }
}

function glTokens(src: string): GlTok[] | null {
  const out: GlTok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const two = rest.slice(0, 2);
    if (["==", "!=", "=~", "!~", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    const v = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(rest);
    if (v) {
      out.push({ t: "var", v: v[1] ?? v[2] });
      i += v[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) return null;
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === "/") {
      let j = i + 1;
      while (j < src.length && src[j] !== "/") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return null;
      const flags = /^[a-z]*/.exec(src.slice(j + 1))?.[0] ?? "";
      out.push({ t: "re", v: src.slice(i + 1, j), flags });
      i = j + 1 + flags.length;
      continue;
    }
    if (rest.startsWith("null")) {
      out.push({ t: "null" });
      i += 4;
      continue;
    }
    return null;
  }
  return out;
}

/** Variables a GitLab expression may read: a value, null (not set), or UNKNOWN. */
export type GlVars = (name: string) => string | null | typeof UNKNOWN;

export function evalGitlab(src: string, vars: GlVars): ExprResult {
  const unknowns: string[] = [];
  const toks = glTokens(src);
  if (!toks || toks.length === 0) return { value: UNKNOWN, unknowns: ["if"], invalid: true };
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => {
    const t = peek();
    return t?.t === "op" && t.v === v;
  };
  const fail = (): never => {
    throw new SyntaxError("bad expression");
  };
  type Operand = { kind: "value"; v: string | null | typeof UNKNOWN } | { kind: "re"; re: RegExp | null; src: string };
  const operand = (): Operand => {
    const tok = peek();
    if (!tok) fail();
    i++;
    if (tok.t === "var") {
      const v = vars(tok.v);
      if (v === UNKNOWN && !unknowns.includes(`$${tok.v}`)) unknowns.push(`$${tok.v}`);
      return { kind: "value", v };
    }
    if (tok.t === "str") return { kind: "value", v: tok.v };
    if (tok.t === "null") return { kind: "value", v: null };
    if (tok.t === "re") return { kind: "re", re: safeRegex(tok.v, tok.flags), src: `/${tok.v}/` };
    fail();
    return { kind: "value", v: null };
  };
  const asRegex = (o: Operand): RegExp | null | typeof UNKNOWN => {
    if (o.kind === "re") return o.re;
    if (o.v === UNKNOWN) return UNKNOWN;
    if (o.v === null) return null;
    const m = /^\/(.*)\/([a-z]*)$/s.exec(o.v);
    return m ? safeRegex(m[1], m[2]) : null;
  };
  const comparison = (): ExprValue => {
    if (isOp("(")) {
      i++;
      const v = or();
      if (!isOp(")")) fail();
      i++;
      return v;
    }
    const left = operand();
    const op = peek();
    if (op?.t === "op" && ["==", "!=", "=~", "!~"].includes(op.v)) {
      i++;
      const right = operand();
      if (op.v === "==" || op.v === "!=") {
        const a = left.kind === "value" ? left.v : left.src;
        const b = right.kind === "value" ? right.v : right.src;
        if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
        return op.v === "==" ? a === b : a !== b;
      }
      const subject = left.kind === "value" ? left.v : null;
      const re = asRegex(right);
      if (subject === UNKNOWN || re === UNKNOWN) return UNKNOWN;
      if (re === null) {
        if (!unknowns.includes("regex")) unknowns.push("regex");
        return UNKNOWN;
      }
      const hit = subject !== null && re.test(subject.slice(0, 1024));
      return op.v === "=~" ? hit : !hit;
    }
    // A variable alone: set and not empty.
    if (left.kind !== "value") return true;
    return left.v === UNKNOWN ? UNKNOWN : left.v !== null && left.v !== "";
  };
  const and = (): ExprValue => {
    let left = comparison();
    while (isOp("&&")) {
      i++;
      const right = comparison();
      const l = truth(left);
      if (l === false) continue;
      left = l === UNKNOWN ? (truth(right) === false ? false : UNKNOWN) : right;
    }
    return left;
  };
  const or = (): ExprValue => {
    let left = and();
    while (isOp("||")) {
      i++;
      const right = and();
      const l = truth(left);
      if (l === true) continue;
      left = l === UNKNOWN ? (truth(right) === true ? true : UNKNOWN) : right;
    }
    return left;
  };
  try {
    const value = or();
    if (i < toks.length) fail();
    return { value, unknowns: value === UNKNOWN ? unknowns : [], invalid: false };
  } catch {
    return { value: UNKNOWN, unknowns: ["if"], invalid: true };
  }
}

/**
 * A GitHub branch/tag filter (`main`, `release/**`, `v*`, `!skip`) as a test.
 * `*` stays within one path segment, `**` crosses them, `?` is one character,
 * `+` repeats the one before it, `[…]` is a set; a later `!pattern` removes
 * what an earlier one let in.
 */
export function ghRefFilter(patterns: readonly string[]): (ref: string) => boolean {
  const compile = (p: string): RegExp => {
    let re = "";
    for (let k = 0; k < p.length; k++) {
      const c = p[k];
      if (c === "*") {
        if (p[k + 1] === "*") {
          re += ".*";
          k++;
        } else re += "[^/]*";
      } else if (c === "?") re += ".";
      else if (c === "+") re += "+";
      else if (c === "[") {
        const end = p.indexOf("]", k);
        if (end < 0) re += "\\[";
        else {
          re += `[${p.slice(k + 1, end).replace(/[\\^]/g, "\\$&")}]`;
          k = end;
        }
      } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
  };
  const rules = patterns.map((p) => (p.startsWith("!") ? { neg: true, re: compile(p.slice(1)) } : { neg: false, re: compile(p) }));
  return (ref) => {
    let ok = false;
    for (const r of rules) if (r.re.test(ref)) ok = !r.neg;
    return ok;
  };
}
