// Utilities → access check: reading a pasted request (v1.21, ADR 0032). Access
// requests arrive as whatever the requester had at hand — a table copied from
// Excel, Confluence or Google Sheets (tab-separated), a Markdown or CSV table, a
// ticket form ("Источник: …" on its own line), arrow lines, a sentence from a
// chat ("с 10.0.0.1 на 10.0.0.5 порт 443"). `recognize` turns any of those into
// rule drafts — the four cells of the rules table — and says, line by line, what
// it took, what it skipped and what it guessed, so nothing is invented silently
// (principle 5): the UI marks the taken tokens in the original text.
//
// It never decides what a valid rule is: a draft is cells as text, and the table
// asks `parseRules` (via netcheckform.ts) like any typed rule.
//
// Pure (INVARIANTS "чистая логика в .ts").

import {
  isCidr,
  isIpv4,
  normalizeRuleLine,
  parseRules,
  servicePort,
  type NetRule,
  type Proto,
} from "./netcheck";

/** One rule as the rules table holds it: its cells, as text. */
export interface RuleDraft {
  /** Sources — addresses, subnets or server names; "" = the tab the tool runs on. */
  source: string;
  targets: string;
  ports: string;
  proto: Proto;
}

export type LineKind = "rule" | "header" | "skipped" | "blank";

/**
 * Something the reader of the paste should know about a line:
 * sourceByOrder — no "from"/"to" words, so the first address was taken as the
 *   source; portByName — a port came from a service name (`https` → 443);
 * noPorts — the rule has no ports yet (the table cell is left to fill);
 * noTarget — addresses, but nothing to connect to; nothing — no address at all;
 * udpOnly — the protocol said UDP, which can't be checked.
 */
export type PasteNote = "sourceByOrder" | "portByName" | "noPorts" | "noTarget" | "nothing" | "udpOnly";

export type MarkKind = "addr" | "port" | "proto";

/** A taken token in the line's original text: `[start, end)`. */
export interface Mark {
  start: number;
  end: number;
  kind: MarkKind;
}

export interface PasteLine {
  /** 1-based, in the pasted text. */
  line: number;
  text: string;
  kind: LineKind;
  marks: Mark[];
  notes: PasteNote[];
  /** Indexes into `rules` of what this line gave (a form's fields share one). */
  rules: number[];
}

export interface PasteResult {
  rules: RuleDraft[];
  lines: PasteLine[];
}

// ── Words ────────────────────────────────────────────────────────────────────

type Role = "source" | "target" | "port" | "proto" | "note";

// Column and field names, by the start of a word: Russian declines nouns
// (источник, источника, источники), so a stem matches every form. Short English
// words match whole, or "protocol" would read as "to".
const ROLE_WORDS: [Role, RegExp][] = [
  ["source", /^(источник|откуда$|src$|source|from$|клиент|client|инициатор|отправител|sender)/],
  ["target", /^(назначени|куда$|получател|dst$|dest|target|to$|сервер$|server$|хост$|host$|адресат)/],
  ["port", /^(порт|port|сервис|service)/],
  ["proto", /^(протокол|proto|transport)/],
  ["note", /^(описани|коммент|comment|descr|note|примечани|обосновани)/],
];

/** Roles a header cell or a field name names: by its words, in role order. */
function roleOf(name: string): Role | null {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/-]/gu, " ")
    .split(/[\s/-]+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;
  for (const [role, re] of ROLE_WORDS) if (words.some((w) => re.test(w))) return role;
  return null;
}

// Words in a sentence that say what the next address is.
const SOURCE_MARK = /^(с|со|from|src|source|источник\p{L}*|от|из|откуда)$/u;
const TARGET_MARK = /^(на|to|dst|destination|назначени\p{L}*|до|к|ко|target|куда)$/u;
const PORT_MARK = /^(порт\p{L}*|port|ports|по)$/u;
// Words that sit between a marker and its address without being one.
const FILLER = /^(сервер\p{L}*|хост\p{L}*|машин\p{L}*|server|host|ip|адрес\p{L}*|address|узл\p{L}*|node)$/u;

