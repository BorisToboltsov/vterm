# Решение проблем

Частые проблемы при установке и запуске. Установка — в [INSTALL.md](INSTALL.md);
возможности — в [GUIDE.md](GUIDE.md).

---

## Возможные проблемы
- **`cargo` не найден после установки rustup** — добавьте Cargo в `PATH`
  (`source "$HOME/.cargo/env"` или перезапустите терминал).
- **pnpm блокирует сборку нативных пакетов** (`Ignored build scripts: esbuild`) —
  разрешение уже прописано в [pnpm-workspace.yaml](../pnpm-workspace.yaml)
  (`allowBuilds: { esbuild: true }`); достаточно выполнить `pnpm install` повторно.
- **Долгая первая сборка Rust** — это нормально: компилируется всё дерево
  зависимостей Tauri. Последующие сборки используют кэш в `src-tauri/target/`.
- **На другом Mac приложение не открывается** («не удаётся проверить разработчика»
  / «программа повреждена») — сборка не подписана Developer ID и не нотаризована,
  поэтому при переносе macOS ставит карантин Gatekeeper (`com.apple.quarantine`).
  Запустите хелпер `open-on-mac.sh`, который лежит рядом с `.dmg` (кладётся при
  `pnpm tauri:build:mac` и в CI), либо снимите карантин вручную:
  `xattr -dr com.apple.quarantine /Applications/vterm.app`. Подробнее — в
  [INSTALL.md](INSTALL.md#запуск-готового-приложения) (раздел «Запуск готового
  приложения → macOS»).
