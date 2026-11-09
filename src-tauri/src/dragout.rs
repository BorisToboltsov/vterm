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
//! A folder goes to Explorer too since v1.36 (ADR 0059): Explorer is told every
//! file before the drop, so the folder is walked on the server when the drag
//! begins and handed over as the list of what is in it ([`flatten`]). And files
//! of this machine — a local tab's — are handed over as they are, not promised:
//! the system copies them from where they are ([`local_items`]).
//!
//! While the system has the drag, the page that began it hears nothing of the
//! pointer. The drag's source does, and says to the app's windows what the page
//! used to ([`crate::appwin::system_drag_moved`]): held over a window of the
//! app the files are still drawn by it, and let go of there they are the app's
//! own drop, as before.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
/// dropped: since v1.36 a folder is listed off the server for that when the
/// drag begins ([`flatten`]).
pub const FOLDERS: bool = cfg!(any(target_os = "macos", windows));

/// More than this is not promised in one drag: each item is an object of the
/// system's, made before the drag can begin — on Windows every file and folder
/// inside a dragged folder counts too.
pub const MAX_ITEMS: usize = 500;

/// Why the system was not handed a drag — said to the page, which tells the
/// user when the files are let go of outside every window (v1.36).
#[cfg_attr(not(windows), allow(dead_code))] // the walk of a folder is Windows'
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Declined {
    /// A name this machine cannot give a file.
    Name,
    /// More files and folders than one drag carries ([`MAX_ITEMS`]).
    TooMany,
    /// A link to a folder: followed, it could lead anywhere, round in a circle too.
    FolderLink,
    /// Something that cannot be read, or whose length the server does not give.
    Unreadable,
    /// A path inside a folder longer than Explorer takes.
    LongPath,
    /// A file of this machine that is not there any more.
    Gone,
    /// The system would not take the drag (the button is up, the window is gone).
    NotTaken,
}

/// What `drag_out_begin` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutAnswer {
    pub taken: bool,
    pub why: Option<Declined>,
}

impl OutAnswer {
    const TAKEN: Self = Self {
        taken: true,
        why: None,
    };
    fn declined(why: Declined) -> Self {
        Self {
            taken: false,
            why: Some(why),
        }
    }
}

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
    /// taker has to be told beforehand ([`flatten`]). Never the page's word:
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
    /// The files are this machine's (a local tab's panel, v1.36): handed over
    /// as they are — `path` is where they are here — not promised.
    #[serde(default)]
    pub local: bool,
    /// A transfer of this drag was stopped: the promises not yet begun are not
    /// kept ([`in_turn`]). Shared by every copy of the drag's description.
    #[serde(skip)]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub stopped: std::sync::Arc<std::sync::atomic::AtomicBool>,
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

// ── A folder for Explorer (v1.36, ADR 0059) ──────────────────────────────────

/// What the walk saw of one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    /// A file, and how long it is.
    File(u64),
    Folder,
    /// A link to a folder.
    FolderLink,
    /// It could not be read, or has no length to go by.
    Unreadable,
}

/// One entry of a folder of the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub seen: Seen,
}

/// What a walk of the dragged folders found: each folder's entries by its path
/// on the server; `None` — it could not be listed.
pub type Listings = HashMap<String, Option<Vec<Entry>>>;

/// Most UTF-16 units of a path inside a dragged folder: what the name field of
/// a `FILEDESCRIPTORW` holds (`feed::NAME_UNITS`).
#[cfg_attr(not(windows), allow(dead_code))]
pub const PATH_UNITS: usize = 259;

