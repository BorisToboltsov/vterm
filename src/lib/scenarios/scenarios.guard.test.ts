// Scenarios guard (ADR 0071, 0072). What holds the subsystem together across files:
//
//  1. A playbook run is typed only as `playbookLine` builds it, and only after
//     the run is watched — a run started unwatched leaves its folder (with the
//     task results of the servers) on the host until the tab closes.
//  2. Terraform applies only the saved plan the view showed: `applyArgv` with
//     the plan's path, never an `apply` of its own making.
//  3. Nothing the servers said (a task's message, a diff, a recipe's output)
//     and no recipe text is rendered as markup: no `{@html}` here.
//  4. A finished run's folder goes at once, and a closing tab takes the rest
//     (`forgetScenarios`, called from `closeTabFully` — `tabteardown.guard`).
//  5. The sudo password of a recipe run reaches only `recipeRun`: no event, no
//     message, no setting carries it.
//  6. A file of «Mine» is written over only where the seeding plan allows it —
//     a shipped file the app wrote and nobody changed (`seedPlan`, ADR 0072):
//     `recipeSave` with `replace` is called by the store's save, which the
//     panel and the page never ask to replace, and by `writeShipped`, which
//     writes only a plan of `seedPlan` or `restorePlan`.
//
// Every check is a function over source text with comments removed, and shows
// on a mutated copy that it catches the violation it exists for.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src", "lib", "scenarios");
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Source without comments — a mention in a comment proves nothing. */
function code(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith("//", i) && src[i - 1] !== ":") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
      continue;
    }
    out += src[i++];
  }
  return out;
}

