//! Встроенный WebView2 Runtime для «полного» portable-файла Windows.
//!
//! Окно vterm рисует системный WebView2. На Windows 10 LTSC, урезанных образах и
//! машинах без сети его нет, а поставить нечем: ни Store, ни winget, ни интернета.
//! Поэтому релиз несёт второй portable — `vterm-portable-<v>-x86_64-webview2.exe`:
//! тот же `vterm.exe`, к концу которого CI дописал **неизменённый** подписанный
//! Microsoft `.cab` Fixed Version runtime и 64-байтовый хвост-описание
//! (`scripts/webview2-runtime.mjs embed`). Windows дописанное не исполняет — exe
//! запускается как обычно.
//!
//! На старте (до создания окна) `prepare` решает, откуда брать движок:
//! * системный WebView2 есть или пользователь сам указал папку переменной
//!   `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` — ничего не делаем: системный runtime
//!   обновляется Windows Update, вшитый — никогда;
//! * хвоста нет (обычная сборка, лёгкий portable) — ничего не делаем;
//! * иначе — распаковка в `%LOCALAPPDATA%\vcore\vterm\data\webview2\<версия>` (один
//!   раз) и та же переменная окружения на неё: штатный механизм загрузчика WebView2.
//!
//! Распаковка **атомарна**: `.cab` копируется из exe с проверкой sha256 из хвоста,
//! разворачивается встроенным `expand.exe` во временную папку, и только целиком
//! готовая папка переименовывается в `<версия>`. Оборванная распаковка не выдаёт себя
//! за готовую. Сеть не нужна ни на одном шаге (офлайн-инвариант, ADR 0004).
//!
//! Решение и альтернативы — ADR 0013. Формат хвоста обязан совпадать с
//! `scripts/webview2-runtime.mjs` (гейт `webview2runtime.test.ts`).

// Чистая часть модуля вызывается только из Windows-ветки; на остальных ОС её держат
// тесты, поэтому в не-тестовой сборке под macOS/Linux она «мёртвая».
#![cfg_attr(not(windows), allow(dead_code))]

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Сигнатура хвоста — последние 8 байт файла.
pub const MAGIC: &[u8; 8] = b"VTWV2RT1";
/// Длина хвоста: версия (16) · sha256 (32) · длина `.cab` (8, LE) · сигнатура (8).
pub const TRAILER_LEN: usize = 64;
const VERSION_LEN: usize = 16;
/// Переменная, которой загрузчик WebView2 берёт папку Fixed Version runtime.
pub const ENV_FOLDER: &str = "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER";
/// Исполняемый файл движка — по нему узнаём корень распакованного runtime.
const ENGINE_EXE: &str = "msedgewebview2.exe";
/// Префиксы служебных файлов кэша (распаковка в процессе, копия `.cab`, корзина).
const PARTIAL_PREFIX: &str = ".partial-";
const CAB_PREFIX: &str = ".cab-";
const TRASH_PREFIX: &str = ".trash-";
/// Служебный файл старше этого — брошен упавшим запуском, его можно убрать.
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

/// Описание вшитого runtime из хвоста exe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trailer {
    pub version: String,
    pub sha256: [u8; 32],
    pub cab_len: u64,
}

/// Версия Fixed Version runtime: ровно четыре числа через точку. Строгая проверка
/// не косметика: версия становится именем каталога кэша, и `..\..` из повреждённого
/// хвоста иначе увёл бы распаковку за его пределы.
pub fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Разбирает последние [`TRAILER_LEN`] байт файла. `None` — хвоста нет (обычный exe)
/// или он не наш: чужие байты в конце файла не повод что-то распаковывать.
pub fn parse_trailer(tail: &[u8]) -> Option<Trailer> {
    if tail.len() != TRAILER_LEN || &tail[56..64] != MAGIC {
        return None;
    }
    let raw = &tail[..VERSION_LEN];
    let end = raw.iter().position(|&b| b == 0).unwrap_or(VERSION_LEN);
    if raw[end..].iter().any(|&b| b != 0) {
        return None;
    }
    let version = std::str::from_utf8(&raw[..end]).ok()?.to_string();
    if !valid_version(&version) {
        return None;
    }
    let mut sha256 = [0u8; 32];
    sha256.copy_from_slice(&tail[16..48]);
    let cab_len = u64::from_le_bytes(tail[48..56].try_into().ok()?);
    if cab_len == 0 {
        return None;
    }
    Some(Trailer {
        version,
        sha256,
        cab_len,
    })
}

