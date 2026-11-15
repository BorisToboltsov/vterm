#!/bin/sh
# vterm:
#   name: Update packages
#   description: Every package to its newest version from the system's repositories; says when a reboot is due
#   os: [debian, ubuntu, fedora, rhel, rocky, almalinux, alpine]
#   sudo: true
#   check: true
set -eu

os_like() ( . /etc/os-release 2>/dev/null; echo " ${ID:-} ${ID_LIKE:-} " )

pending() {
  case "$(os_like)" in
    *" debian "* | *" ubuntu "*)
      apt-get -q update >/dev/null
      apt-get -s -q upgrade 2>/dev/null | grep -c '^Inst ' || true
      ;;
    *" rhel "* | *" fedora "* | *" centos "*)
      dnf -q check-update 2>/dev/null | grep -cE '^[^ ]+\.[^ ]+ +[^ ]+ +[^ ]+' || true
      ;;
    *" alpine "*)
      apk -q update >/dev/null
      apk -u list 2>/dev/null | grep -c . || true
      ;;
    *)
      echo "this system is not one the recipe knows: $(os_like)" >&2
      exit 3
      ;;
  esac
}

check() {
  n=$(pending)
  if [ "$n" -gt 0 ]; then
    echo "would update $n packages"
    return 1
  fi
  echo "already so: every package is up to date"
}

apply() {
  case "$(os_like)" in
    *" debian "* | *" ubuntu "*)
      apt-get -q update
      apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
      ;;
    *" rhel "* | *" fedora "* | *" centos "*)
      dnf -y -q upgrade
      ;;
    *" alpine "*)
      apk -q update
      apk -q upgrade
      ;;
    *)
      echo "this system is not one the recipe knows: $(os_like)" >&2
      exit 3
      ;;
  esac
  if [ -f /var/run/reboot-required ] || { command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; }; then
    echo "updated; a reboot is due"
  else
    echo "updated"
  fi
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
