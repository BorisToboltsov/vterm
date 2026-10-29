// Transfer-job guard (v1.12, ADR 0025).
//
// A transfer is a job of the backend. A window asks for one, shows the jobs of
// its sessions, and waits for none — that is what lets a tab leave for another
// window with its transfer under way, and what gives a copy between two
// sessions, whose tabs may stand in two windows, somewhere to live.
//
// Each rule below is one of the ways that quietly stops being true:
//
//  1. One path starts a job. `transferStart` (the command) is called from
//     `transferflow.ts` and nowhere else: that is where the destination is asked
//     which names it holds and the user is asked before a file is replaced
//     (v1.11.3). A second caller is a way to replace a file without a question.
//     Held by the lint rule `vterm/owned-imports` (and `invoke` by `invoke-in-api`).
//  2. Leave to replace comes from an answer. In `startTransfer` a file may
//     replace only because the caller said a system dialog agreed (`agreed`), or
//     because `uploadItems` said so after the question — never as a literal.
//  3. Nothing of a job lives in a window. The transfers store starts no job and
//     keeps no "which session owns this transfer" map; the panel keeps no loop
//     over the files of a batch.
//  4. A job in flight does not hold its tab. `DetachState` has no field for
//     transfers, and the window flow (page/windowflow) gives it none.
//  5. The window hears of jobs first and asks what is under way second — both
//     when it starts and when it takes a tab over. Asked first, a job that ended
//     in between would stay in the list for good.
//  6. A late event or list reply cannot restore a transfer after its SSH tab
//     closed. Both feeds check that this window still owns a side of the job.
//
// Checked on the source with comments stripped; each check is a function over
// text, shown to catch its own violation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** Drop `<!-- … -->`, `/* … *\/` and `// …` (not the `//` of a URL). */
export function code(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    out += source[i++];
  }
  return out.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const FLOW = "src/lib/transferflow.ts";
const STORE = "src/lib/stores/transfers.svelte.ts";
const PANEL = "src/lib/SftpPanel.svelte";
const HANDOFF = "src/lib/tabhandoff.ts";
const PAGE = "src/routes/+page.svelte";
const WINDOWS = "src/lib/page/windowflow.svelte.ts";

// ── 2: leave to replace comes from an answer ────────────────────────────────

export function replaceViolations(flow: string): string[] {
  const c = code(flow);
  const out: string[] = [];
  const fn = c.slice(c.indexOf("export async function startTransfer"));
  const agreed = /if \(req\.agreed\) \{([\s\S]*?)\n  \} else \{([\s\S]*?)\n  \}\n/.exec(fn);
  if (!agreed) return ["startTransfer no longer tells an agreed transfer from one to ask about"];
  const [, said, asked] = agreed;
  if (!/replace: true/.test(said)) out.push("an agreed transfer is not given leave to replace");
  if (/replace: true/.test(asked)) {
    out.push("a transfer nobody was asked about is given leave to replace");
  }
  if (!/uploadItems\(paths, check, ask \? await askReplace\(req\.destDir, check\) : "skip"\)/.test(asked)) {
    out.push("what may replace is not what the question answered");
  }
  if (!/const ask = check === null \|\| check\.clash\.length > 0;/.test(asked)) {
    out.push("a folder that could not be listed is not asked about");
  }
  return out;
}

// ── 3: nothing of a job lives in a window ───────────────────────────────────

export function ownershipViolations(store: string, panel: string): string[] {
  const out: string[] = [];
  const s = code(store);
  if (/\bowners\b|\btrackTransfer\b|\bsessionTransfers\b/.test(s)) {
    out.push("the transfers store keeps which session a transfer belongs to");
  }
  if (/\binvoke\b|\btransferStart\b|\bstartTransfer\b/.test(s)) {
    out.push("the transfers store starts a job");
  }
  const p = code(panel);
  if (/for \(const [^)]*\) \{[^}]*(startTransfer|transferStart)/.test(p)) {
    out.push("the panel loops over the files of a batch itself");
  }
  if (/\bbeginUpload\b|\bendUpload\b|\btrackTransfer\b/.test(p)) {
    out.push("the panel tracks a transfer it started");
  }
  return out;
}

