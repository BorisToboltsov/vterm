# vterm E2E tests

End-to-end tests that drive the **real native window** via
[WebdriverIO](https://webdriver.io/) + [`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/).

> ⚠️ **`tauri-driver` supports Linux and Windows only — not macOS.**
> On macOS run the unit/component suites (`pnpm test`) and let CI run E2E on its
> Linux runner. See the root [TESTS.md](../TESTS.md) for the full picture.

## Prerequisites

- `cargo install tauri-driver`
- **Linux:** `webkit2gtk-driver` (provides `WebKitWebDriver`) on `PATH`
- **Windows:** `msedgedriver` matching the installed WebView2 runtime
- A test SSH server (see below)

## Test SSH server

```sh
docker compose -f docker-compose.ssh.yml up -d   # 127.0.0.1:2222, tester/testpass
```

## Run

```sh
pnpm install          # inside this e2e/ folder (separate from the app deps)
pnpm test:e2e
```

Override the target with `VTERM_TEST_SSH_HOST` / `_PORT` / `_USER` / `_PASS`.

The spec builds the release binary first (`cargo build --release` in `src-tauri`),
then launches it through `tauri-driver`.
