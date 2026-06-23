# Тестирование vterm

Документация по тестовому набору проекта (Фаза 5 дорожной карты —
[ROADMAP.md](ROADMAP.md)). Цель набора — **страховочная сеть перед
рефакторингом**: чистая логика покрыта на ≥ 90 %, есть компонентные и E2E-тесты,
а CI блокирует сборку, если тесты или гейты покрытия не прошли.

## Содержание

- [Слои тестов](#слои-тестов)
- [Что нужно установить](#что-нужно-установить)
- [Быстрый старт](#быстрый-старт)
- [Rust-тесты](#rust-тесты)
- [Фронтенд-тесты (Vitest)](#фронтенд-тесты-vitest)
- [Компонентные тесты](#компонентные-тесты)
- [E2E-тесты](#e2e-тесты)
- [Тестовый SSH-сервер](#тестовый-ssh-сервер)
- [Покрытие и гейты](#покрытие-и-гейты)
- [CI-пайплайн](#ci-пайплайн)
- [Где лежат тесты](#где-лежат-тесты)
- [Как добавить тест](#как-добавить-тест)

---

## Слои тестов

| Слой | Стек | Что проверяет | Где запускается |
|------|------|---------------|-----------------|
| **Rust unit** | `cargo test` | Чистая логика бэкенда: парсинг метрик, пути папок, serde-модели, хранилище, политика host-key | Везде (macOS/Linux/Windows) |
| **Frontend unit** | Vitest + jsdom | Чистые модули UI: дерево серверов, форматтеры, темы, настройки, clipboard, обёртки `api` | Везде |
| **Component** | Vitest + `@testing-library/svelte` | Рендер и взаимодействие компонентов (`HelpPanel`, `StatusBar`) | Везде |
| **E2E / интеграция** | WebdriverIO + `tauri-driver` | Реальное окно против живого SSH-сервера: добавление сервера, подключение, ввод команды, SFTP | **Linux/Windows** (не macOS) и CI |

> Интеграция с реальным SSH/SFTP (Фаза 5.3) выполняется E2E-набором против
> контейнера `linuxserver/openssh-server` — он поднимает весь стек
> (russh → PTY → exec → SFTP) так же, как боевое приложение.

---

## Что нужно установить

Toolchain на этой машине нестандартный (см. также внутреннюю памятку проекта):

```sh
# Rust (cargo/rustc ставились через rustup, но не в PATH свежей сессии):
source "$HOME/.cargo/env"

# pnpm — standalone-установка (corepack-шим сломан под Node 25):
export PATH="$HOME/Library/pnpm/bin:$PATH"
```

Для покрытия и E2E (по необходимости):

```sh
cargo install cargo-llvm-cov   # покрытие Rust
cargo install tauri-driver     # драйвер нативного окна для E2E (Linux/Windows)
```

---

## Быстрый старт

```sh
# Rust: юнит-тесты
cargo test --manifest-path src-tauri/Cargo.toml

# Фронтенд: юнит + компонентные тесты
pnpm test

# Фронтенд: с покрытием и гейтами
pnpm test:coverage

# Линтеры-гейты
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm check
```

---

## Rust-тесты

Юнит-тесты живут в `#[cfg(test)] mod tests` рядом с кодом, который проверяют.
Тестируется **чистая логика без сети**:

- `lib.rs` — `normalize_path`, `reprefixed` (перенос/переименование папок и
  поддеревьев), `parse_metrics` (вкл. расширенные поля: uptime/swap/users/ip/
  topproc/cputemp/netconns/kernel/stime), `parse_cpustat`, `parse_net`/`parse_pair`
  (rx/tx сети и disk I/O), `uuid_like`;
- `model.rs` — serde round-trip `ServerProfile`/`NewServerProfile`/`AuthMethod`
  (camelCase, `#[serde(default)]` для старых JSON без `group`/`tags`);
- `store.rs` — декодирование профилей/папок/known_hosts, битый JSON → дефолты,
  файловый round-trip во временном каталоге (`tempfile`);
- `pty.rs` — `pty_size` (кламп размеров локального PTY к ≥ 1×1). Само порождение
  shell-вкладки (`portable-pty`) проверяется вживую/E2E, а не юнит-тестом
  (нужен реальный tty + Tauri-события).
- `ssh.rs` — `HostKeyPolicy::from_str`, имена событий, `key_is_encrypted` на
  сгенерированных `ssh-keygen` ключах (тест мягко пропускается, если
  `ssh-keygen` недоступен); `find_default_key` (порядок предпочтения OpenSSH,
  пустой каталог → `None`, игнор каталогов с именем ключа) и `pick_key_path`
  (явный путь побеждает, пустой/отсутствующий откатывается на дефолт из `~/.ssh`).
- `error.rs` — `AppError`: наличие маркеров (`auth-rejected`/`host-key-rejected`)
  в `Display`, конверсии `From<String>/<io::Error>`, сериализация в строку
  (контракт с фронтом не меняется).
- `backup.rs` — экспорт/импорт бэкапа: round-trip серверов/папок/настроек
  (camelCase), отсутствие секретов в JSON, отказ на мусоре и будущей версии,
  минимальный документ, нормализация папок.

```sh
cargo test --manifest-path src-tauri/Cargo.toml            # все тесты
cargo test --manifest-path src-tauri/Cargo.toml parse_     # по имени
```

Покрытие (Cobertura + текстовый итог):

```sh
cargo llvm-cov --manifest-path src-tauri/Cargo.toml --no-report
cargo llvm-cov report --manifest-path src-tauri/Cargo.toml
```

> Опционально можно использовать `cargo nextest run` для более быстрого прогона —
> набор совместим с ним без изменений.

---

## Фронтенд-тесты (Vitest)

Конфигурация — [vitest.config.ts](vitest.config.ts) (отдельная от dev-конфига
Tauri/SvelteKit): плагин Svelte + `svelteTesting()`, среда **jsdom**, алиас
`$lib`. Глобальная подготовка — [vitest-setup.ts](vitest-setup.ts) (матчеры
`jest-dom`, детерминированный `localStorage` и no-op `Element.prototype.animate` —
jsdom не реализует Web Animations API, который используют Svelte-переходы
`slide`/`fade`).

```sh
pnpm test            # один прогон
pnpm test:watch      # watch-режим
pnpm test:coverage   # прогон + покрытие + гейты
```

Покрываемые чистые модули и сторы:

- `tree.ts` — построение `treeRows`, эффективные папки, группировка, фильтр
  поиска, `parentOf`/`nameOf`/`groupOf`, валидация drop (`dropAllowed`);
- `format.ts` — `fmtBytes`, `fmtRate` (B/KB/MB/s, прочерк для null), `fmtUptime`
  (d/h/m), `osIcon`
  (возвращает имя иконки реестра — Apple/Linux/Windows/BSD/Unknown, и каждое имя
  существует в `icons.ts`), `memPct`, `diskFree` (статус-бар);
- `util.ts` — `debounce` (с fake-таймерами), `isHidden`, `matchesQuery`
  (AND-подстрока, регистронезависимость, пустой запрос → всё);
- `command.ts` — `matchScore` (пустой запрос, отсутствие терма, регистронезависимость
  по title/subtitle/keywords/group, все термы обязательны, буст префикса) и
  `filterCommands` (порядок, отсев, ранжирование, стабильность ничьих);
- `actions/drag.ts` — `passedThreshold`, `dropTargetAt`, экшен `resizableHandle`;
- `actions/clipboardKeys.ts` — `selectedText`/`replaceSelection` (вставка по
  каретке и замена выделения с событием `input`) и экшен `clipboardKeys`: вставка
  по Cmd+V и Ctrl+V, копирование/вырезание выделения, select-all по Cmd+A,
  игнор обычных и Alt/Shift-модифицированных нажатий, снятие слушателя в `destroy`
  (модуль `../clipboard` замокан, так что вставка/копирование проверяются без
  Tauri/navigator);
- `themes.ts` — целостность палитр (все ключи — валидный hex, группа
  light/modern/retro), наличие светлых тем, `themeSwatches`, `getTheme`,
  `applyUiPalette`;
- `settings.svelte.ts` — дефолты, persist в `localStorage`, `activeTerminalTheme`,
  `resetSettings` (рунический модуль — эффекты прогоняются через `flushSync`);
- `stores/layout.svelte.ts` — дефолты, persist ширин/сворачивания, `clamp`;
- `stores/tabs.svelte.ts` — `openTab`/`closeTab`/`moveTab`/`setTabStatus`,
  переназначение активной вкладки, чистые `statusLabel`/`dotClass`/`isLive`,
  `nextTabIndex` (роуминг ←/→ с заворотом, Home/End, null для прочих клавиш/пустого);
- `stores/toasts.svelte.ts` — `notify`/`notifyError`/`notifySuccess`/`notifyInfo`,
  авто-дисмисс по `TOAST_TTL` (fake-таймеры), кастомный ttl и sticky (`ttl=0`),
  `dismissToast` (снятие таймера), `clearToasts`;
- `stores/transfers.svelte.ts` — `aggregateTransfers` (активные/суммарный %/
  направление, приоритет upload), `applyProgress` (upsert, авто-удаление done по
  `DONE_LINGER_MS` с fake-таймерами), `removeTransfer`;
- `clipboard.ts` — `writeClipboard` (async API + фолбэк на textarea/`execCommand`)
  и `readClipboard`: нативное чтение через бэкенд (`read_clipboard_text`, мок `./api`)
  без обращения к `navigator.clipboard`, откат на web-API при отсутствии нативного
  ридера, пустая строка если оба пути упали;
- `api.ts` — каждая обёртка вызывает `invoke`/диалог с правильным
  именем команды и аргументами (вкл. `readClipboardText` → `read_clipboard_text`,
  `exportBackup`/`importBackup` и backup-диалоги);
- `settings.svelte.ts` — `applyImportedSettings` (применение бэкапа: известные
  ключи, дефолты для отсутствующих, merge `customTheme`, игнор мусора);
- `icons.ts` — целостность реестра иконок;
- `markdown.ts` — мини-рендер Markdown для встроенной инструкции: `escapeHtml`,
  `inline` (код/ссылки/жирный/курсив, экранирование, литеральный код в бэктиках),
  `renderMarkdown` (заголовки по уровням, `<ul>` из подряд идущих пунктов, фенс-код
  с экранированием, pipe-таблицы, цитаты, `<hr>`, абзацы, закрытие списка перед
  заголовком, отличие `-` пункта от `---`).

**Гейты безопасности (юнит, в обычном `pnpm test`):**

- `autonomy.guard.test.ts` — нет runtime-обращений в сеть (fetch/WebSocket/CDN/
  аналитика). См. [Сеть и автономность](README.md#сеть-и-автономность).
- `tauri-security.guard.test.ts` — CSP задан и строгий, capabilities минимальны,
  opener ограничен `https://`, нет `dangerous*`. См. [SECURITY.md](SECURITY.md).

**Supply-chain / SAST (отдельная стадия `security` в CI, локально по желанию):**
`cargo audit` + `cargo deny check` (Rust), `pnpm audit` + **Semgrep**
(`p/typescript`/`p/javascript`/`p/secrets`), **Trivy** (`fs`). Принятые
исключения и обоснования — [SECURITY.md](SECURITY.md) и
[src-tauri/deny.toml](src-tauri/deny.toml).

> Чистая логика дерева и форматтеры вынесены из `+page.svelte` / `StatusBar.svelte`
> в отдельные `.ts`-модули (Фаза 5.8), поэтому тестируются без DOM.

---

## Компонентные тесты

`@testing-library/svelte` рендерит компоненты в jsdom; нативные Tauri-API
мокаются через `vi.mock`.

- `HelpPanel.test.ts` — вкладки Help/Инструкция/About, таблица хоткеев, версия из
  мока `@tauri-apps/api/app`, открытие внешних ссылок, контакты автора (email +
  Telegram через opener), рендер встроенного README на вкладке «Инструкция».
- `StatusBar.test.ts` — компактный режим по умолчанию (иконки + проценты, без имён/
  байтов/графика), тоггл в расширенный (имена, байты, sparkline, load-avg), скрытие
  группы по флагу видимости, индикатор передач SFTP из общего стора (+клик →
  разворот панели), OS-иконка по `title`, состояния ошибки/прочерков.
- `Icon.test.ts` — рендер SVG из реестра, размер, accessible-title.
- `Toast.test.ts` — рендер тостов из стора, роль `status`, кнопка Dismiss убирает
  тост (синхронизация с `toastsState`).
- `EmptyState.test.ts` — рендер иконки/заголовка/подсказки, опциональность подсказки,
  слот CTA-кнопок.
- `CommandPalette.test.ts` — список команд и фильтрация по вводу, запуск верхнего
  совпадения по Enter и закрытие, запуск по клику, навигация ↑/↓, закрытие по Escape,
  пустое состояние «Ничего не найдено».
- `Skeleton.test.ts` — пульсирующий плейсхолдер (`animate-pulse`, `aria-hidden`),
  применение размеров width/height и доп. классов.
- `Modal.test.ts` — `Modal` (рендер/закрытие по фону и Escape; a11y: `role="dialog"`/
  `aria-modal`/`aria-label`, автофокус первого контроля, фокус-трап Tab/Shift+Tab по
  кругу) и `ConfirmDialog` (колбэки confirm/cancel, accent/danger).
- `TopBar.test.ts` — статус и кнопка «Add server».
- `ServerTree.test.ts` — рендер папок/серверов, выбор, dbl-click → connect,
  сворачивание папки, фильтр поиска, кнопка «New folder», пустое состояние с
  CTA «Добавить сервер» (`empty-add-server` → `onAddServer`).
- `SettingsPanel.test.ts` — секция Backup: экспорт по выбранному пути со снимком
  настроек, отмена экспорта, импорт после подтверждения + вызов `onImported`;
  визуальный пикер тем (свёрнут/раскрытие, выбор → `aria-checked`), сетка шрифтов с
  Python-превью (`font-preview`), поиск по настройкам (фильтр секций, пустое состояние),
  сворачиваемые чекбоксы показателей статус-бара (`metrics-toggle`).

Тяжёлые интерактивные компоненты (`Terminal.svelte` — xterm.js,
`SftpPanel.svelte` — нативные диалоги и pointer-DnD, `SettingsPanel.svelte`)
исключены из юнит-покрытия и проверяются E2E-набором.

---

## E2E-тесты

Каталог [e2e/](e2e/) — самодостаточный (свой `package.json`). Драйвит **реальное
нативное окно** через WebdriverIO + `tauri-driver`.

> ⚠️ `tauri-driver` поддерживает **только Linux и Windows** — на macOS E2E не
> запускается. На macOS используйте `pnpm test`, а E2E прогоняет CI на Linux.

```sh
cd e2e
pnpm install
docker compose -f docker-compose.ssh.yml up -d   # тестовый SSH 127.0.0.1:2222
pnpm test:e2e
docker compose -f docker-compose.ssh.yml down
```

Сценарий `specs/app.e2e.js` (happy-path): добавить сервер → подключиться к
тестовому SSH → ввести команду → проверить вывод. Селекторы используют
`data-testid` (`add-server`, `field-alias/host/username`, `save-server`,
`server-row`, `connect`, `secret-input`, `secret-connect`), расставленные в
`+page.svelte` (Фаза 5.8). Подробности — [e2e/README.md](e2e/README.md).

---

## Тестовый SSH-сервер

Контейнер `linuxserver/openssh-server` (пароль-аутентификация) обслуживает E2E и
интеграционные сценарии:

```sh
docker compose -f e2e/docker-compose.ssh.yml up -d
# 127.0.0.1:2222 — пользователь tester / пароль testpass
```

Параметры переопределяются переменными окружения `VTERM_TEST_SSH_HOST`,
`_PORT`, `_USER`, `_PASS`. В CI сервер подаётся как GitLab service (job
`test:e2e`).

---

## Покрытие и гейты

| Область | Гейт | Где настроен |
|---------|------|--------------|
| Чистая логика фронта (`tree`, `format`, `themes`, `clipboard`) | **≥ 90 %** по строкам/ветвям/функциям | `thresholds` в [vitest.config.ts](vitest.config.ts) |
| Фронтенд в целом (в пределах `include`) | **≥ 80 %** | там же |
| Rust | Cobertura-отчёт в MR-виджете | job `test:rust` |

`pnpm test:coverage` завершается с ненулевым кодом, если порог не достигнут —
именно это и блокирует пайплайн. Отчёты: текст в консоли, HTML в `coverage/`,
Cobertura (`coverage/cobertura-coverage.xml`) и JSON-summary для CI.

---

## CI-пайплайн

[.gitlab-ci.yml](.gitlab-ci.yml), стадии **`lint` → `test` → `build` → `release`**.
Сборка дистрибутивов запускается только после зелёных линтеров и тестов:

- **`lint`** — `cargo fmt --check`, `cargo clippy -D warnings`, `pnpm check`.
- **`test:rust`** — `cargo llvm-cov` (тесты + покрытие, Cobertura в MR).
- **`test:web`** — `pnpm test:coverage` (юнит + компонентные + гейты), junit + Cobertura.
- **`test:e2e`** — WebdriverIO против SSH-сервиса (только дефолтная ветка/ручной
  запуск, `allow_failure: true` из-за чувствительности нативного драйвера к окружению).
- **`build:macos` / `build:windows`** — два дистрибутива (как в предыдущих фазах).

> Теги раннеров (`[linux]`, `[macos]`, `[windows]`) — плейсхолдеры, замените на
> теги ваших зарегистрированных GitLab-раннеров.

---

## Где лежат тесты

```
src-tauri/src/*.rs            # Rust: #[cfg(test)] mod tests рядом с кодом (incl. error.rs)
src/lib/*.test.ts             # Фронтенд: юнит + компонентные тесты
src/lib/stores/*.test.ts      # Тесты runes-сторов (layout, tabs)
src/lib/actions/*.test.ts     # Тесты pointer-drag хелперов/экшена
src/lib/autonomy.guard.test.ts# Гейт офлайн-автономности
vitest.config.ts              # Конфиг Vitest + гейты покрытия
vitest-setup.ts               # Глобальная подготовка (jest-dom, localStorage)
src/vitest-env.d.ts           # Типы матчеров jest-dom для svelte-check
e2e/                          # WebdriverIO + tauri-driver (свой package.json)
  wdio.conf.js                #   конфиг (сборка release + tauri-driver)
  specs/app.e2e.js            #   happy-path сценарий
  docker-compose.ssh.yml      #   тестовый SSH-сервер
```

---

## Как добавить тест

- **Rust:** добавьте `#[test]` в `mod tests` соответствующего файла. Для чистой
  логики выносите её в свободную функцию (как `reprefixed`), чтобы тестировать без
  `State`/сети.
- **Фронтенд:** создайте `src/lib/<модуль>.test.ts`, импортируйте функции
  напрямую. Логику без DOM держите в `.ts`-модулях, а не в `.svelte`.
- **Компонент:** `render(Component, { props })` из `@testing-library/svelte`,
  нативные API мокайте через `vi.mock`.
- **E2E:** добавьте `*.e2e.js` в `e2e/specs/` и `data-testid` на нужные элементы.

После изменений прогоняйте перед коммитом:

```sh
cargo test --manifest-path src-tauri/Cargo.toml && pnpm test && pnpm check
```
