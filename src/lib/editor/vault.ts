// Ansible Vault in the editor (ADR 0076). An encrypted file is hex under a
// `$ANSIBLE_VAULT;1.1;AES256` header: shown as text it is noise, and an edit
// to it breaks the file. The editor says what it is and offers the user's own
// `ansible-vault` in the terminal — vterm never holds a vault password.

/** The header of an encrypted file, or null. */
export interface VaultHeader {
  version: string;
  cipher: string;
  /** The vault id (`1.2;AES256;prod`), or null. */
  label: string | null;
}

/** The vault header of `content`, or null when the file is not encrypted whole. */
export function vaultHeader(content: string): VaultHeader | null {
  const first = content.slice(0, content.indexOf("\n") < 0 ? content.length : content.indexOf("\n")).trim();
  const m = /^\$ANSIBLE_VAULT;(\d+\.\d+);([A-Z0-9]+)(?:;(\S+))?$/.exec(first);
  if (!m) return null;
  return { version: m[1], cipher: m[2], label: m[3] ?? null };
}

/** 1-based lines that start an inline `!vault |` value in YAML. */
export function inlineVaultLines(content: string): number[] {
  const out: number[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/:\s*!vault\s*\|/.test(lines[i])) out.push(i + 1);
  }
  return out;
}

/** The argv that shows (or edits) the file with the user's own tool, in the terminal. */
export function vaultArgv(path: string, edit: boolean, label: string | null): string[] {
  const argv = ["ansible-vault", edit ? "edit" : "view"];
  if (label) argv.push("--vault-id", `${label}@prompt`);
  argv.push(path);
  return argv;
}
