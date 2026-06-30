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
  в `lib.rs`) и каналы событий (`term://…`, `sftp://…`, `menu://…`). Новый
  функционал такого рода: команда в бэкенде + типизированная обёртка в
  [src/lib/api.ts](../src/lib/api.ts). Не дублируй бизнес-логику на фронте. (ADR 0001)
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
    `phase_event`, payload `connecting`→`authenticating`→`session`, эмитится по ходу
    последовательных стадий `connect`); фронт слушает его в `Terminal.svelte` (проп `onphase`,
    только SSH), а чистый маппинг фаза→состояние-шага — в [connphase.ts](../src/lib/connphase.ts)
    (`phaseSteps`, ADR 0003). Новую стадию подключения добавляй как новый `emit` в `connect` +
    запись в `PHASE_ORDER`, не плоди отдельные каналы. Анимации — только дешёвые
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
  [actions/drag.ts](../src/lib/actions/drag.ts). Rust: `reprefixed`,
  `decode_or_default`. (ADR 0003)
- **Состояние UI — в runes-сторах** `src/lib/stores/*.svelte.ts` (по образцу
  [settings.svelte.ts](../src/lib/settings.svelte.ts)): `layout` (ширины/сворачивание
  панелей), `tabs` (вкладки терминалов). Не разбрасывай состояние по компонентам. (ADR 0003)
- **Компоненты декомпозированы.** `+page.svelte` — оркестратор; крупные части
  вынесены в `TopBar`, `ServerTree`. Переиспользуй примитивы `Modal`,
  `ConfirmDialog`, `Icon`. Иконки — из реестра [icons.ts](../src/lib/icons.ts) через
  `<Icon name="…" />`, **не эмодзи**. Pointer-drag — через `actions/drag.ts`. (ADR 0003)
  Оформление кнопок/иконок/строк — по закреплённой **дизайн-системе** (см. [DESIGN.md](DESIGN.md)).
- **Офлайн-инвариант.** Никаких runtime-обращений в сеть, кроме исходящего SSH к
  серверам пользователя. Шрифты встроены (`@fontsource`), внешние ссылки — только
  по явному клику через `tauri-plugin-opener`. Закреплено гейтом
  [autonomy.guard.test.ts](../src/lib/autonomy.guard.test.ts). (ADR 0004)
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
