//! Files dragged out of the app — onto the desktop, into a folder of the
//! system (v1.14, ADR 0027).
//!
//! This is not the label that follows a tab between two windows
//! ([`crate::dragghost`]): that one is a picture, and the drop it leads to is
//! the app's own. A file dropped on the desktop is taken by *another program*,
//! and only a drag of the system's own reaches one. So when files leave the
//! window, the page hands the drag over — here — and the system carries it on.
//!
//! The file is not on this machine when the drag begins; it is on a server. What
//! is dragged is a **promise** of it: the system says where it was dropped, and
//! only then is it fetched — by the same job of the transfers registry as any
//! other download ([`crate::transfers`]), into the folder the system named.
//!
//!  - macOS: `NSFilePromiseProvider` — the Finder gives a destination URL.
//!  - Windows: a COM data object with `FILEDESCRIPTOR` and `FILECONTENTS` as a
//!    stream — Explorer pulls the bytes itself.
//!  - Linux: nothing. Wayland has no way to do it at all, and X11's direct-save
//!    protocol is not something every file manager speaks; the way to one's own
//!    machine there is a local tab's file panel.
//!
//! While the system has the drag, the page that began it hears nothing of the
//! pointer. The drag's source does, and says to the app's windows what the page
//! used to ([`crate::appwin::system_drag_moved`]): held over a window of the
//! app the files are still drawn by it, and let go of there they are the app's
//! own drop, as before.

use crate::error::AppResult;
use serde::Deserialize;
use tauri::{AppHandle, WebviewWindow};

mod feed;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// Where the system can carry a promised file (mirror of `dragOutOffered` in
/// dragout.ts).
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

/// Whether a folder can be promised. macOS takes one as it takes a file — a
/// place to write to. Explorer is told every file of a drag before it is
/// dropped, and a folder's would have to be listed off the server for that; a
/// folder is not dragged out there (mirror of `dragOutBlocker` in dragout.ts).
pub const FOLDERS: bool = cfg!(target_os = "macos");

/// More than this is not promised in one drag: each item is an object of the
/// system's, made before the drag can begin.
pub const MAX_ITEMS: usize = 500;

/// One file or folder of a server, promised to the system.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutItem {
    /// Where it is on the server.
    pub path: String,
    /// What it is called there — and, if that is a name this machine can
    /// give a file, what it will be called here.
    pub name: String,
    #[serde(default)]
    pub is_dir: bool,
    /// How long it is — asked of the server when the drag begins, where the
    /// taker has to be told beforehand ([`measured`]). Never the page's word:
    /// a listing is minutes old, and gives a link the length of its own text.
    #[serde(skip)]
    pub size: Option<u64>,
}

/// What the page hands over when files leave its window.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutSpec {
    /// The session whose server the files are on.
    pub session: String,
    /// What its tab is called.
    #[serde(default)]
    pub label: String,
    pub items: Vec<OutItem>,
    /// The files as a window of the app is told of them (`describeFiles`):
    /// passed on unread to the window they are held over.
    pub carried: serde_json::Value,
}

/// The items of a drag that can be promised: those whose name this machine can
/// give a file. A name is the server's word ([`crate::localfile::safe_component`])
/// — and here it is handed to *another program* as the name to create, so one
/// that is not a single safe component is not promised at all. Where a
/// folder cannot be promised (`folders` false), a drag with one in it is not
/// begun: half of what was picked up would be left behind without a word.
pub fn promised(items: &[OutItem], folders: bool) -> Vec<OutItem> {
    if !folders && items.iter().any(|item| item.is_dir) {
        return Vec::new();
    }
    items
        .iter()
        .filter(|item| crate::localfile::safe_component(&item.name))
        .take(MAX_ITEMS)
        .cloned()
        .collect()
}

/// What the server says of an item at this moment: whether it is a folder and
/// how long it is. `None` — it could not be asked, or its length is not one a
/// reader can go by ([`sizeless`]).
pub type Fact = Option<(bool, u64)>;

