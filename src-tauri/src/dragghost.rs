//! The label of a tab dragged out of its window, drawn over the desktop
//! (ADR 0018).
//!
//! A page draws nothing outside its window, so between two windows of the app
//! nobody could show the tab being carried: its label stopped at the edge of the
//! window it left. This is a small window of its own — no frame, above
//! everything — that the backend keeps next to the pointer while the tab is over
//! none of the app's windows.
//!
//! **It is a picture, not a participant.** It takes neither the keyboard nor the
//! mouse: the window the drag began in must keep the drag, and the window under
//! the pointer is the one the tab would land in — a label that could be hit
//! would be "the window under the pointer" itself. No capability covers it, it
//! calls no command, and it is told how to look by `eval` alone.
//!
//! It is made on the first drag that needs it and kept, hidden, for the next:
//! a WebView takes a moment to load, and a label that arrives after the tab has
//! been dropped is no label.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// Label of the floating window. Not `main` and not `win-*`: no capability
/// covers it, and no window of the app lists it as a place to move a tab to.
pub const LABEL: &str = "drag-ghost";

/// Where the label is a window of its own. It has to stay above everything,
/// never take the focus and never be laid out among the other windows — on
/// macOS and Windows that is the window system's to grant, and it does. On
/// Linux each of the three is up to the window manager (a tiling one would
/// tile it), and what has not been seen to hold is not shipped: there the label
/// stays what the page draws at the edge of its window. (Nor can a Wayland
/// session say that the pointer is over none of our windows — see
/// [`crate::winhit`].)
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

/// The label hangs from the pointer like the one a page draws (`GHOST_OFFSET`
/// in tabhandoff.ts) — and so is never under the pointer itself.
const OFFSET: (f64, f64) = (12.0, 8.0);

/// The window's page has loaded: it can be told how to look. Shown before
/// that, it would be an empty rectangle next to the pointer.
static LOADED: AtomicBool = AtomicBool::new(false);

/// How the label looks: what the window the tab is dragged out of shows for it
/// — its status dot and its name. No caption: the tab over the desktop says
/// what is being carried, not what letting go will do.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Look {
    title: String,
    bg: String,
    fg: String,
    accent: String,
    dot: String,
    /// Size of the label as the page measured it, CSS px.
    w: f64,
    h: f64,
}

impl Look {
    /// The size to give the window: what was measured, within reason.
    fn size(&self) -> (f64, f64) {
        let side = |v: f64, min: f64, max: f64| {
            if v.is_finite() {
                v.clamp(min, max)
            } else {
                min
            }
        };
        (side(self.w, 60.0, 480.0), side(self.h, 24.0, 64.0))
    }
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(ghost) = app.get_webview_window(LABEL) {
        return Some(ghost);
    }
    LOADED.store(false, Ordering::Relaxed);
    let ghost = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("ghost.html".into()))
        .title("")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // It must never take the keyboard from the window the drag began in.
        .focused(false)
        .focusable(false)
        .visible(false)
        .shadow(true)
        .inner_size(200.0, 34.0)
        .on_page_load(|_, payload| {
            if payload.event() == PageLoadEvent::Finished {
                LOADED.store(true, Ordering::Relaxed);
            }
        })
        .build()
        .ok()?;
    // Nor the mouse: the window under it is the one the tab would land in.
    let _ = ghost.set_ignore_cursor_events(true);
    Some(ghost)
}

/// Make sure the window exists — hidden — before it is needed: it takes a
/// moment to load its page.
pub fn prepare(app: &AppHandle) {
    if SUPPORTED {
        let _ = window(app);
    }
}

