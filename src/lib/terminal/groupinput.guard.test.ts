// Synchronous input as group work (ADR 0064).
//
// Each rule below is one of the ways the group's work quietly stops being one
// text for every member, or starts writing where nobody looked:
//
//  1. The line's history is the app's. The bar recalls with `recall` and writes
//     to no session itself: ↑ passed to four shells recalls four commands.
//  2. Keys go by the plan. `keys()` writes only to who `keysPlan` named — the
//     members on the same kind of screen — and only what `mirrorable` left; a
//     paste goes through each member's own paste.
//  3. Only the terminal in focus is a source: the page gives `onkeys` to that
//     terminal alone, or every member would echo its keys to all the others.
//  4. An upload to the group replaces only on its own question's answer:
//     `agreed` is the answer, never a literal.
//  5. The edit on the group writes a copy only against the hash it was read
//     with, and only after the source's own file was saved.
//
// Checked on the source with comments stripped; each check is a function over
// text, shown to catch its own violation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

/** Script without JS comments (markup comments can only over-flag here). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The text of the method or function starting at `head`, up to the next one at the same indent. */
function body(src: string, head: string, indent = "    "): string {
  const at = src.indexOf(head);
  if (at < 0) return "";
  const end = src.indexOf(`\n${indent}}`, at);
  return src.slice(at, end < 0 ? undefined : end);
}

const BAR = "src/lib/terminal/BroadcastBar.svelte";
const FLOW = "src/lib/page/broadcastflow.svelte.ts";
const PAGE = "src/routes/+page.svelte";
const UPLOAD = "src/lib/page/groupuploadflow.svelte.ts";
const EDIT = "src/lib/page/groupeditflow.svelte.ts";

export function historyViolations(bar: string): string[] {
  const c = code(bar);
  const out: string[] = [];
  if (/writeToTerminal|from "\.\.\/api/.test(c)) out.push("the bar writes to the sessions itself");
  const step = body(c, "function step(", "  ");
  if (!/recall\(recent, walk, value, dir\)/.test(step)) out.push("↑/↓ in the line no longer recall what the line sent");
  if (!/e\.key === "ArrowUp" \|\| e\.key === "ArrowDown"\) \{\s*e\.preventDefault\(\);/.test(c)) {
    out.push("↑/↓ in the line are not taken from the field");
  }
  return out;
}

export function keysViolations(flow: string): string[] {
  const c = code(flow);
  const keys = body(c, "keys(source: string, data: string)");
  const out: string[] = [];
  if (keys === "") return ["keys() not found"];
  if (!/const \{ to \} = keysPlan\(source\);/.test(keys)) out.push("keys are not sent by the plan of who is on the same screen");
  if (/deps\.targets\(\)/.test(keys)) out.push("keys are sent to the whole group, not to the plan");
  if (!/const keys = mirrorable\(data\);/.test(keys)) out.push("mouse and focus reports are passed on");
  if (!/pastedText\(data\)/.test(keys) || !/pasteInto\?\.\(paste\)/.test(keys)) {
    out.push("a paste is passed on with the source's brackets, not through each member's own paste");
  }
  if (!/keysReceivers\(source, deps\.targets\(\), deps\.screenOf\)/.test(c)) out.push("the plan does not ask each member's screen");
  return out;
}

export function sourceViolations(page: string): string[] {
  const c = code(page);
  return /onkeys=\{bcOn && bcFlow\.mode === "keys" && tabsState\.activeId === tab\.sessionId\s*\?/.test(c)
    ? []
    : ["a terminal other than the one in focus can be the source of the group's keys"];
}

export function uploadViolations(flow: string): string[] {
  const c = code(flow);
  const out: string[] = [];
  if (/\btransferStart\b/.test(c)) out.push("the group's upload starts a job other than through startTransfer");
  if (/agreed: true/.test(c)) out.push("the group's upload replaces without being asked");
  if (!/agreed: plan\.replace,/.test(c)) out.push("what may replace is not the answer to the group's question");
  if (!/hostSources\(a\.sources, h\.check, a\.replace\)/.test(c)) out.push("what each server is sent is not decided by hostSources");
  return out;
}

export function editViolations(flow: string): string[] {
  const c = code(flow);
  const apply = body(c, "async apply(doc: EditorDoc)");
  const out: string[] = [];
  if (apply === "") return ["apply() not found"];
  const saved = apply.indexOf("await deps.saveLead(");
  const write = apply.indexOf("sftpWriteText(");
  if (saved < 0 || write < 0 || saved > write) out.push("a copy is written before the source's own file was saved");
  if (!/if \(!saved\) \{[\s\S]*?return;\s*\}/.test(apply)) out.push("copies are written though the source's file was not saved");
  if (!/sftpWriteText\(h\.id, a\.path, text, file\.eol, file\.sha256,/.test(apply)) {
    out.push("a copy is written without the hash it was read with");
  }
  return out;
}

describe("synchronous input as group work (ADR 0064)", () => {
  it("1: the line's history is the app's, never the shells'", () => {
    expect(historyViolations(read(BAR))).toEqual([]);
  });

  it("2: keys go only by the plan of who is on the same screen", () => {
    expect(keysViolations(read(FLOW))).toEqual([]);
  });

  it("3: only the terminal in focus is the source of the group's keys", () => {
    expect(sourceViolations(read(PAGE))).toEqual([]);
  });

  it("4: an upload to the group replaces only on its own question's answer", () => {
    expect(uploadViolations(read(UPLOAD))).toEqual([]);
  });

  it("5: the edit on the group writes a copy against its hash, after the source was saved", () => {
    expect(editViolations(read(EDIT))).toEqual([]);
  });
});

describe("each check catches its own violation", () => {
  const swap = (src: string, from: string, to: string) => {
    expect(src.includes(from), `"${from}" not in the source`).toBe(true);
    return src.replace(from, to);
  };

  it("1", () => {
    const bar = read(BAR);
    expect(historyViolations(swap(bar, 'import Icon from "../ui/Icon.svelte";', 'import Icon from "../ui/Icon.svelte";\n  import { writeToTerminal } from "../api";'))).toContain(
      "the bar writes to the sessions itself",
    );
    expect(historyViolations(swap(bar, "recall(recent, walk, value, dir)", "null"))).toContain(
      "↑/↓ in the line no longer recall what the line sent",
    );
  });

  it("2", () => {
    const flow = read(FLOW);
    expect(keysViolations(swap(flow, "const { to } = keysPlan(source);", "const to = deps.targets();"))).toEqual(
      expect.arrayContaining([
        "keys are not sent by the plan of who is on the same screen",
        "keys are sent to the whole group, not to the plan",
      ]),
    );
    expect(keysViolations(swap(flow, "const keys = mirrorable(data);", "const keys = data;"))).toContain(
      "mouse and focus reports are passed on",
    );
  });

  it("3", () => {
    const page = read(PAGE);
    expect(sourceViolations(swap(page, " && tabsState.activeId === tab.sessionId\n", "\n"))).toHaveLength(1);
  });

  it("4", () => {
    const flow = read(UPLOAD);
    expect(uploadViolations(swap(flow, "agreed: plan.replace,", "agreed: true,"))).toEqual(
      expect.arrayContaining(["the group's upload replaces without being asked"]),
    );
  });

  it("5", () => {
    const flow = read(EDIT);
    expect(editViolations(swap(flow, "file.eol, file.sha256,", "file.eol, null,"))).toContain(
      "a copy is written without the hash it was read with",
    );
    expect(editViolations(swap(flow, "      if (!saved) {", "      if (false) {"))).toContain(
      "copies are written though the source's file was not saved",
    );
  });
});
