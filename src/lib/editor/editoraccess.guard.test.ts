import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Editor write access (v1.24): whether a save will land is asked ahead of
// editing, a refused save keeps the buffer and puts the way out next to Save —
// sudo or a copy on this computer — and that copy never lands on another file.
// The flow half — the access probe on open, the sudo password checked before it
// is kept, a refused save marked rather than answered with a dialog — is the
// editor flow's (page/editorflow), held by its behaviour tests. What is left here
// is what the editor shows by Save and how the backend writes the copy.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const editor = read("src/lib/editor/EditorTab.svelte");
const local = read("src-tauri/src/localfile.rs");

function problems(editorSource: string, localSource: string): string[] {
  const out: string[] = [];
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
    expect(problems(editor, local)).toEqual([]);
  });

  it("detects live violations of the warning, the recovery and copy safety", () => {
    expect(problems(editor.replace('t("editor.saveWithSudo")', 't("editor.save")'), local)).toContain(
      "no recovery actions by Save",
    );
    expect(problems(editor, local.replace("options.write(true).create_new(true);", "options.write(true).create(true);"))).toContain(
      "local copy can overwrite another file",
    );
  });
});
