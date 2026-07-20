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
  - [Живые SFTP-тесты (`live_sftp`)](#живые-sftp-тесты-live_sftp-фаза-396)
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
  TCP), `parse_sensors` (датчики lm-sensors: label/temp/high/crit, пустые
  high/crit → None, нет строки → пусто), `cpu_breakdown` (user/system/iowait/steal/
  idle % из двух jiffy-сэмплов, нет прироста → None), `parse_top_procs` (pid|user|cpu|
  mem|comm-записи; один парсер по ключу — `topcpu=` для CPU и `topmemp=` для ОЗУ),
  `parse_netdev`/`parse_diskdev`/`parse_sessions` (per-interface
  сеть, per-device диск ×512, сессии `who`), `dev_rate_map` (per-second дельты по
  устройствам, первый опрос → пусто), `parse_detail` (mem/filenr/ulimit/procs +
  **health-скаляры** failed/listen/conntrack/timesync, пустое → None) и `parse_pending`
  (распознавание пакетного менеджера и счётчиков обновлений); плюс
  `detail_script_runs_in_a_shell_and_emits_keys` гоняет `DETAIL_SCRIPT` через `sh`
  (ловит регрессии экранирования awk/ps/ss, в т.ч. строк
  `sensors=`/`cpubreak=`/`topcpu=`/`netdev=`/`diskdev=`/`sessions=`); `parse_extras`
  (GPU/Docker/SMART/OOM из ленивого `EXTRAS_SCRIPT`, пустые поля → None) +
  `extras_script_runs_in_a_shell_and_emits_keys` (в т.ч. hardware-ключи
  `arch=`/`cpumodel=`/`cpucores=`/`virt=`/`vendor=`/`boardname=`/`bios=`…, Фаза 20.16);
  `parse_extras_reads_hardware` (CPU-модель со схлопыванием пробелов, ядра/потоки/сокеты/
  частота, arch/virt/машина/**плата**/bios; пусто → дефолты) и `combine_machine_dedupes_vendor`
  (vendor+name, дедуп когда name уже содержит vendor);
- `metrics/local.rs` (**Фаза 38** — нативный `sysinfo`-коллектор для локальных вкладок) —
  чистые хелперы: `is_loopback` (lo/lo0/Windows Loopback), `is_system_drive` (Windows `C:`),
  `root_disk` (выбор `/`/системного тома, иначе крупнейший, псевдо-mount `total=0` игнор),
  `sum_net` (сумма rx/tx без loopback), `top_procs_label` (ранжирование по CPU + округление);
  плюс smoke-тесты `collect_metrics`/`collect_extras` на **реальной ОС** (mem_total>0, CPU% в
  диапазоне, непустые OS/arch) — проверяют, что sysinfo-путь честно отдаёт метрики этой машины;
- `model.rs` — serde round-trip `ServerProfile`/`NewServerProfile`/`AuthMethod`
  (camelCase, `#[serde(default)]` для старых JSON без `group`/`tags`/**`autoRecord`**/**`noAi`** —
  легаси-профиль → `auto_record:false`/`no_ai:false`/`chat_prompt_id:None`/`exec_mode:None`; round-trip
  сохраняет `autoRecord`/`noAi:true`/`chatPromptId`/`execMode`); **Фаза 21:** round-trip
  вложенного `proxy` (`ProxyKind::Jump`, host/authMethod), легаси-профиль → `proxy:None`,
  `ProxyKind` сериализуется в lowercase (`jump`/`socks5`/`http`);
- `store.rs` — round-trip профилей/папок/known_hosts **через реальный путь записи**
  (`write_atomic` → `read_store` во временном каталоге, `tempfile`), а не декодирование
  собранных руками байтов: атомарная запись — часть того, что обязано round-trip'иться;
  `map_without` (Фаза 33, менеджер known_hosts — удаляет только названный ключ,
  отсутствующий → без изменений);
  - **атомарная запись** (Фаза 44.1) — перезапись существующего файла, создание каталога
    конфига, отсутствие временных файлов после успеха **и** после провала; провал
    `rename` (цель занята каталогом) обязан вернуть ошибку, а не тихо «сохранить».
    `temp_sibling` — скрытый сосед, два вызова подряд не коллизируют;
  - **карантин** (Фаза 44.1) — отсутствующий файл = штатный первый запуск (дефолт, ничего
    не создаётся, предупреждений нет); битый файл переносится в `.corrupt-<nanos>`, его
    **байты сохраняются дословно**, предупреждение несёт путь спасённой копии;
    `take_warnings` дренирует (тост показывается ровно один раз). Отдельным тестом —
    сам сценарий потери: загрузка битого файла + последующее сохранение не должны
    доставать до спасённой копии. Тесты, трогающие глобальный список предупреждений,
    сериализованы своим мьютексом — `take_warnings` дренирует на весь процесс, и
    параллельные потоки иначе воруют предупреждения друг у друга;
  - **форма DTO** (Фаза 44.1) — `StoreWarning` сериализуется ровно так, как объявлено во
    фронте (`quarantined: string | null`): фронт **ветвится** на этом поле, поэтому
    переименование или `skip_serializing_if` тихо превратили бы «данные под угрозой» в
    успокаивающее сообщение;
- `pty.rs` — `pty_size` (кламп размеров локального PTY к ≥ 1×1). Само порождение
  shell-вкладки (`portable-pty`) проверяется вживую/E2E, а не юнит-тестом
  (нужен реальный tty + Tauri-события).
- `lib.rs` — `program_on_path` (Фаза 26, детект шелла для `shell_exists`): резолв
  абсолютного пути к `current_exe`, отказ на пустом/пробельном/несуществующем имени
  и на явном несуществующем пути.
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
  `file-changed`/`dest-exists`/`key-exists`) в `Display`, конверсии
  `From<String>/<io::Error>`, сериализация в строку (контракт с фронтом не меняется).
- `keygen.rs` (Фаза 32, генерация SSH-ключей) — `parse_algorithm` (известные id →
  spec, неизвестный → ошибка); `pub_path_for` (`.pub` дописывается к **всему** имени);
  `expand_tilde` (обычные пути не трогаются, `~/…` → абсолютный); round-trip генерации
  Ed25519 (файлы созданы, `.pub` начинается с `ssh-ed25519`, отпечаток `SHA256:`,
  `load_secret_key` без passphrase проходит); генерация **с passphrase** (без неё
  `load_secret_key` падает, с ней — проходит); отказ на существующем файле без
  `overwrite` (`AppError::KeyExists`), успех с `overwrite`; **права `0600`** на приватном
  ключе (Unix).
- `recording.rs` (Фаза 12.3, аудит) — `annotate` пишет видимое `o`-событие
  `[vterm] …` в asciicast, **даже на паузе** (два события: до и после `set_paused(true)`).
- `localfile.rs` (Фаза 12.4, локальные файлы) — `local_temp` (скрытый sibling, корректный
  parent + bare-имя); async round-trip read/write с **конфликт-проверкой** по sha
  (правильный sha → запись, устаревший → `file-changed`); отказ на **бинаре** (NUL) и
  **слишком большом** файле; `rename` (Фаза 21) — перемещение файла в подпапку и **отказ**
  `dest-exists` при занятом имени; `copy` (Фаза 21) — рекурсивное дублирование дерева
  (оригинал цел) и отказ `dest-exists`; `read_text_returns_full_content` — гейт-регрессия
  на чтение для редактора: `read_text` возвращает **всё** содержимое файла целиком (не
  пустую строку) и `read_only=false` для `0644` (через `tokio::test` + `tempfile`).
- `servertools.rs` (Фаза 12.8) — `parse_status` (mgr + present-bins), `install_command`
  (команда под менеджер: системные с sudo, fallback `pip --user` для yamllint/ruff, distro-имена
  для sensors, бинарь для hadolint, **smartmontools/sysstat по своему имени**, `None` для
  неизвестного; **Фаза B** `install_commands_for_yaml_linters` — `ansible-lint` pip/brew,
  `actionlint`/`kubeconform` brew или серверная загрузка бинаря), `sudoize` (первый `sudo`→`sudo -S`,
  pip/brew без изменений, мульти-sudo — только первый), `build_status` (installed-флаг).
- `sftp.rs` → `parse_id_names` (ls-владелец) — разбор `/etc/passwd`/`/etc/group`
  (`name:x:id:…`, первое имя на id, пропуск битых строк; один парсер для users и groups).
  **Аудит SFTP** (Фаза 37.2): `sftp_mirror` — успех (`[sftp] $ … / exit 0`, без тела-ошибки) и
  провал (тело с текстом ошибки + `exit 1`); мутирующие команды пишут его через `record_sftp`,
  чтения — нет.
- `sync.rs` (Фаза 12.5–12.6) — `shell_quote` (экранирование `'`), `remote_hash_command`
  (квотирование пути + fallback `sha256sum`→`shasum`), `parse_hashsum` (hash+относительный путь,
  `*`-маркер, пробелы в пути, пропуск не-hex/коротких строк), `remote_join`/`local_join`;
  **grep** — `grep_command` (флаги `-rnIi`/`-F`/`-E`, квотирование) и `parse_grep`
  (`path:line:text`, пропуск битых строк); **lint** — `lint_tool` (язык→инструмент, неизвестный →
  `None`) и `lint_command` (`bin args 'tmp' 2>&1`); **валидаторы демонов (Фаза A)** —
  `lint_tool_daemon_validators` (sshd/sudoers/haproxy/bind/systemd: bin/format/`sudo`/`suffix`,
  форма команды у tool с пустыми args), `lint_check_command_includes_sbin` (sbin в `PATH`),
  `lint_tmp_ext_maps_unit_types` (расширение юнита, регистронезависимо, дефолт `service`);
  **YAML-семейство (Фаза B)** — `lint_tool_yaml_dialects` (compose с плейсхолдером `{}` в
  `lint_command` → `docker compose -f 'FILE' config`, ghactions/prometheus/ansible/k8s: bin/format).
- `sftp.rs` (Фаза 12.1, редактор конфигов) — чистые хелперы чтения/записи текста:
  `sha256_hex` против эталонных векторов SHA-256 (пустая строка, `"abc"`);
  `detect_eol` (lf/crlf/одна строка); `apply_eol` (LF→CRLF и обратно, идемпотентность
  на CRLF-входе); `looks_binary` (NUL → бинарь, UTF-8/кириллица → текст);
  `is_read_only` (`0o444` → true, `0o644`/`0o600`/None → false); `temp_sibling`
  (скрытый sibling в той же папке, без `/` для голого имени).
- `sync.rs` (Фаза 39.6, sudo-бэкап) — `sudo_backup_command`: форма `if … then … fi`, а **не**
  `test -e X && cp …`. С `&&` отсутствующий файл (первое сохранение нового root-конфига) даёт
  ненулевой код, маркер не печатается, и «копировать нечего» становится неотличимо от «копия не
  удалась» — а так как провал бэкапа теперь отменяет сохранение, каждое такое сохранение
  отклонялось бы. Плюс `cp -p` (иначе копия ложится по umask вызывающего, и секретный конфиг
  резервируется общедоступным) и квотирование пути с кавычкой.
- `sync.rs` (Фаза 39.8, прогон синхронизации) — `sync_transfer_id`: id выводится из **полного**
  пути (зеркало `syncTransferId` в `sync.ts`) и различает одноимённые файлы в разных каталогах —
  базовое имя из события прогресса этого не может, поэтому строки плана привязать было бы не к
  чему. `sync_mirror_op` квотирует оба корня; `sync_mirror_body` перечисляет операции и
  **выбрасывает конфликты** (запись документирует сделанное, не рассмотренное); кап на 50
  строках с хвостом `… and N more` — иначе прогон на 200 файлов похоронит запись, которую сам
  же должен документировать.
- `error.rs` (дополнено в Фазе 39.6) — маркер `backup-failed` в `Display` и **причина рядом с
  ним**: «не смог сделать копию» без объяснения нечем лечить.
