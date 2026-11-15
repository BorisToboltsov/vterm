#!/bin/sh
# vterm:
#   name: Prometheus node_exporter
#   description: node_exporter from its GitHub release, checked against the release's sums, as a systemd service
#   os: [debian, ubuntu, fedora, rhel, rocky, almalinux]
#   sudo: true
#   check: true
#   params:
#     VERSION: { label: Version, default: 1.8.2 }
#     LISTEN: { label: Listen on, default: ":9100", hint: 127.0.0.1:9100 }
set -eu

BIN=/usr/local/bin/node_exporter
UNIT=/etc/systemd/system/node_exporter.service
case "$VERSION" in "" | *[!0-9.]*) echo "not a version: $VERSION" >&2; exit 3 ;; esac
case "$LISTEN" in *[!0-9a-zA-Z.:\[\]-]*) echo "not an address: $LISTEN" >&2; exit 3 ;; esac

arch() {
  case "$(uname -m)" in
    x86_64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    armv7l) echo armv7 ;;
    *) echo "this machine is not one the release is built for: $(uname -m)" >&2; exit 3 ;;
  esac
}

check() {
  if [ ! -x "$BIN" ]; then echo "would install node_exporter $VERSION"; return 1; fi
  have=$("$BIN" --version 2>&1 | sed -n 's/^node_exporter, version \([0-9.]*\).*/\1/p')
  if [ "$have" != "$VERSION" ]; then echo "node_exporter $have; would install $VERSION"; return 1; fi
  if ! grep -q -- "--web.listen-address=$LISTEN" "$UNIT" 2>/dev/null; then echo "would listen on $LISTEN"; return 1; fi
  if ! systemctl is-active -q node_exporter; then echo "would start node_exporter"; return 1; fi
  echo "already so: node_exporter $VERSION on $LISTEN"
}

apply() {
  a=$(arch)
  name="node_exporter-$VERSION.linux-$a"
  base="https://github.com/prometheus/node_exporter/releases/download/v$VERSION"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/$name.tar.gz" "$base/$name.tar.gz"
  curl -fsSL -o "$tmp/sha256sums.txt" "$base/sha256sums.txt"
  (cd "$tmp" && grep " $name.tar.gz\$" sha256sums.txt | sha256sum -c -) >/dev/null
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  id node_exporter >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -M node_exporter
  install -m 755 "$tmp/$name/node_exporter" "$BIN"
  cat >"$UNIT" <<EOF
# written by vterm
[Unit]
Description=Prometheus node_exporter
After=network-online.target

[Service]
User=node_exporter
ExecStart=$BIN --web.listen-address=$LISTEN
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable node_exporter >/dev/null 2>&1
  systemctl restart node_exporter
  echo "node_exporter $VERSION on $LISTEN"
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
