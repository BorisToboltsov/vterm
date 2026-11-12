//! Where the windows stood (v1.36, ADR 0057): the position, size and
//! maximized state of every window, written down when the app quits and given
//! back when it starts — to the main window always, to a window of the
//! previous launch when its tabs come back with it.
//!
//! The record is the window system's word — physical pixels, the outer corner
//! and the inner size, as `tauri` reads and sets them — and it is not trusted on
//! the way back: the monitor a window stood on may be gone, or another
//! resolution. A window whose title bar would not be on any monitor is put in
//! the middle of the first one; a size larger than the monitor is cut to it.
//! Where the window system does not say where a window is (Wayland), the size
//! is kept and the position is not.

use crate::diag::Logged;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A window's place: the outer top-left corner and the inner size, physical px.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    /// None where the window system did not say (Wayland).
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// What `windows.json` holds: a place per window label.
pub type Places = HashMap<String, Place>;

/// A monitor's work area (what the dock and the taskbar leave), physical px.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// How much of the window's top edge has to be on a monitor for its position to
/// be kept: enough to grab the title bar and drag it back.
const GRIP: (i64, i64) = (120, 24);

/// The window labels a record is kept for: the main window and the windows tabs
/// were moved out to. Anything else read from the file is not a place of ours.
pub fn kept_label(label: &str) -> bool {
    label == crate::appwin::MAIN
        || label
            .strip_prefix("win-")
            .is_some_and(|n| !n.is_empty() && n.len() <= 9 && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Overlap of two spans `[a, a+al)` and `[b, b+bl)`.
fn overlap(a: i64, al: i64, b: i64, bl: i64) -> i64 {
    ((a + al).min(b + bl) - a.max(b)).max(0)
}

/// Whether the top edge of a window at (x, y), `width` wide, can be grabbed on `area`.
fn grabbable(x: i32, y: i32, width: u32, area: &Area) -> bool {
    let w = overlap(x.into(), width.into(), area.x.into(), area.width.into());
    let h = overlap(y.into(), GRIP.1, area.y.into(), area.height.into());
    w >= GRIP.0.min(width.into()) && h >= GRIP.1
}

/// The place to give a window that stood at `saved`, on the monitors `areas`
/// (the first is the one to fall back to), no smaller than `min`. With no
/// monitors known, the record is taken as it is.
pub fn fit(saved: Place, areas: &[Area], min: (u32, u32)) -> Place {
    let width = saved.width.max(min.0);
    let height = saved.height.max(min.1);
    let Some(first) = areas.first() else {
        return Place {
            width,
            height,
            ..saved
        };
    };
    let on = match (saved.x, saved.y) {
        (Some(x), Some(y)) => areas.iter().find(|a| grabbable(x, y, width, a)),
        _ => None,
    };
    let area = on.unwrap_or(first);
    let width = width.min(area.width.max(min.0));
    let height = height.min(area.height.max(min.1));
    let (x, y) = match (on, saved.x, saved.y) {
        (Some(_), Some(x), Some(y)) => (Some(x), Some(y)),
        // Off every monitor: in the middle of the first.
        (None, Some(_), Some(_)) => (
            Some(area.x + ((i64::from(area.width) - i64::from(width)) / 2).max(0) as i32),
            Some(area.y + ((i64::from(area.height) - i64::from(height)) / 2).max(0) as i32),
        ),
        // The window system never said where it was: it decides again.
        _ => (None, None),
    };
    Place {
        x,
        y,
        width,
        height,
        maximized: saved.maximized,
    }
}

/// The places read back from disk, without what is not one: a label that is no
/// window's, a size of zero.
pub fn sanitize(places: Places) -> Places {
    places
        .into_iter()
        .filter(|(label, p)| kept_label(label) && p.width > 0 && p.height > 0)
        .collect()
}

/// Where `window` stands now; None when the window system cannot say even its size.
pub fn place_of(window: &tauri::WebviewWindow) -> Option<Place> {
    let size = window.inner_size().ok()?;
    let pos = window.outer_position().ok();
    Some(Place {
        x: pos.map(|p| p.x),
        y: pos.map(|p| p.y),
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    })
}

/// The work areas of the monitors, the primary one first.
pub fn areas_of(window: &tauri::WebviewWindow) -> Vec<Area> {
    let to_area = |m: &tauri::Monitor| {
        let r = m.work_area();
        Area {
            x: r.position.x,
            y: r.position.y,
            width: r.size.width,
            height: r.size.height,
        }
    };
    let mut out: Vec<Area> = Vec::new();
    if let Ok(Some(primary)) = window.primary_monitor() {
        out.push(to_area(&primary));
    }
    for m in window.available_monitors().unwrap_or_default() {
        let a = to_area(&m);
        if !out.contains(&a) {
            out.push(a);
        }
    }
    out
}

/// Put `window` where `saved` says, fitted to the monitors there are now.
/// Returns whether it was maximized: the caller maximizes it once it is shown —
/// a hidden window maximized first would be shown by it on some platforms.
pub fn apply(window: &tauri::WebviewWindow, saved: Place, min: (u32, u32)) -> bool {
    let place = fit(saved, &areas_of(window), min);
    window
        .set_size(tauri::PhysicalSize::new(place.width, place.height))
        .log_debug("windows", "the window was not given its size");
    if let (Some(x), Some(y)) = (place.x, place.y) {
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .log_debug("windows", "the window was not moved to its place");
    }
    place.maximized
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: (u32, u32) = (640, 360);
    const LAPTOP: Area = Area {
        x: 0,
        y: 25,
        width: 1440,
        height: 875,
    };
    const RIGHT: Area = Area {
        x: 1440,
        y: 0,
        width: 2560,
        height: 1440,
    };

    fn at(x: i32, y: i32, width: u32, height: u32) -> Place {
        Place {
            x: Some(x),
            y: Some(y),
            width,
            height,
            maximized: false,
        }
    }

    #[test]
    fn a_window_that_is_on_a_monitor_stays_where_it_was() {
        assert_eq!(
            fit(at(100, 80, 1000, 700), &[LAPTOP], MIN),
            at(100, 80, 1000, 700)
        );
        // On the second monitor, partly hanging off its right edge: still grabbable.
        assert_eq!(
            fit(at(3800, 300, 900, 600), &[LAPTOP, RIGHT], MIN),
            at(3800, 300, 900, 600)
        );
    }

    #[test]
    fn a_window_whose_monitor_is_gone_comes_to_the_middle_of_the_first() {
        // It stood on the right monitor, which is unplugged now.
        let back = fit(at(2000, 200, 1000, 700), &[LAPTOP], MIN);
        assert_eq!(back, at(220, 112, 1000, 700));
        // Its title bar above the top of every monitor: it could not be grabbed.
        assert_eq!(fit(at(100, -500, 800, 600), &[LAPTOP], MIN).y, Some(162));
    }

    #[test]
    fn a_size_is_cut_to_the_monitor_and_kept_above_the_minimum() {
        let big = fit(at(0, 25, 3000, 2000), &[LAPTOP], MIN);
        assert_eq!((big.width, big.height), (1440, 875));
        let small = fit(at(10, 40, 100, 50), &[LAPTOP], MIN);
        assert_eq!((small.width, small.height), MIN);
    }

    #[test]
    fn where_the_window_system_never_said_the_position_is_not_made_up() {
        let wayland = Place {
            x: None,
            y: None,
            width: 1200,
            height: 800,
            maximized: true,
        };
        assert_eq!(fit(wayland, &[LAPTOP], MIN), wayland);
        // No monitors known: the record as it is, above the minimum.
        assert_eq!(fit(at(5, 5, 100, 100), &[], MIN), at(5, 5, 640, 360));
    }

    #[test]
    fn only_places_of_our_windows_are_read_back() {
        let mut places = Places::new();
        for label in [
            "main",
            "win-2",
            "win-17",
            "drag-ghost",
            "win-",
            "win-x",
            "Main",
            "win-1234567890",
        ] {
            places.insert(label.into(), at(0, 0, 800, 600));
        }
        places.insert("win-3".into(), at(0, 0, 0, 600));
        let mut kept: Vec<String> = sanitize(places).into_keys().collect();
        kept.sort();
        assert_eq!(kept, vec!["main", "win-17", "win-2"]);
    }
}
