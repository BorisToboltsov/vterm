# Установка и сборка vterm

Готовые сборки, требования, разработка, упаковка дистрибутивов и релизы.
Возможности — в [GUIDE.md](GUIDE.md); решение проблем — в [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

**Содержание:**
[⬇️ Готовая сборка](#готовая-сборка) ·
[🧩 Требования](#требования) ·
[🛠️ Разработка](#разработка) ·
[📦 Сборка дистрибутивов](#сборка-дистрибутивов) ·
[🚀 Релизы через CI](#релизы-через-ci) ·
[⌨️ Команды проекта](#команды-проекта)

---

## Готовая сборка

Файлы под все три ОС — на странице [релизов](https://github.com/BorisToboltsov/vterm/releases/latest).

| ОС | Файл | Установка и первый запуск |
|----|------|---------------------------|
| **macOS** | `.dmg` | Открыть, перетащить **vterm.app** в `/Applications`. Сборка не подписана — см. врезку ниже |
| **Windows** | `-setup.exe` (NSIS) · `.msi` | Обычная установка. SmartScreen → *«Подробнее» → «Выполнить в любом случае»* |
| **Windows** | `vterm-portable-…-x86_64.exe` | Один файл, без установки — скопировал и запустил |
| **Linux** | `.deb` · `.rpm` · AppImage | Пакетный менеджер; AppImage — `chmod +x` и запуск |

> **macOS: «не удаётся проверить разработчика» / «программа повреждена».** Сборка не
> подписана Developer ID и не нотаризована, поэтому при переносе (интернет / AirDrop /
> флешка) macOS ставит ей карантин Gatekeeper. Рядом с `.dmg` в релизе лежит хелпер: он
> ставит `.app` в `/Applications`, снимает карантин, при необходимости подписывает
> ad-hoc и открывает приложение.
>
> ```bash
> chmod +x open-on-mac.sh && ./open-on-mac.sh
> ```
>
> Вручную то же самое для уже установленного бандла:
> `xattr -dr com.apple.quarantine /Applications/vterm.app`. Это обход на стороне
> получателя — прогнать нужно каждому, кому отдаёте сборку; предупреждения совсем
> убирает только подпись Developer ID + нотаризация (Фаза 15, [ROADMAP.md](ROADMAP.md)).

**Portable — это про один файл, а не про переносимое состояние.** Нужен системный
**WebView2 Runtime** (предустановлен в Windows 11 и Windows 10 21H2+), а профили
серверов и `known_hosts` по-прежнему пишутся в `%APPDATA%\vterm`, секреты — в Windows
Credential Manager. Запуск с флешки не оставит систему нетронутой и не перенесёт
настройки на другую машину.

---

## Требования

Нужны только для сборки из исходников. На всех ОС: **Node.js 20+**, **pnpm**
и **Rust stable** ([rustup](https://rustup.rs/)).

| ОС | Дополнительно |
|----|---------------|
| **macOS** | Xcode Command Line Tools (`xcode-select --install`); WebView даёт система |
| **Windows** | [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — нагрузка «Разработка классических приложений на C++» (линковщик MSVC) · [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) |
| **Linux** | `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, `patchelf` (+ `rpm` для `.rpm`) |

Полный список — [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/).

### Windows с нуля

На чистой машине всё ставится через **winget** (есть в Windows 10 1709+ и Windows 11):

```powershell
winget install --id Rustlang.Rustup -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Microsoft.EdgeWebView2Runtime -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**Закройте и откройте PowerShell заново**, чтобы обновился `PATH`, затем включите pnpm
и проверьте, что всё на месте:

```powershell
corepack enable
corepack prepare pnpm@latest --activate
rustc --version; node --version; pnpm --version
```

---

## Разработка

```bash
pnpm install      # JS-зависимости
pnpm tauri dev    # dev-режим
```

`pnpm tauri dev` поднимает Vite на `http://localhost:1420`, компилирует Rust-бэкенд
(первая сборка — 1–2 минуты, дальше быстрее за счёт кэша) и открывает нативное окно
с горячей перезагрузкой фронтенда.

> `pnpm` или `cargo` не находятся, сборка падает на Windows, приложение не открывается
> на другом Mac — [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Сборка дистрибутивов

```bash
pnpm tauri build        # дистрибутив под текущую ОС
pnpm tauri:build:mac    # то же + open-on-mac.sh рядом с .dmg
```

Результат — в `src-tauri/target/release/bundle/`:

| ОС | Артефакты |
|----|-----------|
| **macOS** | `macos/vterm.app` (портативный бандл) · `dmg/*.dmg` |
| **Windows** | `msi/*.msi` · `nsis/*-setup.exe` · portable `src-tauri/target/release/vterm.exe` |
| **Linux** | `deb/*.deb` · `rpm/*.rpm` · `appimage/*.AppImage` |

⚠️ **Собирается только под текущую ОС.** Один файл для Windows и macOS невозможен —
у систем разные форматы исполняемых (PE/`.exe` vs Mach-O), а кросс-компиляция Tauri
между ОС нерабочая (нужны системный WebView и линковщик целевой ОС). Все три артефакта
на каждой фазе даёт CI (ниже).

Отдельного bundle-таргета «portable» у Tauri нет, и он не нужен: фронтенд вшит в бинарь,
а `.msi`/`.exe` — лишь установочные обёртки вокруг него, поэтому `vterm.exe` из
`release/` уже самодостаточен. CI кладёт его в релиз как
`vterm-portable-<версия>-x86_64.exe`.

> Сборки не подписаны. Для распространения без предупреждений ОС нужны Apple Developer
> ID + нотаризация (macOS) и code-signing сертификат (Windows) — Фаза 15, см.
> [ROADMAP.md](ROADMAP.md).

---

## Релизы через CI

**GitHub Actions** — [release.yml](../.github/workflows/release.yml), на раннерах GitHub
(для публичного репозитория бесплатны, свои поднимать не нужно). По пушу тега `v*`
собирает **macOS (universal), Windows и Linux** и создаёт **черновик** GitHub Release:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Два файла бандлер Tauri не производит, поэтому их доливает в тот же релиз
`gh release upload`: **`open-on-mac.sh`** рядом с `.dmg` (скачанный из релиза теряет
флаг исполняемости — нужен `chmod +x`) и **`vterm-portable-<версия>-x86_64.exe`**.
Прогон виден во вкладке **Actions**; готовый черновик — в **Releases**: проверить
ассеты и нажать **Publish** (либо `releaseDraft: false` в workflow — публиковать сразу).

**GitLab CI** — [.gitlab-ci.yml](../.gitlab-ci.yml) (`lint → security → test → build → release`) для
**self-hosted** раннеров: теги `macos` / `windows` / `linux` в конфиге замените на теги
своих раннеров (*Settings → CI/CD → Runners*). Пуш и MR дают артефакты пайплайна, тег
`v1.2.3` — GitLab Release. Rust и pnpm CI ставит сам.

---

## Команды проекта

| Команда | Действие |
|---------|----------|
| `pnpm install` | Установить JS-зависимости |
| `pnpm tauri dev` | Запуск приложения в режиме разработки |
| `pnpm tauri build` | Дистрибутив под текущую ОС |
| `pnpm tauri:build:mac` | То же + `open-on-mac.sh` рядом с `.dmg` |
| `pnpm dev` · `pnpm build` | Только фронтенд: Vite dev-сервер · production-сборка |
| `pnpm check` | Типы и a11y (`svelte-check`) |
| `pnpm test` · `pnpm test:coverage` | Vitest: юнит и компонентные · с покрытием и гейтами |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust-юнит-тесты |

> **Место на диске.** `src-tauri/target` растёт до десятков ГБ. После зелёного прогона
> удаляйте **готовые бандлы** — `rm -rf src-tauri/target/release/bundle`: весят больше
> всего, а инкрементальный кэш остаётся и держит следующую сборку быстрой. Полная
> очистка (`cargo clean --manifest-path src-tauri/Cargo.toml`) освобождает максимум, но
> ближайшая сборка пойдёт с нуля.

Подробно о тестах (E2E, покрытие, CI) — [TESTS.md](TESTS.md).
