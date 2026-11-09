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
| Фронтенд | **SvelteKit 3** (Svelte 5, runes), SPA через `adapter-static` | UI; конфигурация — в плагине Vite ([vite.config.js](../vite.config.js)), `svelte.config.js` нет (ADR 0046) |
| Стили | **Tailwind CSS v4** | Плагин Vite, без `tailwind.config.js`/PostCSS; токены — через `@theme` в [app.css](../src/app.css) |
| Сборка | **Vite 8** | Dev-сервер и бандл |
| Терминал | **xterm.js 6** + fit/webgl/search/web-links | ANSI, поиск по буферу, кликабельные ссылки |
| SSH | **russh 0.65** | Чистый Rust: пароль/ключ, PTY, shell, exec |
| Локальный PTY | **portable-pty 0.9** | forkpty (Unix) / ConPTY (Windows) |
| SFTP | **russh-sftp 3** | Поверх той же SSH-сессии |
| Редактор | **CodeMirror 6** | 50+ языков, линт, инлайн-diff (`unifiedMergeView`) |
| Секреты | **keyring 4** | Keychain (macOS) / Credential Manager (Windows) / Secret Service |
| Метрики (локально) | **sysinfo** | Нативный сбор без сети |
| Ключи | **ssh-key** + `rand` | Офлайн-генерация, без внешнего `ssh-keygen` |
| LLM | **reqwest** (rustls) | Только из Rust, только к эндпоинту пользователя |
| Тесты | **cargo test** · **Vitest 5** · **WebdriverIO** | Юнит / компонентные / E2E |

---

## Граница фронт/бэк

Главный принцип: **тяжёлая логика — в Rust, фронтенд — тонкий UI**. Граница проходит по
двум каналам Tauri: команды (`invoke`, запрос-ответ) и события (`emit`, поток от бэкенда).
Фронтенд **не делает сетевых вызовов вообще** — ни SSH, ни LLM, ни загрузки картинок; всё
исходящее идёт из Rust, поэтому CSP остаётся строгим (см. офлайн-инвариант).

Слои фронта, сверху вниз: страница → контроллеры `lib/page/` и компоненты → сторы →
`lib/api/`; чистые `.ts` стоят сбоку и ни от кого из них не зависят. Компоненты и чистая
логика лежат по папкам подсистем (`lib/terminal/`, `lib/files/`, …), слои — в своих папках
(ADR 0045). Направление импортов держит правило линтера `vterm/layers`
([lint/vterm.js](../lint/vterm.js)). Страница берёт модули `src/lib` через `#lib/…` — subpath
import из `package.json` с расширением файла (`#lib/stores/tabs.svelte.ts`, ADR 0046); внутри
`src/lib` пути относительные.

```
┌──────────────────────── WebView · фронтенд ─────────────────────────┐
│  routes/+page.svelte — оркестратор (вкладки, доки, модалки)         │
│      ├── lib/<подсистема>/*.svelte — компоненты и панели            │
│      ├── lib/stores/   — состояние в рунах (tabs, layout, …)        │
│      └── lib/<подсистема>/*.ts — чистая логика: argv, парсеры       │
│                              ▲ тестируется без DOM и сети           │
│                    lib/api/  — типизированные обёртки (нижний слой) │
└──────────┬──────────────────────────────────────▲───────────────────┘
           │ invoke(): ~90 команд                 │ emit(): события
┌──────────▼──────────────────────────────────────┴───────────────────┐
│  lib.rs — generate_handler!, AppState, общие мосты к сессиям        │
│      ├── commands/: bridge-слой — команды поверх AppState по доменам│
│      ├── доменные модули: servers · folders · sftp · localfile ·    │
│      │   recording · ai · git · container · kube · netprobe ·       │
│      │   netcheck · …                                               │
│      └── AppState: sessions · local_ptys · cancels ·                │
│                    metrics_samples · pending_opens · id_names       │
└──────────┬──────────────────────────────────────────────────────────┘
           │
   SSH/SFTP к серверам пользователя (russh, в т.ч. через его proxy) ·
   локальный PTY · файловая система · OS keychain · LLM-эндпоинт пользователя ·
   TCP-рукопожатие «Проверки доступа» с локальной вкладки (ADR 0012) или
   bash/nc/telnet/curl пользователя по его выбору (ADR 0033)
```

