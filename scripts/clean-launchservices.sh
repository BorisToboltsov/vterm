#!/usr/bin/env bash
#
# clean-launchservices.sh — вычищает мёртвые регистрации vterm.app из LaunchServices (macOS).
#
# Зачем: каждый `tauri build` создаёт .dmg, macOS монтирует его в новый /Volumes/dmg.XXXX
# и регистрирует лежащий внутри vterm.app. Шаг «Очистка сборок» затем сносит бандл — и
# регистрация становится фантомной, указывающей в несуществующий путь. За десятки пересборок
# их набираются десятки, все с одним bundle id `su.vcore.vterm`; Finder на «Открыть с помощью
# → vterm» резолвит id в мёртвую запись, и приложение молча не открывается (ровно этот баг).
#
# У КОНЕЧНОГО пользователя такого не бывает: он монтирует один .dmg, ставит в /Applications
# и извлекает том — остаётся одна регистрация. Проблема — только на машине разработчика,
# гоняющей сборку помногу раз. Поэтому это шаг очистки, а не правка кода.
#
# Скрипт трогает ТОЛЬКО регистрации vterm.app и только те, чей путь уже не существует на
# диске (или это оставшийся смонтированным build-DMG). Канонический /Applications/vterm.app
# не трогается, а в конце переобъявляется авторитетным. Идемпотентен и безопасен.
#
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "не macOS — пропускаю"; exit 0; }

LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -x "$LSREG" ]] || { echo "lsregister не найден" >&2; exit 1; }

count() { "$LSREG" -dump 2>/dev/null | grep -ci 'path:.*vterm\.app' || true; }

# 1) Отмонтировать тома с vterm.app, оставшиеся от прерванных сборок (иначе их запись
#    считается «живой» и не снимется ниже).
while IFS= read -r vol; do
  [[ -n "$vol" && -e "$vol/vterm.app" ]] || continue
  echo "==> отмонтирую $vol"
  hdiutil detach "$vol" -quiet 2>/dev/null || diskutil unmount "$vol" 2>/dev/null || true
done < <(mount | grep -oE '/Volumes/dmg\.[^ ]+' | sort -u)

before="$(count)"

# 2) Снять регистрацию каждой vterm.app, чей путь больше не существует на диске.
removed=0
while IFS= read -r p; do
  [[ -n "$p" && ! -e "$p" ]] || continue
  "$LSREG" -u "$p" 2>/dev/null || true
  echo "==> снял мёртвую регистрацию: $p"
  removed=$((removed + 1))
done < <("$LSREG" -dump 2>/dev/null | grep -oE '/[^ ]*vterm\.app' | sort -u)

# 3) Сделать установленную копию авторитетной (если она есть).
[[ -d /Applications/vterm.app ]] && "$LSREG" -f /Applications/vterm.app 2>/dev/null || true

echo "vterm-регистраций в LaunchServices: было ${before}, стало $(count) (снято ${removed})"
