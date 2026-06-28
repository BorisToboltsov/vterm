import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { fileURLToPath } from "node:url";

// Standalone Vitest config (independent of the Tauri/SvelteKit dev config).
// Uses the plain Svelte plugin — components and `.svelte.ts` runes modules are
// compiled for the browser and run under jsdom. The svelteTesting() plugin wires
// up the "browser" resolve condition and auto-cleanup between tests.
export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest-setup.ts"],
    include: ["src/**/*.{test,spec}.{js,ts}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "json-summary", "cobertura"],
      include: ["src/lib/**/*.{ts,svelte}"],
      exclude: [
        "src/lib/**/*.test.ts",
        "src/lib/types.ts", // type-only
        "src/**/*.d.ts",
        // Heavy interactive components driven by native APIs (xterm.js, native
        // dialogs, pointer DnD). Their pure logic lives in covered .ts modules
        // (tree.ts, drag.ts); behaviour is exercised by the E2E suite (e2e/) and
        // a smoke component test — not jsdom branch coverage. See TESTS.md.
        "src/lib/Terminal.svelte",
        "src/lib/SftpPanel.svelte",
        "src/lib/SettingsPanel.svelte",
        "src/lib/ServerTree.svelte",
        // Polling overlay driven by live metrics/native fetches; pure logic lives
        // in thresholds.ts/format.ts (covered) and a smoke test renders it.
        "src/lib/MonitoringOverlay.svelte",
        // Recordings library — thin shell over the recording API + dialogs; pure
        // logic (transcript/parse) lives in recording.ts (covered).
        "src/lib/RecordingsPanel.svelte",
        // asciicast player — xterm-driven replay; timing logic (outputUpTo/
        // formatTime/castDuration) lives in recording.ts (covered).
        "src/lib/RecordingPlayer.svelte",
        // CodeMirror-driven config editor; pure logic (language detection,
        // workspace bookkeeping, theme glue) lives in editorlang.ts /
        // workspaces.svelte.ts / cmtheme.ts (covered). See TESTS.md.
        "src/lib/EditorTab.svelte",
        // CodeMirror MergeView diff dialog (driven by the merge addon).
        "src/lib/DiffModal.svelte",
      ],
      thresholds: {
        // Gate the pure logic hard (the safety net for the upcoming refactor).
        "src/lib/{tree,format,themes,clipboard}.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Overall gate across everything still in `include`.
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