- **Команды** инкапсулированы в [src/lib/api/](../src/lib/api/) — UI не работает со
  строками-именами команд. Команда живёт в своём доменном модуле, `lib.rs` её только
  регистрирует; исключение — команды поверх общего `AppState` и приватные мосты
  (`get_sftp`/`record_sftp`/`run_driver`): bridge-слой в [commands/](../src-tauri/src/commands/).
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
| `sftp://progress` | [sftp.rs](../src-tauri/src/sftp.rs), [sync.rs](../src-tauri/src/sync.rs) | Прогресс одного файла прогона синхронизации (id детерминированный — `sync:<путь>`). **Окну, которое показывает вкладку сессии на момент события** (`WindowSink::following`, ADR 0058) |
| `sftp://job` | [transfers.rs](../src-tauri/src/transfers.rs) | Состояние задания переноса: стороны, текущий файл, сколько файлов и байт, чем кончилось (ADR 0025). **Окну, которое показывает вкладку сессии задания сейчас**; двум окнам — обоим |
| `sync://run` | [sync.rs](../src-tauri/src/sync.rs) | Как идёт прогон синхронизации: идёт, готово, остановлен, сорвался (`RunView`) — окну вкладки сессии на момент события; последнее — `sync_run_of` (ADR 0058) |
| `sync://scan` | [sync.rs](../src-tauri/src/sync.rs) | Сколько файлов уже прохэшировано при сравнении синхронизации (`{id, files}`, id = `<сравнение>:local`/`:remote`); счётчик без итога, поэтому не на `sftp://progress`. Окну, запустившему сравнение |
| `ai://out\|think\|done\|error/{id}` | [ai.rs](../src-tauri/src/ai.rs) | Токены ответа · рассуждение модели (отдельно, в `content` не попадает) · счёт токенов · ошибка |
| `menu://…` | нативное меню (Rust) | `about`/`help`/`manual`/`monitoring`/`settings` — **окну в фокусе**; `quit` — запрос выхода (меню, закрытие главного окна, выход от ОС), **главному окну**, отвечает `QuitDialog` |
| `vterm://open-file` | `lib.rs` (single-instance, `RunEvent::Opened`) | «Открыть с помощью vterm» — путь файла, **главному окну** |
| `window://…` | [appwin.rs](../src-tauri/src/appwin.rs), [store.rs](../src-tauri/src/store.rs), окна друг другу | То, о чём окна договариваются (ADR 0017, 0018): `targets` — куда в каждом окне можно скопировать файл, всем (ADR 0026); `close` — вопрос второму окну перед закрытием; `catalog` — список серверов или папок изменился на диске, всем; `settings` — снимок настроек от изменившего их окна, всем; `servers-deleted` — серверы удалены, их вкладки закрываются во всех окнах; `windows` — список окон, принимающих вкладки (метка, заголовок вкладки в фокусе, число вкладок), всем; `handoff` — открытому окну предлагают вкладку, только ему; `drag` — вкладку другого окна держат над этим (`over`), отпустили здесь (`drop`) или она ушла (`leave`), только ему |
| `install://out` | [servertools.rs](../src-tauri/src/servertools.rs) | Вывод установки серверного инструмента (линтеры) |

---

## Фронтенд: слои

