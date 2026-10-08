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
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const isWindows = platform() === "win32";

// `VTERM_E2E_PROFILE=debug` builds and drives the debug binary: minutes less
// per run while a spec is being written. CI leaves it unset — the suite then
// runs against what a release ships.
const profile = process.env.VTERM_E2E_PROFILE === "debug" ? "debug" : "release";

const binary = path.resolve(
  projectRoot,
  "src-tauri/target",
  profile,
  isWindows ? "vterm.exe" : "vterm",
);

let tauriDriver;
// The app's own directories for one spec file (Linux), removed after it.
let profileDir;

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
    const release = profile === "release" ? ["--release"] : [];
    spawnSync("cargo", ["build", ...release, "--features", "tauri/custom-protocol"], {
      cwd: path.resolve(projectRoot, "src-tauri"),
      stdio: "inherit",
    });
  },

  // Start/stop tauri-driver around each WebDriver session.
  beforeSession: () => {
    // Every spec file starts the app with nothing remembered. The app keeps its
    // servers on disk and brings back the tabs of its previous launch (ADR
    // 0019), so a spec would otherwise begin with whatever the one before it
    // left open. On Linux the app's directories follow the XDG variables; the
    // driver, and the app it starts, inherit them. (Windows keeps one profile:
    // the suite runs on Linux in CI, and WebView2's data folder is not moved by
    // an environment variable the driver could be trusted with.)
    if (!isWindows) {
      profileDir = mkdtempSync(path.join(tmpdir(), "vterm-e2e-"));
      for (const [name, dir] of [
        ["XDG_DATA_HOME", "data"],
        ["XDG_CONFIG_HOME", "config"],
        ["XDG_CACHE_HOME", "cache"],
      ]) {
        process.env[name] = path.join(profileDir, dir);
      }
    }
    // Where `cargo install` put it: CARGO_HOME when the toolchain sets one (the
    // official Rust image keeps it in /usr/local/cargo), else ~/.cargo.
    const cargoHome = process.env.CARGO_HOME || path.resolve(homedir(), ".cargo");
    tauriDriver = spawn(path.resolve(cargoHome, "bin", "tauri-driver"), [], {
      stdio: [null, process.stdout, process.stderr],
    });
  },
  afterSession: () => {
    tauriDriver?.kill();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  },
};
