# Установка и сборка vterm

Готовые сборки, требования, разработка, упаковка дистрибутивов и релизы.
Возможности — в [GUIDE.md](GUIDE.md); решение проблем — в [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

**Содержание:**
[⬇️ Готовая сборка](#готовая-сборка) ·
[🧩 Требования](#требования) ·
[🛠️ Разработка](#разработка) ·
[📦 Сборка дистрибутивов](#сборка-дистрибутивов) ·
[🚀 Релизы через CI](#релизы-через-ci) ·
[🏷️ Как выкатить релиз](#как-выкатить-релиз) ·
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

### Проверить скачанное

Выше вам предлагают снять карантин Gatekeeper и продавить SmartScreen — то есть
отключить ровно ту проверку, которая отвечает на вопрос «откуда этот файл». Поэтому в
релизе есть чем ответить на него самостоятельно.

**Контрольные суммы.** В ассетах лежит `SHA256SUMS`; положите его рядом со скачанными
файлами:

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

На macOS — `shasum -a 256 -c SHA256SUMS --ignore-missing`, в PowerShell —
`Get-FileHash .\vterm-portable-1.0.0-x86_64.exe` и сверить строку глазами.

**Происхождение сборки.** К каждому бандлу приложен подписанный SLSA-provenance:
он подтверждает, что файл собран этим репозиторием и этим workflow, а не кем-то ещё.
Проверяется [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify vterm_1.0.0_universal.dmg --repo BorisToboltsov/vterm
```

Это **не замена подписи разработчика**: Gatekeeper и SmartScreen проверяют совсем
другое и о provenance не знают. Но на вопрос «те ли это байты, что вышли из сборки»
он отвечает точно — а подпись Developer ID и нотаризация остаются в планах
(Фаза 15, [ROADMAP.md](ROADMAP.md)).

**Состав поставки.** `vterm-sbom.cdx.json` — SBOM в формате CycloneDX: полный список
зависимостей обеих экосистем, если вашей стороне нужно прогнать его своим сканером.

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
(для публичного репозитория бесплатны, свои поднимать не нужно). Единственный триггер —
**пуш тега `v*`**: ни push в `main`, ни кнопка «Run workflow» его не запускают. Собирает
**macOS (universal), Windows и Linux** параллельно (`fail-fast: false` — падение одной ОС
не убивает остальные) и создаёт **черновик** GitHub Release.

Перед сборкой обязательно проходит джоба `verify` — она вызывает
[ci.yml](../.github/workflows/ci.yml) целиком (линтеры, тесты, покрытие, production-сборка,
supply-chain). Красное дерево до сборки не доходит; связь держится гейтом
`releaseassets.guard.test.ts`. Прочие workflow репозитория — в
[TESTS.md](TESTS.md#ci-на-github).

После того как все три бандла легли в черновик, джоба `integrity` добавляет к нему
`SHA256SUMS`, SBOM (CycloneDX) и **SLSA-provenance** — см. «Проверить скачанное» ниже.

Linux-job намеренно собирается на **ubuntu-22.04**, а не на свежем образе: пакеты линкуются
с glibc сборочного хоста, поэтому его версия — пол совместимости артефакта. 22.04 (glibc 2.35)
покрывает и Debian 12, и Ubuntu 22.04/24.04+; сборка на 24.04/26.04 этот охват сужает.

**GitLab CI** — [.gitlab-ci.yml](../.gitlab-ci.yml) (`lint → security → test → build → release`) для
**self-hosted** раннеров: теги `macos` / `windows` / `linux` в конфиге замените на теги
своих раннеров (*Settings → CI/CD → Runners*). Пуш и MR дают артефакты пайплайна, тег
`v1.2.3` — GitLab Release. Rust и pnpm CI ставит сам.

---

## Как выкатить релиз

Пошагово, от чистого рабочего дерева до опубликованного релиза.

### 1. Поднять версию — одной командой

Версия живёт **только** в [package.json](../package.json); `tauri.conf.json` берёт её
оттуда ссылкой, а `Cargo.toml`/`Cargo.lock` синхронизирует скрипт. Схема и правила — в
[CLAUDE.md](../CLAUDE.md).

```bash
pnpm version:set 1.0.1
```

Руками манифесты не правь: расхождение ловит гейт `version.guard.test.ts`, а версия,
вписанная в `tauri.conf.json` литералом, разъедется с `package.json` на следующем бампе.

### 2. Прогнать все шесть гейтов

Красное чините здесь: в CI то же самое обойдётся в 20+ минут на трёх раннерах.

```bash
source "$HOME/.cargo/env"
export PATH="$HOME/Library/pnpm/bin:$PATH"

cargo fmt    --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test   --manifest-path src-tauri/Cargo.toml
pnpm check
pnpm test:coverage
pnpm build
```

`pnpm build` обязателен отдельно: CI зовёт его как `beforeBuildCommand`, и поломка
production-сборки видна только здесь — `pnpm check` (это лишь `svelte-check`) её пропускает.

### 3. Закоммитить и запушить

Тег указывает на **коммит**, а не на рабочее дерево: незакоммиченное в релиз не попадёт.

```bash
git status --short          # должно быть пусто
git push origin main
```

### 4. Поставить и запушить тег — это и есть кнопка «Собрать»

```bash
git tag v1.0.0
git push origin v1.0.0
```

### 5. Дождаться прогона

Вкладка **Actions** — три job'а. Дольше всех macOS: universal-сборка компилирует Rust
дважды, под `aarch64` и `x86_64`.

### 6. Проверить ассеты и опубликовать

Релиз создаётся **черновиком** (`releaseDraft: true`) — публично его не видно, пока вы не
нажмёте **Publish** в разделе **Releases**. Сначала сверьте список:

| ОС | Должно быть |
|----|-------------|
| **macOS** | `vterm_<версия>_universal.dmg` · **`open-on-mac.sh`** |
| **Windows** | `vterm_<версия>_x64_en-US.msi` · `vterm_<версия>_x64-setup.exe` · **`vterm-portable-<версия>-x86_64.exe`** |
| **Linux** | `.deb` · `.rpm` · `.AppImage` (x86_64) |

**Жирным** — два файла, которых бандлер Tauri не производит: их доливают отдельные шаги
через `gh release upload`. Если какого-то файла нет — упал job этой ОС, смотрите Actions.
Скачанный из релиза `open-on-mac.sh` теряет флаг исполняемости, получателю нужен `chmod +x`
(это написано в теле релиза).

### Если что-то пошло не так

**Прогон упал, нужно пересобрать тот же тег.** Кнопка «Re-run jobs» соберёт **тот же старый
коммит** — тег на него и указывает. После исправления тег надо перевесить:

```bash
git push origin :refs/tags/v1.0.0     # удалить тег на GitHub
git tag -d v1.0.0                     # и локально
git tag v1.0.0 && git push origin v1.0.0
```

Если черновик релиза при этом уже создан — удалите его в **Releases** перед пушем тега,
иначе рядом с новыми ассетами останутся старые. Повторная заливка одноимённых файлов
конфликта не даёт (`gh release upload --clobber`), поэтому re-run **одной** упавшей ОС
безопасен, если остальные собрались.

**Упал только шаг заливки ассетов (403).** *Settings → Actions → General → Workflow
permissions* → «Read and write permissions». В workflow уже стоит `permissions: contents:
write`, но настройка репозитория — потолок над ней.

**Релиз собрался, но хочется поправить косметику в workflow.** Не перевешивайте тег ради
этого: зелёный релиз с готовыми ассетами дороже, чем снятый варнинг. Правки уедут со
следующим тегом.

**Обкатать без «настоящего» релиза.** Тег вида `v1.0.0-rc1` подходит под маску `v*`,
собирается так же, а черновик потом удаляется бесследно.

### Что закреплено тестами

[releaseassets.guard.test.ts](../src/lib/releaseassets.guard.test.ts) читает workflow и
падает, если: пропал шаг заливки `open-on-mac.sh` или portable-`.exe`; `node-version` не
перекрывает пол запиненного мажора pnpm (pnpm 11 требует Node ≥ 22.13 и умирает первым же
вызовом); какой-то экшен откатился на мажор с рантаймом Node 20. Все три — поломки, зелёные
локально и видимые только в CI.

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