| Слой | Где | Правило |
|------|-----|---------|
| Оркестратор | [+page.svelte](../src/routes/+page.svelte) | Вкладки, доки, модалки, маршрутизация событий. Единственный, кто знает про всё сразу |
| Контроллеры страницы | [src/lib/page/](../src/lib/page/) | `uiscaleflow` (шаг масштаба интерфейса по клавише и из ⌘K), `recordingflow` (запись: REC вкладки и группы, автозапись прода, пауза того, что не на экране или простаивает, вопрос после остановки), `copyflow` (копия в другую сессию: куда можно, рассылка другим окнам, вопрос о папке), `pathsyncflow` (синхронизация пути: кто следует за терминалом, команда настройки шелла, вопрос сервера, подключение и конец сессии), `filelinkflow` (файлы из вывода терминала: клик, вопрос, открытие в редакторе или панели файлов), `restoreflow` (вкладки прошлого запуска: восстановление по политике `waitReason`, кнопка ждущей вкладки, «подключить все»), `editorflow` (редактор конфигов: открытие, запись, sudo, diff перед сохранением, конфликт, вопрос при закрытии), `filedragflow` (перетаскивание файлов: что значит бросок, файлы с рабочего стола и из других окон, вынос в систему), `windowflow` (вкладки и области между окнами: передача, бросок за окно, приём, перенос области целиком). Состояние страницы получают геттерами; своё отдают только для чтения |
| Компоненты | `src/lib/<подсистема>/*.svelte` | Панели и модалки — в папке своей подсистемы; общие примитивы (`Modal`, `ConfirmDialog`, `ContextMenu`, `PasswordInput`, `Icon`, `CopyButton`) — в `ui/`, там же строка фильтра списков `ListHeader` с полем `FilterField`, заголовок группы `GroupHeader` и `FilteredEmpty` (ADR 0050), лог с инструментами `LogTail` и полоса «Требует внимания» `AttentionStrip` (ADR 0054) |
| Состояние | `src/lib/stores/*.svelte.ts` | Руны: `tabs` (список вкладок-сессий и раскладка центра: дерево областей и область в фокусе; «активная вкладка» — производная от неё; в центре только соединения), `tabdrag` (перетаскивание вкладки терминала: в полосу, в середину или на край области), `viewdrag` (перетаскивание вида внутри соединения — терминала или файла: в полосу зоны, на её середину или край; за пределы соединения вид не выносится), `tabrestore` (слот вкладок окна в `localStorage`: что вернуть после перезапуска — пишет каждое окно, читает главное; с вкладкой — каталог её оболочки, док и файлы), `layout` (раскладка доков: кто в каком доке, размеры, сворачивание — сохраняется), `dockdrag` (перетаскивание вкладки панели), `topbarpins` (список кнопок верхней панели — единственный, кто присваивает `settings.topbar`, ADR 0029), `topbardrag` (перетаскивание кнопки верхней панели: предпросмотр порядка, перенос при отпускании), `colwidths` (ширины колонок списков Docker и k8s и колонки, которые пользователь убрал из таблицы, — сохраняются), `panelsplit` (где стоит граница между двумя частями широкой панели — по одной на границу: две у Git, по одной у Docker, k8s и файловой панели; сохраняется), `listview` (порядок и группировка каждого списка — на приложение, по списку, сохраняется; фильтр списка — по сессии в `dockstate`), `workspaces` (открытые в редакторе файлы по сессиям и раскладка зон соединения — терминал и файлы рядом; модель — `sessionviews.ts` поверх `splitlayout.ts`, ADR 0024), `aichat`, `broadcast`, `metricsfeed` (один опрос базовых метрик на сессию: последний замер, история по номерам опросов, отметка «не ответил»; бар, мониторинг и заставка — его наблюдатели, ADR 0053), `transfers` (что окно показывает из заданий переноса своих сессий — вид, а не хозяин: ADR 0025), `replaceask` (очередь вопросов «заменить файлы?», один диалог на окно), `linkopen` (клик по ссылке в выводе терминала: спросить или открыть; один вопрос на окно — `LinkOpenDialog`), `filecopy` (куда можно скопировать файл и что выделено в панели — мост между файловыми панелями и страницей; запрос перемещения внутри панели), `filedrag` (перетаскивание файлов: своё, из другого окна и с рабочего стола; цель под указателем, раскрытие вкладки по удержанию — ADR 0026; у края окна отдаёт жест системе — ADR 0027), `syncrun`, `syncjob` (синхронизация сессии: форма, план, сравнение/прогон — переживает закрытие окна), `recordings`, `toasts`, `hostenv`, `dockstate` (что панели доков помнят по `sessionId`: подвкладку и вид внутри неё, общий рабочий каталог дока, который читает git; папку, которую панель файлов должна открыть по клику в выводе терминала; фильтр и свёрнутые группы каждого списка; что открыто рядом со списком Docker и k8s и как читается его лог; поиск по файлам с ответом); настройки — [settings.svelte.ts](../src/lib/settings/settings.svelte.ts) |
| Чистая логика | `src/lib/<подсистема>/*.ts` | Сборка argv, парсеры, валидация, раскладки — рядом с компонентами своей подсистемы. Без DOM и сети → тесты дешёвые; общие мелочи — `ui/util`; модель фильтра, групп и порядка любого списка — `ui/listview` (слова её меню — `ui/listtext`), схема списка — в `.ts` его подсистемы; укладка пустого состояния — `ui/emptytier`, общая модель плавной укладки и её доводки — `ui/fluidfit`; какие колонки таблицы списка помещаются в его ширину — `ui/colfit`, разбор строк лога — `ui/loglines`, выбор нескольких строк — `ui/listselect` (ADR 0054); зеркало моделей Rust — `types.ts`, единственный файл в корне `src/lib` |
| API | [src/lib/api/](../src/lib/api/) | `core`/`servers`/`session`/`files`/`git`/`container`/`kube`/`probe`/`recording`/`ai`/`updater`/`window` + barrel |
| Действия | `src/lib/actions/` | `drag` (ресайз-ручка, `layoutBox`/`slotIndex` для перетаскивания вкладок, анимация `glide`), `tooltip`, `mdlinks`, `clipboardKeys`, `emptyfit` (кружок, линии и отступы пустого состояния по его высоте), `connfit` (экран подключения по его высоте), `fluidglide` (всё движение от размера: доводка обоих, ряды с «⋯», часть рядом со списком, порог ширины, сетки; только `transform`/`opacity`) |
| i18n | [src/lib/i18n/](../src/lib/i18n/) | `locales` (реестр) · `en`/`ru` (словарь на язык, `en` канонический) · `messages` (сборка словарей) · `translate` (чистые resolve/interpolate) · `index` (`t()` реактивен от `settings.language`) |

Самые крупные компоненты — `+page.svelte` (3.0k строк, оркестратор), `FileBrowser` (общее
тело обеих файловых панелей), `MonitoringOverlay`, `Terminal`, `EditorTab`.

## Бэкенд: модули

