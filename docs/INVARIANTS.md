# Инварианты vterm

Жёсткие контракты кодовой базы — **что обязан соблюдать и чего нельзя**. Это канон:
нарушать без явного решения нельзя. Обоснования решений — в [adr/](adr/); как всё
устроено (диаграмма, слои, спека подсистем) — в [ARCHITECTURE.md](ARCHITECTURE.md);
правила процесса — в [../CLAUDE.md](../CLAUDE.md) (он подключает этот файл через
`@`-импорт, поэтому инварианты авто-загружаются в каждую сессию).

---

## Архитектурные инварианты (выработано в Фазе 6 — соблюдать)

Полные обоснования — в [docs/adr/](adr/). Краткие правила:

- **Граница фронт/бэк.** Вся логика SSH/SFTP/секретов/файлов живёт в Rust-бэкенде
  (`src-tauri/src/`). Svelte-фронтенд ходит к ней только через `invoke()` (команды
  в `lib.rs`) и каналы событий (`term://…`, `sftp://…`, `menu://…`, `install://…`). Новый
  функционал такого рода: команда в бэкенде + типизированная обёртка в
  [src/lib/api/](../src/lib/api/). Не дублируй бизнес-логику на фронте. (ADR 0001)
  - **Единый контракт терминала.** SSH-сессии ([ssh.rs](../src-tauri/src/ssh.rs)) и
    локальные shell-вкладки ([pty.rs](../src-tauri/src/pty.rs), `portable-pty`)
    используют **один** канал событий (`term://out|closed/{id}`) и **одни** команды
    (`write_to_terminal`/`resize_pty`/`disconnect`, маршрутизация по `session_id`),
    поэтому [Terminal.svelte](../src/lib/Terminal.svelte) общий для обоих (проп
    `local`). Новый вид терминала подключай к этому же контракту, а не отдельным.
  - **Окно подключения (connecting-оверлей).** Пока SSH-вкладка в статусе
    `Connecting…`, поверх области терминала показывается
    [ConnectingOverlay.svelte](../src/lib/ConnectingOverlay.svelte): орбита-комета вокруг
    иконки сервера + `alias` + `user@host:port` + **честный** чек-лист фаз. Фазы —
    **реальные**, из дополнительного канала `term://phase/{id}` ([ssh.rs](../src-tauri/src/ssh.rs)
    `phase_event`, payload цели `connecting`→`authenticating`→`session`, эмитится по ходу
    последовательных стадий `connect`); фронт слушает его в `Terminal.svelte` (проп `onphase`,
    только SSH), а чистый маппинг фаза→состояние-шага — в [connphase.ts](../src/lib/connphase.ts)
    (`phaseSteps`, ADR 0003). Новую **обязательную** стадию добавляй как новый `emit` в `connect` +
    запись в `PHASE_ORDER`, не плоди отдельные каналы. **Прокси-подстадии** (Фаза 21) — тоже
    реальные события, **но не в `PHASE_ORDER`**: эмитятся первыми и группируются под прокси —
    jump host `proxyConnecting`/`proxyAuthenticating`/`proxyTunnel`, SOCKS5/HTTP
    `proxyConnecting`/`proxyHandshake`. `phaseSteps(current, errored, proxy)`
    (`proxy: "jump"|"tcp"|null`) добавляет их с тегом группы `proxy` только при наличии прокси
    (без прокси — плоский чек-лист, как раньше). **Фейковые подстадии рисовать нельзя** — для
    SOCKS5 честное разбиение достигается socket-вариантом `tokio-socks` (сами делаем
    `TcpStream::connect`, затем негоциацию). Анимации — только дешёвые
    `transform`/`opacity`, под глобальным `prefers-reduced-motion`-guard.
    **Тот же компонент — экран ошибки/обрыва** (проп `failed`): орбита заменяется
    статичной иконкой сервера с **красным крестом**, чек-лист **замирает на упавшей
    фазе** (`phaseSteps(phase, true)` → пройденные `done`, упавшая `error`, дальше
    `pending`), под ним — заголовок/красная деталь и **кнопки-действия через слот**
    (`children`). Старую тонкую верхнюю плашку оставляем **только для локальных
    вкладок**; для SSH — оверлей. Маппинг статуса вкладки в заголовок/деталь/упавшую
    фазу/действие — `sshErrorView` в [+page.svelte](../src/routes/+page.svelte).
    **Провал аутентификации больше не закрывает вкладку автоматически**: вкладка
    остаётся с оверлеем (`Соединение ✓ / Аутентификация ✗`), а модалка ввода секрета
    открывается **по кнопке** «Ввести пароль заново» (`reauth`), а не сразу.


