# CONTEXT — рабочие правила проекта vterm

Контекст, который нужно учитывать при выполнении **любой** будущей задачи в этом
репозитории. Читать до начала работы.

---

## Рабочий процесс (Definition of Done каждой задачи)

1. **Дорожная карта.** План развития — в [ROADMAP.md](ROADMAP.md). По мере
   выполнения фазы/задачи **отмечай сделанное** там же (чекбоксы `[x]`, статус
   фазы `⬜ → ✅`, краткая заметка о статусе) — так же, как оформлены прошлые фазы.
2. **Тесты обязательны.** После реализации фичи **пиши тесты** на неё. Смотри, как
   это устроено, в [TESTS.md](TESTS.md), и **добавляй описание новых тестов** в
   TESTS.md (в соответствующий раздел/таблицу).
3. **Прогон тестов.** После выполнения задания **прогоняй весь набор**. Если
   что-то не проходит — **чини**, пока не станет зелёным (см. команды ниже).
4. **Документация — обязательна наравне с кодом.** При **любом** добавлении или
   фиксе функционала обновляй документацию **в том же объёме, что ROADMAP, TESTS и
   CONTEXT**: [README.md](README.md) (возможности, команды, структура каталогов,
   требования, установка), [ROADMAP.md](ROADMAP.md) (чекбоксы/статус), а при
   изменении тестов — [TESTS.md](TESTS.md) и при изменении правил/инвариантов —
   этот [CONTEXT.md](CONTEXT.md). README — не «по необходимости», а обязательный
   артефакт: фича/фикс без отражения в README считается незавершённым. README
   также показывается внутри приложения (Help → «Инструкция»), поэтому держи его
   актуальным и пригодным для чтения конечным пользователем.

### Полный прогон перед завершением

```sh
source "$HOME/.cargo/env"                       # cargo не в PATH свежей сессии
export PATH="$HOME/Library/pnpm/bin:$PATH"      # standalone pnpm

cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml
pnpm check
pnpm test:coverage
```

Все пять команд должны быть зелёными. Гейты покрытия (**≥ 90 %** для чистой логики,
**≥ 80 %** в целом) настроены в [vitest.config.ts](vitest.config.ts) и **роняют**
прогон, если не достигнуты.

---

## Архитектура и инварианты (выработано в Фазе 6 — соблюдать)

Полные обоснования — в [docs/adr/](docs/adr/). Краткие правила:

- **Граница фронт/бэк.** Вся логика SSH/SFTP/секретов/файлов живёт в Rust-бэкенде
  (`src-tauri/src/`). Svelte-фронтенд ходит к ней только через `invoke()` (команды
  в `lib.rs`) и каналы событий (`term://…`, `sftp://…`, `menu://…`). Новый
  функционал такого рода: команда в бэкенде + типизированная обёртка в
  [src/lib/api.ts](src/lib/api.ts). Не дублируй бизнес-логику на фронте. (ADR 0001)
  - **Единый контракт терминала.** SSH-сессии ([ssh.rs](src-tauri/src/ssh.rs)) и
    локальные shell-вкладки ([pty.rs](src-tauri/src/pty.rs), `portable-pty`)
    используют **один** канал событий (`term://out|closed/{id}`) и **одни** команды
    (`write_to_terminal`/`resize_pty`/`disconnect`, маршрутизация по `session_id`),
    поэтому [Terminal.svelte](src/lib/Terminal.svelte) общий для обоих (проп
    `local`). Новый вид терминала подключай к этому же контракту, а не отдельным.


- **Ошибки — типизированы.** В Rust возвращай `AppResult<T>`
  ([error.rs](src-tauri/src/error.rs)), не `String`. Семантические случаи —
  отдельные варианты (`AuthRejected`, `HostKeyRejected`, `NoSession`,
  `UnknownServer`); прочее — `AppError::Message`. `AppError` сериализуется в строку,
  поэтому контракт с фронтом не меняется; маркеры (`auth-rejected` и т.п.) живут в
  `Display`. (ADR 0002)
- **Чистая логика — в `.ts`/свободных функциях**, не в `.svelte`/командах: её
  тестируют без DOM/сети. Фронт: [tree.ts](src/lib/tree.ts),
  [format.ts](src/lib/format.ts), [util.ts](src/lib/util.ts),
  [actions/drag.ts](src/lib/actions/drag.ts). Rust: `reprefixed`,
  `decode_or_default`. (ADR 0003)