/// The path of `name` inside the folder it was found in, on the server.
pub fn remote_child(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// The items of a drag as Explorer is told of them: every file with its length
/// and every folder, a folder before what is in it, each named by its path
/// inside the drag (`site/conf/a.conf` — `feed` writes the separators Windows'
/// way). `top` are the dragged items, `seen` what the server says of each of
/// them now; `listings` what the walk found in the folders.
///
/// Whole or not at all: a link to a folder, something unreadable, a name this
/// machine cannot give a file, a path too long, more than one drag carries —
/// and the drag is not begun, with the reason. Half of a folder in Explorer,
/// looking like all of it, would be worse than none.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn flatten(
    top: &[OutItem],
    seen: &[Seen],
    listings: &Listings,
) -> Result<Vec<OutItem>, Declined> {
    if top.len() != seen.len() {
        return Err(Declined::Unreadable);
    }
    let mut out = Vec::new();
    fn add(
        out: &mut Vec<OutItem>,
        listings: &Listings,
        path: &str,
        name: &str,
        seen: Seen,
    ) -> Result<(), Declined> {
        if !crate::localfile::safe_component(name.rsplit('/').next().unwrap_or(name)) {
            return Err(Declined::Name);
        }
        if name.encode_utf16().count() > PATH_UNITS {
            return Err(Declined::LongPath);
        }
        if out.len() >= MAX_ITEMS {
            return Err(Declined::TooMany);
        }
        match seen {
            Seen::File(size) => out.push(OutItem {
                path: path.to_string(),
                name: name.to_string(),
                is_dir: false,
                size: Some(size),
            }),
            Seen::FolderLink => return Err(Declined::FolderLink),
            Seen::Unreadable => return Err(Declined::Unreadable),
            Seen::Folder => {
                out.push(OutItem {
                    path: path.to_string(),
                    name: name.to_string(),
                    is_dir: true,
                    size: None,
                });
                let Some(Some(entries)) = listings.get(path) else {
                    return Err(Declined::Unreadable);
                };
                for entry in entries {
                    let child = remote_child(path, &entry.name);
                    add(
                        out,
                        listings,
                        &child,
                        &format!("{name}/{}", entry.name),
                        entry.seen,
                    )?;
                }
            }
        }
        Ok(())
    }
    for (item, seen) in top.iter().zip(seen) {
        add(&mut out, listings, &item.path, &item.name, *seen)?;
    }
    Ok(out)
}

/// What the server says of `path` now, following a link: a file with its
/// length (an "empty" one is read once — the server gives no length to what it
/// makes up as it is read, [`sizeless`]), a folder, or neither. `link` — the
/// entry is a link, and a folder behind it is a [`Seen::FolderLink`].
#[cfg_attr(not(windows), allow(dead_code))]
async fn seen_of(sftp: &russh_sftp::client::SftpSession, path: &str, link: bool) -> Seen {
    use tokio::io::AsyncReadExt;
    let Ok(said) = sftp.metadata(path.to_string()).await else {
        return Seen::Unreadable;
    };
    if said.is_dir() {
        return if link { Seen::FolderLink } else { Seen::Folder };
    }
    if !said.is_regular() {
        return Seen::Unreadable;
    }
    let Some(size) = said.size else {
        return Seen::Unreadable;
    };
    if size == 0 {
        let Ok(mut file) = sftp.open(path.to_string()).await else {
            return Seen::Unreadable;
        };
        let mut byte = [0u8; 1];
        match file.read(&mut byte).await {
            Ok(first) if !sizeless(size, first) => {}
            _ => return Seen::Unreadable,
        }
    }
    Seen::File(size)
}