- `sftp.rs` (Фаза 39.6, атрибуты `SETSTAT`) — `chmod_attrs` несёт **только** права, все
  остальные поля `None`: любое лишнее `Some` становится флагом атрибута на проводе, а `size`
  означает `truncate` — именно так обнулялся каждый сохранённый файл.
  `russh_sftp_default_attrs_are_not_blank` фиксирует **причину**: `FileAttributes::default()`
  в крейте — заполненный шаблон «новый каталог», а не пустая структура. Если апгрейд когда-нибудь
  сделает `Default` пустым, тест упадёт и гейт ослабят осознанно, а не по случайности.
  `no_file_attributes_built_from_default` — гейт по всему дереву `src-tauri/src`: ни один литерал
  атрибутов не добирается `Default`. Образцы для поиска собираются в рантайме, иначе гейт
  находит собственные строковые литералы (первая версия так и сделала).
  Round-trip по проводу — в [живых тестах](#живые-sftp-тесты-live_sftp-фаза-396).
- `backup.rs` — экспорт/импорт бэкапа: round-trip серверов/папок/настроек
  (camelCase), отсутствие секретов в JSON, отказ на мусоре и будущей версии,
  минимальный документ, нормализация папок.
- `ai.rs` (Фаза 17, ИИ-брокер) — чистые экстракторы дельт стрима: `openai_delta`
  (`choices[0].delta.content`, None для role-only), `anthropic_delta`/`anthropic_done`
  (`content_block_delta`→`delta.text`, `message_stop`), сборка тел `openai_body`
  (system первым сообщением, `stream:true`) / `anthropic_body` (`max_tokens` дефолт 4096,
  `system` отдельным полем), char-safe `truncate`; `merge_params` (доп-параметры мёржатся верхним
  уровнем, `model`/`messages`/`stream`/`system` защищены; `max_tokens` из params перекрывает дефолт
  Anthropic). Отмена: `cancel_ai_chat` на неизвестном id —
  no-op; на зарегистрированном стриме `notify_one` будит ожидание (`#[tokio::test]`). Список моделей:
  `parse_models` понимает OpenAI (`data[].id`) и Ollama (`models[].name`/`.model`), сортирует+дедупит,
  пустое на неизвестной форме. Ошибки типизированы: 401/403 → `AuthRejected`, сбой соединения →
  маркер `ai-unreachable`; `provider_error_message` достаёт `error.message` из тела Anthropic/OpenAI
  (иначе None → сырое тело). Классификация на фронте — `aiErrorKind`. Сетевой вызов (reqwest) не тестируется.
- `git.rs` (Фаза 29, git-панель) — `shell_quote` (обёртка в `'…'`, экранирование `'`
  как `'\''`), `ssh_command` (квотинг `cwd` и аргументов; инъекция вида `x; rm -rf /`
  остаётся одним аргументом), `git_mirror` (аудит-строка `[git] $ … / [git] exit N`,
  LF→CRLF). Локальный/SSH-исполнитель (`run_local`/`exec_captured`) и сам `git` не
  тестируются (внешний процесс/сеть).
- `netprobe.rs` (Фаза 34, сетевые утилиты) — `probe_command` (квотинг каждого токена;
  инъекция `x; rm -rf /` остаётся одним аргументом; сохранность токена-пайплайна
  `sh -c '<pipeline>'`) и `probe_mirror` (Фаза 36.1 — обёртка `[util] $ … / exit N`,
  LF→CRLF, как `git_mirror`). Сам `probe_run`/`exec_captured` не тестируются (сеть/внешний хост).
- `container.rs` (Фаза 35, Docker-панель) — `container_command` (квотинг каждого токена;
  инъекция `x; rm -rf /` остаётся одним аргументом), `run_local` (несуществующий бинарь →
  `exit 127`+stderr, не `Err`/паника — Фаза 36.6, чтобы фронт классифицировал «не установлен»),
  **`container_mirror`** (Фаза 36 — обёртка `[docker] $ … / exit N`
  для аудита записи, как `git_mirror`). Сам `container_run`/`docker_login`/`exec_captured`
  и `docker` не тестируются (внешний процесс/демон; логин несёт секрет).
- `localenv.rs` (Фаза 36.6, реконструкция PATH локальных спавнов) — `combine_paths`
  (дедуп с сохранением порядка login→process→каталоги, пропуск пустых), `resolve_program`
  (поиск бинаря по PATH → абсолютный путь; passthrough явного пути; miss → имя как есть),
  `parse_marker_line` (выбор PATH после маркера из шумного stdout login-шелла). Сам запрос
  login-шелла (`$SHELL -ilc`) не тестируется (внешний процесс).
- `textenc.rs` (Фаза 39, кодировки редактора) — `decode`/`encode` round-trip для каждой
  ветки определения: чистый UTF-8, UTF-8 с BOM (BOM не попадает в текст, но возвращается
  при сохранении), UTF-16LE с BOM и **без** BOM (sniff по NUL-паттерну), UTF-16BE,
  легаси-кодировка (CP1251 — кириллический конфиг). Отдельно негативные кейсы: ELF-заголовок
  остаётся «бинарным», а UTF-8 с одиночным NUL **не** принимается за UTF-16; пустой файл →
  пустой UTF-8; неизвестная метка → фолбэк UTF-8. Сам файловый ввод-вывод не тестируется.
- `proccwd.rs` (Фаза 39.3, cwd локальной оболочки) — читает cwd **собственного процесса**
  на той ОС, где идёт прогон, и сверяет с `std::env::current_dir` (канонизируя пути: на macOS
  `/var` отдаётся как `/private/var`). Это единственный процесс, чей cwd можно утверждать без
  мока ОС, зато проверяется **реальный платформенный путь** — `/proc` на Linux, `proc_pidinfo`
  на macOS, PEB на Windows. Второй кейс: несуществующий pid → `None`, а не ошибка/паника
  (отказ здесь — штатный исход).
- `drives.rs` (Фаза 39.1, уровень «Этот компьютер») — `drive_letters` (декодирование маски
  `GetLogicalDrives`: типовой набор C+D, дисковод A+C, граничный бит `Z`, пустая маска,
  отбрасывание битов 26+ — иначе за `Z` пошли бы `[`, `\`), `drive_kind` (все семь значений
  `GetDriveTypeW` + неизвестное будущее → `unknown`), **`should_enrich`** (правило «не трогать
  сетевые и оптические диски» — закреплено тестом, чтобы его не «упростили» в обход всех
  дисков: обращение к отвалившейся SMB-шаре блокируется на таймаут), `drive_entry` (запись —
  каталог по пути **корня** диска, без выдуманных прав/владельца). Сами Win32-вызовы не
  тестируются (нет Windows), но **кросс-проверяются компилятором** — см. ниже.
- `localfile.rs` (Фаза 39, Windows-атрибуты) — `dos_attr_string`: фиксированные слоты
  `d/a/r/h/s` (`-a---` обычный файл, `d----` каталог, `-arh-` read-only+скрытый,
  `d--hs` скрытый системный каталог, `-----` без атрибутов), неизвестные биты
  (COMPRESSED/ENCRYPTED) не сдвигают слоты. Форматирование компилируется и тестируется на
  **всех** ОС (только сам lookup под `cfg(windows)`), поэтому регрессия ловится и на macOS.

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

### Кросс-проверка Windows-кода без Windows-машины (Фаза 39.1)

Блоки под `#[cfg(windows)]` на macOS/Linux **не компилируются вообще**, поэтому опечатка в
Win32-сигнатуре всплыла бы только на Windows-сборке — а `build:windows`/`lint:windows` стоят
`when: manual` (раннера нет). Фаза 38.1 установила, что «в лоб» это не решается:
`cargo clippy --target x86_64-pc-windows-msvc` падает на `aws-lc-sys` (компилирует C, нужен
Windows SDK), не доходя до нашего кода.

Обходной приём — **изолированный крейт**: копия FFI-модуля с единственной зависимостью
`windows-sys` (чистый Rust, SDK не нужен), крейт-локальные типы подменены заглушками
структурно того же вида. Тогда работает:

```sh
rustup target add x86_64-pc-windows-msvc
cargo check --target x86_64-pc-windows-msvc              # то же, что build:windows
cargo check --target x86_64-pc-windows-msvc --all-targets # то же, что lint:windows
```

Проверяются сигнатуры, типы указателей, имена констант и feature-гейты. **Не** проверяются
рантайм-поведение и линковка — для этого по-прежнему нужна Windows. Приём окупился сразу:
поймал два `dead_code`-предупреждения, видимых только на Windows-сборке. Применяйте его для
любого нового `#[cfg(windows)]`-блока с FFI.

---

## Фронтенд-тесты (Vitest)

Конфигурация — [vitest.config.ts](../vitest.config.ts) (отдельная от dev-конфига
Tauri/SvelteKit): плагин Svelte + `svelteTesting()`, среда **jsdom**, алиас
`$lib`. Глобальная подготовка — [vitest-setup.ts](../vitest-setup.ts) (матчеры
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
  `diskFree` (статус-бар), `isUnlimitedLimit`/`fmtLimit` (потолок ~i64::MAX →
  «без лимита»/`∞`, реалистичные значения и null — ограничены/прочерк);
- `monhealth.ts` — health-уровень по блокам: `worstLevel` (выбор худшего),
  `loadCoreLevel`, `sensorLevel` (свои crit/high → иначе cpuTemp-порог), `cpuHealth`/
  `memHealth`/`fsHealth` (по порогам из настроек, ∞-FD игнор), `loadHealth` (load1 +
  load/ядро), `netHealth` (warn при errors/drops), `tempHealth`/`hasTempData`,
  `extrasHealth` (SMART≠PASSED→crit, OOM→warn).
- `thresholds.ts` — `thresholdLevel` (ok/warn/crit, включительные границы, crit
  важнее warn, null-значение/порог → ok, по-уровнево отключаемые границы),
  `levelTextClass`/`thresholdClass` (уровень → `text-warn`/`text-danger`);
- `util.ts` — `debounce` (с fake-таймерами), `isHidden`, `matchesQuery`
  (AND-подстрока, регистронезависимость, пустой запрос → всё);
- `tabteardown.guard.test.ts` (Фаза 44.2) — снос вкладки: сырой `closeTab` из стора
  импортируется **одним** файлом (`+page.svelte`), вызывается **ровно один раз** и внутри
  `closeTabFully`, сам снос содержит все четыре очистки по `sessionId`
  (`removeWorkspace`/`removeChat`/`removeBroadcastMember`/`nginxConfigCache.delete`), а
  массового `closeTabsForServer` нет ни в экспортах стора, ни в импортах. Проверен на
  живых нарушениях: второй вызов `closeTabStore(` и убранный `removeBroadcastMember` —
  оба пойманы. Проверка на массовый закрыватель **структурная** (export/import-спецификаторы),
  потому что текстовый поиск имени падал на доке, объясняющей его отсутствие;
- `metrics/mod.rs` → `clear_session_covers_every_field_of_the_struct` (Фаза 44.2) — читает
  объявление `MetricsSamples` из исходника и требует каждое поле в `clear_session`.
  Соседний `clear_session_removes_every_sample_store` перечисляет восемь стора руками и
  **не заметил бы девятого** — именно так выжила исходная утечка net/disk (Фаза 18.1).
  Проверен добавлением поля `leak_samples`: гейт падает и называет его;
- `storewarn.ts` (Фаза 44.1) — `storeWarningMessage`: спасённый файл → ключ
  `store.corruptSaved` с базовым именем файла (тост, а не свалка путей) и **полным**
  путём спасённой копии; неспасённый → **другой ключ** `store.corruptStuck` с полным
  путём. Проверяется именно расхождение ключей: «данные спасены» и «данные под угрозой» —
  разные новости, и подать вторую как первую значит повторить ту самую ошибку, ради
  которой всё делалось. Плюс базовое имя из Windows-пути и голое имя файла без каталога;
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
  и `null` → как таймингованные); **полоса активности** (`activityBuckets`, Фаза 42):
  раскладка вывода по корзинам времени, событие ровно на конце попадает в последнюю (не
  за границу), **события ввода игнорируются** (набранная команда не должна перевешивать
  проехавшую сборку), **лог-шкала** — 2 КБ болтовни рядом с 5 МБ `cat` остаются видимыми
  (на линейной шкале это 0,0004 от высоты, т.е. снова плоская полоса), «всплеск» меряется
  от медианы **непустых** корзин, поэтому долгие простои не помечают всплеском всё подряд;
  нулевая длительность и бессмысленное число корзин не роняют вид;
- `actions/clipboardKeys.ts` — `isEditable` (text-like input/textarea — да; чекбокс/
  div/readonly/disabled/`.xterm`-textarea — нет), `selectedText`/`replaceSelection`
  (вставка по каретке + событие `input`; замена всего значения для `type="number"`
  без selection API) и глобальный `handleClipboardShortcut`: вставка по Cmd+V и
  Ctrl+V (вкл. number-поле), копирование/вырезание выделения, select-all по Cmd+A,
  игнор не-редактируемых целей (терминал) и обычных/Alt/Shift-нажатий (модуль
  `../clipboard` замокан, проверка без Tauri/navigator);
  `copyDocumentSelection` — копирование выделения обычного текста **вне** input/
  textarea (превью Markdown) через `writeClipboard`, `false` при схлопнутом
  выделении и для выделений внутри `.cm-editor`/`.xterm` (там своё копирование),
  и ветка Cmd/Ctrl+C с `preventDefault` для не-input цели в `handleClipboardShortcut`;
- `actions/tooltip.ts` (Фаза 20.17) — экшен подсказки: пузырёк с `role="tooltip"`
  **портируется в `document.body`** (не внутри триггера), убирается по `mouseleave`/
  `blur`; пустой текст → ничего; `update()` переименовывает открытый пузырёк;
  `destroy()` убирает его и снимает слушатели. **Тайминг (20.17.3, fake timers):**
  hover — с ~500мс задержкой (отменяется, если увести курсор раньше), `focus` —
  мгновенно, а **skip-window** ~300мс показывает подсказку сразу, если другая только
  что закрылась;
- `themes.ts` — целостность палитр (терминал — всегда hex; у фирменных тем `ui`-панели
  допускают rgba), группа light/modern/retro/**signature**, наличие светлых тем,
  фирменная тройка `deep-well`/`aurora`/`glass` **с** `backdrop`+`overlay` (у классических
  их нет), дефолт **Deep Well**, `themeSwatches`, `getTheme`, `applyUiPalette`;
- `AppLogo.svelte` — `AppLogo.test.ts` (Фаза 27): рендерит логотип с `aria-label`, у
  фирменной темы фон-квадрат = её `backdrop`-градиент, у классической — `var(--color-panel)`;
- `ThemeOverlay.svelte` — `ThemeOverlay.test.ts` (Фаза 27): у фирменной темы рендерит
  полноэкранный `position:fixed; pointer-events:none` слой глубины с градиентом `overlay`;
  для классической и `custom` — не рендерит ничего;
- `settings.svelte.ts` — дефолты (в т.ч. `recordIdlePauseSecs: 20` — пауза записи при простое),
  persist в `localStorage`, `activeTerminalTheme`,
  `applyActiveTheme` (Фаза 20.10 — пресет пушит `--color-*` на `documentElement`,
  зеркалит панель на `documentElement.style.backgroundColor` и персистит в
  `CHROME_PANEL_KEY` для анти-FOUC boot-скрипта в `app.html`; custom-тема оставляет
  CSS-дефолты),
  `resetSettings` (рунический модуль — эффекты прогоняются через `flushSync`),
  `statusBarThresholds` (числовые дефолты, deep-merge бэкапа с сохранением
  дефолтов для отсутствующих метрик, явный `null` = отключено, отсев мусора),
  `smartLogs` (Фаза 10: дефолты — всё включено; merge частичного бэкапа с
  сохранением дефолтных под-флагов; восстановление `resetSettings`),
  `highlightRules` (Фаза 10: посев стартовых правил, в т.ч. green `success` + поля
  стилей `wholeLine/bold/background`; санитизация импортируемого массива — отсев
  мусора, фолбэк цвета/`enabled`, коэрсия булевых стилей; восстановление `resetSettings`),
  `searchOptions` (Фаза 10: дефолты off; persist/reload; merge частичного бэкапа;
  восстановление `resetSettings`),
  `windowsShell`/`localShellPath` (Фаза 26 — локальный шелл: дефолт `cmd`/пусто,
  persist выбора и custom-пути, импорт валидных значений с фолбэком мусора к дефолтам);
- `stores/layout.svelte.ts` — дефолты, persist ширин/сворачивания, `clamp`;
- `stores/tabs.svelte.ts` — `openTab` (kind `ssh`)/`openLocalTab` (kind `local`,
  пустой `serverId`, алиас «Local shell»)/`closeTab`/`moveTab`/`setTabStatus`,
  переназначение активной вкладки, чистые `statusLabel`/`dotClass`/`isLive`,
  `isMonitorable` (**Фаза 38** — гейт status bar/мониторинга: SSH **и** local + `Connected` →
  true; `Connecting`/`Disconnected`/`Error`/`null`/`undefined` → false),
  `serverDots` (Фаза 20.12 — статусы SSH-вкладок → `dots: {cls, pulse}[]`: цвет+тональная
  обводка, `pulse` только на `Connecting`; рендер в **tab-order** (новая вкладка — кружок
  в конец стопки), но при переполнении _выбор_ показанных severity-first чтобы ошибка не
  пряталась под капом; кап 3 + `extra` overflow, `bg-muted`-fallback, пустой список),
  `nextTabIndex` (роуминг ←/→ с заворотом, Home/End, null для прочих клавиш/пустого),
  `newTabAction` (Фаза 20.15 — ⌘/Ctrl+T: SSH-вкладка → `{kind:"ssh", serverId}`; локальная
  вкладка/`null`/`undefined` → `{kind:"local"}`), `tabsForServer` (Фаза 44.2 — перечисляет
  сессии сервера и **ничего не закрывает**: закрывающая половина обязана пройти через
  `closeTabFully`, см. гейт `tabteardown.guard.test.ts`; прежний `closeTabsForServer`
  ронял строки в обход сноса);
- `connphase.ts` — окно подключения (0.11.2): `phaseSteps` (первая фаза `active`,
  остальные `pending`; ранние → `done`, поздние → `pending`; `errored` красит
  активную фазу в `error`; неизвестная фаза → первый шаг `active`) и порядок
  `PHASE_ORDER`, совпадающий со стадиями бэкенда; **Фаза 21 (proxy-подстадии):** без
  `proxy` группы нет (все шаги `group:"server"`); `proxy:"jump"` даёт три подшага
  (`proxyConnecting`/`proxyAuthenticating`/`proxyTunnel`, `group:"proxy"`) перед целью,
  `proxy:"tcp"` — два (`proxyConnecting`/`proxyHandshake`); состояние `done`/`active`/
  `error` по позиции, провал замирает на нужном подшаге;
- `stores/toasts.svelte.ts` — `notify`/`notifyError`/`notifySuccess`/`notifyInfo`,
  авто-дисмисс по `TOAST_TTL` (fake-таймеры), кастомный ttl и sticky (`ttl=0`),
  `dismissToast` (снятие таймера), `clearToasts`;
- `stores/transfers.svelte.ts` — `aggregateTransfers` (активные/суммарный %/
  направление, приоритет upload), `applyProgress` (upsert, авто-удаление done по
  `DONE_LINGER_MS` с fake-таймерами), `removeTransfer`; **скорость** (Фаза 42, часы
  подменяются через `setTransferClock`): байты/с из соседних снимков, истории разных
  переносов не смешиваются, завершённый перенос теряет скорость (100 % со скоростью
  читается как «ещё едет»), и повторно использованный id **не наследует** старую историю;
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
  `exportBackup`/`importBackup` и backup-диалоги, **Фаза 26:** `hostOs` → `host_os`,
  `shellExists` → `shell_exists`, `openLocalTerminal` с `shell` (`null` по умолчанию и
  явная программа)) + `isFileChangedError`
  (матч маркера `file-changed`, игнор посторонних ошибок) + `isPermissionError`
  (матч `permission denied`/`no such file` — отказ доступа, при котором предлагается sudo);
- `localshell.ts` (Фаза 26, чистый резолв локального шелла) — `windowsShellProgram`
  (пресеты → `powershell.exe`/`pwsh.exe`, `cmd`/`custom` → `null`), `resolveLocalShell`
  на Windows (пресеты, custom с trim/фолбэком, игнор `localShellPath` для не-custom) и на
  macOS/Linux (непустой путь = override `$SHELL`, пусто = дефолт ОС);
- `editorlang.ts` (Фаза 12.2) — `baseName`/`fileExt` (lower-case расширения, dotfile
  без расширения), `editorLangFor` (известные расширения → язык: config-форматы, **скрипты/
  ЯП** Python/JS/TS/Java/Go/Rust/Ruby/C·C++·C#/SQL/PowerShell/Lua/Perl, **markup** HTML/CSS/
  SCSS/Less/XML, **DevOps** nginx/CMake/diff/Protobuf/Puppet, Groovy/Scala/Kotlin/Dart/Swift/
  Clojure/Haskell/Erlang/Elm/R/Julia/CoffeeScript/OCaml/F#/Tcl и др.; **Dockerfile** по
  имени/расширению + Gemfile/Containerfile/Vagrantfile/`nginx.conf`/`CMakeLists.txt`/
  `build.gradle`; well-known dotfile `.env`/`.bashrc`; **валидаторы демонов (Фаза A)** —
  `sshd_config`+`sshd_config.d/` (и негатив на клиентский `ssh_config`), `sudoers`+`sudoers.d/`,
  `haproxy.cfg`/дерево `haproxy/` (негатив на одиночный `.cfg`), `named.conf*` (BIND),
  systemd-юниты по расширению; **YAML-диалекты (Фаза B)** — `docker-compose`/`compose` по имени,
  `.github/workflows/` (негатив на yaml вне workflows), `prometheus.yml`, Ansible (плейбуки/роли),
  плюс `yamlDialectFromContent`/`editorLangWithDialect` (k8s по `apiVersion`+`kind`, Ansible по
  `hosts`+`tasks`, апгрейд только generic-`yaml`, имя-детект compose не перебивается); неизвестное →
  `null`), `isEditable`
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
  **прогресс прогона** (Фаза 39.8) — `syncTransferId` (совпадает с `sync::sync_transfer_id`,
  различает одноимённые файлы в разных каталогах), `syncRowStatus` (фаза + прогресс; после
  остановки строки читаются «не выполнено», а не «в очереди»; конфликт всегда `skipped`),
  `syncRowPct` (кламп/округление, `done` без байтов = 100 %), `syncRunSummary` (счёт по
  применимому плану, вес завершённого файла целиком, план из одних удалений доходит до 100 %);
- `stores/syncrun.svelte.ts` (Фаза 39.8) — чужие id (обычные переносы панели) игнорируются;
  строки прогона пишутся по id; **завершённые не истекают** (в отличие от `transfers`-стора с
  его `DONE_LINGER_MS`, иначе галочки гасли бы посреди прогона); очистка между прогонами;
- `SyncModal.test.ts` (Фаза 39.8, компонентные) — во время прогона строка завершённого файла
  получает галочку, текущего — свой процент, шапка считает «файл N из M»; «Остановить» зовёт
  `sftpCancel` **своим** `runId` из вызова `sftpSyncApply`; после остановки окно **не
  закрывается**, показывает плашку и «не выполнено», «Применить» заблокирована, доступно
  «Сравнить заново»; чистый прогон закрывает окно;
- `fileicon.ts` (Фаза 12.6) — `fileIconName`: папка/симлинк сохраняют иконки, маппинг по
  расширению (код/конфиг/shell/образ/архив/ключ), fallback на `file`;
- `servertools.ts` (Фаза 12.8) — `commandNeedsSudo` (sudo-команды → true, pip/brew → false);
- `ToolInstallDialog.test.ts` (Фаза 20.14) — установка серверного инструмента: клик
  «Install via sudo» → появляется индикатор прогресса + консоль; чанк из канала
  `install://out/{id}` (замок `listen`) попадает в консоль; завершение → состояние
  успеха + `onInstalled` + `notifySuccess` + снятие слушателя; провал → `notifyError`
  без успеха, кнопки восстановлены;
- `remotelint.ts` (Фаза 12.7, серверный линт) — `hasRemoteLinter` (какие языки поддержаны,
  включая валидаторы демонов Фазы A), `parseLint`: формат `colon` (`FILE:line[:col]: msg`,
  уровень из ключевых слов, пропуск пустых/несовпадающих) и `nginx` (`[emerg] … in FILE:line`,
  успех → пусто); **валидаторы демонов (Фаза A)** — `sshd` (`FILE: line N:` + сводки без номера,
  пустой вывод → чисто), `visudo` (`near line N`, снятие `>>> … <<<`, `parsed OK` → чисто),
  `haproxy` (тег `[ALERT]`/`[WARNING]` → уровень + `[FILE:N]`, `valid` → пусто), `systemd`
  (ключевые `FILE:N:` + непривязанные ошибки на строке 1, чистый юнит → пусто); **YAML-семейство
  (Фаза B)** — `hasRemoteLinter` для compose/ghactions/prometheus/ansible/k8s и формат `generic`
  (compose/promtool/kubeconform: только строки-проблемы, номер строки если есть, success/пусто →
  чисто, kubeconform `invalid`-строка на строке 1);
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
  [EditorTab.svelte](../src/lib/EditorTab.svelte) и [DiffModal.svelte](../src/lib/DiffModal.svelte)
  исключены из покрытия (CodeMirror/MergeView-driven, как Terminal/SftpPanel — логика в `.ts`);
- `cspnonce.test.ts` (Фаза 36.4) — фикс «стили редактора не применяются в `tauri build`». В
  упакованной сборке Tauri штампует пер-загрузочный nonce в CSP `style-src`, что по спецификации
  отменяет `'unsafe-inline'` и блокирует runtime-`<style>` CodeMirror (`.sheet === null`) → ни
  раскладка baseTheme, ни цвета `cmtheme.ts`, ни подсветка не применяются. Тесты: `firstNonce`
  (чистая — первый непустой nonce, `''` если нет); `readStyleNonce` (jsdom — читает nonce с
  инлайнового `<style>`, пусто без nonce); `cspNonceExtension` (возвращает extension); плюс
  **гейт-регрессия**, что [EditorTab.svelte](../src/lib/EditorTab.svelte) и
  [DiffModal.svelte](../src/lib/DiffModal.svelte) импортируют и вызывают `cspNonceExtension()`
  в extensions (общий style-module создаётся на первом `EditorView`, nonce обязан быть у каждого);
- `util.ts` → `lineDiffStat` (Фаза 12.3) — 0/0 для идентичного текста; счёт added/removed;
  multiset (порядок не важен, дубликаты учитываются) — метрика для аудит-записи правок;
- `settings.svelte.ts` → `editor` (Фаза 12.3) — дефолты `{diffBeforeSave,lint}=true`, мердж
  частичного бэкапа, восстановление `resetSettings`; `sftp` + `clampMaxOpenMb` (Фаза 12) —
  дефолт `maxOpenMb=2`, кламп импортируемого значения в `[1,64]` (округление, мусор → дефолт),
  сброс к дефолту;
- `settings.svelte.ts` — `applyImportedSettings` (применение бэкапа: известные
  ключи, дефолты для отсутствующих, merge `customTheme`, игнор мусора) + `language`
  (дефолт `en`, персист, валидация валидного/невалидного кода при импорте);
- `i18n/` — локализация ([i18n.test.ts](../src/lib/i18n/i18n.test.ts)): реестр языков и
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

**«Следовать за терминалом» (OSC 7 shell-integration, Фаза 21):**

- `osc.test.ts` — `parseOsc7`: `file://host/path` → путь, URL-декод, Windows-URI,
  корень, невалидные/относительные payload'ы → null.
- `oscpipe.test.ts` — реальный `@xterm/xterm` вызывает наш OSC 7-обработчик как для
  сырой последовательности, так и после `applyHighlight` (эскейпы не ломаются).
- `localfollow.test.ts` / `sftpfollow.test.ts` — панель навигирует при смене пропа
  `terminalCwd` (для SFTP — после connect); ручная навигация не «отскакивает».
- `shellintegration.test.ts` — `OSC7_SETUP`: содержит `printf` OSC 7, идемпотентен,
  ведущий пробел (вне истории), немедленный вызов эмиттера; `osc7SetupDisplay()` без пробела.
- `termzoom.test.ts` (Фаза 21, чистая логика) — `accumulatePinch`: порог шага,
  рост/уменьшение по знаку `deltaY`, мультишаг с остатком, накопление дробных дельт,
  кламп на границах 8–32 с дренажом аккумулятора.
- `filemove.test.ts` (Фаза 21, чистая логика) — `parentDir`/`baseName`/`joinPath` и
  `checkMove` (перемещение внутри панели): корректный путь-назначение, отказы
  self / в-свой-потомок / no-op, различение соседа с общим префиксом имени
  (`/a/proj` vs `/a/proj2`), нормализация хвостовых слэшей; `uniqueCopyName`
  («… copy» → «… copy 2», поиск первого свободного номера, нормализация уже-`copy`
  суффикса, dotfile без расширения).
- `multiselect.test.ts` (Фаза 21, чистая логика) — `clickSelect`: обычный клик
  (одна запись + якорь), Ctrl/Cmd-клик (добавить/убрать), Shift-диапазон в обе
  стороны, замена диапазона с сохранением якоря, фолбэк на одиночный выбор при
  отсутствующем/устаревшем якоре.
- `filekeys.test.ts` (Фаза 21, чистая логика) — клавиатура списка файлов:
  `nextCursor` (вниз/вверх с клампом, Home/End, Page с клампом, старт с `-1`,
  null на не-навигационных клавишах/пустом списке) и `scrollForCursor`
  (курсор уже виден / выше / ниже вьюпорта, с учётом строки «..»).

**Гейты безопасности (юнит, в обычном `pnpm test`):**

- `autonomy.guard.test.ts` — нет runtime-обращений в сеть (fetch/WebSocket/CDN/
  аналитика). См. [Сеть и автономность](../README.md#сеть-и-автономность).
- `tauri-security.guard.test.ts` — CSP задан и строгий, capabilities минимальны,
  opener ограничен `https://`, нет `dangerous*`. См. [SECURITY.md](../SECURITY.md).

**Supply-chain / SAST (отдельная стадия `security` в CI, локально по желанию):**
`cargo audit` + `cargo deny check` (Rust), `pnpm audit` + **Semgrep**
(`p/typescript`/`p/javascript`/`p/secrets`), **Trivy** (`fs`). Принятые
исключения и обоснования — [SECURITY.md](../SECURITY.md) и
[src-tauri/deny.toml](../src-tauri/deny.toml).

- `fspath.test.ts` (Фаза 39) — сепаратор-осознанная путевая арифметика: `isRoot`
  (POSIX `/`, корень диска `C:\`/`C:/`/`C:`, UNC `\\server\share` с трейлингом и без),
  `parentOf` (подъём по обоим сепараторам; **остановка** на корне диска — регрессия на
  «путь стал `/` в корне `C:`»; корень сам себе родитель; голое имя без родителя),
  `sep`/`joinPath` (сохранение уже использованного сепаратора, без удвоения),
  `baseName`, `isUnder` (регистронезависимость и смешанные сепараторы на Windows,
  регистрозависимость на POSIX — это чинит «перетаскивание папки в собственное поддерево»
  в `filemove`).
- `drives.test.ts` (Фаза 39.1) — вид строки диска: `driveDisplayName` (`Windows (C:)`, откат
  на голую букву без метки), `driveIcon` (оптический/сетевой отличаются от локального),
  `driveKindKey`, `driveUsage`/`driveUsedFraction` (**null** для необследованного диска и для
  тома нулевой ёмкости — вместо «0 Б свободно из 0 Б» и деления на ноль; кламп доли, т.к.
  квотируемое «доступно вызывающему» может превысить общий объём и переполнить полосу).
- `localdrives.test.ts` (Фаза 39.1, компонентный) — **полный круг навигации**: `..` есть в
  корне `C:\` и ведёт на `DRIVES_ROOT`, оттуда можно зайти в `D:\` (ровно та функция, что
  была недоступна); на самом уровне дисков `..` нет; метка+свободное место рисуются, а диск
  без данных о размере показывает название типа; строка пути показывает «Этот компьютер», а
  не сентинел; создание файла/папки на уровне дисков **заблокировано**, а в обычном каталоге
  — нет; **POSIX не задет** (в `/` по-прежнему нет `..`).
- `fspath.test.ts` (дополнено в Фазе 39.1) — `isDriveRoot` и `navParent`: из корня диска вверх
  на `DRIVES_ROOT`, с него — некуда; обычные каталоги идут как `parentOf`; POSIX-корень и
  UNC-шара — тупики; пустой путь (состояние панели до первой загрузки) не путается с
  сентинелом.
- `terminput.test.ts` + `terminput.guard.test.ts` (Фаза 39.5) — чем завершается команда,
  отправляемая в PTY. Ключевое утверждение: терминатор — **CR**, а не LF, потому что CR это
  то, что шлёт клавиша Enter (с LF команда вставлялась в Windows-промпт и не выполнялась;
  на Linux/macOS проходило лишь потому, что readline/ZLE вешают `Ctrl+J` на `accept-line`).
  `submitBlock` переводит **каждую** строку многострочного блока, иначе на Windows выполнилась
  бы только последняя — шелл сделал бы не то, что показано. Гейт сканирует исходники на
  `encode(… \n …)`. **Гейт проверен на настоящем нарушении** (временно возвращали LF в
  GitPanel) — первая версия его регулярки нарушение пропускала, так что гейт без такой
  проверки не гарантирует ничего.
- `clipboardpaste.guard.test.ts` (Фаза 39.6) — позицию курсора после вставки **нельзя** считать
  от длины строки из буфера обмена. CodeMirror нормализует переводы строк при вставке, поэтому
  CRLF-текст (любая многострочная вставка из Windows-приложения) ложится в документ **короче**
  исходной строки: `anchor: from + text.length` уходил за границу, `state.update()` бросал
  `RangeError` **до** применения изменений, внутри необработанного `.then()` — тихий и полный
  провал вставки. На macOS не воспроизводилось (буфер в LF), однострочный текст проходил — баг
  читался как «вставляет только по одной строке». Помимо скана исходников гейт **закрепляет
  причину** двумя тестами на само поведение CodeMirror: документ короче строки, и старая форма
  действительно бросает. Правильная форма — `view.state.replaceSelection(text)`.
- `passwordinput.guard.test.ts` (Фаза 39.7) — ни одного сырого `<input type="password">` вне
  примитива [PasswordInput.svelte](../src/lib/PasswordInput.svelte). До этой фазы таких полей
  было **девять** в семи файлах — одинаковые четыре строки, скопированные по месту, и ни в
  одном нельзя было увидеть набранное. Гейт существует ровно затем, чтобы десятое поле не
  написали снова по-старому: правка «добавить глазик в каждую копию» такую гарантию не даёт.
  Вторым тестом гейт проверяет, что примитив всё ещё рендерит настоящий password-инпут — иначе
  скан охранял бы пустоту.
- `clipboardKeys.test.ts` (дополнено в Фазе 39.6) — та же ловушка для `<textarea>`: его `value`
  по спеке нормализует CRLF в LF, поэтому каретка, посчитанная от исходной строки, уезжала за
  конец (браузер клампил — тихо, но неверно). Теперь измеряется по сохранённому значению.
- `cdterminal.test.ts` (Фаза 39.4) — построение команды `cd` для двустороннего следования.
  `cdShellKind`: OS-дефолт (cmd на Windows, POSIX иначе), семейство PowerShell по полному пути,
  и **POSIX-оболочка, установленная на Windows** (Git Bash) — кейс, который наивное правило
  «windows ⇒ cmd» ломает. `cdCommand`: POSIX-квотинг с `'\''`, PowerShell с удвоением кавычки
  и `-LiteralPath` (скобки в имени легальны и иначе стали бы шаблоном), cmd с двойными
  кавычками и **`/d`** (без него смена диска не переводит туда). Отказы: пустой путь → `null`
  (голый `cd` увёл бы в домашний каталог) и путь с переводом строки → `null` (иначе вторая
  команда выполнилась бы).
- `localdrives.test.ts` (дополнено в Фазе 39.4) — двустороннее следование локальной панели:
  открытие папки и подъём сообщаются наверх, при выключенном тумблере — молчание,
  **переход, сделанный при следовании за терминалом, обратно не зеркалится** (защита от петли),
  и на уровне дисков `cd` не шлётся. Последние два — те, ради которых тесты и писались:
  первый ловит петлю, второй поймал реальный баг с `$derived`, пересчитавшимся после загрузки.
- `osc.test.ts` (дополнено в Фазе 39.3) — `parseOsc9` (windows-диалект OSC 9;9): голый
  windows-путь, путь **в кавычках** (их добавляют профили PowerShell из документации
  Microsoft), POSIX и UNC, `file://`-вариант. **Ключевой негативный кейс:** прочие подтипы
  OSC 9 (`9;4` — индикатор прогресса, уведомления) дают `null`, иначе панель уехала бы по
  значению вроде `4;3;70`.
- `shellintegration.test.ts` (дополнено в Фазе 39.3) — `needsShellSetup`: для **локальной**
  вкладки диалог настройки не показывается никогда (её cwd читается у ОС) — это и была та
  преграда, из-за которой фича выглядела нерабочей на стоковом zsh; для SSH — показывается,
  только если удалённый шелл ещё ничего не сообщил и сниппет не вписан в этой сессии.
- `pathbar.test.ts` (Фаза 39.2, компонентный, обе панели) — редактируемая строка пути:
  предзаполнение текущим путём и переход по Enter; отмена по **Escape** и по **blur** (клик
  мимо не должен уводить по недонабранному пути); no-op на пустом вводе и на текущем пути;
  вставка пути **в кавычках** из Проводника; раскрытие `~`; **инлайн-ошибка** на
  несуществующем пути (а не молчаливый no-op); переход на другой диск по голой букве `D:`;
  в SFTP — **зеркалирование в терминал** при «следовать за терминалом» и его отсутствие при
  отмене. Tauri-webview замокан: `SftpPanel` подписывается на drag-drop при монтировании, и
  без мока Vitest сыпал unhandled-ошибками, способными маскировать реальные падения.
- `fspath.test.ts` (дополнено в Фазе 39.2) — `normalizeInputPath`: снятие кавычек (и
  **несовпадающая** кавычка остаётся как есть, а не калечит путь), раскрытие `~` только при
  известном home, срезание хвостового разделителя кроме корня, схлопывание дублей **с
  сохранением** ведущего `\\` UNC, голая буква диска → корень, пустой ввод → `null`.
- `hostcaps.test.ts` (Фаза 39) — классификация `Metrics.os` в семейство ОС для обоих
  транспортов (`System::name()` локально: `Windows`/`Darwin`/`Ubuntu`; `uname -s` по SSH:
  `Linux`/`Darwin`/`FreeBSD`), включая POSIX-слои на Windows (`MINGW64_NT-…`, `CYGWIN_NT-…`,
  `MSYS_NT-…`). Гейты: `supportsLoadAverage` (false только на Windows),
  `supportsSensorsInstall` (true только на Linux — «Установить lm-sensors» это apt-пакет),
  `supportsTemperature`. **Ключевой кейс:** пустая/неизвестная ОС → карточки остаются
  видимыми (пустота значит «ещё не опрошено», а не «невозможно»).
- `diagpath.guard.test.ts` (Фаза 39, гейт) — ни один `.svelte`/`.ts` в `src/` не содержит
  `/tmp/…`-литерала вне комментариев. Ловит забытую диагностику вроде блока, который
  на каждом старте читал `/tmp/vterm-realtest.conf` (на Windows `/tmp` не существует, и
  пользователь видел ошибку при каждом запуске).
- `lscolors.test.ts` (дополнено в Фазе 39) — `formatMode` с DOS-атрибутами: при
  отсутствующем `mode` рисуются атрибуты (`-a---`) вместо `-?????????`, а известные
  mode-биты всегда важнее атрибутов; `ownerLabel`/`fileTooltip` на Windows-записи не
  показывают владельца (uid/gid там не существует) вместо `?:?`.

- `motion.test.ts` + `motion.guard.test.ts` (Фаза 42) — длительность Svelte-переходов.
  `motionMs` схлопывается в 0 при `prefers-reduced-motion` и не пропускает в WAAPI
  бессмыслицу (отрицательное, `NaN`, `Infinity`); `motion()` **перечитывает** предпочтение
  на каждый вызов (Svelte пересобирает параметры на каждый прогон перехода), а не
  замораживает его при загрузке модуля. **Гейт:** ни одна директива `transition:`/`in:`/`out:`
  в `.svelte` не несёт литеральную длительность **и не идёт без параметров** (там Svelte
  берёт свои 400 мс). Гейт нужен потому, что общий `prefers-reduced-motion`-guard в
  `app.css` выглядит исчерпывающим, но WAAPI-анимации Svelte не покрывает — на месте
  вызова нарушение неотличимо от корректного кода. Третий тест проверяет сам матчер
  (балансировка скобок), чтобы гейт не стал вакуумным.
- `transfer.test.ts` (Фаза 42) — скорость и ETA переносов SFTP. **Ключевой кейс:**
  `sampleRate` следует за просадкой канала вместо средней за весь перенос (правило «держать
  один сэмпл до отсечки» сперва схлопывало окно в полную среднюю — тест это поймал);
  счётчик, поехавший назад (папочный перенос перешёл к новому файлу), даёт `null`, а не
  отрицательную скорость; `etaSeconds` при нулевой скорости — `null` («застряло»), а не 0
  («прибывает сейчас»); `fmtEta(null)` — прочерк, не выдуманный ноль.
- `loadhistory.test.ts` (Фаза 42) — кольцевой буфер нагрузки Docker/k8s и разбор величин
  CLI (`"12.34%"`, `"120m"`, `"1Gi"`). **Ключевые кейсы:** объект, пропавший из снимка,
  теряет историю целиком (иначе утечка за часы работы панели), а живой объект **без
  показания в этом цикле** сохраняет прежнюю историю и **не получает нуля** — ноль
  нарисовал бы провал, которого не было; `historyMax` не опускается ниже пола, чтобы
  дрожание простаивающего контейнера не выглядело нагрузкой.

- `typography.guard.test.ts` (Фаза 44, гейт) — кегли только из шкалы: нет арбитрарных
  `text-[Npx]`, шаги `--text-caption`/`--text-meta` объявлены, **companion'ов
  `--text-*--line-height` нет** (с ними утилита Tailwind печатала бы ещё и `line-height`, и
  переименование 328 мест стало бы тихим сдвигом интерлиньяжа), uppercase-микротекст набран
  одним оформлением. Проверен на двух живых нарушениях. **Два теста внутри самого гейта
  пришлось чинить:** проверка companion'ов ловила собственный комментарий в `app.css` (снятие
  комментариев + требование двоеточия), а проверка оформления рапортовала о 30 корректных
  местах из-за альтернации `wide|wider`, где первая ветка матчит префикс второй.
- `statuscolor.guard.test.ts` (Фаза 43, гейт) — ни одного сырого класса палитры Tailwind
  (`bg-green-400`, `text-amber-400`, `bg-red-500`…) в `.svelte`, кроме санкционированной
  зелёной primary-кнопки. **Гейт, а не соглашение:** такой класс на дефолтной тёмной теме
  читается идеально и потому проходит ревью — ломается он только на светлых темах, где
  янтарная точка на кремовой панели превращается в пятно. Второй тест проверяет, что
  исключение для кнопки ещё кого-то находит (иначе оно молча протухнет).
- `themes.test.ts` (дополнено в Фазе 43) — `statusPalette`: тема называет цвет сама, иначе
  берётся дефолт **по группе**; **ключевой кейс** — светлая тема не должна унаследовать
  почти флуоресцентную тёмную тройку (проверяется по каждому shipped-светлому пресету),
  и `applyUiPalette` пишет `--color-ok/warn/bad` на корень.
- `k8s.test.ts` (дополнено в Фазе 43) — лимиты пода. **Ключевой кейс:** `sumLimit` — `null`,
  если хоть один контейнер без лимита, и **никогда** не суммирует только те контейнеры, что
  лимит объявили (иначе под на 800m нарисуется как 400% от потолка, которого никто не
  применяет); `limitTone(null)` — тоже `null`, а не «ok» (безлимитный под не здоров, он не
  измерен); `parsePods` читает лимиты и `qosClass` из уже получаемого `-o json`.
- `docker.test.ts` (дополнено в Фазе 43) — потолки контейнера. `parseLimits` трактует
  докеровский `0` как «лимита нет»; **ключевой кейс** `parseMemUsed` — читается **только
  левая** половина `MemUsage`, потому что правая это лимит **или** размер хоста, и здесь они
  неотличимы; `groupUsage` считает только отчитавшиеся контейнеры и остаётся `null`-`null`
  для пустого проекта, а не уверенным нулём.

> Чистая логика дерева и форматтеры вынесены из `+page.svelte` / `StatusBar.svelte`
> в отдельные `.ts`-модули (Фаза 5.8), поэтому тестируются без DOM.

---

## Компонентные тесты

`@testing-library/svelte` рендерит компоненты в jsdom; нативные Tauri-API
мокаются через `vi.mock`.

- `HelpPanel.test.ts` — вкладки Help/Инструкция/About, таблица хоткеев (в т.ч. строка
  ⌘/Ctrl+T «новая вкладка», Фаза 20.15, и ⌘F/Ctrl+Shift+F «поиск по терминалу», Фаза 21),
  блок чипов «Возможности» (Фаза 21), версия из
  мока `@tauri-apps/api/app`, открытие внешних ссылок, контакты автора (email +
  Telegram через opener), рендер встроенного README на вкладке «Инструкция».
- `StatusBar.test.ts` — компактный режим по умолчанию (иконки + проценты, без имён/
  байтов/графика), тоггл в расширенный (имена, байты, sparkline, load-avg), скрытие
  группы по флагу видимости, индикатор передач SFTP из общего стора (+клик →
  разворот панели), OS-иконка по `title`, состояния ошибки/прочерков; **пороги**
  (жёлтый при превышении среднего, красный — предельного, без цвета ниже порогов);
  hover-подсказки (fake timers): имена пользователей и **реальные значения RAM**
  (`RAM 2.0 GiB / 8.0 GiB`, Фаза 20.18) всплывают после open-delay.
  *(Кнопка мониторинга убрана из статус-бара в Фазе 20.13 — переехала в верхнюю полосу.)*
- `MonitoringOverlay.test.ts` — smoke-тест страницы мониторинга (API замокан):
  блок «Система» и **детальные секции** (ядра/разделы/TCP) видны всегда (единый
  режим, без плиток); композитная
  полоса памяти; **таблица датчиков температуры** + per-core heatmap, **карточка
  установки lm-sensors** при пустых датчиках (клик → `onInstallTool("sensors")`);
  **CPU-разбивка** (stacked-бар) и **таблицы топ-процессов** (по CPU и по памяти);
  **скаляры здоровья**
  (failed-юниты/conntrack/синхр. времени) в блоке «Система»; **сводка health-бейджей**
  (`health-summary`) и точки-индикаторы в заголовках; **per-interface сеть**,
  **per-device disk I/O** и **таблица сессий**; безлимитный потолок дескрипторов
  рендерится как `∞`; **ленивая** секция «Дополнительно» (GPU/Docker/SMART/OOM,
  `fetchExtras` после первого рендера); **группа «Оборудование»** (модель CPU,
  ядра/потоки, частота, arch, машина, плата) и **бейдж виртуализации** в шапке «Система»
  из `extras.hardware`, а также **строка «Всего»** и подпись «из N GiB» в блоке ОЗУ
  (Фаза 20.16); **ленивая** подгрузка
  pending-updates после первого рендера (+ **скелетон** в группе «Обновления», пока
  промис не разрешён); **скелетоны дельтовых метрик** (per-core/разбивка CPU/per-device
  I/O) пока `pollCount < 2`; красная подсветка раздела при превышении
  порога диска, отсутствие опроса при закрытой странице.
  **Гейт возможностей хоста (Фаза 39):** на `os: "Windows"` карточка температуры
  говорит «недоступно на этом хосте» (`sensors-unsupported`) и **не** предлагает
  установку lm-sensors, а карточка load average скрыта целиком (`load-badge`/
  `load-history` отсутствуют). Отсутствие проверяется **после** ожидания
  `detail-sections`, иначе тест проходил бы просто потому, что ничего ещё не
  отрисовано.
- `Chart.test.ts` — линия-`path` на серию (атрибут `d` начинается с `M`, цвет
  `stroke`), доп. area-`path` при `fill`, одна линия на серию для мульти-серии,
  пустая серия не рисует ничего.
- `StackedBar.test.ts` — пропорциональные сегменты (ширина в `%`) + легенда с
  подписями, скрытие легенды при `legend=false`, пропуск нулевых сегментов в полосе.
- `Icon.test.ts` — рендер SVG из реестра, размер, accessible-title.
- `Toast.test.ts` — рендер тостов из стора, роль `status`, кнопка Dismiss убирает
  тост (синхронизация с `toastsState`).
- `EmptyState.test.ts` — рендер иконки/заголовка/подсказки, опциональность подсказки,
  слот CTA-кнопок.
- `ViewModeToggle.test.ts` — сегмент «Raw | Table» (0.11.5): `aria-pressed` на
  активном сегменте по пропу `structured`, вызов `onSelect(true/false)` по клику; при
  `compact` подписи схлопываются контейнерным запросом (`@max-[460px]:hidden`), без — всегда видны.
- `ConnectingOverlay.test.ts` — окно ожидания подключения (0.11.2): заголовок с
  `alias` и подпись `user@host:port`, `role="status"`; активная фаза с акцентным
  цветом и многоточием, предыдущая фаза как «done». Режим ошибки (0.11.3, проп
  `failed`): упавшая фаза в `text-danger`, заголовок/красная деталь и `role="alert"`,
  скрытие чек-листа при `showSteps={false}`. **Фаза 21 (proxy-подстадии):** без `proxy` —
  одна группа «сервер» (заголовок-адрес сервера, без прокси-заголовка); `proxy:"jump"` +
  `via` рисует две группы (заголовки-адреса прокси/сервера), подшаг «Туннель» и активную
  «Аутентификация…»; `proxy:"tcp"` показывает «Рукопожатие» и **не** содержит «Туннель».
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
- `serverform.test.ts` (Фаза 20.7, чистая логика) — валидаторы формы сервера:
  `isValidPort` (1…65535, отказ на `null`/дробном/вне диапазона) и `isValidHost` —
  IPv4 (октеты 0–255, без ведущих нулей), IPv6 (`::`-сжатие, zone-id, встроенный IPv4),
  RFC-1123 hostname (метки, дефисы, чисто-числовой TLD мультиметочного имени → отказ),
  trim + пустая строка.
- `sshkeygen.test.ts` (Фаза 32, чистая логика генерации ключей) — реестр алгоритмов
  (уникальные id), `isValidAlgorithm`, `defaultKeyName` (id_ed25519/id_rsa/id_ecdsa,
  неизвестный → id_key); `validateKeyName` (пусто/разделители/`.`/`..`),
  `validateKeyPath` (корневые пути ок, относительный → ошибка); `buildKeyPath`/
  `resolvedPath` (один слэш, кастомный путь с trim); `buildGenerateRequest` (пустые
  passphrase/comment → `undefined`, trim comment, проброс `overwrite`); `isFormValid`.
- `utilities.test.ts` (Фаза 33, реестр панели «Утилиты») — уникальность id, наличие
  иконок в реестре и title/desc-ключей в каталоге, дефолт `keys`, `isUtility`,
  `utilitiesMatching` (пустой запрос → всё, поиск по keywords на обоих языках и по id).
- `codec.test.ts` (Фаза 33, Base64/URL/Hex) — round-trip Base64 (ASCII/UTF-8),
  URL-safe без паддинга, дозаполнение паддинга при декодировании; hex (0x/пробелы/
  двоеточия, нечётная длина/мусор → ошибка); `runCodec` (пустой вход = пустой результат,
  url encode/decode, `invalidHex`/`invalidUrl`/`invalidBase64`, base64url round-trip).
- `cidr.test.ts` (Фаза 33, CIDR/подсеть) — `parseIpv4`/`intToIpv4` round-trip и отсев
  мусора; `parseCidr` (/24 сеть/broadcast/маска/wildcard/диапазон/хосты, bare→/32,
  /31 point-to-point, /0, границы 172.16/12 приватности, ошибки empty/address/prefix);
  `ipInCidr` (членство, null на мусоре).
- `timeconv.test.ts` (Фаза 33, Unix-время↔дата) — `detectUnit` (s/ms по величине),
  `epochToDate`/`parseEpoch`, парсинг ISO и `parseFlexible`; `isValidTimeZone`,
  `formatInZone` (UTC и +3 смещение), `relativeParts` (будущее/прошлое, секунды/годы).
- `cron.test.ts` (Фаза 33, cron) — `parseCron` (every-minute, списки/диапазоны/шаги,
  `@macros`, имена месяцев/дней, 7=Вс, ошибки count/range/шаг); `cronMatches` (каждые 15
  мин, union DOM·DOW); `nextRuns` (квартальные, будни 9:00, редкое расписание = меньше N).
- `pwgen.test.ts` (Фаза 33, генератор паролей) — `randInt` (диапазон/покрытие, throw на 0),
  `buildClasses` (только выбранные, отсев неоднозначных/своих), `generatePassword`
  (длина, `noClass`/`lengthTooSmall`/`emptyPool`, requireEach ≥1 каждого, noRepeats без
  повторов/последовательностей), `entropyBits`, `generatePassphrase` (число слов,
  заглавные, добавленная цифра, энтропия по размеру словаря).
- `jwt.test.ts` (Фаза 33, JWT) — `decodeJwt` (header/payload/подпись эталонного HS256,
  ошибки empty/structure/invalidJson/invalidBase64); `claimDate`, `expiryStatus`.
- `knownhosts.test.ts` (Фаза 33, менеджер known_hosts) — `splitHostPort` (последнее
  двоеточие, IPv6 в скобках, без порта); `prepareHosts` (сортировка host→числовой port,
  фильтр по id/отпечатку, пустой запрос, разбивка полей для вида).
- `probe.test.ts` (Фаза 34, общая логика сетевых утилит) — `shellQuote` (безопасные
  токены без кавычек, кавычки для пустых/со спецсимволами, экранирование `'`),
  `toShellCommand`, `isCommandMissing` (детект «command not found» и пр.), `probeError`
  (пусто при успехе, приоритет stderr→stdout→exit).
- `tls.test.ts` (Фаза 34, TLS-инспектор) — `tlsArgs` (пайплайн `sh -c` с SNI, порт,
  квотинг), `parseTlsCert` (subject/issuer/serial/fingerprint/SAN, дни до истечения при
  инъекции `now`, `null` без сертификата, unparseable `notAfter`), `expiryLevel` (пороги).
- `http.test.ts` (Фаза 34, HTTP-клиент) — `httpArgs` (минимальный GET; метод/заголовки/
  тело/`-L`, отсев пустых заголовков), `parseHttp` (статус/заголовки/тело+тайминги, только
  финальный ответ в цепочке редиректов, `null` без статус-строки), `statusClass` (диапазоны).
  (Фаза 36.1 — `dns`/`net`/`portscan`/`externalip`/`hashes` инструменты и их тесты удалены.)
- `docker.test.ts` (Фаза 35, Docker-панель) — билдеры argv (`psArgs` с compose-лейблами и
  US-форматом, `logsArgs` без `-f`, `composeUp/Down` с `--project-directory`, prune с `-f`,
  `execShellCommand` bash→sh); парсеры (`parsePs` c нормализацией состояния и `workdir=null`,
  `parseImages` с dangling `<none>`, `parseNetworks/Volumes/Stats`); `groupByCompose`
  (группировка, бакет Standalone последним, `workdir` от первого); `parseAvailability`
  (ok/missing/daemon/denied/unknown); `isDestructive` (rm/rmi/prune/compose down — да;
  start/stop/restart/up/logs — нет); `stateTone`/`isRunning`. **Фаза 36**: `needsConfirm`
  (деструктив + stop/restart/kill — да; start/up/logs/inspect — нет), `containerInfoRows`
  (отсев пустых полей; cpu/mem/net только у работающего со снимком stats), `loginArgs`/
  `logoutArgs` (`--password-stdin`, Docker Hub без url), `registryLabel`, `sanitizeDockerRegistries`
  (отсев мусора, требование username, дедуп по url). UI-оболочки (`Docker*.svelte`) — в
  exclude покрытия, вся логика в `docker.ts`. `clampDockerRefresh` — в `settings.test.ts`.
- `DockerDetailModal.test.ts` (v0.41.1, компонентные) — модалка «Подробнее» **не теряет
  выбранную вкладку** на снимках поллинга: открывается на «Обзоре»; после `rerender` с
  **новым объектом того же контейнера** (изменился `status`) остаётся на «Логах» с уже
  загруженным текстом; на **другом** `id` сбрасывается на «Обзор»; поллер логов не
  дублируется (один вызов `runQuery` за интервал). Все четыре падают на коде до фикса —
  эффект зависел от объекта, а не от `id`.
- `k8s.test.ts` (Фаза 37, Kubernetes-панель, 53 теста) — `kubectlProg` (пусто→`kubectl`,
  `k3s kubectl`→токены, абс. путь одним токеном); `withScope` (вставка `--context`/
  `--namespace`/`-A`; `namespace=null`→дефолт контекста; `namespaced:false` для cluster-scoped;
  `scoped:false` для kubeconfig-команд; multi-token программа) и `objectScope` (per-object
  namespace даже при `-A`-виде); билдеры argv (`versionArgs` с `--request-timeout`, `workloadsArgs`
  четыре типа, `logsArgs` с `-c`, `scaleArgs` кламп к ≥0, `rolloutRestartArgs` формы `kind/name`,
  `describeArgs`/`getYamlArgs`); `execShellCommand` (инлайн context/namespace/container, bash→sh);
  `k8sAge` (s/m/h/d, двухъединичный, `''` на мусор); `resolveOwner` (ReplicaSet→Deployment rollup,
  имя с дефисами, StatefulSet/DaemonSet напрямую, контроллер-реф, standalone); `podDisplayStatus`
  (Terminating/waiting/terminated≠Completed/phase); парсеры JSON (`parsePods` — ready/restarts/
  node/age/owner, `parseWorkloads` — Deploy/STS/DS/CronJob shape, `parseNamespaces`/`parseContexts`
  сортировка, `parseTopPods` 3/4 колонки + пусто без metrics-server); `groupByOwner` (бакет
  Standalone последним); `parseAvailability` (ok по serverVersion / missing/no-config/unreachable/
  forbidden/unknown); `podPhaseTone`; `isDestructive`/`needsConfirm` (delete/drain + cordon/rollout
  restart/scale-to-0 — да; ненулевой scale и чтения — нет). UI-оболочки (`K8s*.svelte`) — в exclude
  покрытия, вся логика в `k8s.ts`. `clampK8sRefresh` — в `settings.test.ts`. Бэкенд `kube.rs`:
  `kube_command` (квотинг каждого токена + wrapper-программа + нейтрализация инъекции),
  `kube_mirror` (обёртка `[k8s] $ … / exit N`), `run_local` (ENOENT→`exit 127`).
  **Фаза 37.1** (+10 тестов, 63 всего): билдеры `servicesArgs`/`ingressArgs`/`nodesArgs`/`eventsArgs`,
  `cordonArgs`/`uncordonArgs`/`drainArgs` (cordon/drain → confirm, uncordon — нет), `portForwardCommand`
  (инлайн scope/target, wrapper-программа, пропуск пустого scope); `parseServices` (type/clusterIP/
  external с LB-ingress/externalIPs/`<pending>`, ports-строка, firstPort), `parseIngress` (hosts join +
  LB-адрес), `nodeRoles` (label’ы `node-role.kubernetes.io/*` + legacy `kubernetes.io/role`), `parseNodes`
  (Ready/`SchedulingDisabled`, version, internalIP), `parseEvents` (newest-first сортировка, object
  `Kind/name`, count), `nodeStatusTone`/`eventTone`.
- `K8sDetailModal.test.ts` (v0.41.1, компонентные) — то же для модалки пода: вкладка «Логи»
  переживает свежий снимок того же пода (изменились `age`/`restarts`), другой `name`
  сбрасывает на «Обзор», и **под с тем же именем в другом namespace считается другим подом**
  (идентичность — `namespace/name`, не имя).
- `idle.test.ts` (Фаза 28, чистая логика заставки простоя) — `isIdleSetting`/
  `clampIdleTimeout` (валидация настроек, клэмп к [15…3600] c) и детект простоя
  `isIdle`/`msUntilIdle` (порог по «нет активности», обратный отсчёт без отрицательных).
  `swallowDismiss` (Фаза 29-фикс): жест-дисмисс глотается только если цель — canvas
  заставки/его потомок; клик по доку (git-меню и пр.) и вырожденные входы (null/undefined) —
  `false`, чтобы клик дошёл до контрола.
- `idlefx.test.ts` (Фаза 28) — `bufferGrid` (буфер→сетка `rows×cols`: паддинг пробелами,
  верх-выравнивание при нехватке строк, обрезка, табы, нулевой размер), `classifyToken`
  (keyword/ok/number/plain) и `tokenizeBuffer` (дедуп, отсев 1-символьного шума, обрезка
  краевой пунктуации, перенос семантического класса).
- `connlost.test.ts` (Фаза 28) — `classifyClose`/`showNoSignal`: NO SIGNAL только при
  неожиданном обрыве подключённой сессии (не ручное закрытие, не провал коннекта).
- `git.test.ts` (Фаза 29, чистая логика git-панели) — билдеры аргументов (status/log/
  branch/stage/commit/checkout/push/pull/stash/diff), парсеры `parseStatus`
  (`--porcelain=v2 -z`: заголовки ветки, ahead/behind, initial/detached, обычные/
  переименованные/untracked, `stagedFiles`/`unstagedFiles`), `parseLog` (поля/родители/
  декорации), `parseBranches` (локальные vs удалённые, current, отброс `origin/HEAD`),
  `parseStashes`, `parseDiff` (типы строк), `parseCommitFiles` (rename-строки),
  `isDestructive` (force-push/`-D`/`--hard`/discard/merge/stash drop-pop), `buildGraph`
  (линейная история в одну дорожку, merge → два `out`-сегмента + вторая дорожка,
  конвергенция → `in`-сегмент), `railColor` (цикл/wrap). Билдеры действий над коммитом
  (checkout/reset soft-mixed-hard/cherry-pick/revert/tag/diff-vs-working/remote-url) и
  `commitWebUrl` (ssh-scp/https/ssh → веб-ссылка, bitbucket → `/commits/`, null для
  локального remote); `parseLog` помечает HEAD (`head`-флаг, `HEAD` вычищается из refs);
  `isUncommittedChangesError` (распознаёт abort «would be overwritten / commit or stash»
  на реальном выводе `git checkout`, не срабатывает на pathspec/not-a-repo — для диалога
  разрешения незакоммиченных изменений); `discardFileArgs` (untracked→`clean -f`,
  tracked→`checkout HEAD --`), `discardAllArgs`=`reset --hard`, `cleanArgs`; `showFileAtArgs`
  (`show HEAD:<path>` — база для редактируемого инлайн-diff в редакторе). Ветко-действия
  `rebaseArgs`/`setUpstreamArgs`/`compareBranchesArgs`, `branchWebUrl` (`/tree/…`,
  bitbucket `/branch/…`); stash-превью `stashFilesArgs`/`stashFileDiffArgs`, `stashPushFileArgs`;
  сеть `isRemoteConnectionError` (обрыв/DNS/auth/host-key) и `parseSyncResult` (up-to-date/
  диапазон); `parseLog` читает тело (`body`, `-z` NUL-записи).
- `gitview.test.ts` (Фаза 29) — `fileStatusColor` (буквы статуса → цвет-классы),
  `relTime` (бакеты now/m/h/d/w/y, клэмп будущих меток), `commitTooltip` (заголовок +
  тело + автор/время/hash; тело опускается, если пустое).
- `api.test.ts` (Фаза 29) — обёртка `gitRun` передаёт `sessionId`/`cwd`/`args`/
  `timeoutSecs`/`mirror` в команду `git_run` (дефолт 30с/`mirror:false`; мутация — явный
  таймаут + `mirror:true`).
- `ctxmenu.test.ts` (Фаза 31, чистая логика контекстного меню) — `clampMenuPosition`
  (меню держится в вьюпорте: сдвиг влево/вверх при выходе за правый/нижний край, не заходит
  за верх-левый `margin`, кастомный отступ) и `isAction` (гвард: строка без `kind` и явный
  `action` — кликабельны; `separator`/`submenu` — нет). Само `ContextMenu.svelte` и
  ПКМ-обработчики поверхностей проверены вручную в превью (таб-бар и терминал).
- `ServerFormModal.test.ts` (Фаза 20.5) — валидация обязательных полей формы сервера
  (`api` замокан): submit при пустых `alias`/`host`/`username` подсвечивает все три
  (`aria-invalid`, «This field is required» ×3 + сводка) и **не** зовёт `addServer`;
  ошибка поля снимается по заполнению; whitespace-only не проходит (`.trim()`);
  **host** — мусорный (`256.300.1.1`) блокирует сейв с отдельным сообщением «Enter a
  valid host name or IP address», исправление на валидный (`example.com`) пропускает;
  пустой host даёт «required», не «invalid»; **дублирование (Фаза 20.9):**
  `openDuplicate(server)` предзаполняет форму полями оригинала, алиас → `{alias} (copy)`,
  сохранение зовёт `addServer` (не `updateServer`), а сохранённый секрет в payload не
  попадает;
  **порт** — очистка блокирует сейв («Port must be between 1 and 65535», `aria-invalid`)
  и не шлёт `null` в бэкенд, вне-диапазонный (`99999`) отклоняется, повторный ввод
  валидного порта снимает ошибку и пропускает сейв (`port: 2222` в payload); при
  валидных данных `addServer` вызывается один раз с payload и `onsaved(_, "add")`;
  повторное открытие формы сбрасывает подсветку. **Компоновка (Фаза 20.17):** две
  колонки с заголовками «Connection» / «Recording & AI», а подсказки свёрнуты в
  info-тултипы (Фаза 20.17.1, компонент `InfoHint` — 20.19) — абзац-хинт автозаписи не
  рендерится текстом; «ⓘ» — фокусируемая кнопка с `aria-label`, по фокусу появляется
  `role="tooltip"`, по blur исчезает. **Proxy (Фаза 21):** по умолчанию прямое
  подключение — полей прокси нет, в payload `proxy: null`; включение прокси и заполнение
  jump-хоста шлёт объект `proxy` (`kind: "jump"`, host/username/authMethod,
  `hasSavedPassword: true` при введённом секрете) и зовёт `saveProxySecret(id, secret)`
  (секрет не попадает в профиль); выбор **SOCKS5** показывает необязательный basic-auth
  (хинт, без SSH-радио), шлёт `kind: "socks5"` с host/port/username и сохраняет пароль
  через `saveProxySecret`; при включённом прокси с невалидным host сейв блокируется
  (`aria-invalid` на `proxy-host`, `addServer` не вызван).
- `notes.test.ts` (Фаза 21, чистая логика) — заметки к серверу: `noteStats`
  (символы/слова/строки, пустой/whitespace → `empty`, счёт code point'ов для emoji),
  `notesDirty` (точное сравнение draft↔saved), `hasNotes` (непустой после trim,
  null/undefined → false), `notesTarget` (активная вкладка сервера выигрывает у
  выделения, фолбэк на выделение на локальной вкладке, null без обоих).
- `NotesModal.test.ts` (Фаза 21, компонентный) — редактор заметок: textarea засеян из
  `server.notes`; ввод запускает **дебаунс-автосохранение** (`onsave` зовётся один раз
  с последним текстом только после 800 мс); «Сохранить и закрыть» флашит правку и зовёт
  `onclose` (без двойного сохранения от таймера); без изменений `onsave` не зовётся, но
  окно закрывается; переключение на «Просмотр» рендерит Markdown. Компонент
  coverage-excluded (оболочка), чистая логика — в `notes.ts`.
- `servericons.test.ts` (Фаза 21, чистая логика) — пиктограммы серверов: `SERVER_ICONS`
  (уникальные ключи, есть `generic`, каждый глиф существует в реестре `icons.ts`),
  `resolveServerIcon` (известный ключ → глиф; пусто/неизвестно/null → `server`),
  `SERVER_COLORS` (уникальные ключи, классы `text-`/`bg-`), `resolveServerColorClass`
  (известный → text-класс; иначе `text-muted`).
- `ServerIconPicker.test.ts` (Фаза 21, компонентный) — пикер иконки+цвета (сворачиваемый):
  по умолчанию **свёрнут** — превью выбора (`server-icon-preview`) есть, сетки/свотчей нет;
  раскрытие (`server-icon-section`) показывает сетку глифов и свотчи (в т.ч. «none»);
  `aria-pressed` на выбранных глифе/цвете; клик по другому глифу/свотчу переносит выделение
  (двусторонний `bind`). В `ServerFormModal.test.ts` добавлен тест: раскрытие секции, затем выбор
  глифа (`server-icon-database`) и цвета (`server-color-green`) попадает в payload `addServer`
  (`icon`/`iconColor`).
- `broadcast.test.ts` (Фаза 22, чистая логика) — синхронный ввод: `eligibleMembers`
  (только открытые живые члены, в порядке вкладок; закрытые/ошибочные/чужие id отброшены),
  `prodMembers`/`groupHasProd` (только SSH с prod-тегом; local и неизвестный сервер — не prod),
  `frameCommand` (команда + `\n`, без trim, null для пустой), `pickLayout` (сетка ≤ порога,
  дальше фокус), `gridColumns` (кол-во колонок по ширине/мин-плитке, кап 4, минимум 1).
- `BroadcastBar.test.ts` (Фаза 22, компонентный) — командная строка: отправка по кнопке и по
  Enter (`onsend` с текстом, поле очищается), пустая команда не отправляется, при
  `disabled`/0 целей ввод инертен и кнопка `disabled`.
- `BroadcastRoster.test.ts` (Фаза 22, компонентный) — ростер фокус-раскладки: список членов с
  алиасами, prod-бейдж у prod-члена, клик по строке → `onfocus(id)`, кнопка удаления → `onremove(id)`.
- `recgroup.test.ts` (Фаза 22, чистая логика) — группировка записей в бандлы: `groupRecordings`
  (записи без `batchId` — одиночные; общий `batchId` схлопывается в группу на месте первого члена;
  одинокий член батча — тоже группа; разные батчи не смешиваются; `timestamp` группы = минимальный).
  В `RecordingsPanel.test.ts` добавлен тест: записи одного `batchId` показываются свёрнутым бандлом
  «Broadcast → N servers», разворачивается по клику. `groupRecordings` также берёт `label` бандла
  из любого члена (имя бродкаста), а именованный бандл в панели показывается своим именем
  (подзаголовок — счётчик + дата). **`sectionRecordings`** (Фаза 22, «группировка когда записей
  много») — внешний слой секций над схлопнутыми бандлами: режим `none` → одна плоская секция `all`
  (счётчик суммирует членов бандла); `server` → секции по имени сервера в порядке первого появления,
  локальные (без сервера) — в `noServer`, бандлы целиком — в `broadcast` (не дробятся по серверам);
  `date` → относительные бакеты `today/yesterday/week/month/older/unknownDate` (детерминированно от
  переданного `now`, члены одного бакета держатся вместе). Rust `batch_id_from_header`/`batch_label_from_header` — чтение
  `vterm.batch`/`vterm.batchLabel` (строка → `Some`, отсутствие/не-строка → `None`);
  `with_batch_label` — запись `vterm.batchLabel` в заголовок с сохранением событий.
- `history.test.ts` (Фаза 23, чистая логика) — парсинг истории шелла + захват ввода для
  Ctrl+R-оверлея: `parseShellHistory` (bash-строки; zsh EXTENDED `: ts:elapsed;cmd` со снятием
  префикса; пропуск bash `#<epoch>`-таймстампов; склейка backslash-переносов, но не экранированного
  `\\`; CRLF/пустые), `recentUniqueCommands` (новые сверху, дедуп по последнему употреблению),
  `filterCommands` (регистронезависимый substring, порядок сохранён, пустой запрос → всё),
  `mergeCommands` (приоритетное слияние источников: клиентский захват выше файла, дедуп по первому),
  `createCommandCapture` (reducer над потоком ввода: коммит по Enter через границы чанков; Backspace/
  Ctrl-U/Ctrl-W-редактирование; отмена по Ctrl-C и пустые Enter не коммитятся; строка, правленая
  стрелками или Tab-дополнением, помечается «грязной» и пропускается; следующая строка снова
  захватывается).
- `CommandHistory.test.ts` (Фаза 23, компонент) — оверлей истории: список + счётчик `N/M`, живой
  фильтр при наборе, `Enter` вставляет выбранную (первую) команду через `onaccept`, `↑`+`Enter`
  берёт вторую, клик по строке — вставка, `Esc` → `onclose`, пустое состояние и текст ошибки.
- `settingsNav.test.ts` (Фаза 15, чистая логика) — группы настроек: каждый раздел ровно
  в одной группе (1:1 покрытие), `visibleSectionIds` (активная группа vs кросс-группный
  поиск), `groupMatchCounts`, `groupForSection` (deep-link).
- `ai.test.ts` (Фаза 17, чистая логика) — конфигурация ИИ-ассистента: дефолты (opt-in/off,
  Anthropic→`claude-opus-4-8`), `sanitizeEndpoint`/`sanitizeAiSettings` (отброс мусора,
  сброс висячего active), `activeEndpoint`/`aiReady`, `buildChatRequest` (null когда выкл;
  max_tokens=4096 для anthropic); `mergeModelOptions` (загруженные ∪ текущая, сорт+дедуп, пустые
  отброшены); `parseParams` (объект / пусто / битое / массив → null); `buildChatRequest` склеивает
  `basePrompt` перед системным промтом и прикладывает распарсенные `params`; `aiErrorKind` (auth: `auth-rejected`/401/permission denied; unreachable:
  `ai-unreachable`/connection refused; billing: credit/quota; rate: 429; иначе other).
  **Промты-списки:** дефолт — один активный промт на вид с встроенным текстом; `sanitizeAiSettings`
  мигрирует легаси-строки (`chatSystem`…) в списки (trim), хранит валидные списки с корректным
  `activeId`, для отсутствующих видов даёт дефолт; `resolvePromptContent` (предпочтённый по id промт
  главнее активного, фолбэк при пустом наборе). `AiChat.test.ts` проверяет, что `req.system` = контент
  активного промта, а при заданном `chatPromptId` — выбранного. Привязка чат-промта к серверу — поле
  `ServerProfile.chatPromptId` (`model.rs` round-trip). `effectiveExecMode` (валидный override сервера
  главнее глобального, иначе глобальный); `AiChat.test.ts` — `serverExecMode="suggest"` убирает кнопку
  «Выполнить» даже при глобальном `confirm` (поле `ServerProfile.execMode`). UI ИИ (`AiSettingsSection`/`RightDock`) —
  coverage-excluded, проверяется через `SettingsPanel.test.ts` (вкладка-группа «Ассистент»).
- `aierror.test.ts` (Фаза 17, чистая логика) — `describeAiError`: маркеры → локализованные подсказки
  (auth → про ключ, unreachable → про адрес, billing → про средства/квоту, rate → про лимит),
  сырой детейл для прочего, дефолт при пустом.
- `redact.test.ts` (Фаза 17.3 + 20.2, чистая логика) — маскирование секретов перед отправкой
  контекста ИИ: `KEY=value`/`key: value`/`--password=…`, токены `Bearer`/`Authorization`,
  пароли в URL, AWS-ключи (`AKIA…`), тело PEM-блока (с сохранением fence), эхо `Password:`;
  счётчик скрытых секретов; пустой ввод и текст без секретов — без изменений.
  **Фаза 20.2:** standalone self-identifying токены вне `KEY=`/`Bearer` — JWT (`eyJ…`),
  GitHub (`ghp_`/`github_pat_`), Slack (`xox…`), Stripe (`sk_live_…`), GCP (`AIza…`),
  Google OAuth (`ya29.…`); и что обычные слова (`eyJson` без dotted-структуры) не маскируются.
- `aicontext.test.ts` (Фаза 17.3, чистая логика) — сборка контекста по уровням
  (`buildContext`): выделение приоритетнее tail; `includeBuffer` заменяет tail полным буфером;
  `includeRecording`/`includeMetadata` подключаются только при включённых флагах; редакция и
  подсчёт строк/секретов; пропуск пустых источников; `withContext` (склейка вопроса с контекстом).
  `buildContext` берёт `ContextTiers` (уровни выбираются по чату — поповер `AiChat`, `AiChat.test.ts`
  проверяет, что включённый «весь буфер» расширяет предпросмотр; `stores/aichat.test.ts` — что новый
  чат наследует уровни-дефолты из `settings.ai`).
- `aiexec.test.ts` (Фаза 17.4, чистая логика) — исполнитель: `parseChatSegments` (текст+код в
  порядке, язык fence, `runnable` только для shell, `closed=false` для незакрытого стрим-fence,
  многострочные блоки, пропуск пустого текста); `isRunnableLang`; `isProdServer` (теги
  prod/production, регистр/пробелы, пустое/`null`; **Фаза 20.3** — контракт точного тега:
  `prod-eu`/`non-prod`/`preprod`/`product` намеренно **не** prod); `toTerminalInput` (ровно
  один `\n`, внутренние переводы строк сохраняются); `auditLabel` (одна строка / «… (+N)» / пусто).
- `aidialog.test.ts` (Фаза 17.8 + 20.1, чистая логика) — петля диалог-агента: `nextCommand`
  (первый runnable+closed shell-блок, `null` без команды/для незакрытого fence/не-shell);
  `buildFeedback` (статус exit/timeout, склейка stdout+stderr, **редакция секретов**, обрезка до
  `FEEDBACK_MAX_LINES`); `DIALOG_SYSTEM_SUFFIX`. **Фаза 20.1** — `isDangerousCommand`: базовый
  деструктив плюс закрытые обходы — длинные/раздельные флаги `rm` (`--recursive --force`, `-r -f`),
  `--no-preserve-root`, `find -delete`/`-exec rm`, пайп в шелл (`curl|sh`), `base64 -d`/`--decode`,
  `eval`, рекурсивный `chmod/chown -R` на `/`; и что обычные команды (`git log | less`,
  `base64 file > out`, `rm build/x.o`) не флагаются.
- `airunbook.test.ts` (Фаза 17.5, чистая логика) — план из записи: `buildRunbookContext` (редакция
  секретов + счётчик, подсчёт строк с обрезкой хвоста, `sources=["recording"]`, пустой транскрипт →
  пусто). Инструкция — единый редактируемый `runbookSystem` (дефолт покрыт в `ai.test.ts`).
- `aiscript.test.ts` (Фаза 17.6, чистая логика) — скрипты из записи: `extractScript` (достаёт блок
  нужного языка, предпочитает совпавший/длиннейший, фолбэк на любой код-блок → на весь ответ);
  `scriptFileName` (слаг + `.sh`/`.yml`, дефолт `runbook`, обрезка длинных); `scriptExt`.
- `RecordingsPanel.test.ts` (Фаза 17.5–17.6) — кнопка ✨ скрыта при выключенном ИИ; клик открывает
  меню (план/sh/ansible). **План:** диалог согласия с **замаскированным** транскриптом (секрет не
  виден), до подтверждения `aiChat` не зовётся, `system`=`runbookSystem`, стрим в просмотрщик.
  **Скрипты:** `system`=`scriptShSystem`/`scriptAnsibleSystem`, по завершении `onOpenScript`
  получает имя (`deploy-nginx.sh`/`.yml`) и извлечённый код. Моки `./api` + канал событий.
- `workspaces.test.ts` (доп. 17.6) — `addScratchEditor`: заполненный, «грязный» (пустой
  `baseContent`), новый (`baseSha256=""`) документ, сразу активен.
- `stores/aichat.test.ts` — пер-сессионный стор + сервис стрима диалога ИИ: слоты (`getChat`
  создаёт/возвращает, сессии независимы, `undefined`→`KEY_NONE`, `clearChat`/`removeChat`
  идемпотентно); `startChat` (пуш user+assistant, стрим дельт `ai://out`, `done` снимает
  `streaming`, склейка контекста в `sent` при показе только вопроса, ошибка при выключенном ИИ,
  событие `ai://error` (+ перевод маркера в дружелюбный текст через `describeAiError`),
  авто-исполнение по `done` в `auto`/не-прод и его блок на проде);
  `runCommand` (запись в терминал + аудит, идемпотентность, блок при `noAi`, сброс отметки при сбое);
  `stopChat` (зовёт `cancelAiChat` с тем же `streamId`, снимает `streaming`, сохраняет частичный
  текст, глушит поздние события; no-op без активного стрима). Моки `../api` + канал событий.
- `AiChat.test.ts` (Фаза 17.3–17.4) — **контекст+согласие:** без контекста отправка сразу;
  кнопка «Контекст» открывает диалог с **замаскированным** предпросмотром, до подтверждения
  `aiChat` не зовётся; подтверждение шлёт вопрос, склеенный с редактированным контекстом (секрет
  не утёк, в пузыре только вопрос); отмена не шлёт; «Контекст» неактивна без провайдера. **Испол-
  нитель:** мок канала `ai://out|done/{id}` прогоняет ответ с ```bash-блоком — `confirm` даёт
  кнопку «Выполнить» → `writeToTerminal` (`ls -la\n`) + `annotateRecording` (аудит), повторный
  клик заблокирован; `suggest` — кнопки нет; `auto` на не-прод запускает без клика, на прод —
  только кнопка; без `sessionId` исполнение недоступно. **Прод-защита (17.7):** на сервере с
  `noAi` кнопка «Контекст» неактивна и видна плашка, кнопок «Выполнить» нет даже в `confirm`,
  авто-запуск заблокирован. **Пер-сессионность:** диалог хранится по `sessionId`, переключение
  вкладок (смена пропа) восстанавливает переписку, «Очистить» чистит только активную сессию,
  а **стрим продолжается после размонтирования** компонента (уход на другую вкладку) — ответ
  дописывается в слот и виден при возврате. **Стоп:** во время генерации вместо «Отправить»
  показывается кнопка-квадрат «Остановить», клик зовёт `cancelAiChat` и возвращает «Отправить».
  **Выбор модели:** селектор в шапке заполняется из `aiModels`, выбор пишет `endpoint.model`; при
  ошибке запроса остаётся ручная модель. Покрывает и `AiConsentDialog`.
- `aipresets.test.ts` (Фаза 40, чистая логика) — реестр пресетов эндпоинтов: **каждый пресет
  лежит на одном из двух реальных транспортов** (`openai`/`anthropic`) — пресет с выдуманным
  провайдером указывал бы на несуществующую ветку бэкенда; уникальность id и меток; base URL
  абсолютный и **без хвостового слэша** (бэкенд дописывает `/chat/completions`); облачные
  требуют ключ, локальные — нет; DeepSeek **не** использует модели, снятые с поддержки
  2026-07-24; `presetById` на неизвестном id → null; `endpointFromPreset` даёт свежий id на
  каждый вызов (иначе два эндпоинта делили бы запись в keychain); **round-trip через
  `sanitizeEndpoint`** — включая vLLM с пустой моделью: если бы санитайзер его ронял, выбор
  пресета выглядел бы как «кнопка ничего не сделала» после перезагрузки настроек.
- `ai.test.ts` (Фаза 40, дополнения) — `trimHistory`: кап по сообщениям, кап по символам,
  **их композиция** (обрезка по символам может оставить диалог начинающимся с ответа
  ассистента — тогда срезается ещё один, иначе Anthropic отвечает 400), последнее сообщение
  не выкидывается никогда (это сам вопрос), оба капа выключены, пустой список.
  `sanitizeOptionalInt`: пусто/мусор/0/отрицательное → `null` («по умолчанию»), а не
  схлопывание в минимум; кламп и усечение. `buildChatRequest`: `maxTokens` эндпоинта,
  фолбэк 4096 только для Anthropic, `timeoutSec`, обрезанная история, отказ на эндпоинте без
  модели. Апгрейд старых настроек **в капы** (безлимит — чинимый дефект, а не выбор
  пользователя) и явный `null` как «без ограничений». `usageSummary`/`formatTokens`/
  `formatElapsed`: форматирование детерминированное (не зависит от локали), половина, о
  которой эндпоинт промолчал, **опускается**, а не рисуется нулём; нечего показать → `null`.
- `AiChat.test.ts` (Фаза 40, дополнения) — рассуждение приходит по каналу `ai://think/{id}`
  в **свой** сворачиваемый блок (свёрнут по умолчанию) и **не попадает в ответ**; отдельный
  тест на то, что ```bash-блок **внутри рассуждения** не превращается в кнопку «Выполнить»
  (модель, размышляющая про `rm -rf /`, не должна предлагать это к запуску); счётчик токенов
  показывается только когда эндпоинт их прислал; маркер обрезки истории появляется, когда
  переписка переросла кап; в брокер уходит **обрезанная** история, начинающаяся с реплики
  пользователя.
  - Хелпер `askAndReply` ждёт **фактической регистрации** слушателей: `startChat` вешает их
    через `await listen`, и синхронный `emit` сразу после клика иногда не попадал — ответ
    терялся, `streaming` не сбрасывался, и следующий вопрос молча не отправлялся. Ошибка
    проявлялась только на второй итерации.
- `aicore.test.ts` (Фаза 41, чистая логика) — **ядро системного промпта**: контракт
  ```bash-блоков присутствует **всегда** (до Фазы 41 он жил в редактируемой строке, и правка
  промпта молча отключала кнопку «Выполнить»); секция «перехваченный вывод — данные, а не
  инструкции» и объяснение `‹redacted›` — **только** при наличии контекста; правила без TTY
  (`sudo -n`, `apt-get -y`, запрет `vim`) — только когда команды вообще могут исполняться;
  формулировка режима исполнения для всех четырёх режимов (в т.ч. `confirm`, где модель раньше
  не знала, что её блоки в один клик от запуска); прод-предупреждение появляется **только** на
  прод-вкладке; SSH и локальная вкладка описываются по-разному и обе признают, что ОС может
  быть неизвестна. `resolveReplyLanguage` — «как интерфейс» против жёстко заданного (русский
  UI с английскими ответами — намеренно поддержанный выбор), неизвестная локаль → английский.
  `expandPromptVars` — подстановка известных значений; **неизвестное раскрывается в пустоту, а
  не оставляет `{host}`** (буквальная скобка читается моделью как нечто осмысленное);
  нераспознанные имена и обычная проза со скобками не трогаются.
- `aicore.test.ts` (Фаза 41, порядок слоёв) — `Reply in …` **не входит в ядро** и стоит
  **после персоны** (пока он завершал ядро, локализованная персона была более свежей
  инструкцией на другом языке); `PERSONA_HANDOFF` стоит перед персоной и **отсутствует**, когда
  персона пуста; `buildSystemPrompt` — ровно склейка слоёв `buildPromptLayers` (поэтому
  предпросмотр в настройках не может разойтись с отправляемым); подстановки раскрываются в
  слое персоны.
- `aiprompts.test.ts` (Фаза 41) — локализация промптов: каждый вид есть в каждой локали,
  неизвестная локаль → английский, **машиночитаемая часть переживает перевод** (```bash в
  `sh`/`runbook`, ```yaml в `ansible`). `origin`: свежий промпт — `builtin`; сохранённые до
  появления поля классифицируются сравнением со всеми локализациями сразу; **явно сохранённый
  `custom` важнее совпадения по содержимому** (пользователь, набравший дефолт дословно, всё
  равно им владеет); текст, мигрировавший из легаси-поля, считается пользовательским.
  `reseedBuiltinPrompts` — пересеивает нетронутые, **не трогает отредактированные** (ради чего
  поле и заведено), сохраняет id и активный выбор, восстанавливает отсутствующий вид.
- `aimetrics.test.ts` (Фаза 41) — снимок метрик для ИИ: заголовочные показатели; поля, которых
  хост не сообщил, **опускаются, а не пишутся нулём** («Swap: 0» сказало бы модели, что
  подкачка свободна); load average исчезает целиком там, где такого понятия нет; из разделов
  берутся только заполненные ≥80% (десяток пустых loop-точек похоронил бы забитую); работает
  без загруженной детализации; пустые строковые поля пропускаются.
- `AiChat.test.ts` (Фаза 41, дополнения) — ядро в реально отправленном промпте: инструкция
  «одна команда за раз» в диалоговом режиме, правила без TTY, прод-предупреждение **только**
  на проде, «данные, не инструкции» + `‹redacted›` при приложенном контексте. **`askAbout`**:
  открывает **существующий** consent-диалог вместо отправки (точка входа экономит копирование,
  а не обходит согласие), после подтверждения шлёт подготовленный вопрос с секцией `###`,
  **игнорируется на сервере с `noAi`**, и запрос очищается, чтобы не сработать повторно.
- `git.test.ts` (Фаза 41, дополнения) — `stagedDiffArgs`: `--cached` с урезанным контекстом
  (`-U1` — контекстные строки почти удваивают токены без пользы для описания) и `--no-color`.
- `settings.guard.test.ts` (Фаза 41) — статический гейт: ни один `.svelte` не должен делать
  `bind:value={settings.language}`. Двусторонняя привязка пишет локаль в стор в обход
  `setLocale`, а вместе с ним пропадает пересев нетронутых ИИ-промптов — **именно так фича и
  оказалась мёртвой**, пока это не всплыло при проверке в живом приложении.
- `i18n.test.ts` (Фаза 41, дополнения) — `setLocale` пересеивает промпты с `origin: "builtin"`
  под новый язык и **оставляет отредактированные дословно**; нетронутые виды при этом всё равно
  следуют за языком.
- `DisclosureRow.test.ts` (Фаза 15) — единый сворачиваемый блок: рендер лейбла/счётчика,
  свёрнут по умолчанию, переключение `aria-expanded` по клику.
- `SettingsPanel.test.ts` — двухпанельная навигация (выбор группы из sidebar, deep-link
  `initialSection` — в т.ч. `servertools` как цель шестерёнки верхней полосы, Фаза 20.13,
  секция `data-settings-section` в виде; **пере-скролл к верху по `ResizeObserver`**, когда
  асинхронный каталог инструментов подгружается и растит секцию — Фаза 20.13.3), липкий
  заголовок, стрелки по группам),
  кросс-группный поиск, бэкап, тема/шрифт, метрики и шаблоны под disclosure.
  **Сброс настроек (v0.21.4):** кнопка «Сбросить к значениям по умолчанию» открывает
  `ConfirmDialog` (мгновенного сброса нет); отмена оставляет настройки нетронутыми,
  подтверждение возвращает их к дефолту (`settings.theme === DEFAULT_THEME_ID`).
- `TopBar.test.ts` (Фаза 20.13) — хлебные крошки подключения (`alias · user@host:port`),
  кнопка настроек → `onOpenSettings`, кнопка мониторинга → `onOpenMonitoring` (видна только
  при `connected`, скрыта без коннекта), отсутствие бренда «vterm» и кнопки «Add server».
- `ServerTree.test.ts` — рендер папок/серверов, выбор, dbl-click → connect,
  сворачивание папки, фильтр поиска, кнопка «New folder», кнопка «Add server» в
  тулбаре (`add-server` → `onAddServer`), пустое состояние с CTA «Добавить сервер»
  (`empty-add-server` → `onAddServer`). **Выделение папки (Фаза 20.6):** клик по строке
  папки → `onSelectFolder(path)`; выделенная папка помечена `aria-selected`/`border-accent`;
  тоггл сворачивания и кнопки действий (rename/subfolder/delete) **не** выделяют папку
  (`stopPropagation`). **Drag-выделение (Фаза 20.8):** нажатие на строку сервера вешает
  `select-none` на список (чтобы drag не выделял текст строк ниже), отпускание — снимает.
  **Дублирование (Фаза 20.9):** кнопка copy в строке → `onDuplicateServer(server)`, без
  выделения сервера через bubbling (`stopPropagation`). **Кружки подключений (Фаза 20.12):**
  проп `connections` (serverId → статусы) → `conn-dots` с кружком на вкладку (кружок
  `Connecting` несёт класс `pulse-dot`); кап 3 + бейдж `+N`; нет вкладок → блока
  `conn-dots` нет. **Клавиатура (v0.21.25):** `↑`/`↓` двигают рамку-курсор
  (`onSelect`/`onSelectFolder` для следующей/предыдущей строки, из «нет выбора» — на
  первую; шаг с папки на её первый сервер); `Enter` на сервере → `onSelect`+`onConnect`,
  на папке → сворачивание (строка сервера исчезает); `Delete` → `onDeleteServer`/
  `onDeleteFolder`; `Space` ничего не делает; выбранная строка несёт рамку
  `outline-accent/70`.
- `SettingsPanel.test.ts` — секция Backup: экспорт по выбранному пути со снимком
  настроек, отмена экспорта, импорт после подтверждения + вызов `onImported`;
  визуальный пикер тем (свёрнут/раскрытие, выбор → `aria-checked`), сетка шрифтов с
  Python-превью (`font-preview`), поиск по настройкам (фильтр секций, пустое состояние),
  сворачиваемые чекбоксы показателей статус-бара (`metrics-toggle`), **live-переключение
  языка** (`language-select` → заголовок панели меняется на выбранный язык).

**`PasswordInput.test.ts`** (Фаза 39.7, 9 тестов) — примитив поля секрета: стартует
замаскированным, toggle переключает `type` password↔text и `aria-pressed`, подпись
(`aria-label`) описывает **следующее** действие, набранное значение переживает показ и
скрытие, свежее монтирование снова маскирует (открыть диалог заново — не увидеть прошлый
секрет), биндинг `undefined` допустим (поле API-ключа биндится в разрежённую карту
`keyDrafts[id]`, и `$bindable("")` такой биндинг отвергал — регрессия, найденная прогоном),
toggle — `type="button"` (четыре поля живут внутри `<form>`, где он бы её отправил),
`disabled` гасит и поле, и кнопку, автофокус только по просьбе.

Тяжёлые интерактивные компоненты (`Terminal.svelte` — xterm.js,
`SftpPanel.svelte` — нативные диалоги и pointer-DnD, `SettingsPanel.svelte`,
`MonitoringOverlay.svelte` — петля опроса метрик) исключены из **покрытия** (их
чистая логика живёт в покрытых `.ts`-модулях — `thresholds.ts`/`format.ts`), но
поведение всё равно проверяется smoke/компонентными тестами и E2E-набором.
Пример поведения, проверяемого только E2E/вручную (Фаза 20.11): латч `connected`
в `Terminal.svelte` прячет плавающий тумблер Raw↔Table, пока SSH-вкладка ещё
подключается (`jsonViewEnabled && connected`), чтобы он не торчал над connecting-оверлеем.

---

## E2E-тесты

Каталог [e2e/](../e2e/) — самодостаточный (свой `package.json`). Драйвит **реальное
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
`+page.svelte` (Фаза 5.8). Подробности — [e2e/README.md](../e2e/README.md).

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

### Живые SFTP-тесты (`live_sftp`, Фаза 39.6)

Модуль `live_sftp` в [sftp.rs](../src-tauri/src/sftp.rs) гоняет **round-trip
сохранения против настоящего sshd** — того же контейнера. Тесты помечены
`#[ignore]`, поэтому обычный `cargo test` остаётся герметичным:

```sh
docker compose -f e2e/docker-compose.ssh.yml up -d
cargo test --manifest-path src-tauri/Cargo.toml --lib live_sftp -- --ignored
docker compose -f e2e/docker-compose.ssh.yml down
```

**Зачем отдельный слой.** Весь набор чистых тестов `sftp.rs` (`apply_eol`,
`temp_sibling`, `looks_binary`, `sha256_hex`) был зелёным, пока редактор
**уничтожал каждый сохранённый файл**: `FileAttributes::default()` в russh-sftp
поднимал `ATTR_SIZE = 0`, сервер делал `truncate`, и пустой временный файл
переезжал на место пользовательского конфига. Дефект жил не в вычисленном
значении, а в том, **что мы попросили сделать сервер**, — такое невидимо без
сервера на другом конце, сколько ни пиши юнит-тестов.

Шесть случаев:

| Тест | Что закрепляет |
| --- | --- |
| `save_keeps_the_content_it_reported_writing` | Файл на сервере совпадает и с правкой, и с распиской (`WriteResult`), которую получил редактор. Тот самый баг 39.6 |
| `save_preserves_permission_bits` | Права переносятся на замену — чтобы «фикс» не выродился в «вообще не слать атрибуты» |
| `save_rewrites_in_the_original_encoding` | Контракт кодировок Фазы 39 (UTF-16LE + CRLF) — впервые проверен по проводу, а не в памяти |
| `backup_copy_is_a_sibling_that_keeps_the_original_mode` | Настройка «копия .bak»: где лежит, что содержит и **чем читается** — копия создавалась с правами по умолчанию, поэтому `0600`-конфиг с учётными данными резервировался в `0644` |
| `a_failed_backup_aborts_the_save_and_leaves_the_file_intact` | Не удалось сделать копию → сохранение **отменяется**, на сервере остаётся оригинал. Провал подстраивается каталогом на имени `.bak` (файлом это не станет никакими правами, и root не нужен) |
| `backup_is_skipped_for_a_file_that_does_not_exist_yet` | Обратная сторона: копировать нечего — это не провал бэкапа, первое сохранение нового файла проходит |

Всё, что меняет **разговор с сервером** (атрибуты, порядок `remove`/`rename`,
кодировки), закрепляй здесь, а не только юнит-тестом на чистой функции.

---

## Покрытие и гейты

| Область | Гейт | Где настроен |
|---------|------|--------------|
| Чистая логика фронта (`tree`, `format`, `themes`, `clipboard`) | **≥ 90 %** по строкам/ветвям/функциям | `thresholds` в [vitest.config.ts](../vitest.config.ts) |
| Фронтенд в целом (в пределах `include`) | **≥ 80 %** | там же |
| Rust | Cobertura-отчёт в MR-виджете | job `test:rust` |

`pnpm test:coverage` завершается с ненулевым кодом, если порог не достигнут —
именно это и блокирует пайплайн. Отчёты: текст в консоли, HTML в `coverage/`,
Cobertura (`coverage/cobertura-coverage.xml`) и JSON-summary для CI.

---

## CI-пайплайн

[.gitlab-ci.yml](../.gitlab-ci.yml), стадии **`lint` → `test` → `build` → `release`**.
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
