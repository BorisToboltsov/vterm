// YAML of a CI file, read into plain values with the lines each key stands on
// (ADR 0068). The parser (`yaml`) is loaded on first use — like the editor's
// grammars — so the app does not carry it until a pipeline is drawn; this is the
// only module that imports it, and only dynamically (`pipeline.guard`).
//
// The text is untrusted (a file on a server): aliases are capped
// (`MAX_ALIASES`, the "billion laughs" of YAML), duplicate keys are an error as
// GitLab and GitHub make them, and nothing here is ever rendered as markup.

import type * as YamlLib from "yaml";

export type Yaml = typeof YamlLib;

/** GitLab's `!reference [.job, key]`, kept as what it names until the config is merged. */
export class YamlReference {
  constructor(readonly path: string[]) {}
}

/** More expanded aliases than this in one file is not a CI file but a bomb. */
export const MAX_ALIASES = 200;

export interface YamlSpan {
  line: number;
  endLine: number;
}

export interface YamlFile {
  /** The document as plain values; null when it did not parse. */
  value: unknown;
  /** The first parse error, with its line. */
  error: { message: string; line: number } | null;
  /** The lines of the entry at `path` (keys of nested maps), or null when there is none. */
  span(path: readonly string[]): YamlSpan | null;
  /** The keys of the map at `path`, in the order they are written. */
  keys(path: readonly string[]): string[];
}

let loading: Promise<Yaml> | null = null;

/** The parser, loaded once. */
export function loadYaml(): Promise<Yaml> {
  loading ??= import("yaml");
  return loading;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

function referenceTag(Y: Yaml): YamlLib.CollectionTag {
  return {
    tag: "!reference",
    collection: "seq",
    default: false,
    // A Scalar holding the marker: `toJS` hands the marker back as it is.
    resolve: (seq) => new Y.Scalar(new YamlReference(strings((seq as YamlLib.YAMLSeq).toJSON()))),
  };
}

const firstLine = (message: string): string => message.split("\n")[0].trim();

const EMPTY: YamlFile = { value: null, error: null, span: () => null, keys: () => [] };

/**
 * Parse `text`. A file of several documents is read for the one that holds the
 * config: GitLab puts a `spec:` header in a document of its own before it.
 */
export function parseYaml(Y: Yaml, text: string): YamlFile {
  if (!text.trim()) return EMPTY;
  const lines = new Y.LineCounter();
  const options = { merge: true, lineCounter: lines, customTags: [referenceTag(Y)], uniqueKeys: true, prettyErrors: false };
  const parsed = Y.parseAllDocuments(text, options);
  const docs = Array.isArray(parsed) ? parsed : [];
  if (docs.length === 0) return EMPTY;
  const isSpec = (d: YamlLib.Document.Parsed) => Y.isMap(d.contents) && d.contents.has("spec") && d.contents.items.length === 1;
  const doc = docs.length > 1 && isSpec(docs[0]) ? docs[1] : docs[0];
  const lineAt = (offset: number) => lines.linePos(Math.max(0, offset)).line;
  const failure = doc.errors[0];
  if (failure) return { ...EMPTY, error: { message: firstLine(failure.message), line: lineAt(failure.pos[0]) } };
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (e) {
    return { ...EMPTY, error: { message: firstLine(e instanceof Error ? e.message : String(e)), line: 1 } };
  }
  const pairAt = (path: readonly string[]): YamlLib.Pair | null => {
    let node: unknown = doc.contents;
    let pair: YamlLib.Pair | null = null;
    for (const key of path) {
      if (!Y.isMap(node)) return null;
      pair = (node.items as YamlLib.Pair[]).find((p) => Y.isScalar(p.key) && String(p.key.value) === key) ?? null;
      if (!pair) return null;
      node = pair.value;
    }
    return pair;
  };
  return {
    value,
    error: null,
    span(path) {
      const pair = pairAt(path);
      const key = pair && Y.isNode(pair.key) ? pair.key.range : null;
      if (!pair || !key) return null;
      const end = Y.isNode(pair.value) && pair.value.range ? pair.value.range[1] : key[1];
      const line = lineAt(key[0]);
      return { line, endLine: Math.max(line, lineAt(end - 1)) };
    },
    keys(path) {
      const node = path.length === 0 ? doc.contents : pairAt(path)?.value;
      if (!Y.isMap(node)) return [];
      return (node.items as YamlLib.Pair[]).filter((p) => Y.isScalar(p.key)).map((p) => String((p.key as YamlLib.Scalar).value));
    },
  };
}

// ── Plain-value helpers for the readers of the config ─────────────────────────

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof YamlReference);

/** A scalar as text; null for anything else. */
export function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** A string or a list of strings, as a list; null when the value is neither. */
export function strList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  const one = str(v);
  if (one !== null) return [one];
  if (!Array.isArray(v)) return null;
  return v.map(str).filter((s): s is string => s !== null);
}

/** A map of plain values (`env:`, `variables:`), each as text; anything else is skipped. */
export function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    // GitLab writes `VAR: { value: x, description: … }`.
    const s = str(isObj(val) ? val.value : val);
    if (s !== null) out[k] = s;
  }
  return out;
}

/** The first line of a script line or step, trimmed, for a one-line list. */
export function oneLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.trim();
}
