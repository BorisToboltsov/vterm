// The journal of notifications (ADR 0062) is the one road every message
// takes, and the window shows it without being buried by it:
//
//  1. `notify` notes the message in the journal first — masked, for the journal
//     is kept on disk — and only then makes its toast. What is told nobody is not
//     a message at all but an event of the diagnostics (ADR 0063).
//  2. A window draws no more toasts than `fitToasts` lets it; the rest wait under
//     one line. Drawing the whole queue is what buried the window under a burst.
//  3. Taken off the bar, the bell does not take the journal with it: Settings →
//     Journal, the last group, draws the same list and the pin that puts the bell
//     back, and ⌘K opens the journal.
//  4. Every window hears the journal; only the main one tells the backend what the
//     settings say, as it is for everything the windows share.
//  5. The journal's numbers are one in the frontend and the backend: its event,
//     the ages it keeps, the most it keeps.
//  6. A panel that polls its host (Docker, k8s) has one read in flight at a time
//     and says a failed read in a strip, and as an event of the diagnostics once
//     a streak — a toast per tick buried the window when the link dropped.
//
// A check is a function over the source that names what it found; each is shown
// catching its own violation below.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** `src` without its `<!-- … -->` blocks, by scanning: one regex pass leaves a nested opener behind. */
function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    out += src[i++];
  }
  return out;
}

/** Source without comments: a mention in a comment proves nothing. */
const code = (src: string): string =>
  stripHtmlComments(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The body of `function name(` up to its closing brace at column 0. */
function body(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return "";
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end < 0 ? undefined : end);
}

const FILES = {
  toasts: "src/lib/stores/toasts.svelte.ts",
  toast: "src/lib/ui/Toast.svelte",
  nav: "src/lib/settings/settingsNav.ts",
  settings: "src/lib/settings/SettingsPanel.svelte",
  logs: "src/lib/notifications/JournalSettings.svelte",
  page: "src/routes/+page.svelte",
  api: "src/lib/api/journal.ts",
  pure: "src/lib/notifications/journal.ts",
  rust: "src-tauri/src/journal.rs",
  docker: "src/lib/docker/DockerPanel.svelte",
  k8s: "src/lib/k8s/K8sPanel.svelte",
  git: "src/lib/git/GitPanel.svelte",
} as const;
type Sources = Record<keyof typeof FILES, string>;
const sources = (): Sources =>
  Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)])) as Sources;

