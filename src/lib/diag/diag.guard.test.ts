// The diagnostics (ADR 0063) are one thing on two sides, reached from every
// window and kept out of the bell:
//
//  1. Their sources, threshold, event and the sizes on disk are one in the
//     frontend and the backend — a source only one side knows is written as none.
//  2. Every message the user is shown is an event too: `journal_note` writes it.
//  3. Every window hears the diagnostics — the threshold, its own uncaught
//     errors — and the main one tells the backend's panics.
//  4. The bell's popover shows the messages alone; the diagnostics are a layer
//     of Settings → Journal.
//  5. Rust writes through `tracing` only: printing is a clippy error outside
//     the tests, for nobody reads a GUI process's stdout — and nothing is
//     dropped in silence: `let _ =` over a `Result` and `.ok();` are clippy
//     errors too (ADR 0063, stage 2).
//  6. The mask is one: the shared examples hold `redactSecrets` and the
//     writer's mask (`diag/mask.rs`) alike.
//  7. Every kind of event the backend or a window writes (`code`) is one the
//     list titles — and every title has an event that wears it.
//
// A check is a function over the source that names what it found; each is shown
// catching its own violation below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../ai/redact";
import { DEFAULT_DIAG_SIZE_MB, DEFAULT_THRESHOLD, DIAG_CODES, DIAG_SIZES_MB, DIAG_SOURCES } from "./diag";

const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const FILES = {
  rust: "src-tauri/src/diag/mod.rs",
  journal: "src-tauri/src/journal.rs",
  api: "src/lib/api/diag.ts",
  page: "src/routes/+page.svelte",
  store: "src/lib/stores/diag.svelte.ts",
  bell: "src/lib/notifications/JournalPanel.svelte",
  settings: "src/lib/notifications/JournalSettings.svelte",
  cargo: "src-tauri/Cargo.toml",
  clippy: "src-tauri/clippy.toml",
} as const;
type Sources = Record<keyof typeof FILES, string>;
const sources = (): Sources =>
  Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)])) as Sources;

/** Rust's `SOURCES` array, as strings. */
function rustSources(rust: string): string[] {
  const list = /pub const SOURCES: \[&str; \d+\] = \[([^\]]*)\]/.exec(rust)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function oneThingViolations(
  s: Pick<Sources, "rust" | "api">,
  ts: { sources: readonly string[]; threshold: string; sizes: readonly number[]; size: number },
): string[] {
  const out: string[] = [];
  const rs = rustSources(s.rust);
  if ([...rs].sort().join() !== [...ts.sources].sort().join()) out.push("the sources differ");
  const def = /pub const DEFAULT_THRESHOLD: Level = Level::(\w+);/.exec(s.rust)?.[1]?.toLowerCase();
  if (def !== ts.threshold) out.push("the default threshold differs");
  const event = (src: string, re: RegExp) => re.exec(src)?.[1];
  if (event(s.api, /DIAG_EVENT = "([^"]+)"/) !== event(s.rust, /pub const EVENT: &str = "([^"]+)"/)) out.push("the event differs");
  const sizes = /pub const SIZES_MB: \[u32; \d+\] = \[([^\]]*)\]/.exec(s.rust)?.[1]?.replace(/\s/g, "");
  const size = Number(/pub const DEFAULT_SIZE_MB: u32 = (\d+);/.exec(s.rust)?.[1]);
  if (sizes !== ts.sizes.join(",") || size !== ts.size) out.push("the sizes on disk differ");
  return out;
}

/** The body of a Rust `fn name(` up to the next `\n}\n`. */
function rustFn(src: string, name: string): string {
  const at = src.indexOf(`fn ${name}(`);
  if (at < 0) return "";
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end < 0 ? undefined : end);
}

function shownViolations(journal: string): string[] {
  const body = rustFn(journal, "journal_note");
  const event = body.indexOf("crate::diag::shown(");
  const note = body.indexOf("journal.note(");
  if (event < 0) return ["a message shown is not an event"];
  return note >= 0 && note < event ? ["the event is written after the note, which moves it"] : [];
}

function windowViolations(s: Pick<Sources, "page" | "store">): string[] {
  const out: string[] = [];
  if (!/unlisteners\.push\(startDiag\(isMainWindow\)\);/.test(s.page)) out.push("a window does not hear the diagnostics");
  if (!/addEventListener\("error", onError\)/.test(s.store) || !/addEventListener\("unhandledrejection", onRejection\)/.test(s.store)) {
    out.push("a window's uncaught errors are not written");
  }
  if (!/news\.panics > panicsSeen && main/.test(s.store)) out.push("the backend's panics are not told by the main window");
  return out;
}

