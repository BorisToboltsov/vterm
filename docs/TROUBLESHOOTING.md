# Решение проблем

Частые проблемы при установке, сборке и запуске. Установка и сборка — в
[INSTALL.md](INSTALL.md); возможности — в [GUIDE.md](GUIDE.md).

**Содержание:**
[🛠️ Сборка из исходников](#сборка-из-исходников) ·
[🍏 macOS](#macos) ·
[🪟 Windows](#windows)

---

## Сборка из исходников

- **`cargo` или `pnpm` не найдены** (`command not found`) — инструменты стоят в
  нестандартных путях. Откройте новую вкладку терминала (профиль перечитается) или
  выполните в текущей сессии: `source "$HOME/.cargo/env"` ·
  `export PATH="$HOME/Library/pnpm/bin:$PATH"`.
- **`Ignored build scripts: esbuild`** — pnpm блокирует нативные build-скрипты;
  разрешение уже прописано в [pnpm-workspace.yaml](../pnpm-workspace.yaml)
  (`allowBuilds: { esbuild: true }`), достаточно повторить `pnpm install`.
- **Долгая первая сборка Rust** — это нормально: компилируется всё дерево зависимостей
  Tauri. Последующие сборки берут кэш из `src-tauri/target/`.

## macOS

- **Приложение не открывается на другом Mac** («не удаётся проверить разработчика» /
  «программа повреждена») — сборка не подписана Developer ID, поэтому при переносе macOS
  ставит ей карантин Gatekeeper. Запустите хелпер `open-on-mac.sh` (лежит рядом с `.dmg`
  в релизе и при `pnpm tauri:build:mac`) либо снимите карантин вручную:
  `xattr -dr com.apple.quarantine /Applications/vterm.app`. Подробнее — в
  [INSTALL.md](INSTALL.md#готовая-сборка).

## Windows

- **`link.exe` not found** / ошибка линковки — не установлены **C++ Build Tools** или не
  перезапущен терминал после установки.
- **Окно не открывается / белый экран** — не установлен **WebView2 Runtime**.
- **`pnpm` не распознан** — не выполнен `corepack enable` или не перезапущен терминал.
- **`failed to read file 'capabilities\._default.json': stream did not contain valid
  UTF-8`** — исходники скопированы с macOS (флешка FAT/exFAT, сетевая шара, zip), и рядом
  с каждым файлом лёг служебный AppleDouble-двойник `._имя`; Tauri читает **все** файлы
  из `src-tauri\capabilities\` как JSON и падает на нём. Двойники скрытые — `dir` и
  Проводник их не показывают. Удалить из корня репозитория (PowerShell):

  ```powershell
  Get-ChildItem -Path . -Recurse -Force -Filter '._*' | Remove-Item -Force
  ```

  Заодно удалите папки `__MACOSX`. Надёжнее забирать код через `git clone` — тогда
  двойников не будет в принципе, git их не отслеживает.
