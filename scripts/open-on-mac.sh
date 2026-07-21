#!/usr/bin/env bash
#
# open-on-mac.sh — устанавливает и запускает НЕПОДПИСАННУЮ сборку vterm на чужом Mac,
# снимая карантин Gatekeeper. Отдавайте этот скрипт вместе с .dmg.
#
# Почему это нужно: сборка не подписана Developer ID и не нотаризована, поэтому при
# переносе (интернет/AirDrop/флешка) macOS ставит файлу атрибут com.apple.quarantine
# и отказывается открывать («не удаётся проверить разработчика» / «программа повреждена»).
# Скрипт снимает карантин и на Apple Silicon при необходимости ставит ad-hoc-подпись.
#
# Использование:
#   ./open-on-mac.sh                      # автопоиск vterm*.dmg рядом и в ~/Downloads
#   ./open-on-mac.sh путь/к/vterm.dmg     # явный путь к .dmg
#   ./open-on-mac.sh путь/к/vterm.app     # если .app уже распакован
#
set -euo pipefail

APP_NAME="vterm.app"
DEST="/Applications"

blue() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
red()  { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; }

# --- 1. Найти источник (.dmg или .app) ------------------------------------------
src="${1:-}"
if [[ -z "$src" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for dir in "$script_dir" "$PWD" "$HOME/Downloads" "$HOME/Desktop"; do
    cand="$(ls -t "$dir"/vterm*.dmg 2>/dev/null | head -1 || true)"
    [[ -n "$cand" ]] && { src="$cand"; break; }
  done
fi
[[ -z "$src" ]] && { red "Не найден vterm*.dmg. Укажите путь: $0 путь/к/vterm.dmg"; exit 1; }
[[ ! -e "$src" ]] && { red "Файл не найден: $src"; exit 1; }

# --- 2. Получить .app: из .dmg (монтируем) либо напрямую -------------------------
app_src=""
mount_point=""
cleanup() {
  [[ -n "$mount_point" ]] && hdiutil detach "$mount_point" -quiet -force >/dev/null 2>&1 || true
}
trap cleanup EXIT

case "$src" in
  *.dmg)
    blue "Монтирую образ: $src"
    attach_out="$(hdiutil attach "$src" -nobrowse -readonly)"
    mount_point="$(echo "$attach_out" | grep -o '/Volumes/.*' | tail -1)"
    [[ -z "$mount_point" ]] && { red "Не удалось смонтировать .dmg"; exit 1; }
    app_src="$mount_point/$APP_NAME"
    ;;
  *.app)
    app_src="$src"
    ;;
  *)
    red "Ожидается .dmg или .app, получено: $src"; exit 1 ;;
esac
[[ ! -d "$app_src" ]] && { red "Внутри не найден $APP_NAME"; exit 1; }

# --- 3. Скопировать в /Applications ---------------------------------------------
target="$DEST/$APP_NAME"
blue "Устанавливаю в $DEST"
if [[ -w "$DEST" ]]; then
  rm -rf "$target"
  cp -R "$app_src" "$DEST/"
else
  blue "Нужны права администратора для записи в $DEST — потребуется пароль (sudo)"
  sudo rm -rf "$target"
  sudo cp -R "$app_src" "$DEST/"
fi

# .dmg больше не нужен — размонтируем до запуска
cleanup
mount_point=""

# --- 4. Снять карантин ----------------------------------------------------------
blue "Снимаю карантин (com.apple.quarantine)"
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

# --- 5. ad-hoc подпись на Apple Silicon, если валидной подписи нет ---------------
if [[ "$(uname -m)" == "arm64" ]]; then
  if ! codesign --verify --deep --strict "$target" >/dev/null 2>&1; then
    blue "Ставлю ad-hoc-подпись (требование Apple Silicon)"
    codesign --force --deep --sign - "$target" >/dev/null 2>&1 || true
  fi
fi

# --- 6. Запуск ------------------------------------------------------------------
blue "Запускаю vterm"
open "$target"