// A hostname that can stand alone in a sentence: dotted, its last label not all
// digits (`4.2`, `v1.2` aren't hosts).
const DOTTED_HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z][A-Za-z0-9-]*$/;
// Any hostname, for a word a marker or a column says is an address.
const ANY_HOST = /^(?=.{1,253}$)(?=.*[A-Za-z])[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
// "From anywhere": not an address, and no server to check from either.
const ANY_WORD = /^(any|all|anywhere|internet|любой|любая|любые|все|всё|интернет|0\.0\.0\.0\/0)$/;

// Four dotted numbers are meant as an address even when one is out of range
// (`10.70.39.300`): taken, the table names the typo; skipped, it would vanish.
const IP_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;

function isAddr(word: string): boolean {
  return isIpv4(word) || isCidr(word) || IP_LIKE.test(word) || DOTTED_HOST.test(word);
}

// ── Tokens ───────────────────────────────────────────────────────────────────

interface Tok {
  text: string;
  start: number;
  end: number;
  /** Inside parentheses: a note, never an address of its own. */
  paren: boolean;
}

/** Words and the punctuation that matters, with their positions in `line`. */
function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let depth = 0;
  // Arrows a sentence writes (`->`, `—>`, `=>`, `→`, `➜`) all read as `->`.
  const re =
    /(\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?)|([\p{L}\p{N}][\p{L}\p{N}._-]*)|([-‐‑‒–—―−=]+\s?>|[→⟶⟹⇒⇨➔➙➛➜➝➞➟➠➡➤⭢]\ufe0f?|[,;:()[\]/|])/gu;
  for (const m of line.matchAll(re)) {
    const text = m[3] && /[>→⟶⟹⇒⇨➔➙➛➜➝➞➟➠➡➤⭢]/.test(m[3]) ? "->" : m[0];
    const start = m.index ?? 0;
    if (text === "(") depth++;
    if (text === ")") depth = Math.max(0, depth - 1);
    // A word ending in a dot ("порт 443.") — the dot is the sentence's.
    const trimmed = m[2] ? text.replace(/[._-]+$/, "") : text;
    const end = text === "->" ? start + m[0].length : start + trimmed.length;
    out.push({ text: trimmed, start, end, paren: depth > 0 && text !== "(" });
  }
  return out;
}

/** A port token: a number, a range or a service name; the ports it gives. */
function portOf(word: string): { ports: string; named: boolean } | null {
  if (/^\d{1,5}$/.test(word) && Number(word) >= 1 && Number(word) <= 65535) return { ports: word, named: false };
  if (/^\d{1,5}-\d{1,5}$/.test(word)) return { ports: word, named: false };
  const named = servicePort(word);
  return named === null ? null : { ports: word.toLowerCase(), named: true };
}

const PROTO = /^(tcp|udp)$/i;

// ── Cells (a table column or a form field) ─────────────────────────────────

interface Taken {
  addrs: string[];
  /** Words that weren't addresses: the cell's note. */
  label: string;
  marks: Mark[];
}

/**
 * The addresses in a cell that is known to hold addresses: IPs, subnets and
 * dotted names anywhere (a name before `(10.0.0.5)` is then the note); when it
 * has none of those, plain names outside parentheses.
 */
function cellAddrs(cell: string, offset: number): Taken {
  const toks = tokenize(cell).filter(
    (t) => !/^[,;:()[\]/|]$/.test(t.text) && t.text !== "->" && !ANY_WORD.test(t.text.toLowerCase()),
  );
  const strong = toks.filter((t) => isAddr(t.text));
  const picked = strong.length > 0 ? strong : toks.filter((t) => !t.paren && ANY_HOST.test(t.text) && !FILLER.test(t.text.toLowerCase()));
  const rest = toks.filter((t) => !picked.includes(t)).map((t) => t.text);
  return {
    addrs: [...new Set(picked.map((t) => t.text))],
    label: rest.join(" "),
    marks: picked.map((t) => ({ start: offset + t.start, end: offset + t.end, kind: "addr" as const })),
  };
}

