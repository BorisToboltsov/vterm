#!/usr/bin/env bash
# The E2E suite, inside the Linux box (scripts/linux-box.sh): the front end is
# built, the app is built by wdio's onPrepare, and the suite drives it on an X
# server that has no screen. Arguments go to wdio:
#
#   pnpm e2e:linux --spec specs/windows.e2e.js
#
# The debug binary is driven unless VTERM_E2E_PROFILE says otherwise — this is
# for writing specs; CI runs the release build on its own runner.
# The specs that need the test sshd (docker-compose.ssh.yml) reach it on the
# host: it publishes its port there, not inside this container.
set -euo pipefail

export VTERM_E2E_PROFILE="${VTERM_E2E_PROFILE:-debug}"
export VTERM_TEST_SSH_HOST="${VTERM_TEST_SSH_HOST:-host.docker.internal}"

pnpm install --frozen-lockfile
pnpm build
cd e2e
pnpm install --no-frozen-lockfile
# WebKit talks to a session bus; a container has none until one is started.
# VTERM_E2E_WM names a window manager to start on the X server first (the image
# has openbox); without it the server is bare, as on CI's runner.
exec dbus-run-session -- xvfb-run --auto-servernum --server-args="-screen 0 1600x1000x24" \
  bash -c 'if [ -n "${VTERM_E2E_WM:-}" ]; then "$VTERM_E2E_WM" & sleep 1; fi; exec pnpm test:e2e "$@"' run "$@"