// ── 4: a job in flight does not hold its tab ────────────────────────────────

export function detachViolations(handoff: string, flow: string): string[] {
  const out: string[] = [];
  const h = code(handoff);
  const state = /export interface DetachState \{([\s\S]*?)\n\}/.exec(h)?.[1] ?? "";
  if (state === "") out.push("DetachState not found");
  if (/\btransfers?\b/.test(state)) out.push("a transfer in flight keeps its tab in this window");
  const fn = /function stateOf\([\s\S]*?\n  \}\n/.exec(code(flow))?.[0] ?? "";
  if (fn === "") out.push("stateOf not found");
  if (/transfer/i.test(fn)) out.push("the window flow counts transfers when asked whether a tab may go");
  return out;
}

// ── 5: heard first, asked second ────────────────────────────────────────────

export function listenFirstViolations(page: string): string[] {
  const c = code(page);
  const out: string[] = [];
  const heard =
    /listenHere<TransferJob>\("sftp:\/\/job", \(e\) => hearJob\(e\.payload\)\)\s*\.then\(\(u\) => \{\s*unlisteners\.push\(u\);\s*return refreshTransfers\(\);/;
  if (!heard.test(c)) {
    out.push("the window asks what is under way before it listens — or does not ask at all");
  }
  // A tab taken over asks once what came with its session: the window flow
  // does (its behaviour tests), given the page's own way of asking.
  if (!/refreshTransfers: \(\) => void refreshTransfers\(\),/.test(c)) {
    out.push("a tab taken over arrives without the transfers that came with its session");
  }
  if ((c.match(/\bapplyJob\(/g) ?? []).length !== 2) {
    out.push("a job reaches the store by a path other than hearing it or asking for the list");
  }
  return out;
}

export function closedTabViolations(page: string): string[] {
  const c = code(page);
  const heard = c.split("function hearJob(job: TransferJob) {")[1]?.split("/** The jobs of this window")[0] ?? "";
  const listed = c.split("async function refreshTransfers() {")[1]?.split("// ──")[0] ?? "";
  const rejectsLateEvent = /if \(!jobVisibleInWindow\(job, [^;]+\)\) \{\s*removeTransfer\(job\.id\);\s*return;\s*\}\s*applyJob\(job\)/.test(heard);
  const rejectsLateList = /if \(jobVisibleInWindow\(job, [^;]+\)\) \{\s*applyJob\(job\);\s*\} else \{\s*removeTransfer\(job\.id\);/.test(listed);
  const out: string[] = [];
  if (!rejectsLateEvent) out.push("a late job event can restore a row after its SSH tab closed");
  if (!rejectsLateList) out.push("a list reply can restore a row after its SSH tab closed");
  return out;
}

describe("transfer-job guard", () => {
  it("leave to replace comes from an answer", () => {
    expect(replaceViolations(read(FLOW))).toEqual([]);
  });

  it("nothing of a job lives in a window", () => {
    expect(ownershipViolations(read(STORE), read(PANEL))).toEqual([]);
  });

  it("a job in flight does not hold its tab", () => {
    expect(detachViolations(read(HANDOFF), read(WINDOWS))).toEqual([]);
  });

  it("the window hears of jobs first and asks what is under way second", () => {
    expect(listenFirstViolations(read(PAGE))).toEqual([]);
  });

  it("ignores jobs after the last tab of their sessions closes", () => {
    expect(closedTabViolations(read(PAGE))).toEqual([]);
  });
});

describe("the guard catches", () => {
  const mutate = (source: string, from: string, to: string): string => {
    const out = source.replace(from, to);
    expect(out, `mutation "${from}" did not apply`).not.toBe(source);
    return out;
  };

  it("leave to replace handed out without a question", () => {
    const flow = read(FLOW);
    const always = mutate(
      flow,
      "      isDir: dirs.get(path)?.isDir ?? false,\n      replace,",
      "      isDir: dirs.get(path)?.isDir ?? false,\n      replace: true,",
    );
    expect(replaceViolations(always)).toEqual([
      "a transfer nobody was asked about is given leave to replace",
    ]);
    const unasked = mutate(
      flow,
      'ask ? await askReplace(req.destDir, check) : "skip"',
      '"replace"',
    );
    expect(replaceViolations(unasked)).toEqual(["what may replace is not what the question answered"]);
    const blind = mutate(
      flow,
      "const ask = check === null || check.clash.length > 0;",
      "const ask = check !== null && check.clash.length > 0;",
    );
    expect(replaceViolations(blind)).toEqual(["a folder that could not be listed is not asked about"]);
  });

  it("a window that owns a transfer again", () => {
    const store = read(STORE);
    const owned = `${store}\nconst owners = $state<Record<string, string>>({});\nexport function trackTransfer(id: string, s: string) { owners[id] = s; }\n`;
    expect(ownershipViolations(owned, read(PANEL))).toEqual([
      "the transfers store keeps which session a transfer belongs to",
    ]);
    const looping = mutate(
      read(PANEL),
      "    await startTransfer({\n      src: DISK,",
      "    for (const p of paths) { await startTransfer({ src: DISK, dst: here, sources: [{ path: p, isDir: false }], destDir }); }\n    await startTransfer({\n      src: DISK,",
    );
    expect(ownershipViolations(store, looping)).toEqual([
      "the panel loops over the files of a batch itself",
    ]);
  });

  it("a transfer that holds its tab again", () => {
    const handoff = mutate(
      read(HANDOFF),
      "  /** Its sync job is comparing or applying. */",
      "  /** Its transfers still in flight. */\n  transfers: number;\n  /** Its sync job is comparing or applying. */",
    );
    expect(detachViolations(handoff, read(WINDOWS))).toEqual([
      "a transfer in flight keeps its tab in this window",
    ]);
    const flow = mutate(
      read(WINDOWS),
      "      syncBusy: isBusy(peekSyncJob(sid)),\n      chatBusy",
      "      syncBusy: isBusy(peekSyncJob(sid)) || transfersOf(sid).length > 0,\n      chatBusy",
    );
    expect(detachViolations(read(HANDOFF), flow)).toEqual([
      "the window flow counts transfers when asked whether a tab may go",
    ]);
  });

  it("a window that asks before it listens, and a tab that arrives without its transfers", () => {
    const page = read(PAGE);
    const early = mutate(
      page,
      "        unlisteners.push(u);\n        return refreshTransfers();",
      "        unlisteners.push(u);",
    );
    expect(listenFirstViolations(early)).toEqual([
      "the window asks what is under way before it listens — or does not ask at all",
    ]);
    const bare = mutate(page, "    refreshTransfers: () => void refreshTransfers(),", "    refreshTransfers: () => {},");
    expect(listenFirstViolations(bare)).toEqual([
      "a tab taken over arrives without the transfers that came with its session",
    ]);
  });

  it("a late event or list reply that resurrects a closed tab's transfer", () => {
    const page = read(PAGE);
    const event = mutate(page, "      removeTransfer(job.id);\n      return;", "      return;");
    expect(closedTabViolations(event)).toEqual([
      "a late job event can restore a row after its SSH tab closed",
    ]);
    const list = mutate(page, "        } else {\n          removeTransfer(job.id);", "        } else {");
    expect(closedTabViolations(list)).toEqual([
      "a list reply can restore a row after its SSH tab closed",
    ]);
  });
});
