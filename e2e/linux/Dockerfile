# The Linux side of vterm on a machine that is not Linux: the app is built and
# driven inside this image (see scripts/linux-box.sh and docs/TESTS.md). It is
# what the CI runner installs, in a container — WebKitGTK, its WebDriver, an X
# server without a screen, and tauri-driver.
#
# Both bases are official images; nothing is piped from the network into a shell.
FROM node:22-bookworm-slim AS node

FROM rust:1-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && npm install --global pnpm@11

# The packages of the CI jobs (ci.yml, nightly.yml), plus what a headless X
# session needs: xvfb and xauth for the server, xdotool to move its pointer,
# a session bus for WebKit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
      libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
      webkit2gtk-driver xvfb xauth xdotool x11-utils dbus-x11 rsync \
 && rm -rf /var/lib/apt/lists/*

# For the specs that move the X server's own pointer (windowdrop.e2e.js): a
# window of another application to lay over ours, a window manager to run them
# under (VTERM_E2E_WM=openbox — a bare X server stacks and focuses windows
# differently from a desktop), and a way to see the screen when such a spec
# fails (`import -window root shot.png`).
RUN apt-get update \
 && apt-get install -y --no-install-recommends x11-apps imagemagick openbox \
 && rm -rf /var/lib/apt/lists/*

# The box works as an ordinary user, as CI's runner does: once the packages are
# in, nothing here needs root. The directories the volumes of
# scripts/linux-box.sh are mounted over exist beforehand and belong to that
# user — a new volume takes the owner of the directory it covers. The X
# server's socket directory is made here too: only root may give it its mode.
RUN useradd --create-home --uid 1000 --shell /bin/bash vterm \
 && install -d -o vterm -g vterm /work /usr/local/cargo/registry \
 && install -d -m 1777 /tmp/.X11-unix
USER vterm
RUN mkdir -p /home/vterm/.local/share/pnpm

RUN rustup component add clippy rustfmt \
 && cargo install tauri-driver --locked

WORKDIR /work