/// The files of a drag with the lengths the server gives them now — for a
/// taker that is told how long each file is before it reads one (Explorer).
/// `None` — the drag is not begun: something in it is a folder after all (a
/// link to one), cannot be read, or has no length to go by. Not "the rest of
/// it": half of what was picked up would be left behind without a word.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn measured(items: Vec<OutItem>, facts: Vec<Fact>) -> Option<Vec<OutItem>> {
    if items.len() != facts.len() {
        return None;
    }
    items
        .into_iter()
        .zip(facts)
        .map(|(item, fact)| match fact {
            Some((false, size)) => Some(OutItem {
                size: Some(size),
                is_dir: false,
                ..item
            }),
            _ => None,
        })
        .collect()
}

/// Whether a file said to be empty is not: the server gives no length to what
/// it makes up as it is read (`/proc`, `/sys`), and a taker that copies "as
/// many bytes as it was told" would leave an empty file that looks like a
/// copy. `first` is how many bytes its first read gave.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn sizeless(size: u64, first: usize) -> bool {
    size == 0 && first > 0
}

/// How many files are asked about at once.
#[cfg_attr(not(windows), allow(dead_code))]
const ASKED_AT_ONCE: usize = 32;

/// Ask the server about each item ([`Fact`]), following links.
#[cfg_attr(not(windows), allow(dead_code))]
async fn facts(app: &AppHandle, session_id: &str, items: &[OutItem]) -> Vec<Fact> {
    use tokio::io::AsyncReadExt;
    let Ok(session) = crate::session_arc_of(app, session_id).await else {
        return vec![None; items.len()];
    };
    let Ok(sftp) = session.sftp().await else {
        return vec![None; items.len()];
    };
    let mut all = Vec::with_capacity(items.len());
    for group in items.chunks(ASKED_AT_ONCE) {
        let asked = group.iter().map(|item| {
            let sftp = sftp.clone();
            async move {
                let said = sftp.metadata(item.path.clone()).await.ok()?;
                if said.is_dir() {
                    return Some((true, 0));
                }
                let size = said.size?;
                if size == 0 {
                    // Empty — or made up as it is read: one read tells.
                    let mut file = sftp.open(item.path.clone()).await.ok()?;
                    let mut byte = [0u8; 1];
                    let first = file.read(&mut byte).await.ok()?;
                    if sizeless(size, first) {
                        return None;
                    }
                }
                Some((false, size))
            }
        });
        all.extend(futures_util::future::join_all(asked).await);
    }
    all
}

/// The transfer that keeps a promise: `item` of the session, to `dest` on this
/// machine. `dest` is the system's — it named the folder, and settled what the
/// file is called there — so what is at `dest` may be replaced.
pub fn fetch_spec(
    spec: &OutSpec,
    item: &OutItem,
    dest: &str,
    id: String,
) -> crate::transfers::Spec {
    use crate::transfers::{Item, Side, Spec};
    let dest_dir = std::path::Path::new(dest)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    Spec {
        id,
        src: Side {
            session: Some(spec.session.clone()),
            local: false,
            label: spec.label.clone(),
        },
        dst: Side {
            session: None,
            local: true,
            label: String::new(),
        },
        items: vec![Item {
            from: item.path.clone(),
            to: dest.to_string(),
            is_dir: item.is_dir,
            replace: true,
        }],
        dest_dir,
    }
}

/// Keep a promise: fetch `item` to `dest`, as a job like any other download —
/// it shows in the window of the session's tab and can be stopped there. Ends
/// when the job does; `Err` says why the file is not there.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) async fn fetch(
    app: &AppHandle,
    origin: &str,
    spec: &OutSpec,
    item: &OutItem,
    dest: &str,
) -> Result<(), String> {
    let id = format!("out-{}", crate::uuid_like());
    let wait = crate::launch_transfer(app, origin, fetch_spec(spec, item, dest, id))
        .await
        .map_err(|e| e.to_string())?;
    let done = wait
        .await
        .map_err(|_| "the transfer was dropped".to_string())?;
    match done.state {
        crate::transfers::State::Done => Ok(()),
        crate::transfers::State::Cancelled => Err("cancelled".into()),
        _ => Err(done.error.unwrap_or_else(|| "the transfer failed".into())),
    }
}

