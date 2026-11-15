// The recipe library (ADR 0071, 0072): the user's recipes and playbooks — the
// app's folder ("Mine") and the folders they added — as one list the Scenarios
// panel draws, the projects found in those folders, and the recipes and
// playbooks that ship with the app. A shipped one is written into "Mine" once,
// in the reader's language (`seedPlan`), and from then on is the user's file:
// edited, renamed, deleted like any other. While its text is still the one
// written, a later build may write it anew; once it was changed, never. Nothing
// is fetched (principle 6). Pure.
import { readPlaybook, type Playbook } from "./ansibleplay";
import { projectSigns, type ProjectKind } from "./project";
import type { SeedState } from "./bookmarks";
import { flowMap, headerValue, parseRecipe, type RecipeMeta } from "./recipe";

/** Where a library file lies: the app's folder, or a folder the user added. */
export type LibraryOrigin = "own" | "source";

interface ItemBase {
  /** The file's path. */
  id: string;
  origin: LibraryOrigin;
  /** The file name (`install-docker.sh`). */
  file: string;
  /** The folder it was read from. */
  dir: string;
  text: string;
}

/** A shell script with a `# vterm:` header — or without one, which is said. */
export interface LibraryRecipe extends ItemBase {
  kind: "recipe";
  /** Its header, or why it has none that reads. */
  meta: RecipeMeta | null;
  error: string | null;
}

/**
 * A playbook of Ansible: a YAML file whose document is a list of plays — or a
 * YAML file that does not parse, shown with why rather than dropped: a
 * playbook with a typo would vanish from the list otherwise.
 */
export interface LibraryPlaybook extends ItemBase {
  kind: "playbook";
  /** Null — the YAML did not parse (`error` says why). */
  book: Playbook | null;
  error: string | null;
  /** The first play's name, else the file's. */
  name: string;
  /** The comment at its top. */
  description: string;
}

export type LibraryItem = LibraryRecipe | LibraryPlaybook;

/** A project the library found in a folder the user added (ADR 0072). */
export interface FoundProject {
  kind: ProjectKind;
  root: string;
  /** The folder it was found in. */
  source: string;
}

/** What `recipes_scan` answers, as far as the library reads it. */
export interface ScanLike {
  dir: string;
  files: { path: string; dir: string; name: string; text: string }[];
  folders?: { path: string; source: string; entries: { name: string; isDir: boolean }[] }[];
}

export const isRecipeFile = (name: string): boolean => /\.sh$/i.test(name);
export const isPlaybookFile = (name: string): boolean => /\.ya?ml$/i.test(name);

/** A library entry for one recipe text. */
export function libraryRecipe(origin: LibraryOrigin, file: string, dir: string, id: string, text: string): LibraryRecipe {
  const parsed = parseRecipe(text);
  return {
    kind: "recipe",
    id,
    origin,
    file,
    dir,
    text,
    meta: parsed.ok ? parsed.meta : null,
    error: parsed.ok ? null : parsed.error,
  };
}

/** The comment at the top of a playbook — how it says what it is for. */
export function playbookDescription(text: string): string {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "---" || (line === "" && out.length === 0)) continue;
    if (!line.startsWith("#")) break;
    const said = line.replace(/^#+\s?/, "").trim();
    if (said) out.push(said);
  }
  const all = out.join(" ");
  return all.length > 240 ? `${all.slice(0, 239)}…` : all;
}

/** The `name:` of the first play of a parsed playbook, when it has one. */
function firstPlayName(doc: unknown): string | null {
  if (!Array.isArray(doc)) return null;
  for (const item of doc) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  }
  return null;
}

/** What the YAML parser said of a text: its value, or why it did not parse. */
export interface YamlRead {
  value: unknown;
  error: string | null;
}

/**
 * A library entry for a YAML text: a playbook, a YAML file that does not parse
 * (said), or null when it parses as something else (variables, an inventory,
 * compose).
 */
export function libraryPlaybook(origin: LibraryOrigin, file: string, dir: string, id: string, text: string, read: YamlRead): LibraryPlaybook | null {
  const base = { kind: "playbook" as const, id, origin, file, dir, text, description: playbookDescription(text) };
  const stem = file.replace(/\.ya?ml$/i, "");
  if (read.error) return { ...base, book: null, error: read.error, name: stem };
  const book = readPlaybook(read.value);
  if (!book || (book.plays.length === 0 && book.imports.length === 0)) return null;
  return { ...base, book, error: null, name: firstPlayName(read.value) ?? stem };
}

