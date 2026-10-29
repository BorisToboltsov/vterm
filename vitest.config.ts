import { defineConfig } from "vitest/config";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

// Standalone Vitest config (independent of the Tauri/SvelteKit dev config).
// Uses the plain Svelte plugin — components and `.svelte.ts` runes modules are
// compiled for the browser and run under jsdom. The svelteTesting() plugin wires
// up the "browser" resolve condition and auto-cleanup between tests. The
// preprocessor is the one vite.config.js hands SvelteKit (there is no
// svelte.config.js to share it since SvelteKit 3); `#lib/…` resolves through the
// `imports` field of package.json, with no alias.
export default defineConfig({
  plugins: [svelte({ preprocess: vitePreprocess() }), svelteTesting()],
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
        "src/lib/terminal/Terminal.svelte",
        // File browsers: <FileBrowser> is the shared body of the two thin wrappers
        // (SftpPanel/LocalFilePanel); its pure logic lives in filebrowser.ts (covered).
        "src/lib/files/FileBrowser.svelte",
        "src/lib/files/SftpPanel.svelte",
        "src/lib/files/LocalFilePanel.svelte",
        "src/lib/settings/SettingsPanel.svelte",
        "src/lib/servers/ServerTree.svelte",
        // Polling overlay driven by live metrics/native fetches; pure logic lives
        // in thresholds.ts/format.ts (covered) and a smoke test renders it.
        "src/lib/monitoring/MonitoringOverlay.svelte",
        // Idle screensaver — heavy canvas rendering over the WebGL terminal driven
        // by rAF/live metrics. Pure logic (detection, buffer→grid, tokenize, close
        // classification) lives in idle.ts/idlefx.ts/connlost.ts (covered).
        "src/lib/screensaver/IdleOverlay.svelte",
        // Recordings library — thin shell over the recording API + dialogs; pure
        // logic (transcript/parse) lives in recording.ts (covered).
        "src/lib/recording/RecordingsPanel.svelte",
        // asciicast player — xterm-driven replay; timing logic (outputUpTo/
        // formatTime/castDuration) lives in recording.ts (covered).
        "src/lib/recording/RecordingPlayer.svelte",
        // CodeMirror-driven config editor; pure logic (language detection,
        // workspace bookkeeping, theme glue) lives in editorlang.ts /
        // workspaces.svelte.ts / cmtheme.ts (covered). See docs/TESTS.md.
        "src/lib/editor/EditorTab.svelte",
        // CodeMirror MergeView diff dialog (driven by the merge addon).
        "src/lib/editor/DiffModal.svelte",
        // Sync dialog — thin shell over sync.ts (covered) + native dialogs/api.
        "src/lib/sync/SyncModal.svelte",
        // Server-tools install helper — thin shells over the api + native flows.
        "src/lib/editor/ServerToolsPanel.svelte",
        "src/lib/editor/ToolInstallDialog.svelte",
        // AI assistant settings — thin shell over settings.ai + keychain api (Phase 17).
        "src/lib/ai/AiSettingsSection.svelte",
        // AI chat dock — event-stream glue over the broker (Phase 17.2).
        "src/lib/ai/AiChat.svelte",
        // The switch that picks a session tool panel for an id (v1.1) — every
        // branch is one of the excluded shells above/below. The dock chrome
        // around it (Dock.svelte) and the layout model (docklayout.ts) ARE covered.
        "src/lib/layout/DockPanel.svelte",
        // Git panel (Phase 29) — UI shells over git_run + rAF/effects glue. All
        // pure logic (arg builders, status/log/branch/diff parsers, graph lane
        // layout, destructive-op classifier, view helpers) lives in git.ts /
        // gitview.ts (heavily covered). Diff view mirrors DiffModal's exclusion.
        "src/lib/git/GitPanel.svelte",
        "src/lib/git/GitGraph.svelte",
        "src/lib/git/GitChanges.svelte",
        "src/lib/git/GitBranches.svelte",
        "src/lib/git/GitDiffView.svelte",
        // Docker panel (Phase 35) — UI shells over container_run + polling/effects
        // glue. All pure logic (arg builders, ps/images/networks/volumes/stats
        // parsers, compose grouping, availability classifier, destructive-op
        // classifier, view helpers) lives in docker.ts (heavily covered). The text
        // modal mirrors GitDiffView's exclusion.
        "src/lib/docker/DockerPanel.svelte",
        "src/lib/docker/DockerContainers.svelte",
        "src/lib/docker/DockerImages.svelte",
        "src/lib/docker/DockerNetworks.svelte",
        "src/lib/docker/DockerTextModal.svelte",
        // Kubernetes panel (Phase 37) — UI shells over pure k8s.ts (arg builders,
        // withScope, JSON parsers, groupByOwner, availability + destructive-op
        // classifiers, all heavily covered in k8s.test.ts). Same rationale as the
        // Docker panel above.
        "src/lib/k8s/K8sPanel.svelte",
        "src/lib/k8s/K8sPods.svelte",
        "src/lib/k8s/K8sWorkloads.svelte",
        "src/lib/k8s/K8sNetwork.svelte",
        "src/lib/k8s/K8sCluster.svelte",
        "src/lib/k8s/K8sDetailModal.svelte",
        "src/lib/k8s/K8sTextModal.svelte",
        "src/lib/k8s/K8sSettings.svelte",
        // Add/edit server form — UI shell over the server api + native key picker
        // (extracted from +page.svelte in Phase 18.4.2).
        "src/lib/servers/ServerFormModal.svelte",
        // Folder create/rename/delete modals — UI shell over the folder api
        // (extracted from +page.svelte in Phase 18.4.3).
        "src/lib/servers/FolderModals.svelte",
        // Password/passphrase prompt — UI shell over the tab store (Phase 18.4.4).
        "src/lib/connect/SecretPrompt.svelte",
        // Per-server notes editor — UI shell over the notes api; pure counting/
        // dirty logic lives in notes.ts (covered). A behavior test still runs.
        "src/lib/servers/NotesModal.svelte",
        // Settings sections — UI shells over the settings store, split out of
        // SettingsPanel in Phase 18.5 (like AiSettingsSection).
        "src/lib/appearance/AppearanceSettings.svelte",
        "src/lib/terminal/SmartLogsSettings.svelte",
        "src/lib/monitoring/StatusBarSettings.svelte",
        "src/lib/screensaver/IdleSettings.svelte",
        "src/lib/editor/SnippetsSettings.svelte",
        "src/lib/servers/BackupSettings.svelte",
        // Utilities panel + tools (Phase 33) — UI shells over pure .ts logic that
        // is heavily covered: codec.ts, cidr.ts, timeconv.ts, cron.ts, pwgen.ts,
        // jwt.ts, knownhosts.ts, utilities.ts. The .svelte files
        // are forms/tables with no logic of their own (same rationale as above).
        "src/lib/utilities/UtilitiesPanel.svelte",
        "src/lib/utilities/UtilKeys.svelte",
        "src/lib/utilities/UtilCodec.svelte",
        "src/lib/utilities/UtilCidr.svelte",
        "src/lib/utilities/UtilTimestamp.svelte",
        "src/lib/utilities/UtilCron.svelte",
        "src/lib/utilities/UtilPassword.svelte",
        "src/lib/utilities/UtilJwt.svelte",
        "src/lib/utilities/UtilKnownHosts.svelte",
        // Network tools (Phase 34) — UI shells over pure .ts (tls/http) + the
        // shared probe runner.
        "src/lib/utilities/UtilProbeRunner.svelte",
        "src/lib/utilities/UtilTls.svelte",
        "src/lib/utilities/UtilHttp.svelte",
        "src/lib/ui/CopyButton.svelte",
        // Custom frameless window title bar (Windows/Linux) — UI shell over the
        // Tauri window API (minimize/maximize/close/drag/resize) + the shared
        // <ContextMenu>. Its pure logic (resize-edge geometry, menu anchoring)
        // lives in windowchrome.ts (covered in windowchrome.test.ts).
        "src/lib/windows/TitleBar.svelte",
      ],
      thresholds: {
        // Gate the pure logic hard (the safety net for the upcoming refactor).
        "src/lib/{servers/tree,monitoring/format,appearance/themes,app/clipboard}.ts": {
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
