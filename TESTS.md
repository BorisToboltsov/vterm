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
  (rx/tx сети и disk I/O), `uuid_like`; **детальные метрики мониторинга** —
  `parse_percpu`/`percpu_delta` (per-core CPU%), `parse_psi` (PSI some-средние),
  `parse_partitions` (слияние места и inodes по mount), `parse_tcp` (состояния
  TCP), `parse_detail` (mem/filenr/ulimit/procs) и `parse_pending` (распознавание
  пакетного менеджера и счётчиков обновлений);
- `model.rs` — serde round-trip `ServerProfile`/`NewServerProfile`/`AuthMethod`
  (camelCase, `#[serde(default)]` для старых JSON без `group`/`tags`/**`autoRecord`** —
  легаси-профиль → `auto_record:false`; round-trip сохраняет `autoRecord:true`);
- `store.rs` — декодирование профилей/папок/known_hosts, битый JSON → дефолты,
  файловый round-trip во временном каталоге (`tempfile`);
- `pty.rs` — `pty_size` (кламп размеров локального PTY к ≥ 1×1). Само порождение
  shell-вкладки (`portable-pty`) проверяется вживую/E2E, а не юнит-тестом
  (нужен реальный tty + Tauri-события).
- `recording.rs` — запись сессий (Фаза 11), чистые хелперы: `asciicast_header`
  (валидный JSON v2, кламп нулевых размеров, **флаг-расширение `timed`** — `true`/`false`
  в заголовке, плюс поле **`server`** = creation-title), `with_updated_meta` (перезапись
  `title`/`description`: события и прочие поля — `timed`/`width`/**`server`** — сохраняются,
  т.е. сервер переживает переименование; не-JSON/пустой ввод → `None`),
  **метаданные сессии**: `Recorder::start` вкладывает в заголовок `vterm`-объект (env из
  фронта: hostname/ip/os + бэкендные `recordMode`/`startedAt`; пустой env → объект всё равно с
  `recordMode`), `with_ended_at` ставит `vterm.endedAt` сохраняя остальное, `RecordMode::label`
  (commands/fullNoTiming/full round-trip), **пауза** (`set_paused`): пока на паузе `output`
  отбрасывается, а `input` авто-возобновляет (фоновый поток не записан, до/после — записаны),
  `event_line` (JSON-массив `[t,kind,data]`
  с округлением времени до мкс и экранированием), `sanitize_title` (fs-безопасный слаг,
  фолбэк `session`), `is_password_prompt` (детект `password:`/`passphrase:`/`[sudo]`,
  без ложного срабатывания на «the password is …»), `RecordMode::parse`
  (full/fullNoTiming/commands → timed/per_line, неизвестное → full), и **ритм untimed-режимов**
  (`Recorder` во временный файл): в `commands` сначала пишется **затравочное приглашение**
  (передано в `start` — первое `o`-событие при `t=0`), затем команда эхо-печатается посимвольно
  с растущими таймингами, а вывод (два чанка) пишется **одним таймингом** — сразу целиком, не
  построчно; в `fullNoTiming` (приглашение пустое → не сеется) набор идёт с **тем же шагом
  `TYPING_STEP`** (пер-keystroke — проверяется равенство интервала), а вывод так же **одним
  таймингом** — оба режима играют полностью одинаково. Отдельный тест: **пустой Enter в
  `commands` игнорируется** — «долбёжка» Enter не даёт `i`-событий, а echo пустых строк и
  повторно отрисованное приглашение оболочки подавляются (в записи остаются затравочное
  приглашение и реальная команда с выводом). **Построчный редактор `commands`-режима:**
  стрелки/escape не утекают в команду (`ESC[D`/`ESC[C`, `ESC O D`/`ESC O C` SS3, `ESC[1;5C`
  CSI-с-параметрами → чистая `cd /etc/systemd`); **вставка по курсору** — после ←← набранный
  `X` встаёт в середину (`cd /etc/systeXmd`, а не в конец); **Home/End/Delete/backspace**
  (Ctrl+A/E, `ESC[H`, `ESC[3~`) редактируют строку в нужной позиции; **правки оболочки
  восстанавливаются из её вывода:** **история (↑/↓)** — `ESC[A`/`ESC O A` + redraw `CR приглашение
  команда ESC[K` → recalled-команда как есть, а после backspace+вставки — отредактированная
  (`cd /etc/systeX`); **tab-completion** — простое дополнение (эхо `c/` без `CR` → дописка по
  курсору `cd /etc/`) и неоднозначное со списком+перерисовкой (→ строка минус приглашение, `echo`).
- `ssh.rs` — `HostKeyPolicy::from_str`, имена событий (вкл. `phase_event` →
  `term://phase/{id}`), `key_is_encrypted` на
  сгенерированных `ssh-keygen` ключах (тест мягко пропускается, если
  `ssh-keygen` недоступен); `find_default_key` (порядок предпочтения OpenSSH,
  пустой каталог → `None`, игнор каталогов с именем ключа) и `pick_key_path`
  (явный путь побеждает, пустой/отсутствующий откатывается на дефолт из `~/.ssh`).
- `error.rs` — `AppError`: наличие маркеров (`auth-rejected`/`host-key-rejected`/
  `file-changed`) в `Display`, конверсии `From<String>/<io::Error>`, сериализация
  в строку (контракт с фронтом не меняется).
- `recording.rs` (Фаза 12.3, аудит) — `annotate` пишет видимое `o`-событие
  `[vterm] …` в asciicast, **даже на паузе** (два события: до и после `set_paused(true)`).
- `localfile.rs` (Фаза 12.4, локальные файлы) — `local_temp` (скрытый sibling, корректный
  parent + bare-имя); async round-trip read/write с **конфликт-проверкой** по sha
  (правильный sha → запись, устаревший → `file-changed`); отказ на **бинаре** (NUL) и
  **слишком большом** файле (через `tokio::test` + `tempfile`).
- `servertools.rs` (Фаза 12.8) — `parse_status` (mgr + present-bins), `install_command`
  (команда под менеджер: системные с sudo, fallback `pip --user` для yamllint/ruff, distro-имена
  для sensors, бинарь для hadolint, `None` для неизвестного), `sudoize` (первый `sudo`→`sudo -S`,
  pip/brew без изменений, мульти-sudo — только первый), `build_status` (installed-флаг).
- `sftp.rs` → `parse_id_names` (ls-владелец) — разбор `/etc/passwd`/`/etc/group`
  (`name:x:id:…`, первое имя на id, пропуск битых строк; один парсер для users и groups).
- `sync.rs` (Фаза 12.5–12.6) — `shell_quote` (экранирование `'`), `remote_hash_command`
  (квотирование пути + fallback `sha256sum`→`shasum`), `parse_hashsum` (hash+относительный путь,
  `*`-маркер, пробелы в пути, пропуск не-hex/коротких строк), `remote_join`/`local_join`;
  **grep** — `grep_command` (флаги `-rnIi`/`-F`/`-E`, квотирование) и `parse_grep`
  (`path:line:text`, пропуск битых строк); **lint** — `lint_tool` (язык→инструмент, неизвестный →
  `None`) и `lint_command` (`bin args 'tmp' 2>&1`).
- `sftp.rs` (Фаза 12.1, редактор конфигов) — чистые хелперы чтения/записи текста:
  `sha256_hex` против эталонных векторов SHA-256 (пустая строка, `"abc"`);
  `detect_eol` (lf/crlf/одна строка); `apply_eol` (LF→CRLF и обратно, идемпотентность
  на CRLF-входе); `looks_binary` (NUL → бинарь, UTF-8/кириллица → текст);
  `is_read_only` (`0o444` → true, `0o644`/`0o600`/None → false); `temp_sibling`
  (скрытый sibling в той же папке, без `/` для голого имени).
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
  существует в `icons.ts`), `memPct`, `fmtPct` (округление + «%», прочерк),
  `diskFree` (статус-бар);
- `thresholds.ts` — `thresholdLevel` (ok/warn/crit, включительные границы, crit
  важнее warn, null-значение/порог → ok, по-уровнево отключаемые границы),
  `levelTextClass`/`thresholdClass` (уровень → `text-warn`/`text-danger`);
- `util.ts` — `debounce` (с fake-таймерами), `isHidden`, `matchesQuery`
  (AND-подстрока, регистронезависимость, пустой запрос → всё);
- `command.ts` — `matchScore` (пустой запрос, отсутствие терма, регистронезависимость
  по title/subtitle/keywords/group, все термы обязательны, буст префикса) и
  `filterCommands` (порядок, отсев, ранжирование, стабильность ничьих);
- `search.ts` — полнобуферный поиск терминала (Фаза 10): `buildMatcher`
  (пустой запрос → null, регистронезависимость по умолчанию, `caseSensitive`,
  экранирование метасимволов в литеральном режиме vs `regex`, `wholeWord` —
  границы слова, невалидный regex → null), `findMatchRows` (индексы строк
  сверху-вниз, пустой запрос/нет совпадений, регистр), `contextSnippet` (строка
  ±radius, клампинг у краёв буфера, обрезка хвостовых пустых строк, out-of-range
  → пусто), `matchCountLabel` (`""` при 0, one-based `n/total`, `count+` при
  непрослеживаемом активном индексе);
- `highlight.ts` — regex-подсветка логов (Фаза 10): `colorToSgr` (имя цвета → ANSI
  SGR), `compileRules` (пропуск выключенных/пустых/невалидных regex, флаги `gi` vs
  `g`; перенос `wholeLine` + построение set/reset из стилей), `applyHighlight` (обёртка
  совпадения в SGR + сброс; регистронезависимость; несколько правил; без двойной обёртки
  на пересечении; **не матчит внутри escape-последовательностей**; подсветка реального
  текста при escape-кодах; без зависания на нулевых; **подсветка всей строки** для
  `wholeLine`-правила и построчное применение; **жирный** (`1;…`) и **фон** (чёрный текст
  на цвете) с полным сбросом `0`);
- `jsonlog.ts` — мультиформатный парсер структурных логов (Фаза 10): `stripAnsi`,
  `parseLogLine` (объект-JSON; толерантность к пробелам/ANSI; отсев не-JSON, массивов,
  примитивов, битого, пустого), `parseLogfmt` (пары `key=value` с кавычками; отсев
  одиночной пары и строк со свободным текстом), `parseSyslog` (RFC3164 с pid и
  ISO-вариант; null для не-syslog), `parseNginx` (combined-лог: поля + уровень из статуса
  5xx→error/4xx→warn; null для не-access), `parseDmesg` (uptime-префикс; null для обычной
  строки), `extractFields` (канонические/альтернативные имена `ts/level/message`, коэрсия,
  null для отсутствующих/объектных, **регистронезависимо** + journald `MESSAGE`/`PRIORITY`/
  `SYSLOG_TIMESTAMP`), `toLogEntry` (**авто-определение формата** + `format`/`source`; null
  для plain-text), `normalizeTime` (epoch µs/ms/s, ISO → локальный формат; uptime и
  непарсируемое — как есть; null→''), `levelCategory`
  (severity → bucket error/warn/info/debug/other; **числовой syslog-`PRIORITY`** 0-3/4/5-6/7),
  `levelClass` (категория → класс
  `text-danger`/`text-warn`/`text-muted`/''), `availableFields` (сортированный union
  ключей raw для пикера колонок), `fieldValue` (строка/объект→JSON/пусто для null),
  `filterEntries` (пустой запрос → всё; регистронезависимый матч по level/message/raw-JSON),
  `applyFilters` (комбинация текст + чипы уровня: все/пустой набор → без фильтра,
  только включённые категории, пересечение с текстом), `colWidth` (хранимая ширина vs
  фолбэк при отсутствии/неположительном значении), `resizedWidth` (старт + знаковая
  дельта с округлением, кламп к минимуму);
- `recording.ts` — записи сессий (Фаза 11): `parseCast` (заголовок + `o`/`i`-события
  asciicast, отсев мусора, пустое, **чтение флага-расширения `timed`** из заголовка —
  `false`/отсутствует), `extractTranscript` (склейка вывода, снятие ANSI,
  игнор ввода, схлопывание CR-перерисовок до финального состояния, сжатие пустых строк,
  пусто без вывода), `extractCommands` (список введённых команд: keystroke-режим — по Enter;
  **commands-режим — каждое `i`-событие без `\r` = команда**, не склеиваются),
  `extractMarkdown` (**ранбук**: шапка `# title`, нумерованные команды в code-span, вывод в
  `` ```text ``; голый заголовок без вывода; пусто без команд; **commands-режим без `\r` строит
  ранбук, а не пустой файл** — из блока срезаются эхо команды и хвостовое приглашение; «забор»
  расширяется при backtick'ах в выводе), **`sessionMetaPairs`/`metadataComment`** (упорядоченный
  блок метаданных: server/host/address/ip/user/os/kernel/started/ended/duration/mode/app; только
  присутствующие поля; `#`-комментарии для txt; пусто без заголовка),
  `castDuration` (время последнего события / 0); библиотека:
  `recordingDateISO` (UTC `YYYY-MM-DD`, "" для 0), `filterRecordings` (по **заголовку/описанию/
  серверу**/файлу/ISO-дате — в т.ч. сервер находится после переименования заголовка,
  регистронезависимо, пустой запрос → всё), `sortRecordings`/`sortRecordingsBy`
  (одно- и **многоключевая** сортировка дата/имя/размер: приоритет по порядку критериев,
  пустые → копия без мутации входа); плеер: `outputUpTo` (конкатенация вывода до времени
  `t`, игнор ввода), `formatTime` (`M:SS`/`H:MM:SS`, отрицательное → `0:00`) и
  `playbackSpeeds` (по флагу `timed`: реально-таймингованные → `0.5/1/2/4×` старт `1×`;
  синтетические `timed:false` → замедленная `0.25/0.5/1/2×` старт `0.5×`; отсутствие флага
  и `null` → как таймингованные);
