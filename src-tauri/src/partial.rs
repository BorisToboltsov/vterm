//! Where an interrupted copy of one file stands (v1.36, ADR 0060).
//!
//! A file of a transfer job is written to a hidden temp next to its target and
//! put in place only when whole (`sftp::upload_staged` and its kin). When the
//! job is cut off — the connection dropped, the session was replaced — that
//! temp is kept, and the job remembers how far it is **known** to be written:
//! a resumed job continues the file from there instead of from its first byte.
//!
//! "Known" is the point of this module. The SFTP client pipelines its writes:
//! `write_all` returning means the bytes are on their way, not on the server,
//! and a server that took a later write before an earlier one would leave a
//! hole the length of the file does not show. So the copy stops every
//! [`CHECKPOINT_STEP`] bytes to have every write before that point confirmed
//! (`flush`), and only such a point is ever told ([`Partial::at`]). Whatever
//! stands in the temp beyond it is written over with the same bytes.
//!
//! And a partial copy is of one source as it was: a source whose size or
//! modification time changed since is copied again from the start
//! ([`resume_at`]).

use russh_sftp::protocol::FileAttributes;
use std::io::SeekFrom;
use std::time::UNIX_EPOCH;
use tokio::io::AsyncSeekExt;

/// How often a copy has every write before it confirmed and tells the point:
/// one round trip per this many bytes, and at most this much copied twice.
pub const CHECKPOINT_STEP: u64 = 8 * 1024 * 1024;

/// A source file as it was when its copy began: what a partial copy is of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub size: u64,
    /// Seconds since the epoch.
    pub modified: u64,
}

/// A partial copy: its temp, how much of it is known to be written, and what
/// it is a copy of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Partial {
    /// The hidden temp next to the target, on the destination's side.
    pub tmp: String,
    /// Bytes from the start of the temp, every one of them confirmed written.
    pub at: u64,
    pub source: Stamp,
}

/// How a job's copy of one file is staged. A sync run has none: its temp goes
/// with the error, as before.
pub struct Keep<'a> {
    /// A partial copy of this same file to continue, when there is one.
    pub resume: Option<Partial>,
    /// Told where the copy is known to stand: once when it begins (so the temp
    /// is the job's to clean up from its first byte), then at each checkpoint.
    pub mark: &'a (dyn Fn(Partial) + Send + Sync),
}

/// Where a copy that is continued begins, and who hears its checkpoints.
pub struct Resume<'a> {
    pub start: u64,
    pub checkpoint: &'a (dyn Fn(u64) + Send + Sync),
}

/// The point a copy of `partial`'s file continues from: its checkpoint, when
/// the source is still the one it was a copy of and the temp still holds that
/// much; otherwise zero — the file is copied again.
pub fn resume_at(partial: &Partial, source: Option<Stamp>, tmp_len: Option<u64>) -> u64 {
    match (source, tmp_len) {
        (Some(now), Some(len))
            if now == partial.source && len >= partial.at && partial.at <= now.size =>
        {
            partial.at
        }
        _ => 0,
    }
}

/// The temp a copy writes and where in it: a partial copy's own temp — from
/// its checkpoint, or from zero when it cannot be trusted (written over, not
/// left beside a new one) — or a new temp from `fresh`.
pub fn staging(
    held: Option<&Partial>,
    source: Option<Stamp>,
    tmp_len: Option<u64>,
    fresh: impl FnOnce() -> String,
) -> (String, u64) {
    match held {
        Some(partial) => (partial.tmp.clone(), resume_at(partial, source, tmp_len)),
        None => (fresh(), 0),
    }
}

/// A file of this machine, as a source.
pub fn local_stamp(meta: &std::fs::Metadata) -> Option<Stamp> {
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(Stamp {
        size: meta.len(),
        modified: modified.as_secs(),
    })
}

/// A file of a server, as a source. Without a size or a time it is no source a
/// partial copy could be checked against.
pub fn remote_stamp(attrs: &FileAttributes) -> Option<Stamp> {
    Some(Stamp {
        size: attrs.size?,
        modified: u64::from(attrs.mtime?),
    })
}

/// The temp on this machine, opened to be written at `at`: made anew from zero.
pub async fn local_writer(tmp: &str, at: u64) -> std::io::Result<tokio::fs::File> {
    if at == 0 {
        return tokio::fs::File::create(tmp).await;
    }
    let mut file = tokio::fs::OpenOptions::new().write(true).open(tmp).await?;
    file.seek(SeekFrom::Start(at)).await?;
    Ok(file)
}

/// The temp on a server, opened to be written at `at`: made anew from zero.
pub async fn remote_writer(
    sftp: &russh_sftp::client::SftpSession,
    tmp: &str,
    at: u64,
) -> Result<russh_sftp::client::fs::File, String> {
    if at == 0 {
        return sftp.create(tmp).await.map_err(|e| e.to_string());
    }
    let mut file = sftp
        .open_with_flags(tmp, russh_sftp::protocol::OpenFlags::WRITE)
        .await
        .map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(at))
        .await
        .map_err(|e| e.to_string())?;
    Ok(file)
}

