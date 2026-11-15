// A playbook as the project overview shows it (ADR 0071): its plays — whom
// they run on, which roles, which tags — and the playbooks it imports. From the
// YAML already parsed (`pipeline/yamldoc.ts` loads the parser); pure.

export interface Play {
  name: string;
  /** The `hosts:` pattern as written. */
  hosts: string;
  roles: string[];
  become: boolean;
  /** Prompts of `vars_prompt` — Ansible asks them in the terminal. */
  prompts: string[];
}

export interface Playbook {
  plays: Play[];
  /** `import_playbook:` targets, as written. */
  imports: string[];
  /** Every tag written in it (plays, roles, tasks, blocks), sorted. */
  tags: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

function tagsOf(v: unknown): string[] {
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.flatMap(tagsOf);
  return [];
}

/** Tags of tasks and blocks, however deep. */
function taskTags(list: unknown, into: Set<string>, depth = 0): void {
  if (!Array.isArray(list) || depth > 8) return;
  for (const t of list) {
    if (!isObj(t)) continue;
    for (const tag of tagsOf(t.tags)) into.add(tag);
    for (const key of ["block", "rescue", "always"]) taskTags(t[key], into, depth + 1);
  }
}

/** A playbook from its parsed YAML; null when the document is not one. */
export function readPlaybook(doc: unknown): Playbook | null {
  if (!Array.isArray(doc) || doc.length === 0) return null;
  const plays: Play[] = [];
  const imports: string[] = [];
  const tags = new Set<string>();
  for (const item of doc) {
    if (!isObj(item)) return null;
    const imp = asStr(item.import_playbook) ?? asStr(item["ansible.builtin.import_playbook"]);
    if (imp) {
      imports.push(imp);
      continue;
    }
    const hosts = Array.isArray(item.hosts) ? item.hosts.map(asStr).filter(Boolean).join(",") : asStr(item.hosts);
    if (hosts === null) return null;
    for (const tag of tagsOf(item.tags)) tags.add(tag);
    const roles: string[] = [];
    if (Array.isArray(item.roles)) {
      for (const r of item.roles) {
        const name = typeof r === "string" ? r : isObj(r) ? (asStr(r.role) ?? asStr(r.name)) : null;
        if (name) roles.push(name);
        if (isObj(r)) for (const tag of tagsOf(r.tags)) tags.add(tag);
      }
    }
    for (const key of ["pre_tasks", "tasks", "post_tasks", "handlers"]) taskTags(item[key], tags);
    const prompts = Array.isArray(item.vars_prompt)
      ? item.vars_prompt.map((p) => (isObj(p) ? asStr(p.name) : null)).filter((x): x is string => !!x)
      : [];
    plays.push({
      name: asStr(item.name) ?? hosts,
      hosts,
      roles,
      become: item.become === true || item.become === "yes" || item.become === "true",
      prompts,
    });
  }
  return { plays, imports, tags: [...tags].sort() };
}

/** Tags of a role's tasks (`roles/<r>/tasks/main.yml`, parsed). */
export function roleTags(doc: unknown): string[] {
  const set = new Set<string>();
  taskTags(doc, set);
  return [...set].sort();
}

/** The collections and roles a `requirements.yml` asks for (parsed). */
export function readRequirements(doc: unknown): { collections: string[]; roles: string[] } {
  const names = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => asStr(x) ?? (isObj(x) ? (asStr(x.name) ?? asStr(x.src)) : null)).filter((x): x is string => !!x) : [];
  if (Array.isArray(doc)) return { collections: [], roles: names(doc) };
  if (!isObj(doc)) return { collections: [], roles: [] };
  return { collections: names(doc.collections), roles: names(doc.roles) };
}

/** Installed collections from `ansible-galaxy collection list --format json`: their names. */
export function installedCollections(text: string): Set<string> | null {
  try {
    const doc = JSON.parse(text) as unknown;
    if (!isObj(doc)) return null;
    const out = new Set<string>();
    for (const path of Object.values(doc)) if (isObj(path)) for (const name of Object.keys(path)) out.add(name);
    return out;
  } catch {
    return null;
  }
}