/// Обратная операция — для тестов и как документация формата (пишет его
/// `scripts/webview2-runtime.mjs`).
#[cfg(test)]
pub fn encode_trailer(t: &Trailer) -> [u8; TRAILER_LEN] {
    let mut out = [0u8; TRAILER_LEN];
    out[..t.version.len()].copy_from_slice(t.version.as_bytes());
    out[16..48].copy_from_slice(&t.sha256);
    out[48..56].copy_from_slice(&t.cab_len.to_le_bytes());
    out[56..64].copy_from_slice(MAGIC);
    out
}

/// Читает хвост открытого exe. `Ok(Some((хвост, смещение .cab)))`, если он есть и
/// `.cab` помещается в файл целиком.
pub fn read_trailer<R: Read + Seek>(r: &mut R) -> io::Result<Option<(Trailer, u64)>> {
    let len = r.seek(SeekFrom::End(0))?;
    if len < TRAILER_LEN as u64 {
        return Ok(None);
    }
    r.seek(SeekFrom::Start(len - TRAILER_LEN as u64))?;
    let mut tail = [0u8; TRAILER_LEN];
    r.read_exact(&mut tail)?;
    let Some(t) = parse_trailer(&tail) else {
        return Ok(None);
    };
    match (len - TRAILER_LEN as u64).checked_sub(t.cab_len) {
        Some(offset) => Ok(Some((t, offset))),
        None => Ok(None),
    }
}

/// Что делать на старте.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    /// Ничего: движок даст система (или пользователь).
    Leave,
    /// Движка нет нигде: ни в системе, ни в exe. Вместо падения при создании
    /// окна — объяснение, что скачать или поставить.
    Missing,
    /// Вшитый runtime уже распакован — только указать на него.
    UseCache,
    /// Распаковать вшитый runtime и указать на него.
    Extract,
}

/// Выбор источника движка. Порядок важен: системный runtime (и явный выбор
/// пользователя) всегда побеждает вшитый — тот не обновляется никогда.
pub fn decide(env_set: bool, system_installed: bool, bundled: bool, cache_ready: bool) -> Choice {
    if env_set || system_installed {
        Choice::Leave
    } else if !bundled {
        Choice::Missing
    } else if cache_ready {
        Choice::UseCache
    } else {
        Choice::Extract
    }
}

/// Версия из реестра (`pv` ключа EdgeUpdate) означает установленный runtime, если
/// она не пуста и не `0.0.0.0` — так проверку описывает Microsoft: после удаления
/// ключ иногда остаётся с нулевой версией.
pub fn is_installed_version(pv: &str) -> bool {
    let pv = pv.trim();
    !pv.is_empty() && pv != "0.0.0.0"
}

/// Есть ли движок в каталоге установки Evergreen (`…\EdgeWebView\Application`):
/// там лежат папки версий, во время обновления — сразу две. Страховка поверх
/// реестра: ложное «не найден» запретило бы запуск, который бы удался.
pub fn has_installed_engine(app_dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(app_dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        valid_version(&e.file_name().to_string_lossy()) && e.path().join(ENGINE_EXE).is_file()
    })
}

/// Корень распакованного runtime — папка, где лежит `msedgewebview2.exe`: сам
/// каталог или его единственный подкаталог (`.cab` Microsoft кладёт всё в
/// `Microsoft.WebView2.FixedVersionRuntime.<версия>.<arch>\`).
pub fn find_runtime_root(dir: &Path) -> Option<PathBuf> {
    if dir.join(ENGINE_EXE).is_file() {
        return Some(dir.to_path_buf());
    }
    let mut found = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join(ENGINE_EXE).is_file() {
            if found.is_some() {
                return None; // два кандидата — не угадываем
            }
            found = Some(path);
        }
    }
    found
}

/// Копирует `len` байт с `offset` из `src` в `dst`, считая sha256 на лету: один
/// проход по 300 МБ вместо двух.
pub fn copy_with_sha256<R: Read + Seek, W: Write>(
    src: &mut R,
    offset: u64,
    len: u64,
    dst: &mut W,
) -> io::Result<[u8; 32]> {
    src.seek(SeekFrom::Start(offset))?;
    let mut limited = src.take(len);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut copied = 0u64;
    loop {
        let n = limited.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        dst.write_all(&buf[..n])?;
        copied += n as u64;
    }
    if copied != len {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!("embedded runtime is truncated: {copied} of {len} bytes"),
        ));
    }
    dst.flush()?;
    Ok(hasher.finalize().into())
}

