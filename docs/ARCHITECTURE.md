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
| Оболочка | **Tauri 2** | WebView + Rust-бэкенд; окно нативное на macOS, безрамочное со своим обрамлением на Windows/Linux (ADR 0011) |
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
│      │   recording · ai · git · container · kube · netprobe ·       │
│      │   netcheck · …                                               │
│      └── AppState: sessions · local_ptys · cancels ·                │
│                    metrics_samples · pending_opens · id_names       │
└──────────┬──────────────────────────────────────────────────────────┘
           │
   SSH/SFTP к серверам пользователя (russh, в т.ч. через его proxy) ·
   локальный PTY · файловая система · OS keychain · LLM-эндпоинт пользователя ·
   TCP-рукопожатие «Проверки доступа» с локальной вкладки (ADR 0012)
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

Новый канал заводится **только** под принципиально другой сорт данных — не под
новую стадию тех же (поэтому `term://phase` отдельно от `term://out`, а `ai://think` —
от `ai://out`).

Окон может быть несколько (ADR 0017), поэтому у события есть ещё и **адресат**. События с id
в имени (`term://…/{id}`, `ai://…/{id}`, `install://out/{id}`) идут всем: слушает их только тот,
у кого эта сессия или этот стрим. События без id идут **одному окну** (`emit_to`), и фронт
слушает их через `listenHere` — обычный `listen` слышит и то, что послано чужому окну.

| Канал | Кто эмитит | Что несёт |
|-------|-----------|-----------|
| `term://out\|closed/{id}` | [outgate.rs](../src-tauri/src/outgate.rs) — затвор вывода сессии; пишут в него [ssh.rs](../src-tauri/src/ssh.rs), [pty.rs](../src-tauri/src/pty.rs) и зеркало шагов ИИ | Поток PTY и закрытие сессии. На время передачи вкладки в другое окно затвор копит вывод вместо отправки |
| `term://phase/{id}` | [ssh.rs](../src-tauri/src/ssh.rs) | **Реальные** фазы подключения (`connecting`→`authenticating`→`session` + подстадии прокси) |
| `term://auth/{id}` | [kbdauth.rs](../src-tauri/src/kbdauth.rs) | Вопросы сервера при входе `keyboard-interactive`, на которые vterm не ответил сам (код, выбор Duo); ответ — команда `answer_auth_prompt` |
| `sftp://progress` | [sftp.rs](../src-tauri/src/sftp.rs), [sync.rs](../src-tauri/src/sync.rs) | Прогресс передачи по id переноса (у синхронизации id детерминированный — `sync:<путь>`). **Окну, запустившему перенос** (`WindowSink`) |
| `sync://scan` | [sync.rs](../src-tauri/src/sync.rs) | Сколько файлов уже прохэшировано при сравнении синхронизации (`{id, files}`, id = `<сравнение>:local`/`:remote`); счётчик без итога, поэтому не на `sftp://progress`. Окну, запустившему сравнение |
| `ai://out\|think\|done\|error/{id}` | [ai.rs](../src-tauri/src/ai.rs) | Токены ответа · рассуждение модели (отдельно, в `content` не попадает) · счёт токенов · ошибка |
| `menu://…` | нативное меню (Rust) | `about`/`help`/`manual`/`monitoring`/`settings` — **окну в фокусе**; `quit` — запрос выхода (меню, закрытие главного окна, выход от ОС), **главному окну**, отвечает `QuitDialog` |
| `vterm://open-file` | `lib.rs` (single-instance, `RunEvent::Opened`) | «Открыть с помощью vterm» — путь файла, **главному окну** |
| `window://…` | [appwin.rs](../src-tauri/src/appwin.rs), [store.rs](../src-tauri/src/store.rs), окна друг другу | То, о чём окна договариваются (ADR 0017, 0018): `close` — вопрос второму окну перед закрытием; `catalog` — список серверов или папок изменился на диске, всем; `settings` — снимок настроек от изменившего их окна, всем; `servers-deleted` — серверы удалены, их вкладки закрываются во всех окнах; `windows` — список окон, принимающих вкладки (метка, заголовок вкладки в фокусе, число вкладок), всем; `handoff` — открытому окну предлагают вкладку, только ему; `drag` — вкладку другого окна держат над этим (`over`), отпустили здесь (`drop`) или она ушла (`leave`), только ему |
| `install://out` | [servertools.rs](../src-tauri/src/servertools.rs) | Вывод установки серверного инструмента (линтеры) |

