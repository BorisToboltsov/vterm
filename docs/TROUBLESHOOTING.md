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