interface PortsTaken {
  ports: string[];
  proto: Proto | null;
  named: boolean;
  marks: Mark[];
}

/** Ports and protocol in a port cell or a sentence's tail: `443/tcp`, `TCP 5432`, `ssh, https`. */
function cellPorts(toks: Tok[], offset: number): PortsTaken {
  const out: PortsTaken = { ports: [], proto: null, named: false, marks: [] };
  for (const t of toks) {
    if (t.paren) continue;
    if (PROTO.test(t.text)) {
      // Both named ("TCP/UDP"): TCP is the one that can be checked.
      out.proto = out.proto === "tcp" ? "tcp" : (t.text.toLowerCase() as Proto);
      out.marks.push({ start: offset + t.start, end: offset + t.end, kind: "proto" });
      continue;
    }
    const p = portOf(t.text);
    if (!p) continue;
    if (!out.ports.includes(p.ports)) out.ports.push(p.ports);
    out.named ||= p.named;
    out.marks.push({ start: offset + t.start, end: offset + t.end, kind: "port" });
  }
  return out;
}

const withLabel = (addrs: string[], label: string) =>
  addrs.length === 0 ? "" : addrs.join(", ") + (label ? ` (${label})` : "");

// ── Lines ────────────────────────────────────────────────────────────────────

/** Split a table line into cells with their offsets; null when it isn't one. */
function cellsOf(line: string, sep: Sep): { text: string; start: number }[] | null {
  let body = line;
  let shift = 0;
  if (sep === "|") {
    const lead = line.indexOf("|");
    if (lead < 0) return null;
    if (line.slice(0, lead).trim() === "") {
      body = line.slice(lead + 1);
      shift = lead + 1;
    }
    body = body.replace(/\|\s*$/, "");
  }
  if (!body.includes(sep)) return null;
  const cells: { text: string; start: number }[] = [];
  let at = 0;
  for (const part of body.split(sep)) {
    cells.push({ text: part, start: shift + at });
    at += part.length + 1;
  }
  return cells;
}

type Sep = "\t" | "|" | ";" | ",";

/** A header line: the role of each column, or null. Needs two named columns,
 *  one of them an address column, and no address in the line itself. */
function headerOf(line: string): { sep: Sep; roles: (Role | null)[] } | null {
  for (const sep of ["\t", "|", ";", ","] as Sep[]) {
    const cells = cellsOf(line, sep);
    if (!cells || cells.length < 2) continue;
    const roles = cells.map((c) => roleOf(c.text));
    const named = new Set(roles.filter(Boolean));
    if (named.size < 2 || (!named.has("source") && !named.has("target"))) continue;
    if (tokenize(line).some((t) => isAddr(t.text))) continue;
    return { sep, roles };
  }
  return null;
}

/** `Источник: 10.0.0.1` — a ticket form's field on its own line. A line with
 *  several fields (`Источник: a, Назначение: b`) is a sentence, not a field. */
function fieldOf(line: string): { role: Role; value: string; start: number } | null {
  const m = /^(\s*)([^:=\d][^:=]{0,40}?)(\s*[:=]\s*)(.*\S)\s*$/.exec(line);
  if (!m) return null;
  const role = roleOf(m[2]);
  if (!role) return null;
  for (const more of m[4].matchAll(/(?:^|[,;])\s*([^:=,;]{1,40}?)\s*[:=]/g)) {
    if (roleOf(more[1])) return null;
  }
  return { role, value: m[4], start: m[1].length + m[2].length + m[3].length };
}