---

## Фронтенд: слои

| Слой | Где | Правило |
|------|-----|---------|
| Оркестратор | [+page.svelte](../src/routes/+page.svelte) | Вкладки, доки, модалки, маршрутизация событий. Единственный, кто знает про всё сразу |
| Компоненты | `src/lib/*.svelte` (106) | Панели, модалки, примитивы (`Modal`, `ConfirmDialog`, `ContextMenu`, `PasswordInput`, `Icon`, `CopyButton`) |
| Состояние | `src/lib/stores/*.svelte.ts` | Руны: `tabs` (список вкладок-сессий и раскладка центра: дерево областей и область в фокусе; «активная вкладка» — производная от неё; в центре только соединения), `tabdrag` (перетаскивание вкладки терминала: в полосу, в середину или на край области), `viewdrag` (перетаскивание вида внутри соединения — терминала или файла: в полосу зоны, на её середину или край; за пределы соединения вид не выносится), `tabrestore` (слот вкладок окна в `localStorage`: что вернуть после перезапуска — пишет каждое окно, читает главное), `layout` (раскладка доков: кто в каком доке, размеры, сворачивание — сохраняется), `dockdrag` (перетаскивание вкладки панели), `colwidths` (ширины колонок списков Docker и k8s — сохраняются), `panelsplit` (где стоит граница между двумя частями широкой панели — по одной на Git, Docker и k8s, сохраняется), `workspaces` (открытые в редакторе файлы по сессиям и раскладка зон соединения — терминал и файлы рядом; модель — `sessionviews.ts` поверх `splitlayout.ts`, ADR 0024), `aichat`, `broadcast`, `transfers`, `syncrun`, `syncjob` (синхронизация сессии: форма, план, сравнение/прогон — переживает закрытие окна), `recordings`, `toasts`, `hostenv`, `dockstate` (что панели доков помнят по `sessionId`: подвкладку и вид внутри неё, общий рабочий каталог дока, который читает git); настройки — [settings.svelte.ts](../src/lib/settings.svelte.ts) |
| Чистая логика | `src/lib/*.ts` (115) | Сборка argv, парсеры, валидация, раскладки. Без DOM и сети → тесты дешёвые |
| API | [src/lib/api/](../src/lib/api/) | `core`/`servers`/`session`/`files`/`git`/`container`/`kube`/`probe`/`recording`/`ai` + barrel |
| Действия | `src/lib/actions/` | `drag` (ресайз-ручка, `layoutBox`/`slotIndex` для перетаскивания вкладок, анимация `glide`), `tooltip`, `mdlinks`, `clipboardKeys` |
| i18n | [src/lib/i18n/](../src/lib/i18n/) | `locales` (реестр) · `messages` (`en` канонический) · `translate` (чистые resolve/interpolate) · `index` (`t()` реактивен от `settings.language`) |

Самые крупные компоненты — `+page.svelte` (3.0k строк, оркестратор), `FileBrowser` (общее
тело обеих файловых панелей), `MonitoringOverlay`, `Terminal`, `EditorTab`.

## Бэкенд: модули