/** The body of `function name(` up to the next function at the same indentation. */
function fnBody(src: string, name: string): string {
  const at = src.search(new RegExp(`function ${name}\\(`));
  if (at < 0) return "";
  const rest = src.slice(at);
  const end = rest.slice(1).search(/\n  (?:async )?function |\nexport (?:async )?function |\nfunction /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

export function runViolations(view: string): string[] {
  const launch = fnBody(code(view), "launch");
  const out: string[] = [];
  if (!/const line = playbookLine\(/.test(launch)) out.push("the playbook line is not playbookLine's");
  const watched = launch.indexOf("watchAnsibleRun(");
  const typed = launch.indexOf("onTypeLine(line)");
  if (typed < 0) out.push("the run is not typed");
  else if (watched < 0 || watched > typed) out.push("the run is typed before it is watched");
  if ((code(view).match(/onTypeLine\(/g) ?? []).length !== 1) out.push("a line is typed outside launch");
  return out;
}

export function applyViolations(view: string, others: Record<string, string>): string[] {
  const out: string[] = [];
  const c = code(view);
  if (!/onTypeArgv\(applyArgv\(root, p\.planPath\)\)/.test(fnBody(c, "applyPlan"))) out.push("the plan applied is not the one saved");
  for (const [file, src] of Object.entries(others)) {
    if (file === "tfplan.ts") continue;
    if (/["']terraform["'][^\]]*["']apply["']|terraform apply/.test(code(src))) {
      out.push(`${file} builds an apply of its own`);
    }
  }
  return out;
}

export const htmlViolations = (files: Record<string, string>): string[] =>
  Object.entries(files)
    .filter(([, src]) => /\{@html\b/.test(code(src)))
    .map(([f]) => `${f} renders markup`);

export function cleanupViolations(store: string): string[] {
  const c = code(store);
  const out: string[] = [];
  const poll = fnBody(c, "pollAnsible");
  const ended = poll.indexOf("if (ended) {");
  if (ended < 0 || poll.indexOf("cleanWatch(sessionId)", ended) < 0) out.push("a finished run keeps its folder");
  const forget = fnBody(c, "forgetScenarios");
  if (!/iacCleanup\(sessionId, w\.tempDir\)/.test(forget) || !/iacCleanup\(sessionId, p\.tempDir\)/.test(forget)) {
    out.push("a closing tab leaves a folder of a run");
  }
  return out;
}

/** The top-level arguments of each call `name(` in `src` — its definition is not a call. */
function callArgs(src: string, name: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  for (const m of src.matchAll(re)) {
    if (/function\s+$/.test(src.slice(Math.max(0, (m.index ?? 0) - 12), m.index))) continue;
    const args: string[] = [];
    let depth = 0;
    let cur = "";
    for (let i = (m.index ?? 0) + m[0].length; i < src.length; i++) {
      const ch = src[i];
      if (ch === ")" && depth === 0) break;
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      if (ch === "," && depth === 0) {
        args.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push(args);
  }
  return out;
}

export function overwriteViolations(store: string, callers: Record<string, string>): string[] {
  const c = code(store);
  const out: string[] = [];
  for (const args of callArgs(c, "recipeSave")) {
    const call = args.join(", ");
    if (call !== "name, text, replace" && call !== "w.file, w.text, w.replace") out.push(`recipeSave(${call}) outside the save and the seeding`);
  }
  if (!/await recipeSave\(name, text, replace\)/.test(fnBody(c, "saveRecipe"))) out.push("the save does not pass on its caller's replace");
  for (const args of callArgs(c, "writeShipped")) {
    if (args.length !== 1 || !(args[0] === "plan" || args[0].startsWith("restorePlan("))) out.push(`writeShipped(${args.join(", ")}) is not a plan of the seeding`);
  }
  if (!/const plan = seedPlan\(/.test(fnBody(c, "seedShipped"))) out.push("the seeding plan is not seedPlan's");
  for (const [file, src] of Object.entries(callers)) {
    for (const args of callArgs(code(src), "saveRecipe")) {
      if (args.length > 2) out.push(`${file} asks a save to replace: saveRecipe(${args.join(", ")})`);
    }
  }
  return out;
}

export function passwordViolations(store: string, panel: string): string[] {
  const out: string[] = [];
  for (const [name, src] of [["store", code(store)], ["panel", code(panel)]] as const) {
    for (const m of src.matchAll(/\b(?:diag\.\w+|notify\w+|swallowed?|orNull)\(([^;]*)/g)) {
      if (/password/i.test(m[1])) out.push(`the ${name} writes the password: ${m[0].slice(0, 60)}`);
    }
    if (/settings\.\w+\s*=[^=][^;]*password/i.test(src)) out.push(`the ${name} keeps the password in the settings`);
  }
  if (!/password: spec\.password/.test(fnBody(code(store), "runOnHost"))) out.push("the password does not reach recipeRun");
  return out;
}

const VIEW = "src/lib/scenarios/ProjectView.svelte";
const STORE = "src/lib/stores/scenarios.svelte.ts";
const PANEL = "src/lib/scenarios/ScenariosPanel.svelte";
const PAGE = "src/routes/+page.svelte";
const all = Object.fromEntries(
  readdirSync(DIR)
    .filter((f) => /\.(svelte|ts)$/.test(f) && !f.endsWith(".test.ts"))
    .map((f) => [f, readFileSync(join(DIR, f), "utf8")]),
);

describe("scenarios guard", () => {
  it("a playbook run is typed as playbookLine builds it, once it is watched", () => {
    expect(runViolations(read(VIEW))).toEqual([]);
  });
  it("Terraform applies only the saved plan", () => {
    expect(applyViolations(read(VIEW), all)).toEqual([]);
  });
  it("nothing of the servers is rendered as markup", () => {
    expect(htmlViolations(all)).toEqual([]);
  });
  it("a finished run's folder goes at once, a closing tab takes the rest", () => {
    expect(cleanupViolations(read(STORE))).toEqual([]);
  });
  it("a recipe's sudo password reaches only the run", () => {
    expect(passwordViolations(read(STORE), read(PANEL))).toEqual([]);
  });
  it("a file of «Mine» is written over only where the seeding plan allows it", () => {
    expect(overwriteViolations(read(STORE), { [PANEL]: read(PANEL), [PAGE]: read(PAGE) })).toEqual([]);
  });
});

describe("scenarios guard — catches what it exists for", () => {
  const view = read(VIEW);
  const store = read(STORE);
  const mutate = (src: string, from: string, to: string) => {
    expect(src).toContain(from);
    return src.replace(from, to);
  };

  it("a run typed before it is watched, or built by hand", () => {
    const early = mutate(view, "    watchAnsibleRun({", "    onTypeLine(line);\n    watchAnsibleRun({");
    expect(runViolations(early)).toContain("a line is typed outside launch");
    const typedFirst = mutate(view, "    lastChoice = choice;\n    tab = \"run\";\n    onTypeLine(line);", "    lastChoice = choice;\n    tab = \"run\";");
    expect(runViolations(mutate(typedFirst, "    watchAnsibleRun({", "    onTypeLine(line);\n    watchAnsibleRun({"))).toContain(
      "the run is typed before it is watched",
    );
    expect(runViolations(mutate(view, "const line = playbookLine(", "const line = handMade("))).toContain("the playbook line is not playbookLine's");
  });

  it("an apply of another plan, or of none", () => {
    expect(applyViolations(mutate(view, "onTypeArgv(applyArgv(root, p.planPath))", 'onTypeArgv(["terraform", "apply"])'), {})).toContain(
      "the plan applied is not the one saved",
    );
    expect(applyViolations(view, { "X.svelte": 'onTypeArgv(["terraform", "apply", "-auto-approve"])' })).toEqual(["X.svelte builds an apply of its own"]);
  });

  it("markup from a server", () => {
    expect(htmlViolations({ "AnsibleRunView.svelte": "<pre>{@html cell.msg}</pre>" })).toEqual(["AnsibleRunView.svelte renders markup"]);
  });

  it("a folder left behind", () => {
    expect(cleanupViolations(mutate(store, "      cleanWatch(sessionId);\n    }\n    return !ended;", "    }\n    return !ended;"))).toContain(
      "a finished run keeps its folder",
    );
    expect(cleanupViolations(store.replace(/iacCleanup\(sessionId, p\.tempDir\)/g, "noop(p.tempDir)"))).toContain("a closing tab leaves a folder of a run");
  });

  it("a password in an event, a message or the settings", () => {
    const panel = read(PANEL);
    expect(passwordViolations(`${store}\ndiag.info("scenarios", "run", { password: spec.password });`, panel)).toHaveLength(1);
    expect(passwordViolations(store, `${panel}\nsettings.scenarioTab = ask.password;`)).toHaveLength(1);
    expect(passwordViolations(mutate(store, "      password: spec.password,", "      password: null,"), panel)).toContain(
      "the password does not reach recipeRun",
    );
  });

  it("a save that replaces, a write of the build's text by hand", () => {
    const panel = read(PANEL);
    expect(overwriteViolations(store, { [PANEL]: mutate(panel, "await saveRecipe(file, r.text);", "await saveRecipe(file, r.text, true);") })).toEqual([
      `${PANEL} asks a save to replace: saveRecipe(file, r.text, true)`,
    ]);
    expect(overwriteViolations(`${store}\nconst x = () => recipeSave("install-docker.sh", shipped, true);`, {})).toContain(
      'recipeSave("install-docker.sh", shipped, true) outside the save and the seeding',
    );
    expect(overwriteViolations(mutate(store, "const written = await writeShipped(plan);", "const written = await writeShipped({ writes: all, seeded: {} });"), {})).toContain(
      "writeShipped({ writes: all, seeded: {} }) is not a plan of the seeding",
    );
    expect(overwriteViolations(mutate(store, "const plan = seedPlan(", "const plan = everything("), {})).toContain("the seeding plan is not seedPlan's");
  });
});
