#!/bin/sh
# vterm:
#   name: Free disk space
#   description: The system journal down to a size, the package cache emptied, packages nothing needs removed
#   os: [debian, ubuntu, fedora, rhel, rocky, almalinux]
#   sudo: true
#   check: true
#   params:
#     JOURNAL_MAX: { label: Keep of the journal, default: 200M, hint: "100M, 1G" }
set -eu

case "$JOURNAL_MAX" in "" | *[!0-9KMG]*) echo "not a size: $JOURNAL_MAX" >&2; exit 3 ;; esac

os_like() ( . /etc/os-release 2>/dev/null; echo " ${ID:-} ${ID_LIKE:-} " )
to_mb() {
  n=${1%?}
  case "$1" in *K) echo $((n / 1024)) ;; *M) echo "$n" ;; *G) echo $((n * 1024)) ;; *) echo $(($1 / 1048576)) ;; esac
}
journal_mb() {
  command -v journalctl >/dev/null 2>&1 || { echo 0; return; }
  du -sm /var/log/journal 2>/dev/null | cut -f1 || echo 0
}
cache_mb() {
  for d in /var/cache/apt/archives /var/cache/dnf; do
    [ -d "$d" ] && du -sm "$d" 2>/dev/null | cut -f1 && return
  done
  echo 0
}

check() {
  j=$(journal_mb)
  c=$(cache_mb)
  max=$(to_mb "$JOURNAL_MAX")
  if [ "${j:-0}" -gt "$max" ] || [ "${c:-0}" -gt 50 ]; then
    echo "journal ${j:-0} MB (keep $max), package cache ${c:-0} MB — would free them"
    return 1
  fi
  echo "already so: journal ${j:-0} MB, package cache ${c:-0} MB"
}

apply() {
  before=$(df -Pm / | awk 'NR == 2 { print $4 }')
  command -v journalctl >/dev/null 2>&1 && journalctl -q --vacuum-size="$JOURNAL_MAX"
  case "$(os_like)" in
    *" debian "* | *" ubuntu "*) apt-get -y -q autoremove && apt-get -q clean ;;
    *" rhel "* | *" fedora "* | *" centos "*) dnf -y -q autoremove && dnf -q clean all ;;
    *) echo "the package cache of this system is not one the recipe knows; the journal was trimmed" ;;
  esac
  after=$(df -Pm / | awk 'NR == 2 { print $4 }')
  echo "freed $((after - before)) MB on /"
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