| Модуль | Зона ответственности |
|--------|---------------------|
| [lib.rs](../src-tauri/src/lib.rs) | Регистрация команд, `AppState`, bridge к сессиям, команды поверх общего состояния |
| [ssh.rs](../src-tauri/src/ssh.rs) · [pty.rs](../src-tauri/src/pty.rs) | SSH-сессии (russh, proxy, keepalive, `exec_captured`) · локальный PTY |
| [outgate.rs](../src-tauri/src/outgate.rs) | Затвор вывода сессии: шлёт `term://out`/`closed` или копит байты, пока вкладка переезжает в другое окно; счёт отправленного, предел накопленного, откат (ADR 0017) |
| [appwin.rs](../src-tauri/src/appwin.rs) | Окна приложения: кто владеет сессией, подтверждение закрытия по окнам, передача вкладки новому или открытому окну (`detach_*` / `take_handoff` / `attach_session` / `decline_handoff`; область уходит повтором той же передачи — порядок и место вкладок решает фронт, `paneMoveOrder` в `tabhandoff.ts`, ADR 0023), список окон, принимающих вкладки (`announce_window`), сводка для диалога выхода, адресные события (`WindowSink`, `emit_to_focused`) (ADR 0017, 0018) |
| [dragghost.rs](../src-tauri/src/dragghost.rs) | Окно-метка перетаскиваемой вкладки над рабочим столом: маленькое окно без рамки поверх всего, без фокуса, мыши и прав; бэкенд держит его у указателя и задаёт вид `eval`-ом. Его страница — `static/ghost.html` + `ghost.css` + `ghost.js`, без инлайна (ADR 0018) |
| [winhit.rs](../src-tauri/src/winhit.rs) | Какое окно приложения под указателем мыши и где указатель внутри него — вопросом к оконной системе: macOS `windowNumberAtPoint` + часть окна, не закрытая заголовком (`contentLayoutRect`), Windows `WindowFromPoint` + `ScreenToClient`, Linux на X11 — GDK (`gdk_device_get_window_at_position`) + место WebView в окне по GTK; на Wayland ответа нет. Без расчёта по прямоугольникам (ADR 0018) |
| [kbdauth.rs](../src-tauri/src/kbdauth.rs) | Вход `keyboard-interactive`: кто отвечает на вопрос (`plan`/`after_first`), ожидание ответа пользователя (`PendingPrompts`, `answer_auth_prompt`) |
| [sftp.rs](../src-tauri/src/sftp.rs) · [sync.rs](../src-tauri/src/sync.rs) | Файловые операции по SSH · синхронизация каталогов (SHA-256, dry-run, отмена) |
| [localfile.rs](../src-tauri/src/localfile.rs) · [drives.rs](../src-tauri/src/drives.rs) · [proccwd.rs](../src-tauri/src/proccwd.rs) | Локальная ФС · перечисление дисков Windows · чтение cwd процесса |
| [store.rs](../src-tauri/src/store.rs) · [secrets.rs](../src-tauri/src/secrets.rs) · [backup.rs](../src-tauri/src/backup.rs) | JSON-хранилище (атомарная запись, карантин) · keychain · экспорт/импорт настроек |
| [servers.rs](../src-tauri/src/servers.rs) · [folders.rs](../src-tauri/src/folders.rs) · [model.rs](../src-tauri/src/model.rs) | Профили, папки, DTO |
| [metrics/](../src-tauri/src/metrics/) | `mod.rs` — шелл-пробы по SSH; `local.rs` — нативный сбор через sysinfo |
| [recording.rs](../src-tauri/src/recording.rs) | Запись сессий (asciicast v2), маскирование ввода, экспорт |
| [ai.rs](../src-tauri/src/ai.rs) | Брокер LLM: стрим, два протокола, `ai_models` |
| [git.rs](../src-tauri/src/git.rs) · [container.rs](../src-tauri/src/container.rs) · [kube.rs](../src-tauri/src/kube.rs) · [netprobe.rs](../src-tauri/src/netprobe.rs) | Драйверы панелей — дамповые исполнители argv |
| [netcheck.rs](../src-tauri/src/netcheck.rs) | «Проверка доступа» на локальной вкладке: нативное TCP-рукопожатие, тот же протокол ответа, что у SSH-скрипта (ADR 0012) |
| [localenv.rs](../src-tauri/src/localenv.rs) | Реконструкция `PATH` для локального спавна (упакованное приложение наследует минимальный) |
| [webview2.rs](../src-tauri/src/webview2.rs) | «Полный» portable Windows: хвост exe с WebView2 Fixed Version runtime, выбор системный/вшитый, атомарная распаковка до создания окна (ADR 0013); упаковка — [scripts/webview2-runtime.mjs](../scripts/webview2-runtime.mjs) |
| [keygen.rs](../src-tauri/src/keygen.rs) · [servertools.rs](../src-tauri/src/servertools.rs) · [textenc.rs](../src-tauri/src/textenc.rs) | Генерация SSH-ключей · серверные линтеры · определение и round-trip кодировок |
| [error.rs](../src-tauri/src/error.rs) | `AppResult`/`AppError` |

