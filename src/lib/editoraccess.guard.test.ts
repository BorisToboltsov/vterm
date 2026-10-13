import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("src/routes/+page.svelte");
const editor = read("src/lib/EditorTab.svelte");
const local = read("src-tauri/src/localfile.rs");

function problems(pageSource: string, editorSource: string, localSource: string): string[] {
  const out: string[] = [];
  const save = pageSource.slice(
    pageSource.indexOf("async function doWriteEditor("),
    pageSource.indexOf("async function confirmDiffSave("),
  );
  const permission = save.slice(
    save.indexOf('!doc.sudo && doc.source === "sftp" && isPermissionError(e)'),
    save.indexOf("} else if (isBackupFailedError(e))"),
  );
  if (!pageSource.includes("sftpWriteAccess(sid, path)")) out.push("no early write probe");
  if (!pageSource.includes("await sftpCheckSudo(p.sid, pw)")) out.push("sudo is not checked");
  if (!permission.includes('setEditorSaveIssue(sid, doc.id, "permission")'))
    out.push("failed save has no recovery state");
  if (permission.includes('sudoPrompt = { kind: "save"')) out.push("failed save opens modal itself");
  if (!editorSource.includes('doc.writeAccess === "restricted"') ||
      !editorSource.includes('t("editor.writeNeedsAccess")')) out.push("no early warning by Save");
  if (!editorSource.includes('doc.saveIssue === "permission"') ||
      !editorSource.includes('t("editor.saveWithSudo")') ||
      !editorSource.includes('t("editor.saveCopy")')) out.push("no recovery actions by Save");
  const copy = localSource.slice(
    localSource.indexOf("pub async fn write_editor_copy("),
    localSource.indexOf("// ── Tauri commands ──"),
  );
  if (!copy.includes(".create_new(true)")) out.push("local copy can overwrite another file");
  return out;
}

describe("editor write access contract", () => {
  it("warns before editing and keeps explicit recovery actions next to Save", () => {
    expect(problems(page, editor, local)).toEqual([]);
  });

  it("detects live violations of recovery and copy safety", () => {
    expect(problems(page.replace('setEditorSaveIssue(sid, doc.id, "permission")',
      'sudoPrompt = { kind: "save", sid, doc }'), editor, local)).toContain(
      "failed save has no recovery state",
    );
    expect(problems(page, editor, local.replace("options.write(true).create_new(true);", "options.write(true).create(true);"))).toContain(
      "local copy can overwrite another file",
    );
  });
});