- **Состояние UI — в runes-сторах** `src/lib/stores/*.svelte.ts` (по образцу
  [settings.svelte.ts](src/lib/settings.svelte.ts)): `layout` (ширины/сворачивание
  панелей), `tabs` (вкладки терминалов). Не разбрасывай состояние по компонентам. (ADR 0003)
- **Компоненты декомпозированы.** `+page.svelte` — оркестратор; крупные части
  вынесены в `TopBar`, `ServerTree`. Переиспользуй примитивы `Modal`,
  `ConfirmDialog`, `Icon`. Иконки — из реестра [icons.ts](src/lib/icons.ts) через
  `<Icon name="…" />`, **не эмодзи**. Pointer-drag — через `actions/drag.ts`. (ADR 0003)
  Оформление кнопок/иконок/строк — по закреплённой **дизайн-системе** (см. ниже).
- **Офлайн-инвариант.** Никаких runtime-обращений в сеть, кроме исходящего SSH к
  серверам пользователя. Шрифты встроены (`@fontsource`), внешние ссылки — только
  по явному клику через `tauri-plugin-opener`. Закреплено гейтом
  [autonomy.guard.test.ts](src/lib/autonomy.guard.test.ts). (ADR 0004)
- **Безопасность.** CSP в `tauri.conf.json` держи строгим (никаких удалённых
  origin'ов; не возвращай `csp: null`); capabilities — минимально необходимые
  (opener только `https://`, без `dialog:default`/`fs`/`dangerous*`). Секреты —
  только в keychain, оборачивай копии в `zeroize::Zeroizing`, **никогда не логируй**.
  Host-key дефолт — не «accept». Зависимости проходят `cargo audit`/`cargo deny`/
  `pnpm audit`/Semgrep (стадия `security` в CI). Гейты:
  [tauri-security.guard.test.ts](src/lib/tauri-security.guard.test.ts), `deny.toml`.
  Полная модель — [SECURITY.md](SECURITY.md).
- **Контракт типов — camelCase.** Rust-модели — `#[serde(rename_all = "camelCase")]`,
  зеркало в [src/lib/types.ts](src/lib/types.ts). Новые поля старых структур —
  `#[serde(default)]`.
- **Персистентность:** профили/папки/known_hosts — JSON в конфиг-каталоге
  (`store.rs`); секреты — только в OS keychain (`secrets.rs`), никогда в файлах;
  настройки/layout UI — `localStorage` (runes-сторы). Для e2e — `data-testid`.

## Дизайн-система (Фаза 7 — ЗАКРЕПЛЕНО, НЕ МЕНЯТЬ без явного запроса)

> **Главный инвариант.** Визуальный язык ниже зафиксирован. Его **нельзя менять**
> при рефакторинге, чистке, переименованиях, добавлении фич и любых других задачах —
> **только если пользователь напрямую попросил изменить дизайн**. Новые элементы UI
> обязаны переиспользовать существующие токены/паттерны, а не вводить свои. Если
> задача формально требует тронуть оформление, но прямого запроса на это нет —
> сохраняй текущий вид и спрашивай.

- **Источник цвета.** Только токены `@theme` из [src/app.css](src/app.css)
  (`panel`, `panel-alt`, `edge`, `accent`, `accent-hover`, `danger`, `muted`,
  `text`) + `green-600/500` для primary-действия (Connect). Никаких сырых hex в
  компонентах, никаких новых цветов без запроса.
- **Иконки.** Единственный источник — реестр [icons.ts](src/lib/icons.ts), рендер
  через `<Icon name="…" />` ([Icon.svelte](src/lib/Icon.svelte)): line-стиль,
  24×24, `currentColor`, `stroke-width 1.8`. **Эмодзи запрещены** (вкл. иконки ОС в
  статус-баре). Иконки папки/файла/символьной ссылки **одинаковы** в левой панели
  ([ServerTree.svelte](src/lib/ServerTree.svelte)) и в SFTP
  ([SftpPanel.svelte](src/lib/SftpPanel.svelte)). Новую иконку — добавлять в реестр,
  не инлайнить SVG в компонентах.
- **Кнопки с текстом** (база `rounded px-3 py-1 text-sm font-medium`), два варианта:
  - **primary / green** (действие Connect): `bg-green-600 text-white hover:bg-green-500`
    (+ `disabled:opacity-40`). Connect **всегда зелёный**.
  - **neutral**: `bg-edge hover:bg-accent hover:text-panel-alt`.
- **Иконочные кнопки в тулбарах** (collapse/expand, refresh, new folder, add server,
  upload): `flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white`,
  иконка `size=14`.
- **Иконочные действия в строках** (edit/download/upload по ховеру строки):
  `rounded p-0.5 text-muted hover:text-accent`; **удаление** —
  `hover:text-danger` (иконка `trash`); иконка `size=13`.
- **Появление действий по ховеру — без сдвига.** Группа действий строки
  резервирует место всегда и показывается через `invisible → group-hover:visible`
  (**не** `hidden`/`display`-переключение — иначе строка «прыгает»). Подсветка строки
  (`hover:bg-edge`, выбранное — `border-accent`) меняет только фон/рамку, не геометрию.
- **Сворачивание панелей** — шевронами из реестра (`chevronLeft`/`chevronRight`),
  не символами `«`/`»`.
- **Пустые состояния/онбординг** — через [EmptyState.svelte](src/lib/EmptyState.svelte)
  (бейдж-иконка в кружке + заголовок + опц. подсказка + слот CTA-кнопок). Используй
  его для «нет данных»-экранов (пустой список серверов, отсутствие активной сессии),
  не верстай разрозненные заглушки. CTA — нейтральные/green-кнопки из кнопочной системы.
- **Тосты/уведомления** ([Toast.svelte](src/lib/Toast.svelte) +
  [stores/toasts.svelte.ts](src/lib/stores/toasts.svelte.ts)) — единственный канал
  неблокирующих сообщений. Ошибки операций и статусы показывай через
  `notifyError`/`notifySuccess`/`notifyInfo`, **не** инлайновыми баннерами (исключение —
  контекстная валидация прямо в форме/на экране подключения). Контейнер фиксирован
  снизу-справа; тон по типу: error → `danger` (иконка `alert`), success → `green`
  (иконка `check`), info → `accent` (иконка `info`); авто-дисмисс по `TOAST_TTL`.
- **Доступность (a11y).** Диалоги — через [Modal.svelte](src/lib/Modal.svelte)
  (`ConfirmDialog`/формы строй на нём): он даёт `role="dialog"`/`aria-modal`/`aria-label`,
  фокус-трап (Tab/Shift+Tab по кругу), автофокус первого контроля и **возврат фокуса**
  открывшему при закрытии — не дублируй это в новых диалогах. Интерактивные элементы
  имеют доступное имя (`aria-label`/`title`) и достижимы с клавиатуры; иконочные кнопки —
  обязательно `aria-label`. Вкладки терминалов — паттерн tablist с роуминг-`tabindex`
  (активная `0`, прочие `-1`) и навигацией ↑/↓/←/→/Home/End/Enter (чистый
  `nextTabIndex` в [stores/tabs.svelte.ts](src/lib/stores/tabs.svelte.ts)). Дерево —
  `role="tree"`/`treeitem`. Не понижай эти гарантии при рефакторинге.
- **Командная палитра** (⌘K / Ctrl+K, [CommandPalette.svelte](src/lib/CommandPalette.svelte) +
  чистая логика [command.ts](src/lib/command.ts)) — top-aligned оверлей: поле поиска
  (иконка `search`) + ранжированный список команд с клавиатурной навигацией
  (↑/↓/Enter/Esc), активная строка — `bg-edge`, чип группы — `bg-panel`. Ранжирование/
  фильтрация — только в `command.ts` (`filterCommands`/`matchScore`); компонент
  получает `commands` с готовыми `run` от страницы, новые источники команд добавляй
  там же. Глобальный хоткей ⌘K — `<svelte:window>` в [+page.svelte](src/routes/+page.svelte).
- **Анимации/переходы.** Короткие и сдержанные: токены `--motion-fast` (120ms) /
  `--motion-base` (200ms) в [app.css](src/app.css); анимируй только дешёвые свойства
  (`opacity`/`transform`/цвет/`width`/`height`), не layout вне панелей.
  **Всё, что сворачивается/разворачивается, обязано делать это плавно** (как панели
  `ServerTree`/`SftpPanel` и раздел Theme в настройках): по горизонтали — анимация
  ширины (`transition-[width]`, выключается на ресайзе), по вертикали — Svelte
  `transition:slide` (≈200ms); мгновенных скрытий/показов сворачиваемых блоков не
  делай. **Уважай
  `prefers-reduced-motion`** — глобальный guard в `app.css` гасит анимации, не вводи
  движение в обход него. Паттерны: сворачивание панелей — `transition-[width]`,
  **выключается на время ресайза** (проп `animateWidth` из `resizing`); состояния
  строк/drop-таргета — `transition duration-150`; drag-«призраки» — `in:fade` 120ms;
  загрузка списков — скелетоны через [Skeleton.svelte](src/lib/Skeleton.svelte)
  (`animate-pulse`, `aria-hidden`), а не текст «Loading…».
- **Темы и настройки.** Темы — записи `ThemeDef` в [themes.ts](src/lib/themes.ts)
  (`group: light|modern|retro`), каждая несёт полную терминальную палитру + UI-палитру
  (`UiPalette` → `--color-*`); добавление темы = один объект + запись в `THEMES`
  (точка расширения, не правь существующие палитры без запроса). В настройках тема
  выбирается **визуальным пикером** (кнопки-чипы с образцами `themeSwatches`,
  `role="radio"`) — раздел **сворачиваемый, по умолчанию свёрнут** (тоггл показывает
  текущую тему с превью-образцами). Шрифт — **такой же сворачиваемый раздел с сеткой**
  кнопок-`radio`, каждая отрисована своим начертанием (превью), плюс живой образец кода
  (`font-preview`). Поиск по настройкам — секции фильтруются `matchesQuery`
  ([util.ts](src/lib/util.ts)) по ключевым словам; пустой запрос показывает всё.
- **Панель мониторинга** (нижний статус-бар, [StatusBar.svelte](src/lib/StatusBar.svelte)) —
  ряд **групп** показаний (OS, user@host, CPU, ОЗУ, диск). Закреплено:
  - **Структура группы:** иконка (`size=14 text-muted`) + значение(я). Все значения —
    `tabular-nums`; составное значение собирается в **один** элемент (ОЗУ —
    `used / total (pct)`, диск — `free / total`), без `&nbsp;`-склеек.
  - **Интервалы и разделители:** внутри группы — `gap-2`; **между любыми группами**
    (включая любые новые показатели) **обязательна** тонкая **черточка** `divider()`
    (`h-3 w-px bg-current`, т.е. цветом текста) с равным `gap-2` по бокам — её рендерит
    цикл `{#each groups}` через `{#if i > 0}`, поэтому новый показатель = новая запись в
    `groups`, а не вложение в чужую группу (так load average вынесен из CPU в свою
    группу). Контейнер — `gap-2`.
  - **Фиксированная ширина значений (анти-«прыжок»):** значение каждого показателя —
    в `inline-block` с **двумя плотными ширинами на элемент** через хелпер
    `w(compact, expanded)` (`tabular-nums`): своя ширина под контент компактного и
    расширенного режима, чтобы не было ни «прыжка» при смене цифр, ни пустого места.
    Длинные/переменные тексты (top process, kernel, ip, байтовые строки) — `truncate`
    (хвост за `…`), полное значение в `title` (top process — топ-3 процесса). Парные
    скорости (net/disk I/O) — компактный `gap-1`.
  - **CPU — мини-график** (sparkline, только в расширенном режиме): прямоугольник
    `h-3.5 w-10` (`border-edge`, фон `bg-panel`) со столбиками; история `CPU_SAMPLES`
    значений `cpuPct`, левый паддинг нулями (стабильная ширина, рост справа),
    цвет столбиков — зелёный `#22c55e` (в тон иконке CPU). Не возвращать
    горизонтальную полосу загрузки.
  - **Режимы:** `settings.statusBarExpanded` (по умолчанию **компактный**) —
    компактный показывает иконки + проценты (CPU/ОЗУ/диск %), расширенный добавляет
    имя ОС, байтовые суммы, sparkline и load-average инлайн. Тоггл — кнопка справа
    (`statusbar-toggle`, иконки `chevronsLeft`/`chevronsRight`).
  - **Показатели (каждый — своя группа со своей иконкой):** OS, user@host, ip(`globe`),
    uptime(`power`,`fmtUptime`), kernel(`terminal`), server time(`clock`),
    CPU(%+sparkline), load average(`gauge`), CPU temp(`thermometer`), top process
    (`activity`), ОЗУ, swap(`swap`), диск, disk I/O(`diskIo`,`fmtRate`),
    сеть(`upload`/`download`,`fmtRate`), connections(`plug`), users(`users`, число +
    список в `title`). Скоростные метрики (сеть, disk I/O) считаются в бэкенде дельтой
    счётчиков (`/proc/net/dev`, `/proc/diskstats`) через общий `rate_from`
    (`net_samples`/`disk_samples` + `Instant`), как CPU%.
  - **Видимость и доступность:** `settings.statusBarItems` (флаг на каждый показатель) —
    чекбоксы в свёрнутом под-разделе настроек. Группа показывается при флаге **и**
    наличии данных (метрики, которых хост не отдаёт, авто-скрываются, а не висят
    прочерком); core (cpu/ram/disk) — всегда при флаге. Контейнер `overflow-x-auto` —
    при переполнении бар скроллится горизонтально (тонкий скроллбар из `app.css`).
  - **Индикатор передач SFTP:** при активных передачах — сегмент со стрелкой ↑/↓ и
    суммарным `%` (в расширенном — N файлов + мини-бар); клик разворачивает панель SFTP
    (`layout.sftpCollapsed=false`). Состояние передач — общий стор
    [stores/transfers.svelte.ts](src/lib/stores/transfers.svelte.ts) (подписка на
    `sftp://progress` — в `+page`), агрегат — чистый `aggregateTransfers`.

## Сборка: два артефакта на каждой фазе

Требование пользователя: **каждая фаза** даёт **два** дистрибутива — macOS
(`.app`/`.dmg`) и Windows (`.msi`/`.exe`). Единый кросс-ОС файл невозможен; Windows
на этом Mac не собирается → механизм — **GitLab CI** ([.gitlab-ci.yml](.gitlab-ci.yml),
self-hosted раннеры, теги-плейсхолдеры `[macos]`/`[windows]`/`[linux]`). CI устроен
как `lint → test → build → release`: сборка идёт только после зелёных тестов.

## Версионирование

Схема — `0.<фаза>.<фикс>` (валидный SemVer из **трёх** чисел):

- 1-я цифра — **основная версия** (пока `0`, до релиза).
- 2-я цифра — **номер фазы** (минорная); поднимается при переходе на новую фазу.
- 3-я цифра — **номер фикса/хотфикса/правки бага** (патч); поднимается при каждом
  баг-фиксе/хотфиксе **внутри** текущей фазы.

**Сброс последней цифры в 0** при изменении любой более старшей цифры (новая фаза
или смена основной версии).

> **Почему 3 числа, а не 4.** Хотелось «`0.0.0.0`», где последняя цифра — фикс, но
> Cargo/SemVer (и `package.json`, и `tauri.conf.json`) принимают **только три**
> числа — `0.8.0.0` не парсится. Поэтому **номер фичи в версии не кодируется** — он
> ведётся в [ROADMAP.md](ROADMAP.md) (заметки «Феатура N (vX)»), а версия отражает
> фазу и номер фикса.

Поднимай версию согласованно в [package.json](package.json),
[src-tauri/Cargo.toml](src-tauri/Cargo.toml) и
[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json); затем `cargo check` для
синхронизации `Cargo.lock`. Версию приложение читает из `tauri.conf.json`
(`getVersion`) и показывает в окне About.

## Toolchain (нестандартный на этой машине)

- `cargo`/`rustc` ставились через rustup, но **не в PATH** свежей сессии →
  `source "$HOME/.cargo/env"`.
- `pnpm` — standalone в `$HOME/Library/pnpm/bin` (corepack-шим сломан под Node 25)
  → `export PATH="$HOME/Library/pnpm/bin:$PATH"`.
- pnpm гейтит нативные build-скрипты; esbuild разрешён через
  `allowBuilds: { esbuild: true }` в [pnpm-workspace.yaml](pnpm-workspace.yaml).
- Запуск приложения: `pnpm tauri dev` (первая Rust-сборка ~1–2 мин).
- `tauri-driver` (E2E) работает только на **Linux/Windows**, не на macOS — E2E
  прогоняет CI; локально на macOS гоняй `pnpm test`.
