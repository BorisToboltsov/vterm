# Установка, сборка и запуск vterm

Требования, установка для разработки, сборка дистрибутивов и запуск готового
приложения. Возможности и использование — в [GUIDE.md](GUIDE.md); решение проблем —
в [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Требования к окружению

Нужны на обеих ОС:

- **Node.js** 20+ и **pnpm** (через `corepack` или standalone-инсталлятор).
- **Rust** stable через [rustup](https://rustup.rs/) (используется 1.96+).

Дополнительно по платформам:

### macOS
- **Xcode Command Line Tools**: `xcode-select --install`.
- WebView предоставляется системой (WKWebView), отдельная установка не нужна.

### Windows
- **Microsoft C++ Build Tools** (компонент «Сборка C++» из Visual Studio Build
  Tools) — нужен линковщик MSVC.
- **WebView2 Runtime** (на Windows 11 предустановлен; на Windows 10 ставится
  [отсюда](https://developer.microsoft.com/microsoft-edge/webview2/)).

Подробности — в официальной инструкции
[Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/).

## Установка и запуск (разработка)

```bash
# 1. Установить JS-зависимости
pnpm install

# 2. Запустить приложение в режиме разработки
pnpm tauri dev
```

`pnpm tauri dev` поднимает Vite на `http://localhost:1420`, компилирует Rust-бэкенд
(первая сборка — 1–2 минуты, дальше быстрее за счёт кэша) и открывает нативное окно
с горячей перезагрузкой фронтенда.

> **Если `pnpm` или `cargo` не находятся** (`command not found`) — инструменты стоят
> в нестандартных путях. Откройте новую вкладку терминала (профиль перечитается) или
> выполните в текущей сессии:
>
> ```bash
> export PATH="$HOME/Library/pnpm/bin:$PATH"   # pnpm
> source "$HOME/.cargo/env"                     # cargo
> ```

## Установка на Windows (с нуля)

Пошагово для **чистой Windows-машины** после того, как репозиторий уже скопирован
(`git clone` или распакованный архив). Все команды выполняются в **PowerShell**.

> **Если исходники скопированы с macOS — сначала вычисти файлы `._*`.**
> При переносе с Mac через флешку (FAT/exFAT), сетевую шару или zip, собранный
> в macOS, рядом с каждым файлом появляется служебный **AppleDouble**-двойник
> `._имя` (бинарные метаданные, не UTF-8). Сборочный скрипт Tauri читает **все**
> файлы из `src-tauri\capabilities\` как JSON и падает на таком двойнике:
>
> ```
> failed to read file 'capabilities\._default.json': stream did not contain valid UTF-8
> ```
>
> Такие файлы обычно имеют атрибут **hidden**, поэтому `dir` и Проводник их не
> показывают, а обычный `del` отказывается удалять — кажется, что файла нет, а он на
> месте. Найти (ключ `-Force` / `/a` показывает скрытые) и удалить из корня репозитория:
>
> ```powershell
> # посмотреть, что есть
> Get-ChildItem -Path . -Recurse -Force -Filter '._*'
>
> # удалить все
> Get-ChildItem -Path . -Recurse -Force -Filter '._*' | Remove-Item -Force
> ```
>
> Проверить конкретно каталог капабилити (в нём должен остаться только `default.json`):
>
> ```powershell
> dir /a /b /s src-tauri\capabilities
> ```
>
> Если переносил zip'ом — удали заодно папки `__MACOSX`. Надёжнее всего забирать код
> через `git clone` — тогда двойников не будет в принципе, git их не отслеживает.

### 1. Системные компоненты

Проще всего поставить зависимости через **winget** (встроен в Windows 10 1709+ /
Windows 11). Открой PowerShell и выполни:

```powershell
# Rust (компилятор + cargo) через rustup
winget install --id Rustlang.Rustup -e

# Node.js LTS (даёт node + npm; pnpm включим ниже через corepack)
winget install --id OpenJS.NodeJS.LTS -e

# Microsoft C++ Build Tools — нужен линковщик MSVC для сборки Rust
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# WebView2 Runtime — движок окна Tauri (на Windows 11 обычно уже стоит)
winget install --id Microsoft.EdgeWebView2Runtime -e
```

> Если `winget` недоступен — поставь те же компоненты вручную:
> [rustup](https://rustup.rs/) · [Node.js LTS](https://nodejs.org/) ·
> [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
> (отметь рабочую нагрузку **«Разработка классических приложений на C++»**) ·
> [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

**Закрой и открой PowerShell заново** (или перелогинься), чтобы обновился `PATH`
и стали видны `cargo`, `node`, `corepack`.

### 2. Активировать pnpm

```powershell
corepack enable
corepack prepare pnpm@latest --activate
```

Проверка, что всё на месте:

```powershell
rustc --version    # напр. rustc 1.9x.x
node  --version    # напр. v20.x
pnpm  --version    # напр. 9.x
```

### 3. Установить зависимости и запустить

Из корня репозитория:

```powershell
# JS-зависимости
pnpm install

# Запуск в режиме разработки (первая Rust-сборка — 1–2 минуты)
pnpm tauri dev
```

### 4. Собрать дистрибутив (опционально)

```powershell
pnpm tauri build
```

Готовые файлы появятся в `src-tauri\target\release\bundle\` — установщики `.msi`
(в `msi\`) и/или NSIS `.exe` (в `nsis\`); портативный `vterm.exe` —
в `src-tauri\target\release\`.

> **Возможные проблемы (Windows).**
> - *`link.exe` not found* / ошибка линковки — не доустановлены **C++ Build Tools**
>   (шаг 1) или не перезапущен терминал.
> - *Окно не открывается / белый экран* — не установлен **WebView2 Runtime**.
> - *`pnpm` не распознан* — не выполнен `corepack enable` (шаг 2) или не перезапущен
>   терминал.
> - *`failed to read file 'capabilities\._default.json': stream did not contain valid
>   UTF-8`* — в исходниках остались скрытые AppleDouble-файлы `._*` после копирования
>   с macOS; чистка — во врезке в начале раздела «Установка на Windows (с нуля)».

## Сборка дистрибутивов

```bash
pnpm tauri build
```

Команда собирает фронтенд, компилирует Rust в release и упаковывает нативный
дистрибутив **только для текущей ОС**.

⚠️ **Важно: один файл, работающий и на Windows, и на macOS, невозможен** — у систем
разные форматы исполняемых файлов (PE/`.exe` vs Mach-O). Поэтому на каждом этапе
собираются **два отдельных артефакта**, по одному на ОС. Кросс-компиляция между
macOS и Windows на одной машине для Tauri-приложения нерабочая (нужны системный
WebView и линковщик целевой ОС), поэтому **оба файла собираются в CI** — см. ниже.

Результат локальной сборки появляется в `src-tauri/target/release/bundle/`:

- **macOS** — `.app` (портативный бандл, можно перетащить куда угодно) и `.dmg`
  в подкаталогах `macos/` и `dmg/`.
- **Windows** — `.msi` (WiX) и/или установщик NSIS (`.exe`) в `msi/` и `nsis/`.
  Сам `vterm.exe` из `target/release/` — это портативный файл (нужен лишь системный
  WebView2 Runtime).

> Для распространения без предупреждений ОС потребуется подпись кода: Apple
> Developer ID + нотаризация на macOS и code-signing сертификат на Windows. Это
> вынесено в Фазу 15 (см. [ROADMAP.md](ROADMAP.md)).

## Непрерывная сборка (CI): два файла на каждом этапе

Чтобы на каждом этапе гарантированно получать **оба** дистрибутива, настроен
**GitLab CI** [.gitlab-ci.yml](../.gitlab-ci.yml) с двумя задачами сборки — на
macOS- и Windows-раннерах:

| Событие | Что происходит |
|---------|----------------|
| push в дефолтную ветку, Merge Request, ручной запуск | Сборка обеих ОС, файлы — в **артефактах пайплайна** (`vterm-macos`, `vterm-windows`) |
| push тега вида `v1.2.3` | Дополнительно создаётся **GitLab Release** для обеих ОС |

macOS собирается как **universal** (Intel + Apple Silicon). Конфиг рассчитан на
**self-hosted раннеры**: в [.gitlab-ci.yml](../.gitlab-ci.yml) указаны теги-плейсхолдеры
`macos` / `windows` / `linux` — замените их на теги своих раннеров
(*GitLab → Settings → CI/CD → Runners*). Раннер macOS должен иметь Xcode CLT, раннер
Windows — VS C++ Build Tools и WebView2 Runtime; Rust и pnpm CI ставит сам
(идемпотентно). Сборка активируется после публикации репозитория в GitLab; локально
по-прежнему доступна сборка только под текущую ОС через `pnpm tauri build`.

## Запуск готового приложения

### macOS
1. Открыть `.dmg`, перетащить **vterm.app** в `/Applications`.
2. Запустить. Если сборка не подписана, при первом запуске:
   правый клик по приложению → **«Открыть»** → подтвердить
   (либо разрешить в *Системные настройки → Конфиденциальность и безопасность*).

### Windows
1. Запустить `.msi` или NSIS-`.exe` и пройти установку.
2. Запустить **vterm** из меню «Пуск». Если установщик не подписан, SmartScreen
   может показать предупреждение — *«Подробнее» → «Выполнить в любом случае»*.

## Команды проекта

| Команда | Действие |
|---------|----------|
| `pnpm install` | Установить JS-зависимости |
| `pnpm tauri dev` | Запуск приложения в режиме разработки |
| `pnpm tauri build` | Сборка нативного дистрибутива для текущей ОС |
| `pnpm dev` | Только фронтенд (Vite) без окна Tauri |
| `pnpm build` | Сборка фронтенда (SPA через adapter-static) |
| `pnpm check` | Проверка типов и a11y (`svelte-check`) |
| `pnpm test` | Фронтенд-тесты (Vitest: юнит + компонентные) |
| `pnpm test:watch` | Тесты Vitest в watch-режиме |
| `pnpm test:coverage` | Тесты Vitest с покрытием и гейтами |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust-юнит-тесты |
| `pnpm tauri --version` | Версия Tauri CLI |
| `rm -rf src-tauri/target/release/bundle` | Очистка готовых бандлов (.app/.dmg/.msi/.exe) — лёгкая, кэш сборки цел |
| `cargo clean --manifest-path src-tauri/Cargo.toml` | Полная очистка `src-tauri/target` (десятки ГБ) — следующая сборка будет с нуля |

> **Очистка места.** `src-tauri/target` растёт до десятков ГБ (в основном
> `target/debug` — инкрементальный кэш компилятора). После зелёного прогона гейтов
> удаляй **готовые бандлы** — `rm -rf src-tauri/target/release/bundle` (весят больше
> всего, не нужны после проверки); инкрементальный кэш при этом сохраняется и держит
> следующую сборку быстрой. Если места критически не хватает — полная очистка
> `cargo clean` (или `rm -rf src-tauri/target`) сносит **весь** кэш: место
> освобождается максимально, но ближайшая `pnpm tauri dev`/`build` пересоберёт Rust
> с нуля (~1–2 мин и дольше).

> Подробно о тестах (E2E, покрытие, CI) — [TESTS.md](TESTS.md).