/// Show the label next to the mouse pointer. False — and nothing is shown —
/// where there is no such label, or while its page is still loading: the page
/// the tab came from goes on drawing it.
pub fn show(app: &AppHandle, look: &Look) -> bool {
    if !SUPPORTED {
        return false;
    }
    let Some(ghost) = window(app) else {
        return false;
    };
    if !LOADED.load(Ordering::Relaxed) {
        return false;
    }
    let (w, h) = look.size();
    let _ = ghost.set_size(LogicalSize::new(w, h));
    if let Ok(at) = app.cursor_position() {
        let scale = ghost.scale_factor().unwrap_or(1.0);
        let _ = ghost.set_position(PhysicalPosition::new(
            at.x + OFFSET.0 * scale,
            at.y + OFFSET.1 * scale,
        ));
    }
    if let Ok(json) = serde_json::to_string(look) {
        let _ = ghost.eval(format!("window.setGhost && window.setGhost({json})"));
    }
    if !ghost.is_visible().unwrap_or(false) {
        let _ = ghost.show();
    }
    true
}

/// Take the label off the screen (the window stays, for the next drag).
pub fn hide(app: &AppHandle) {
    if let Some(ghost) = app.get_webview_window(LABEL) {
        if ghost.is_visible().unwrap_or(false) {
            let _ = ghost.hide();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_takes_the_size_it_was_measured_at_within_reason() {
        let look = |w, h| Look {
            w,
            h,
            ..Look::default()
        };
        assert_eq!(look(180.0, 34.0).size(), (180.0, 34.0));
        // Nothing measured yet, or nonsense: a small label, not a window that
        // covers the screen or one too small to see.
        assert_eq!(look(0.0, 0.0).size(), (60.0, 24.0));
        assert_eq!(look(9000.0, 9000.0).size(), (480.0, 64.0));
        assert_eq!(look(f64::NAN, f64::INFINITY).size(), (60.0, 24.0));
    }

    #[test]
    fn a_look_reads_what_the_page_sends_and_survives_what_it_leaves_out() {
        let look: Look =
            serde_json::from_str(r##"{"title":"web-01","accent":"#7db3ff","w":120.5}"##).unwrap();
        assert_eq!(look.title, "web-01");
        assert_eq!(look.accent, "#7db3ff");
        assert_eq!(look.dot, "");
        assert_eq!(look.size(), (120.5, 24.0));
    }

    /// A source file before its tests, line comments stripped.
    fn code(src: &str) -> String {
        let src = src.replace("\r\n", "\n");
        src[..src.find("#[cfg(test)]").expect("tests")]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_floating_label_is_a_picture_and_never_a_window_of_the_app() {
        // Guard (v1.4.0, ADR 0018). The label is a real window, and each of the
        // things it must not be is a way to break the drag it only illustrates:
        //  - key or focused, it takes the keyboard — and the drag — from the
        //    window the tab is dragged out of;
        //  - hit by the mouse, it is "the window under the pointer", and the tab
        //    can never reach a window lying under it;
        //  - named like a window of the app, it gets that window's capability
        //    and is offered to the others as a place to move a tab to.
        let ghost = code(include_str!("dragghost.rs"));
        for needed in [
            ".focused(false)",
            ".focusable(false)",
            ".visible(false)",
            "set_ignore_cursor_events(true)",
        ] {
            assert!(ghost.contains(needed), "the floating label lost {needed}");
        }
        assert!(LABEL != crate::appwin::MAIN && !LABEL.starts_with("win-"));
        // Shown only once its page has loaded — never as an empty rectangle.
        let show = &ghost[ghost.find("pub fn show(").expect("show")..];
        let show = &show[..show.find("\n}\n").expect("end of show")];
        let loaded = show.find("LOADED.load(").expect("waits for the page");
        assert!(loaded < show.find("ghost.show()").expect("shows the window"));
        // And it is never what the pointer is found to be over.
        let windows = code(include_str!("appwin.rs"));
        let asked = &windows[windows
            .find("async fn pointer_window(")
            .expect("the question")..];
        let asked = &asked[..asked.find("\n}\n").expect("end of fn")];
        assert!(asked.contains("hit.label != crate::dragghost::LABEL"));
    }
}