/// Уникальный суффикс служебного имени: pid + наносекунды, чтобы два запуска
/// подряд (или одновременно) не делили одну временную папку.
fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// Распаковывает вшитый runtime в `base/<версия>` и возвращает его корень.
///
/// `prepare_dir` вызывается на пустой временной папке до распаковки (на Windows —
/// права песочнице WebView2, которые файлы затем наследуют), `expand` разворачивает
/// `.cab` в папку. Обе — параметры, чтобы путь целиком гонялся тестами на любой ОС.
pub fn install<R, P, E>(
    exe: &mut R,
    trailer: &Trailer,
    cab_offset: u64,
    base: &Path,
    prepare_dir: P,
    expand: E,
) -> io::Result<PathBuf>
where
    R: Read + Seek,
    P: Fn(&Path) -> io::Result<()>,
    E: Fn(&Path, &Path) -> io::Result<()>,
{
    fs::create_dir_all(base)?;
    let suffix = unique_suffix();
    let partial = base.join(format!("{PARTIAL_PREFIX}{suffix}"));
    let cab = base.join(format!("{CAB_PREFIX}{suffix}"));
    fs::create_dir(&partial)?;

    let staged = (|| {
        prepare_dir(&partial)?;
        let sha = {
            let mut out = io::BufWriter::new(fs::File::create(&cab)?);
            copy_with_sha256(exe, cab_offset, trailer.cab_len, &mut out)?
        };
        if sha != trailer.sha256 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "embedded runtime checksum mismatch (the .exe is damaged)",
            ));
        }
        expand(&cab, &partial)?;
        find_runtime_root(&partial).map(|_| ()).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{ENGINE_EXE} not found after unpacking"),
            )
        })
    })();
    let _ = fs::remove_file(&cab);
    if let Err(e) = staged {
        let _ = fs::remove_dir_all(&partial);
        return Err(e);
    }

    let target = base.join(&trailer.version);
    // Остаток прежней версии без движка (кто-то стёр файлы руками) мешает rename.
    if target.exists() && find_runtime_root(&target).is_none() {
        let _ = fs::remove_dir_all(&target);
    }
    if let Err(e) = fs::rename(&partial, &target) {
        let _ = fs::remove_dir_all(&partial);
        // Второй запуск успел первым — его результат так же годен.
        if find_runtime_root(&target).is_none() {
            return Err(e);
        }
    }
    find_runtime_root(&target).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("{ENGINE_EXE} not found in {}", target.display()),
        )
    })
}

/// Убирает из кэша прежние версии и брошенные служебные файлы. Только то, что
/// безопасно: чужая версия сперва переименовывается в корзину — на Windows это не
/// удаётся, пока её держит запущенный старый vterm, и тогда она остаётся целой, а не
/// наполовину удалённой. Ошибки глушатся: это уборка, а не условие запуска.
pub fn cleanup_stale(base: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if name == keep {
            continue;
        }
        if name.starts_with(PARTIAL_PREFIX)
            || name.starts_with(CAB_PREFIX)
            || name.starts_with(TRASH_PREFIX)
        {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age >= STALE_AFTER);
            if old {
                let _ = fs::remove_dir_all(&path).or_else(|_| fs::remove_file(&path));
            }
        } else if valid_version(&name) {
            let trash = base.join(format!("{TRASH_PREFIX}{}", unique_suffix()));
            if fs::rename(&path, &trash).is_ok() {
                let _ = fs::remove_dir_all(&trash);
            }
        }
    }
}

/// Тексты окна подготовки и ошибки. Они живут здесь, а не в `messages.ts`: окно
/// WebView ещё не создано, `t()` и настройка языка недоступны. Язык — по языку
/// интерфейса Windows; набор языков тот же, что у приложения (en, ru).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Msg {
    Preparing,
    Failed,
    Missing,
}

pub fn text(msg: Msg, russian: bool) -> &'static str {
    match (msg, russian) {
        (Msg::Preparing, true) => {
            "vterm готовит встроенный WebView2 Runtime…\n\nЭто делается один раз и может занять минуту-другую."
        }
        (Msg::Preparing, false) => {
            "vterm is preparing the bundled WebView2 Runtime…\n\nThis happens once and may take a minute or two."
        }
        (Msg::Failed, true) => {
            "Не удалось подготовить встроенный WebView2 Runtime.\n\nПричина: {err}\nПапка: {dir}\n\nОсвободите место на диске и запустите vterm снова либо установите WebView2 Runtime (docs/INSTALL.md)."
        }
        (Msg::Failed, false) => {
            "Could not prepare the bundled WebView2 Runtime.\n\nReason: {err}\nFolder: {dir}\n\nFree up disk space and start vterm again, or install the WebView2 Runtime (docs/INSTALL.md)."
        }
        (Msg::Missing, true) => {
            "Не найден Microsoft Edge WebView2 Runtime — без него окно vterm не откроется.\n\nЧто можно сделать:\n\n• Скачать vterm-portable-…-x86_64-webview2.exe — тот же portable, WebView2 уже внутри (без установки, без сети и без прав администратора):\n{releases}\n\n• Или установить WebView2 Runtime (на машине без сети — Standalone Installer):\n{webview2}\n\nCtrl+C копирует этот текст вместе со ссылками."
        }
        (Msg::Missing, false) => {
            "Microsoft Edge WebView2 Runtime was not found — vterm cannot open its window without it.\n\nWhat you can do:\n\n• Download vterm-portable-…-x86_64-webview2.exe — the same portable with WebView2 inside (no install, no network, no admin rights):\n{releases}\n\n• Or install the WebView2 Runtime (Standalone Installer for an offline machine):\n{webview2}\n\nCtrl+C copies this text with the links."
        }
    }
}

