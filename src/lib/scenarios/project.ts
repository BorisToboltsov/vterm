// Which kind of project a folder is (ADR 0071): an Ansible project, a
// Terraform one, or neither — from the names in the folder, before anything
// in them is read. Pure: the file panel asks it of every folder it shows.

export type ProjectKind = "ansible" | "terraform";

export interface ProjectSigns {
  kind: ProjectKind;
  /** The names that told it, for the panel's tooltip. */
  markers: string[];
}

const ANSIBLE_STRONG_FILES = ["ansible.cfg", "ansible-navigator.yml", "ansible-navigator.yaml"];
const ANSIBLE_STRONG_DIRS = ["group_vars", "host_vars", "roles", "collections"];
const PLAYBOOK_NAMES = ["site.yml", "site.yaml", "playbook.yml", "playbook.yaml", "main.yml", "main.yaml"];
const INVENTORY_NAMES = ["inventory", "inventories", "hosts", "hosts.ini", "hosts.yml", "inventory.ini", "inventory.yml"];

const isYaml = (n: string) => /\.ya?ml$/i.test(n);

/**
 * What the folder is, by its entries. Ansible: `ansible.cfg`, or `group_vars`,
 * `host_vars`, `roles` beside a playbook, or a playbook beside an inventory.
 * Terraform: a `*.tf` file or the lock file. A folder with both is the one
 * with the stronger sign — `ansible.cfg` over `.tf`, `.tf` over the rest.
 */
export function projectSigns(entries: readonly { name: string; isDir: boolean }[]): ProjectSigns | null {
  const files = entries.filter((e) => !e.isDir).map((e) => e.name);
  const dirs = entries.filter((e) => e.isDir).map((e) => e.name);
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  const lf = lower(files);
  const ld = lower(dirs);

  const ansibleCfg = ANSIBLE_STRONG_FILES.filter((n) => lf.includes(n));
  const tf = files.filter((n) => /\.tf$/i.test(n) || n === ".terraform.lock.hcl");
  if (ansibleCfg.length) return { kind: "ansible", markers: ansibleCfg };
  if (tf.length) return { kind: "terraform", markers: tf.slice(0, 4) };

  const playbooks = files.filter((n) => PLAYBOOK_NAMES.includes(n.toLowerCase()));
  const anyYaml = files.some(isYaml);
  const strongDirs = ANSIBLE_STRONG_DIRS.filter((n) => ld.includes(n));
  const inventory = [...files, ...dirs].filter((n) => INVENTORY_NAMES.includes(n.toLowerCase()));
  if (strongDirs.length && (anyYaml || strongDirs.length > 1)) return { kind: "ansible", markers: [...strongDirs, ...playbooks] };
  if (playbooks.length && inventory.length) return { kind: "ansible", markers: [...playbooks, ...inventory] };
  return null;
}

/** The file of a folder's listing a playbook may be: a YAML file at its top. */
export const playbookCandidate = (name: string): boolean =>
  isYaml(name) && !/^(requirements|galaxy|ansible-navigator|\.ansible-lint|docker-compose|compose)\.ya?ml$/i.test(name);

/**
 * The inventory of a project: what its `ansible.cfg` names — Ansible reads that
 * and nothing else — or, with none named, the usual names in the folder (what
 * the user would pass with `-i`).
 */
export function inventoryCandidates(entries: readonly { name: string; isDir: boolean }[], cfgInventory: string[]): string[] {
  if (cfgInventory.length) return [...cfgInventory];
  return entries.filter((e) => INVENTORY_NAMES.includes(e.name.toLowerCase())).map((e) => e.name);
}

/** The `inventory =` of an `ansible.cfg` (`[defaults]`), comma-separated paths as written. */
export function cfgInventory(cfg: string): string[] {
  let section = "";
  for (const raw of cfg.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }
    const kv = /^(inventory|hostfile)\s*[=:]\s*(.+)$/i.exec(line);
    if (section === "defaults" && kv) {
      return kv[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}