- `actions/clipboardKeys.ts` — `isEditable` (text-like input/textarea — да; чекбокс/
  div/readonly/disabled/`.xterm`-textarea — нет), `selectedText`/`replaceSelection`
  (вставка по каретке + событие `input`; замена всего значения для `type="number"`
  без selection API) и глобальный `handleClipboardShortcut`: вставка по Cmd+V и
  Ctrl+V (вкл. number-поле), копирование/вырезание выделения, select-all по Cmd+A,
  игнор не-редактируемых целей (терминал) и обычных/Alt/Shift-нажатий (модуль
  `../clipboard` замокан, проверка без Tauri/navigator);
- `themes.ts` — целостность палитр (все ключи — валидный hex, группа
  light/modern/retro), наличие светлых тем, `themeSwatches`, `getTheme`,
  `applyUiPalette`;
- `settings.svelte.ts` — дефолты (в т.ч. `recordIdlePauseSecs: 20` — пауза записи при простое),
  persist в `localStorage`, `activeTerminalTheme`,
  `resetSettings` (рунический модуль — эффекты прогоняются через `flushSync`),
  `statusBarThresholds` (числовые дефолты, deep-merge бэкапа с сохранением
  дефолтов для отсутствующих метрик, явный `null` = отключено, отсев мусора),
  `smartLogs` (Фаза 10: дефолты — всё включено; merge частичного бэкапа с
  сохранением дефолтных под-флагов; восстановление `resetSettings`),
  `highlightRules` (Фаза 10: посев стартовых правил, в т.ч. green `success` + поля
  стилей `wholeLine/bold/background`; санитизация импортируемого массива — отсев
  мусора, фолбэк цвета/`enabled`, коэрсия булевых стилей; восстановление `resetSettings`),
  `searchOptions` (Фаза 10: дефолты off; persist/reload; merge частичного бэкапа;
  восстановление `resetSettings`);