function bellViolations(s: Pick<Sources, "bell" | "settings">): string[] {
  const out: string[] = [];
  if (/DiagList|diag\.svelte/.test(s.bell)) out.push("the bell's popover shows the diagnostics");
  if (!/<DiagList\b/.test(s.settings) || !/<JournalList\b/.test(s.settings)) out.push("Settings → Journal lacks a layer");
  return out;
}

function printViolations(s: Pick<Sources, "cargo" | "clippy">): string[] {
  const out: string[] = [];
  for (const lint of ["print_stdout", "print_stderr", "dbg_macro", "let_underscore_must_use", "unused_result_ok"]) {
    if (!new RegExp(`^${lint}\\s*=\\s*"(?:warn|deny)"`, "m").test(s.cargo)) out.push(`clippy does not hold ${lint}`);
  }
  for (const allow of ["allow-print-in-tests", "allow-dbg-in-tests"]) {
    if (!new RegExp(`^${allow}\\s*=\\s*true`, "m").test(s.clippy)) out.push(`tests may not use ${allow.slice(6, -9)}`);
  }
  return out;
}

/** Every file under `dir` with one of `exts`, tests left out — path and text. */
function sourcesUnder(dir: string, exts: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path, exts));
    else if (exts.some((e) => name.endsWith(e)) && !name.endsWith(".test.ts")) out.push([path, read(path)]);
  }
  return out;
}

/** The Rust before its tests: the gates' own samples are not events. */
const rustCode = (src: string): string => src.split("\n#[cfg(test)]\nmod tests {")[0].split("\nmod gates {")[0];

/** The argument text of every call that starts at a match of `head`. */
function callArgs(text: string, head: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(head)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    out.push(text.slice(start, i));
  }
  return out;
}

/**
 * The codes written in `files`: in Rust `code = "x"` (tracing) and
 * `code = Some("x"…)` (an event built by hand); in TypeScript `code: "x"` in a
 * call of the facade.
 */
