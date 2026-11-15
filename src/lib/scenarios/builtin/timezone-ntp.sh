#!/bin/sh
# vterm:
#   name: Time zone and NTP
#   description: The system's time zone, and its clock kept by NTP (systemd)
#   os: [debian, ubuntu, fedora, rhel, rocky, almalinux]
#   sudo: true
#   check: true
#   params:
#     TIME_ZONE: { label: Time zone, default: UTC, hint: Europe/Berlin }
set -eu

case "$TIME_ZONE" in "" | *..* | /*) echo "not a time zone: $TIME_ZONE" >&2; exit 3 ;; esac
command -v timedatectl >/dev/null 2>&1 || { echo "timedatectl is missing: the recipe needs systemd" >&2; exit 3; }
[ -e "/usr/share/zoneinfo/$TIME_ZONE" ] || { echo "no such time zone here: $TIME_ZONE" >&2; exit 3; }

check() {
  tz=$(timedatectl show -p Timezone --value)
  ntp=$(timedatectl show -p NTP --value)
  if [ "$tz" != "$TIME_ZONE" ]; then echo "time zone $tz; would set $TIME_ZONE"; return 1; fi
  if [ "$ntp" != yes ]; then echo "would turn NTP on"; return 1; fi
  echo "already so: $TIME_ZONE, NTP on"
}

apply() {
  timedatectl set-timezone "$TIME_ZONE"
  timedatectl set-ntp true
  echo "$TIME_ZONE, NTP on: $(date)"
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
