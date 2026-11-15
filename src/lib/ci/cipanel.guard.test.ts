// CI guard (ADR 0069). Three things that hold only together:
//
// 1. Every call to a forge goes through the CI store, and every write the store
//    makes is recorded (`[ci]` in the session recording): a panel calling
//    `ciRun` itself would skip the watches, the badges' cache and the cleanup on
//    close — and a write slipped in as a read would leave no trace.
// 2. A watched run is the one read that goes on with the panel hidden — so it
//    ends with the run, and with the tab: `forgetCi` drops a closed tab's
//    watches and stops the timer when none is left.
// 3. The schema of a run reads the file at the run's commit through the store,
//    never `git` itself: the schema reads only through its connection
//    (`pipeline.guard`), the store asks git on the same session.
// 4. The pipelines tab (ADR 0070) reads the repository's files through the
//    store's `readPipelines` — the schema's loader over the session's
//    connection — and never on a timer: on finding the repository, on
//    «Refresh», back on screen. The jobs its dots are coloured by are read
//    only while the panel is on screen.
//
// Sources are read without comments: a rule written only in a comment is not a rule.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** Drop `<!-- … -->` by scanning, not with one non-greedy `.replace` (CodeQL). */
function stripHtmlComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    out += text[i++];
  }
  return out;
}

const code = (src: string): string =>
  stripHtmlComments(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function files(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files(full, acc);
    else if (/\.(ts|svelte)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) acc.push(full);
  }
  return acc;
}

const STORE = "lib/stores/ci.svelte.ts";
const read = (rel: string) => code(readFileSync(join(SRC, rel), "utf8"));

/** The body of `function name(` up to the next top-level function. */
function fn(src: string, name: string): string {
  const at = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (at < 0) return "";
  const next = src.slice(at + 1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next);
}

/** Who calls `ciRun` other than the store. */
export function strayCallers(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([rel, src]) => rel !== STORE && rel !== "lib/api/ci.ts" && rel !== "lib/api/index.ts" && /\bciRun\b/.test(src))
    .map(([rel]) => rel);
}