- `stores/layout.svelte.ts` — дефолты, persist ширин/сворачивания, `clamp`;
- `stores/tabs.svelte.ts` — `openTab` (kind `ssh`)/`openLocalTab` (kind `local`,
  пустой `serverId`, алиас «Local shell»)/`closeTab`/`moveTab`/`setTabStatus`,
  переназначение активной вкладки, чистые `statusLabel`/`dotClass`/`isLive`,
  `nextTabIndex` (роуминг ←/→ с заворотом, Home/End, null для прочих клавиш/пустого);
- `connphase.ts` — окно подключения (0.11.2): `phaseSteps` (первая фаза `active`,
  остальные `pending`; ранние → `done`, поздние → `pending`; `errored` красит
  активную фазу в `error`; неизвестная фаза → первый шаг `active`) и порядок
  `PHASE_ORDER`, совпадающий со стадиями бэкенда;
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
  `sftpCreateFile` → `sftp_create_file`, `sftpReadText` → `sftp_read_text`,
  `sftpWriteText` → `sftp_write_text` (вкл. `expectedSha256`), `readLocalText` →
  `read_local_text`, `writeLocalText` → `write_local_text`, `takePendingOpens` →
  `take_pending_opens`, `localHome`/`localList`/`localMkdir`/`localCreateFile`/`localDelete`
  → `local_*` (локальная файловая панель), `sftpHashTree`/`localHashTree`/`sftpSyncApply` →
  `sftp_hash_tree`/`local_hash_tree`/`sftp_sync_apply` (синхронизация), `annotateRecording` →
  `annotate_recording`, `fetchMetricsDetail` → `fetch_metrics_detail`, `fetchPendingUpdates` →
  `fetch_pending_updates`,
  `exportBackup`/`importBackup` и backup-диалоги) + `isFileChangedError`
  (матч маркера `file-changed`, игнор посторонних ошибок) + `isPermissionError`
  (матч `permission denied`/`no such file` — отказ доступа, при котором предлагается sudo);