/// Ссылки окна «WebView2 не найден». Только показываются: перейти по ним —
/// решение пользователя, приложение в сеть не ходит.
pub const RELEASES_URL: &str = "https://github.com/BorisToboltsov/vterm/releases/latest";
pub const WEBVIEW2_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// Точка входа: зовётся первой строкой `run()`, до создания окна и рантайма tokio.
#[cfg(windows)]
pub fn prepare() {
    let env_set = std::env::var_os(ENV_FOLDER).is_some_and(|v| !v.is_empty());
    if env_set || win::system_runtime_installed() {
        return;
    }
    let bundle = std::env::current_exe()
        .and_then(fs::File::open)
        .ok()
        .and_then(|mut exe| match read_trailer(&mut exe) {
            Ok(Some((trailer, offset))) => Some((exe, trailer, offset)),
            _ => None,
        });
    let Some((mut exe, trailer, offset)) = bundle else {
        // Лёгкий portable или установленная сборка на машине без WebView2: окно
        // всё равно не создастся — объясняем, что делать, вместо падения.
        if decide(false, false, false, false) == Choice::Missing {
            let msg = text(Msg::Missing, win::ui_is_russian())
                .replace("{releases}", RELEASES_URL)
                .replace("{webview2}", WEBVIEW2_URL);
            win::message_box(&msg, false);
            std::process::exit(1);
        }
        return;
    };
    let Some(base) = directories::ProjectDirs::from("su", "vcore", "vterm")
        .map(|d| d.data_local_dir().join("webview2"))
    else {
        return;
    };
    let cached = find_runtime_root(&base.join(&trailer.version));
    let root = match (decide(false, false, true, cached.is_some()), cached) {
        (Choice::UseCache, Some(root)) => root,
        _ => {
            let russian = win::ui_is_russian();
            let splash = win::Splash::show(text(Msg::Preparing, russian));
            let result = install(
                &mut exe,
                &trailer,
                offset,
                &base,
                win::grant_sandbox_read,
                win::expand_cab,
            );
            drop(splash);
            match result {
                Ok(root) => root,
                Err(e) => {
                    let msg = text(Msg::Failed, russian)
                        .replace("{err}", &e.to_string())
                        .replace("{dir}", &base.display().to_string());
                    win::message_box(&msg, true);
                    std::process::exit(1);
                }
            }
        }
    };
    // Процесс ещё однопоточный (ни окна, ни tokio) — менять окружение безопасно.
    std::env::set_var(ENV_FOLDER, &root);
    cleanup_stale(&base, &trailer.version);
}