| Модуль | Зона ответственности |
|--------|---------------------|
| [lib.rs](../src-tauri/src/lib.rs) | Регистрация команд (`generate_handler!`), `AppState`, общие мосты к сессиям (`session_arc`, `end_session`, `register_cancel`), запуск приложения |
| [commands/](../src-tauri/src/commands/) | Bridge-слой — команды поверх общего `AppState` по доменам: `session` (SSH, локальный шелл, ввод, cwd), `sftp` (файлы, синхронизация, поиск, задания переноса), `drivers` (git/docker/kubectl/пробы/проверка доступа — один диспетчер по транспорту), `recording`, `backup`, `ai` (ключи, `ai_exec`), `chrome` (меню macOS, буфер обмена, «Открыть с помощью»). `BRIDGE` — список файлов для гейтов |
| [exec.rs](../src-tauri/src/exec.rs) · [locks.rs](../src-tauri/src/locks.rs) | Общее исполнение драйверов: `ExecOutput`, команда для SSH, локальный запуск, строка аудита · `.locked()` — блокировка, переживающая панику |
| [ssh.rs](../src-tauri/src/ssh.rs) · [pty.rs](../src-tauri/src/pty.rs) | SSH-сессии (russh, proxy, keepalive, `exec_captured`) · локальный PTY |
| [outgate.rs](../src-tauri/src/outgate.rs) | Затвор вывода сессии: шлёт `term://out`/`closed` или копит байты, пока вкладка переезжает в другое окно; счёт отправленного, предел накопленного, откат (ADR 0017) |
| [appwin.rs](../src-tauri/src/appwin.rs) | Окна приложения: кто владеет сессией, подтверждение закрытия по окнам, передача вкладки новому или открытому окну (`detach_*` / `take_handoff` / `attach_session` / `decline_handoff`; окна прошлого запуска — `reopen_windows` / `take_restore`, места окон — при `quit_app` и `place_main`, подгонка под мониторы — [winplace.rs](../src-tauri/src/winplace.rs), ADR 0057; область уходит повтором той же передачи — порядок и место вкладок решает фронт, `paneMoveOrder` в `tabhandoff.ts`, ADR 0023), список окон, принимающих вкладки (`announce_window`), сводка для диалога выхода, адресные события (`WindowSink`, `emit_to_focused`) (ADR 0017, 0018) |
| [dragghost.rs](../src-tauri/src/dragghost.rs) | Окно-метка перетаскиваемой вкладки над рабочим столом: маленькое окно без рамки поверх всего, без фокуса, мыши и прав; бэкенд держит его у указателя и задаёт вид `eval`-ом. Его страница — `static/ghost.html` + `ghost.css` + `ghost.js`, без инлайна (ADR 0018) |
| [dragout.rs](../src-tauri/src/dragout.rs) · [dragout/](../src-tauri/src/dragout/) | Вынос файла в систему — на рабочий стол, в папку (ADR 0027, 0059): что можно обещать и под каким именем, обход папки сервера для Проводника (`survey`/`flatten`), проверка файлов этой машины (`local_items`), команда `drag_out_begin` с причиной отказа. `macos.rs` — сессия перетаскивания с `NSFilePromiseProvider` (файл этой машины — `NSURL`), обещание исполняет задание реестра переносов. `windows.rs` — три COM-объекта (объект данных, поток, источник) вокруг `feed.rs`. `feed.rs` — всё, что они делают, без COM: файл сервера как блокирующий поток, раскладки `FILEGROUPDESCRIPTORW` и `DROPFILES`; собирается и тестируется на любой ОС |
| [aigate.rs](../src-tauri/src/aigate.rs) | Затвор ответа ИИ (ADR 0058): куски стрима `ai://…` — через него; передача вкладки придерживает ответ её сессии вместе с выводом терминала и отдаёт принявшему окну |
| [winplace.rs](../src-tauri/src/winplace.rs) | Места окон (ADR 0057): что пишется при выходе (угол, размер, «развёрнуто» — в физических пикселях, `windows.json` через `store`), подгонка под мониторы, какие есть сейчас (`fit`: заголовок вне всех мониторов — в середину первого, размер — не больше монитора), применение к окну до показа |
| [tabcontent.rs](../src-tauri/src/tabcontent.rs) | Вывод и диалог вкладки после перезапуска — только под `restoreOutput` (ADR 0057): файл на вкладку в `data_dir/tabs/` (`0600`, атомарно, не больше 16 МБ), имя — проверенный id сессии; что писать и когда, решает фронт |
| [winhit.rs](../src-tauri/src/winhit.rs) | Какое окно приложения под указателем мыши и где указатель внутри него — вопросом к оконной системе: macOS `windowNumberAtPoint` + часть окна, не закрытая заголовком (`contentLayoutRect`), Windows `WindowFromPoint` + `ScreenToClient`, Linux на X11 — GDK (`gdk_device_get_window_at_position`) + место WebView в окне по GTK; на Wayland ответа нет. Без расчёта по прямоугольникам (ADR 0018) |
| [kbdauth.rs](../src-tauri/src/kbdauth.rs) | Вход `keyboard-interactive`: кто отвечает на вопрос (`plan`/`after_first`), ожидание ответа пользователя (`PendingPrompts`, `answer_auth_prompt`) |
| [sftp.rs](../src-tauri/src/sftp.rs) · [sync.rs](../src-tauri/src/sync.rs) | Файловые операции по SSH, перенос одного файла через временный сосед (в т.ч. с сервера на сервер) · синхронизация каталогов (SHA-256, dry-run, отмена) |
| [fileuser.rs](../src-tauri/src/fileuser.rs) | Кто сейчас в терминале (дерево процессов на сервере) и панель файлов под этим пользователем: `sftp-server` через sudo (ADR 0047) |
| [transfers.rs](../src-tauri/src/transfers.rs) | Реестр заданий переноса (ADR 0025): загрузка, скачивание, копия между сессиями, локальная копия — один цикл; кому говорить о задании; строка для записи сессии |
| [localfile.rs](../src-tauri/src/localfile.rs) · [drives.rs](../src-tauri/src/drives.rs) · [proccwd.rs](../src-tauri/src/proccwd.rs) | Локальная ФС · перечисление дисков Windows · чтение cwd процесса |
| [store.rs](../src-tauri/src/store.rs) · [secrets.rs](../src-tauri/src/secrets.rs) · [backup.rs](../src-tauri/src/backup.rs) | JSON-хранилище (атомарная запись, карантин) · keychain · экспорт/импорт настроек |
| [servers.rs](../src-tauri/src/servers.rs) · [folders.rs](../src-tauri/src/folders.rs) · [model.rs](../src-tauri/src/model.rs) | Профили, папки, DTO |
| [metrics/](../src-tauri/src/metrics/) | `mod.rs` — шелл-пробы по SSH; `local.rs` — нативный сбор через sysinfo |
| [recording.rs](../src-tauri/src/recording.rs) | Запись сессий (asciicast v2), маскирование ввода, экспорт |
| [ai.rs](../src-tauri/src/ai.rs) | Брокер LLM: стрим, два протокола, `ai_models` |
| [git.rs](../src-tauri/src/git.rs) · [container.rs](../src-tauri/src/container.rs) · [kube.rs](../src-tauri/src/kube.rs) · [netprobe.rs](../src-tauri/src/netprobe.rs) | Драйверы панелей — дамповые исполнители argv; политика argv каждого драйвера (`check_args`) — граница WebView (ADR 0036) |
| [netcheck.rs](../src-tauri/src/netcheck.rs) | «Проверка доступа» на локальной вкладке: нативное TCP-рукопожатие или инструмент пользователя (`LocalTool`: argv зашит здесь, ожидание ограничивает приложение), тот же протокол ответа, что у SSH-скрипта, остановка по флагу из общей карты отмен (ADR 0012, 0032, 0033) |
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
| **Терминал** | `ssh.rs`, `kbdauth.rs`, `pty.rs`, `outgate.rs` | `connect_plan`/`connect_session`/`answer_auth_prompt`/`open_local_terminal`/`write_to_terminal`/`resize_pty`/`disconnect`/`watch_local_submits`/`local_submitted_cwd` · `term://` | `Terminal.svelte`, `TerminalPasteDialog`, `LinkOpenDialog` (+ стор `stores/linkopen`), `FileLinkDialog`, `ConnectingOverlay`, `AuthPromptDialog` (+ стор `stores/authprompt`) | `connphase`, `ssherror`, `connlost`, `localshell`, `terminput`, `termpaste`, `termlink` (что делает клик по ссылке, хост и адрес для вопроса), `urllinks` (адреса в выводе, нелатинский домен тоже, и их провайдер xterm), `termfiles` (файлы в выводе: кандидаты строки, место в файле, подтверждение по листингу, команда листинга и заголовки, решение клика — ADR 0035), `filelinkprovider` (сторона xterm: блоки команд с их каталогом, кэш листингов, клик), `termcmd`, `tabattach`, `broadcast`, `termzoom`, `osc`, `termwrite` (ввод в сессию строго по порядку), `termmouse` (что делают ПКМ и Ctrl+V), `sessionbar` (панель сессии над терминалом), `clipboard` (буфер обмена через бэкенд) |
| **Серверы и папки** | `servers.rs`, `folders.rs`, `store.rs`, `secrets.rs`, `backup.rs` | `list_servers`/`add_server`/…/`set_server_path_sync`/`export_backup`/`read_backup`/`import_backup` | `ServerTree`, `ServerFormModal`, `FolderModals`, `SecretPrompt`, `BackupImportDialog` (предпросмотр импорта) | `tree`, `serverform`, `servericons`, `notes`, `storewarn`, `backupimport` (замена логинов и путей, «добавить к моим») |
| **SFTP и файлы** | `sftp.rs`, `sync.rs`, `localfile.rs`, `drives.rs`, `fileuser.rs` | `sftp_*`, `shell_user`, `local_*` (в т.ч. `local_kinds`), `transfer_start`/`transfer_list`, `sftp_sync_start`/`sync_run_of`, `sftp_grep` · `sftp://job`, `sftp://progress`, `sync://run`, `sync://scan` | `FileBrowser` + тонкие `SftpPanel`/`LocalFilePanel`, `SortTitle` (название колонки, по которой сортируют), `GrepResults` (результаты поиска по содержимому — под полем поиска или в панели рядом со списком), `SyncModal` (+ `SyncRemotePicker`), `CopyToDialog`, `ReplaceDialog`, `FileDragGhost` | `filebrowser`, `fspath`, `sync`, `remotetree`, `filekeys`, `filemove`, `multiselect`, `fileicon`, `lscolors`, `transfer`, `transferflow`, `copyto`, `filedrop`, `virtuallist`, `filesort` (порядок листинга и его схема списка), `grepview` (группы по файлам, подсветка найденного), `cdterminal` (строка `cd` под запущенную оболочку для следования за терминалом) |
| **Редактор конфигов** | `sftp.rs`/`localfile.rs` (чтение-запись, локальная копия), `sync.rs` (sudo), `textenc.rs`, `servertools.rs` | `sftp_read_text`/`write_text`, `sftp_write_access`, `sftp_check_sudo`, `save_editor_copy`, `lint_remote`, `nginx_config_files`, `server_tools_status`, `run_tool_install` · `install://out` | `EditorTab`, `DiffModal` | `editorlang`, `remotelint`, `nginxmode`, `markdown`, `htmlsan`, `badge`, `mdimage`, `cmtheme`, `cspnonce`, `snippets`, `editorplace` (столбец места `x.c:42:5`); грамматики по требованию — `editorlangs` (`import()` на язык) |
| **Мониторинг** | `metrics/mod.rs`, `metrics/local.rs` | `fetch_metrics`/`fetch_metrics_detail`/`fetch_pending_updates`/`fetch_extras`/`fetch_live_extras`/`fetch_process_detail` | `StatusBar` (сводка: вердикт, группы с «⋯», чип проблем, плитка по наведению — ADR 0053), `MonitoringOverlay` (навигация по разделам) и разделы `Mon*` (`MonOverview`, `MonCpu`, `MonMemory`, `MonDisks`, `MonNetwork`, `MonTemperature`, `MonProcesses`, `MonContainers`, `MonGpu`, `MonSystem`), `Chart`, `TweenNumber`, `Meter`, `StackedBar`, `MonCard`, `MonHeader` (с проблемами раздела), `MonProblemRow`, `Sparkline` | `barmodel` (статус-бар: порядок и приоритет групп, укладка `fitBar`, раздел по клику, плитки, чип), `monproblems` (проблемы и уровни разделов), `monsections` (разделы и значения навигации), `monhistory` (история замеров), `chartgeom` (геометрия графиков), `proclist` (список процессов: схема, дерево), `monpalette`, `thresholds`, `hostcaps`, `monhealth` (уровни и границы load — `loadZones`), `loadhistory`, `format`; плавность — `ui/tween` (общая с заставкой, у бара — `STATUS_MS`); замеры — стор `stores/metricsfeed` |
| **Запись сессий** | `recording.rs` | `start_recording`/`stop_recording`/`export_recording`/… | `RecordingsPanel`, плеер | `recording`, `recgroup`, `airunbook`, `aiscript` |
| **Логи и текст** | — (всё на фронте, поверх буфера xterm) | — | Переключатель Raw/Table, поиск по буферу, история | `jsonlog`, `highlight`, `search`, `history`, `command` |
| **Git · Docker · k8s · пробы** | `commands/drivers.rs` → `exec.rs`; политики `git.rs`, `container.rs`, `kube.rs`, `netprobe.rs` | `git_run`, `container_run`, `kubectl_run`, `probe_run`, `docker_login`, `record_audit` | `GitPanel`, `PathSyncDialog` (как включать синхронизацию пути на этом сервере — ADR 0034), `DockerPanel` (сети — `DockerNetworks` + `DockerNetGraph`, сколько занято — `DockerDiskUsage`; «Ресурсы» подробностей — общий `Chart` мониторинга; колонка имён — `DockerTreeSections`, подробности образа, сети и тома — `DockerImageDetail`/`DockerNetworkDetail`/`DockerVolumeDetail` поверх `dockeritems`, стека — `DockerStackDetail`; в узкой панели — окном `DockerItemModal`), `K8sPanel` (сеть — `K8sNetwork` + `K8sRouteView`), `UtilProbeRunner`; подробности и текст — `DockerDetail`/`DockerText`/`K8sDetail`/`K8sText`: окном (`*Modal`) в узком доке, в `SidePane` рядом со списком в широкой панели; подробности коммита — `GitCommitDetail`: в `SidePane` рядом с историей или полоской под ней; поиск — `GitLogFilter`, метка — `GitRefChip` | `followcwd`, `shellintegration`, `pathsync` (режим синхронизации пути сервера: спрашивать / всегда / вручную), `git`, `gitview`, `gitlanes` (полосы и цвета истории, форма линии), `gitrefs` (метки коммита, дерево веток), `docker`, `dockernet` (порты, членство в сетях, раскладка топологии), `dockeritems` (подробности образа, сети, тома), `dockerstack` (стек compose: сервисы, действия, конфигурация), `k8s`, `k8sroute` (маршрут ingress → сервис → эндпоинты), `probe`, `tls`, `http`, `panelwide` (порог широкого вида для решений, которые CSS принять не может; действие `actions/panelwide`), `age` (возраст в строке списка — один формат на все панели) |
| **ИИ-ассистент** | `ai.rs` | `ai_chat`/`cancel_ai_chat`/`ai_models`/`ai_exec`/`set_ai_key` · `ai://` | `AiChat`, `AiConsentDialog`, `AiSettingsSection` | `ai`, `aicore`, `aiprompts`, `aipresets`, `aiexec`, `aicontext`, `aidialog`, `aimetrics`, `aierror`, `redact`, `aiask` (вопросы «спросить про…» и когда чат может начать ход) |
| **Утилиты** | `keygen.rs`, `store.rs` (known_hosts), `netcheck.rs` | `generate_ssh_key`, `list_known_hosts`, `remove_known_host`, `netcheck_run` | `UtilitiesPanel` + `Util*.svelte` (`UtilNetCheck` → `NetCheckHosts`, `NetCheckRuleTable`, `NetCheckMatrix`) | `utilities`, `netcheck`, `netcheckpaste` (разбор заявки), `netcheckform` (строки таблицы), `netroute` (источник → сервер, план, матрица), `netcheckwords` (+ стор `stores/netcheck`: правила и прогон по хосту вкладки), `sshkeygen`, `knownhosts`, `codec`, `cidr`, `cron`, `jwt`, `pwgen`, `timeconv`, `wordlist` |
| **Окна** | `appwin.rs`, `outgate.rs`, `winhit.rs`, `dragghost.rs` | `detach_begin`/`detach_commit`/`detach_abort` (окно, отдающее вкладку) · `take_handoff`/`attach_session`/`decline_handoff` (окно, принимающее её) · `announce_window` · `announce_copy_targets` (куда в этом окне можно скопировать файл) · `drag_over`/`drag_drop`/`drag_end` (вкладка или файлы над другим окном) · `drag_out_begin` (файлы — системе, ответ — взяла или почему нет; дальше окнам о них говорит бэкенд) · `close_window` · `report_window_summary`/`other_windows_summary` · `detach_begin` придерживает и ответ ИИ (`aigate`) · `arm_close_guard`/`quit_app` (места окон — `windows.json`) · `reopen_windows`/`take_restore` (окна прошлого запуска, ADR 0057) · `window://`, `menu://quit` | Та же страница в каждом окне (`+page.svelte`); `QuitDialog` (выход и закрытие окна); в `Terminal.svelte` — снимок (`snapshot`) и приём сессии (`adopt`) | `appwindow` (роль окна по метке, другие окна и их имена), `tabhandoff` (пакет вкладки, `detachBlocker`, `moveOffered`, бросок за окно), `quitsummary` (`mergeQuitRows`) + `stores/tabpacket` (пакет из сторов и обратно), `stores/tabdrag` (бросок за окно; о перетаскиваемой вкладке говорится бэкенду по порядку, он отвечает, над каким она окном и рисует ли её окно-метка), `stores/tabincoming` (вкладка другого окна над этим: метка, место в полосе, подсветка), `dragout` (что можно отдать системе и что ей отдаётся), `splitlayout` (`placeTab`, `previewIncoming`), `api/window` (`listenHere`) |
| **Оформление** | — | `set_menu_language` · `menu://` | `ThemeOverlay`, `IdleOverlay`, `AppLogo`, `SettingsPanel`, `QuitDialog`, `TopBar` (кнопки — список пользователя, раздел настроек — `TopbarSettings`; убранные действия сессии — группой в `UtilitiesPanel`, карточка `UtilSessionAction`) | `themes`, `motion`, `idle`, `idlefx`, `standby` (экран ожидания: история простоя и её события, точка под указателем, часы сервера, перенос на заставке, сдвиг против выгорания), `tween` (значения заставки доходят до замера плавно), `icons`, `ctxmenu`, `settingsNav`, `quitsummary`, `topbaractions` (какие кнопки есть, что панель показывает и что помещается), `topbarui` (подписи, иконки, меню панели), `sessionactions` (действия сессии как строки окна «Утилиты»: что запускает кнопка и почему она выключена), `colormix` (смешение цветов и читаемость на фоне), `prodtint` (подкраска фона прод-терминала), `segmented` (клавиатура сегментного переключателя) |
| **Раскладка (центр)** | — (всё на фронте; вкладки и дерево областей — слот `vterm.tabs:<окно>` в `localStorage`, ADR 0019) | — | Области и их полосы вкладок рисует `+page.svelte` (сниппет `stripTabs`); терминалы — один плоский `{#each}`, поставленный по прямоугольникам областей; `SplitDivider` — разделитель двух половин сплита (мышь и клавиатура) | `splitlayout` (дерево областей: `addTab`/`removeTab`/`moveTab`/`splitWithTab`/`joinPanes`, прямоугольники `layoutRects` с минимумом области, зоны сброса `paneZone`/`applyDrop`, предпросмотр `previewTabs`, проверка `layoutProblems`, сохранённое дерево — `savedLayout`/`loadLayout`, сетка областей одной командой — `tileTabs`/`gridFit`), `tabrestore` (вкладки после перезапуска: запись вкладки без полей сессии — с её местом: каталоги, scope k8s, файлы и зоны, раскладка до сетки; чтение слота, окна прошлого запуска, `waitReason` — кто открывает сессию сам, `waitView` — что написано на месте ждущей вкладки), `tabcontent` (вывод и диалог вкладки под `restoreOutput`: что пишется, `keepsContent`, разбор записи — ADR 0057), `centerview` (что на экране: `onScreenSessions`, позиция области в CSS, чей вопрос о входе показать, какие записи на паузе), `appshortcuts` (хорды областей) + сторы `stores/tabs`, `stores/tabdrag`, `stores/tabrestore`, `tabstrip` (линия активной вкладки и вида в фокусе) |
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
│   └── lib/                    # папка — подсистема или слой; тесты рядом с модулем (ADR 0045)
│       ├── types.ts            # зеркало моделей Rust — единственный файл в корне
│       ├── terminal/           # терминал: ввод, вставка, поиск, подсветка, ссылки, синхронный ввод
│       ├── connect/            # подключение: фазы, укладка экрана, вопрос о входе, секрет, ошибки SSH
│       ├── tabs/               # вкладки: линия активной, shell контейнера, восстановление
│       ├── layout/             # центр (дерево областей, зоны соединения) и доки
│       ├── windows/            # окна: роль, обрамление, передача вкладки, выход
│       ├── topbar/             # кнопки верхней панели
│       ├── files/              # файловые панели, пути, перетаскивание, переносы
│       ├── sync/               # синхронизация каталогов
│       ├── pathsync/           # следование за терминалом
│       ├── editor/             # редактор: языки, линт, сниппеты, diff, серверные инструменты
│       ├── markdown/           # markdown — недоверенный вход: рендер, картинки, санитайзер
│       ├── git/                # панель Git
│       ├── docker/             # панель Docker
│       ├── k8s/                # панель k8s
│       ├── monitoring/         # метрики: оверлей, статус-бар, пороги, графики
│       ├── netcheck/           # «Проверка доступа»
│       ├── utilities/          # окно «Утилиты» и его инструменты
│       ├── recording/          # записи сессий
│       ├── ai/                 # ИИ-ассистент
│       ├── servers/            # дерево серверов, форма, заметки, бэкап
│       ├── settings/           # окно настроек и стор settings; секции — у своих подсистем
│       ├── appearance/         # темы, шрифты, цвета, масштаб интерфейса
│       ├── screensaver/        # заставка простоя
│       ├── app/                # палитра ⌘K, хоткеи, буфер обмена, справка, обновления
│       ├── ui/                 # общие примитивы: Modal, ConfirmDialog, ContextMenu, Icon, …
│       ├── repo/               # гейты репозитория: документация, CI, линтер, версия, релиз
│       ├── api/                # слой: типизированные обёртки invoke()
│       ├── stores/             # слой: состояние в рунах
│       ├── page/               # слой: контроллеры страницы
│       ├── actions/            # слой: drag · tooltip · mdlinks · clipboardKeys · panelwide · emptyfit · connfit · fluidglide
│       └── i18n/               # слой: locales · messages · translate · index
├── src-tauri/
│   ├── src/                    # модули Rust (см. таблицу выше); commands/ — bridge-слой
│   ├── capabilities/           # минимальные разрешения Tauri
│   ├── icons/                  # иконки бандла (статичные)
│   └── tauri.conf.json         # окно, бандл, строгий CSP
├── e2e/                        # WebdriverIO + tauri-driver (CI; на macOS — в Linux-контейнере:
│                               # linux/Dockerfile, `pnpm e2e:linux`); specs/ · support/
├── docs/                       # GUIDE · INSTALL · TROUBLESHOOTING · INVARIANTS ·
│                               # ARCHITECTURE · DESIGN · ROADMAP · REFACTORING · TESTS · CI · adr/ ·
│                               # diagrams/ (схемы CI, собирает `pnpm ci:diagrams`)
├── scripts/                    # open-on-mac · place-opener · clean-launchservices · make-icons · ci-diagrams ·
│                               # release-train (выпуск по расписанию) · linux-box (команда в Linux-контейнере)
├── vite.config.js              # SvelteKit: адаптер, препроцессор, опрос версии (ADR 0046)
├── lint/vterm.js               # правила ESLint проекта: слои импорта и инварианты одного места
├── eslint.config.js            # рекомендованные наборы JS/TS/Svelte + правила проекта
├── .github/workflows/          # ci · codeql · security · deep (глубокие проверки) · train (поезд выпусков) ·
│                               # release (три ОС по тегу)
├── .github/actions/            # общие шаги CI: setup-web · setup-rust · test-sshd
└── rust-toolchain.toml         # версия Rust — одна на CI, машину и Linux-контейнер
```
Модель выбора шрифта — `src/lib/appearance/fonts.ts` (дефолты по группе темы и миграция).
Реактивное разрешение для терминала, записей и превью — `activeFontFamily()` в settings.
Масштаб интерфейса — `src/lib/appearance/uiscale.ts` (значения и расчёт); корневой размер шрифта
ставит `applyUiScale()`, числа пересчитывает `uiPx()`, шрифт терминала — `activeFontSize()` (ADR 0049).

## Обновления приложения

`HelpPanel` содержит историю из `CHANGELOG.md` и `UpdatePanel`; обе вкладки доступны из
нативного меню macOS и `TitleBar` Windows/Linux. `api/updater.ts` вызывает `updater.rs`:
`update_check`, `update_download` (Channel прогресса), `update_install`,
`update_window_ready`, `update_startup`. Состояние проверки/подготовленного файла принадлежит
приложению; `update://prepare`/`update://resume` согласуют выход всех окон.

`update_protocol.rs` описывает подписанный манифест. `update_helper.rs` — отдельный процесс,
копия текущего исполняемого файла с режимом `--vterm-update-helper`, который исполняется до
WebView и single-instance. Помощник работает без сети; установщик зависит от формата сборки.
`scripts/update-release.mjs` готовит macOS ZIP и подписанное описание восьми форматов в CI.
Обоснование — [ADR 0031](adr/0031-app-updates.md).
