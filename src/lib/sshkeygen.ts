// Pure logic for the SSH key-generation utility (Phase 32). All decisions —
// which algorithms exist, the default filename per algorithm, path assembly,
// name/path validation, and building the backend request — live here so they are
// unit-tested without DOM or the Tauri bridge (architecture invariant). The Rust
// side (`keygen.rs`) is a dumb executor that just writes what this describes.

/** Default directory for generated keys — interoperable with system `ssh(1)`. */
export const SSH_DIR = "~/.ssh";

/** A selectable key algorithm. `id` is the exact string the backend parses. */
export interface KeyAlgorithm {
  id: string;
  /** Suggested filename (matches what `ssh-keygen -t <type>` would pick). */
  defaultName: string;
}

/**
 * Supported algorithms, in display order. RSA sizes are explicit ids because the
 * backend builds the keypair at that exact bit size. ECDSA is nistp256 — the
 * common `ssh-keygen -t ecdsa` default.
 */
export const KEY_ALGORITHMS: readonly KeyAlgorithm[] = [
  { id: "ed25519", defaultName: "id_ed25519" },
  { id: "rsa-4096", defaultName: "id_rsa" },
  { id: "rsa-2048", defaultName: "id_rsa" },
  { id: "ecdsa-p256", defaultName: "id_ecdsa" },
] as const;

/** Whether `id` is a known algorithm. */
export function isValidAlgorithm(id: string): boolean {
  return KEY_ALGORITHMS.some((a) => a.id === id);
}

/** Suggested filename for an algorithm (`id_key` if unknown). */
export function defaultKeyName(algorithm: string): string {
  return KEY_ALGORITHMS.find((a) => a.id === algorithm)?.defaultName ?? "id_key";
}

/** Reasons a filename is rejected — mapped to an i18n message by the caller. */
export type NameError = "empty" | "separator" | "dots";

/**
 * Validate a bare key filename (not a path): non-empty, no path separators, and
 * not a `.`/`..` traversal component. Returns `null` when valid.
 */
export function validateKeyName(name: string): NameError | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (/[/\\]/.test(trimmed)) return "separator";
  if (trimmed === "." || trimmed === "..") return "dots";
  return null;
}

/** Reasons a custom full path is rejected. */
export type PathError = "empty" | "notAbsolute";

/**
 * Validate a custom full path (advanced mode). Must be non-empty and rooted —
 * absolute (`/…`), home-relative (`~…`), or a Windows drive (`C:\…`).
 */
export function validateKeyPath(path: string): PathError | null {
  const trimmed = path.trim();
  if (!trimmed) return "empty";
  const rooted = trimmed.startsWith("/") || trimmed.startsWith("~") || /^[A-Za-z]:[\\/]/.test(trimmed);
  return rooted ? null : "notAbsolute";
}

/** Join a directory and a filename with a single `/` (drops a trailing slash). */
export function buildKeyPath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, "");
  return base ? `${base}/${name.trim()}` : name.trim();
}

/** Inputs the generate form collects. */
export interface KeygenForm {
  algorithm: string;
  /** Base directory when not using a custom path (defaults to `SSH_DIR`). */
  dir: string;
  /** Bare filename when not using a custom path. */
  name: string;
  /** Advanced: use `customPath` verbatim instead of `dir`/`name`. */
  useCustomPath: boolean;
  customPath: string;
  passphrase: string;
  comment: string;
}

/** The request payload sent to the backend `generate_ssh_key` command. */
export interface GenerateKeyRequest {
  algorithm: string;
  path: string;
  passphrase?: string | null;
  comment?: string | null;
  overwrite: boolean;
}

/** The resolved destination path for a form (custom path, or dir + name). */
export function resolvedPath(form: KeygenForm): string {
  return form.useCustomPath ? form.customPath.trim() : buildKeyPath(form.dir, form.name);
}

/**
 * Build the backend request from a form. Empty passphrase/comment become
 * `undefined` so the backend writes an unencrypted / comment-less key.
 */
export function buildGenerateRequest(form: KeygenForm, overwrite: boolean): GenerateKeyRequest {
  return {
    algorithm: form.algorithm,
    path: resolvedPath(form),
    passphrase: form.passphrase ? form.passphrase : undefined,
    comment: form.comment.trim() ? form.comment.trim() : undefined,
    overwrite,
  };
}

/** Whether the form is complete enough to submit (valid path components). */
export function isFormValid(form: KeygenForm): boolean {
  if (!isValidAlgorithm(form.algorithm)) return false;
  return form.useCustomPath
    ? validateKeyPath(form.customPath) === null
    : validateKeyName(form.name) === null;
}
