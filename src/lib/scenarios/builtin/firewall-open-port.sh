#!/bin/sh
# vterm:
#   name: Open a port in the firewall
#   description: Allows a port in ufw or firewalld, whichever is running; nothing else is changed
#   os: [debian, ubuntu, fedora, rhel, rocky, almalinux]
#   sudo: true
#   check: true
#   params:
#     PORT: { label: Port, required: true, hint: 443 }
#     PROTO: { label: Protocol, default: tcp, hint: tcp or udp }
set -eu

case "$PORT" in "" | *[!0-9]*) echo "not a port: $PORT" >&2; exit 3 ;; esac
case "$PROTO" in tcp | udp) ;; *) echo "not a protocol: $PROTO" >&2; exit 3 ;; esac

which_fw() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    echo ufw
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    echo firewalld
  else
    echo none
  fi
}

check() {
  case "$(which_fw)" in
    ufw)
      if ufw status | grep -qE "^$PORT/$PROTO +ALLOW"; then echo "already so: ufw allows $PORT/$PROTO"; return 0; fi
      echo "would allow $PORT/$PROTO in ufw"; return 1 ;;
    firewalld)
      if firewall-cmd -q --query-port="$PORT/$PROTO"; then echo "already so: firewalld allows $PORT/$PROTO"; return 0; fi
      echo "would allow $PORT/$PROTO in firewalld"; return 1 ;;
    *)
      echo "neither ufw nor firewalld is running here" >&2; exit 3 ;;
  esac
}

apply() {
  case "$(which_fw)" in
    ufw) ufw allow "$PORT/$PROTO" ;;
    firewalld)
      firewall-cmd -q --permanent --add-port="$PORT/$PROTO"
      firewall-cmd -q --reload
      echo "firewalld allows $PORT/$PROTO" ;;
    *) echo "neither ufw nor firewalld is running here" >&2; exit 3 ;;
  esac
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