/** A canonical rule line (an arrow and `host:ports`): the parser's own reading. */
function arrowLine(line: string): RuleDraft | null {
  if (!/->/.test(normalizeRuleLine(line))) return null;
  const { rules, errors } = parseRules(line);
  if (errors.length || rules.length === 0) return null;
  return draftOf(rules);
}

/** The cells of the rules one canonical line parsed into (several sources = one draft). */
function draftOf(rules: NetRule[]): RuleDraft {
  const first = rules[0];
  const sources = rules.map((r) => r.source).filter((s): s is string => !!s);
  const note = (n?: string) => (n ? ` (${n})` : "");
  return {
    source: sources.length ? sources.join(", ") + note(first.sourceLabel) : "",
    targets: first.targets.join(", ") + note(first.label),
    ports: first.ports.join(", "),
    proto: first.proto,
  };
}

/** Marks of the addresses and ports a canonical line holds, found in its text. */
function marksIn(line: string): Mark[] {
  const marks: Mark[] = [];
  let afterColon = false;
  for (const t of tokenize(line)) {
    if (t.text === ":") afterColon = true;
    if (t.paren) continue;
    if (isAddr(t.text) || (!afterColon && ANY_HOST.test(t.text) && !PROTO.test(t.text))) {
      marks.push({ start: t.start, end: t.end, kind: "addr" });
    } else if (afterColon && portOf(t.text)) marks.push({ start: t.start, end: t.end, kind: "port" });
    else if (PROTO.test(t.text)) marks.push({ start: t.start, end: t.end, kind: "proto" });
  }
  return marks;
}

interface Sentence {
  drafts: RuleDraft[];
  marks: Mark[];
  notes: PasteNote[];
}

/**
 * A free-text line. Addresses are IPs, subnets, dotted names, `name:port`, and
 * plain names right after "с/from" or "на/to". Who is the source: the address
 * after a "from" word; without such words, the first of two address groups
 * (separated by more than a comma) — and the line says so. Ports: after a port
 * word, after `host:`, a bare number right after an address, `443/tcp`, a
 * service name anywhere. `a:22, b:80` is two rules, not a:80 and b:22.
 */
