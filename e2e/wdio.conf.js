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
  //
  // `--features tauri/custom-protocol` is MANDATORY: Tauri gates dev-vs-prod on
  // `is_dev() == !cfg!(feature = "custom-protocol")`, so a plain `cargo build`
  // yields a DEV binary that loads `devUrl` (http://localhost:1420) instead of
  // the embedded `frontendDist`. In CI there is no Vite server, so the window
  // renders WebKit's "Could not connect to localhost" error and no testid ever
  // appears. `tauri build` sets this feature; building via cargo we pass it.
  onPrepare: () => {
    spawnSync("cargo", ["build", "--release", "--features", "tauri/custom-protocol"], {
      cwd: path.resolve(projectRoot, "src-tauri"),
      stdio: "inherit",
    });
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
