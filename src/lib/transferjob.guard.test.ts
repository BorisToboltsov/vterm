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
//  2. Leave to replace comes from an answer. In `startTransfer` a file may
//     replace only because the caller said a system dialog agreed (`agreed`), or
//     because `uploadItems` said so after the question — never as a literal.
//  3. Nothing of a job lives in a window. The transfers store starts no job and
//     keeps no "which session owns this transfer" map; the panel keeps no loop
//     over the files of a batch.
//  4. A job in flight does not hold its tab. `DetachState` has no field for
//     transfers, and the page gives it none.
//  5. The window hears of jobs first and asks what is under way second — both
//     when it starts and when it takes a tab over. Asked first, a job that ended
//     in between would stay in the list for good.
//
// Checked on the source with comments stripped; each check is a function over
// text, shown to catch its own violation.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

function sources(dir = "src"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(rel);
  }
  return out;
}

const unix = (rel: string): string => relative(ROOT, join(ROOT, rel)).split(sep).join("/");

const API = "src/lib/api/files.ts";
const FLOW = "src/lib/transferflow.ts";
const STORE = "src/lib/stores/transfers.svelte.ts";
const PANEL = "src/lib/SftpPanel.svelte";
const HANDOFF = "src/lib/tabhandoff.ts";
const PAGE = "src/routes/+page.svelte";

// ── 1: one path starts a job ────────────────────────────────────────────────

/** Files other than the API wrapper and the flow that start a job themselves. */
export function starterViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [rel, source] of Object.entries(files)) {
    if (rel === API || rel === FLOW) continue;
    const c = code(source);
    if (/\btransferStart\s*\(/.test(c) || /["']transfer_start["']/.test(c)) {
      out.push(`${rel} starts a transfer itself — no question is asked before a file is replaced`);
    }
  }
  return out;
}

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

export function detachViolations(handoff: string, page: string): string[] {
  const out: string[] = [];
  const h = code(handoff);
  const state = /export interface DetachState \{([\s\S]*?)\n\}/.exec(h)?.[1] ?? "";
  if (state === "") out.push("DetachState not found");
  if (/\btransfers?\b/.test(state)) out.push("a transfer in flight keeps its tab in this window");
  const fn = /function detachStateOf\([\s\S]*?\n  \}\n/.exec(code(page))?.[0] ?? "";
  if (fn === "") out.push("detachStateOf not found");
  if (/transfer/i.test(fn)) out.push("the page counts transfers when asked whether a tab may go");
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
  const adopt = /unpackTab\(packet, drop\);([\s\S]{0,200}?)return true;/.exec(c)?.[1] ?? "";
  if (!/refreshTransfers\(\)/.test(adopt)) {
    out.push("a tab taken over arrives without the transfers that came with its session");
  }
  if ((c.match(/\bapplyJob\(/g) ?? []).length !== 2) {
    out.push("a job reaches the store by a path other than hearing it or asking for the list");
  }
  return out;
}

describe("transfer-job guard", () => {
  const files = Object.fromEntries(sources().map((rel) => [unix(rel), read(rel)]));

  it("one path starts a job", () => {
    expect(starterViolations(files)).toEqual([]);
  });

  it("leave to replace comes from an answer", () => {
    expect(replaceViolations(read(FLOW))).toEqual([]);
  });

  it("nothing of a job lives in a window", () => {
    expect(ownershipViolations(read(STORE), read(PANEL))).toEqual([]);
  });

  it("a job in flight does not hold its tab", () => {
    expect(detachViolations(read(HANDOFF), read(PAGE))).toEqual([]);
  });

  it("the window hears of jobs first and asks what is under way second", () => {
    expect(listenFirstViolations(read(PAGE))).toEqual([]);
  });
});

describe("the guard catches", () => {
  const mutate = (source: string, from: string, to: string): string => {
    const out = source.replace(from, to);
    expect(out, `mutation "${from}" did not apply`).not.toBe(source);
    return out;
  };

  it("a panel that starts a job itself", () => {
    const panel = mutate(
      read(PANEL),
      "await startTransfer({\n      src: DISK,",
      "await transferStart({\n      src: DISK,",
    );
    expect(starterViolations({ [PANEL]: panel })).toHaveLength(1);
    // Or goes to the command directly.
    expect(starterViolations({ "src/lib/x.ts": 'invoke("transfer_start", { spec });' })).toHaveLength(1);
    // A comment that names the command starts nothing.
    expect(starterViolations({ "src/lib/x.ts": "// see transferStart(spec)" })).toEqual([]);
  });

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
    expect(detachViolations(handoff, read(PAGE))).toEqual([
      "a transfer in flight keeps its tab in this window",
    ]);
    const page = mutate(
      read(PAGE),
      "      syncBusy: isBusy(peekSyncJob(sid)),\n      chatBusy",
      "      syncBusy: isBusy(peekSyncJob(sid)) || transfersOf(sid).length > 0,\n      chatBusy",
    );
    expect(detachViolations(read(HANDOFF), page)).toEqual([
      "the page counts transfers when asked whether a tab may go",
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
    const bare = mutate(page, "    void refreshTransfers();\n    return true;", "    return true;");
    expect(listenFirstViolations(bare)).toEqual([
      "a tab taken over arrives without the transfers that came with its session",
    ]);
  });
});