/// Walk the dragged items on the server: what each is, and what is in each
/// folder, down to the bottom — stopping as soon as more turned up than one
/// drag carries.
#[cfg_attr(not(windows), allow(dead_code))]
async fn survey(
    app: &AppHandle,
    session_id: &str,
    items: &[OutItem],
) -> Result<(Vec<Seen>, Listings), Declined> {
    let session = crate::session_arc_of(app, session_id)
        .await
        .map_err(|_| Declined::Unreadable)?;
    let sftp = session.sftp().await.map_err(|_| Declined::Unreadable)?;
    let mut seen = Vec::with_capacity(items.len());
    let mut folders = Vec::new();
    for item in items {
        // A dragged entry the listing called a file but is a folder is a link to one.
        let now = seen_of(&sftp, &item.path, !item.is_dir).await;
        if now == Seen::Folder {
            folders.push(item.path.clone());
        }
        seen.push(now);
    }
    let mut listings = Listings::new();
    let mut counted = items.len();
    while let Some(dir) = folders.pop() {
        let Ok(listed) = sftp.read_dir(dir.clone()).await else {
            listings.insert(dir, None);
            continue;
        };
        let mut entries = Vec::new();
        for entry in listed {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            counted += 1;
            if counted > MAX_ITEMS {
                return Err(Declined::TooMany);
            }
            let path = remote_child(&dir, &name);
            let kind = entry.file_type();
            let now = if kind.is_dir() {
                Seen::Folder
            } else {
                seen_of(&sftp, &path, kind.is_symlink()).await
            };
            if now == Seen::Folder {
                folders.push(path);
            }
            entries.push(Entry { name, seen: now });
        }
        listings.insert(dir, Some(entries));
    }
    Ok((seen, listings))
}

