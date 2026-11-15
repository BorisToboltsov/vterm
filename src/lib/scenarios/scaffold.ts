// A new Ansible project to start from (ADR 0071): `ansible.cfg` pointing at an
// inventory made of the servers picked from the catalog, `site.yml` with one
// play and a `common` role that only asks the servers to answer, and an empty
// `requirements.yml`. Ordinary files: nothing in them is vterm's. Pure.

export interface ScaffoldFile {
  /** Relative to the project folder, `/`-separated. */
  path: string;
  text: string;
}

/** The folders of the project, parents first. */
export const SCAFFOLD_DIRS = ["inventory", "roles", "roles/common", "roles/common/tasks"];

/** The files of a new project; `inventory` is the YAML of the servers picked. */
export function scaffoldFiles(inventory: string): ScaffoldFile[] {
  return [
    {
      path: "ansible.cfg",
      text: ["[defaults]", "inventory = inventory/vterm.yml", "roles_path = roles", "retry_files_enabled = False", ""].join("\n"),
    },
    { path: "inventory/vterm.yml", text: inventory },
    {
      path: "site.yml",
      text: ["- name: Every server", "  hosts: all", "  roles:", "    - common", ""].join("\n"),
    },
    {
      path: "roles/common/tasks/main.yml",
      text: [
        "- name: The server answers",
        "  ansible.builtin.ping:",
        "",
        "- name: What the server runs",
        "  ansible.builtin.debug:",
        '    msg: "{{ ansible_facts.distribution | default(\'?\') }} {{ ansible_facts.distribution_version | default(\'\') }}"',
        "",
      ].join("\n"),
    },
    { path: "requirements.yml", text: ["collections: []", ""].join("\n") },
  ];
}

/** A folder name for a project: one path component, no leading dot. */
export function projectFolderProblem(name: string): "empty" | "bad" | null {
  const n = name.trim();
  if (!n) return "empty";
  if (n.startsWith(".") || /[\\/:*?"<>|]/.test(n)) return "bad";
  return null;
}
