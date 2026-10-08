//! Which of the app's windows the mouse pointer is over, and where in it
//! (ADR 0018).
//!
//! A tab dragged out of one window and held over another is drawn by that
//! other window, and lands in it where it is let go of. Pointer events do not
//! cross windows, so the window giving the tab up cannot see what is under the
//! pointer once it has left, and the window under it hears nothing of a drag
//! that began elsewhere — the backend has to say, to both.
//!
//! **The OS is asked, and it answers exactly or not at all.** Only the window
//! system knows what is frontmost at a point: a window of another application
//! lying on top of ours, a window on another desktop or Space, a minimized one.
//! What Tauri can tell — rectangles and the order windows were focused in — gets
//! exactly those cases wrong, and a tab dropped *beside* a window would fly into
//! one the user cannot even see. So there is no fallback built on rectangles:
//!
//! - macOS — `+[NSWindow windowNumberAtPoint:belowWindowWithWindowNumber:]`,
//!   the frontmost window of any application at a screen point;
//! - Windows — `WindowFromPoint`, then the top-level window of what it hit (the
//!   WebView is a child window);
//! - Linux on X11 — `gdk_device_get_window_at_position`: the X server walks its
//!   window tree down from the root at the pointer, and GDK names the window it
//!   ends in only when it is this process's;
//! - Linux on Wayland — no answer. A client is told about the pointer only
//!   while the pointer is over its own surface, and what GDK remembers during a
//!   drag is the surface the drag began on. The same goes for an X11 backend
//!   forced onto a Wayland session: its X server sees no native Wayland window
//!   lying on top of ours. There the drop opens a new window, and the tab menu
//!   and the palette move a tab between windows.
//!
//! Where in the window the pointer is comes from the same source — the part of
//! the window its page occupies, as the window system reports it — never from
//! where Tauri says the window is on the screen, and never from an assumption
//! about how tall a title bar is.

use tauri::AppHandle;
// Only where the window system is asked: elsewhere there are no windows to look through.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use tauri::Manager;

/// A window of the app under the mouse pointer.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub label: String,
    /// The pointer inside the window's page: CSS px from its top-left corner.
    pub x: f64,
    pub y: f64,
}

/// The app window under the mouse pointer and the pointer's place in it; `None`
/// over anything else, or where the OS cannot say. Call on the main thread —
/// AppKit answers there only (and says nothing elsewhere, rather than guess).
pub fn app_window_at_pointer(app: &AppHandle) -> Option<Hit> {
    at_pointer(app)
}

#[cfg(target_os = "macos")]
fn at_pointer(app: &AppHandle) -> Option<Hit> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSWindow};

    let mtm = MainThreadMarker::new()?;
    // Screen coordinates, origin bottom-left — what the question below takes.
    let mouse = NSEvent::mouseLocation();
    let number = NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(mouse, 0, mtm);
    app.webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            let ns_window = window.ns_window().ok()?.cast::<NSWindow>();
            // SAFETY: the pointer is the NSWindow of a window Tauri keeps alive; we
            // are on the main thread (the marker above) and only read from it.
            let ns_window = unsafe { ns_window.as_ref() }?;
            if ns_window.windowNumber() != number {
                return None;
            }
            // The page occupies the part of the window its title bar does not
            // cover. That is NOT "the content rectangle": where the content view
            // runs under the title bar (macOS 26 and later make every titled
            // window so), the content rectangle is the whole frame, and the
            // pointer read 32 px lower than it was — the tab had to be aimed
            // with its label. Window coordinates grow upwards, the page's
            // downwards; points are CSS px.
            let page = ns_window.contentLayoutRect();
            let at = ns_window.convertPointFromScreen(mouse);
            Some(Hit {
                label,
                x: at.x - page.origin.x,
                y: page.origin.y + page.size.height - at.y,
            })
        })
}

#[cfg(windows)]
fn at_pointer(app: &AppHandle) -> Option<Hit> {
    let (root, x, y) = top_level_window_at_cursor()?;
    app.webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            if window.hwnd().ok()?.0 != root {
                return None;
            }
            // Client pixels to CSS px: the window's own scale, not a monitor's.
            let scale = window.scale_factor().ok()?;
            Some(Hit {
                label,
                x: x / scale,
                y: y / scale,
            })
        })
}

/// The top-level window the cursor is over, as the window system sees it, and
/// the cursor in that window's client area (physical px).
#[cfg(windows)]
fn top_level_window_at_cursor() -> Option<(*mut core::ffi::c_void, f64, f64)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetCursorPos, WindowFromPoint, GA_ROOT,
    };

    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: plain window-system queries; `point` outlives the calls using it.
    unsafe {
        if GetCursorPos(&mut point) == 0 {
            return None;
        }
        let hit = WindowFromPoint(point);
        if hit.is_null() {
            return None;
        }
        // The WebView is a child window of ours: climb to the top-level one.
        let root = GetAncestor(hit, GA_ROOT);
        if root.is_null() || ScreenToClient(root, &mut point) == 0 {
            return None;
        }
        Some((root, f64::from(point.x), f64::from(point.y)))
    }
}

