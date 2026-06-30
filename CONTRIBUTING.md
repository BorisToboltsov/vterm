# Contributing to vterm

Спасибо за интерес к проекту! Этот документ описывает, как настроить окружение,
какие правила соблюдать и как устроена кодовая база.

> Перед началом обязательно прочитайте [CLAUDE.md](CLAUDE.md) — правила процесса
> (DoD, тесты, i18n, версии). Жёсткие контракты кодовой базы — в
> [docs/INVARIANTS.md](docs/INVARIANTS.md) (канон); как всё устроено — в
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); дизайн-система — в
> [docs/DESIGN.md](docs/DESIGN.md); обоснования решений — в [docs/adr/](docs/adr/).

## Окружение

```sh
source "$HOME/.cargo/env"                    # cargo не в PATH свежей сессии
export PATH="$HOME/Library/pnpm/bin:$PATH"   # standalone pnpm
pnpm install                                 # JS-зависимости
pnpm tauri dev                               # запуск приложения (первая Rust-сборка ~1–2 мин)
```

## Перед коммитом — всё должно быть зелёным

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml
pnpm check
pnpm test:coverage
```

CI (`.gitlab-ci.yml`) гоняет те же гейты: `lint → test → build → release`. Сборка
дистрибутивов не стартует, пока тесты не зелёные. Подробно о тестах — в
[docs/TESTS.md](docs/TESTS.md).

## Структура кода

```
src-tauri/src/        Rust-бэкенд (вся логика SSH/SFTP/секретов/файлов)
  error.rs              AppError (thiserror) — единый тип ошибок команд
  ssh.rs  sftp.rs       russh / russh-sftp
  secrets.rs            keychain
  store.rs              JSON-персистентность профилей/папок/known_hosts
  model.rs              модели (serde camelCase ↔ TS)
  lib.rs                #[tauri::command] — публичный API для фронта
src/lib/              Фронтенд (Svelte 5 + TS)
  *.svelte              компоненты (TopBar, ServerTree, Terminal, SftpPanel, …)
  Icon/Modal/ConfirmDialog.svelte   переиспользуемые примитивы
  stores/*.svelte.ts    runes-сторы состояния (layout, tabs, settings)
  tree.ts format.ts util.ts  чистая логика (тестируется без DOM)
  actions/drag.ts       pointer-drag экшен/хелперы
  api.ts                типизированные обёртки над invoke()
e2e/                  WebdriverIO + tauri-driver (Linux/Windows)
docs/adr/             Architecture Decision Records
```

## Правила

Жёсткие контракты кодовой базы (граница фронт/бэк, типизированные ошибки, чистая
логика в `.ts`, состояние в рунах, иконки из реестра, camelCase, офлайн,
безопасность, персистентность) — **канон в [docs/INVARIANTS.md](docs/INVARIANTS.md)**.
Соблюдайте их; не дублируйте список здесь, чтобы он не расходился.

- **Тесты обязательны** для новых фич; описывайте их в [docs/TESTS.md](docs/TESTS.md).

## Стиль

- Rust: `cargo fmt` + `clippy -D warnings`.
- TS/Svelte: проект форматируется в стиле существующего кода; `pnpm check` без ошибок.
- Комментарии объясняют «почему», а не «что»; следуйте плотности окружающего кода.

## Версионирование

Версию (`0.N.0`, N = номер фазы) держите согласованной в `package.json`,
`src-tauri/Cargo.toml` и `src-tauri/tauri.conf.json`; затем `cargo check` для
синхронизации `Cargo.lock`.