/** The projects among the folders of the sources: a source itself, or a folder in it. */
export function foundProjects(scan: ScanLike): FoundProject[] {
  const out: FoundProject[] = [];
  for (const f of scan.folders ?? []) {
    const signs = projectSigns(f.entries);
    if (signs) out.push({ kind: signs.kind, root: f.path, source: f.source });
  }
  return out;
}

/**
 * The user's files as the library shows them: the app's folder is "own", the
 * rest "source"; a script is a recipe, YAML that reads as plays a playbook
 * (`readYaml` parses it; null — no YAML parser, the YAML is not read). The YAML
 * of a source that is an Ansible project itself is that project's — it shows as
 * the project, not as loose playbooks.
 */
export function libraryItems(scan: ScanLike, readYaml: ((text: string) => YamlRead) | null): { items: LibraryItem[]; notPlaybooks: number } {
  const projectRoots = new Set(foundProjects(scan).filter((p) => p.kind === "ansible").map((p) => p.root));
  const items: LibraryItem[] = [];
  let notPlaybooks = 0;
  for (const f of scan.files) {
    const origin: LibraryOrigin = f.dir === scan.dir ? "own" : "source";
    if (isRecipeFile(f.name)) {
      items.push(libraryRecipe(origin, f.name, f.dir, f.path, f.text));
      continue;
    }
    if (!isPlaybookFile(f.name) || !readYaml || (origin === "source" && projectRoots.has(f.dir))) continue;
    const book = libraryPlaybook(origin, f.name, f.dir, f.path, f.text, readYaml(f.text));
    if (book) items.push(book);
    else notPlaybooks++;
  }
  return { items, notPlaybooks };
}

/** How the list names an item: a recipe by its header, a playbook by its first play; else the file. */
export const itemName = (r: LibraryItem): string => (r.kind === "playbook" ? r.name : r.meta?.name || r.file);

/** What an item says it does. */
export const itemDescription = (r: LibraryItem): string => (r.kind === "playbook" ? r.description : (r.meta?.description ?? ""));

/** Whether `r` matches the filter text: its name, description or file. */
export function itemMatches(r: LibraryItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [itemName(r), itemDescription(r), r.file].some((s) => s.toLowerCase().includes(q));
}

// ── What ships with the app ───────────────────────────────────────────────────

