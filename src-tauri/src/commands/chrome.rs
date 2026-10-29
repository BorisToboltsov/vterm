// The app's shell around the pages: files handed to it by the OS, the clipboard
// and the native macOS menu.

use crate::error::AppResult;
use crate::locks::Locked;
use crate::AppState;
use tauri::{AppHandle, State};

/// Take and clear the queue of files vterm was asked to open (CLI args at launch
/// and macOS `Opened` events), so the frontend can open them on startup.
#[tauri::command]
pub fn take_pending_opens(state: State<AppState>) -> Vec<String> {
    std::mem::take(&mut state.pending_opens.locked())
}

/// Read UTF-8 text from the OS clipboard in the Rust process.
///
/// The frontend deliberately avoids `navigator.clipboard.readText()`: in
/// WKWebView (macOS) it pops WebKit's "Paste" permission button, and the app
/// ships without a native Edit menu (so the terminal keeps ⌘C/⌘V). Reading the
/// pasteboard here — the same thing `tauri-plugin-clipboard-manager` would do —
/// never touches the webview, so no prompt appears. Returns the empty string for
/// an empty/non-text clipboard; errors on platforms without a native reader so
/// the caller can fall back to the web API.
#[tauri::command]
pub fn read_clipboard_text() -> AppResult<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        // SAFETY: reading the general pasteboard via AppKit. NSPasteboard reads
        // are thread-safe, so this is fine off the main thread (Tauri command
        // pool). We only borrow the returned string to copy it into a Rust String.
        let text =
            unsafe { NSPasteboard::generalPasteboard().stringForType(NSPasteboardTypeString) };
        Ok(text.map(|s| s.to_string()).unwrap_or_default())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(crate::error::AppError::Message(
            "native clipboard read is only implemented on macOS".into(),
        ))
    }
}

/// Localized labels for the native menu. Sourced from the frontend i18n
/// dictionaries (`src/lib/i18n`) so the native menu follows the same language as
/// the rest of the UI. Defaults are the canonical English used for the very
/// first build, before the WebView pushes the user's language.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
// Windows/Linux no longer host a native menu bar (custom in-window chrome —
// TitleBar.svelte — replaces it), so none of these labels are read there; macOS
// still builds its app/Help menu from them. Kept as a field so the frontend
// contract stays stable across platforms.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MenuLabels {
    // The File-menu label is only meaningful for an in-window menu bar; macOS uses
    // the standard "vterm" app menu instead, so it goes unread there.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    file_menu: String,
    help_menu: String,
    settings: String,
    about: String,
    help: String,
    manual: String,
    changelog: String,
    updates: String,
    monitoring: String,
    #[serde(default = "default_quit_label")]
    quit: String,
}

fn default_quit_label() -> String {
    "Quit vterm".into()
}

impl Default for MenuLabels {
    fn default() -> Self {
        Self {
            file_menu: "File".into(),
            help_menu: "Help".into(),
            settings: "Settings…".into(),
            about: "About vterm".into(),
            help: "Help".into(),
            manual: "Manual".into(),
            changelog: "Changelog".into(),
            updates: "Check for updates…".into(),
            monitoring: "Monitoring".into(),
            quit: default_quit_label(),
        }
    }
}

/// Build the native application menu from localized `labels`. On macOS the items
/// live in the standard "vterm" app menu (Settings with ⌘,) and a Help menu, in
/// the system menu bar. Windows/Linux draw their own in-window chrome
/// (TitleBar.svelte) with an HTML File/Help menu, so there the native menu is
/// empty — no OS-drawn menu bar to keep light against a dark theme.
/// Item ids are stable across languages, so the `on_menu_event` routing keeps
/// working after a rebuild (see `set_menu_language`).
pub fn build_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    labels: &MenuLabels,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::MenuBuilder;

    // Windows/Linux: the in-window TitleBar owns the menu, so attach an empty
    // native menu (removing the OS menu bar entirely). `labels` is unused here.
    // The two cfg blocks are mutually exclusive, so exactly one survives per
    // platform and is the function's tail expression — no `return` (needless on
    // the platform where this block is the tail; clippy -D warnings catches it).
    #[cfg(not(target_os = "macos"))]
    {
        let _ = labels;
        MenuBuilder::new(app).build()
    }

    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{MenuItemBuilder, SubmenuBuilder};

        let settings = MenuItemBuilder::with_id("settings", &labels.settings)
            .accelerator("CmdOrCtrl+,")
            .build(app)?;
        let about = MenuItemBuilder::with_id("about", &labels.about).build(app)?;
        let help = MenuItemBuilder::with_id("help", &labels.help).build(app)?;
        let manual = MenuItemBuilder::with_id("manual", &labels.manual).build(app)?;
        let changelog = MenuItemBuilder::with_id("changelog", &labels.changelog).build(app)?;
        let updates = MenuItemBuilder::with_id("updates", &labels.updates).build(app)?;
        let monitoring = MenuItemBuilder::with_id("monitoring", &labels.monitoring)
            .accelerator("CmdOrCtrl+Shift+M")
            .build(app)?;
        // Our own item, not the predefined `quit()`: that one terminates the app
        // natively, past the confirmation `request_quit` routes through.
        let quit = MenuItemBuilder::with_id("quit", &labels.quit)
            .accelerator("CmdOrCtrl+Q")
            .build(app)?;

        // No Edit menu on purpose: the terminal handles ⌘C/⌘V itself, and a
        // native Edit menu would steal those accelerators before xterm sees them.
        let app_menu = SubmenuBuilder::new(app, "vterm")
            .item(&about)
            .separator()
            .item(&settings)
            .item(&monitoring)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&quit)
            .build()?;
        let help_menu = SubmenuBuilder::new(app, &labels.help_menu)
            .item(&help)
            .item(&manual)
            .item(&changelog)
            .separator()
            .item(&updates)
            .build()?;
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&help_menu)
            .build()
    }
}

/// Rebuild the native menu in the language chosen on the frontend. Called by the
/// WebView on startup and whenever the user switches language in Settings.
#[tauri::command]
pub fn set_menu_language(app: AppHandle, labels: MenuLabels) -> Result<(), String> {
    let menu = build_app_menu(&app, &labels).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}
