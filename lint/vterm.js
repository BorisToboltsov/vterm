// vterm's own lint rules (stage D of the 1.25 refactor).
//
// Each rule used to be a `*.guard.test.ts` that read source text with a regex.
// As a rule it reads the syntax tree — a comment or a string can neither trip nor
// satisfy it — and it shows up in the editor while the code is written, not only
// in the test run. Every rule names the invariant it holds (docs/INVARIANTS.md);
// src/lib/lint.guard.test.ts proves each one still catches the violation it
// exists for. An exception is an `eslint-disable` comment with its reason: the
// config reports a directive that no longer suppresses anything, so a stale
// exception fails the run, as it did in the gates.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "src", "lib");
const ROUTES = path.join(ROOT, "src", "routes");

/** A rule that reports one message; `visit` returns the AST visitor. */
function rule(description, message, visit) {
  return {
    meta: { type: "problem", docs: { description }, schema: [], messages: { bad: message } },
    create(context) {
      return visit(context, (node, data) => context.report({ node, messageId: "bad", data }));
    },
  };
}

/** The text of a string-ish node — a literal, a template chunk, markup text — or null. */
function stringOf(node) {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateElement") return node.value.cooked ?? node.value.raw;
  if (node.type === "SvelteLiteral") return node.value;
  return null;
}

/** Visits every node below `node` (not `node` itself). */
function walk(context, node, fn) {
  for (const key of context.sourceCode.visitorKeys[node.type] ?? []) {
    const child = node[key];
    for (const n of Array.isArray(child) ? child : [child]) {
      if (n && typeof n.type === "string") {
        fn(n);
        walk(context, n, fn);
      }
    }
  }
}

/** Whether `node` or anything below it passes `test`. */
function some(context, node, test) {
  let found = test(node);
  walk(context, node, (n) => {
    found ||= test(n);
  });
  return found;
}

function insideAttribute(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === "SvelteAttribute" || n.type === "SvelteDirective") return true;
  }
  return false;
}

const isMember = (n, prop) =>
  n?.type === "MemberExpression" && !n.computed && n.property.type === "Identifier" && n.property.name === prop;
const directiveName = (node) => node.key.name.name ?? node.key.name;
const attributeName = (node) => (node.type === "SvelteAttribute" ? node.key.name : null);

// ── Imports and layers ──────────────────────────────────────────────────────────

/** Where an import points: an absolute path for project files, the bare name otherwise. */
function target(file, source) {
  if (source.startsWith(".")) return { file: path.resolve(path.dirname(file), source) };
  if (source === "$lib" || source.startsWith("$lib/")) return { file: path.join(LIB, source.slice(4)) };
  return { pkg: source };
}

const under = (file, dir) => file === dir || file.startsWith(dir + path.sep);

/** `./Foo.svelte` is a component; `./settings.svelte` names the runes module `settings.svelte.ts`. */
const isComponent = (file) => file.endsWith(".svelte") && !existsSync(`${file}.ts`);
const isRunes = (file) => /\.svelte(\.ts)?$/.test(file) && !isComponent(file);

/** Calls `fn(node, target)` for every value import, re-export and dynamic import. */
function eachImport(context, fn) {
  const file = context.filename;
  const typeOnly = (node) =>
    node.importKind === "type" ||
    node.exportKind === "type" ||
    (node.specifiers?.length > 0 &&
      node.specifiers.every((s) => s.importKind === "type" || s.exportKind === "type"));
  const check = (node) => {
    const src = node.source;
    if (!src || src.type !== "Literal" || typeof src.value !== "string" || typeOnly(node)) return;
    fn(node, target(file, src.value), src.value);
  };
  return {
    ImportDeclaration: check,
    ExportNamedDeclaration: check,
    ExportAllDeclaration: check,
    ImportExpression: check,
  };
}

/**
 * Pure modules (`src/lib/*.ts`) that reach a store, the backend or Tauri on
 * purpose. Principle 2: logic lives in `.ts` that tests run without a DOM or a
 * backend; a module on this list is a flow, not logic, and says why. An entry
 * whose module no longer imports anything impure is reported.
 */
const IMPURE_BY_DESIGN = {
  "appwindow.ts": "names the window this page runs in — asks Tauri, once",
  "clipboard.ts": "reads the clipboard through the backend: WebKit would prompt",
  "quitsummary.ts": "lists live sessions for the quit dialog from the tab store",
  "transferflow.ts": "the one path that starts a transfer: asks before replacing, reports failures",
};