#[cfg(windows)]
mod win {
    use std::ffi::OsStr;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
    use windows_sys::Win32::Graphics::Gdi::{GetStockObject, COLOR_WINDOW, DEFAULT_GUI_FONT};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetSystemMetrics,
        MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassW, SendMessageW, TranslateMessage,
        MB_ICONERROR, MB_ICONWARNING, MB_OK, MSG, SM_CXSCREEN, SM_CYSCREEN, WM_CLOSE, WM_DESTROY,
        WM_SETFONT, WNDCLASSW, WS_BORDER, WS_CHILD, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
        WS_VISIBLE,
    };

    /// GUID клиента EdgeUpdate для WebView2 Runtime — из документации Microsoft
    /// «Detect if a WebView2 Runtime is already installed».
    const CLIENT: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    /// `SS_CENTER` у класса STATIC.
    const SS_CENTER: u32 = 0x1;

    fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
        s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn reg_string(root: HKEY, subkey: &str, value: &str) -> Option<String> {
        let (subkey, value) = (wide(subkey), wide(value));
        let mut buf = [0u16; 128];
        let mut size = std::mem::size_of_val(&buf) as u32;
        // SAFETY: буфер и его размер в байтах валидны, строки NUL-терминированы.
        let rc = unsafe {
            RegGetValueW(
                root,
                subkey.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if rc != ERROR_SUCCESS {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    /// Установлен ли Evergreen WebView2 — ровно три места реестра, которые
    /// перечисляет Microsoft: на машину (32-битная ветка), на машину (64), на
    /// пользователя; плюс каталоги установки как страховка от ложного «нет».
    pub fn system_runtime_installed() -> bool {
        registry_says_installed()
            || install_dirs()
                .iter()
                .any(|d| super::has_installed_engine(d))
    }

    fn install_dirs() -> Vec<PathBuf> {
        let tail = Path::new("Microsoft")
            .join("EdgeWebView")
            .join("Application");
        ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
            .iter()
            .filter_map(std::env::var_os)
            .map(|root| PathBuf::from(root).join(&tail))
            .collect()
    }

    fn registry_says_installed() -> bool {
        let places = [
            (
                HKEY_LOCAL_MACHINE,
                format!(r"SOFTWARE\WOW6432Node\{CLIENT}"),
            ),
            (HKEY_LOCAL_MACHINE, format!(r"SOFTWARE\{CLIENT}")),
            (HKEY_CURRENT_USER, format!(r"Software\{CLIENT}")),
        ];
        places.iter().any(|(root, key)| {
            reg_string(*root, key, "pv").is_some_and(|pv| super::is_installed_version(&pv))
        })
    }

    pub fn ui_is_russian() -> bool {
        // SAFETY: функция без аргументов.
        let lang = unsafe { GetUserDefaultUILanguage() };
        lang & 0x3ff == 0x19 // LANG_RUSSIAN
    }

    fn system32(exe: &str) -> PathBuf {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        PathBuf::from(root).join("System32").join(exe)
    }

    fn run(mut cmd: Command, what: &str) -> io::Result<()> {
        let out = cmd.output()?;
        if out.status.success() {
            return Ok(());
        }
        let mut detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if detail.is_empty() {
            detail = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        Err(io::Error::other(format!(
            "{what} failed ({}): {detail}",
            out.status
        )))
    }

    /// Разворачивает `.cab` встроенным `expand.exe` — тем же способом, что описывает
    /// Microsoft для Fixed Version. Свой распаковщик не берём: крейт `cab` читает
    /// каждый файл солидного LZX-архива с начала папки, на 300 МБ это квадрат.
    pub fn expand_cab(cab: &Path, dest: &Path) -> io::Result<()> {
        let mut cmd = Command::new(system32("expand.exe"));
        crate::localenv::no_console_window_std(&mut cmd);
        cmd.arg(cab).arg("-F:*").arg(dest);
        run(cmd, "expand.exe")
    }

    /// Права на чтение для песочницы WebView2 (ALL APPLICATION PACKAGES и ALL
    /// RESTRICTED APPLICATION PACKAGES): без них процессы движка не стартуют из
    /// папки в профиле пользователя. Выдаётся на пустую папку с наследованием —
    /// распакованные файлы получают права сами.
    pub fn grant_sandbox_read(dir: &Path) -> io::Result<()> {
        let mut cmd = Command::new(system32("icacls.exe"));
        crate::localenv::no_console_window_std(&mut cmd);
        cmd.arg(dir)
            .arg("/grant")
            .arg("*S-1-15-2-1:(OI)(CI)(RX)")
            .arg("*S-1-15-2-2:(OI)(CI)(RX)")
            .arg("/Q");
        run(cmd, "icacls.exe")
    }

    /// Модальное окно с текстом: `error` — красный крест, иначе предупреждение.
    pub fn message_box(text: &str, error: bool) {
        let icon = if error { MB_ICONERROR } else { MB_ICONWARNING };
        let (text, title) = (wide(text), wide("vterm"));
        // SAFETY: строки NUL-терминированы и живут до возврата.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | icon,
            );
        }
    }

    unsafe extern "system" fn splash_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_DESTROY {
            PostQuitMessage(0);
            return 0;
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// Маленькое окно «Подготовка…» на время распаковки: WebView ещё нет, а без
    /// окна первый запуск выглядит зависшим, и exe кликают снова. Живёт в своём
    /// потоке с циклом сообщений; `Drop` закрывает его и ждёт поток.
    pub struct Splash {
        hwnd: usize,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Splash {
        pub fn show(text: &'static str) -> Splash {
            let (tx, rx) = std::sync::mpsc::channel::<usize>();
            let thread = std::thread::spawn(move || {
                // SAFETY: классические вызовы Win32 в потоке, который владеет окном
                // и крутит его цикл сообщений; строки живут до конца функции.
                unsafe {
                    let instance = GetModuleHandleW(std::ptr::null());
                    let class = wide("vterm-webview2-splash");
                    let wc = WNDCLASSW {
                        lpfnWndProc: Some(splash_proc),
                        hInstance: instance,
                        lpszClassName: class.as_ptr(),
                        hbrBackground: (COLOR_WINDOW + 1) as usize as _,
                        ..std::mem::zeroed()
                    };
                    RegisterClassW(&wc);
                    let (w, h) = (460, 130);
                    let x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
                    let y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
                    let title = wide("vterm");
                    let hwnd = CreateWindowExW(
                        WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                        class.as_ptr(),
                        title.as_ptr(),
                        WS_POPUP | WS_BORDER | WS_VISIBLE,
                        x,
                        y,
                        w,
                        h,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        instance,
                        std::ptr::null(),
                    );
                    let label_class = wide("STATIC");
                    let label = wide(text);
                    let static_hwnd = CreateWindowExW(
                        0,
                        label_class.as_ptr(),
                        label.as_ptr(),
                        WS_CHILD | WS_VISIBLE | SS_CENTER,
                        16,
                        24,
                        w - 32,
                        h - 40,
                        hwnd,
                        std::ptr::null_mut(),
                        instance,
                        std::ptr::null(),
                    );
                    let font = GetStockObject(DEFAULT_GUI_FONT);
                    SendMessageW(static_hwnd, WM_SETFONT, font as usize, 1);
                    let _ = tx.send(hwnd as usize);
                    let mut msg: MSG = std::mem::zeroed();
                    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            });
            let hwnd = rx.recv().unwrap_or(0);
            Splash {
                hwnd,
                thread: Some(thread),
            }
        }
    }

    impl Drop for Splash {
        fn drop(&mut self) {
            if self.hwnd != 0 {
                // SAFETY: окно создано потоком сплэша; WM_CLOSE → DestroyWindow →
                // WM_DESTROY → выход из его цикла сообщений.
                unsafe {
                    PostMessageW(self.hwnd as HWND, WM_CLOSE, 0, 0);
                }
            }
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const VERSION: &str = "154.0.4258.48";

    /// exe-заглушка + «.cab» + хвост — ровно то, что пишет `embed`.
    fn bundle(exe: &[u8], cab: &[u8]) -> (Vec<u8>, Trailer) {
        let t = Trailer {
            version: VERSION.into(),
            sha256: Sha256::digest(cab).into(),
            cab_len: cab.len() as u64,
        };
        let mut out = exe.to_vec();
        out.extend_from_slice(cab);
        out.extend_from_slice(&encode_trailer(&t));
        (out, t)
    }

    /// «expand» для тестов: кладёт движок туда же, куда кладёт настоящий `.cab`.
    fn fake_expand(_cab: &Path, dest: &Path) -> io::Result<()> {
        let root = dest.join(format!(
            "Microsoft.WebView2.FixedVersionRuntime.{VERSION}.x64"
        ));
        fs::create_dir_all(&root)?;
        fs::write(root.join(ENGINE_EXE), b"engine")
    }

    fn no_prepare(_: &Path) -> io::Result<()> {
        Ok(())
    }

    #[test]
    fn version_must_be_four_numbers() {
        assert!(valid_version("154.0.4258.48"));
        for bad in [
            "",
            "154.0.4258",
            "1.2.3.4.5",
            "..\\..\\x",
            "1.2.3.a",
            "1..3.4",
            "123456.0.0.0",
        ] {
            assert!(!valid_version(bad), "{bad:?} accepted");
        }
    }

    #[test]
    fn trailer_round_trips() {
        let t = Trailer {
            version: VERSION.into(),
            sha256: [7; 32],
            cab_len: 307_904_013,
        };
        assert_eq!(parse_trailer(&encode_trailer(&t)), Some(t));
    }

    #[test]
    fn foreign_or_damaged_tail_is_not_a_trailer() {
        let t = Trailer {
            version: VERSION.into(),
            sha256: [1; 32],
            cab_len: 10,
        };
        let good = encode_trailer(&t);

        let mut bad_magic = good;
        bad_magic[63] ^= 1;
        assert_eq!(parse_trailer(&bad_magic), None);

        let mut traversal = good;
        traversal[..16].fill(0);
        traversal[..6].copy_from_slice(b"..\\..\\");
        assert_eq!(parse_trailer(&traversal), None);

        let mut junk_after_nul = good;
        junk_after_nul[15] = b'9';
        assert_eq!(parse_trailer(&junk_after_nul), None);

        let mut empty = good;
        empty[48..56].fill(0);
        assert_eq!(parse_trailer(&empty), None);

        assert_eq!(parse_trailer(&good[1..]), None);
    }

    #[test]
    fn plain_exe_has_no_trailer() {
        assert_eq!(
            read_trailer(&mut Cursor::new(b"MZ plain exe".to_vec())).unwrap(),
            None
        );
        assert_eq!(read_trailer(&mut Cursor::new(vec![0u8; 3])).unwrap(), None);
    }

    #[test]
    fn trailer_claiming_more_than_the_file_is_ignored() {
        let mut t = Trailer {
            version: VERSION.into(),
            sha256: [0; 32],
            cab_len: 1_000,
        };
        let mut file = b"MZ".to_vec();
        file.extend_from_slice(&encode_trailer(&t));
        assert_eq!(read_trailer(&mut Cursor::new(file)).unwrap(), None);
        t.cab_len = 2;
        let mut file = b"MZ".to_vec();
        file.extend_from_slice(&encode_trailer(&t));
        assert_eq!(read_trailer(&mut Cursor::new(file)).unwrap(), Some((t, 0)));
    }

    #[test]
    fn reads_the_cab_offset_after_the_exe() {
        let (file, t) = bundle(b"MZ-exe-bytes", b"MSCF-cab");
        assert_eq!(read_trailer(&mut Cursor::new(file)).unwrap(), Some((t, 12)));
    }

    #[test]
    fn system_runtime_always_wins_over_the_bundled_one() {
        use Choice::*;
        assert_eq!(decide(false, true, true, true), Leave);
        assert_eq!(decide(true, false, true, false), Leave);
        // Ни системного, ни вшитого — не падение при создании окна, а объяснение.
        assert_eq!(decide(false, false, false, false), Missing);
        assert_eq!(decide(false, true, false, false), Leave);
        assert_eq!(decide(false, false, true, true), UseCache);
        assert_eq!(decide(false, false, true, false), Extract);
    }

    #[test]
    fn registry_version_rules() {
        assert!(is_installed_version("154.0.4258.48"));
        assert!(!is_installed_version(""));
        assert!(!is_installed_version(" 0.0.0.0 "));
    }

    #[test]
    fn engine_in_an_evergreen_install_dir_counts_as_installed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!has_installed_engine(dir.path()));
        assert!(!has_installed_engine(&dir.path().join("missing")));
        // Папка версии без движка (обновление в процессе) и посторонняя папка — нет.
        fs::create_dir(dir.path().join("141.0.3537.71")).unwrap();
        fs::create_dir(dir.path().join("SetupMetrics")).unwrap();
        fs::write(dir.path().join("SetupMetrics").join(ENGINE_EXE), b"x").unwrap();
        assert!(!has_installed_engine(dir.path()));
        // Две версии рядом во время обновления — достаточно одной с движком.
        fs::create_dir(dir.path().join("142.0.1.2")).unwrap();
        fs::write(dir.path().join("142.0.1.2").join(ENGINE_EXE), b"x").unwrap();
        assert!(has_installed_engine(dir.path()));
    }

    #[test]
    fn copy_checks_length() {
        let mut out = Vec::new();
        let sha =
            copy_with_sha256(&mut Cursor::new(b"0123456789".to_vec()), 2, 4, &mut out).unwrap();
        assert_eq!(out, b"2345");
        assert_eq!(sha, <[u8; 32]>::from(Sha256::digest(b"2345")));
        let err = copy_with_sha256(&mut Cursor::new(b"0123".to_vec()), 2, 4, &mut Vec::new());
        assert_eq!(err.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn install_unpacks_into_the_version_folder_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let (file, t) = bundle(b"MZ", b"MSCF-cab-bytes");
        let (_, off) = read_trailer(&mut Cursor::new(file.clone()))
            .unwrap()
            .unwrap();
        let root = install(
            &mut Cursor::new(file),
            &t,
            off,
            dir.path(),
            no_prepare,
            fake_expand,
        )
        .unwrap();
        assert!(root.starts_with(dir.path().join(VERSION)));
        assert!(root.join(ENGINE_EXE).is_file());
        assert_eq!(find_runtime_root(&dir.path().join(VERSION)), Some(root));
        // Ни временной папки, ни копии .cab не осталось.
        let left: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(left, vec![std::ffi::OsString::from(VERSION)]);
    }

    #[test]
    fn prepare_runs_on_the_empty_folder_before_unpacking() {
        let dir = tempfile::tempdir().unwrap();
        let (file, t) = bundle(b"MZ", b"cab");
        let seen = std::cell::Cell::new(false);
        let prepare = |p: &Path| {
            assert_eq!(fs::read_dir(p)?.count(), 0);
            seen.set(true);
            Ok(())
        };
        install(
            &mut Cursor::new(file),
            &t,
            2,
            dir.path(),
            prepare,
            fake_expand,
        )
        .unwrap();
        assert!(seen.get());
    }

    #[test]
    fn damaged_payload_is_rejected_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let (mut file, t) = bundle(b"MZ", b"MSCF-cab-bytes");
        file[4] ^= 0xff; // байт внутри .cab
        let err = install(
            &mut Cursor::new(file),
            &t,
            2,
            dir.path(),
            no_prepare,
            fake_expand,
        )
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn failed_unpack_is_never_mistaken_for_a_ready_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let (file, t) = bundle(b"MZ", b"cab");
        // Распаковщик оборвался на середине: что-то записал, движка нет.
        let half = |_: &Path, dest: &Path| -> io::Result<()> {
            fs::write(dest.join("half.dll"), b"x")?;
            Err(io::Error::other("disk full"))
        };
        assert!(install(
            &mut Cursor::new(file.clone()),
            &t,
            2,
            dir.path(),
            no_prepare,
            half
        )
        .is_err());
        assert_eq!(find_runtime_root(&dir.path().join(VERSION)), None);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        // «Успешный» expand без движка — тоже не готово.
        let empty = |_: &Path, _: &Path| -> io::Result<()> { Ok(()) };
        assert!(install(&mut Cursor::new(file), &t, 2, dir.path(), no_prepare, empty).is_err());
        assert!(!dir.path().join(VERSION).exists());
    }

    #[test]
    fn broken_leftover_of_the_same_version_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join(VERSION);
        fs::create_dir_all(stale.join("sub")).unwrap();
        fs::write(stale.join("sub").join("leftover.dll"), b"x").unwrap();
        let (file, t) = bundle(b"MZ", b"cab");
        let root = install(
            &mut Cursor::new(file),
            &t,
            2,
            dir.path(),
            no_prepare,
            fake_expand,
        )
        .unwrap();
        assert!(root.join(ENGINE_EXE).is_file());
        assert!(!stale.join("sub").exists());
    }

    #[test]
    fn concurrent_winner_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let (file, t) = bundle(b"MZ", b"cab");
        // Пока мы распаковывали, второй запуск уже положил готовую версию.
        let race = |cab: &Path, dest: &Path| -> io::Result<()> {
            fake_expand(cab, &dest.parent().unwrap().join(VERSION))?;
            fake_expand(cab, dest)
        };
        let root = install(&mut Cursor::new(file), &t, 2, dir.path(), no_prepare, race).unwrap();
        assert!(root.join(ENGINE_EXE).is_file());
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(VERSION)]);
    }

    #[test]
    fn root_is_not_guessed_between_two_candidates() {
        let dir = tempfile::tempdir().unwrap();
        for sub in ["a", "b"] {
            fs::create_dir(dir.path().join(sub)).unwrap();
            fs::write(dir.path().join(sub).join(ENGINE_EXE), b"x").unwrap();
        }
        assert_eq!(find_runtime_root(dir.path()), None);
        assert_eq!(find_runtime_root(&dir.path().join("missing")), None);
    }

    #[test]
    fn cleanup_keeps_current_and_fresh_work_and_drops_old_versions() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        for name in [VERSION, "150.0.1.2", ".partial-fresh", "notes"] {
            fs::create_dir(base.join(name)).unwrap();
        }
        fs::write(base.join(".cab-fresh"), b"x").unwrap();
        cleanup_stale(base, VERSION);
        let mut left: Vec<_> = fs::read_dir(base)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        // Свежая распаковка может принадлежать параллельному запуску — не трогаем;
        // чужие имена (не версия, не служебное) — тоже.
        assert_eq!(left, vec![".cab-fresh", ".partial-fresh", VERSION, "notes"]);
    }

    #[test]
    fn cleanup_drops_service_files_abandoned_by_a_crashed_launch() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join(".cab-old");
        let file = fs::File::create(&old).unwrap();
        file.set_modified(SystemTime::now() - STALE_AFTER - Duration::from_secs(60))
            .unwrap();
        drop(file);
        cleanup_stale(dir.path(), VERSION);
        assert!(!old.exists());
    }

    #[test]
    fn texts_exist_in_both_languages_with_placeholders() {
        for ru in [true, false] {
            assert!(!text(Msg::Preparing, ru).is_empty());
            let failed = text(Msg::Failed, ru);
            assert!(failed.contains("{err}") && failed.contains("{dir}"));
        }
        assert_ne!(text(Msg::Preparing, true), text(Msg::Preparing, false));
        for ru in [true, false] {
            let missing = text(Msg::Missing, ru);
            // Оба выхода названы: portable с WebView2 и установка runtime.
            assert!(missing.contains("x86_64-webview2.exe"));
            assert!(missing.contains("{releases}") && missing.contains("{webview2}"));
        }
        assert!(RELEASES_URL.starts_with("https://") && WEBVIEW2_URL.starts_with("https://"));
    }
}
