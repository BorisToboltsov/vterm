// A profile is published only after persistence, and the form closes without
// waiting for the system keychain after the profile is saved.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const FORM = "src/lib/servers/ServerFormModal.svelte";
const SERVERS = "src-tauri/src/servers.rs";

export function creationViolations(form: string, servers: string): string[] {
  const errors: string[] = [];
  const submit = form.split("async function submit(event: Event) {")[1]?.split("\n</script>")[0] ?? "";
  const profile = submit.indexOf("await addServer(payload)");
  const published = submit.indexOf("onsaved(saved, savedMode)");
  const closed = submit.indexOf("open = false", published);
  const keychain = submit.indexOf("await saveServerSecret(saved.id, serverSecret)");
  if (!(profile >= 0 && published > profile && closed > published && keychain > closed)) {
    errors.push("the form must publish and close the saved profile before waiting for the keychain");
  }
  const add = servers.split("fn add_persisted(")[1]?.split("\n#[tauri::command]")[0] ?? "";
  const written = add.indexOf("persist(&next)?");
  const visible = add.indexOf("*servers = next");
  if (!(written >= 0 && visible > written && servers.includes("add_persisted(&mut servers, created, store::save_servers)"))) {
    errors.push("a profile must reach disk before it enters the in-memory catalog");
  }
  return errors;
}

describe("server creation guard", () => {
  const form = read(FORM);
  const servers = read(SERVERS);

  it("keeps the two publication boundaries", () => {
    expect(creationViolations(form, servers)).toEqual([]);
  });

  it("catches a form waiting for the keychain before closing", () => {
    const reverted = form.replace(
      "      open = false;\n      notifySuccess(",
      "      notifySuccess(",
    ).replace(
      "      // Store a just-typed proxy secret",
      "      open = false;\n      // Store a just-typed proxy secret",
    );
    expect(reverted).not.toBe(form);
    expect(creationViolations(reverted, servers)).toEqual([
      "the form must publish and close the saved profile before waiting for the keychain",
    ]);
  });

  it("catches a profile entering memory before a failed disk write", () => {
    const reverted = servers.replace(
      "    persist(&next)?;\n    *servers = next;",
      "    *servers = next;\n    persist(&servers)?;",
    );
    expect(reverted).not.toBe(servers);
    expect(creationViolations(form, reverted)).toEqual([
      "a profile must reach disk before it enters the in-memory catalog",
    ]);
  });
});