function impureFor(t) {
  if (t.pkg) return t.pkg.startsWith("@tauri-apps/") || t.pkg.startsWith("$app/") ? t.pkg : null;
  const f = t.file;
  if (under(f, path.join(LIB, "stores"))) return "a store";
  if (under(f, path.join(LIB, "page"))) return "a page controller";
  if (under(f, path.join(LIB, "api"))) return "the backend API";
  if (isComponent(f)) return "a component";
  if (isRunes(f)) return "a runes module";
  return null;
}

const layers = {
  meta: {
    type: "problem",
    docs: { description: "Imports follow the layers of the front end" },
    schema: [],
    messages: {
      routes: "src/lib does not depend on the page (src/routes): move what both need into src/lib.",
      api: "src/lib/api is the bottom layer — it does not import {{what}} (principle 1).",
      store: "A store does not import {{what}}: the page and the components sit above the stores.",
      pure:
        "A pure module does not import {{what}} — logic lives in .ts that tests run without a DOM or a backend " +
        "(principle 2). Move the call to its caller, or name the module in IMPURE_BY_DESIGN (lint/vterm.js) with a reason.",
      stale: "{{file}} imports nothing impure any more — drop it from IMPURE_BY_DESIGN (lint/vterm.js).",
    },
  },
  create(context) {
    const file = context.filename;
    if (!under(file, LIB) || /\.test\.ts$/.test(file)) return {};
    const rel = path.relative(LIB, file);
    const inApi = under(file, path.join(LIB, "api"));
    const inStores = under(file, path.join(LIB, "stores"));
    const pure = !rel.includes(path.sep) && file.endsWith(".ts") && !file.endsWith(".svelte.ts") && !file.endsWith(".d.ts");
    const excused = pure && rel in IMPURE_BY_DESIGN;
    let impure = false;
    return {
      ...eachImport(context, (node, t) => {
        if (t.file && under(t.file, ROUTES)) return context.report({ node, messageId: "routes" });
        if (inApi) {
          const f = t.file;
          const what = f && (under(f, path.join(LIB, "stores")) ? "a store" : under(f, path.join(LIB, "page")) ? "a page controller" : isComponent(f) ? "a component" : isRunes(f) ? "a runes module" : null);
          if (what) context.report({ node, messageId: "api", data: { what } });
          return;
        }
        if (inStores && t.file) {
          const what = isComponent(t.file) ? "a component" : under(t.file, path.join(LIB, "page")) ? "a page controller" : null;
          if (what) context.report({ node, messageId: "store", data: { what } });
          return;
        }
        if (pure) {
          const what = impureFor(t);
          if (!what) return;
          impure = true;
          if (!excused) context.report({ node, messageId: "pure", data: { what } });
        }
      }),
      "Program:exit"(node) {
        if (excused && !impure) context.report({ node, messageId: "stale", data: { file: rel } });
      },
    };
  },
};

function onlyIn(pkg, description, message) {
  return rule(description, message, (context, report) =>
    eachImport(context, (node, t) => {
      if (t.pkg === pkg || t.pkg?.startsWith(`${pkg}/`)) report(node);
    }),
  );
}

// ── Rules ───────────────────────────────────────────────────────────────────────

