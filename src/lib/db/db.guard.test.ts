// Databases guard (ADR 0080). What holds only across several places:
//
// 1. The window does not say what the recording gets and is not where the lock
//    is held: `db_query`/`db_apply` take no line of audit, the backend builds it
//    and judges the statement before it runs.
// 2. SQL, results and the database's messages never reach the diagnostics or
//    the journal from the window: an error quotes the values it was about. What
//    may be told is a list (`TOLD`): a list of bad names passes a renamed one.
// 3. Work is never lost without a question: a document, a tab, a bulk close and
//    quitting each look at the store's `dbWork`.
// 4. What a database answers is text: no `{@html}` in the subsystem.
//
// Sources are read without comments: a rule written only in a comment is not a rule.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

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

const code = (src: string): string => stripHtmlComments(src).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** From `open` to the bracket that closes the first one after it. */
function span(src: string, open: string, brackets: "()" | "{}"): string {
  const at = src.indexOf(open);
  if (at < 0) return "";
  const from = src.indexOf(brackets[0], at);
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === brackets[0]) depth++;
    else if (src[i] === brackets[1] && --depth === 0) return src.slice(at, i + 1);
  }
  return "";
}

export function commandViolations(commands: string, api: string): string[] {
  const out: string[] = [];
  for (const name of ["db_query", "db_apply"]) {
    const args = span(code(commands), `fn ${name}(`, "()");
    if (!args) out.push(`${name} is missing`);
    else if (/\baudit\b|\bsaid\b/.test(args)) out.push(`${name} takes the recording's line from the window`);
  }
  if (/\baudit\b/.test(code(api))) out.push("the window sends a line for the recording");
  return out;
}

/** All the module tells the diagnostics and the journal, call by call. A new one is read for what it carries, then listed. */
const TOLD = [
  `diag.warn("db", "the activity was not read: the view shows its last answer")`,
  `diag.warn("db", "the database password was not kept in the keychain: the next connection asks again")`,
  `diag.info("db", "database profiles saved", { count: list.length, local: place === null })`,
  `diag.info("db", "table edits applied", { count: statements.length })`,
  `notifyError(t("db.act.stopFailed", { id: s.session.id, error: got.missing ? t("db.act.noSuch") : (got.error ?? "") }), { source: "db", sessionId })`,
  `notifySuccess(s.terminate ? t("db.act.terminated", { id: s.session.id }) : t("db.act.cancelled", { id: s.session.id }), { source: "db", sessionId })`,
  `notifySuccess(t("db.export.copied", { rows: out.rows.length }), { source: "db", sessionId })`,
  `notifyError(t("db.form.saveFailed", { error: failureText(dbFailure(e)) }), { source: "db" })`,
  `notifyError(failureText(dbFailure(e)), { source: "db" })`,
  `swallowed("db", "the previous database operation failed before the next one", error)`,
  `swallow("db", "the clipboard was not read: nothing was pasted")`,
  `swallow("db", "the SQL grammar did not load: the console has no highlighting or completion")`,
];

export function tellViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, raw] of Object.entries(files)) {
    const src = code(raw);
    for (const m of src.matchAll(/\b(diag(?:\.\w+|Event)|notify\w+|noteJournal|journalNote|noteRejected|swallowed|swallow|orNull)\(/g)) {
      const call = span(src.slice(m.index), m[1], "()").replace(/\s+/g, " ");
      if (!TOLD.includes(call)) out.push(`${name} tells the diagnostics or the journal something not on its list: ${call.slice(0, 120)}`);
    }
    // A stop's reason becomes a toast.
    const at = src.indexOf("export function stopDbSession(");
    const stop = at < 0 ? "" : src.slice(at, src.indexOf("\n}", at));
    if (/\.(message|detail|hint)\b/.test(stop)) out.push(`${name} gives a toast the database's words`);
    if (src.includes("{@html")) out.push(`${name} draws an answer as markup`);
  }
  return out;
}

