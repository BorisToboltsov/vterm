#!/usr/bin/env bash
#
# place-opener.sh — кладёт open-on-mac.sh рядом с каждым собранным .dmg.
# Запускается после `tauri build` (см. npm-скрипт `tauri:build:mac` и CI build:macos),
# чтобы получатель нашёл хелпер прямо рядом с бандлом. Путь до .dmg отличается для
# нативной (target/release/…) и universal (target/universal-apple-darwin/release/…)
# сборки, поэтому ищем по всему target/ и покрываем оба случая.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
opener="$here/open-on-mac.sh"
target_root="$here/../src-tauri/target"

[[ -f "$opener" ]] || { echo "Не найден $opener" >&2; exit 1; }

found=0
while IFS= read -r dmg; do
  dir="$(dirname "$dmg")"
  cp "$opener" "$dir/open-on-mac.sh"
  chmod +x "$dir/open-on-mac.sh"
  echo "==> open-on-mac.sh рядом с $(basename "$dmg")  ($dir)"
  found=1
done < <(find "$target_root" -type f -name '*.dmg' -path '*/bundle/dmg/*' 2>/dev/null)

if [[ "$found" -eq 0 ]]; then
  echo "Не найдено ни одного .dmg под $target_root — сначала соберите (pnpm tauri build)." >&2
  exit 1
fi
