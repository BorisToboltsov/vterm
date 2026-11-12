//! Reading the diagnostics back (ADR 0063): pages of events, newest first,
//! narrowed on this side — a window never holds the whole file. The page says how
//! many of each level, source and server the filter would show — each facet
//! counted with the others applied and itself not, the way a list's facet menu
//! counts (ADR 0050) — and whether older events match.

use super::{Event, Level};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Events a page holds at most (a page may hold a few more: those of its last moment).
pub const MAX_PAGE: usize = 1000;

/// What a window asks for.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    /// Levels kept; empty — every one.
    #[serde(default)]
    pub levels: Vec<Level>,
    /// Sources kept; "" stands for none. Empty — every one.
    #[serde(default)]
    pub sources: Vec<String>,
    /// Servers kept by name; "" stands for none. Empty — every one.
    #[serde(default)]
    pub servers: Vec<String>,
    /// Matched case-insensitively against the text, source, server and fields.
    #[serde(default)]
    pub text: String,
    /// Only events before this moment (unix ms): the next page.
    #[serde(default)]
    pub before: Option<u64>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// A page of events and what the filter would show.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub events: Vec<Event>,
    /// Older events match too.
    pub more: bool,
    /// Per facet (`level`, `source`, `server`), each value and how many it shows.
    pub counts: BTreeMap<&'static str, BTreeMap<String, u32>>,
    /// Events in the files, whatever the filter.
    pub total: usize,
    /// Lines that did not read as an event — said, not hidden.
    pub unreadable: usize,
}

fn level_name(l: Level) -> String {
    format!("{l:?}").to_lowercase()
}

impl Query {
    fn keeps_level(&self, e: &Event) -> bool {
        self.levels.is_empty() || self.levels.contains(&e.level)
    }
    fn keeps_source(&self, e: &Event) -> bool {
        self.sources.is_empty() || self.sources.contains(&e.source.clone().unwrap_or_default())
    }
    fn keeps_server(&self, e: &Event) -> bool {
        self.servers.is_empty() || self.servers.contains(&e.server.clone().unwrap_or_default())
    }
    fn keeps_text(&self, e: &Event, needle: &str) -> bool {
        if needle.is_empty() {
            return true;
        }
        let hay = [
            Some(e.text.as_str()),
            e.source.as_deref(),
            e.server.as_deref(),
        ];
        hay.into_iter()
            .flatten()
            .any(|s| s.to_lowercase().contains(needle))
            || e.fields.iter().any(|(k, v)| {
                k.to_lowercase().contains(needle) || v.to_string().to_lowercase().contains(needle)
            })
    }
}

/// Every event of `files` (oldest first), and how many lines did not parse.
pub fn read(files: &[PathBuf]) -> (Vec<Event>, usize) {
    let mut events = Vec::new();
    let mut unreadable = 0;
    for path in files {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        for l in text.lines().filter(|l| !l.trim().is_empty()) {
            match serde_json::from_str::<Event>(l) {
                Ok(e) => events.push(e),
                Err(_) => unreadable += 1,
            }
        }
    }
    // The helper's file is read last but lived between the others.
    events.sort_by_key(|e| e.at);
    (events, unreadable)
}

