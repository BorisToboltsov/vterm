#!/usr/bin/env bash
# Run a command in vterm's Linux box: the project as it is on disk now, inside
# the image of e2e/linux/Dockerfile. For what only Linux can build or run —
# the code under `cfg(target_os = "linux")`, and the E2E suite (tauri-driver
# does not exist for macOS). See docs/TESTS.md.
#
#   scripts/linux-box.sh cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
#   pnpm e2e:linux --spec specs/windows.e2e.js      (= scripts/linux-box.sh e2e/linux/run.sh …)
#
# The working tree is mounted read-only and copied into a volume: nothing the
# box builds (node_modules, target/) lands in the checkout, and the macOS build
# next to it is left alone. The volumes keep the builds between runs; drop them
# with `docker volume rm vterm-linux-work vterm-linux-cargo vterm-linux-pnpm`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
image=vterm-linux-box

docker build --quiet --tag "$image" "$root/e2e/linux" >/dev/null

exec docker run --rm --init \
  --volume "$root":/src:ro \
  --volume vterm-linux-work:/work \
  --volume vterm-linux-cargo:/usr/local/cargo/registry \
  --volume vterm-linux-pnpm:/root/.local/share/pnpm \
  --env CI=1 \
  --env VTERM_E2E_PROFILE --env VTERM_E2E_WM --env VTERM_TEST_SSH_HOST \
  "$image" bash -c '
    set -euo pipefail
    rsync --archive --delete \
      --exclude node_modules --exclude /src-tauri/target --exclude /build \
      --exclude /.svelte-kit --exclude /.git \
      /src/ /work/
    cd /work
    exec "$@"
  ' linux-box "$@"
