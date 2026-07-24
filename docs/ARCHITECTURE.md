# Архитектура vterm

Как устроено приложение: стек, граница фронт/бэк, каналы, слои, из чего собраны
подсистемы. **Что обязан соблюдать** — в [INVARIANTS.md](INVARIANTS.md) (канон),
**как выглядит** — в [DESIGN.md](DESIGN.md), **что и когда делали** — в
[ROADMAP.md](ROADMAP.md) и [CHANGELOG.md](../CHANGELOG.md), обоснования решений — в
[adr/](adr/). Здесь — только карта: детали реализации живут в коде и устаревают быстрее
текста.

**Содержание:**
[Стек](#стек) ·
[Граница фронт/бэк](#граница-фронтбэк) ·
[Каналы событий](#каналы-событий) ·
[Фронтенд: слои](#фронтенд-слои) ·
[Бэкенд: модули](#бэкенд-модули) ·
[Подсистемы](#подсистемы) ·
[Структура каталогов](#структура-каталогов)

---

## Стек

| Слой | Технология | Роль |
|------|-----------|------|
| Оболочка | **Tauri 2** | Нативное окно + WebView, Rust-бэкенд, нативное меню |
| Бэкенд | **Rust** stable | Команды, состояние, SSH/SFTP/секреты, метрики, ИИ-брокер |
| Фронтенд | **SvelteKit** (Svelte 5, runes), SPA через `adapter-static` | UI |
| Стили | **Tailwind CSS v4** | Плагин Vite, без `tailwind.config.js`/PostCSS; токены — через `@theme` в [app.css](../src/app.css) |
| Сборка | **Vite 6** | Dev-сервер и бандл |
| Терминал | **xterm.js 6** + fit/webgl/search/web-links | ANSI, поиск по буферу, кликабельные ссылки |
| SSH | **russh 0.61** | Чистый Rust: пароль/ключ, PTY, shell, exec |
| Локальный PTY | **portable-pty 0.9** | forkpty (Unix) / ConPTY (Windows) |
| SFTP | **russh-sftp 2** | Поверх той же SSH-сессии |
| Редактор | **CodeMirror 6** | 50+ языков, линт, инлайн-diff (`unifiedMergeView`) |
| Секреты | **keyring 3** | Keychain (macOS) / Credential Manager (Windows) / Secret Service |
| Метрики (локально) | **sysinfo** | Нативный сбор без сети |
| Ключи | **ssh-key** + `rand` | Офлайн-генерация, без внешнего `ssh-keygen` |
| LLM | **reqwest** (rustls) | Только из Rust, только к эндпоинту пользователя |
| Тесты | **cargo test** · **Vitest** · **WebdriverIO** | Юнит / компонентные / E2E |

---

## Граница фронт/бэк

Главный принцип: **тяжёлая логика — в Rust, фронтенд — тонкий UI**. Граница проходит по
двум каналам Tauri: команды (`invoke`, запрос-ответ) и события (`emit`, поток от бэкенда).
Фронтенд **не делает сетевых вызовов вообще** — ни SSH, ни LLM, ни загрузки картинок; всё
исходящее идёт из Rust, поэтому CSP остаётся строгим (см. офлайн-инвариант).

```
┌──────────────────────── WebView · фронтенд ─────────────────────────┐
│  routes/+page.svelte — оркестратор (вкладки, доки, модалки)         │
│      ├── lib/*.svelte  — компоненты и панели                        │
│      ├── lib/stores/   — состояние в рунах (tabs, layout, …)        │
│      └── lib/*.ts      — чистая логика: argv, парсеры, валидация    │
│                              ▲ тестируется без DOM и сети           │
│                    lib/api/  — типизированные обёртки               │
└──────────┬──────────────────────────────────────▲───────────────────┘
           │ invoke(): ~90 команд                 │ emit(): события
┌──────────▼──────────────────────────────────────┴───────────────────┐
│  lib.rs — generate_handler!, AppState, bridge к сессиям             │
│      ├── доменные модули: servers · folders · sftp · localfile ·    │
│      │   recording · ai · git · container · kube · netprobe · …     │
│      └── AppState: sessions · local_ptys · cancels ·                │
│                    metrics_samples · pending_opens · id_names       │
└──────────┬──────────────────────────────────────────────────────────┘
           │
   SSH/SFTP к серверам пользователя (russh, в т.ч. через его proxy) ·
   локальный PTY · файловая система · OS keychain · LLM-эндпоинт пользователя
```

- **Команды** инкапсулированы в [src/lib/api/](../src/lib/api/) — UI не работает со
  строками-именами команд. Команда живёт в своём доменном модуле, `lib.rs` её только
  регистрирует; исключение — команды поверх общего `AppState` и приватные мосты
  (`session_arc`/`get_sftp`/`record_sftp`).
- **Модель данных** ([model.rs](../src-tauri/src/model.rs)) сериализуется через `serde` с
  `rename_all = "camelCase"` — зеркало в [types.ts](../src/lib/types.ts). Пароли в модели
  не хранятся: только в keychain ([secrets.rs](../src-tauri/src/secrets.rs)).
- **Ошибки** — `AppResult<T>`/`AppError` ([error.rs](../src-tauri/src/error.rs)),
  сериализуются в строку с маркерами (`auth-rejected`, `key-exists`, `dest-exists`).

---

## Каналы событий

Каналов пять, и новый заводится **только** под принципиально другой сорт данных — не под
новую стадию тех же (поэтому `term://phase` отдельно от `term://out`, а `ai://think` —
от `ai://out`).

| Канал | Кто эмитит | Что несёт |
|-------|-----------|-----------|
| `term://out\|closed\|phase/{id}` | [ssh.rs](../src-tauri/src/ssh.rs), [pty.rs](../src-tauri/src/pty.rs) | Поток PTY, закрытие сессии, **реальные** фазы подключения (`connecting`→`authenticating`→`session` + подстадии прокси) |
| `sftp://progress` | [sftp.rs](../src-tauri/src/sftp.rs), [sync.rs](../src-tauri/src/sync.rs) | Прогресс передачи по id переноса (у синхронизации id детерминированный — `sync:<путь>`) |
| `ai://out\|think\|done\|error/{id}` | [ai.rs](../src-tauri/src/ai.rs) | Токены ответа · рассуждение модели (отдельно, в `content` не попадает) · счёт токенов · ошибка |
| `menu://…` | нативное меню (Rust) | `about`/`help`/`manual`/`monitoring`/`settings` |
| `install://out` | [servertools.rs](../src-tauri/src/servertools.rs) | Вывод установки серверного инструмента (линтеры) |

---

## Фронтенд: слои

| Слой | Где | Правило |
|------|-----|---------|
| Оркестратор | [+page.svelte](../src/routes/+page.svelte) | Вкладки, доки, модалки, маршрутизация событий. Единственный, кто знает про всё сразу |
| Компоненты | `src/lib/*.svelte` (91) | Панели, модалки, примитивы (`Modal`, `ConfirmDialog`, `ContextMenu`, `PasswordInput`, `Icon`, `CopyButton`) |
| Состояние | `src/lib/stores/*.svelte.ts` | Руны: `tabs`, `layout`, `workspaces`, `aichat`, `broadcast`, `transfers`, `syncrun`, `recordings`, `toasts`, `hostenv`; настройки — [settings.svelte.ts](../src/lib/settings.svelte.ts) |
| Чистая логика | `src/lib/*.ts` (89) | Сборка argv, парсеры, валидация, раскладки. Без DOM и сети → тесты дешёвые |
| API | [src/lib/api/](../src/lib/api/) | `core`/`servers`/`session`/`files`/`git`/`container`/`kube`/`probe`/`recording`/`ai` + barrel |
| Действия | `src/lib/actions/` | `drag`, `tooltip`, `mdlinks`, `clipboardKeys` |
| i18n | [src/lib/i18n/](../src/lib/i18n/) | `locales` (реестр) · `messages` (`en` канонический) · `translate` (чистые resolve/interpolate) · `index` (`t()` реактивен от `settings.language`) |

Самые крупные компоненты — `+page.svelte` (2.6k строк, оркестратор), `FileBrowser` (общее
тело обеих файловых панелей), `MonitoringOverlay`, `Terminal`, `EditorTab`.

## Бэкенд: модули

| Модуль | Зона ответственности |
|--------|---------------------|
| [lib.rs](../src-tauri/src/lib.rs) | Регистрация команд, `AppState`, bridge к сессиям, команды поверх общего состояния |
| [ssh.rs](../src-tauri/src/ssh.rs) · [pty.rs](../src-tauri/src/pty.rs) | SSH-сессии (russh, proxy, keepalive, `exec_captured`) · локальный PTY |
| [sftp.rs](../src-tauri/src/sftp.rs) · [sync.rs](../src-tauri/src/sync.rs) | Файловые операции по SSH · синхронизация каталогов (SHA-256, dry-run, отмена) |
| [localfile.rs](../src-tauri/src/localfile.rs) · [drives.rs](../src-tauri/src/drives.rs) · [proccwd.rs](../src-tauri/src/proccwd.rs) | Локальная ФС · перечисление дисков Windows · чтение cwd процесса |
| [store.rs](../src-tauri/src/store.rs) · [secrets.rs](../src-tauri/src/secrets.rs) · [backup.rs](../src-tauri/src/backup.rs) | JSON-хранилище (атомарная запись, карантин) · keychain · экспорт/импорт настроек |
| [servers.rs](../src-tauri/src/servers.rs) · [folders.rs](../src-tauri/src/folders.rs) · [model.rs](../src-tauri/src/model.rs) | Профили, папки, DTO |
| [metrics/](../src-tauri/src/metrics/) | `mod.rs` — шелл-пробы по SSH; `local.rs` — нативный сбор через sysinfo |
| [recording.rs](../src-tauri/src/recording.rs) | Запись сессий (asciicast v2), маскирование ввода, экспорт |
| [ai.rs](../src-tauri/src/ai.rs) | Брокер LLM: стрим, два протокола, `ai_models` |
| [git.rs](../src-tauri/src/git.rs) · [container.rs](../src-tauri/src/container.rs) · [kube.rs](../src-tauri/src/kube.rs) · [netprobe.rs](../src-tauri/src/netprobe.rs) | Драйверы панелей — дамповые исполнители argv |
| [localenv.rs](../src-tauri/src/localenv.rs) | Реконструкция `PATH` для локального спавна (упакованное приложение наследует минимальный) |
| [keygen.rs](../src-tauri/src/keygen.rs) · [servertools.rs](../src-tauri/src/servertools.rs) · [textenc.rs](../src-tauri/src/textenc.rs) | Генерация SSH-ключей · серверные линтеры · определение и round-trip кодировок |
| [error.rs](../src-tauri/src/error.rs) | `AppResult`/`AppError` |

---

## Подсистемы

Что из чего собрано. Контракты («новый X подключай так же», «не дублируй») — в
[INVARIANTS.md](INVARIANTS.md); здесь только карта модулей.

| Подсистема | Бэкенд | Команды · каналы | UI | Чистая логика |
|-----------|--------|------------------|----|---------------|
| **Терминал** | `ssh.rs`, `pty.rs` | `connect_plan`/`connect_session`/`open_local_terminal`/`write_to_terminal`/`resize_pty`/`disconnect` · `term://` | `Terminal.svelte`, `ConnectingOverlay` | `connphase`, `ssherror`, `connlost`, `localshell`, `terminput`, `broadcast`, `termzoom`, `osc` |
| **Серверы и папки** | `servers.rs`, `folders.rs`, `store.rs`, `secrets.rs`, `backup.rs` | `list_servers`/`add_server`/…/`export_backup`/`import_backup` | `ServerTree`, `ServerFormModal`, `FolderModals`, `SecretPrompt` | `tree`, `serverform`, `servericons`, `notes`, `storewarn` |
| **SFTP и файлы** | `sftp.rs`, `sync.rs`, `localfile.rs`, `drives.rs` | `sftp_*`, `local_*`, `sftp_sync_apply`, `sftp_grep` · `sftp://progress` | `FileBrowser` + тонкие `SftpPanel`/`LocalFilePanel`, `SyncModal` | `filebrowser`, `fspath`, `sync`, `filekeys`, `filemove`, `multiselect`, `fileicon`, `lscolors`, `transfer`, `virtuallist` |
| **Редактор конфигов** | `sftp.rs`/`localfile.rs` (чтение-запись), `textenc.rs`, `servertools.rs` | `sftp_read_text`/`write_text`, `lint_remote`, `nginx_config_files`, `server_tools_status`, `run_tool_install` · `install://out` | `EditorTab`, `DiffModal` | `editorlang`, `remotelint`, `nginxmode`, `markdown`, `htmlsan`, `badge`, `mdimage`, `cmtheme`, `cspnonce`, `snippets` |
| **Мониторинг** | `metrics/mod.rs`, `metrics/local.rs` | `fetch_metrics`/`fetch_metrics_detail`/`fetch_pending_updates`/`fetch_extras` | `StatusBar`, `MonitoringOverlay`, `Chart`, `Sparkline`, `StackedBar` | `thresholds`, `hostcaps`, `monhealth`, `loadhistory`, `format` |
| **Запись сессий** | `recording.rs` | `start_recording`/`stop_recording`/`export_recording`/… | `RecordingsPanel`, плеер | `recording`, `recgroup`, `airunbook`, `aiscript` |
| **Логи и текст** | — (всё на фронте, поверх буфера xterm) | — | Переключатель Raw/Table, поиск по буферу, история | `jsonlog`, `highlight`, `search`, `history`, `command` |
| **Git · Docker · k8s · пробы** | `git.rs`, `container.rs`, `kube.rs`, `netprobe.rs` | `git_run`, `container_run`, `kubectl_run`, `probe_run`, `docker_login` | `GitPanel`, `DockerPanel`, `K8sPanel`, `UtilProbeRunner` | `git`, `gitview`, `docker`, `k8s`, `probe`, `tls`, `http` |
| **ИИ-ассистент** | `ai.rs` | `ai_chat`/`cancel_ai_chat`/`ai_models`/`ai_exec`/`set_ai_key` · `ai://` | `AiChat`, `AiConsentDialog`, `AiSettingsSection` | `ai`, `aicore`, `aiprompts`, `aipresets`, `aiexec`, `aicontext`, `aidialog`, `aimetrics`, `aierror`, `redact` |
| **Утилиты** | `keygen.rs`, `store.rs` (known_hosts) | `generate_ssh_key`, `list_known_hosts`, `remove_known_host` | `UtilitiesPanel` + `Util*.svelte` | `utilities`, `sshkeygen`, `knownhosts`, `codec`, `cidr`, `cron`, `jwt`, `pwgen`, `timeconv`, `wordlist` |
| **Оформление** | — | `set_menu_language` · `menu://` | `ThemeOverlay`, `IdleOverlay`, `AppLogo`, `SettingsPanel` | `themes`, `motion`, `idle`, `idlefx`, `icons`, `ctxmenu`, `settingsNav` |

---

## Структура каталогов

```
vterm/
├── src/                        # фронтенд (SvelteKit, SPA)
│   ├── routes/                 # +layout · +page.svelte (оркестратор)
│   ├── app.css                 # токены @theme, глобальные правила
│   ├── app.html                # первый кадр темы, style-nonce для CodeMirror
│   └── lib/
│       ├── *.svelte            # компоненты и панели (91)
│       ├── *.ts                # чистая логика (89) + тесты рядом
│       ├── api/                # типизированные обёртки invoke()
│       ├── stores/             # состояние в рунах
│       ├── actions/            # drag · tooltip · mdlinks · clipboardKeys
│       └── i18n/               # locales · messages · translate · index
├── src-tauri/
│   ├── src/                    # модули Rust (см. таблицу выше)
│   ├── capabilities/           # минимальные разрешения Tauri
│   ├── icons/                  # иконки бандла (статичные)
│   └── tauri.conf.json         # окно, бандл, строгий CSP
├── e2e/                        # WebdriverIO + tauri-driver (гоняет CI)
├── docs/                       # GUIDE · INSTALL · TROUBLESHOOTING · INVARIANTS ·
│                               # ARCHITECTURE · DESIGN · ROADMAP · TESTS · adr/
├── scripts/                    # open-on-mac · place-opener · clean-launchservices
├── .github/workflows/          # release.yml — сборка трёх ОС по тегу
└── .gitlab-ci.yml              # lint → security → test → build → release
```
