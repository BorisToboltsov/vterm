# Contributing to vterm

Спасибо за интерес к проекту! Этот документ описывает, как настроить окружение,
какие правила соблюдать и как устроена кодовая база.

> Перед началом обязательно прочитайте [CLAUDE.md](CLAUDE.md): правила процесса (DoD,
> гейты, i18n, версии) и **карта документации** — что в какой файл писать и чего туда не
> писать. Жёсткие контракты кодовой базы — в [docs/INVARIANTS.md](docs/INVARIANTS.md)
> (канон); как всё устроено — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md);
> дизайн-система — в [docs/DESIGN.md](docs/DESIGN.md); обоснования решений — в
> [docs/adr/](docs/adr/).

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

Плюс `pnpm build` — `vite build` ловит поломки production-сборки, которые `pnpm check`
(только типы) пропускает. CI (`.gitlab-ci.yml`) гоняет те же гейты:
`lint → security → test → build → release`; сборка дистрибутивов не стартует, пока тесты не
зелёные. Подробно о тестах — в [docs/TESTS.md](docs/TESTS.md).

## Структура кода

```
src-tauri/src/        Rust-бэкенд (вся логика SSH/SFTP/секретов/файлов)
  <домен>.rs            #[tauri::command] живёт в своём модуле: servers, folders,
                        localfile, keygen, git, container, kube, netprobe, …
  lib.rs                generate_handler!, AppState, мост к сессиям
  error.rs              AppError (thiserror) — единый тип ошибок команд
  ssh.rs  sftp.rs       russh / russh-sftp     · secrets.rs — keychain
  store.rs              JSON-персистентность   · model.rs — serde camelCase ↔ TS
src/lib/              Фронтенд (Svelte 5 + TS)
  *.svelte              компоненты и панели
  Icon/Modal/ConfirmDialog/ContextMenu/PasswordInput.svelte   примитивы
  stores/*.svelte.ts    runes-сторы состояния (layout, tabs, workspaces, …)
  *.ts                  чистая логика — тестируется без DOM и сети
  actions/              drag · tooltip · mdlinks · clipboardKeys
  api/                  типизированные обёртки над invoke() (по доменам + barrel)
  i18n/                 locales · messages · translate
e2e/                  WebdriverIO + tauri-driver (Linux/Windows)
docs/adr/             Architecture Decision Records
```

Полная карта — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Правила

Жёсткие контракты кодовой базы (граница фронт/бэк, типизированные ошибки, чистая
логика в `.ts`, состояние в рунах, иконки из реестра, camelCase, офлайн,
безопасность, персистентность) — **канон в [docs/INVARIANTS.md](docs/INVARIANTS.md)**.
Соблюдайте их; не дублируйте список здесь, чтобы он не расходился.

- **Тесты обязательны** для новых фич. Новый контракт закрепляйте гейтом
  `*.guard.test.ts` и проверяйте его на живом нарушении, а не только на зелёном коде.
- **Видимый текст — только через `t()`** и сразу на всех языках: частичный перевод не
  компилируется.
- **Документация — часть работы.** Что в какой файл писать и чего туда не писать —
  таблица «Карта документации» в [CLAUDE.md](CLAUDE.md). Правило одно: у каждого
  документа свой жанр, вместо копии мысли — ссылка.

## Стиль

- Rust: `cargo fmt` + `clippy -D warnings`.
- TS/Svelte: проект форматируется в стиле существующего кода; `pnpm check` без ошибок.
- Комментарии объясняют «почему», а не «что»; следуйте плотности окружающего кода.

## Версионирование

Схема `0.<фаза>.<фикс>`: вторая цифра — номер фазы (растёт на новой фазе, третья
сбрасывается в 0), третья — фикс внутри фазы. Держите версию согласованной в
`package.json`, `src-tauri/Cargo.toml` и `src-tauri/tauri.conf.json`; затем `cargo check`
для синхронизации `Cargo.lock`.