function noteViolations(toasts: string): string[] {
  const notify = body(code(toasts), "notify");
  const noted = notify.indexOf("noteJournal(");
  const toast = notify.indexOf("toastKey(");
  const out: string[] = [];
  if (noted < 0) out.push("notify does not note the message in the journal");
  else if (!/noteJournal\(\{[^}]*text: redactSecrets\(message\)\.text/.test(notify)) {
    out.push("notify notes the message unmasked");
  }
  if (toast < 0 || noted < 0 || toast < noted) out.push("a toast comes before its note");
  if (/opts\.quiet/.test(notify)) out.push("a message is told nobody");
  return out;
}

function toastViolations(toast: string): string[] {
  const src = code(toast);
  const out: string[] = [];
  if (!/const fit = \$derived\(fitToasts\(toastsState\.list\)\);/.test(src)) out.push("the toasts are not fitted");
  if (/\{#each toastsState\.list\b/.test(src) || !/\{#each fit\.shown as toast \(toast\.id\)\}/.test(src)) {
    out.push("the whole queue is drawn");
  }
  if (!/\{#if fit\.hidden > 0\}/.test(src)) out.push("what waits unseen is not said");
  return out;
}

function reachViolations(s: Pick<Sources, "nav" | "settings" | "logs" | "page">): string[] {
  const out: string[] = [];
  if (!/\{ id: "journal", icon: JOURNAL_ICON, sections: \["journal"\] \},\s*\];/.test(code(s.nav))) {
    out.push("Journal is not the last group of Settings");
  }
  if (!/\{#if show\("journal"\)\}\s*<JournalSettings\b/.test(code(s.settings))) out.push("Settings does not draw Journal");
  const logs = code(s.logs);
  if (!/<JournalList\b/.test(logs)) out.push("Journal does not show the list");
  if (!/unpinAction\("journal"\) : pinAction\("journal"\)/.test(logs)) {
    out.push("Journal has no pin for its button");
  }
  if (!/id: "act:journal"[^}]*run: openJournal/.test(code(s.page))) out.push("⌘K does not open the journal");
  return out;
}

function windowViolations(page: string): string[] {
  const src = code(page);
  const out: string[] = [];
  if (!/unlisteners\.push\(startJournal\(\)\);/.test(src)) out.push("a window does not hear the journal");
  if (!/if \(isMainWindow\) untrack\(\(\) => configureJournal\(keep, days\)\);/.test(src)) {
    out.push("the settings of the journal are not told by the main window alone");
  }
  return out;
}

/** The literal list after `name` in Rust (`[1, 7]`) or TS (`[1, 7] as const`), as numbers. */
function numbers(src: string, pattern: RegExp): string {
  return (pattern.exec(src)?.[1] ?? "").replace(/\s|_/g, "");
}

function numberViolations(s: Pick<Sources, "api" | "pure" | "rust">): string[] {
  const out: string[] = [];
  const event = (src: string, re: RegExp) => re.exec(src)?.[1];
  if (event(s.api, /JOURNAL_EVENT = "([^"]+)"/) !== event(s.rust, /pub const EVENT: &str = "([^"]+)"/)) {
    out.push("the journal's event differs");
  }
  const tsDays = numbers(s.pure, /JOURNAL_DAYS = \[([^\]]*)\]/);
  if (!tsDays || tsDays !== numbers(s.rust, /RETENTION_DAYS: \[u32; \d+\] = \[([^\]]*)\]/)) {
    out.push("the ages the journal keeps differ");
  }
  const tsMax = numbers(s.pure, /JOURNAL_MAX_ENTRIES = ([\d_]+)/);
  if (!tsMax || tsMax !== numbers(s.rust, /pub const MAX_ENTRIES: usize = ([\d_]+)/)) {
    out.push("the most the journal keeps differs");
  }
  return out;
}

/** The body of `function name(` in a component's script, up to its closing brace at two spaces. */
function scriptBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return "";
  const end = src.indexOf("\n  }\n", at);
  return src.slice(at, end < 0 ? undefined : end);
}

function pollViolations(panel: string, name: string): string[] {
  const src = code(panel);
  const out: string[] = [];
  if (!/const refresh = singleFlight\(readNow\);/.test(src)) out.push(`${name} reads over a read still out`);
  if (!/<PollFailStrip\b/.test(src)) out.push(`${name} does not say a failed read`);
  const read = scriptBody(src, "readNow");
  if (!/catch \(e\) \{\s*failedRead\(String\(e\)\);/.test(read)) out.push(`${name} does not take a failed read to its strip`);
  if (/notify(Error|Info|Success)\(/.test(read)) out.push(`${name} toasts from its poll`);
  const failed = scriptBody(src, "failedRead");
  if (/notify(Error|Info|Success)\(/.test(failed) || !/diag\.warn\(/.test(failed)) {
    out.push(`${name} says a failed read aloud, not to the diagnostics`);
  }
  return out;
}

const mutate = (src: string, from: string, to: string): string => {
  expect(src, `the guard's own fixture: ${from}`).toContain(from);
  return src.replace(from, to);
};

describe("journal guard", () => {
  const s = sources();

  it("every message is a note in the journal, masked, before any toast", () => {
    expect(noteViolations(s.toasts)).toEqual([]);
  });

  it("a window draws no more toasts than fit", () => {
    expect(toastViolations(s.toast)).toEqual([]);
  });

  it("the journal is reached without the bell", () => {
    expect(reachViolations(s)).toEqual([]);
  });

  it("every window hears the journal, the main one tells its settings", () => {
    expect(windowViolations(s.page)).toEqual([]);
  });

  it("the numbers of the journal are one in the frontend and the backend", () => {
    expect(numberViolations(s)).toEqual([]);
  });

  it("a panel's poll is one read at a time, and a failed one is a strip", () => {
    expect([...pollViolations(s.docker, "Docker"), ...pollViolations(s.k8s, "k8s"), ...pollViolations(s.git, "git")]).toEqual([]);
  });
});

describe("journal guard — catches what it exists for", () => {
  const s = sources();

  it("a message that never reaches the journal, reaches it unmasked or late, or is told nobody", () => {
    const line = "noteJournal({ kind, text: redactSecrets(message).text, source: opts.source, serverId, server });";
    expect(noteViolations(mutate(s.toasts, line, ""))).toEqual([
      "notify does not note the message in the journal",
      "a toast comes before its note",
    ]);
    expect(noteViolations(mutate(s.toasts, "text: redactSecrets(message).text", "text: message"))).toEqual([
      "notify notes the message unmasked",
    ]);
    const key = "const key = toastKey(kind, message, opts.source, serverId);";
    const late = mutate(mutate(s.toasts, line, ""), key, `${key}\n  ${line}`);
    expect(noteViolations(late)).toEqual(["a toast comes before its note"]);
    expect(noteViolations(mutate(s.toasts, key, `if (opts.quiet) return "";\n  ${key}`))).toEqual(["a message is told nobody"]);
  });

  it("the whole queue drawn", () => {
    const all = mutate(s.toast, "{#each fit.shown as toast (toast.id)}", "{#each toastsState.list as toast (toast.id)}");
    expect(toastViolations(all)).toEqual(["the whole queue is drawn"]);
    expect(toastViolations(mutate(s.toast, "{#if fit.hidden > 0}", "{#if false}"))).toEqual(["what waits unseen is not said"]);
  });

  it("a journal lost with its bell", () => {
    const notLast = mutate(s.nav, '{ id: "journal", icon: JOURNAL_ICON, sections: ["journal"] },', "");
    expect(reachViolations({ ...s, nav: notLast })).toEqual(["Journal is not the last group of Settings"]);
    expect(reachViolations({ ...s, settings: mutate(s.settings, "<JournalSettings", "<div") })).toEqual([
      "Settings does not draw Journal",
    ]);
    expect(reachViolations({ ...s, logs: mutate(s.logs, "<JournalList", "<div") })).toEqual(["Journal does not show the list"]);
    expect(
      reachViolations({ ...s, logs: mutate(s.logs, 'unpinAction("journal") : pinAction("journal")', "{}") }),
    ).toEqual(["Journal has no pin for its button"]);
    expect(reachViolations({ ...s, page: mutate(s.page, "run: openJournal", "run: () => {}") })).toEqual([
      "⌘K does not open the journal",
    ]);
  });

  it("a window deaf to the journal, a second window telling the settings", () => {
    expect(windowViolations(mutate(s.page, "unlisteners.push(startJournal());", ""))).toEqual([
      "a window does not hear the journal",
    ]);
    const every = mutate(
      s.page,
      "if (isMainWindow) untrack(() => configureJournal(keep, days));",
      "untrack(() => configureJournal(keep, days));",
    );
    expect(windowViolations(every)).toEqual(["the settings of the journal are not told by the main window alone"]);
  });

  it("numbers that drift apart", () => {
    expect(numberViolations({ ...s, api: mutate(s.api, '"window://journal"', '"window://notes"') })).toEqual([
      "the journal's event differs",
    ]);
    expect(numberViolations({ ...s, pure: mutate(s.pure, "[1, 7, 30, 90]", "[1, 7, 30, 365]") })).toEqual([
      "the ages the journal keeps differ",
    ]);
    expect(numberViolations({ ...s, rust: mutate(s.rust, "MAX_ENTRIES: usize = 1000", "MAX_ENTRIES: usize = 500") })).toEqual([
      "the most the journal keeps differs",
    ]);
  });

  it("a poll that piles up, toasts, or keeps its failure to itself", () => {
    expect(pollViolations(mutate(s.docker, "const refresh = singleFlight(readNow);", "const refresh = readNow;"), "Docker")).toEqual([
      "Docker reads over a read still out",
    ]);
    expect(pollViolations(mutate(s.k8s, "<PollFailStrip", "<div"), "k8s")).toEqual(["k8s does not say a failed read"]);
    expect(pollViolations(mutate(s.git, "const refresh = singleFlight(readNow);", "const refresh = readNow;"), "git")).toEqual([
      "git reads over a read still out",
    ]);
    const loud = mutate(s.docker, "failedRead(String(e));", 'notifyError(String(e), { source: "docker", sessionId });');
    expect(pollViolations(loud, "Docker")).toEqual([
      "Docker does not take a failed read to its strip",
      "Docker toasts from its poll",
    ]);
    const aloud = mutate(
      s.k8s,
      'diag.warn("k8s", `poll failed: ${text}`, undefined, { ...aboutSession(sessionId), code: "poll-failed" });',
      'notifyError(text, { source: "k8s", sessionId });',
    );
    expect(pollViolations(aloud, "k8s")).toEqual(["k8s says a failed read aloud, not to the diagnostics"]);
  });
});