---

## Подсистемы

Что из чего собрано. Контракты («новый X подключай так же», «не дублируй») — в
[INVARIANTS.md](INVARIANTS.md); здесь только карта модулей.

| Подсистема | Бэкенд | Команды · каналы | UI | Чистая логика |
|-----------|--------|------------------|----|---------------|
| **Терминал** | `ssh.rs`, `kbdauth.rs`, `pty.rs`, `outgate.rs` | `connect_plan`/`connect_session`/`answer_auth_prompt`/`open_local_terminal`/`write_to_terminal`/`resize_pty`/`disconnect` · `term://` | `Terminal.svelte`, `ConnectingOverlay`, `AuthPromptDialog` (+ стор `stores/authprompt`) | `connphase`, `ssherror`, `connlost`, `localshell`, `terminput`, `termcmd`, `tabattach`, `broadcast`, `termzoom`, `osc` |
| **Серверы и папки** | `servers.rs`, `folders.rs`, `store.rs`, `secrets.rs`, `backup.rs` | `list_servers`/`add_server`/…/`export_backup`/`import_backup` | `ServerTree`, `ServerFormModal`, `FolderModals`, `SecretPrompt` | `tree`, `serverform`, `servericons`, `notes`, `storewarn` |
| **SFTP и файлы** | `sftp.rs`, `sync.rs`, `localfile.rs`, `drives.rs` | `sftp_*`, `local_*`, `sftp_sync_apply`, `sftp_grep` · `sftp://progress`, `sync://scan` | `FileBrowser` + тонкие `SftpPanel`/`LocalFilePanel`, `SyncModal` (+ `SyncRemotePicker`) | `filebrowser`, `fspath`, `sync`, `remotetree`, `filekeys`, `filemove`, `multiselect`, `fileicon`, `lscolors`, `transfer`, `virtuallist` |
| **Редактор конфигов** | `sftp.rs`/`localfile.rs` (чтение-запись), `textenc.rs`, `servertools.rs` | `sftp_read_text`/`write_text`, `lint_remote`, `nginx_config_files`, `server_tools_status`, `run_tool_install` · `install://out` | `EditorTab`, `DiffModal` | `editorlang`, `remotelint`, `nginxmode`, `markdown`, `htmlsan`, `badge`, `mdimage`, `cmtheme`, `cspnonce`, `snippets` |
| **Мониторинг** | `metrics/mod.rs`, `metrics/local.rs` | `fetch_metrics`/`fetch_metrics_detail`/`fetch_pending_updates`/`fetch_extras` | `StatusBar`, `MonitoringOverlay`, `Chart`, `Sparkline`, `StackedBar` | `thresholds`, `hostcaps`, `monhealth`, `loadhistory`, `format` |
| **Запись сессий** | `recording.rs` | `start_recording`/`stop_recording`/`export_recording`/… | `RecordingsPanel`, плеер | `recording`, `recgroup`, `airunbook`, `aiscript` |
| **Логи и текст** | — (всё на фронте, поверх буфера xterm) | — | Переключатель Raw/Table, поиск по буферу, история | `jsonlog`, `highlight`, `search`, `history`, `command` |
| **Git · Docker · k8s · пробы** | `git.rs`, `container.rs`, `kube.rs`, `netprobe.rs` | `git_run`, `container_run`, `kubectl_run`, `probe_run`, `docker_login`, `record_audit` | `GitPanel`, `DockerPanel` (сети — `DockerNetworks` + `DockerNetGraph`), `K8sPanel` (сеть — `K8sNetwork` + `K8sRouteView`), `UtilProbeRunner`; подробности и текст — `DockerDetail`/`DockerText`/`K8sDetail`/`K8sText`: окном (`*Modal`) в узком доке, в `SidePane` рядом со списком в широкой панели | `followcwd`, `git`, `gitview`, `docker`, `dockernet` (порты, членство в сетях, раскладка графа), `k8s`, `k8sroute` (маршрут ingress → сервис → эндпоинты), `probe`, `tls`, `http`, `panelwide` (порог широкого вида для решений, которые CSS принять не может; действие `actions/panelwide`) |
| **ИИ-ассистент** | `ai.rs` | `ai_chat`/`cancel_ai_chat`/`ai_models`/`ai_exec`/`set_ai_key` · `ai://` | `AiChat`, `AiConsentDialog`, `AiSettingsSection` | `ai`, `aicore`, `aiprompts`, `aipresets`, `aiexec`, `aicontext`, `aidialog`, `aimetrics`, `aierror`, `redact` |
| **Утилиты** | `keygen.rs`, `store.rs` (known_hosts), `netcheck.rs` | `generate_ssh_key`, `list_known_hosts`, `remove_known_host`, `netcheck_run` | `UtilitiesPanel` + `Util*.svelte` (`UtilNetCheck`) | `utilities`, `netcheck` (+ стор `stores/netcheck`), `sshkeygen`, `knownhosts`, `codec`, `cidr`, `cron`, `jwt`, `pwgen`, `timeconv`, `wordlist` |
| **Окна** | `appwin.rs`, `outgate.rs`, `winhit.rs`, `dragghost.rs` | `detach_begin`/`detach_commit`/`detach_abort` (окно, отдающее вкладку) · `take_handoff`/`attach_session`/`decline_handoff` (окно, принимающее её) · `announce_window` · `drag_over`/`drag_drop`/`drag_end` (вкладка над другим окном) · `close_window` · `report_window_summary`/`other_windows_summary` · `arm_close_guard`/`quit_app` · `window://`, `menu://quit` | Та же страница в каждом окне (`+page.svelte`); `QuitDialog` (выход и закрытие окна); в `Terminal.svelte` — снимок (`snapshot`) и приём сессии (`adopt`) | `appwindow` (роль окна по метке, другие окна и их имена), `tabhandoff` (пакет вкладки, `detachBlocker`, `moveOffered`, бросок за окно), `quitsummary` (`mergeQuitRows`) + `stores/tabpacket` (пакет из сторов и обратно), `stores/tabdrag` (бросок за окно; о перетаскиваемой вкладке говорится бэкенду по порядку, он отвечает, над каким она окном и рисует ли её окно-метка), `stores/tabincoming` (вкладка другого окна над этим: метка, место в полосе, подсветка), `splitlayout` (`placeTab`, `previewIncoming`), `api/window` (`listenHere`) |
| **Оформление** | — | `set_menu_language` · `menu://` | `ThemeOverlay`, `IdleOverlay`, `AppLogo`, `SettingsPanel`, `QuitDialog` | `themes`, `motion`, `idle`, `idlefx`, `icons`, `ctxmenu`, `settingsNav`, `quitsummary` |
| **Раскладка (центр)** | — (всё на фронте; вкладки и дерево областей — слот `vterm.tabs:<окно>` в `localStorage`, ADR 0019) | — | Области и их полосы вкладок рисует `+page.svelte` (сниппет `stripTabs`); терминалы — один плоский `{#each}`, поставленный по прямоугольникам областей; `SplitDivider` — разделитель двух половин сплита (мышь и клавиатура) | `splitlayout` (дерево областей: `addTab`/`removeTab`/`moveTab`/`splitWithTab`/`joinPanes`, прямоугольники `layoutRects` с минимумом области, зоны сброса `paneZone`/`applyDrop`, предпросмотр `previewTabs`, проверка `layoutProblems`, сохранённое дерево — `savedLayout`/`loadLayout`, сетка областей одной командой — `tileTabs`/`gridFit`), `tabrestore` (вкладки после перезапуска: запись вкладки без полей сессии, чтение слота, `waitReason` — кто открывает сессию сам, `waitView` — что написано на месте ждущей вкладки), `centerview` (что на экране: `onScreenSessions`, позиция области в CSS, чей вопрос о входе показать, какие записи на паузе), `appshortcuts` (хорды областей) + сторы `stores/tabs`, `stores/tabdrag`, `stores/tabrestore` |
| **Раскладка (доки)** | — (всё на фронте; `vterm.layout` в `localStorage`) | — | `Dock` (три экземпляра: левый, правый, нижний), `DockPanel` (выбор сессионной панели по id), `DockDragGhost`; панели приходят сниппетом `dockPanel` из `+page.svelte`. `ColumnHead` + `ColumnGrip` — заголовок колонки и её перетаскиваемая граница (ручка общая с таблицей логов); `PanelsSettings` — секция «Панели» настроек (скрытие панелей) | `docklayout` (модель: `loadDocks`, `movePanel`, `revealPanel`, `shownPanel`, предпросмотр перетаскивания `previewPanels`, скрытые панели), `dockui` (подписи вкладок, меню вкладки: перенос и скрытие), `colwidths` (ширины колонок: арифметика, санитайзер; ею же пользуется таблица логов) + сторы `stores/layout`, `stores/dockdrag`, `stores/colwidths` |
| **Оконное обрамление** | `lib.rs` `setup` (снятие декораций главного окна на non-macOS); вторые окна `appwin.rs` создаёт сразу без них | `core:window:*` (Tauri window API) | `TitleBar` (Win/Linux; macOS — нативное) | `windowchrome`, `hostenv` |

