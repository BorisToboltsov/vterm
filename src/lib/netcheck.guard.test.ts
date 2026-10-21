import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Access check (v1.21, ADR 0032): what keeps a request check from turning into
// something nobody asked for.
//
// - A check runs only through the store (`startRun`/`retryRun`), and every
//   check it starts carries a stop handle set before the call — "Stop" must
//   reach whatever is running. The tool itself probes only who a host is
//   (no targets).
// - Sweeping a subnet is asked first: the run button goes through
//   `requestRun`, and the run starts only where no subnet is in the plan or
//   from the confirmation.
// - A paste becomes rules only by an act — the "Add" button or ⌘/Ctrl+Enter —
//   never from typing or an effect: what was read is shown before it is taken.
// - Rules and runs are filed by the home host, not by session: another tab
//   shows its own, never the previous server's (the bug this fixed).
// - One cap and one batch size on both sides: netcheck.ts and netcheck.rs.
//
// Every check is a function over source text (comments stripped) and shows,
// on a planted violation, that it catches its own.

const LIB = join(process.cwd(), "src", "lib");
const read = (p: string) => readFileSync(join(LIB, p), "utf8");

function strip(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** The text of `function name(` up to its closing brace at the start of a line. */
function fnBody(src: string, name: string): string {
  const at = src.search(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  if (at < 0) return "";
  const end = src.indexOf("\n  }\n", at);
  const end2 = src.indexOf("\n}\n", at);
  const stop = [end, end2].filter((e) => e > at).sort((a, b) => a - b)[0] ?? src.length;
  return src.slice(at, stop);
}

// ── The checks ───────────────────────────────────────────────────────────────

/** Files that call `netcheckRun(` (the API wrapper itself excluded). */
function runCallers(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([name, src]) => !name.endsWith("api/probe.ts") && /\bnetcheckRun\(/.test(strip(src)))
    .map(([name]) => name)
    .sort();
}

/** In the tool, every `netcheckRun(` probes identity only: no targets. */
function toolOnlyProbesIdentity(src: string): boolean {
  const calls = [...strip(src).matchAll(/netcheckRun\(([^;]*?)\)\s*;/gs)].map((m) => m[1]);
  return calls.length > 0 && calls.every((c) => /netcheckArgs\(\[\]\)\s*,\s*\[\]/.test(c));
}

/** In the store, the check carries the stop handle, set before the call, and Stop uses it. */
function storeCallsAreStoppable(src: string): boolean {
  const s = strip(src);
  const probe = fnBody(s, "probeHost");
  const set = probe.indexOf("h.cancelId =");
  const call = probe.indexOf("netcheckRun(");
  if (set < 0 || call < 0 || set > call) return false;
  const args = probe.slice(call, probe.indexOf(");", call));
  if (!/cancelId\s*,?\s*$/.test(args.trim())) return false;
  if ((s.match(/netcheckRun\(/g) ?? []).length !== 1) return false;
  return /sftpCancel\(h\.cancelId\)/.test(fnBody(s, "stopRun"));
}

/** A subnet in the plan is asked first: the button calls requestRun, the run starts only in `go`. */
function subnetIsAskedFirst(src: string): boolean {
  const s = strip(src);
  if ((s.match(/\bstartRun\(/g) ?? []).length !== 1) return false;
  if (!fnBody(s, "go").includes("startRun(")) return false;
  const req = fnBody(s, "requestRun");
  if (!/if\s*\(\s*subnetPlans\.length\s*>\s*0\s*\)\s*confirming\s*=\s*true;\s*else\s+void go\(\)/.test(req)) return false;
  const goCalls = [...s.matchAll(/(?<!function )\bgo\(\)/g)].length;
  // requestRun's else, the confirmation's onconfirm — and nowhere else.
  if (goCalls !== 2 || !/onconfirm=\{\(\)\s*=>\s*void go\(\)\}/.test(s)) return false;
  return /data-testid="netcheck-run"[\s\S]*?onclick=\{requestRun\}/.test(s);
}

/** A paste becomes rules only from the Add button or ⌘/Ctrl+Enter. */
function pasteAddsOnlyByAct(src: string): boolean {
  const s = strip(src);
  if (!/pasted\.rules\.map/.test(fnBody(s, "addPasted"))) return false;
  const uses = [...s.matchAll(/\baddPasted\b/g)].length;
  // The definition, the key handler, the button.
  if (uses !== 3) return false;
  if (!/onclick=\{addPasted\}/.test(s)) return false;
  if (!/metaKey \|\| e\.ctrlKey\)\)\s*\{\s*e\.preventDefault\(\);\s*addPasted\(\);/.test(fnBody(s, "onInboxKey"))) return false;
  // Nothing else touches what was read: every use of its rules is in addPasted.
  const all = [...s.matchAll(/pasted\??\.rules/g)].length;
  const inside = [...fnBody(s, "addPasted").matchAll(/pasted\??\.rules/g)].length;
  return all > 0 && all === inside;
}

/** The tool asks the store by its home host — never by a session id. */
function filedByHome(tool: string, store: string): boolean {
  const t = strip(tool);
  for (const fn of ["rowsOf", "runOf", "startRun", "stopRun", "retryRun"]) {
    for (const m of t.matchAll(new RegExp(`\\b${fn}\\(([^,)]*)`, "g"))) {
      if (m[1].trim() !== "homeKey") return false;
    }
  }
  const st = strip(store);
  return (
    /rows:\s*Record<string, RuleRow\[\]>/.test(st) &&
    /runs:\s*Record<string, NetRun>/.test(st) &&
    ![...st.matchAll(/netcheckState\.(?:rows|runs)\[([^\]]+)\]/g)].some((m) => m[1].trim() !== "home")
  );
}

/** The cap and the batch size are one number on both sides. */
function sidesAgree(ts: string, rs: string): boolean {
  const num = (src: string, re: RegExp) => Number(re.exec(src)?.[1] ?? NaN);
  return (
    num(ts, /export const MAX_CHECKS = (\d+);/) === num(rs, /pub const MAX_CHECKS: usize = (\d+);/) &&
    num(ts, /export const BATCH = (\d+);/) === num(rs, /const BATCH: usize = (\d+);/) &&
    !Number.isNaN(num(ts, /export const MAX_CHECKS = (\d+);/))
  );
}

// ── The gate ─────────────────────────────────────────────────────────────────

describe("access check guard", () => {
  const tool = read("UtilNetCheck.svelte");
  const store = read("stores/netcheck.svelte.ts");
  const table = read("NetCheckRuleTable.svelte");

  it("checks run only through the store and the tool's identity probe", () => {
    const files = Object.fromEntries(sourceFiles(LIB).map((f) => [f.slice(LIB.length + 1), readFileSync(f, "utf8")]));
    expect(runCallers(files)).toEqual(["UtilNetCheck.svelte", "stores/netcheck.svelte.ts"]);
    expect(toolOnlyProbesIdentity(tool)).toBe(true);
    // Planted: the tool checks targets itself.
    expect(toolOnlyProbesIdentity(tool.replace("netcheckArgs([]), []", "netcheckArgs(t), t"))).toBe(false);
    expect(runCallers({ ...files, "Other.svelte": "netcheckRun(a, b, c);" })).toContain("Other.svelte");
  });

  it("every check carries a stop handle, and Stop uses it", () => {
    expect(storeCallsAreStoppable(store)).toBe(true);
    expect(storeCallsAreStoppable(store.replace(/\n\s*cancelId,\n(\s*\);)/, "\n$1"))).toBe(false);
    expect(storeCallsAreStoppable(store.replace("sftpCancel(h.cancelId)", "sftpCancel(\"\")"))).toBe(false);
    // Planted: the handle is set only after the check has started.
    const set = /\n(\s*)h\.cancelId = (`[^`]*`);/.exec(store)!;
    const late = store.replace(set[0], "").replace("    const cur = hostOf(home, id, i);\n    if (!cur) return;\n    const rep", `    h.cancelId = ${set[2]};\n    const cur = hostOf(home, id, i);\n    if (!cur) return;\n    const rep`);
    expect(late).not.toBe(store);
    expect(storeCallsAreStoppable(late)).toBe(false);
  });

  it("a subnet sweep is asked first", () => {
    expect(subnetIsAskedFirst(tool)).toBe(true);
    expect(subnetIsAskedFirst(tool.replace("onclick={requestRun}", "onclick={go}"))).toBe(false);
    expect(subnetIsAskedFirst(tool.replace("if (subnetPlans.length > 0) confirming = true;\n    else void go();", "void go();"))).toBe(
      false,
    );
    expect(subnetIsAskedFirst(tool.replace("async function go() {", "async function go() {\n    void startRun(homeKey, [], 1, '');"))).toBe(
      false,
    );
  });

  it("a paste becomes rules only by an act", () => {
    expect(pasteAddsOnlyByAct(table)).toBe(true);
    expect(pasteAddsOnlyByAct(table.replace("bind:value={inbox}", "bind:value={inbox}\n    oninput={addPasted}"))).toBe(false);
    expect(pasteAddsOnlyByAct(table.replace("const summary =", "$effect(() => { if (pasted?.rules.length) setRows(homeKey, []); });\n  const summary ="))).toBe(
      false,
    );
  });

  it("rules and runs are filed by the home host", () => {
    expect(filedByHome(tool, store)).toBe(true);
    expect(filedByHome(tool.replace("rowsOf(homeKey)", "rowsOf(homeId ?? \"\")"), store)).toBe(false);
    expect(filedByHome(tool, store.replace("netcheckState.rows[home] = rows;", "netcheckState.rows[rows[0]?.id ?? home] = rows;"))).toBe(false);
  });

  it("the cap and the batch are one number on both sides", () => {
    const ts = read("netcheck.ts");
    const rs = readFileSync(join(process.cwd(), "src-tauri", "src", "netcheck.rs"), "utf8");
    expect(sidesAgree(ts, rs)).toBe(true);
    expect(sidesAgree(ts.replace(/MAX_CHECKS = \d+;/, "MAX_CHECKS = 512;"), rs)).toBe(false);
    expect(sidesAgree(ts, rs.replace(/const BATCH: usize = \d+;/, "const BATCH: usize = 64;"))).toBe(false);
  });
});