const SHIPPED = import.meta.glob(["./builtin/*.sh", "./builtin/*.yml"], { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

/** The recipes that ship with the app — their names and labels are `scenarios.builtin.<stem>.*`. */
export const SHIPPED_RECIPES = [
  "install-docker",
  "update-packages",
  "add-user-key",
  "firewall-open-port",
  "swap-file",
  "timezone-ntp",
  "fail2ban-ssh",
  "ssh-key-only",
  "node-exporter",
  "cleanup-disk",
] as const;

/** The example playbooks — their name and description are `scenarios.starter.<stem>.*`. */
export const SHIPPED_PLAYBOOKS = ["install-docker", "update-packages", "add-user-key"] as const;

/** Every shipped file, in the order it is written into "Mine". */
export const SHIPPED_FILES: readonly string[] = [...SHIPPED_RECIPES.map((n) => `${n}.sh`), ...SHIPPED_PLAYBOOKS.map((n) => `${n}.yml`)];

/** A shipped file's text as it is in the build (English). */
export const shippedText = (file: string): string => SHIPPED[`./builtin/${file}`] ?? "";

/** A key to its text in one language; the key itself when the language has none. */
export type Translate = (key: string) => string;

/** `key`'s text, or `fallback` when the dictionary has none. */
const said = (tr: Translate, key: string, fallback: string): string => {
  const v = tr(key);
  return v && v !== key ? v : fallback;
};

/** A YAML scalar: bare when it reads back as itself, double-quoted otherwise. */
const yamlScalar = (v: string): string => (/^[\p{L}\p{N}][\p{L}\p{N} ()\-–—.,']*$/u.test(v) ? v : JSON.stringify(v));

/** A shipped recipe with its header in a language: name, description, each parameter's label and hint. */
function localizeRecipe(stem: string, text: string, tr: Translate): string {
  const key = (k: string) => `scenarios.builtin.${stem}.${k}`;
  let inHeader = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^#\s*vterm:\s*$/.test(line)) {
        inHeader = true;
        return line;
      }
      if (!inHeader) return line;
      const m = /^(#\s{2,})(\S[^:]*):\s*(.*)$/.exec(line);
      if (!m) {
        inHeader = /^#\s{2,}/.test(line);
        return line;
      }
      const [, lead, name, value] = m;
      if (name === "name") return `${lead}name: ${headerValue(said(tr, key("name"), value))}`;
      if (name === "description") return `${lead}description: ${headerValue(said(tr, key("desc"), value))}`;
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return line;
      const map = flowMap(value);
      if (!map) return line;
      if ("label" in map) map.label = said(tr, key(name), map.label);
      if ("hint" in map) map.hint = said(tr, key(`${name}.hint`), map.hint);
      const parts = Object.entries(map).map(([k, v]) => `${k}: ${headerValue(v)}`);
      return `${lead}${name}: { ${parts.join(", ")} }`;
    })
    .join("\n");
}

/** A shipped playbook with its top comment and its play's name in a language. */
function localizePlaybook(stem: string, text: string, tr: Translate): string {
  const key = (k: string) => `scenarios.starter.${stem}.${k}`;
  let named = false;
  return text
    .split("\n")
    .map((line, i) => {
      if (i === 0 && line.startsWith("# ")) return `# ${said(tr, key("desc"), line.slice(2))}`;
      const m = /^- name: (.*)$/.exec(line);
      if (!m || named) return line;
      named = true;
      const was = m[1];
      const now = said(tr, key("name"), was);
      return now === was ? line : `- name: ${yamlScalar(now)}`;
    })
    .join("\n");
}

/** A shipped file's text in a language — what is written into "Mine". */
export function shippedIn(file: string, tr: Translate): string {
  const text = shippedText(file);
  const stem = file.replace(/\.(sh|yml)$/, "");
  return isRecipeFile(file) ? localizeRecipe(stem, text, tr) : localizePlaybook(stem, text, tr);
}

/**
 * A text's fingerprint (cyrb53): enough to tell the text written from one the
 * user changed — not a secret, not a check against tampering.
 */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** One file the plan writes into "Mine". */
export interface SeedWrite {
  file: string;
  text: string;
  /** Over a file that is there — only a text the app wrote and nobody changed. */
  replace: boolean;
}

export interface SeedPlan {
  writes: SeedWrite[];
  seeded: SeedState;
}

/**
 * What to write into "Mine" for the shipped files (ADR 0072). A file the app
 * has not written yet is written once, in `lang` — or, when its name is taken
 * already, left as it is (an untouched copy of the build's text is the app's,
 * and is written anew). A file it wrote is written anew while its text is still
 * the one written and a later build changed it — in the language it was written
 * in; changed by the user, renamed or deleted, it is never touched again.
 */
export function seedPlan(present: ReadonlyMap<string, string>, seeded: Readonly<SeedState>, lang: string, trIn: (lang: string) => Translate): SeedPlan {
  const writes: SeedWrite[] = [];
  const next: SeedState = { ...seeded };
  for (const file of SHIPPED_FILES) {
    const mark = seeded[file];
    const now = present.get(file);
    if (!mark) {
      const text = shippedIn(file, trIn(lang));
      if (now === undefined) writes.push({ file, text, replace: false });
      else if (now !== text && now === shippedText(file)) writes.push({ file, text, replace: true });
      else if (now !== text) {
        next[file] = { hash: "", lang };
        continue;
      }
      next[file] = { hash: textHash(text), lang };
      continue;
    }
    if (now === undefined || !mark.hash || textHash(now) !== mark.hash) continue;
    const text = shippedIn(file, trIn(mark.lang));
    if (text === now) continue;
    writes.push({ file, text, replace: true });
    next[file] = { hash: textHash(text), lang: mark.lang };
  }
  return { writes, seeded: next };
}

/**
 * "Bring back the shipped ones": every shipped file "Mine" does not have is
 * written again, in `lang`; a file that is there — changed or not — stays.
 */
export function restorePlan(present: ReadonlyMap<string, string>, seeded: Readonly<SeedState>, lang: string, tr: Translate): SeedPlan {
  const writes: SeedWrite[] = [];
  const next: SeedState = { ...seeded };
  for (const file of SHIPPED_FILES) {
    if (present.has(file)) continue;
    const text = shippedIn(file, tr);
    writes.push({ file, text, replace: false });
    next[file] = { hash: textHash(text), lang };
  }
  return { writes, seeded: next };
}
