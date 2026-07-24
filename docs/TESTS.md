# Тестирование vterm

Как устроен и как гоняется тестовый набор. Задача набора — страховочная сеть под
рефакторинг: чистая логика покрыта на ≥ 90 %, интерфейс — компонентными тестами, контракты
— гейтами. Перечень гейтов и того, что каждый держит, — в
[INVARIANTS.md](INVARIANTS.md#гейты); правила процесса — в [../CLAUDE.md](../CLAUDE.md).

**Содержание:**
[Слои](#слои) · [Быстрый старт](#быстрый-старт) · [Что нужно установить](#что-нужно-установить) ·
[Что чем покрыто](#что-чем-покрыто) · [Гейты-контракты](#гейты-контракты) ·
[Покрытие](#покрытие) · [Живые SFTP-тесты](#живые-sftp-тесты) ·
[E2E и тестовый SSH](#e2e-и-тестовый-ssh) · [CI](#ci) · [Как добавить тест](#как-добавить-тест)

---

## Слои

| Слой | Стек | Объём | Что проверяет | Где идёт |
|------|------|-------|---------------|----------|
| **Rust unit** | `cargo test` | ~235 тестов | Чистая логика бэкенда: парсеры метрик, кодировки, пути, serde-модели, хранилище, политика host-key | Везде |
| **Frontend unit** | Vitest + jsdom | ~1760 тестов в 151 файле | Чистые `.ts`-модули: argv-билдеры и парсеры драйверов, пути, форматтеры, темы, настройки, сторы | Везде |
| **Component** | Vitest + `@testing-library/svelte` | 37 файлов | Рендер и взаимодействие панелей, модалок, форм | Везде |
| **Гейты-контракты** | Vitest (обычные тесты) | 14 файлов | Инварианты, которые нельзя проверить типами: см. [таблицу](INVARIANTS.md#гейты) | Везде |
| **Живые SFTP** | `cargo test -- --ignored` | 6 тестов | Что делает **сервер**, а не что вычислила функция | Локально + CI (нужен контейнер) |
| **E2E** | WebdriverIO + `tauri-driver` | happy-path | Реальное окно против живого SSH | **Linux/Windows**, не macOS |

## Быстрый старт

```sh
cargo test --manifest-path src-tauri/Cargo.toml    # Rust
pnpm test                                          # фронт: юнит + компонентные
pnpm test:coverage                                 # то же + гейты покрытия
```

Линтеры-гейты (входят в Definition of Done вместе с тестами):

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm check
pnpm build
```

## Что нужно установить

Toolchain на этой машине нестандартный:

```sh
source "$HOME/.cargo/env"                     # cargo не в PATH свежей сессии
export PATH="$HOME/Library/pnpm/bin:$PATH"    # standalone pnpm
```

Дополнительно, по необходимости: `cargo install cargo-llvm-cov` (покрытие Rust),
`cargo install tauri-driver` (E2E, только Linux/Windows).

---

## Что чем покрыто

Принцип: **логику тестируем в `.ts`/свободных функциях, а не через компонент**. Поэтому
у каждой подсистемы основная масса тестов лежит на чистом модуле, а на UI приходится
компонентный smoke или проверка конкретного поведения.

| Область | Чистая логика (основное покрытие) | Rust |
|---------|-----------------------------------|------|
| Терминал и подключение | `connphase`, `ssherror`, `connlost`, `localshell`, `terminput`, `broadcast`, `osc` | `ssh.rs` (политика host-key, имена событий, шифрованные ключи) |
| Драйверы панелей | `git`, `gitview`, `docker`, `k8s` (крупнейший набор — 807 строк), `probe`, `tls`, `http` | `git.rs`/`container.rs`/`kube.rs` (квотинг), `localenv.rs` (резолв PATH) |
| Файлы и пути | `fspath`, `filebrowser`, `filekeys`, `filemove`, `multiselect`, `sync`, `drives` | `sftp.rs`, `sync.rs`, `localfile.rs`, `drives.rs`, `textenc.rs` (кодировки) |
| Редактор | `editorlang`, `remotelint`, `nginxmode`, `markdown`, `htmlsan`, `badge`, `mdimage`, `cspnonce` | `textenc.rs`, `servertools.rs` |
| Мониторинг | `thresholds`, `hostcaps`, `monhealth`, `loadhistory`, `format` | `metrics/mod.rs` (30 тестов — парсеры проб), `metrics/local.rs` |
| Запись сессий | `recording`, `recgroup`, `airunbook`, `aiscript` | `recording.rs` (25 тестов — режимы, пауза, мета) |
| ИИ | `ai`, `aicore` (слои промпта), `aiprompts`, `aipresets`, `aiexec`, `aidialog`, `redact` | `ai.rs` (17 тестов — экстракторы дельт обоих протоколов) |
| Логи и текст | `jsonlog`, `highlight`, `search`, `history`, `command` | — |
| Утилиты | `codec`, `cidr`, `cron`, `jwt`, `pwgen`, `timeconv`, `knownhosts`, `sshkeygen`, `utilities` | `keygen.rs`, `store.rs` (known_hosts) |
| Состояние и настройки | `settings`, сторы `tabs`/`layout`/`workspaces`/`aichat`/`syncrun`/`transfers` | `store.rs` (атомарность, карантин), `backup.rs` |
| Оформление | `themes`, `motion`, `idle`, `idlefx`, `icons`, `ctxmenu` | — |

Компонентные тесты живут рядом с компонентом (`ServerTree.test.ts`, `AiChat.test.ts`,
`MonitoringOverlay.test.ts`, `SettingsPanel.test.ts`, `StatusBar.test.ts`,
`ServerFormModal.test.ts`, `pathbar.test.ts`, `localdrives.test.ts` и др.) и проверяют
поведение, а не вёрстку.

## Гейты-контракты

14 файлов `*.guard.test.ts` — обычные vitest-тесты, которые читают **исходники** и падают на
нарушении инварианта. Полный список «гейт → что держит» — в
[INVARIANTS.md](INVARIANTS.md#гейты); там же причина, по которой каждый заведён.

Два правила, выведенные из осечек:

- **Проверяй гейт на живом нарушении**, а не только на зелёном коде. Первая версия
  `mdlink.guard` была файловой и прошла на файле с удалённым экшеном — рядом лежал
  комментарий, упоминавший `use:mdLinks` словами. Первая регулярка `terminput.guard` молча
  пропускала ровно то нарушение, ради которого писалась.
- **Проверяй структуру, а не текст.** Гейт вкладок сначала падал на собственном комментарии
  в документации модуля; лечится разбором import/export-спецификаторов вместо поиска имени.

## Покрытие

| Область | Гейт |
|---------|------|
| `tree.ts`, `format.ts`, `themes.ts`, `clipboard.ts` | **≥ 90 %** строк, ветвей, функций |
| Фронтенд в целом (в пределах `include`) | **≥ 80 %** |
| Rust | Cobertura-отчёт в MR-виджете (порога нет) |

Настроено в [vitest.config.ts](../vitest.config.ts); `pnpm test:coverage` выходит с ненулевым
кодом при недоборе и роняет пайплайн. Отчёты: текст в консоли, HTML в `coverage/`,
Cobertura и JSON-summary для CI.

**Из покрытия исключены UI-оболочки** — компоненты, у которых нет своей логики: панели
драйверов, файловые панели, редактор и diff (CodeMirror), плеер и терминал (xterm),
`Util*.svelte`, секции настроек, модалки-формы. Каждое исключение подписано в конфиге
причиной и указанием, где лежит их покрытая чистая логика. Это не послабление, а следствие
инварианта «логика в `.ts`»: если оболочка требует покрытия — в ней завелась логика,
которой там быть не должно.

## Живые SFTP-тесты

Модуль `live_sftp` в [sftp.rs](../src-tauri/src/sftp.rs) гоняет round-trip сохранения против
**настоящего sshd**. Помечен `#[ignore]`, поэтому обычный `cargo test` остаётся герметичным:

```sh
docker compose -f e2e/docker-compose.ssh.yml up -d
cargo test --manifest-path src-tauri/Cargo.toml --lib live_sftp -- --ignored
docker compose -f e2e/docker-compose.ssh.yml down
```

**Зачем отдельный слой.** Весь набор чистых тестов `sftp.rs` был зелёным, пока редактор
уничтожал каждый сохранённый файл: `FileAttributes::default()` поднимал `ATTR_SIZE = 0`,
сервер делал `truncate`, и пустой временный файл переезжал на место конфига. Дефект жил не в
вычисленном значении, а в том, **что мы попросили сделать сервер**.

| Тест | Что закрепляет |
|------|----------------|
| `save_keeps_the_content_it_reported_writing` | Файл на сервере совпадает с правкой и с расписким об успехе |
| `save_preserves_permission_bits` | Права переносятся на замену |
| `save_rewrites_in_the_original_encoding` | Контракт кодировок: UTF-16LE + CRLF round-trip |
| `backup_copy_is_a_sibling_that_keeps_the_original_mode` | Где лежит `.bak` и какие у неё права |
| `a_failed_backup_aborts_the_save_and_leaves_the_file_intact` | Не удалось скопировать → сохранение отменено |
| `backup_is_skipped_for_a_file_that_does_not_exist_yet` | Копировать нечего — не ошибка |

Всё, что меняет **разговор с сервером** (атрибуты, порядок `remove`/`rename`, кодировки),
закрепляй здесь, а не только юнит-тестом на чистой функции.

> **Прежде чем считать баг «только на Windows», проверь, воспроизводится ли он локально.**
> Два дефекта из 39.6 пришли как windows-only и оба воспроизвелись на macOS, стоило завести
> нужную оснастку: вставка CRLF (любой insert, отмеряющий каретку от длины сырого буфера) и
> обнуление файла при сохранении — последнее вообще не было windows-специфичным, оно портило
> файлы на всех платформах.

## E2E и тестовый SSH

Каталог [e2e/](../e2e/) самодостаточен (свой `package.json`) и драйвит реальное нативное окно.

> `tauri-driver` поддерживает **только Linux и Windows** — на macOS E2E не запускается.
> Локально там гоняем `pnpm test`, E2E прогоняет CI.

```sh
cd e2e
pnpm install
docker compose -f docker-compose.ssh.yml up -d   # SSH на 127.0.0.1:2222, tester/testpass
pnpm test:e2e
docker compose -f docker-compose.ssh.yml down
```

Сценарий `specs/app.e2e.js` — happy-path: добавить сервер → подключиться → ввести команду →
проверить вывод. Селекторы — `data-testid` (`add-server`, `field-alias/host/username`,
`save-server`, `server-row`, `connect`, `secret-input`, `secret-connect`). Параметры сервера
переопределяются `VTERM_TEST_SSH_HOST`/`_PORT`/`_USER`/`_PASS`; в CI он подаётся как service.

## CI

[.gitlab-ci.yml](../.gitlab-ci.yml), стадии **`lint` → `security` → `test` → `build` →
`release`**: сборка идёт только после зелёных линтеров, security-гейтов и тестов.

- **`lint`** — `cargo fmt --check`, `cargo clippy -D warnings`, `pnpm check`; отдельная
  `lint:windows` с нативным clippy (кросс-проверка с Linux невозможна — `aws-lc-sys` требует
  Windows SDK).
- **`security`** — `cargo audit`, `cargo deny`, `pnpm audit`, Semgrep, Trivy.
- **`test:rust`** — `cargo llvm-cov`; **`test:web`** — `pnpm test:coverage` (junit + Cobertura);
  **`test:e2e`** — WebdriverIO против SSH-сервиса (`allow_failure`, нативный драйвер
  чувствителен к окружению).
- **`build:macos` / `build:windows` / `build:linux`** — три дистрибутива.

Релиз по тегу собирает [release.yml](../.github/workflows/release.yml) на раннерах GitHub —
см. [INSTALL.md](INSTALL.md#релизы-через-ci).

## Как добавить тест

- **Rust:** `#[test]` в `mod tests` рядом с кодом. Чистую логику выноси в свободную функцию,
  чтобы не тащить в тест `State` и сеть.
- **Фронтенд:** `src/lib/<модуль>.test.ts`, импорт функций напрямую. Логика без DOM живёт в
  `.ts`, а не в `.svelte` — это инвариант, а не совет.
- **Компонент:** `render(Component, { props })` из `@testing-library/svelte`, нативные API —
  через `vi.mock`. Проверяй поведение, не разметку.
- **Новый контракт:** заводи `*.guard.test.ts` **вместе** с правилом в INVARIANTS и проверь
  его на живом нарушении.
- **E2E:** `*.e2e.js` в `e2e/specs/` + `data-testid` на нужных элементах.

```sh
cargo test --manifest-path src-tauri/Cargo.toml && pnpm test && pnpm check
```
