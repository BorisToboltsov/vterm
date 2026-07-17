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
        // a smoke component test — not jsdom branch coverage. See docs/TESTS.md.
        "src/lib/Terminal.svelte",
        "src/lib/SftpPanel.svelte",
        "src/lib/LocalFilePanel.svelte",
        "src/lib/SettingsPanel.svelte",
        "src/lib/ServerTree.svelte",
        // Polling overlay driven by live metrics/native fetches; pure logic lives
        // in thresholds.ts/format.ts (covered) and a smoke test renders it.
        "src/lib/MonitoringOverlay.svelte",
        // Idle screensaver — heavy canvas rendering over the WebGL terminal driven
        // by rAF/live metrics. Pure logic (detection, buffer→grid, tokenize, close
        // classification) lives in idle.ts/idlefx.ts/connlost.ts (covered).
        "src/lib/IdleOverlay.svelte",
        // Recordings library — thin shell over the recording API + dialogs; pure
        // logic (transcript/parse) lives in recording.ts (covered).
        "src/lib/RecordingsPanel.svelte",
        // asciicast player — xterm-driven replay; timing logic (outputUpTo/
        // formatTime/castDuration) lives in recording.ts (covered).
        "src/lib/RecordingPlayer.svelte",
        // CodeMirror-driven config editor; pure logic (language detection,
        // workspace bookkeeping, theme glue) lives in editorlang.ts /
        // workspaces.svelte.ts / cmtheme.ts (covered). See docs/TESTS.md.
        "src/lib/EditorTab.svelte",
        // CodeMirror MergeView diff dialog (driven by the merge addon).
        "src/lib/DiffModal.svelte",
        // Sync dialog — thin shell over sync.ts (covered) + native dialogs/api.
        "src/lib/SyncModal.svelte",
        // Server-tools install helper — thin shells over the api + native flows.
        "src/lib/ServerToolsPanel.svelte",
        "src/lib/ToolInstallDialog.svelte",
        // AI assistant settings — thin shell over settings.ai + keychain api (Phase 17).
        "src/lib/AiSettingsSection.svelte",
        // AI chat dock — event-stream glue over the broker (Phase 17.2).
        "src/lib/AiChat.svelte",
        "src/lib/RightDock.svelte",
        // Git panel (Phase 29) — UI shells over git_run + rAF/effects glue. All
        // pure logic (arg builders, status/log/branch/diff parsers, graph lane
        // layout, destructive-op classifier, view helpers) lives in git.ts /
        // gitview.ts (heavily covered). Diff view mirrors DiffModal's exclusion.
        "src/lib/GitPanel.svelte",
        "src/lib/GitGraph.svelte",
        "src/lib/GitChanges.svelte",
        "src/lib/GitBranches.svelte",
        "src/lib/GitDiffView.svelte",
        // Docker panel (Phase 35) — UI shells over container_run + polling/effects
        // glue. All pure logic (arg builders, ps/images/networks/volumes/stats
        // parsers, compose grouping, availability classifier, destructive-op
        // classifier, view helpers) lives in docker.ts (heavily covered). The text
        // modal mirrors GitDiffView's exclusion.
        "src/lib/DockerPanel.svelte",
        "src/lib/DockerContainers.svelte",
        "src/lib/DockerImages.svelte",
        "src/lib/DockerNetworks.svelte",
        "src/lib/DockerTextModal.svelte",
        // Kubernetes panel (Phase 37) — UI shells over pure k8s.ts (arg builders,
        // withScope, JSON parsers, groupByOwner, availability + destructive-op
        // classifiers, all heavily covered in k8s.test.ts). Same rationale as the
        // Docker panel above.
        "src/lib/K8sPanel.svelte",
        "src/lib/K8sPods.svelte",
        "src/lib/K8sWorkloads.svelte",
        "src/lib/K8sNetwork.svelte",
        "src/lib/K8sCluster.svelte",
        "src/lib/K8sDetailModal.svelte",
        "src/lib/K8sTextModal.svelte",
        "src/lib/K8sSettings.svelte",
        // Add/edit server form — UI shell over the server api + native key picker
        // (extracted from +page.svelte in Phase 18.4.2).
        "src/lib/ServerFormModal.svelte",
        // Folder create/rename/delete modals — UI shell over the folder api
        // (extracted from +page.svelte in Phase 18.4.3).
        "src/lib/FolderModals.svelte",
        // Password/passphrase prompt — UI shell over the tab store (Phase 18.4.4).
        "src/lib/SecretPrompt.svelte",
        // Per-server notes editor — UI shell over the notes api; pure counting/
        // dirty logic lives in notes.ts (covered). A behavior test still runs.
        "src/lib/NotesModal.svelte",
        // Settings sections — UI shells over the settings store, split out of
        // SettingsPanel in Phase 18.5 (like AiSettingsSection).
        "src/lib/AppearanceSettings.svelte",
        "src/lib/SmartLogsSettings.svelte",
        "src/lib/StatusBarSettings.svelte",
        "src/lib/IdleSettings.svelte",
        "src/lib/SnippetsSettings.svelte",
        "src/lib/BackupSettings.svelte",
        // Utilities panel + tools (Phase 33) — UI shells over pure .ts logic that
        // is heavily covered: codec.ts, cidr.ts, timeconv.ts, cron.ts, pwgen.ts,
        // jwt.ts, knownhosts.ts, utilities.ts. The .svelte files
        // are forms/tables with no logic of their own (same rationale as above).
        "src/lib/UtilitiesPanel.svelte",
        "src/lib/UtilKeys.svelte",
        "src/lib/UtilCodec.svelte",
        "src/lib/UtilCidr.svelte",
        "src/lib/UtilTimestamp.svelte",
        "src/lib/UtilCron.svelte",
        "src/lib/UtilPassword.svelte",
        "src/lib/UtilJwt.svelte",
        "src/lib/UtilKnownHosts.svelte",
        // Network tools (Phase 34) — UI shells over pure .ts (tls/http) + the
        // shared probe runner.
        "src/lib/UtilProbeRunner.svelte",
        "src/lib/UtilTls.svelte",
        "src/lib/UtilHttp.svelte",
        "src/lib/CopyButton.svelte",
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
