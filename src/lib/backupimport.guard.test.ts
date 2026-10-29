import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A backup import writes the catalog the preview assembled, and nothing else.
//
// Before v1.20 an import wrote the archive's server list as it lay: the
// logins and home-directory key paths of whoever exported it, and a "password
// saved" hint for secrets this keychain never held — and it replaced the
// current servers, the only way it knew. Now:
//  - the backend writes the catalog it is given, checked first (`check_catalog`:
//    no empty or repeated id — the keychain keeps secrets by id), and never the
//    archive's own `servers`;
//  - `importBackup` is called from one place, with the catalog the dialog chose;
//  - the dialog's catalog is `planImport` over `remapServers` — logins and key
//    paths changed, the current servers kept or replaced as chosen;
//  - "password saved" comes only from a current server of the same id.
// Each check is a function over source text, run against a planted violation
// too. Checked without comments.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Drop `<!-- … -->` blocks (a scan: one regex pass leaves a nested opener behind). */
function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    out += src[i++];
  }
  return out;
}

function strip(src: string): string {
  return stripHtmlComments(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The text of a function, from its `fn`/`function` line to the next top-level item. */
function body(src: string, head: RegExp): string {
  const m = head.exec(src);
  if (!m) return "";
  const rest = src.slice(m.index);
  const end = rest.slice(1).search(/\n(?:#\[|fn |pub |export |function |async function |\/\/\/)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** Violations in the backend's import command. */
export function backendViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  const fn = body(src, /fn import_backup\(/);
  if (fn === "") return ["import_backup is missing"];
  if (/\b(?:doc|d)\.servers\b|\.servers\s*=\s*doc/.test(fn)) {
    out.push("the import writes the archive's own server list");
  }
  const check = fn.indexOf("backup::check_catalog(");
  const save = fn.indexOf("store::save_servers(");
  if (check < 0 || save < 0 || check > save) out.push("the catalog is written before it is checked");
  if (!/store::save_servers\(&c\.servers\)/.test(fn)) out.push("the import writes something but the given catalog");
  return out;
}

/** Violations in the frontend's path from preview to import. */
export function frontendViolations(dialog: string, settingsSection: string, remap: string): string[] {
  const out: string[] = [];
  const d = strip(dialog);
  if (!/planImport\(\s*mode,\s*current,\s*currentFolders,\s*remapServers\(/.test(d)) {
    out.push("the dialog's catalog is not planImport over remapServers");
  }
  if (!/catalog:\s*plan\?\.catalog\s*\?\?\s*null/.test(d)) out.push("the dialog hands on a catalog it did not plan");
  const s = strip(settingsSection);
  if (!/importBackup\(path,\s*choice\.catalog,\s*choice\.recordings\)/.test(s)) {
    out.push("the import is not given the chosen catalog");
  }
  const r = strip(body(strip(remap), /export function remapServers\(/));
  if ((r.match(/hasSavedPassword:/g) ?? []).length !== 2) {
    out.push("the saved-password hint is set other than in the two places");
  }
  if (
    !/hasSavedPassword:\s*mine\?\.hasSavedPassword\s*\?\?\s*false/.test(r) ||
    !/hasSavedPassword:\s*mine\?\.proxy\?\.hasSavedPassword\s*\?\?\s*false/.test(r)
  ) {
    out.push("the saved-password hint is taken from the backup");
  }
  return out;
}

const LIB = "src-tauri/src/commands/backup.rs";
const DIALOG = "src/lib/BackupImportDialog.svelte";
const SECTION = "src/lib/BackupSettings.svelte";
const REMAP = "src/lib/backupimport.ts";

describe("backup import guard", () => {
  it("the backend writes the given catalog, checked, never the archive's list", () => {
    expect(backendViolations(read(LIB))).toEqual([]);
  });

  it("the frontend imports the catalog the preview planned", () => {
    expect(frontendViolations(read(DIALOG), read(SECTION), read(REMAP))).toEqual([]);
  });

  it("catches a backend that writes the archive's servers", () => {
    const src = read(LIB).replace("store::save_servers(&c.servers)?;", "store::save_servers(&doc.servers)?;");
    const found = backendViolations(src);
    expect(found).toContain("the import writes the archive's own server list");
  });

  it("catches a catalog written before it is checked", () => {
    const src = read(LIB).replace(/\n\s*backup::check_catalog\(&c\.servers\)\?;/, "");
    expect(backendViolations(src)).toContain("the catalog is written before it is checked");
  });

  it("catches a dialog that skips the remap", () => {
    const src = read(DIALOG).replace(/remapServers\(servers, logins, keys, current\)/, "servers");
    expect(frontendViolations(src, read(SECTION), read(REMAP))).toContain(
      "the dialog's catalog is not planImport over remapServers",
    );
  });

  it("catches a saved-password hint carried over from the backup", () => {
    const src = read(REMAP).replace(
      "hasSavedPassword: mine?.hasSavedPassword ?? false",
      "hasSavedPassword: mine?.hasSavedPassword ?? s.hasSavedPassword",
    );
    expect(frontendViolations(read(DIALOG), read(SECTION), src)).toContain(
      "the saved-password hint is taken from the backup",
    );
  });
});