#[cfg(target_os = "linux")]
fn at_pointer(app: &AppHandle) -> Option<Hit> {
    use gtk::prelude::*;

    let display = gdk::Display::default()?;
    if !asks_an_x_server(&display) {
        return None;
    }
    let pointer = display.default_seat()?.pointer()?;
    // The server's answer, not ours: the window at the pointer, and only when
    // it belongs to this process (a window of another application on top of
    // ours ends the walk in a window GDK does not know).
    let (under, _, _) = pointer.window_at_position();
    let top = under?.toplevel();
    app.webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            let gtk_window = window.gtk_window().ok()?;
            if gtk_window.window()? != top {
                return None;
            }
            // The pointer in the window, read from the server, less where the
            // toolkit says the page starts in it. Application px are CSS px.
            let (_, x, y, _) = top.device_position(&pointer);
            let (left, above) = page_origin(&gtk_window)?;
            Some(Hit {
                label,
                x: f64::from(x - left),
                y: f64::from(y - above),
            })
        })
}

/// Whether what GDK talks to is an X server that sees every window on the
/// screen: an X11 backend, and not one run on top of a Wayland session.
#[cfg(target_os = "linux")]
fn asks_an_x_server(display: &gdk::Display) -> bool {
    use gtk::prelude::*;

    let wayland_session = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind == "wayland");
    display.type_().name() == "GdkX11Display" && !wayland_session
}

/// Where the page starts inside its window: the WebView's corner, as GTK laid
/// it out — asked, not assumed to be the window's own.
#[cfg(target_os = "linux")]
fn page_origin(window: &gtk::ApplicationWindow) -> Option<(i32, i32)> {
    use gtk::prelude::*;

    fn web_view(widget: &gtk::Widget) -> Option<gtk::Widget> {
        if widget.type_().name() == "WebKitWebView" {
            return Some(widget.clone());
        }
        let children = widget.downcast_ref::<gtk::Container>()?.children();
        children.iter().find_map(web_view)
    }
    web_view(window.upcast_ref())?.translate_coordinates(window, 0, 0)
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn at_pointer(_app: &AppHandle) -> Option<Hit> {
    None
}

#[cfg(test)]
mod tests {
    /// This file before its tests, line comments stripped.
    fn code() -> String {
        let src = include_str!("winhit.rs").replace("\r\n", "\n");
        src[..src.find("#[cfg(test)]").expect("tests")]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_window_under_the_pointer_is_asked_of_the_os_never_guessed() {
        // Guard (v1.4.0, ADR 0018): what is frontmost at a point is the window
        // system's to say. A window's rectangle says where it is, not whether it
        // is on top there, on this desktop, or minimized — a hit-test built on
        // rectangles sends a tab into a window the user cannot see.
        // (`scale_factor` is not in the list: it turns the client pixels the
        // window system reported into CSS px, and decides nothing.)
        let code = code();
        for geometry in [
            "outer_position",
            "inner_position",
            "outer_size",
            "inner_size",
            "cursor_position",
            "is_minimized",
            "current_monitor",
        ] {
            assert!(
                !code.contains(geometry),
                "the window under the pointer is worked out from {geometry}"
            );
        }
        // Each platform that answers asks the window system itself…
        assert!(code.contains("windowNumberAtPoint_belowWindowWithWindowNumber("));
        assert!(code.contains("WindowFromPoint(point)"));
        // …the pointer's place in the window comes from the window system too…
        // (the part of the window the page occupies — not the content rectangle,
        // which on a window whose content runs under its title bar is the whole
        // frame: the pointer then reads a title bar's height too low)
        assert!(code.contains("contentLayoutRect()"));
        assert!(code.contains("convertPointFromScreen(mouse)"));
        assert!(!code.contains("contentRectForFrameRect"));
        assert!(code.contains("ScreenToClient(root, &mut point)"));
        // …Linux asks the X server through GDK, and only a server that sees
        // every window: on Wayland, or on an X server run inside a Wayland
        // session, it gives no answer rather than one about its own windows only…
        let linux = &code[code
            .find("#[cfg(target_os = \"linux\")]\nfn at_pointer")
            .expect("the Linux answer")..];
        let asked = linux
            .find("pointer.window_at_position()")
            .expect("X is asked");
        let gate = linux
            .find("if !asks_an_x_server(&display) {\n        return None;\n    }")
            .expect("the session is checked");
        assert!(
            gate < asked,
            "the X server is asked before it is known to see every window"
        );
        assert!(code.contains("\"GdkX11Display\" && !wayland_session"));
        assert!(code.contains("var_os(\"WAYLAND_DISPLAY\")"));
        assert!(linux.contains("top.device_position(&pointer)"));
        assert!(linux.contains("page_origin(&gtk_window)?"));
        // …and a platform with no such answer gives none.
        let other = &code[code
            .find("#[cfg(not(any(target_os = \"macos\", windows, target_os = \"linux\")))]")
            .expect("the fallback")..];
        assert!(other.contains("fn at_pointer(_app: &AppHandle) -> Option<Hit> {\n    None\n}"));
    }
}