function codesWritten(files: [string, string][]): Set<string> {
  const found = new Set<string>();
  for (const [path, text] of files) {
    const places = path.endsWith(".rs") ? [text] : callArgs(text, /\b(?:diag\.(?:error|warn|info|debug)|diagEvent)\(/g);
    const shape = path.endsWith(".rs") ? /\bcode = (?:Some\()?"([a-z0-9-]+)"/g : /\bcode: "([a-z0-9-]+)"/g;
    for (const place of places) for (const m of place.matchAll(shape)) found.add(m[1]);
  }
  return found;
}

function codeViolations(files: [string, string][], codes: readonly string[]): string[] {
  const out: string[] = [];
  const known = new Set(codes);
  const written = codesWritten(files);
  for (const c of written) if (!known.has(c)) out.push(`code "${c}" has no title`);
  const all = files.map(([, t]) => t).join("\n");
  for (const c of codes) if (!written.has(c) && !all.includes(`"${c}"`)) out.push(`title "${c}" is worn by no event`);
  return out;
}

const eventSources = (): [string, string][] => [
  ...sourcesUnder("src-tauri/src", [".rs"]).map(([p, t]): [string, string] => [p, rustCode(t)]),
  ...sourcesUnder("src/lib", [".ts", ".svelte"]).filter(([p]) => !p.endsWith("diag/diag.ts") && !p.includes("/i18n/")),
  ...sourcesUnder("src/routes", [".svelte"]),
];

const mutate = (src: string, from: string, to: string): string => {
  expect(src, `the guard's own fixture: ${from}`).toContain(from);
  return src.replace(from, to);
};

const TS = { sources: DIAG_SOURCES, threshold: DEFAULT_THRESHOLD, sizes: DIAG_SIZES_MB, size: DEFAULT_DIAG_SIZE_MB };

describe("diagnostics guard", () => {
  const s = sources();

  it("the sources, threshold, event and size are one in the frontend and the backend", () => {
    expect(oneThingViolations(s, TS)).toEqual([]);
  });

  it("every message shown is an event of the diagnostics", () => {
    expect(shownViolations(s.journal)).toEqual([]);
  });

  it("every window hears the diagnostics and writes its uncaught errors", () => {
    expect(windowViolations(s)).toEqual([]);
  });

  it("the bell shows messages alone; the diagnostics are a layer of Settings → Journal", () => {
    expect(bellViolations(s)).toEqual([]);
  });

  it("Rust prints nowhere outside its tests and drops no Result in silence", () => {
    expect(printViolations(s)).toEqual([]);
  });

  it("every kind of event written has a title, and every title an event", () => {
    expect(codeViolations(eventSources(), DIAG_CODES)).toEqual([]);
  });

  it("the mask is one: the shared examples hold the frontend's", () => {
    const cases = JSON.parse(read("src/lib/ai/redact.cases.json")) as { input: string; output: string }[];
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) expect(redactSecrets(c.input).text, c.input).toBe(c.output);
  });
});

describe("diagnostics guard — catches what it exists for", () => {
  const s = sources();

  it("numbers and lists that drift apart", () => {
    expect(oneThingViolations({ ...s, rust: mutate(s.rust, '    "storage",\n];', "];") }, TS)).toEqual(["the sources differ"]);
    expect(oneThingViolations(s, { ...TS, threshold: "warn" })).toEqual(["the default threshold differs"]);
    expect(oneThingViolations({ ...s, api: mutate(s.api, '"window://diag"', '"window://log"') }, TS)).toEqual(["the event differs"]);
    expect(oneThingViolations({ ...s, rust: mutate(s.rust, "[5, 10, 25, 50, 100, 250]", "[5, 10, 25, 50, 100, 500]") }, TS)).toEqual([
      "the sizes on disk differ",
    ]);
    expect(oneThingViolations({ ...s, rust: mutate(s.rust, "DEFAULT_SIZE_MB: u32 = 25;", "DEFAULT_SIZE_MB: u32 = 50;") }, TS)).toEqual([
      "the sizes on disk differ",
    ]);
  });

  it("a message that is no event, or one written after its note", () => {
    const call = s.journal.slice(s.journal.indexOf("crate::diag::shown("), s.journal.indexOf("let summary = journal.note("));
    expect(shownViolations(mutate(s.journal, call, ""))).toEqual(["a message shown is not an event"]);
    const late = mutate(s.journal, call, "").replace("announce(&app, summary)\n}", `${call}announce(&app, summary)\n}`);
    expect(shownViolations(late)).toEqual(["the event is written after the note, which moves it"]);
  });

  it("a window deaf to the diagnostics, blind to its errors, or a panic told by nobody", () => {
    expect(windowViolations({ ...s, page: mutate(s.page, "unlisteners.push(startDiag(isMainWindow));", "") })).toEqual([
      "a window does not hear the diagnostics",
    ]);
    expect(windowViolations({ ...s, store: mutate(s.store, 'window.addEventListener("error", onError);', "") })).toEqual([
      "a window's uncaught errors are not written",
    ]);
    expect(windowViolations({ ...s, store: mutate(s.store, "news.panics > panicsSeen && main", "false") })).toEqual([
      "the backend's panics are not told by the main window",
    ]);
  });

  it("the diagnostics in the bell, or a layer missing", () => {
    expect(bellViolations({ ...s, bell: `${s.bell}\n<DiagList here="main" />` })).toEqual(["the bell's popover shows the diagnostics"]);
    expect(bellViolations({ ...s, settings: mutate(s.settings, "<DiagList", "<div") })).toEqual(["Settings → Journal lacks a layer"]);
  });

  it("a kind with no title, a title with no event", () => {
    const files: [string, string][] = [["a.rs", 'tracing::info!(source = "app", code = "brand-new", "x");']];
    expect(codeViolations(files, ["brand-new"])).toEqual([]);
    expect(codeViolations(files, [])).toEqual(['code "brand-new" has no title']);
    expect(codeViolations(files, ["brand-new", "gone"])).toEqual(['title "gone" is worn by no event']);
    const facade: [string, string][] = [["b.ts", 'diag.info("ai", "x", undefined, { code: "deny-list" });']];
    expect(codeViolations(facade, [])).toEqual(['code "deny-list" has no title']);
  });

  it("a print let through", () => {
    expect(printViolations({ ...s, cargo: mutate(s.cargo, 'print_stderr = "warn"', "") })).toEqual(["clippy does not hold print_stderr"]);
    expect(printViolations({ ...s, clippy: mutate(s.clippy, "allow-print-in-tests = true", "") })).toEqual(["tests may not use print"]);
    expect(printViolations({ ...s, cargo: mutate(s.cargo, 'let_underscore_must_use = "warn"', "") })).toEqual([
      "clippy does not hold let_underscore_must_use",
    ]);
  });
});