- `editorlang.ts` (Фаза 12.2) — `baseName`/`fileExt` (lower-case расширения, dotfile
  без расширения), `editorLangFor` (известные расширения → язык: config-форматы, **скрипты/
  ЯП** Python/JS/TS/Java/Go/Rust/Ruby/C·C++·C#/SQL/PowerShell/Lua/Perl, **markup** HTML/CSS/
  SCSS/Less/XML, **DevOps** nginx/CMake/diff/Protobuf/Puppet, Groovy/Scala/Kotlin/Dart/Swift/
  Clojure/Haskell/Erlang/Elm/R/Julia/CoffeeScript/OCaml/F#/Tcl и др.; **Dockerfile** по
  имени/расширению + Gemfile/Containerfile/Vagrantfile/`nginx.conf`/`CMakeLists.txt`/
  `build.gradle`; well-known dotfile `.env`/`.bashrc`; неизвестное → `null`), `isEditable`
  (true ⇔ язык распознан), **`editorLangOrPlain`** (всегда отдаёт язык: известный → его,
  неизвестное/без расширения → `plain` Text — позволяет открыть любой файл);
- `stores/workspaces.svelte.ts` (Фаза 12.2) — чистые `isDirty` (content vs base, не при
  loading), `hasUnsaved`, `nextActiveAfterClose` (сохранение неактивного, соседняя/
  предыдущая/терминал); **мутаторы стора** (рунический `$state` под jsdom): `addEditor`
  (loading-док + активация + дедуп по пути), `fillEditor`/`setEditorContent` (загрузка/
  dirty), `markSaved` (новый base+хэш), `failEditor`, `closeEditor` (рефокус),
  `removeWorkspace` + `getWorkspace` (пустой дефолт);