/// How long a temp on this machine is, if it is there.
pub async fn local_len(tmp: &str) -> Option<u64> {
    tokio::fs::metadata(tmp).await.ok().map(|m| m.len())
}

/// How long a temp on a server is, if it is there.
pub async fn remote_len(sftp: &russh_sftp::client::SftpSession, tmp: &str) -> Option<u64> {
    sftp.metadata(tmp).await.ok().and_then(|m| m.size)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: Stamp = Stamp {
        size: 100,
        modified: 1_700_000_000,
    };

    fn partial(at: u64) -> Partial {
        Partial {
            tmp: "/srv/.a.vterm-tmp-1".into(),
            at,
            source: SOURCE,
        }
    }

    #[test]
    fn a_partial_copy_goes_on_from_its_checkpoint_only_while_it_can_be_trusted() {
        // The same source, a temp that still holds the checkpoint: from there.
        assert_eq!(resume_at(&partial(40), Some(SOURCE), Some(40)), 40);
        // More in the temp than was confirmed: still from the checkpoint — the
        // rest is written over with the same bytes.
        assert_eq!(resume_at(&partial(40), Some(SOURCE), Some(64)), 40);
        // The source changed — in size or in time: the file again.
        let grown = Stamp {
            size: 120,
            ..SOURCE
        };
        let touched = Stamp {
            modified: SOURCE.modified + 1,
            ..SOURCE
        };
        assert_eq!(resume_at(&partial(40), Some(grown), Some(40)), 0);
        assert_eq!(resume_at(&partial(40), Some(touched), Some(40)), 0);
        // A source that says nothing of itself cannot be checked.
        assert_eq!(resume_at(&partial(40), None, Some(40)), 0);
        // The temp is gone, or shorter than the checkpoint.
        assert_eq!(resume_at(&partial(40), Some(SOURCE), None), 0);
        assert_eq!(resume_at(&partial(40), Some(SOURCE), Some(39)), 0);
        // A checkpoint past the end of the source is no checkpoint of it.
        let odd = Partial {
            at: 200,
            ..partial(0)
        };
        assert_eq!(resume_at(&odd, Some(SOURCE), Some(200)), 0);
    }

    #[test]
    fn a_continued_copy_writes_its_own_temp_and_a_new_one_a_new_temp() {
        let fresh = || "/srv/.a.vterm-tmp-2".to_string();
        assert_eq!(
            staging(Some(&partial(40)), Some(SOURCE), Some(40), fresh),
            ("/srv/.a.vterm-tmp-1".to_string(), 40)
        );
        // Not to be trusted: the same temp, written over from zero — not a
        // second one left beside it.
        assert_eq!(
            staging(Some(&partial(40)), None, Some(40), fresh),
            ("/srv/.a.vterm-tmp-1".to_string(), 0)
        );
        assert_eq!(
            staging(None, Some(SOURCE), None, fresh),
            ("/srv/.a.vterm-tmp-2".to_string(), 0)
        );
    }

    #[test]
    fn a_source_is_stamped_by_its_size_and_time_or_not_at_all() {
        let attrs = |size: Option<u64>, mtime: Option<u32>| FileAttributes {
            size,
            uid: None,
            user: None,
            gid: None,
            group: None,
            permissions: None,
            atime: None,
            mtime,
        };
        assert_eq!(
            remote_stamp(&attrs(Some(5), Some(7))),
            Some(Stamp {
                size: 5,
                modified: 7
            })
        );
        assert_eq!(remote_stamp(&attrs(Some(5), None)), None);
        assert_eq!(remote_stamp(&attrs(None, Some(7))), None);
    }

    // ── Guard (v1.36, ADR 0060) ──────────────────────────────────────────────

    /// Source with line comments stripped.
    fn bare(src: &str) -> String {
        src.replace("\r\n", "\n")
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The body of the item that starts with `head`: up to its closing line.
    fn body<'a>(code: &'a str, head: &str) -> &'a str {
        let at = code.find(head).unwrap_or_else(|| panic!("{head}"));
        let rest = &code[at..];
        &rest[..rest.find("\n}\n").map_or(rest.len(), |end| end + 2)]
    }

    fn in_order(text: &str, first: &str, then: &str) -> bool {
        matches!((text.find(first), text.rfind(then)), (Some(a), Some(b)) if a < b)
    }

    const STAGED: [(&str, &str); 4] = [
        ("sftp", "pub(crate) async fn upload_staged("),
        ("sftp", "pub(crate) async fn relay_staged("),
        ("sftp", "pub(crate) async fn download_file("),
        ("localfile", "pub(crate) async fn copy_staged("),
    ];

    /// What lets a partial copy be gone on with from a point that is not whole,
    /// or lets the copy of a job lose its temp under the job's feet.
    fn partial_faults(sftp: &str, localfile: &str) -> Vec<String> {
        let mut faults = Vec::new();
        let copy = body(sftp, "pub(crate) async fn copy_from<");
        if !in_order(copy, ".flush()", "(resume.checkpoint)(")
            || copy.matches("(resume.checkpoint)(").count() != 1
        {
            faults
                .push("a checkpoint is told before the writes behind it are confirmed".to_string());
        }
        for (file, head) in STAGED {
            let code = if file == "sftp" { sftp } else { localfile };
            let staged = body(code, head);
            if !in_order(staged, "partial::staging(", "told(keep, stamp, &tmp, at)") {
                faults.push(format!("{head} picks its temp and offset by itself"));
            }
            let failed = &staged[staged.find("if let Err(e) = copied {").unwrap_or(0)..];
            let failed = &failed[..failed.find("return Err(e);").unwrap_or(failed.len())];
            if failed.contains("remove_file")
                && !in_order(failed, "if told.is_none() {", "remove_file")
            {
                faults.push(format!("{head} takes away a temp its job keeps"));
            }
        }
        faults
    }

    /// What lets an interrupted job outlive its closed tab, or the app.
    fn kept_faults(session: &str, appwin: &str, transfers: &str) -> Vec<&'static str> {
        let mut faults = Vec::new();
        let closing = body(session, "pub async fn disconnect(");
        if !in_order(
            closing,
            "forget_session(&app, &session_id)",
            "end_session(&app, &session_id)",
        ) {
            faults.push("a closed tab keeps its interrupted transfers");
        }
        if !in_order(
            appwin,
            "forget_session(&app, &id)",
            "end_session(&app, &id)",
        ) {
            faults.push("a destroyed window's tabs keep their interrupted transfers");
        }
        let quit = body(appwin, "pub async fn quit_app(");
        if !in_order(quit, "take_all_held()", "app.exit(0)") || !quit.contains("discard_held(") {
            faults.push("quitting leaves partial copies behind");
        }
        let run = body(transfers, "pub async fn run(");
        if !run.contains("matches!(done.state, State::Failed | State::Interrupted)")
            || !in_order(run, "jobs.hold(", "discard(&dst.end")
        {
            faults.push("a job the user stopped is kept, or a refused one keeps its copies");
        }
        faults
    }

    #[test]
    fn a_partial_copy_goes_on_only_from_a_confirmed_point_and_never_outlives_its_tab() {
        let sftp = bare(include_str!("sftp.rs"));
        let localfile = bare(include_str!("localfile.rs"));
        let session = bare(include_str!("commands/session.rs"));
        let appwin = bare(include_str!("appwin.rs"));
        let transfers = bare(include_str!("transfers.rs"));
        assert_eq!(partial_faults(&sftp, &localfile), Vec::<String>::new());
        assert_eq!(
            kept_faults(&session, &appwin, &transfers),
            Vec::<&str>::new()
        );

        // Each check catches its violation.
        let copy = body(&sftp, "pub(crate) async fn copy_from<");
        let unconfirmed = sftp.replacen(copy, &copy.replacen(".flush()", ".len()", 1), 1);
        assert!(partial_faults(&unconfirmed, &localfile)[0].contains("before the writes"));
        let own = sftp.replacen("partial::staging(", "pick(", 1);
        assert!(partial_faults(&own, &localfile)[0].contains("upload_staged"));
        let eager = localfile.replacen("if told.is_none() {", "if true {", 1);
        assert!(partial_faults(&sftp, &eager)[0].contains("copy_staged"));
        let kept = session.replacen("forget_session(&app, &session_id)", "", 1);
        assert_eq!(
            kept_faults(&kept, &appwin, &transfers),
            ["a closed tab keeps its interrupted transfers"]
        );
        let quick = appwin.replacen("take_all_held()", "", 1);
        assert_eq!(
            kept_faults(&session, &quick, &transfers),
            ["quitting leaves partial copies behind"]
        );
        let any = transfers.replacen(
            "State::Failed | State::Interrupted",
            "State::Failed | State::Interrupted | State::Cancelled",
            1,
        );
        assert_eq!(
            kept_faults(&session, &appwin, &any),
            ["a job the user stopped is kept, or a refused one keeps its copies"]
        );
    }

    #[tokio::test]
    async fn a_temp_is_opened_at_its_checkpoint_and_made_anew_from_zero() {
        use tokio::io::AsyncWriteExt;
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir
            .path()
            .join(".a.vterm-tmp-1")
            .to_string_lossy()
            .into_owned();
        tokio::fs::write(&tmp, b"0123456789").await.unwrap();
        let mut at = local_writer(&tmp, 4).await.unwrap();
        at.write_all(b"ab").await.unwrap();
        at.flush().await.unwrap();
        drop(at);
        assert_eq!(tokio::fs::read(&tmp).await.unwrap(), b"0123ab6789");
        assert_eq!(local_len(&tmp).await, Some(10));
        let mut anew = local_writer(&tmp, 0).await.unwrap();
        anew.write_all(b"x").await.unwrap();
        anew.flush().await.unwrap();
        drop(anew);
        assert_eq!(tokio::fs::read(&tmp).await.unwrap(), b"x");
    }
}
