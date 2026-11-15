#!/bin/sh
# vterm:
#   name: User with an SSH key
#   description: A user who signs in with a public key; with sudo when asked
#   os: [debian, ubuntu, fedora, rhel, rocky, almalinux, alpine]
#   sudo: true
#   check: true
#   params:
#     NEW_USER: { label: User name, required: true }
#     PUBLIC_KEY: { label: Public key (one line), required: true, hint: ssh-ed25519 AAAA… }
#     WITH_SUDO: { label: Member of the sudo group, type: bool, default: false }
set -eu

case "$NEW_USER" in
  "" | *[!a-z0-9_.-]* | -*) echo "not a user name: $NEW_USER" >&2; exit 3 ;;
esac
case "$PUBLIC_KEY" in
  ssh-* | ecdsa-* | sk-*) ;;
  *) echo "not a public key: it starts with ssh-, ecdsa- or sk-" >&2; exit 3 ;;
esac

admin_group() {
  if getent group sudo >/dev/null 2>&1; then echo sudo; else echo wheel; fi
}
home_of() { getent passwd "$NEW_USER" | cut -d: -f6; }
has_key() {
  h=$(home_of)
  [ -n "$h" ] && [ -f "$h/.ssh/authorized_keys" ] && grep -qxF "$PUBLIC_KEY" "$h/.ssh/authorized_keys"
}
in_admin() { id -nG "$NEW_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$(admin_group)"; }

check() {
  if ! id "$NEW_USER" >/dev/null 2>&1; then echo "would create $NEW_USER"; return 1; fi
  if ! has_key; then echo "would add the key to $NEW_USER"; return 1; fi
  if [ "$WITH_SUDO" = true ] && ! in_admin; then echo "would add $NEW_USER to $(admin_group)"; return 1; fi
  echo "already so: $NEW_USER signs in with this key"
}

apply() {
  if ! id "$NEW_USER" >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd -m -s /bin/sh "$NEW_USER"
    else
      adduser -D -s /bin/sh "$NEW_USER"
    fi
    echo "created $NEW_USER"
  fi
  h=$(home_of)
  install -d -m 700 -o "$NEW_USER" "$h/.ssh"
  touch "$h/.ssh/authorized_keys"
  if ! grep -qxF "$PUBLIC_KEY" "$h/.ssh/authorized_keys"; then
    printf '%s\n' "$PUBLIC_KEY" >>"$h/.ssh/authorized_keys"
    echo "the key was added"
  fi
  chown "$NEW_USER" "$h/.ssh/authorized_keys"
  chmod 600 "$h/.ssh/authorized_keys"
  if [ "$WITH_SUDO" = true ] && ! in_admin; then
    g=$(admin_group)
    if command -v usermod >/dev/null 2>&1; then usermod -aG "$g" "$NEW_USER"; else addgroup "$NEW_USER" "$g"; fi
    echo "$NEW_USER is in $g"
  fi
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
