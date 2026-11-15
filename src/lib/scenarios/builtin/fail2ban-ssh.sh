#!/bin/sh
# vterm:
#   name: fail2ban for SSH
#   description: Bans an address after failed SSH logins; its own file in jail.d, the rest of the setup is kept
#   os: [debian, ubuntu, fedora, rhel, rocky, almalinux]
#   sudo: true
#   check: true
#   params:
#     MAX_RETRY: { label: Failed logins before a ban, default: "5" }
#     BAN_TIME: { label: Ban for, default: 1h, hint: "10m, 1h, 1d" }
set -eu

JAIL=/etc/fail2ban/jail.d/vterm-sshd.local
case "$MAX_RETRY" in "" | *[!0-9]*) echo "not a number: $MAX_RETRY" >&2; exit 3 ;; esac
case "$BAN_TIME" in "" | *[!0-9smhdw]*) echo "not a time: $BAN_TIME" >&2; exit 3 ;; esac

os_like() ( . /etc/os-release 2>/dev/null; echo " ${ID:-} ${ID_LIKE:-} " )
wanted() {
  printf '%s\n' "# written by vterm" "[sshd]" "enabled = true" "maxretry = $MAX_RETRY" "bantime = $BAN_TIME"
}

check() {
  if ! command -v fail2ban-client >/dev/null 2>&1; then echo "would install fail2ban"; return 1; fi
  if [ "$(cat "$JAIL" 2>/dev/null)" != "$(wanted)" ]; then echo "would write $JAIL"; return 1; fi
  if ! fail2ban-client status sshd >/dev/null 2>&1; then echo "would start the sshd jail"; return 1; fi
  echo "already so: the sshd jail is on"
}

apply() {
  if ! command -v fail2ban-client >/dev/null 2>&1; then
    case "$(os_like)" in
      *" debian "* | *" ubuntu "*) apt-get -q update && apt-get -y -q install fail2ban ;;
      *" rhel "* | *" fedora "* | *" centos "*)
        dnf -y -q install epel-release 2>/dev/null || true
        dnf -y -q install fail2ban ;;
      *) echo "this system is not one the recipe knows: $(os_like)" >&2; exit 3 ;;
    esac
  fi
  mkdir -p /etc/fail2ban/jail.d
  wanted >"$JAIL"
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban
  sleep 1
  fail2ban-client status sshd | sed -n 's/.*Currently banned:[[:space:]]*/banned now: /p'
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