/// Files of this machine to hand to the system as they are (v1.36): each must
/// be an absolute path that is there now — the page's word is checked, never
/// taken. A drag of a file that went is not begun.
pub fn local_items(items: &[OutItem]) -> Result<Vec<OutItem>, Declined> {
    if items.len() > MAX_ITEMS {
        return Err(Declined::TooMany);
    }
    items
        .iter()
        .map(|item| {
            let path = std::path::Path::new(&item.path);
            if !path.is_absolute() {
                return Err(Declined::Gone);
            }
            let meta = std::fs::metadata(path).map_err(|_| Declined::Gone)?;
            Ok(OutItem {
                is_dir: meta.is_dir(),
                size: meta.is_file().then_some(meta.len()),
                ..item.clone()
            })
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

/// How many promises are kept at once. Whatever took the files asks for every
/// one of them in one go — and a transfer each, all at once, would hold open as
/// many files as were dragged, on this machine and on the server: a few hundred
/// is past what either lets one program have.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const KEPT_AT_ONCE: usize = 4;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static KEEPING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(KEPT_AT_ONCE);

/// How keeping one promise ended.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, PartialEq)]
pub enum Kept {
    Done,
    /// Its transfer was stopped by the user.
    Stopped,
    Failed(String),
}

/// Keep one promise of a drag when its turn comes. Once a transfer of the drag
/// has been stopped, the ones still waiting are not begun: stopping a file that
/// is on its way out says "not these", and the next few hundred starting up one
/// after another, each to be stopped by hand, would say the app did not hear.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub async fn in_turn<K, W>(
    turns: &tokio::sync::Semaphore,
    stopped: &std::sync::atomic::AtomicBool,
    keep: K,
) -> Result<(), String>
where
    K: FnOnce() -> W,
    W: std::future::Future<Output = Kept>,
{
    use std::sync::atomic::Ordering;
    let _turn = turns.acquire().await.map_err(|_| "cancelled".to_string())?;
    if stopped.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    match keep().await {
        Kept::Done => Ok(()),
        Kept::Stopped => {
            stopped.store(true, Ordering::SeqCst);
            Err("cancelled".into())
        }
        Kept::Failed(why) => Err(why),
    }
}

/// The transfer that keeps a promise: `item` of the session, to `dest` on this
/// machine. `dest` is the system's — it named the folder, and settled what the
/// file is called there — so what is at `dest` may be replaced.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
    in_turn(&KEEPING, &spec.stopped, || async {
        let id = format!("out-{}", crate::uuid_like());
        let job = fetch_spec(spec, item, dest, id);
        // Not queued behind the session's other jobs: the system waits for this file now.
        let wait = match crate::commands::sftp::launch_transfer(app, origin, job, false, None).await
        {
            Ok(wait) => wait,
            Err(e) => return Kept::Failed(e.to_string()),
        };
        match wait.await {
            Ok(done) => match done.state {
                crate::transfers::State::Done => Kept::Done,
                crate::transfers::State::Cancelled => Kept::Stopped,
                _ => Kept::Failed(done.error.unwrap_or_else(|| "the transfer failed".into())),
            },
            Err(_) => Kept::Failed("the transfer was dropped".into()),
        }
    })
    .await
}

/// Files have left the window they were dragged from: hand the drag to the
/// system. Taken — it has it now, and the page lets go; not — it does not, and
/// why (this system cannot, the button is no longer down, something cannot be
/// handed over), and the page carries on as it did.
#[tauri::command]
pub async fn drag_out_begin(
    app: AppHandle,
    window: WebviewWindow,
    spec: OutSpec,
) -> AppResult<OutAnswer> {
    if !SUPPORTED {
        return Ok(OutAnswer::declined(Declined::NotTaken));
    }
    let items = if spec.local {
        // This machine's own files: handed over from where they are.
        match local_items(&spec.items) {
            Ok(items) => items,
            Err(why) => return Ok(OutAnswer::declined(why)),
        }
    } else {
        let items = promised(&spec.items, FOLDERS);
        if items.len() != spec.items.len().min(MAX_ITEMS) {
            return Ok(OutAnswer::declined(Declined::Name));
        }
        // The session has to be there to read from — asked now, not at the drop.
        if items.is_empty() || crate::session_arc_of(&app, &spec.session).await.is_err() {
            return Ok(OutAnswer::declined(Declined::Unreadable));
        }
        // Explorer is told every file and how long it is before it reads one:
        // a folder is walked now, on the server.
        #[cfg(windows)]
        let items = {
            let flat = match survey(&app, &spec.session, &items).await {
                Ok((seen, listings)) => flatten(&items, &seen, &listings),
                Err(why) => Err(why),
            };
            match flat {
                Ok(items) => items,
                Err(why) => return Ok(OutAnswer::declined(why)),
            }
        };
        items
    };
    let spec = OutSpec { items, ..spec };
    // The system's drag begins on the thread that owns the window.
    let (answer, began) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let source = window.clone();
    app.run_on_main_thread(move || begin(&handle, &source, spec, answer))
        .map_err(|e| crate::error::AppError::Message(format!("drag out: {e}")))?;
    Ok(if began.await.unwrap_or(false) {
        OutAnswer::TAKEN
    } else {
        OutAnswer::declined(Declined::NotTaken)
    })
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
            stopped: Default::default(),
            local: false,
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

    #[tokio::test]
    async fn no_more_promises_are_kept_at_once_than_there_are_turns() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;
        let turns = Arc::new(tokio::sync::Semaphore::new(3));
        let stopped = Arc::new(AtomicBool::new(false));
        let (now, most) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let mut all = Vec::new();
        for _ in 0..40 {
            let (turns, stopped, now, most) =
                (turns.clone(), stopped.clone(), now.clone(), most.clone());
            all.push(tokio::spawn(async move {
                in_turn(&turns, &stopped, || async {
                    let at = now.fetch_add(1, Ordering::SeqCst) + 1;
                    most.fetch_max(at, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                    now.fetch_sub(1, Ordering::SeqCst);
                    Kept::Done
                })
                .await
            }));
        }
        for one in all {
            assert_eq!(one.await.unwrap(), Ok(()));
        }
        assert_eq!(most.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_transfer_stopped_keeps_the_rest_of_its_drag_from_starting() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let turns = tokio::sync::Semaphore::new(1);
        let stopped = AtomicBool::new(false);
        let begun = AtomicUsize::new(0);
        let keep = |how: Kept| {
            let begun = &begun;
            move || async move {
                begun.fetch_add(1, Ordering::SeqCst);
                how
            }
        };
        assert_eq!(in_turn(&turns, &stopped, keep(Kept::Done)).await, Ok(()));
        // One that failed is one that failed: the rest are still wanted.
        assert_eq!(
            in_turn(
                &turns,
                &stopped,
                keep(Kept::Failed("permission denied".into()))
            )
            .await,
            Err("permission denied".to_string())
        );
        assert_eq!(in_turn(&turns, &stopped, keep(Kept::Done)).await, Ok(()));
        // One stopped by the user: the ones behind it are not begun at all.
        assert!(in_turn(&turns, &stopped, keep(Kept::Stopped))
            .await
            .is_err());
        assert_eq!(begun.load(Ordering::SeqCst), 4);
        assert!(in_turn(&turns, &stopped, keep(Kept::Done)).await.is_err());
        assert!(in_turn(&turns, &stopped, keep(Kept::Done)).await.is_err());
        assert_eq!(begun.load(Ordering::SeqCst), 4);
        // Another drag is another matter.
        let other = AtomicBool::new(false);
        assert_eq!(in_turn(&turns, &other, keep(Kept::Done)).await, Ok(()));
    }

    fn top(path: &str, name: &str, is_dir: bool) -> OutItem {
        OutItem {
            path: path.into(),
            name: name.into(),
            is_dir,
            size: None,
        }
    }

    fn entry(name: &str, seen: Seen) -> Entry {
        Entry {
            name: name.into(),
            seen,
        }
    }

    #[test]
    fn a_folder_goes_to_explorer_as_what_is_in_it_a_folder_before_its_files() {
        let items = vec![
            top("/srv/site", "site", true),
            top("/srv/a.conf", "a.conf", false),
        ];
        let mut listings = Listings::new();
        listings.insert(
            "/srv/site".into(),
            Some(vec![
                entry("conf", Seen::Folder),
                entry("index.html", Seen::File(120)),
                entry("empty", Seen::Folder),
            ]),
        );
        listings.insert(
            "/srv/site/conf".into(),
            Some(vec![entry("nginx.conf", Seen::File(0))]),
        );
        listings.insert("/srv/site/empty".into(), Some(vec![]));
        let flat = flatten(&items, &[Seen::Folder, Seen::File(7)], &listings).unwrap();
        let shown: Vec<(&str, &str, bool, Option<u64>)> = flat
            .iter()
            .map(|i| (i.path.as_str(), i.name.as_str(), i.is_dir, i.size))
            .collect();
        assert_eq!(
            shown,
            vec![
                ("/srv/site", "site", true, None),
                ("/srv/site/conf", "site/conf", true, None),
                (
                    "/srv/site/conf/nginx.conf",
                    "site/conf/nginx.conf",
                    false,
                    Some(0)
                ),
                ("/srv/site/index.html", "site/index.html", false, Some(120)),
                // An empty folder is made too.
                ("/srv/site/empty", "site/empty", true, None),
                ("/srv/a.conf", "a.conf", false, Some(7)),
            ]
        );
    }

    #[test]
    fn a_folder_goes_whole_or_not_at_all_and_says_why() {
        let site = || vec![top("/srv/site", "site", true)];
        let with = |entries: Vec<Entry>| {
            let mut listings = Listings::new();
            listings.insert("/srv/site".into(), Some(entries));
            listings
        };
        let flat = |entries| flatten(&site(), &[Seen::Folder], &with(entries));
        assert_eq!(
            flat(vec![entry("logs", Seen::FolderLink)]),
            Err(Declined::FolderLink)
        );
        assert_eq!(
            flat(vec![entry("cpuinfo", Seen::Unreadable)]),
            Err(Declined::Unreadable)
        );
        // A name from the server that this machine cannot give a file.
        assert_eq!(flat(vec![entry("..", Seen::File(1))]), Err(Declined::Name));
        assert_eq!(
            flat(vec![entry(&"x".repeat(300), Seen::File(1))]),
            Err(Declined::LongPath)
        );
        let many: Vec<Entry> = (0..MAX_ITEMS)
            .map(|i| entry(&format!("f{i}"), Seen::File(1)))
            .collect();
        assert_eq!(flat(many), Err(Declined::TooMany));
        // A folder that could not be listed, and one the walk never reached.
        let mut unlisted = Listings::new();
        unlisted.insert("/srv/site".into(), None);
        assert_eq!(
            flatten(&site(), &[Seen::Folder], &unlisted),
            Err(Declined::Unreadable)
        );
        assert_eq!(
            flatten(&site(), &[Seen::Folder], &Listings::new()),
            Err(Declined::Unreadable)
        );
        // A dragged "file" that is a link to a folder, and fewer answers than items.
        assert_eq!(
            flatten(
                &[top("/srv/l", "l", false)],
                &[Seen::FolderLink],
                &Listings::new()
            ),
            Err(Declined::FolderLink)
        );
        assert_eq!(
            flatten(&site(), &[], &Listings::new()),
            Err(Declined::Unreadable)
        );
    }

    #[test]
    fn a_file_of_this_machine_is_handed_over_only_when_it_is_there() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = scratch.path().to_path_buf();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        let at = |p: &std::path::Path| top(&p.to_string_lossy(), "x", false);
        let items = local_items(&[at(&file), at(&dir)]).unwrap();
        assert_eq!((items[0].is_dir, items[0].size), (false, Some(5)));
        assert!(items[1].is_dir);
        assert_eq!(local_items(&[at(&dir.join("gone"))]), Err(Declined::Gone));
        assert_eq!(
            local_items(&[top("relative/a.txt", "a.txt", false)]),
            Err(Declined::Gone)
        );
        let many: Vec<OutItem> = (0..=MAX_ITEMS).map(|_| at(&file)).collect();
        assert_eq!(local_items(&many), Err(Declined::TooMany));
        drop(scratch);
    }

    #[test]
    fn the_page_is_told_whether_the_system_took_the_drag_and_why_not() {
        assert_eq!(
            serde_json::to_value(OutAnswer::TAKEN).unwrap(),
            serde_json::json!({"taken": true, "why": null})
        );
        assert_eq!(
            serde_json::to_value(OutAnswer::declined(Declined::FolderLink)).unwrap(),
            serde_json::json!({"taken": false, "why": "folderLink"})
        );
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
        // Every promise is kept in its turn: the one place that starts its
        // transfer does so inside `in_turn`.
        let fetch = block_of(&code, "pub(crate) async fn fetch(");
        if code.matches("launch_transfer(").count() != 1
            || !in_order(
                fetch,
                "in_turn(&KEEPING, &spec.stopped,",
                "launch_transfer(",
            )
        {
            faults.push("a promise is kept out of turn");
        }
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
        // Files of this machine (v1.36): the page's paths are checked — absolute,
        // there now — before anything is handed over.
        if !in_order(body, "if spec.local {", "local_items(&spec.items)")
            || !in_order(body, "local_items(&spec.items)", "begin(&handle")
        {
            faults.push("files of this machine are handed over unchecked");
        }
        // A folder for Explorer: walked on the server and flattened, whole or not at all.
        if !in_order(
            body,
            "survey(&app, &spec.session, &items)",
            "flatten(&items, &seen, &listings)",
        ) || !in_order(body, "flatten(&items, &seen, &listings)", "begin(&handle")
        {
            faults.push("a folder is handed to Explorer without being walked");
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
        if code.contains("launch_transfer(") {
            faults.push("a promise is kept out of turn");
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
        let at_once = broken(
            dragout,
            "in_turn(&KEEPING, &spec.stopped, || async {",
            "in_turn(&tokio::sync::Semaphore::new(999), &spec.stopped, || async {",
        );
        assert!(command_faults(&at_once).contains(&"a promise is kept out of turn"));
        let claimed = broken(
            dragout,
            "#[serde(skip)]\n    pub size:",
            "#[serde(default)]\n    pub size:",
        );
        assert!(command_faults(&claimed).contains(&"a length the page claims would be taken"));
        let trusted = broken(
            dragout,
            "match local_items(&spec.items) {",
            "match Ok::<_, Declined>(spec.items.clone()) {",
        );
        assert!(
            command_faults(&trusted).contains(&"files of this machine are handed over unchecked")
        );
        let unwalked = broken(
            dragout,
            "Ok((seen, listings)) => flatten(&items, &seen, &listings),",
            "Ok((_seen, _listings)) => Ok(items.clone()),",
        );
        assert!(command_faults(&unwalked)
            .contains(&"a folder is handed to Explorer without being walked"));

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