---

## Структура каталогов

```
vterm/
├── src/                        # фронтенд (SvelteKit, SPA)
│   ├── routes/                 # +layout · +page.svelte (оркестратор)
│   ├── app.css                 # токены @theme, глобальные правила
│   ├── app.html                # первый кадр темы, style-nonce для CodeMirror
│   └── lib/
│       ├── *.svelte            # компоненты и панели (111)
│       ├── *.ts                # чистая логика (117) + тесты рядом
│       ├── api/                # типизированные обёртки invoke()
│       ├── stores/             # состояние в рунах
│       ├── actions/            # drag · tooltip · mdlinks · clipboardKeys · panelwide
│       └── i18n/               # locales · messages · translate · index
├── src-tauri/
│   ├── src/                    # модули Rust (см. таблицу выше)
│   ├── capabilities/           # минимальные разрешения Tauri
│   ├── icons/                  # иконки бандла (статичные)
│   └── tauri.conf.json         # окно, бандл, строгий CSP
├── e2e/                        # WebdriverIO + tauri-driver (CI; на macOS — в Linux-контейнере:
│                               # linux/Dockerfile, `pnpm e2e:linux`); specs/ · support/
├── docs/                       # GUIDE · INSTALL · TROUBLESHOOTING · INVARIANTS ·
│                               # ARCHITECTURE · DESIGN · ROADMAP · TESTS · adr/
├── scripts/                    # open-on-mac · place-opener · clean-launchservices · make-icons ·
│                               # linux-box (команда в Linux-контейнере)
├── .github/workflows/          # release.yml — сборка трёх ОС по тегу
└── .gitlab-ci.yml              # lint → security → test → build → release
```