function sentence(line: string): Sentence {
  const toks = tokenize(line);
  const sources: Tok[] = [];
  const targets: Tok[] = [];
  const loose: Tok[][] = [];
  const portToks: Tok[] = [];
  // `host:ports` written together: each target with its own ports.
  const pairs = new Map<string, Tok[]>();
  let pairOf: string | null = null;
  const labels: string[] = [];
  // Addresses written with a port: a target, whatever their place in the line.
  const withPort = new Set<string>();
  let mode: "source" | "target" | "port" | null = null;
  let group: Tok[] | null = null;
  // A plain name is an address only where one is expected: right after a
  // marker or a comma in a marked list.
  let expect = false;
  let last: "addr" | "port" | "proto" | "sep" | null = null;
  // Plain names not taken yet: the last one, or a comma list of them.
  let weakRun: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const low = t.text.toLowerCase();
    if (t.paren) {
      // "(TCP)" says the protocol; any other word in parentheses is a note.
      if (PROTO.test(t.text)) portToks.push(t);
      else if (t.text !== ")" && !/^[,;:]$/.test(t.text)) labels.push(t.text);
      continue;
    }
    if (t.text === ")" || t.text === "(") continue;
    if (t.text === "," || t.text === ";" || low === "и" || low === "and" || t.text === "[" || t.text === "]") {
      if (mode === "source" || mode === "target") expect = true;
      continue;
    }
    if (SOURCE_MARK.test(low)) {
      [mode, group, expect, last, pairOf] = ["source", null, true, "sep", null];
      continue;
    }
    if (TARGET_MARK.test(low) || t.text === "->") {
      // What came before "to" / an arrow, unmarked, is where it comes from;
      // right before an arrow, a plain name counts too (`app-01 -> db`).
      if (sources.length === 0) {
        for (const g of loose.splice(0)) for (const a of g) (withPort.has(a.text) ? targets : sources).push(a);
        if (sources.length === 0 && t.text === "->") sources.push(...weakRun);
      }
      weakRun = [];
      [mode, group, expect, last, pairOf] = ["target", null, true, "sep", null];
      continue;
    }
    if (PORT_MARK.test(low)) {
      // "по" alone is a preposition; it marks ports only before a port word.
      if (low === "по" && !PORT_MARK.test(toks[i + 1]?.text.toLowerCase() ?? "")) continue;
      [mode, expect, pairOf] = ["port", false, null];
      continue;
    }
    if (t.text === ":" || t.text === "/") {
      // `host:443`, `tcp/443`, `tcp:443`: what follows is a port.
      if (last === "addr" || last === "proto") mode = "port";
      continue;
    }
    if (FILLER.test(low) || ANY_WORD.test(low)) continue;
    if (mode === null && ANY_HOST.test(t.text) && !isAddr(t.text) && !PROTO.test(t.text) && !portOf(t.text)) {
      const prev = toks[i - 1]?.text;
      weakRun = prev === "," ? [...weakRun, t] : [t];
    } else if (t.text !== ",") weakRun = [];
    const explicitPort = toks[i + 1]?.text === ":" && /^\d/.test(toks[i + 2]?.text ?? "");
    const strong = isAddr(t.text);
    const weak = !strong && ANY_HOST.test(t.text) && !PROTO.test(t.text) && !portOf(t.text);
    if (strong || (weak && (explicitPort || expect))) {
      expect = false;
      last = "addr";
      pairOf = explicitPort ? t.text : null;
      if (explicitPort && !pairs.has(t.text)) pairs.set(t.text, []);
      if (explicitPort) withPort.add(t.text);
      if (mode === "source") sources.push(t);
      else if (mode === "target") targets.push(t);
      else {
        // No marker: groups split by anything but a comma.
        const prev = toks[i - 1];
        const joined = group && prev && (prev.text === "," || prev.text === ";" || /^(и|and)$/i.test(prev.text));
        if (!joined || !group) {
          group = [];
          loose.push(group);
        }
        group.push(t);
      }
      continue;
    }
    if (PROTO.test(t.text)) {
      portToks.push(t);
      [mode, last] = ["port", "proto"];
      continue;
    }
    const p = portOf(t.text);
    if (p) {
      const slashProto = toks[i + 1]?.text === "/" && PROTO.test(toks[i + 2]?.text ?? "");
      if (mode === "port" || p.named || slashProto || last === "addr" || last === "port") {
        portToks.push(t);
        if (pairOf) pairs.get(pairOf)!.push(t);
        last = "port";
      }
      continue;
    }
    // Any other word ends a list of ports and an unmarked group.
    if (mode === "port") mode = null;
    [group, expect, last, pairOf] = [null, false, null, null];
  }

  const notes: PasteNote[] = [];
  const firstIsSource =
    sources.length === 0 && targets.length === 0 && loose.length >= 2 && !loose[0].some((t) => withPort.has(t.text));
  if (firstIsSource) {
    sources.push(...loose[0]);
    targets.push(...loose.slice(1).flat());
    notes.push("sourceByOrder");
  } else targets.push(...loose.flat());
  targets.sort((a, b) => a.start - b.start);

  const marks: Mark[] = [...sources, ...targets].map((t) => ({ start: t.start, end: t.end, kind: "addr" as const }));
  const ports = cellPorts(portToks, 0);
  marks.push(...ports.marks);
  if (targets.length === 0) {
    notes.push(sources.length ? "noTarget" : "nothing");
    return { drafts: [], marks, notes };
  }
  if (ports.named) notes.push("portByName");
  if (ports.ports.length === 0) notes.push("noPorts");
  if (ports.proto === "udp") notes.push("udpOnly");
  const proto = ports.proto ?? "tcp";
  const source = withLabel(uniq(sources), "");
  const label = labels.join(" ");
  // Every target came with ports of its own, and they differ: a rule each.
  const own = uniq(targets).map((h) => pairs.get(h));
  const split = own.every((p) => p && p.length > 0) && new Set(own.map((p) => uniq(p!).join(","))).size > 1;
  if (split) {
    return {
      drafts: uniq(targets).map((h) => ({
        source,
        targets: withLabel([h], label),
        ports: cellPorts(pairs.get(h)!, 0).ports.join(", "),
        proto,
      })),
      marks,
      notes,
    };
  }
  return {
    drafts: [{ source, targets: withLabel(uniq(targets), label), ports: ports.ports.join(", "), proto }],
    marks,
    notes,
  };
}

