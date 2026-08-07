// WebdriverIO config driving the real native vterm window through tauri-driver.
//
// Requirements (see e2e/README.md):
//   • `cargo install tauri-driver`
//   • Linux: WebKitWebDriver (package `webkit2gtk-driver`) on PATH
//   • Windows: msedgedriver matching the installed WebView2
//   • tauri-driver does NOT support macOS — run this suite on Linux or Windows.
//
// The app binary is built in release mode by onPrepare; a test SSH server is
// expected at VTERM_TEST_SSH_HOST:VTERM_TEST_SSH_PORT (see docker-compose.ssh.yml).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const isWindows = platform() === "win32";

const binary = path.resolve(
  projectRoot,
  "src-tauri/target/release",
  isWindows ? "vterm.exe" : "vterm",
);

// Failure diagnostics land here; the nightly workflow uploads it as an artifact.
const artifactsDir = path.resolve(__dirname, "e2e-artifacts");

let tauriDriver;

export const config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  capabilities: [
    {
      // tauri-driver bridges to the platform WebDriver and launches our binary.
      "tauri:options": { application: binary },
    },
  ],
  hostname: "127.0.0.1",
  port: 4444,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120000 },

  // Build the app once before the run.
  onPrepare: () => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    fs.mkdirSync(artifactsDir, { recursive: true });
    spawnSync("cargo", ["build", "--release"], {
      cwd: path.resolve(projectRoot, "src-tauri"),
      stdio: "inherit",
    });
  },

  // On failure, dump what the native window actually rendered. E2E only runs in
  // CI (tauri-driver has no macOS), so a "no such element" is otherwise blind:
  // we can't tell a blank page (app never mounted) from a wrong first screen.
  // Probe is printed to the log; screenshot/DOM are uploaded as an artifact.
  afterTest: async (test, _context, { passed }) => {
    if (passed) return;
    const slug = (test.title || "test").replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
    try {
      await browser.saveScreenshot(path.join(artifactsDir, `fail-${slug}.png`));
    } catch (e) {
      console.log(`[diag] screenshot failed: ${e.message}`);
    }
    try {
      fs.writeFileSync(
        path.join(artifactsDir, `pagesource-${slug}.html`),
        await browser.getPageSource(),
      );
    } catch (e) {
      console.log(`[diag] getPageSource failed: ${e.message}`);
    }
    try {
      const probe = await browser.execute(() => ({
        url: location.href,
        readyState: document.readyState,
        title: document.title,
        bodyLen: document.body ? document.body.innerHTML.length : -1,
        bodyHead: document.body ? document.body.innerHTML.slice(0, 1500) : null,
        testids: Array.from(document.querySelectorAll("[data-testid]")).map((el) =>
          el.getAttribute("data-testid"),
        ),
        hasTauri:
          typeof window.__TAURI__ !== "undefined" ||
          typeof window.__TAURI_INTERNALS__ !== "undefined",
      }));
      console.log("[diag] PAGE PROBE:\n" + JSON.stringify(probe, null, 2));
    } catch (e) {
      console.log(`[diag] probe failed: ${e.message}`);
    }
    try {
      console.log("[diag] BROWSER LOGS:\n" + JSON.stringify(await browser.getLogs("browser")));
    } catch (e) {
      console.log(`[diag] getLogs('browser') unsupported: ${e.message}`);
    }
  },

  // Start/stop tauri-driver around each WebDriver session.
  beforeSession: () => {
    tauriDriver = spawn(path.resolve(homedir(), ".cargo", "bin", "tauri-driver"), [], {
      stdio: [null, process.stdout, process.stderr],
    });
  },
  afterSession: () => {
    tauriDriver?.kill();
  },
};
