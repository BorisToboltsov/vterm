#!/bin/sh
# vterm:
#   name: Swap file
#   description: A swap file of the given size, on at boot, and how eagerly the kernel uses it
#   os: [debian, ubuntu, fedora, rhel, rocky, almalinux, alpine]
#   sudo: true
#   check: true
#   params:
#     SIZE_MB: { label: "Size, MB", default: "2048" }
#     SWAPPINESS: { label: Swappiness (0–100), default: "10" }
set -eu

FILE=/swapfile
case "$SIZE_MB" in "" | *[!0-9]*) echo "not a size: $SIZE_MB" >&2; exit 3 ;; esac
case "$SWAPPINESS" in "" | *[!0-9]*) echo "not a swappiness: $SWAPPINESS" >&2; exit 3 ;; esac

active_mb() { awk -v f="$FILE" '$1 == f { print int($3 / 1024) }' /proc/swaps; }

check() {
  now=$(active_mb)
  want=$((SIZE_MB - 1))
  if [ -z "$now" ]; then echo "would make $FILE of $SIZE_MB MB"; return 1; fi
  if [ "$now" -lt "$want" ]; then echo "$FILE is $now MB; would make it $SIZE_MB MB"; return 1; fi
  if [ "$(cat /proc/sys/vm/swappiness)" != "$SWAPPINESS" ]; then echo "would set swappiness to $SWAPPINESS"; return 1; fi
  if ! grep -q "^$FILE " /etc/fstab; then echo "would turn $FILE on at boot"; return 1; fi
  echo "already so: $FILE $now MB, swappiness $SWAPPINESS"
}

apply() {
  now=$(active_mb)
  if [ -z "$now" ] || [ "$now" -lt $((SIZE_MB - 1)) ]; then
    [ -n "$now" ] && swapoff "$FILE"
    rm -f "$FILE"
    fallocate -l "${SIZE_MB}M" "$FILE" 2>/dev/null || dd if=/dev/zero of="$FILE" bs=1M count="$SIZE_MB" status=none
    chmod 600 "$FILE"
    mkswap "$FILE" >/dev/null
    swapon "$FILE"
    echo "$FILE: $SIZE_MB MB"
  fi
  grep -q "^$FILE " /etc/fstab || echo "$FILE none swap sw 0 0" >>/etc/fstab
  echo "vm.swappiness = $SWAPPINESS" >/etc/sysctl.d/99-vterm-swap.conf
  sysctl -q -w vm.swappiness="$SWAPPINESS"
  echo "swappiness $SWAPPINESS"
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