const OVERLAY = /fixed\s+inset-0|inset-0\s+fixed/;
const HAS_Z = /\bz-(\d|\[)/;
const ARBITRARY_SIZE = /\btext-\[[0-9.]+(?:px|rem|em|pt)\]/;
const MICRO_LABEL = /\btext-(caption|meta) uppercase tracking-(wider|wide)\b/;
const MICRO_LABEL_ONE = "text-caption uppercase tracking-wider";
const TRANSITIONS = new Set(["fade", "slide", "scale", "fly", "blur", "draw", "flip", "glide"]);
const HUES =
  "green|amber|red|sky|blue|emerald|rose|yellow|orange|violet|purple|cyan|teal|indigo|pink|lime|fuchsia|slate|zinc|neutral|stone|gray";
const RAW_PALETTE = new RegExp(`\\b(?:bg|text|border|ring|fill|stroke)-(?:${HUES})-\\d{2,3}\\b`, "g");
const PRIMARY_BUTTON = /^bg-green-[56]00$/;
const RAW_WHITE_BLACK = /\btext-(?:white|black)(?:\/\d+)?\b/;
/** A solid saturated background that supplies its own contrast; a tint (`bg-accent/10`) is as pale as the panel. */
const SOLID_BUTTON = /\bbg-green-[56]00\b|\bbg-danger\b(?!\/)|\bbg-accent\b(?!\/)/;

/**
 * Reports each string (in script or markup) whose text `test` rejects. In markup
 * it is the element that is reported, once per attribute — so an exception is a
 * comment above the element, not inside its tag.
 */
function classStrings(context, report, test) {
  const text = (node) => context.sourceCode.getText(node);
  return {
    SvelteAttribute(node) {
      if (test(text(node))) report(node.parent);
    },
    SvelteDirective(node) {
      if (node.kind === "Class" && test(text(node.key))) report(node.parent);
    },
    Literal(node) {
      const s = stringOf(node);
      if (s !== null && !insideAttribute(node) && test(s)) report(node);
    },
    TemplateElement(node) {
      if (!insideAttribute(node) && test(stringOf(node))) report(node);
    },
  };
}

const rules = {
  layers,

  "invoke-in-api": onlyIn(
    "@tauri-apps/api/core",
    "The backend is called only through src/lib/api",
    "Call the backend through a typed wrapper in src/lib/api, not invoke() here (principle 1).",
  ),

  "opener-on-click": onlyIn(
    "@tauri-apps/plugin-opener",
    "A link leaves the app only through the paths that ask first",
    "Open links through clickLink (stores/linkopen) or use:mdLinks — they check the scheme and ask (INVARIANTS: «Ссылка из вывода открывается одним путём»).",
  ),

  "password-input": rule(
    "A secret field is a <PasswordInput>, never a raw password input",
    "Use <PasswordInput> — it carries the reveal toggle, autocomplete=off and the masked start on every mount.",
    (_, report) => ({
      SvelteAttribute(node) {
        if (attributeName(node) !== "type") return;
        const password = node.value.some(
          (v) =>
            (v.type === "SvelteLiteral" && v.value === "password") ||
            (v.type === "SvelteMustacheTag" && v.expression.type === "Literal" && v.expression.value === "password"),
        );
        if (password) report(node);
      },
    }),
  ),

  "no-scratch-path": rule(
    "Shipped code names no absolute scratch path",
    "No hard-coded /tmp/… path: a leftover diagnostic shipped once and raised a toast on every launch. Temporary files go through the OS temp dir in Rust.",
    (_, report) => {
      const check = (node) => {
        if (node.type === "TemplateElement" && node.parent.quasis[0] !== node) return;
        if (stringOf(node)?.startsWith("/tmp/")) report(node);
      };
      return { Literal: check, TemplateElement: check, SvelteLiteral: check };
    },
  ),

  "hotkey-letter": rule(
    "A letter hotkey is not matched on the raw e.key",
    "On a Russian layout this key is «к», not «r»: match letters with chordLetter()/the is*Chord predicates from appshortcuts.ts.",
    (_, report) => {
      const isKey = (n) => isMember(n?.type === "ChainExpression" ? n.expression : n, "key");
      const isLetter = (n) => n?.type === "Literal" && typeof n.value === "string" && /^[a-zA-Z]$/.test(n.value);
      return {
        BinaryExpression(node) {
          if (!/^[!=]==?$/.test(node.operator)) return;
          if ((isKey(node.left) && isLetter(node.right)) || (isKey(node.right) && isLetter(node.left))) report(node);
        },
        CallExpression(node) {
          const c = node.callee;
          if (c.type === "MemberExpression" && /^to(Lower|Upper)Case$/.test(c.property.name ?? "") && isKey(c.object)) {
            report(node);
          }
        },
        SwitchStatement(node) {
          if (isKey(node.discriminant)) for (const c of node.cases) if (isLetter(c.test)) report(c);
        },
      };
    },
  ),

  "submit-with-cr": rule(
    "A command is written to a PTY with CR, not LF",
    "Enter is CR: an LF-terminated command sits at a Windows prompt, and a block runs only its last line. Use submitLine()/submitBlock() from terminput.ts.",
    (context, report) => ({
      CallExpression(node) {
        const c = node.callee;
        const encode = (c.type === "Identifier" && c.name === "encode") || isMember(c, "encode");
        if (!encode) return;
        const lf = node.arguments.some((a) => some(context, a, (n) => stringOf(n)?.includes("\n") ?? false));
        if (lf) report(node);
      },
    }),
  ),

  "terminal-write": rule(
    "write_to_terminal is invoked only by the ordered writer",
    "Only api/session.ts invokes write_to_terminal, through createOrderedWriter — a second call site races it and reorders keystrokes.",
    (_, report) => {
      const check = (node) => {
        if (stringOf(node) === "write_to_terminal") report(node);
      };
      return { Literal: check, TemplateElement: check };
    },
  ),

  "no-network": rule(
    "The front end makes no network calls",
    "The WebView makes no network calls (principle 6): traffic goes from Rust, links open through the opener.",
    (context, report) => {
      const NAMES = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);
      return {
        "Program:exit"(node) {
          const scope = context.sourceCode.getScope(node);
          for (const ref of scope.through) {
            if (NAMES.has(ref.identifier.name)) report(ref.identifier);
          }
        },
        MemberExpression(node) {
          const global = node.object.type === "Identifier" && /^(window|globalThis|self)$/.test(node.object.name);
          if (isMember(node, "sendBeacon") || (global && NAMES.has(node.property.name))) report(node);
        },
      };
    },
  ),

  "overlay-z-index": rule(
    "A full-screen overlay carries an explicit z-index",
    "A `fixed inset-0` overlay needs an explicit z-index: inside a dock's stacking context higher siblings paint over it and its buttons stop taking clicks. Reuse <Modal>/<ConfirmDialog>.",
    (context, report) => classStrings(context, report, (s) => OVERLAY.test(s) && !HAS_Z.test(s)),
  ),

  "type-scale": rule(
    "Font sizes come from the type scale",
    "Use the scale: text-caption (10px) · text-meta (11px) · text-xs (12px) · text-sm (14px), not an arbitrary text-[N].",
    (context, report) => classStrings(context, report, (s) => ARBITRARY_SIZE.test(s)),
  ),

  "micro-label": rule(
    "Uppercase micro-labels have one treatment",
    `An uppercase micro-label is "${MICRO_LABEL_ONE}" — 10px against 11px drifted between adjacent panels.`,
    (context, report) =>
      classStrings(context, report, (s) => {
        const m = s.match(MICRO_LABEL);
        return m !== null && m[0] !== MICRO_LABEL_ONE;
      }),
  ),

  "motion-duration": rule(
    "Transition durations come from motion.ts",
    "Take the duration from motion()/motionScale(): Svelte runs transitions on WAAPI, which the app.css reduced-motion guard cannot shorten.",
    (context, report) => ({
      SvelteDirective(node) {
        if (node.kind !== "Transition" && node.kind !== "Animation") return;
        if (!TRANSITIONS.has(directiveName(node))) return;
        const timed =
          node.expression &&
          some(
            context,
            node.expression,
            (n) => n.type === "CallExpression" && n.callee.type === "Identifier" && /^motion(Ms|Scale)?$/.test(n.callee.name),
          );
        if (!timed) report(node);
      },
    }),
  ),

  "locale-binding": rule(
    "The UI language changes only through setLocale()",
    "Don't bind settings.language: the binding skips setLocale(), which also re-seeds the AI prompts the user hasn't edited.",
    (_, report) => ({
      SvelteDirective(node) {
        const e = node.expression;
        if (node.kind === "Binding" && isMember(e, "language") && e.object.type === "Identifier" && e.object.name === "settings") {
          report(node);
        }
      },
    }),
  ),

  "md-links": rule(
    "Rendered markdown is mounted under use:mdLinks",
    "Mount {@html} markdown on an element with use:mdLinks (actions/mdlinks.ts): a link would navigate the WebView, a phishing page without an address bar.",
    (_, report) => ({
      SvelteMustacheTag(node) {
        if (node.kind !== "raw") return;
        const el = node.parent;
        const guarded =
          el?.type === "SvelteElement" &&
          el.startTag.attributes.some(
            (a) => a.type === "SvelteDirective" && a.kind === "Action" && directiveName(a) === "mdLinks",
          );
        if (!guarded) report(node);
      },
    }),
  ),

  "backdrop-no-close": rule(
    "A dialog backdrop only dims",
    "A dimming backdrop must not close the dialog: the first click after switching apps lands on it and a half-filled form vanished. Close with buttons, × or Escape.",
    (context, report) => ({
      SvelteElement(node) {
        if (node.kind !== "html") return;
        const tag = context.sourceCode.getText(node.startTag);
        if (!/\binset-0\b/.test(tag) || !/\bbg-black\/\d+/.test(tag)) return;
        const closes =
          node.name.name === "button" ||
          node.startTag.attributes.some(
            (a) =>
              attributeName(a) === "onclick" ||
              (a.type === "SvelteDirective" && a.kind === "EventHandler" && directiveName(a) === "click"),
          );
        if (closes) report(node.startTag);
      },
    }),
  ),

  "owned-imports": {
    meta: {
      type: "problem",
      docs: { description: "A call that one module owns is imported only there" },
      schema: [
        {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { owners: { type: "array", items: { type: "string" } }, why: { type: "string" } },
            required: ["owners", "why"],
            additionalProperties: false,
          },
        },
      ],
      messages: { bad: "{{name}} is called from {{owners}} alone: {{why}}" },
    },
    create(context) {
      const owned = context.options[0] ?? {};
      const rel = path.relative(ROOT, context.filename).split(path.sep).join("/");
      const check = (node, name) => {
        const entry = Object.hasOwn(owned, name) ? owned[name] : null;
        if (!entry || entry.owners.includes(rel)) return;
        context.report({ node, messageId: "bad", data: { name, owners: entry.owners.join(", "), why: entry.why } });
      };
      return {
        // Named, under any alias: `import { closeTab as drop }` is still closeTab.
        ImportSpecifier(node) {
          if (node.importKind !== "type") check(node, node.imported.name ?? node.imported.value);
        },
        // Through a namespace or a dynamic import: `api.importBackup(…)`.
        MemberExpression(node) {
          if (!node.computed && node.property.type === "Identifier") check(node, node.property.name);
        },
      };
    },
  },

  "owned-writes": {
    meta: {
      type: "problem",
      docs: { description: "A value that one module decides is written only there" },
      schema: [
        {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { owners: { type: "array", items: { type: "string" } }, why: { type: "string" } },
            required: ["owners", "why"],
            additionalProperties: false,
          },
        },
      ],
      messages: { bad: "{{name}} is written in {{owners}} alone: {{why}}" },
    },
    create(context) {
      const owned = context.options[0] ?? {};
      const rel = path.relative(ROOT, context.filename).split(path.sep).join("/");
      /** `settings.terminalLinks` for a plain `object.property`, else null. */
      const nameOf = (n) =>
        n?.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.property.type === "Identifier"
          ? `${n.object.name}.${n.property.name}`
          : null;
      const check = (node, target) => {
        const name = nameOf(target);
        const entry = name && Object.hasOwn(owned, name) ? owned[name] : null;
        if (!entry || entry.owners.includes(rel)) return;
        context.report({ node, messageId: "bad", data: { name, owners: entry.owners.join(", "), why: entry.why } });
      };
      return {
        AssignmentExpression: (node) => check(node, node.left),
        UpdateExpression: (node) => check(node, node.argument),
        // `bind:value={settings.x}` writes it too.
        SvelteDirective: (node) => node.kind === "Binding" && check(node, node.expression),
      };
    },
  },

  "forbidden-imports": {
    meta: {
      type: "problem",
      docs: { description: "A module does not reach the modules its layer sits below" },
      schema: [
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "array", items: { type: "string" } },
              types: { type: "boolean" },
              why: { type: "string" },
            },
            required: ["from", "to", "why"],
            additionalProperties: false,
          },
        },
      ],
      messages: { bad: "{{from}} does not import {{to}}{{kind}}: {{why}}" },
    },
    create(context) {
      const rel = path.relative(ROOT, context.filename).split(path.sep).join("/");
      const mine = (context.options[0] ?? []).filter((r) => r.from === rel);
      if (mine.length === 0) return {};
      // `./tabs.svelte` names tabs.svelte.ts, `./fspath` names fspath.ts.
      const resolved = (file) => (existsSync(`${file}.ts`) ? `${file}.ts` : file);
      const visit = (node, typeOnly) => {
        const src = node.source;
        if (!src || src.type !== "Literal" || typeof src.value !== "string") return;
        const t = target(context.filename, src.value);
        if (!t.file) return;
        const to = path.relative(ROOT, resolved(t.file)).split(path.sep).join("/");
        for (const r of mine) {
          if (!r.to.includes(to) || (typeOnly && r.types)) continue;
          context.report({ node, messageId: "bad", data: { from: rel, to, kind: r.types ? " by value" : "", why: r.why } });
        }
      };
      const typeOnly = (node) =>
        node.importKind === "type" ||
        node.exportKind === "type" ||
        (node.specifiers?.length > 0 && node.specifiers.every((s) => s.importKind === "type" || s.exportKind === "type"));
      return {
        ImportDeclaration: (node) => visit(node, typeOnly(node)),
        ExportNamedDeclaration: (node) => visit(node, typeOnly(node)),
        ExportAllDeclaration: (node) => visit(node, typeOnly(node)),
        ImportExpression: (node) => visit(node, false),
      };
    },
  },

  "path-sync-mode": rule(
    "A stored path-sync answer is read through pathSyncMode()",
    "Read a server's path-sync answer through pathSyncMode(): a mode a newer build wrote, or a hand-edited file, would count as \"always\" somewhere and type a command into a shell unasked.",
    (_, report) => ({
      MemberExpression(node) {
        if (!isMember(node, "pathSync")) return;
        for (let n = node; n.parent; n = n.parent) {
          const p = n.parent;
          if (p.type === "CallExpression" && p.arguments.includes(n)) {
            if (p.callee.type === "Identifier" && p.callee.name === "pathSyncMode") return;
            break;
          }
          if (!["ChainExpression", "MemberExpression", "TSNonNullExpression", "TSAsExpression"].includes(p.type)) break;
        }
        report(node);
      },
    }),
  ),

  "theme-colors": rule(
    "Semantic colour comes from the theme tokens",
    "Use the theme tokens (ok/warn/bad/accent/danger/muted, text-text): a fixed Tailwind colour cannot be legible on both a near-black and a cream panel. White text only on a solid saturated button.",
    (context, report) => {
      const markup = context.filename.endsWith(".svelte");
      return classStrings(context, report, (s) => {
        // The pinned primary-action button (DESIGN.md) is the one fixed colour, and only in markup.
        for (const m of s.matchAll(RAW_PALETTE)) if (!(markup && PRIMARY_BUTTON.test(m[0]))) return true;
        return markup && RAW_WHITE_BLACK.test(s) && !SOLID_BUTTON.test(s);
      });
    },
  ),

  "virtual-scroll": rule(
    "A windowed list turns scroll anchoring off",
    "A list on windowRange() needs [overflow-anchor:none] on its scroller: Chromium (WebView2) re-anchors scrollTop as the window swaps rows, and trackpad scrolling jerks on Windows.",
    (context, report) => {
      let call = null;
      let anchorOff = false;
      const scan = (text) => {
        anchorOff ||= /overflow-anchor:\s*none/.test(text);
      };
      return {
        CallExpression(node) {
          if (node.callee.type === "Identifier" && node.callee.name === "windowRange") call ??= node;
        },
        SvelteAttribute: (node) => scan(context.sourceCode.getText(node)),
        SvelteStyleElement: (node) => scan(context.sourceCode.getText(node)),
        Literal: (node) => scan(stringOf(node) ?? ""),
        TemplateElement: (node) => scan(stringOf(node) ?? ""),
        "Program:exit"() {
          if (call && !anchorOff) report(call);
        },
      };
    },
  ),

  "paste-caret": rule(
    "A caret is not placed from the raw length of pasted text",
    "Don't place the caret from the clipboard string's length: CodeMirror and <textarea> store CRLF shorter, the caret lands past the end and the paste fails silently on Windows. Use view.state.replaceSelection(text) or the value the DOM stored.",
    (context, report) => {
      const CLIP = /^(text|clip|clipboard|pasted|paste)$/i;
      const fromClip = (n) =>
        some(context, n, (x) => isMember(x, "length") && x.object.type === "Identifier" && CLIP.test(x.object.name));
      const caret = (name) => /^(anchor|head|caret)$/i.test(name ?? "");
      return {
        Property(node) {
          if (!node.computed && caret(node.key.name ?? node.key.value) && fromClip(node.value)) report(node);
        },
        AssignmentExpression(node) {
          const name = node.left.type === "Identifier" ? node.left.name : node.left.property?.name;
          if (caret(name) && fromClip(node.right)) report(node);
        },
        VariableDeclarator(node) {
          if (node.id.type === "Identifier" && caret(node.id.name) && node.init && fromClip(node.init)) report(node);
        },
      };
    },
  ),

  "each-as-t": rule(
    "An each-block variable is not named t",
    "Don't name the {#each} variable `t`: it shadows the translation function t() for the whole block.",
    (_, report) => ({
      SvelteEachBlock(node) {
        for (const id of [node.context, node.index]) {
          if (id?.type === "Identifier" && id.name === "t") report(id);
        }
      },
    }),
  ),
};

export default { meta: { name: "vterm" }, rules };
