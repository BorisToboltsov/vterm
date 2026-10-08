# vterm E2E tests

End-to-end tests that drive the **real native window** via
[WebdriverIO](https://webdriver.io/) + [`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/).

> ⚠️ **`tauri-driver` supports Linux and Windows only — not macOS.**
> On macOS the suite runs in a Linux container: `pnpm e2e:linux` from the repo
> root (needs Docker; see [linux/](linux/) and the root
> [TESTS.md](../docs/TESTS.md#linux-в-контейнере) for the full picture).

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

The run builds the release binary first (`cargo build --release` in `src-tauri`;
`VTERM_E2E_PROFILE=debug` drives the debug one instead), then launches it through
`tauri-driver`. Every spec file gets an app profile of its own (Linux): the app
brings back the tabs of its previous launch, and a spec would otherwise start
with what the one before it left open.

## Specs

- `specs/app.e2e.js` — add a server, connect to the test sshd, run a command.
- `specs/windows.e2e.js` — two real windows, local shells only: a tab moves to a
  window of its own and back, and a pane moves whole.
- `specs/views.e2e.js` — files inside their connection, local shell only: a
  file opens under its connection's tab, cannot be dragged out of the
  connection, is dragged to its edge to stand beside the terminal (WebDriver's
  pointer — real pointer events inside one page), a second one stands beside
  the first, and the connection takes its zones to another window.
- `specs/windowdrop.e2e.js` — a tab dropped on another window with the X
  server's own pointer (`xdotool`). Linux on X11; skipped where there is no
  `xdotool` (CI's runner included).

`support/tabs.js` holds what the window specs share.

## On macOS: the Linux box

```sh
pnpm e2e:linux                                # the whole suite, in the container
pnpm e2e:linux --spec specs/windows.e2e.js    # one spec file
VTERM_E2E_WM=openbox pnpm e2e:linux           # under a window manager
```

`scripts/linux-box.sh <command>` runs any command in the same image — it is also
how the code under `cfg(target_os = "linux")` is built and linted from a Mac.
