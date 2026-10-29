// ESLint: the recommended sets for JS, TypeScript and Svelte, plus vterm's own
// rules (lint/vterm.js) — the invariants that used to be text gates. A rule that
// is switched off here says why; an exception inside the code is an
// `eslint-disable` comment with its reason, and one that suppresses nothing fails
// the run (reportUnusedDisableDirectives).

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import svelte from "eslint-plugin-svelte";
import ts from "typescript-eslint";
import vterm from "./lint/vterm.js";

const TESTS = ["**/*.test.ts", "**/*.spec.ts"];
const SOURCE = ["src/**/*.ts", "src/**/*.svelte"];
const MARKUP = ["src/**/*.svelte"];

/** One vterm rule on `files`, minus the modules that own what it guards. */
const own = (name, files, ignores = []) => ({
  files,
  ignores: [...TESTS, ...ignores],
  rules: { [`vterm/${name}`]: "error" },
});

export default defineConfig(
  { ignores: [".claude/", ".svelte-kit/", "build/", "coverage/", "node_modules/", "src-tauri/", "e2e/", "static/"] },
  { linterOptions: { reportUnusedDisableDirectives: "error", reportUnusedInlineConfigs: "error" } },

  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: { parserOptions: { parser: ts.parser, extraFileExtensions: [".svelte"] } },
  },
  {
    rules: {
      // TypeScript resolves names; the core rule knows neither DOM nor Node globals.
      "no-undef": "off",
      // Terminal output and file names are matched for control characters on purpose (ANSI, NUL).
      "no-control-regex": "off",
      "no-fallthrough": ["error", { allowEmptyCase: true }],
      "no-script-url": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true }],
      // {@html} is held by vterm/md-links: markdown under use:mdLinks, the icon registry by name.
      "svelte/no-at-html-tags": "off",
      // A keyed {#each} recreates rows instead of reusing them — the terminal list must not
      // remount (INVARIANTS: «Центр — дерево областей»), so a key is a decision, not a default.
      "svelte/require-each-key": "off",
      // Maps and Sets inside functions are scratch, not state; reactive collections are chosen explicitly.
      "svelte/prefer-svelte-reactivity": "off",
      // A writable $derived is not deeply reactive: `bind:value={answers[i]}` would stop updating.
      "svelte/prefer-writable-derived": "off",
      // `{" "}` and quoted placeholders keep whitespace and quotes readable in markup.
      "svelte/no-useless-mustaches": "off",
    },
  },
  {
    files: TESTS,
    rules: {
      // Fixtures: u64 limits, aligned regexes of quoted source, loose mocks, javascript: URLs.
      "no-loss-of-precision": "off",
      "no-regex-spaces": "off",
      "no-script-url": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-this-alias": "off",
    },
  },

  { plugins: { vterm } },
  own("layers", ["src/lib/**/*.ts", "src/lib/**/*.svelte"]),
  own("invoke-in-api", SOURCE, ["src/lib/api/**"]),
  // Each of these opens a link on the user's click, after checking it.
  own("opener-on-click", SOURCE, [
    "src/lib/stores/linkopen.svelte.ts",
    "src/lib/actions/mdlinks.ts",
    "src/lib/HelpPanel.svelte",
    "src/lib/UpdatePanel.svelte",
  ]),
  own("no-network", SOURCE),
  own("no-scratch-path", SOURCE),
  own("password-input", MARKUP, ["src/lib/PasswordInput.svelte"]),
  own("hotkey-letter", SOURCE, ["src/lib/appshortcuts.ts"]),
  own("submit-with-cr", SOURCE, ["src/lib/terminput.ts"]),
  own("terminal-write", SOURCE, ["src/lib/api/session.ts"]),
  own("overlay-z-index", MARKUP),
  own("type-scale", SOURCE),
  own("micro-label", SOURCE),
  own("motion-duration", MARKUP),
  own("locale-binding", MARKUP),
  own("md-links", MARKUP),
  own("backdrop-no-close", MARKUP),
  own("each-as-t", MARKUP),
  own("path-sync-mode", SOURCE),
  {
    files: SOURCE,
    ignores: TESTS,
    rules: {
      // A call one module owns, because the rule it keeps lives there.
      "vterm/owned-imports": [
        "error",
        {
          setServerPathSync: {
            owners: ["src/lib/page/pathsyncflow.svelte.ts"],
            why: "a server's path-sync answer is written by the form and by the path-sync question, nowhere else",
          },
          transferStart: {
            owners: ["src/lib/transferflow.ts"],
            why: "startTransfer asks before a file is replaced — a second starter replaces without asking (ADR 0025)",
          },
          importBackup: {
            owners: ["src/lib/BackupSettings.svelte"],
            why: "an import writes the catalog the preview planned, after the user saw it",
          },
          startChat: {
            owners: ["src/lib/AiChat.svelte"],
            why: "one AI turn at a time: the composer checks the chat first, and a raised question becomes a chip, never a send",
          },
          netcheckRun: {
            owners: ["src/lib/stores/netcheck.svelte.ts", "src/lib/UtilNetCheck.svelte"],
            why: "a check runs from the store, with a stop handle; the tool only asks a server who it is",
          },
          closeTab: {
            owners: ["src/routes/+page.svelte"],
            why: "a tab closes through closeTabFully, which drops everything kept by its session id",
          },
        },
      ],
      "vterm/forbidden-imports": [
        "error",
        [
          {
            from: "src/lib/stores/tabs.svelte.ts",
            to: ["src/lib/stores/workspaces.svelte.ts", "src/lib/stores/aichat.svelte.ts"],
            why: "the centre holds connections; their files and chats sit above it, and closeTabFully ties them together",
          },
          {
            from: "src/lib/stores/tabincoming.svelte.ts",
            to: ["src/lib/stores/tabs.svelte.ts"],
            types: true,
            why: "the preview of a tab from another window cannot move the layout; the tab is placed once, when it arrives",
          },
        ],
      ],
    },
  },
);