- `sync.ts` (Фаза 12.5, синхронизация) — `compileExclude` (bare-имя по сегменту, glob `*`,
  path-anchored + всё под ним, пустые паттерны), `parseExcludes` (split по `\n`/`,`),
  `diffTrees` (push/pull/bi: новые/изменённые/удаление по флагу, bi → конфликт на расхождении,
  учёт исключений), `applicable` (отбрасывает конфликты), `summarize` (счётчики по op);
- `fileicon.ts` (Фаза 12.6) — `fileIconName`: папка/симлинк сохраняют иконки, маппинг по
  расширению (код/конфиг/shell/образ/архив/ключ), fallback на `file`;
- `servertools.ts` (Фаза 12.8) — `commandNeedsSudo` (sudo-команды → true, pip/brew → false);
- `remotelint.ts` (Фаза 12.7, серверный линт) — `hasRemoteLinter` (какие языки поддержаны),
  `parseLint`: формат `colon` (`FILE:line[:col]: msg`, уровень из ключевых слов, пропуск
  пустых/несовпадающих) и `nginx` (`[emerg] … in FILE:line`, успех → пусто);
- `lscolors.ts` (Фаза 12.x, ls-подсветка) — `isExecutable` (любой x-бит), `lsColorKey`
  (dir/symlink/exec/archive/media → ключ палитры; приоритет symlink>dir>exec), `formatMode`
  (`drwxr-xr-x` + setuid/setgid/sticky, `?` при null), `ownerLabel` (имена → fallback uid/gid),
  `fileTooltip` (права + владелец);