/** The writes of the store that are not recorded, and the reads that are. */
export function auditViolations(store: string): string[] {
  const out: string[] = [];
  const write = fn(store, "write");
  if (!/await ask\(sessionId, args, true,/.test(write)) out.push("write() does not record its call");
  for (const name of ["rerunRun", "cancelRun", "startRun"]) {
    if (!/\breturn write\(/.test(fn(store, name))) out.push(`${name} does not go through write()`);
  }
  // Outside write(), nothing asks with `mirror` on.
  const rest = store.replace(write, "");
  if (/\bask\([^)]*,\s*true\b/.test(rest)) out.push("a call outside write() is recorded as a write");
  if (/\bciRun\([^)]*,\s*true\s*\)/.test(store)) out.push("ciRun is called with mirror outside ask()");
  return out;
}

/** A closed tab's watches stay, or the timer outlives the last watch. */
export function watchViolations(store: string): string[] {
  const out: string[] = [];
  const forget = fn(store, "forgetCi");
  if (!/ciWatch\.list = ciWatch\.list\.filter\(\(w\) => w\.sessionId !== sessionId\)/.test(forget)) out.push("forgetCi keeps the tab's watches");
  if (!/retime\(\)/.test(forget)) out.push("forgetCi leaves the timer running");
  const retime = fn(store, "retime");
  if (!/clearInterval\(timer\)/.test(retime)) out.push("the timer is never stopped");
  if (!/if \(isActive\(answer\.value\.state\)\) continue;\s*unwatchRun\(/.test(fn(store, "checkWatched"))) {
    out.push("a run that ended is not let go");
  }
  return out;
}

/** What the panel does that the pipelines tab forbids: files on a timer, or behind the store's back; the dots' jobs while hidden. */
export function pipesViolations(panel: string, store: string): string[] {
  const out: string[] = [];
  if (/\b(connectionFiles|sftpReadText|readLocalText|sftpList|localList)\b/.test(panel)) out.push("the panel reads files itself");
  if (!/\breadPipelines\(/.test(panel)) out.push("the panel does not read the pipelines through the store");
  const reader = fn(store, "readPipelines");
  if (!/connectionFiles\(/.test(reader) || !/loadGroup\(/.test(reader)) out.push("readPipelines does not use the schema's loader over the connection");
  for (const timer of panel.match(/setInterval\([^]*?\}, [\d_]+\)/g) ?? []) {
    if (/\breadPipes\(/.test(timer)) out.push("the pipeline files are read on a timer");
  }
  const at = panel.indexOf("void readLatestJobs()");
  const effect = at < 0 ? "" : panel.slice(panel.lastIndexOf("$effect(", at), at);
  if (!effect || !/\bvisible\b/.test(effect)) out.push("the dots' jobs are read while the panel is hidden");
  return out;
}

describe("CI guard (ADR 0069)", () => {
  const sources = Object.fromEntries(
    files(join(SRC, "lib")).map((f) => [relative(SRC, f).split("\\").join("/"), code(readFileSync(f, "utf8"))]),
  );
  const store = read(STORE);

  it("every call to a forge goes through the CI store", () => {
    expect(strayCallers(sources)).toEqual([]);
    expect(strayCallers({ "lib/ci/CiPanel.svelte": 'import { ciRun } from "../api";' })).toEqual(["lib/ci/CiPanel.svelte"]);
  });

  it("every write is recorded, and no read is", () => {
    expect(auditViolations(store)).toEqual([]);
    expect(auditViolations(store.replace("await ask(sessionId, args, true, 30)", "await ask(sessionId, args, false, 30)"))).toContain(
      "write() does not record its call",
    );
    expect(auditViolations(store.replace(/(export function cancelRun[^]*?)return write\(/, "$1return ask("))).toContain(
      "cancelRun does not go through write()",
    );
  });

  it("a watch ends with its run and with its tab", () => {
    expect(watchViolations(store)).toEqual([]);
    expect(watchViolations(store.replace("ciWatch.list = ciWatch.list.filter((w) => w.sessionId !== sessionId);", ""))).toContain(
      "forgetCi keeps the tab's watches",
    );
    expect(watchViolations(store.replace("clearInterval(timer);", ""))).toContain("the timer is never stopped");
  });

  it("the pipelines tab reads files through the store, never on a timer; its dots' jobs only on screen", () => {
    const panel = read("lib/ci/CiPanel.svelte");
    expect(pipesViolations(panel, store)).toEqual([]);
    expect(pipesViolations(`${panel}\nimport { sftpReadText } from "../api";`, store)).toContain("the panel reads files itself");
    expect(pipesViolations(panel.replace("const id = setInterval(() => {", "const id = setInterval(() => {\n void readPipes();"), store)).toContain(
      "the pipeline files are read on a timer",
    );
    expect(pipesViolations(panel.replace("if (!visible || !sessionReady || phase !== \"ready\") return;\n    untrack(() => void readLatestJobs());", "untrack(() => void readLatestJobs());"), store)).toContain(
      "the dots' jobs are read while the panel is hidden",
    );
    expect(pipesViolations(panel, store.replace("connectionFiles(local ? null : sessionId", "sftpReadText(sessionId"))).toContain(
      "readPipelines does not use the schema's loader over the connection",
    );
  });

  it("the schema of a run asks git through the store, never itself", () => {
    const view = read("lib/pipeline/PipelineView.svelte");
    expect(view).not.toMatch(/\bgitRun\b/);
    expect(view).toMatch(/\bfileAtCommit\(/);
    expect(fn(store, "fileAtCommit")).toMatch(/gitRun\(sessionId, root, \["show", `\$\{sha\}:\$\{rel\}`\]\)/);
  });
});