const uniq = (toks: Tok[]) => [...new Set(toks.map((t) => t.text))];

/** A table row, its cells mapped by the header's columns. */
function tableRow(line: string, sep: Sep, roles: (Role | null)[]): Sentence | null {
  const cells = cellsOf(line, sep);
  if (!cells) return null;
  const marks: Mark[] = [];
  const notes: PasteNote[] = [];
  let source: Taken | null = null;
  let target: Taken | null = null;
  const portToks: Tok[] = [];
  cells.forEach((cell, i) => {
    const role = roles[i];
    if (role === "source" || role === "target") {
      const taken = cellAddrs(cell.text, cell.start);
      marks.push(...taken.marks);
      if (role === "source") source = taken;
      else target = taken;
    } else if (role === "port" || role === "proto") {
      portToks.push(...tokenize(cell.text).map((t) => ({ ...t, start: t.start + cell.start, end: t.end + cell.start })));
    }
  });
  const s = source as Taken | null;
  const d = target as Taken | null;
  if (!d || d.addrs.length === 0) {
    if (!s || s.addrs.length === 0) return null;
    return { drafts: [], marks, notes: ["noTarget"] };
  }
  const ports = cellPorts(portToks, 0);
  marks.push(...ports.marks);
  if (ports.named) notes.push("portByName");
  if (ports.ports.length === 0) notes.push("noPorts");
  if (ports.proto === "udp") notes.push("udpOnly");
  return {
    drafts: [
      {
        source: s ? withLabel(s.addrs, s.label) : "",
        targets: withLabel(d.addrs, d.label),
        ports: ports.ports.join(", "),
        proto: ports.proto ?? "tcp",
      },
    ],
    marks,
    notes,
  };
}

/**
 * Read a pasted request. Lines are tried as: blank or `#` comment → arrow rule
 * (the canonical parser) → table header → row of the table above → form field
 * (`Порт: 443`; consecutive fields make one rule) → free text. A line with no
 * address is skipped and listed as such.
 */