/// Files have left the window they were dragged from: hand the drag to the
/// system. True — it has it now, and the page lets go; false — it does not
/// (this system cannot, the button is no longer down, nothing can be promised),
/// and the page carries on as it did.
#[tauri::command]
pub async fn drag_out_begin(
    app: AppHandle,
    window: WebviewWindow,
    spec: OutSpec,
) -> AppResult<bool> {
    if !SUPPORTED {
        return Ok(false);
    }
    let items = promised(&spec.items, FOLDERS);
    // The session has to be there to read from — asked now, not at the drop.
    if items.is_empty() || crate::session_arc_of(&app, &spec.session).await.is_err() {
        return Ok(false);
    }
    // Explorer is told how long each file is before it reads one.
    #[cfg(windows)]
    let items = {
        let said = facts(&app, &spec.session, &items).await;
        match measured(items, said) {
            Some(items) => items,
            None => return Ok(false),
        }
    };
    let spec = OutSpec { items, ..spec };
    // The system's drag begins on the thread that owns the window.
    let (answer, began) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let source = window.clone();
    app.run_on_main_thread(move || begin(&handle, &source, spec, answer))
        .map_err(|e| crate::error::AppError::Message(format!("drag out: {e}")))?;
    Ok(began.await.unwrap_or(false))
}

/// Whether the system has the drag — said as soon as it is known, which on
/// Windows is before the drag is over: there the call that begins it returns
/// only when the button is let go of.
type Began = tokio::sync::oneshot::Sender<bool>;

#[cfg(target_os = "macos")]
fn begin(app: &AppHandle, window: &WebviewWindow, spec: OutSpec, answer: Began) {
    // The label the app itself draws over the desktop steps aside.
    crate::dragghost::hide(app);
    let _ = answer.send(macos::begin(app, window, spec));
}

#[cfg(windows)]
fn begin(app: &AppHandle, window: &WebviewWindow, spec: OutSpec, answer: Began) {
    crate::dragghost::hide(app);
    let feed = std::sync::Arc::new(feed::Feed::new(app, window.label(), spec));
    windows::begin(feed, move |began| {
        let _ = answer.send(began);
    });
}