- **Ошибки — типизированы.** В Rust возвращай `AppResult<T>`
  ([error.rs](../src-tauri/src/error.rs)), не `String`. Семантические случаи —
  отдельные варианты (`AuthRejected`, `HostKeyRejected`, `NoSession`,
  `UnknownServer`); прочее — `AppError::Message`. `AppError` сериализуется в строку,
  поэтому контракт с фронтом не меняется; маркеры (`auth-rejected` и т.п.) живут в
  `Display`. (ADR 0002)
- **Чистая логика — в `.ts`/свободных функциях**, не в `.svelte`/командах: её
  тестируют без DOM/сети. Фронт: [tree.ts](../src/lib/tree.ts),
  [format.ts](../src/lib/format.ts), [util.ts](../src/lib/util.ts),
  [actions/drag.ts](../src/lib/actions/drag.ts), [ssherror.ts](../src/lib/ssherror.ts)
  (статус SSH → оверлей), [virtuallist.ts](../src/lib/virtuallist.ts) (оконная
  виртуализация), [serverform.ts](../src/lib/serverform.ts) (валидаторы host/IP и порта
  формы сервера). Rust: `reprefixed`, `decode_or_default`, парсеры метрик в
  [metrics.rs](../src-tauri/src/metrics.rs). (ADR 0003)
- **Состояние UI — в runes-сторах** `src/lib/stores/*.svelte.ts` (по образцу
  [settings.svelte.ts](../src/lib/settings.svelte.ts)): `layout` (ширины/сворачивание
  панелей), `tabs` (вкладки терминалов). Не разбрасывай состояние по компонентам. (ADR 0003)
- **Компоненты декомпозированы.** `+page.svelte` — оркестратор; крупные части
  вынесены в `TopBar`, `ServerTree`, а самодостаточные модалки — в `ServerFormModal`,
  `FolderModals`, `SecretPrompt` (Фаза 18.4). `SettingsPanel` — тонкий shell, секции
  живут в `*SettingsSection.svelte` (Фаза 18.5). `api.ts` разложен по доменам в
  `src/lib/api/` с barrel-реэкспортом (Фаза 18.6). **Оверлеи всегда с явным
  `z-index`** (или через `Modal`/`ConfirmDialog`) — закреплено гейтом
  [overlay.guard.test.ts](../src/lib/overlay.guard.test.ts). Переиспользуй примитивы
  `Modal`, `ConfirmDialog`, `Icon`. Иконки — из реестра [icons.ts](../src/lib/icons.ts)
  через `<Icon name="…" />`, **не эмодзи**. Pointer-drag — через `actions/drag.ts`.
  Подсказки — через `use:tooltip` ([actions/tooltip.ts](../src/lib/actions/tooltip.ts)),
  **не** нативный `title` (кроме заголовков-пропов и раскрытия обрезанного текста);
  у icon-only кнопок обязателен `aria-label`. Длинные описания-подсказки —
  иконкой [InfoHint](../src/lib/InfoHint.svelte) рядом с меткой (к полю) или рядом с
  заголовком секции (вводное описание всей секции), а не абзацем-текстом. (ADR 0003)
  Оформление кнопок/иконок/строк — по закреплённой **дизайн-системе** (см. [DESIGN.md](DESIGN.md)).