- `snippets.ts` (Фаза 12.6, редактируемые в 12.8) — `defaultSnippets` (уникальные id, непустые
  body/name, свежая копия каждый раз), `snippetsForLang(kind, list)` (фильтр по языку + универсальные
  `null`, над переданным списком), `sanitizeSnippets` (отбрасывает мусор, нормализует неизвестный язык
  в `null`, не-массив → дефолты), `newSnippet` (свежий id);
- `cmtheme.ts` (Фаза 12.2) — `isDark` (классификация фона по яркости, мусор → dark) и
  `editorTheme` (непустой набор расширений для реальной палитры темы). Сам редактор
  [EditorTab.svelte](src/lib/EditorTab.svelte) и [DiffModal.svelte](src/lib/DiffModal.svelte)
  исключены из покрытия (CodeMirror/MergeView-driven, как Terminal/SftpPanel — логика в `.ts`);
- `util.ts` → `lineDiffStat` (Фаза 12.3) — 0/0 для идентичного текста; счёт added/removed;
  multiset (порядок не важен, дубликаты учитываются) — метрика для аудит-записи правок;
- `settings.svelte.ts` → `editor` (Фаза 12.3) — дефолты `{diffBeforeSave,lint}=true`, мердж
  частичного бэкапа, восстановление `resetSettings`; `sftp` + `clampMaxOpenMb` (Фаза 12) —
  дефолт `maxOpenMb=2`, кламп импортируемого значения в `[1,64]` (округление, мусор → дефолт),
  сброс к дефолту;
- `settings.svelte.ts` — `applyImportedSettings` (применение бэкапа: известные
  ключи, дефолты для отсутствующих, merge `customTheme`, игнор мусора) + `language`
  (дефолт `en`, персист, валидация валидного/невалидного кода при импорте);
- `i18n/` — локализация ([i18n.test.ts](src/lib/i18n/i18n.test.ts)): реестр языков и
  гард `isLocale`, `availableLocales` (native-имена); **полнота словарей** (каждый
  язык покрывает все `MessageKey`) и **отсутствие лишних ключей**; **неизменность
  технических терминов** между языками (`CPU`/`RAM`/`Load average`/`Disk I/O`/…);
  чистые `interpolate` (плейсхолдеры `{name}`, числа, неизвестные плейсхолдеры) и
  `resolve` (фолбэк на дефолтный язык/ключ); реактивный `t()` (перевод по
  `settings.language`, фолбэк при мусоре);
- `stores/tabs.svelte.ts` — `localizedStatus` (канонический английский статус →
  текущий язык, в т.ч. `Error: {detail}` и дефолт `Not connected`);
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
  разворот панели), OS-иконка по `title`, состояния ошибки/прочерков; **пороги**
  (жёлтый при превышении среднего, красный — предельного, без цвета ниже порогов) и
  кнопка `open-monitoring` (вызывает `onOpenMonitoring`).
- `MonitoringOverlay.test.ts` — smoke-тест страницы мониторинга (API замокан):
  рендер карточек из живого опроса (ЦП/память/ФС/ядра/разделы/TCP), **ленивая**
  подгрузка pending-updates после первого рендера, красная подсветка раздела при
  превышении порога диска, отсутствие опроса при закрытой странице.