export function recognize(text: string): PasteResult {
  const rules: RuleDraft[] = [];
  const lines: PasteLine[] = [];
  let table: { sep: Sep; roles: (Role | null)[] } | null = null;
  // An open form: the rule its fields are filling in, and the lines they came from.
  let form: { draft: RuleDraft; lines: PasteLine[]; roles: Set<Role> } | null = null;

  const closeForm = () => {
    if (!form) return;
    const f = form;
    form = null;
    if (!f.draft.targets) {
      for (const l of f.lines) {
        l.kind = "skipped";
        if (!l.notes.includes("noTarget")) l.notes.push("noTarget");
      }
      return;
    }
    if (!f.draft.ports) f.lines[0].notes.push("noPorts");
    rules.push(f.draft);
    for (const l of f.lines) l.rules = [rules.length - 1];
  };

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const entry: PasteLine = { line, text: raw, kind: "blank", marks: [], notes: [], rules: [] };
    lines.push(entry);
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || /^\|?[\s:|-]+\|?$/.test(trimmed) && trimmed.includes("-")) {
      // A Markdown table's `|---|---|` belongs to the header above.
      if (trimmed && table) entry.kind = "header";
      if (!trimmed) closeForm();
      return;
    }

    const arrow = arrowLine(raw);
    if (arrow) {
      closeForm();
      rules.push(arrow);
      Object.assign(entry, { kind: "rule", marks: marksIn(raw), rules: [rules.length - 1] });
      return;
    }

    const header = headerOf(raw);
    if (header) {
      closeForm();
      table = header;
      entry.kind = "header";
      return;
    }

    if (table) {
      const row = tableRow(raw, table.sep, table.roles);
      if (row) {
        entry.marks = row.marks;
        entry.notes = row.notes;
        if (row.drafts.length) {
          entry.rules = row.drafts.map((d) => rules.push(d) - 1);
          entry.kind = "rule";
        } else entry.kind = "skipped";
        return;
      }
      table = null;
    }

    const field = fieldOf(raw);
    if (field && field.role !== "note") {
      // A field already filled starts the next rule (forms repeat per access).
      if (form && form.roles.has(field.role)) closeForm();
      form ??= { draft: { source: "", targets: "", ports: "", proto: "tcp" }, lines: [], roles: new Set() };
      form.roles.add(field.role);
      form.lines.push(entry);
      entry.kind = "rule";
      if (field.role === "source" || field.role === "target") {
        const taken = cellAddrs(field.value, field.start);
        entry.marks = taken.marks;
        const cell = withLabel(taken.addrs, taken.label);
        if (field.role === "source") form.draft.source = cell;
        else form.draft.targets = cell;
      } else {
        const toks = tokenize(field.value).map((t) => ({ ...t, start: t.start + field.start, end: t.end + field.start }));
        const ports = cellPorts(toks, 0);
        entry.marks = ports.marks;
        if (ports.ports.length) form.draft.ports = ports.ports.join(", ");
        if (ports.proto) form.draft.proto = ports.proto;
        if (ports.named) entry.notes.push("portByName");
        if (ports.proto === "udp") entry.notes.push("udpOnly");
      }
      return;
    }
    if (field?.role === "note" && form) {
      entry.kind = "header";
      return;
    }
    closeForm();

    const s = sentence(raw);
    entry.marks = s.marks;
    entry.notes = s.notes;
    if (s.drafts.length) {
      entry.rules = s.drafts.map((d) => rules.push(d) - 1);
      entry.kind = "rule";
    } else entry.kind = "skipped";
  });
  closeForm();
  for (const l of lines) l.marks.sort((a, b) => a.start - b.start);
  return { rules, lines };
}

/** How many lines of each kind — the summary under the paste box. */
export function pasteSummary(res: PasteResult): {
  rules: number;
  skipped: number;
  header: boolean;
  guesses: number;
  noPorts: number;
} {
  const guess: PasteNote[] = ["sourceByOrder", "portByName"];
  return {
    rules: res.rules.length,
    skipped: res.lines.filter((l) => l.kind === "skipped").length,
    header: res.lines.some((l) => l.kind === "header"),
    guesses: res.lines.filter((l) => l.notes.some((n) => guess.includes(n))).length,
    noPorts: res.rules.filter((r) => !r.ports.trim()).length,
  };
}

/** A line's text cut at its marks, for the highlighted view of the paste. */
export function markedPieces(line: PasteLine): { text: string; kind: MarkKind | null }[] {
  const out: { text: string; kind: MarkKind | null }[] = [];
  let at = 0;
  for (const m of line.marks) {
    if (m.start < at) continue;
    if (m.start > at) out.push({ text: line.text.slice(at, m.start), kind: null });
    out.push({ text: line.text.slice(m.start, m.end), kind: m.kind });
    at = m.end;
  }
  if (at < line.text.length) out.push({ text: line.text.slice(at), kind: null });
  return out;
}