#[cfg(not(any(target_os = "macos", windows)))]
fn begin(_app: &AppHandle, _window: &WebviewWindow, _spec: OutSpec, answer: Began) {
    let _ = answer.send(false);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, is_dir: bool) -> OutItem {
        OutItem {
            path: format!("/srv/{name}"),
            name: name.to_string(),
            is_dir,
            size: None,
        }
    }

    #[test]
    fn only_a_name_this_machine_can_give_a_file_is_promised() {
        let items = vec![
            item("nginx.conf", false),
            item("site", true),
            // The server's word, handed to another program as a name to create.
            item("../../.ssh/authorized_keys", false),
            item("/etc/cron.d/x", false),
            item("", false),
            item("..", true),
        ];
        let kept: Vec<String> = promised(&items, true).into_iter().map(|i| i.name).collect();
        assert_eq!(kept, ["nginx.conf", "site"]);
    }

    #[test]
    fn where_a_folder_cannot_be_promised_a_drag_with_one_is_not_begun() {
        let mixed = vec![item("a.conf", false), item("site", true)];
        // Not "the files of it": half of what was picked up would be left behind.
        assert!(promised(&mixed, false).is_empty());
        assert_eq!(promised(&[item("a.conf", false)], false).len(), 1);
    }

    #[test]
    fn no_more_is_promised_than_one_drag_can_carry() {
        let many: Vec<OutItem> = (0..MAX_ITEMS + 40)
            .map(|i| item(&format!("f{i}"), false))
            .collect();
        assert_eq!(promised(&many, true).len(), MAX_ITEMS);
    }

    #[test]
    fn a_promise_is_kept_by_a_download_to_where_the_system_said() {
        let spec = OutSpec {
            session: "sess-1".into(),
            label: "web-01".into(),
            items: vec![],
            carried: serde_json::Value::Null,
        };
        let job = fetch_spec(
            &spec,
            &item("site", true),
            "/Users/me/Desktop/site 2",
            "out-1".into(),
        );
        assert_eq!(job.id, "out-1");
        assert_eq!(job.src.session.as_deref(), Some("sess-1"));
        assert!(!job.src.local);
        assert_eq!(job.src.label, "web-01");
        // On this machine, outside any tab.
        assert!(job.dst.local && job.dst.session.is_none());
        assert_eq!(job.dest_dir, "/Users/me/Desktop");
        let only = &job.items[0];
        assert_eq!(only.from, "/srv/site");
        // Under the name the system settled on — not the server's.
        assert_eq!(only.to, "/Users/me/Desktop/site 2");
        assert!(only.is_dir);
        // The system named the place; what it put there may be written over.
        assert!(only.replace);
    }

    #[test]
    fn what_the_page_hands_over_is_read_as_it_is_sent() {
        let spec: OutSpec = serde_json::from_str(
            r#"{
                "session": "s",
                "label": "web-01",
                "items": [{ "path": "/a/b", "name": "b", "isDir": true }, { "path": "/a/c", "name": "c", "size": 42 }],
                "carried": { "kind": "files", "from": "s" }
            }"#,
        )
        .unwrap();
        // A length the page claims is not taken: it is the server's to say.
        assert_eq!(
            spec.items,
            [
                item_at("/a/b", "b", true, None),
                item_at("/a/c", "c", false, None)
            ]
        );
        assert_eq!(spec.carried["kind"], "files");
    }

    #[test]
    fn a_taker_told_lengths_beforehand_gets_the_server_s_own() {
        let items = vec![item("a.conf", false), item("b.log", false)];
        let sized = measured(items, vec![Some((false, 120)), Some((false, 0))]).unwrap();
        assert_eq!(sized[0].size, Some(120));
        // An empty file is a file: its length is nought, and that is known.
        assert_eq!(sized[1].size, Some(0));
    }

    #[test]
    fn a_drag_with_something_that_cannot_be_measured_is_not_begun() {
        let two = || vec![item("a.conf", false), item("b", false)];
        // Unreadable, or with no length to go by.
        assert!(measured(two(), vec![Some((false, 1)), None]).is_none());
        // A folder after all: the listing showed a link.
        assert!(measured(two(), vec![Some((false, 1)), Some((true, 0))]).is_none());
        // Fewer answers than questions is not an answer.
        assert!(measured(two(), vec![Some((false, 1))]).is_none());
    }

    #[test]
    fn a_file_the_server_gives_no_length_is_told_from_an_empty_one() {
        // `/proc/cpuinfo`: nought bytes long, and there they are.
        assert!(sizeless(0, 1));
        // Empty and saying so.
        assert!(!sizeless(0, 0));
        // A length was given: it is gone by.
        assert!(!sizeless(4096, 1));
    }

    fn item_at(path: &str, name: &str, is_dir: bool, size: Option<u64>) -> OutItem {
        OutItem {
            path: path.into(),
            name: name.into(),
            is_dir,
            size,
        }
    }

    // ── Gate: a file leaves the app by one door ─────────────────────────────
    // Each check is a function over source text with comments stripped, and
    // the test shows each to catch the violation it is there for.

    /// What ships: no line comments, nothing from the tests on. Line ends as
    /// on the machine the test was written on — a Windows checkout has `\r\n`.
    fn shipped(src: &str) -> String {
        let code: Vec<&str> = src
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect();
        let code = code.join("\n");
        match code.find("#[cfg(test)]") {
            Some(tests) => code[..tests].to_string(),
            None => code,
        }
    }

    /// `first` comes before `then` in `text`, and both are there.
    fn in_order(text: &str, first: &str, then: &str) -> bool {
        matches!((text.find(first), text.find(then)), (Some(a), Some(b)) if a < b)
    }

    /// From `from` to the end of the item it opens (a closing brace in column 0).
    fn block_of<'a>(code: &'a str, from: &str) -> &'a str {
        let Some(at) = code.find(from) else { return "" };
        let rest = &code[at..];
        &rest[..rest.find("\n}\n").unwrap_or(rest.len())]
    }

    /// The command: what the page hands over is checked before anything is begun.
    fn command_faults(dragout: &str) -> Vec<&'static str> {
        let code = shipped(dragout);
        let body = block_of(&code, "pub async fn drag_out_begin(");
        let mut faults = Vec::new();
        if !in_order(body, "promised(&spec.items", "begin(&handle") {
            faults.push("names are not checked before the drag is begun");
        }
        if !body.contains("OutSpec { items, ..spec }") {
            faults.push("what is begun is not what was checked");
        }
        if !in_order(body, "session_arc_of(", "begin(&handle") {
            faults.push("the session is not asked for before the drag is begun");
        }
        if !body.contains("run_on_main_thread(move || begin(") {
            faults.push("the drag is not begun on the thread that owns the window");
        }
        // The length a taker is told is the server's, never the page's.
        if !block_of(&code, "pub struct OutItem").contains("#[serde(skip)]\n    pub size:") {
            faults.push("a length the page claims would be taken");
        }
        faults
    }

    /// Windows: answered before the call that blocks; Esc is not a drop; a
    /// read that failed is never the end of the file.
    fn windows_faults(windows: &str) -> Vec<&'static str> {
        let code = shipped(windows);
        let begin = block_of(&code, "pub fn begin(");
        let mut faults = Vec::new();
        if !in_order(begin, "button_down()", "DoDragDrop(") {
            faults.push("a drag is begun without asking whether the button is down");
        }
        if !in_order(begin, "answer(true);", "DoDragDrop(") {
            faults.push("the page is answered only when the drag is over");
        }
        let after = begin.split("DoDragDrop(").nth(1).unwrap_or("");
        if !in_order(after, "if let_go.get() {", "feed.ended();")
            || !in_order(after, "feed.ended();", "feed.cancelled();")
        {
            faults.push("a drag given up is taken for a drop");
        }
        let query = block_of(&code, "impl IDropSource_Impl for DropSource_Impl {");
        if !in_order(query, "return DRAGDROP_S_CANCEL;", "self.let_go.set(true);") {
            faults.push("Esc is not looked at before the button");
        }
        let read = block_of(&code, "impl ISequentialStream_Impl for RemoteStream_Impl {");
        if !read.contains("Err(_) => (0, STG_E_READFAULT)") {
            faults.push("a read that failed can pass for the end of the file");
        }
        faults
    }

    /// macOS: begun only with the button down; no operation — no drop; the
    /// promise is kept by a transfer of the registry, not by a read of its own.
    fn macos_faults(macos: &str) -> Vec<&'static str> {
        let code = shipped(macos);
        let begin = block_of(&code, "pub fn begin(");
        let mut faults = Vec::new();
        if !in_order(
            begin,
            "NSEvent::pressedMouseButtons() & 1 == 0",
            "beginDraggingSessionWithItems_event_source(",
        ) {
            faults.push("a session is begun without asking whether the button is down");
        }
        if !in_order(
            &code,
            "if operation == NSDragOperation::None {",
            "system_drag_ended(",
        ) || !in_order(&code, "system_drag_cancelled(", "system_drag_ended(")
        {
            faults.push("a session given up is taken for a drop");
        }
        if !code.contains("super::fetch(&app, &origin, &spec, &item, &dest)") {
            faults.push("a promise is not kept by a transfer of the registry");
        }
        if code.contains(".sftp()") || code.contains("download_file(") {
            faults.push("a promise is kept by a download of its own");
        }
        if !block_of(&code, "fn file_name(").contains("self.item_of(provider)") {
            faults.push("a name is given for a promise that was not checked");
        }
        faults
    }

    /// The system's drag is begun in this module and nowhere else.
    fn door_faults(sources: &[(String, String)]) -> Vec<String> {
        let doors = [
            ("DoDrag", "Drop(", "dragout/windows.rs"),
            ("beginDraggingSession", "WithItems", "dragout/macos.rs"),
        ];
        let mut faults = Vec::new();
        for (name, src) in sources {
            let code = shipped(src);
            for (head, tail, home) in doors {
                let call = format!("{head}{tail}");
                if code.contains(&call) && name.replace('\\', "/") != home {
                    faults.push(format!("{name} begins a drag of the system's ({call})"));
                }
            }
        }
        faults
    }

    fn sources() -> Vec<(String, String)> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    let name = path.strip_prefix(&root).unwrap().display().to_string();
                    found.push((name, std::fs::read_to_string(&path).unwrap()));
                }
            }
        }
        found
    }

    /// Apply a mutation and insist it changed something.
    fn broken(src: &str, from: &str, to: &str) -> String {
        let src = src.replace("\r\n", "\n");
        assert!(src.contains(from), "the mutation no longer applies: {from}");
        src.replacen(from, to, 1)
    }

    #[test]
    fn a_file_leaves_the_app_only_as_a_checked_promise() {
        let dragout = include_str!("dragout.rs");
        let windows = include_str!("dragout/windows.rs");
        let macos = include_str!("dragout/macos.rs");

        assert_eq!(command_faults(dragout), Vec::<&str>::new());
        assert_eq!(windows_faults(windows), Vec::<&str>::new());
        assert_eq!(macos_faults(macos), Vec::<&str>::new());
        assert_eq!(door_faults(&sources()), Vec::<String>::new());

        // ── and each check catches what it is there for ──
        let unchecked = broken(
            dragout,
            "let items = promised(&spec.items, FOLDERS);",
            "let items = spec.items.clone();",
        );
        assert!(
            command_faults(&unchecked).contains(&"names are not checked before the drag is begun")
        );
        let other = broken(dragout, "OutSpec { items, ..spec }", "OutSpec { ..spec }");
        assert!(command_faults(&other).contains(&"what is begun is not what was checked"));
        let off_thread = broken(
            dragout,
            "app.run_on_main_thread(move || begin(&handle, &source, spec, answer))",
            "Ok::<(), tauri::Error>(begin(&handle, &source, spec, answer))",
        );
        assert!(command_faults(&off_thread)
            .contains(&"the drag is not begun on the thread that owns the window"));
        let claimed = broken(
            dragout,
            "#[serde(skip)]\n    pub size:",
            "#[serde(default)]\n    pub size:",
        );
        assert!(command_faults(&claimed).contains(&"a length the page claims would be taken"));

        let late = broken(windows, "    answer(true);\n", "");
        assert!(windows_faults(&late).contains(&"the page is answered only when the drag is over"));
        let blind = broken(windows, "if button_down() {", "if true {");
        assert!(windows_faults(&blind)
            .contains(&"a drag is begun without asking whether the button is down"));
        let always = broken(windows, "if let_go.get() {", "if true {");
        assert!(windows_faults(&always).contains(&"a drag given up is taken for a drop"));
        let ended = broken(
            windows,
            "Err(_) => (0, STG_E_READFAULT)",
            "Err(_) => (0, S_FALSE)",
        );
        assert!(
            windows_faults(&ended).contains(&"a read that failed can pass for the end of the file")
        );
        let esc = broken(windows, "return DRAGDROP_S_CANCEL;", "return S_OK;");
        assert!(windows_faults(&esc).contains(&"Esc is not looked at before the button"));

        let up = broken(
            macos,
            "if NSEvent::pressedMouseButtons() & 1 == 0 {",
            "if false {",
        );
        assert!(macos_faults(&up)
            .contains(&"a session is begun without asking whether the button is down"));
        let dropped = broken(
            macos,
            "if operation == NSDragOperation::None {",
            "if false {",
        );
        assert!(macos_faults(&dropped).contains(&"a session given up is taken for a drop"));
        let own = broken(
            macos,
            "super::fetch(&app, &origin, &spec, &item, &dest)",
            "session.sftp().await",
        );
        let own = macos_faults(&own);
        assert!(own.contains(&"a promise is not kept by a transfer of the registry"));
        assert!(own.contains(&"a promise is kept by a download of its own"));

        let elsewhere = vec![(
            "appwin.rs".to_string(),
            format!(
                "fn f() {{ unsafe {{ {}{}a, b, c, d) }}; }}",
                "DoDrag", "Drop("
            ),
        )];
        assert_eq!(door_faults(&elsewhere).len(), 1);
        let at_home = vec![(
            "dragout/windows.rs".to_string(),
            format!(
                "fn f() {{ unsafe {{ {}{}a, b, c, d) }}; }}",
                "DoDrag", "Drop("
            ),
        )];
        assert!(door_faults(&at_home).is_empty());
    }
}