- `Icon.test.ts` — рендер SVG из реестра, размер, accessible-title.
- `Toast.test.ts` — рендер тостов из стора, роль `status`, кнопка Dismiss убирает
  тост (синхронизация с `toastsState`).
- `EmptyState.test.ts` — рендер иконки/заголовка/подсказки, опциональность подсказки,
  слот CTA-кнопок.
- `ViewModeToggle.test.ts` — сегмент «Raw | Table» (0.11.5): `aria-pressed` на
  активном сегменте по пропу `structured`, вызов `onSelect(true/false)` по клику.
- `ConnectingOverlay.test.ts` — окно ожидания подключения (0.11.2): заголовок с
  `alias` и подпись `user@host:port`, `role="status"`; активная фаза с акцентным
  цветом и многоточием, предыдущая фаза как «done». Режим ошибки (0.11.3, проп
  `failed`): упавшая фаза в `text-danger`, заголовок/красная деталь и `role="alert"`,
  скрытие чек-листа при `showSteps={false}`.
- `JsonLogView.test.ts` — табличный JSON-вид (Фаза 10): пустое состояние без записей,
  строка на запись с сообщением, цвет уровня `error` (`text-danger`) в ячейке,
  фильтрация по вводу с обновлением счётчика, нота «нет подходящих записей»,
  скрытие уровня по выключенному чипу, добавление доп. колонки из пикера полей,
  разворот строки (бейдж формата + кнопка копирования), кнопка «Clear» с подтверждением
  (открытие диалога без очистки → подтверждение вызывает `onClear` + сброс колонок;
  отмена сохраняет данные), **изменение ширины колонки** перетаскиванием drag-ручки
  заголовка (pointerdown/move/up меняют `width` в `<colgroup>`), **сегмент «Raw»** в
  тулбаре вызывает `onShowRaw` (а «Table» в табличном режиме — нет).
- `CommandPalette.test.ts` — список команд и фильтрация по вводу, запуск верхнего
  совпадения по Enter и закрытие, запуск по клику, навигация ↑/↓, закрытие по Escape,
  пустое состояние «Ничего не найдено».
- `Skeleton.test.ts` — пульсирующий плейсхолдер (`animate-pulse`, `aria-hidden`),
  применение размеров width/height и доп. классов.
- `Modal.test.ts` — `Modal` (рендер/закрытие по фону и Escape; a11y: `role="dialog"`/
  `aria-modal`/`aria-label`, автофокус первого контроля, фокус-трап Tab/Shift+Tab по
  кругу) и `ConfirmDialog` (колбэки confirm/cancel, accent/danger).
- `TopBar.test.ts` — рендер статуса подключения; проверка, что кнопки «Add server»
  в верхней панели больше нет (перенесена в тулбар списка серверов).
- `ServerTree.test.ts` — рендер папок/серверов, выбор, dbl-click → connect,
  сворачивание папки, фильтр поиска, кнопка «New folder», кнопка «Add server» в
  тулбаре (`add-server` → `onAddServer`), пустое состояние с CTA «Добавить сервер»
  (`empty-add-server` → `onAddServer`).
- `SettingsPanel.test.ts` — секция Backup: экспорт по выбранному пути со снимком
  настроек, отмена экспорта, импорт после подтверждения + вызов `onImported`;
  визуальный пикер тем (свёрнут/раскрытие, выбор → `aria-checked`), сетка шрифтов с
  Python-превью (`font-preview`), поиск по настройкам (фильтр секций, пустое состояние),
  сворачиваемые чекбоксы показателей статус-бара (`metrics-toggle`), **live-переключение
  языка** (`language-select` → заголовок панели меняется на выбранный язык).

Тяжёлые интерактивные компоненты (`Terminal.svelte` — xterm.js,
`SftpPanel.svelte` — нативные диалоги и pointer-DnD, `SettingsPanel.svelte`,
`MonitoringOverlay.svelte` — петля опроса метрик) исключены из **покрытия** (их
чистая логика живёт в покрытых `.ts`-модулях — `thresholds.ts`/`format.ts`), но
поведение всё равно проверяется smoke/компонентными тестами и E2E-набором.

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
src/lib/i18n/i18n.test.ts     # Локализация: словари, t(), фолбэки
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