- **Офлайн-инвариант.** Никаких runtime-обращений в сеть, кроме исходящего SSH к
  серверам пользователя (в т.ч. **через заданный им proxy** — jump host/SOCKS5/HTTP
  CONNECT, Фаза 21 — это часть пути к его же серверам) **и** — при включённом opt-in
  ИИ-ассистенте (Фаза 17) — исходящего к **пользовательскому** LLM-эндпоинту. Весь
  прокси-трафик идёт из Rust-бэкенда ([ssh.rs](../src-tauri/src/ssh.rs)), не из WebView.
  Шрифты встроены (`@fontsource`),
  внешние ссылки — только по явному клику через `tauri-plugin-opener`. **Весь
  LLM-трафик идёт из Rust-бэкенда** ([ai.rs](../src-tauri/src/ai.rs), `reqwest`), не
  из WebView, поэтому CSP остаётся строгим, а фронтенд по-прежнему не делает сетевых
  вызовов. ИИ **выключен по умолчанию**, зашитых облачных эндпоинтов нет (все —
  пользовательские). **Контекст сессии** (выделение/буфер/запись/метаданные) уходит к ИИ
  **только** после маскирования секретов ([redact.ts](../src/lib/redact.ts), маркер `‹redacted›`)
  **и** явного согласия пользователя ([AiConsentDialog.svelte](../src/lib/AiConsentDialog.svelte)) —
  в том числе на локальный эндпоинт. **Исполнение команд** ([aiexec.ts](../src/lib/aiexec.ts) +
  [AiChat.svelte](../src/lib/AiChat.svelte)): предложенные команды попадают в терминал только по
  режиму `execMode` (`suggest`/`confirm`/`auto`); **авто-режим никогда не запускается на
  прод-сервере** (тег `prod`/`production`, `isProdServer`), а выполненные команды пишутся в запись
  как аудит. **Флаг сервера `noAi`** (прод-защита) полностью **блокирует контекст и исполнение** для
  такого сервера — ассистент не получает его данные и не выполняет на нём команды. Закреплено гейтом
  [autonomy.guard.test.ts](../src/lib/autonomy.guard.test.ts). (ADR 0004)
  **Прод-детект — контракт точного тега** (Фаза 20.3): `isProdServer` матчит тег,
  равный `prod`/`production` (регистронезависимо, с trim); **не расширяй** до
  substring/токен-матчинга — иначе `non-prod`/`pre-prod` (staging) ложно попадут под
  прод-защиту и потеряют авто-исполнение. Наследования `prod`/`noAi` через
  папки-группы нет (папка — строковая метка). Deny-list опасных команд
  (`isDangerousCommand`) и маскирование (`redact.ts`) — **не** границы безопасности,
  а предохранители (bias: over-flag/over-mask); границы — прод/noAi-гейт + consent.
  Полный аудит и остаточные риски — в [SECURITY.md](../SECURITY.md#аудит-ии-агента-фаза-20).
- **Безопасность.** CSP в `tauri.conf.json` держи строгим (никаких удалённых
  origin'ов; не возвращай `csp: null`); capabilities — минимально необходимые
  (opener только `https://`, без `dialog:default`/`fs`/`dangerous*`). Секреты —
  только в keychain, оборачивай копии в `zeroize::Zeroizing`, **никогда не логируй**.
  Host-key дефолт — не «accept». Зависимости проходят `cargo audit`/`cargo deny`/
  `pnpm audit`/Semgrep (стадия `security` в CI). Гейты:
  [tauri-security.guard.test.ts](../src/lib/tauri-security.guard.test.ts), `deny.toml`.
  Полная модель — [SECURITY.md](../SECURITY.md).
- **Контракт типов — camelCase.** Rust-модели — `#[serde(rename_all = "camelCase")]`,
  зеркало в [src/lib/types.ts](../src/lib/types.ts). Новые поля старых структур —
  `#[serde(default)]`.
- **Персистентность:** профили/папки/known_hosts — JSON в конфиг-каталоге
  (`store.rs`); секреты — только в OS keychain (`secrets.rs`), никогда в файлах;
  настройки/layout UI — `localStorage` (runes-сторы). Для e2e — `data-testid`.
  **Секрет proxy/jump host** (Фаза 21) — тоже только в keychain, но под
  **proxy-scoped id** (`{id}::proxy`, `secrets.rs`), чтобы не конфликтовать с
  секретом самой цели; чистится в `delete_all`/`forget_secrets`.
