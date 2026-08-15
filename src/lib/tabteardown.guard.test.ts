// Tab-teardown guard (Phase 44.2): a tab is removed only through the one function
// that also drops everything else keyed by its session id.
//
// Why a guard rather than a convention: `closeTab` from the tabs store reads like
// the obvious way to close a tab, and it is — for the *list*. A session id also
// keys the workspace (open editors, holding file contents), the AI conversation
// (holding terminal context), the broadcast member set, and the nginx-config
// cache. Dropping the row alone leaks all of it, and the leftover broadcast member
// is worse than a leak: it is a dead session still in the send set.
//
// This is not hypothetical. Before this phase there were three close paths and
// only one cleaned up — deleting a server closed its tabs through a store-level
// `closeTabsForServer` that could not do the teardown (it would have made the tabs
// store depend on the workspace and chat stores), so it silently dropped the rows.
// The call site looked correct, which is exactly when a guard earns its keep.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const TABS_STORE = "stores/tabs.svelte";

/** The single file allowed to perform the raw list removal. */
const TEARDOWN_FILE = join(SRC, "routes", "+page.svelte");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** Files importing `closeTab` from the tabs store (under any local alias). */
function importersOfCloseTab(): { file: string; alias: string }[] {
  const out: { file: string; alias: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith(join("stores", "tabs.svelte.ts"))) continue;
    const src = readFileSync(file, "utf8");
    // Grab each `import { … } from "…stores/tabs.svelte"` block and look inside.
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*([^"']+)["']/g)) {
      if (!m[0].includes(TABS_STORE)) continue;
      for (const spec of m[1].split(",")) {
        const parts = spec.trim().split(/\s+as\s+/);
        if (parts[0] === "closeTab") out.push({ file, alias: (parts[1] ?? parts[0]).trim() });
      }
    }
  }
  return out;
}

describe("tab teardown guard", () => {
  it("only the teardown file imports the raw closeTab", () => {
    const importers = importersOfCloseTab();
    expect(importers.map((i) => i.file)).toEqual([TEARDOWN_FILE]);
  });

  it("the raw closeTab is called exactly once — inside closeTabFully", () => {
    const importers = importersOfCloseTab();
    const alias = importers[0].alias;
    const src = readFileSync(TEARDOWN_FILE, "utf8");
    const calls = [...src.matchAll(new RegExp(`\\b${alias}\\s*\\(`, "g"))];
    // More than one call site means a path that skips the teardown — the exact
    // shape of the bug this guard exists for.
    expect(calls).toHaveLength(1);

    // And that one call sits in the teardown function, not somewhere that merely
    // happens to be in the same file.
    const body = src.slice(src.indexOf("function closeTabFully"));
    expect(body.slice(0, body.indexOf("}"))).toContain(`${alias}(`);
  });

  it("the teardown drops every store keyed by the session id", () => {
    const src = readFileSync(TEARDOWN_FILE, "utf8");
    const body = src.slice(src.indexOf("function closeTabFully"));
    const fn = body.slice(0, body.indexOf("\n  }"));
    // Each of these owns per-session state; a new one must be added here too.
    for (const cleanup of [
      "removeWorkspace",
      "removeChat",
      "removeBroadcastMember",
      "removeDockState",
      "nginxConfigCache.delete",
    ]) {
      expect(fn).toContain(cleanup);
    }
  });

  it("no bulk close bypasses the teardown", () => {
    // The bulk closer used to live in the tabs store and was how server deletion
    // skipped the cleanup. Its replacement returns ids and closes nothing, so a
    // bulk caller has to go through the teardown itself.
    //
    // Checked structurally — export and import specifiers — rather than by
    // searching for the name: the first version of this guard failed on the
    // prose in a doc comment explaining why the function is gone.
    const banned = "closeTabsForServer";
    const store = readFileSync(join(SRC, "lib", "stores", "tabs.svelte.ts"), "utf8");
    expect(store).not.toMatch(new RegExp(`export\\s+(function|const)\\s+${banned}\\b`));

    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
        expect(names).not.toContain(banned);
      }
    }
  });
});
