#!/bin/sh
# vterm:
#   name: SSH sign-in by key only
#   description: Turns password sign-in off in sshd; refuses while the user has no key, and checks sshd's config before reloading
#   os: [debian, ubuntu, fedora, rhel, rocky, almalinux]
#   sudo: true
#   check: true
set -eu

CONF=/etc/ssh/sshd_config.d/99-vterm-keys-only.conf
login=${SUDO_USER:-$(id -un)}

keys_only() { sshd -T 2>/dev/null | grep -qi '^passwordauthentication no'; }

check() {
  if keys_only; then echo "already so: sshd takes keys only"; return 0; fi
  echo "would turn password sign-in off"
  return 1
}

apply() {
  home=$(getent passwd "$login" | cut -d: -f6)
  if [ ! -s "$home/.ssh/authorized_keys" ]; then
    echo "$login has no authorized key: turning passwords off would lock them out" >&2
    exit 3
  fi
  if ! grep -qiE '^[[:space:]]*Include[[:space:]].*sshd_config\.d' /etc/ssh/sshd_config; then
    echo "sshd_config does not read sshd_config.d — nothing was changed" >&2
    exit 3
  fi
  mkdir -p /etc/ssh/sshd_config.d
  printf '%s\n' "# written by vterm" "PasswordAuthentication no" "KbdInteractiveAuthentication no" >"$CONF"
  if ! sshd -t; then
    rm -f "$CONF"
    echo "sshd rejected the config; it was removed and nothing was reloaded" >&2
    exit 1
  fi
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  if keys_only; then echo "sshd takes keys only"; else echo "written, but sshd still allows passwords: another file sets it first" >&2; exit 1; fi
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