/// The page `q` asks for out of `events` (oldest first).
pub fn page(events: Vec<Event>, unreadable: usize, q: &Query) -> Page {
    let needle = q.text.trim().to_lowercase();
    let limit = q.limit.unwrap_or(200).clamp(1, MAX_PAGE);
    let total = events.len();
    let mut counts: BTreeMap<&'static str, BTreeMap<String, u32>> = BTreeMap::new();
    let mut kept = Vec::new();
    let mut more = false;
    for e in events.into_iter().rev() {
        if !q.keeps_text(&e, &needle) {
            continue;
        }
        let (lv, src, srv) = (q.keeps_level(&e), q.keeps_source(&e), q.keeps_server(&e));
        let mut count = |facet: &'static str, value: String| {
            *counts.entry(facet).or_default().entry(value).or_default() += 1;
        };
        if src && srv {
            count("level", level_name(e.level));
        }
        if lv && srv {
            count("source", e.source.clone().unwrap_or_default());
        }
        if lv && src {
            count("server", e.server.clone().unwrap_or_default());
        }
        if !(lv && src && srv) || q.before.is_some_and(|b| e.at >= b) {
            continue;
        }
        // A page ends between two moments, never inside one: the next page asks
        // for what came before the last moment shown.
        let full = kept.len() >= limit;
        if full && kept.last().is_some_and(|last: &Event| last.at != e.at) {
            more = true;
            continue;
        }
        if !more {
            kept.push(e);
        }
    }
    Page {
        events: kept,
        more,
        counts,
        total,
        unreadable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(at: u64, level: Level, source: &str, server: Option<&str>, text: &str) -> Event {
        let mut e = Event::new(level, Some(source), text.into());
        e.at = at;
        e.server = server.map(Into::into);
        e
    }

    fn sample() -> Vec<Event> {
        vec![
            ev(1, Level::Info, "app", None, "started"),
            ev(
                2,
                Level::Warn,
                "connection",
                Some("prod-db"),
                "proxy refused",
            ),
            ev(
                3,
                Level::Error,
                "connection",
                Some("prod-db"),
                "auth failed",
            ),
            ev(4, Level::Warn, "docker", Some("web"), "poll failed"),
            ev(4, Level::Info, "docker", Some("web"), "poll back"),
            ev(5, Level::Debug, "files", Some("web"), "listed /etc"),
        ]
    }

    fn texts(p: &Page) -> Vec<&str> {
        p.events.iter().map(|e| e.text.as_str()).collect()
    }

    #[test]
    fn a_page_is_newest_first_and_says_there_is_more() {
        let q = Query {
            limit: Some(2),
            ..Query::default()
        };
        let p = page(sample(), 0, &q);
        // The page ends between moments: both events of moment 4 are on it.
        assert_eq!(texts(&p), ["listed /etc", "poll back", "poll failed"]);
        assert!(p.more);
        let next = page(
            sample(),
            0,
            &Query {
                limit: Some(2),
                before: Some(4),
                ..Query::default()
            },
        );
        assert_eq!(texts(&next), ["auth failed", "proxy refused"]);
        assert!(next.more);
        assert_eq!(p.total, 6);
    }

    #[test]
    fn the_filter_narrows_and_each_facet_counts_without_itself() {
        let q = Query {
            levels: vec![Level::Warn],
            servers: vec!["prod-db".into()],
            ..Query::default()
        };
        let p = page(sample(), 0, &q);
        assert_eq!(texts(&p), ["proxy refused"]);
        // Levels are counted over prod-db, whatever level is picked.
        let levels = &p.counts["level"];
        assert_eq!((levels["warn"], levels["error"]), (1, 1));
        // Servers are counted over warnings, whatever server is picked.
        let servers = &p.counts["server"];
        assert_eq!((servers["prod-db"], servers["web"]), (1, 1));
    }

    #[test]
    fn text_matches_the_source_the_server_and_the_fields() {
        let mut events = sample();
        events[5]
            .fields
            .insert("path".into(), "/var/log/nginx".to_owned().into());
        let by = |text: &str| {
            texts(&page(
                events.clone(),
                0,
                &Query {
                    text: text.into(),
                    ..Query::default()
                },
            ))
            .len()
        };
        assert_eq!(by("NGINX"), 1);
        assert_eq!(by("prod-db"), 2);
        assert_eq!(by("docker"), 2);
        assert_eq!(by("nothing like it"), 0);
    }

    #[test]
    fn unreadable_lines_are_counted_not_hidden() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("vterm.jsonl");
        let good = serde_json::to_string(&ev(1, Level::Info, "app", None, "ok")).expect("json");
        std::fs::write(&path, format!("{good}\nnot json\n\n{{\"at\":1}}\n")).expect("write");
        let (events, unreadable) = read(&[path]);
        assert_eq!((events.len(), unreadable), (1, 2));
    }
}
