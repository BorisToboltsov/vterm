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
//  - "password saved" comes only from a current server of the same id;
//  - the databases of this computer (ADR 0080) are only added: the dialog
//    hands on what `planLocalDbs` left, with no saved password, and the
//    backend writes `local_additions` over the ones here — checked before
//    anything is written, never the archive's own list.
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
  // ADR 0080: an archive says nothing of this computer's keychain.
  const flags = fn.indexOf("keep_password_flags(");
  if (flags < 0 || flags > save) out.push("a database's saved-password flag is written as the archive has it");
  if (!/store::save_servers\(&c\.servers\)/.test(fn)) out.push("the import writes something but the given catalog");
  // The databases of this computer: added to the ones here, checked before
  // the first write, never the archive's own list.
  if (/\b(?:doc|d)\.local_databases\b/.test(fn)) out.push("the import writes the archive's own databases of this computer");
  const additions = fn.indexOf("backup::local_additions(");
  const saveLocal = fn.indexOf("store::save_local_databases(");
  if (additions < 0 || saveLocal < 0 || additions > save || !/store::save_local_databases\(&next\)/.test(fn)) {
    out.push("the databases of this computer are written but as added to the ones here, checked first");
  }
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
  if (
    !/importBackup\(\s*path,\s*choice\.catalog,\s*choice\.recordings,\s*choice\.scripts,\s*choice\.localDatabases,?\s*\)/.test(s)
  ) {
    out.push("the import is not given the chosen catalog");
  }
  if (
    !/planLocalDbs\(currentDbs,\s*localDbs\)/.test(d) ||
    !/localDatabases:\s*takeLocalDbs\s*&&\s*dbPlan\s*\?\s*dbPlan\.add\s*:\s*null/.test(d)
  ) {
    out.push("the dialog hands on databases of this computer it did not plan");
  }
  const p = strip(body(strip(remap), /export function planLocalDbs\(/));
  if (!/add\.push\(\{\s*\.\.\.d,\s*hasSavedPassword:\s*false\s*\}\)/.test(p)) {
    out.push("an added database of this computer claims a saved password");
  }
  const r = strip(body(strip(remap), /export function remapServers\(/));
  // The server's own login, its jump host's, each other login's (ADR 0074) and
  // each database's, for the same place and user alone (ADR 0080).
  if ((r.match(/hasSavedPassword:/g) ?? []).length !== 4) {
    out.push("the saved-password hint is set other than in the four places");
  }
  if (
    !/hasSavedPassword:\s*mine\?\.hasSavedPassword\s*\?\?\s*false/.test(r) ||
    !/hasSavedPassword:\s*mine\?\.proxy\?\.hasSavedPassword\s*\?\?\s*false/.test(r) ||
    !/hasSavedPassword:\s*here\?\.hasSavedPassword\s*\?\?\s*false/.test(r) ||
    !/hasSavedPassword:\s*same\s*&&\s*here\.hasSavedPassword/.test(r) ||
    !/const same = !!here && here\.kind === d\.kind &&.*here\.host.*here\.port === d\.port && here\.user === d\.user/.test(r)
  ) {
    out.push("the saved-password hint is taken from the backup");
  }
  return out;
}

const LIB = "src-tauri/src/commands/backup.rs";
const DIALOG = "src/lib/servers/BackupImportDialog.svelte";
const SECTION = "src/lib/servers/BackupSettings.svelte";
const REMAP = "src/lib/servers/backupimport.ts";

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

  it("catches a database's password hint carried over, or following another place (ADR 0080)", () => {
    for (const [from, to] of [
      ["hasSavedPassword: same && here.hasSavedPassword", "hasSavedPassword: d.hasSavedPassword"],
      [" && here.port === d.port", ""],
    ]) {
      const src = read(REMAP).replace(from, to);
      expect(frontendViolations(read(DIALOG), read(SECTION), src)).toContain("the saved-password hint is taken from the backup");
    }
    const lib = read(LIB).replace("crate::db::keep_password_flags(&state.servers.locked(), &mut c.servers);", "");
    expect(backendViolations(lib)).toContain("a database's saved-password flag is written as the archive has it");
  });

  it("catches the archive's databases of this computer written, or written unchecked", () => {
    const archive = read(LIB).replace("dbs,\n        )?)", "doc.local_databases,\n        )?)");
    expect(backendViolations(archive)).toContain("the import writes the archive's own databases of this computer");
    const unchecked = read(LIB).replace("store::save_local_databases(&next)?;", "store::save_local_databases(&dbs)?;");
    expect(backendViolations(unchecked)).toContain(
      "the databases of this computer are written but as added to the ones here, checked first",
    );
  });

  it("catches a dialog that hands on databases it did not plan, or a password hint for them", () => {
    const dialog = read(DIALOG).replace("dbPlan ? dbPlan.add : null", "localDbs");
    expect(frontendViolations(dialog, read(SECTION), read(REMAP))).toContain(
      "the dialog hands on databases of this computer it did not plan",
    );
    const remap = read(REMAP).replace("add.push({ ...d, hasSavedPassword: false })", "add.push(d)");
    expect(frontendViolations(read(DIALOG), read(SECTION), remap)).toContain(
      "an added database of this computer claims a saved password",
    );
    const section = read(SECTION).replace("choice.localDatabases,", "null,");
    expect(frontendViolations(read(DIALOG), section, read(REMAP))).toContain("the import is not given the chosen catalog");
  });

  it("catches another login's hint carried over from the backup (ADR 0074)", () => {
    const src = read(REMAP).replace(
      "hasSavedPassword: here?.hasSavedPassword ?? false",
      "hasSavedPassword: here?.hasSavedPassword ?? l.hasSavedPassword",
    );
    expect(frontendViolations(read(DIALOG), read(SECTION), src)).toContain(
      "the saved-password hint is taken from the backup",
    );
  });
});