export function lossViolations(page: string, editorflow: string): string[] {
  const out: string[] = [];
  const p = code(page);
  if (!/dbWorking\(sessionId\)/.test(span(p, "function requestCloseTab(", "{}"))) out.push("a tab closes over a database's work");
  if (!/if \(dbWorking\(tab\.sessionId\)\.length > 0\) return;/.test(span(p, "function closeInBulk(", "{}"))) out.push("a bulk close takes a database's work");
  if (!/const dirtyEditors = [^\n]*dbWork\(/.test(p)) out.push("quitting does not count a database's work");
  const close = span(code(editorflow), "requestClose(sid", "{}");
  if (!/const work = dbWork\(doc\.id\);\s*if \(work\) dbCloseAsk =/.test(close)) out.push("a document closes over a database's work");
  return out;
}

const files = (): Record<string, string> => ({
  ...Object.fromEntries(
    readdirSync(join(ROOT, "src/lib/db"))
      .filter((f) => /\.(svelte|ts)$/.test(f) && !f.includes(".test."))
      .map((f) => [f, read(`src/lib/db/${f}`)]),
  ),
  "stores/db.svelte.ts": read("src/lib/stores/db.svelte.ts"),
});

const COMMANDS = "src-tauri/src/commands/db.rs";
const PAGE = "src/routes/+page.svelte";
const FLOW = "src/lib/page/editorflow.svelte.ts";

describe("databases guard", () => {
  it("the backend writes the recording's line", () => {
    expect(commandViolations(read(COMMANDS), read("src/lib/api/db.ts"))).toEqual([]);
  });

  it("nothing a database said is told to the diagnostics or the journal, nor drawn as markup", () => {
    expect(tellViolations(files())).toEqual([]);
  });

  it("work is never lost without a question", () => {
    expect(lossViolations(read(PAGE), read(FLOW))).toEqual([]);
  });
});

describe("databases guard — catches what it exists for", () => {
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a window that writes the recording", () => {
    const rs = mutate(read(COMMANDS), "    writable: bool,\n) -> AppResult<Outcome>", "    writable: bool,\n    audit: Option<String>,\n) -> AppResult<Outcome>");
    expect(commandViolations(rs, read("src/lib/api/db.ts"))).toEqual(["db_query takes the recording's line from the window"]);
  });

  it("an answer in the diagnostics, in a toast, or as markup", () => {
    const store = mutate(files()["stores/db.svelte.ts"], 'diag.info("db", "table edits applied", { count: statements.length });', 'diag.info("db", "table edits applied", { count: statements.length, why: d.result.statement });');
    expect(tellViolations({ store })).toHaveLength(1);
    expect(tellViolations({ view: "notifyError(out.error.message);" })).toHaveLength(1);
    // The same under another name: a list of bad names let this one through.
    expect(tellViolations({ view: 'diag.warn("db", `connection failed: ${why}`);' })).toHaveLength(1);
    const toast = mutate(files()["stores/db.svelte.ts"], "error: errorCodeText(out.error) }", "error: out.error.message }");
    expect(tellViolations({ toast })).toEqual(["toast gives a toast the database's words"]);
    expect(tellViolations({ view: "<td>{@html value}</td>" })).toHaveLength(1);
  });

  it("work closed without its question", () => {
    const page = read(PAGE);
    const flow = read(FLOW);
    expect(lossViolations(mutate(page, " || dbWorking(sessionId).length > 0", ""), flow)).toEqual(["a tab closes over a database's work"]);
    expect(lossViolations(mutate(page, "if (dbWorking(tab.sessionId).length > 0) return;", ""), flow)).toEqual(["a bulk close takes a database's work"]);
    expect(lossViolations(mutate(page, " || (ed.db && dbWork(ed.id) !== null)", ""), flow)).toEqual(["quitting does not count a database's work"]);
    expect(lossViolations(page, mutate(flow, "if (work) dbCloseAsk =", "if (false) dbCloseAsk ="))).toEqual(["a document closes over a database's work"]);
  });
});
