# CLAUDE.md — правила разработки vterm

Свод **обязательных правил и ограничений** для любой работы в этом репозитории.
Этот файл автоматически загружается Claude Code в начале каждой сессии — держи его
**компактным**. Подробности живут в `docs/` (ссылки ниже), сюда выносим только то,
что нужно соблюдать.

- **Жёсткие контракты (инварианты)** → [docs/INVARIANTS.md](docs/INVARIANTS.md) — подключены ниже
- **Как устроено (архитектура)** → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Как выглядит UI (закреплено)** → [docs/DESIGN.md](docs/DESIGN.md)
- **План развития** → [docs/ROADMAP.md](docs/ROADMAP.md) · **история** → [CHANGELOG.md](CHANGELOG.md)
- **Тесты** → [docs/TESTS.md](docs/TESTS.md) · **безопасность** → [SECURITY.md](SECURITY.md)

---

## Definition of Done (каждая задача)

1. **Дорожная карта.** Отмечай сделанное в [docs/ROADMAP.md](docs/ROADMAP.md)
   (чекбоксы `[x]`, статус фазы `⬜ → ✅`, краткая заметка) — как оформлены прошлые фазы.
2. **Тесты обязательны.** На каждую фичу/фикс — тесты (образцы и описания в
   [docs/TESTS.md](docs/TESTS.md); добавляй туда описание новых тестов).
3. **Прогон всего набора.** После задачи гоняй все гейты (команды ниже). Красное — чини.
4. **Документация наравне с кодом.** Любое добавление/фикс отражай в документации в том
   же объёме: руководство пользователя [docs/GUIDE.md](docs/GUIDE.md) (встроенная
   инструкция приложения), [README.md](README.md) (витрина), ROADMAP (статус), при
   изменении тестов — TESTS, при изменении инвариантов — [docs/INVARIANTS.md](docs/INVARIANTS.md),
   при изменении архитектуры/дизайна — ARCHITECTURE/DESIGN. Фича без отражения в доках —
   **незавершённая**.
5. **Перевод наравне с кодом.** Любой видимый пользователю текст — **только** через
   `t()` и **сразу на всех** языках (см. «i18n» ниже). Частичный перевод не компилируется.
6. **Версия и два артефакта** — см. ниже.

### Полный прогон перед завершением

```sh
source "$HOME/.cargo/env"                       # cargo не в PATH свежей сессии
export PATH="$HOME/Library/pnpm/bin:$PATH"      # standalone pnpm

cargo fmt   --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml
pnpm check
pnpm test:coverage
pnpm build          # production vite build — ловит поломки релизной сборки
```

Все шесть команд должны быть зелёными. Гейты покрытия (**≥ 90 %** чистая логика,
**≥ 80 %** в целом) настроены в [vitest.config.ts](vitest.config.ts) и **роняют** прогон.
`pnpm build` обязателен отдельно от `pnpm check`: `check` — это только `svelte-check`
(типы), а `pnpm build` (`vite build`, rollup/SSR) ловит поломки production-сборки,
которые `check` пропускает (например, несовместимость версии зависимости —
`pnpm tauri build` собирает тот же бандл).

### Очистка сборок (после зелёного прогона)

Только **когда все шесть гейтов зелёные**, последним шагом чисти собранные
дистрибутивы — иначе диск забивается от многочисленных пересборок. Красное сначала
чини, потом чисти.

```sh
rm -rf src-tauri/target/release/bundle    # .app/.dmg/.msi/.exe от tauri build
```

Инкрементальный кэш Rust (`src-tauri/target/debug`, `…/release/deps`) **не трогаем** —
он держит следующую сборку быстрой; удаляем только готовые бандлы, которые весят
больше всего и не нужны после проверки.

---

## Инварианты (контракты кодовой базы)

Жёсткие контракты — что обязан / чего нельзя (граница фронт/бэк, единый контракт
терминала, типизированные ошибки, чистая логика в `.ts`, состояние в рунах,
переиспользование компонентов, camelCase, персистентность, **офлайн**,
**безопасность**, дизайн-система) — вынесены в [docs/INVARIANTS.md](docs/INVARIANTS.md)
и **подключены сюда автоматически** строкой импорта ниже (Claude Code инлайнит её
содержимое в контекст каждой сессии):

@docs/INVARIANTS.md

## i18n — ЗАКРЕПЛЕНО

- **Главное правило.** Весь видимый текст — на **всех** языках, через `t()`. Хардкод строк
  в компонентах запрещён (надписи, кнопки, `title`/`aria-label`, тосты, тексты ошибок).
  Добавляя фичу, добавляй ключ **сразу во все** словари — иначе `pnpm check` падает.
- **Где живёт.** [src/lib/i18n/](src/lib/i18n/): `locales.ts` (реестр, `DEFAULT_LOCALE=en`),
  `messages.ts` (`en` — канонический набор ключей), `translate.ts` (чистые resolve/interpolate),
  `index.ts` (`t()` реактивен от `settings.language`).
- **Не переводим** доменные термины (`CPU`/`RAM`/`SSH`/`SFTP`/`IP`/`PSI`/`inodes`/имена тем…).
- **Логику не завязывай на перевод:** храни канонический английский в состоянии, локализуй
  только при выводе (`localizedStatus`). Поиск по настройкам — двуязычный (EN+RU в одной строке).
- **Нативное меню** строится в Rust, метки пушатся с фронта (`set_menu_language`).
- Переменную `{#each … as t}` не называй `t` в файлах с функцией перевода.

## Сборка: два артефакта на каждой фазе

Каждая фаза даёт **два** дистрибутива — macOS (`.app`/`.dmg`) и Windows (`.msi`/`.exe`).
Единый кросс-ОС файл невозможен; Windows на этом Mac не собирается → механизм — **GitLab CI**
([.gitlab-ci.yml](.gitlab-ci.yml), self-hosted раннеры). CI: `lint → test → build → release`.

## Версионирование

Схема `0.<фаза>.<фикс>` (валидный трёхчисловой SemVer): 2-я цифра — номер фазы (поднимается
на новой фазе, последняя сбрасывается в 0), 3-я — фикс/хотфикс внутри фазы. Поднимай
согласованно в [package.json](package.json), [src-tauri/Cargo.toml](src-tauri/Cargo.toml),
[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json), затем `cargo check` (синк `Cargo.lock`).
Приложение читает версию из `tauri.conf.json` (About-окно). Номер фичи в версии не кодируется —
ведётся в ROADMAP.

## Toolchain (нестандартный на этой машине)

- `cargo`/`rustc` через rustup, **не в PATH** свежей сессии → `source "$HOME/.cargo/env"`.
- `pnpm` — standalone в `$HOME/Library/pnpm/bin` (corepack-шим сломан под Node 25) →
  `export PATH="$HOME/Library/pnpm/bin:$PATH"`.
- pnpm гейтит нативные build-скрипты; esbuild разрешён через `allowBuilds: { esbuild: true }`
  в [pnpm-workspace.yaml](pnpm-workspace.yaml) (НЕ `onlyBuiltDependencies` в package.json).
- Запуск: `pnpm tauri dev` (первая Rust-сборка ~1–2 мин).
- `tauri-driver` (E2E) — только Linux/Windows, не macOS. Локально на macOS — `pnpm test`; E2E гоняет CI.
