// @vitest-environment node
//
// vterm's own lint rules (lint/vterm.js) hold the invariants that used to be
// text gates. `pnpm lint` runs them over the tree; this file proves each one is
// switched on and still catches the violation it exists for — and stays quiet on
// the compliant shape and on prose that merely names the anti-pattern. An
// exception that no longer suppresses anything fails the run, as a stale
// exemption failed the gates.

import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

async function lint(filePath: string, code: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages;
}

/** The vterm rules (and unused-directive reports) the snippet trips. */
async function tripped(filePath: string, code: string): Promise<string[]> {
  const messages = await lint(filePath, code);
  const fatal = messages.find((m) => m.fatal);
  if (fatal) throw new Error(`${filePath}: ${fatal.message}`);
  return messages
    .map((m) => m.ruleId ?? (/Unused eslint-disable/.test(m.message) ? "unused-directive" : null))
    .filter((id): id is string => id !== null && (id.startsWith("vterm/") || id === "unused-directive"));
}

const svelte = (script: string, markup = "") => `<script lang="ts">\n${script}\n</script>\n${markup}\n`;

/** For each rule: shapes it must catch, and shapes it must leave alone. */
const CASES: Record<string, { bad: [string, string][]; good: [string, string][] }> = {
  layers: {
    bad: [
      ["src/lib/zz_probe.ts", `import { tabsState } from "./stores/tabs.svelte";\nexport const x = tabsState;`],
      ["src/lib/zz_probe.ts", `import { settings } from "./settings.svelte";\nexport const x = settings;`],
      ["src/lib/zz_probe.ts", `import { listen } from "@tauri-apps/api/event";\nexport const x = listen;`],
      ["src/lib/zz_probe.ts", `import { hostOs } from "./api";\nexport const x = hostOs;`],
      ["src/lib/api/zz_probe.ts", `import { settings } from "../settings.svelte";\nexport const x = settings;`],
      ["src/lib/stores/zz_probe.svelte.ts", `import Modal from "../Modal.svelte";\nexport const x = Modal;`],
      ["src/lib/ZzProbe.svelte", svelte(`import Page from "../routes/+page.svelte";`, "<Page />")],
      // An exception whose module imports nothing impure any more.
      ["src/lib/appwindow.ts", `export const x = 1;`],
    ],
    good: [
      ["src/lib/zz_probe.ts", `import type { Tab } from "./stores/tabs.svelte";\nexport type X = Tab;`],
      ["src/lib/zz_probe.ts", `import { t } from "./i18n";\nimport { joinPath } from "./fspath";\nexport const x = [t, joinPath];`],
      ["src/lib/stores/zz_probe.svelte.ts", `import { settings } from "../settings.svelte";\nexport const x = settings;`],
    ],
  },
  "invoke-in-api": {
    bad: [["src/lib/ZzProbe.svelte", svelte(`import { invoke } from "@tauri-apps/api/core";\nvoid invoke;`)]],
    good: [["src/lib/api/zz_probe.ts", `import { invoke } from "@tauri-apps/api/core";\nexport const x = invoke;`]],
  },
  "opener-on-click": {
    bad: [["src/lib/ZzProbe.svelte", svelte(`import { openUrl } from "@tauri-apps/plugin-opener";\nvoid openUrl;`)]],
    good: [["src/lib/stores/linkopen.svelte.ts", `import { openUrl } from "@tauri-apps/plugin-opener";\nexport const x = openUrl;`]],
  },
  "no-network": {
    bad: [
      ["src/lib/zz_probe.ts", `export const x = () => fetch("https://example.com");`],
      ["src/lib/zz_probe.ts", `export const x = () => window.fetch("https://example.com");`],
      ["src/lib/zz_probe.ts", `export const x = () => new WebSocket("wss://example.com");`],
      ["src/lib/zz_probe.ts", `export const x = () => navigator.sendBeacon("https://example.com");`],
    ],
    good: [["src/lib/zz_probe.ts", `function fetch(n: number) { return n; }\nexport const x = fetch(1);`]],
  },
  "no-scratch-path": {
    bad: [
      ["src/lib/zz_probe.ts", `export const p = "/tmp/vterm-realtest.conf";`],
      ["src/lib/zz_probe.ts", "export const p = (n: string) => `/tmp/vterm-${n}.json`;"],
    ],
    good: [["src/lib/zz_probe.ts", `// a diagnostic once read /tmp/vterm-realtest.conf\nexport const p = "C:\\\\Temp";`]],
  },
  "password-input": {
    bad: [["src/lib/ZzProbe.svelte", svelte(`let v = $state("");`, `<input type="password" bind:value={v} />`)]],
    good: [["src/lib/ZzProbe.svelte", svelte(`let v = $state("");`, `<input type="text" bind:value={v} />`)]],
  },
  "hotkey-letter": {
    bad: [
      ["src/lib/zz_probe.ts", `export const f = (e: KeyboardEvent) => e.ctrlKey && e.key === "r";`],
      ["src/lib/zz_probe.ts", `export const f = (e: KeyboardEvent) => e.key.toLowerCase() === "k";`],
      ["src/lib/zz_probe.ts", `export function f(e: KeyboardEvent) { switch (e.key) { case "a": return 1; } return 0; }`],
    ],
    good: [["src/lib/zz_probe.ts", `// e.key === "r" used to be here\nexport const f = (e: KeyboardEvent) => e.key === "Enter";`]],
  },
  "submit-with-cr": {
    bad: [
      ["src/lib/zz_probe.ts", "const enc = new TextEncoder();\nexport const f = (a: string[]) => enc.encode(`git ${a.join(\" \")}\\n`);"],
      ["src/lib/zz_probe.ts", `const enc = new TextEncoder();\nexport const f = () => enc.encode("ls\\n");`],
    ],
    good: [["src/lib/zz_probe.ts", `const enc = new TextEncoder();\nexport const f = () => enc.encode("ls\\r");`]],
  },
  "terminal-write": {
    bad: [["src/lib/zz_probe.ts", `declare const invoke: (c: string) => void;\nexport const f = () => invoke("write_to_terminal");`]],
    good: [["src/lib/zz_probe.ts", `// "write_to_terminal" goes through api/session.ts\nexport const f = 1;`]],
  },
  "overlay-z-index": {
    bad: [["src/lib/ZzProbe.svelte", svelte("", `<div class="fixed inset-0 bg-black/50"></div>`)]],
    good: [["src/lib/ZzProbe.svelte", svelte("", `<div class="fixed inset-0 z-40 bg-black/50"></div>`)]],
  },
  "type-scale": {
    bad: [
      ["src/lib/ZzProbe.svelte", svelte("", `<span class="text-[13px] text-muted">x</span>`)],
      ["src/lib/zz_probe.ts", `export const cls = "text-[0.8rem] text-muted";`],
    ],
    good: [["src/lib/ZzProbe.svelte", svelte("", `<span class="text-meta text-muted">x</span>`)]],
  },
  "micro-label": {
    bad: [["src/lib/ZzProbe.svelte", svelte("", `<h3 class="text-meta uppercase tracking-wide">x</h3>`)]],
    good: [["src/lib/ZzProbe.svelte", svelte("", `<h3 class="text-caption uppercase tracking-wider">x</h3>`)]],
  },
  "motion-duration": {
    bad: [
      ["src/lib/ZzProbe.svelte", svelte(`import { slide } from "svelte/transition";`, `<div transition:slide>x</div>`)],
      ["src/lib/ZzProbe.svelte", svelte(`import { fade } from "svelte/transition";`, `<div in:fade={{ duration: 200 }}>x</div>`)],
    ],
    good: [
      [
        "src/lib/ZzProbe.svelte",
        svelte(`import { slide } from "svelte/transition";\nimport { motion } from "./motion";`, `<div transition:slide={motion({ duration: 200 })}>x</div>`),
      ],
    ],
  },
  "locale-binding": {
    bad: [["src/lib/ZzProbe.svelte", svelte(`import { settings } from "./settings.svelte";`, `<select bind:value={settings.language}></select>`)]],
    good: [["src/lib/ZzProbe.svelte", svelte(`import { settings } from "./settings.svelte";`, `<select value={settings.language}></select>`)]],
  },
  "md-links": {
    bad: [["src/lib/ZzProbe.svelte", svelte(`let html = $state("");`, `<!-- use:mdLinks is not on this element -->\n<div>{@html html}</div>`)]],
    good: [["src/lib/ZzProbe.svelte", svelte(`import { mdLinks } from "./actions/mdlinks";\nlet html = $state("");`, `<div use:mdLinks>{@html html}</div>`)]],
  },
  "backdrop-no-close": {
    bad: [
      ["src/lib/ZzProbe.svelte", svelte(`let open = $state(true);`, `<button class="absolute inset-0 bg-black/50" aria-label="x" onclick={() => (open = false)}></button>`)],
      ["src/lib/ZzProbe.svelte", svelte(`const close = () => {};`, `<div class="absolute inset-0 bg-black/50" role="none" onclick={close}></div>`)],
    ],
    good: [
      [
        "src/lib/ZzProbe.svelte",
        svelte("", `<!-- <button class="inset-0 bg-black/50"> -->\n<div class="absolute inset-0 bg-black/50" aria-hidden="true"></div>`),
      ],
    ],
  },
  "each-as-t": {
    bad: [["src/lib/ZzProbe.svelte", svelte(`const tags = ["a"];`, `{#each tags as t}<span>{t}</span>{/each}`)]],
    good: [["src/lib/ZzProbe.svelte", svelte(`const tags = ["a"];`, `{#each tags as tag}<span>{tag}</span>{/each}`)]],
  },
};

