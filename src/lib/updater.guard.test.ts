import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (p: string) => readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, "");
function violations(main: string, updater: string, helper: string, workflow: string): string[] {
  const errors: string[] = [];
  if (main.indexOf("update_helper::entry()") > main.indexOf("webview2::prepare()") || !main.includes("update_helper::entry()")) errors.push("helper must run before WebView");
  if (!updater.includes("protocol::verified(") || !updater.includes("protocol::verify_file(")) errors.push("verify before handoff");
  if (!helper.includes("validate(plan)?") || !helper.includes("protocol::verify_file(")) errors.push("helper rechecks payload");
  if (updater.indexOf('app.emit("update://prepare"') > updater.indexOf("crate::appwin::quit_app(") || !updater.includes('err("update-unsaved")')) errors.push("all windows must acknowledge");
  if (!helper.includes('"com.apple.quarantine"') || !helper.includes('"--sign", "-"')) errors.push("unsigned macOS preparation");
  if (!workflow.includes('node scripts/update-release.mjs manifest dist') || !workflow.includes('secrets.VTERM_UPDATE_PRIVATE_KEY')) errors.push("signed release manifest");
  if (helper.includes("fs::remove_file(exe)")) errors.push("cleanup must stay in the transaction directory");
  if (helper.indexOf("prepare(&plan)") > helper.indexOf('work.join("helper-ready")')) errors.push("prepare before closing");
  return errors;
}
describe("updater contract", () => {
  const main = read("src-tauri/src/lib.rs"), updater = read("src-tauri/src/updater.rs"), helper = read("src-tauri/src/update_helper.rs"), workflow = read(".github/workflows/release.yml");
  it("holds in production sources", () => expect(violations(main, updater, helper, workflow)).toEqual([]));
  it("rejects live mutations removing each boundary", () => {
    expect(violations(main.replace("update_helper::entry()", "false"), updater, helper, workflow)).toContain("helper must run before WebView");
    expect(violations(main, updater.replaceAll("protocol::verify_file(", "unchecked("), helper, workflow)).toContain("verify before handoff");
    expect(violations(main, updater, helper.replaceAll("validate(plan)?", "()"), workflow)).toContain("helper rechecks payload");
    expect(violations(main, updater.replace('err("update-unsaved")', 'err("other")'), helper, workflow)).toContain("all windows must acknowledge");
    expect(violations(main, updater, helper.replaceAll('"com.apple.quarantine"', '"other"'), workflow)).toContain("unsigned macOS preparation");
    expect(violations(main, updater, helper.replace("prepare(&plan)", "unchecked(&plan)") + " prepare(&plan)", workflow)).toContain("prepare before closing");
    expect(violations(main, updater, helper + " fs::remove_file(exe)", workflow)).toContain("cleanup must stay in the transaction directory");
    expect(violations(main, updater, helper, workflow.replaceAll("secrets.VTERM_UPDATE_PRIVATE_KEY", "other"))).toContain("signed release manifest");
  });
});