describe("vterm lint rules", () => {
  it("every rule of the plugin is switched on and has its cases here", async () => {
    const config = await eslint.calculateConfigForFile("src/lib/zz_probe.ts");
    const plugin = (config.plugins as Record<string, { rules: Record<string, unknown> }>).vterm;
    expect(Object.keys(plugin.rules).sort()).toEqual(Object.keys(CASES).sort());
  });

  for (const [name, { bad, good }] of Object.entries(CASES)) {
    it(`${name}: catches the shapes it exists for, and leaves the compliant ones alone`, async () => {
      for (const [file, code] of bad) {
        expect(await tripped(file, code), `${file}:\n${code}`).toContain(`vterm/${name}`);
      }
      for (const [file, code] of good) {
        expect(await tripped(file, code), `${file}:\n${code}`).toEqual([]);
      }
    });
  }

  it("leaves tests alone: fixtures name the violations on purpose", async () => {
    expect(await tripped("src/lib/zz_probe.test.ts", `export const p = "/tmp/vterm-x";`)).toEqual([]);
  });

  it("fails an exception that no longer suppresses anything", async () => {
    const stale = `// eslint-disable-next-line vterm/no-scratch-path -- was a diagnostic path\nexport const p = "/var/x";`;
    expect(await tripped("src/lib/zz_probe.ts", stale)).toEqual(["unused-directive"]);
    const live = `// eslint-disable-next-line vterm/no-scratch-path -- a fixture path\nexport const p = "/tmp/x";`;
    expect(await tripped("src/lib/zz_probe.ts", live)).toEqual([]);
  });
});
