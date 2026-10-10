//! What a system drag on Windows reads from: a file of a server as a plain,
//! blocking stream of bytes.
//!
//! Explorer pulls a dropped file through a COM stream, one `Read` at a time, on
//! a thread of its choosing — and it wants bytes, not a future. The file is on
//! a server, read by a task of the async runtime; the two meet in a bounded
//! channel. Nothing of it is Windows': this half is plain Rust, compiled and
//! tested everywhere, so that the part which can only be built for Windows
//! (`windows.rs`) is nothing but the COM objects around it.

// Used by the Windows half only; built — and tested — on every machine.
#![cfg_attr(not(windows), allow(dead_code))]

use super::{OutItem, OutSpec};
use std::io::Read;
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt};

/// One block read from the server.
const BLOCK: usize = 64 * 1024;

/// Blocks waiting to be taken. Bounded: a reader that stops reading stops the
/// download, instead of the file piling up in memory.
const AHEAD: usize = 8;

/// A read that gets nothing for this long fails. The stream is read on a
/// thread that may be the app's own (see `windows.rs`): a server that has gone
/// quiet must not hold it for good.
const STALL: Duration = Duration::from_secs(30);

/// A block of the file; an empty one — its end, said in so many words. A
/// channel that just closes is a download that broke off, not a file that is
/// whole: taken for the end, it would leave a cut-off file looking finished.
type Chunk = Result<Vec<u8>, String>;

/// How far a read has got.
enum Flow {
    Going,
    /// The file is whole.
    Whole,
    /// It is not, and will not be: said again to every read that follows. A
    /// failure that turned into "no more bytes" on the next read would be a
    /// cut-off file handed over as a finished one.
    Broken(std::io::ErrorKind, String),
}

/// A file of a server, read as it arrives.
pub struct RemoteReader {
    blocks: Receiver<Chunk>,
    block: Vec<u8>,
    at: usize,
    flow: Flow,
    stall: Duration,
}

impl RemoteReader {
    fn new(blocks: Receiver<Chunk>, stall: Duration) -> Self {
        Self {
            blocks,
            block: Vec::new(),
            at: 0,
            flow: Flow::Going,
            stall,
        }
    }

    fn broken(&mut self, kind: std::io::ErrorKind, message: String) -> std::io::Error {
        self.flow = Flow::Broken(kind, message.clone());
        std::io::Error::new(kind, message)
    }
}

impl Read for RemoteReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        while self.at == self.block.len() {
            match &self.flow {
                Flow::Going => {}
                Flow::Whole => return Ok(0),
                Flow::Broken(kind, message) => {
                    return Err(std::io::Error::new(*kind, message.clone()))
                }
            }
            match self.blocks.recv_timeout(self.stall) {
                Ok(Ok(block)) if block.is_empty() => {
                    self.flow = Flow::Whole;
                    return Ok(0);
                }
                Ok(Ok(block)) => {
                    self.block = block;
                    self.at = 0;
                }
                Ok(Err(message)) => return Err(self.broken(std::io::ErrorKind::Other, message)),
                // The task is gone without saying the file had ended.
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.broken(
                        std::io::ErrorKind::UnexpectedEof,
                        "the download broke off".into(),
                    ));
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(self.broken(
                        std::io::ErrorKind::TimedOut,
                        "the server stopped sending".into(),
                    ));
                }
            }
        }
        let n = out.len().min(self.block.len() - self.at);
        out[..n].copy_from_slice(&self.block[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

/// Read what `open` opens, block by block, into a [`RemoteReader`]. The task
/// ends when the file does, when it fails — the reader is told why — or when
/// the reader is dropped. `ended` hears how many bytes went and whether all of
/// them did.
pub fn pipe<R, O, E>(open: O, stall: Duration, ended: E) -> RemoteReader
where
    R: AsyncRead + Unpin + Send + 'static,
    O: std::future::Future<Output = Result<R, String>> + Send + 'static,
    E: FnOnce(u64, Result<(), String>) + Send + 'static,
{
    let (send, blocks) = sync_channel::<Chunk>(AHEAD);
    tauri::async_runtime::spawn(async move {
        let mut moved: u64 = 0;
        let outcome: Result<(), String> = async {
            let mut source = open.await?;
            loop {
                let mut block = vec![0u8; BLOCK];
                let n = source.read(&mut block).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Ok(());
                }
                block.truncate(n);
                moved += n as u64;
                // The channel is a blocking one, and full means "wait": that
                // wait belongs on a thread that may block.
                let send = send.clone();
                let sent = tokio::task::spawn_blocking(move || send.send(Ok(block)))
                    .await
                    .map_err(|e| e.to_string())?;
                if sent.is_err() {
                    return Err("nobody is reading any more".to_string());
                }
            }
        }
        .await;
        // The last word — the end, or why there is none — waits for room in the
        // channel like any block: dropped, it would turn a failure into an end.
        let last: Chunk = match &outcome {
            Ok(()) => Ok(Vec::new()),
            Err(message) => Err(message.clone()),
        };
        let _ = tokio::task::spawn_blocking(move || send.send(last)).await;
        ended(moved, outcome);
    });
    RemoteReader::new(blocks, stall)
}

// ── The stream Explorer reads, without the COM around it ────────────────────

/// Where a seek is counted from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Whence {
    Start,
    Here,
    End,
}

/// One file as whatever took the drag reads it: opened by the first read, read
/// once, front to back.
///
/// Not by the handing over: a program that only looks at what is held over it
/// asks for the stream too, and a download must not begin because a pointer
/// passed over a window.
pub struct Outflow {
    open: Option<Box<dyn FnOnce() -> Option<RemoteReader> + Send>>,
    reader: Option<RemoteReader>,
    /// How long the file is, when the server said.
    size: Option<u64>,
    /// How much of it has been handed over.
    at: u64,
    /// Where the reader says it stands: at `at` — or, having asked how long
    /// the file is the way readers do (by going to its end), there.
    stands: u64,
}

impl Outflow {
    pub fn new(
        size: Option<u64>,
        open: impl FnOnce() -> Option<RemoteReader> + Send + 'static,
    ) -> Self {
        Self {
            open: Some(Box::new(open)),
            reader: None,
            size,
            at: 0,
            stands: 0,
        }
    }

    pub fn size(&self) -> Option<u64> {
        self.size
    }

    /// Fill `out`. Fewer bytes than it holds — the file has ended: a reader of
    /// such a stream may take a short read for the end, so there is none
    /// before it.
    pub fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        // Standing at the end, having gone there to measure the file.
        if out.is_empty() || self.stands != self.at {
            return Ok(0);
        }
        if let Some(open) = self.open.take() {
            self.reader = open();
        }
        let Some(reader) = self.reader.as_mut() else {
            return Err(std::io::Error::other("the file cannot be read"));
        };
        let mut filled = 0;
        while filled < out.len() {
            match reader.read(&mut out[filled..])? {
                0 => break,
                n => filled += n,
            }
        }
        self.at += filled as u64;
        self.stands = self.at;
        Ok(filled)
    }

    /// The places a stream read once can go: where it has read to, and the
    /// end — which is how a reader asks how long a file is before rewinding to
    /// read it. Anywhere else would need the bytes that have already gone, or
    /// ones not yet here.
    pub fn seek(&mut self, offset: i64, whence: Whence) -> Option<u64> {
        let to = match whence {
            Whence::Start => u64::try_from(offset).ok()?,
            Whence::Here => self.stands.checked_add_signed(offset)?,
            Whence::End => self.size?.checked_add_signed(offset)?,
        };
        if to != self.at && Some(to) != self.size {
            return None;
        }
        self.stands = to;
        Some(to)
    }
}

// ── What Explorer is told of the files ──────────────────────────────────────
// A `FILEGROUPDESCRIPTORW`: a count, then one fixed-size record per file. Laid
// out here by hand, byte for byte, so that it is tested on every machine; the
// Windows half only copies it into the memory block the system asks for.

/// Size of one `FILEDESCRIPTORW`.
pub const DESCRIPTOR_SIZE: usize = 592;
/// Where its fields are.
const AT_FLAGS: usize = 0;
const AT_ATTRIBUTES: usize = 36;
const AT_SIZE_HIGH: usize = 64;
const AT_SIZE_LOW: usize = 68;
const AT_NAME: usize = 72;
/// A name is at most this many UTF-16 units, and a zero after them.
const NAME_UNITS: usize = 259;

const FD_ATTRIBUTES: u32 = 0x0000_0004;
const FD_FILESIZE: u32 = 0x0000_0040;
const FD_PROGRESSUI: u32 = 0x0000_4000;
const FD_UNICODE: u32 = 0x8000_0000;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;

/// The name a file is given in Explorer: the server's, with what Windows
/// cannot have in a file name replaced. (Separators and `:` never get here —
/// such a name is not promised at all, `dragout::promised`.)
pub fn windows_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '<' | '>' | '"' | '|' | '?' | '*' | '/' | '\\' | ':' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect()
}

/// The bytes of a `FILEGROUPDESCRIPTORW` for `items`: each a plain file, with
/// its size when the listing knew it, and Explorer's own progress window asked
/// for.
pub fn descriptor_bytes(items: &[OutItem]) -> Vec<u8> {
    let mut out = vec![0u8; 4 + items.len() * DESCRIPTOR_SIZE];
    out[..4].copy_from_slice(&(items.len() as u32).to_le_bytes());
    for (i, item) in items.iter().enumerate() {
        let record = &mut out[4 + i * DESCRIPTOR_SIZE..4 + (i + 1) * DESCRIPTOR_SIZE];
        let mut flags = FD_ATTRIBUTES | FD_PROGRESSUI | FD_UNICODE;
        if let Some(size) = item.size {
            flags |= FD_FILESIZE;
            record[AT_SIZE_HIGH..AT_SIZE_HIGH + 4]
                .copy_from_slice(&((size >> 32) as u32).to_le_bytes());
            record[AT_SIZE_LOW..AT_SIZE_LOW + 4].copy_from_slice(&(size as u32).to_le_bytes());
        }
        record[AT_FLAGS..AT_FLAGS + 4].copy_from_slice(&flags.to_le_bytes());
        record[AT_ATTRIBUTES..AT_ATTRIBUTES + 4]
            .copy_from_slice(&FILE_ATTRIBUTE_NORMAL.to_le_bytes());
        for (n, unit) in windows_name(&item.name)
            .encode_utf16()
            .take(NAME_UNITS)
            .enumerate()
        {
            record[AT_NAME + n * 2..AT_NAME + n * 2 + 2].copy_from_slice(&unit.to_le_bytes());
        }
    }
    out
}

/// What the COM objects of a drag know of the app: which files they stand for,
/// how to read one, and whom to tell where the pointer is.
pub struct Feed {
    app: AppHandle,
    /// Label of the window the drag began in.
    source: String,
    spec: OutSpec,
}

impl Feed {
    pub fn new(app: &AppHandle, source: &str, spec: OutSpec) -> Self {
        Self {
            app: app.clone(),
            source: source.to_string(),
            spec,
        }
    }

    pub fn items(&self) -> &[OutItem] {
        &self.spec.items
    }

    /// The file at `index`, as a stream to hand over. Nothing is read yet.
    pub fn outflow(self: &std::sync::Arc<Self>, index: usize) -> Option<Outflow> {
        let size = self.spec.items.get(index)?.size;
        let feed = self.clone();
        Some(Outflow::new(size, move || feed.open(index)))
    }

    /// Start reading the file at `index`. The session's recording is told when
    /// the read has ended — a file that left the server is something it keeps.
    pub fn open(&self, index: usize) -> Option<RemoteReader> {
        let item = self.spec.items.get(index)?.clone();
        let (app, session_id, path) = (self.app.clone(), self.spec.session.clone(), item.path);
        let (audit_app, audit_session, audit_path) =
            (app.clone(), session_id.clone(), path.clone());
        let open = async move {
            let session = crate::session_arc_of(&app, &session_id)
                .await
                .map_err(|e| e.to_string())?;
            let sftp = session.sftp().await.map_err(|e| e.to_string())?;
            sftp.open(path.clone())
                .await
                .map_err(|e| format!("open {path}: {e}"))
        };
        Some(pipe(open, STALL, move |_moved, outcome| {
            tauri::async_runtime::spawn(async move {
                let Ok(session) = crate::session_arc_of(&audit_app, &audit_session).await else {
                    return;
                };
                let op = format!(
                    "get {} -> (dragged out)",
                    crate::git::shell_quote(&audit_path)
                );
                let (code, detail) = match outcome {
                    Ok(()) => (0, String::new()),
                    Err(message) => (1, message),
                };
                session.record_output(crate::sftp::sftp_mirror(&op, code, &detail).as_bytes());
            });
        }))
    }

    /// The pointer has moved: the window of the app under it draws the files.
    /// True when there is one. Main thread only.
    pub fn moved(&self) -> bool {
        crate::appwin::system_drag_moved(&self.app, &self.source, &self.spec.carried)
    }

    /// The drag was given up: nobody has the files. Main thread only.
    pub fn cancelled(&self) {
        crate::appwin::system_drag_cancelled(&self.app, &self.source);
    }

    /// The drag has ended. True when it was let go of over a window of the app,
    /// which has the files now. Main thread only.
    pub fn ended(&self) -> bool {
        crate::appwin::system_drag_ended(&self.app, &self.source, &self.spec.carried)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    /// Read a reader to its end on a thread that may block, as Explorer would.
    fn drain(mut reader: RemoteReader, step: usize) -> std::io::Result<Vec<u8>> {
        let mut all = Vec::new();
        let mut buf = vec![0u8; step];
        loop {
            match reader.read(&mut buf)? {
                0 => return Ok(all),
                n => all.extend_from_slice(&buf[..n]),
            }
        }
    }

    fn file(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn a_file_comes_through_whole_whatever_the_size_of_a_read() {
        let bytes = file(3 * BLOCK + 123);
        for step in [1 << 20, 4096, 7] {
            let source = std::io::Cursor::new(bytes.clone());
            let (said, heard) = channel();
            let reader = pipe(
                async move { Ok(source) },
                Duration::from_secs(5),
                move |moved, outcome| {
                    let _ = said.send((moved, outcome));
                },
            );
            assert_eq!(drain(reader, step).unwrap(), bytes, "step {step}");
            let (moved, outcome) = heard.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(moved, bytes.len() as u64);
            assert_eq!(outcome, Ok(()));
        }
    }

    #[test]
    fn an_empty_file_is_an_end_not_an_error() {
        let reader = pipe(
            async { Ok(std::io::Cursor::new(Vec::new())) },
            Duration::from_secs(5),
            |_, _| {},
        );
        assert_eq!(drain(reader, 4096).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn a_file_that_cannot_be_opened_fails_the_read_and_says_why() {
        let (said, heard) = channel();
        let reader = pipe(
            async {
                Err::<std::io::Cursor<Vec<u8>>, _>(
                    "open /etc/shadow: permission denied".to_string(),
                )
            },
            Duration::from_secs(5),
            move |moved, outcome| {
                let _ = said.send((moved, outcome));
            },
        );
        let error = drain(reader, 4096).unwrap_err();
        assert!(error.to_string().contains("permission denied"), "{error}");
        let (moved, outcome) = heard.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(moved, 0);
        assert!(outcome.is_err());
    }

    /// A source that gives one block and then nothing, for ever.
    struct Stalls(bool);
    impl AsyncRead for Stalls {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if self.0 {
                return std::task::Poll::Pending;
            }
            self.0 = true;
            buf.put_slice(b"first");
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn a_server_gone_quiet_fails_the_read_instead_of_holding_it() {
        let mut reader = pipe(
            async { Ok(Stalls(false)) },
            Duration::from_millis(150),
            |_, _| {},
        );
        let mut buf = [0u8; 16];
        assert_eq!(reader.read(&mut buf).unwrap(), 5);
        let error = reader.read(&mut buf).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        // And it stays failed — at once, without waiting again, and never as
        // "no more bytes": that would be the cut-off file passing for a whole one.
        let asked = std::time::Instant::now();
        let again = reader.read(&mut buf).unwrap_err();
        assert_eq!(again.kind(), std::io::ErrorKind::TimedOut);
        assert!(asked.elapsed() < Duration::from_millis(100));
    }

    fn whole(bytes: Vec<u8>) -> RemoteReader {
        pipe(
            async move { Ok(std::io::Cursor::new(bytes)) },
            Duration::from_secs(5),
            |_, _| {},
        )
    }

    #[test]
    fn a_stream_handed_over_reads_nothing_until_it_is_read() {
        let opened = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = opened.clone();
        let mut flow = Outflow::new(Some(5), move || {
            seen.store(true, std::sync::atomic::Ordering::SeqCst);
            Some(whole(b"hello".to_vec()))
        });
        // Looked at, asked where it is and how long, rewound: no download.
        let mut buf = [0u8; 3];
        assert_eq!(flow.seek(0, Whence::Here), Some(0));
        assert_eq!(flow.seek(0, Whence::End), Some(5));
        // Standing at the end there is nothing to read — and nothing is opened.
        assert_eq!(flow.read(&mut buf).unwrap(), 0);
        assert_eq!(flow.seek(0, Whence::Start), Some(0));
        assert!(!opened.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(flow.read(&mut buf).unwrap(), 3);
        assert!(opened.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(&buf, b"hel");
    }

    #[test]
    fn a_read_is_short_only_at_the_end_of_the_file() {
        let bytes = file(2 * BLOCK + 10);
        let mut flow = Outflow::new(None, {
            let bytes = bytes.clone();
            move || Some(whole(bytes))
        });
        // More than one block is asked for at once: all of it comes.
        let mut big = vec![0u8; BLOCK + 500];
        assert_eq!(flow.read(&mut big).unwrap(), big.len());
        assert_eq!(big, bytes[..BLOCK + 500]);
        assert_eq!(flow.seek(0, Whence::Here), Some((BLOCK + 500) as u64));
        // The rest is less than is asked for — and that is the end.
        let mut rest = vec![0u8; 4 * BLOCK];
        let n = flow.read(&mut rest).unwrap();
        assert_eq!(n, bytes.len() - big.len());
        assert_eq!(rest[..n], bytes[BLOCK + 500..]);
        assert_eq!(flow.read(&mut rest).unwrap(), 0);
    }

    #[test]
    fn a_stream_read_once_goes_nowhere_but_where_it_is() {
        let mut flow = Outflow::new(None, || Some(whole(file(100))));
        let mut buf = [0u8; 40];
        flow.read(&mut buf).unwrap();
        assert_eq!(flow.seek(0, Whence::Here), Some(40));
        assert_eq!(flow.seek(40, Whence::Start), Some(40));
        // Back to bytes that have gone, on past ones not read, from an end
        // nobody told it of: none of it.
        assert_eq!(flow.seek(0, Whence::Start), None);
        assert_eq!(flow.seek(-1, Whence::Here), None);
        assert_eq!(flow.seek(10, Whence::Here), None);
        assert_eq!(flow.seek(0, Whence::End), None);
        // And a refused seek moves nothing: the read goes on from where it was.
        assert_eq!(flow.read(&mut buf).unwrap(), 40);
        assert_eq!(buf[0], 40);
    }

    #[test]
    fn a_reader_part_way_through_can_measure_the_file_and_come_back() {
        let mut flow = Outflow::new(Some(100), || Some(whole(file(100))));
        let mut buf = [0u8; 40];
        flow.read(&mut buf).unwrap();
        assert_eq!(flow.seek(0, Whence::End), Some(100));
        assert_eq!(flow.seek(0, Whence::Here), Some(100));
        // Back to where the reading stopped — not to the start, which has gone.
        assert_eq!(flow.seek(0, Whence::Start), None);
        assert_eq!(flow.seek(40, Whence::Start), Some(40));
        assert_eq!(flow.read(&mut buf).unwrap(), 40);
        assert_eq!(buf[0], 40);
    }

    #[test]
    fn a_file_that_cannot_be_opened_fails_every_read_of_its_stream() {
        let mut flow = Outflow::new(None, || None);
        let mut buf = [0u8; 8];
        assert!(flow.read(&mut buf).is_err());
        assert!(flow.read(&mut buf).is_err());
        let mut broken = Outflow::new(None, || {
            Some(pipe(
                async { Err::<std::io::Cursor<Vec<u8>>, _>("gone".to_string()) },
                Duration::from_secs(5),
                |_, _| {},
            ))
        });
        assert!(broken.read(&mut buf).is_err());
        // Not "the file has ended" the second time round.
        assert!(broken.read(&mut buf).is_err());
    }

    /// A channel closed without the end having been said: not a whole file.
    #[test]
    fn a_download_that_breaks_off_is_not_taken_for_the_end_of_the_file() {
        let (send, blocks) = sync_channel::<Chunk>(AHEAD);
        send.send(Ok(b"half".to_vec())).unwrap();
        drop(send);
        let mut reader = RemoteReader::new(blocks, Duration::from_secs(1));
        let mut buf = [0u8; 16];
        assert_eq!(reader.read(&mut buf).unwrap(), 4);
        let error = reader.read(&mut buf).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn explorer_is_told_each_file_s_name_and_size() {
        let items = [
            OutItem {
                path: "/srv/a.conf".into(),
                name: "a.conf".into(),
                is_dir: false,
                size: Some(5 * 1024 * 1024 * 1024 + 7),
            },
            OutItem {
                path: "/srv/b".into(),
                name: "отчёт?.txt".into(),
                is_dir: false,
                size: None,
            },
        ];
        let bytes = descriptor_bytes(&items);
        assert_eq!(bytes.len(), 4 + 2 * DESCRIPTOR_SIZE);
        assert_eq!(u32::from_le_bytes(bytes[..4].try_into().unwrap()), 2);
        let field = |record: usize, at: usize| {
            let at = 4 + record * DESCRIPTOR_SIZE + at;
            u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
        };
        let name = |record: usize| {
            let at = 4 + record * DESCRIPTOR_SIZE + AT_NAME;
            let units: Vec<u16> = bytes[at..at + 520]
                .chunks(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|u| *u != 0)
                .collect();
            String::from_utf16(&units).unwrap()
        };
        // A size past 4 GiB is split across the two halves.
        assert_eq!(
            field(0, AT_FLAGS),
            FD_ATTRIBUTES | FD_PROGRESSUI | FD_UNICODE | FD_FILESIZE
        );
        assert_eq!(field(0, AT_SIZE_HIGH), 1);
        assert_eq!(field(0, AT_SIZE_LOW), 1024 * 1024 * 1024 + 7);
        assert_eq!(field(0, AT_ATTRIBUTES), FILE_ATTRIBUTE_NORMAL);
        assert_eq!(name(0), "a.conf");
        // No size known: none is claimed. A name Windows cannot have is mended.
        assert_eq!(field(1, AT_FLAGS) & FD_FILESIZE, 0);
        assert_eq!(name(1), "отчёт_.txt");
    }

    #[test]
    fn a_name_longer_than_explorer_takes_is_cut_and_still_ends() {
        let long = OutItem {
            path: "/x".into(),
            name: "я".repeat(400),
            is_dir: false,
            size: None,
        };
        let bytes = descriptor_bytes(&[long]);
        let at = 4 + AT_NAME;
        let units = bytes[at..at + 520]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|u| *u != 0)
            .count();
        assert_eq!(units, NAME_UNITS);
    }

    #[test]
    fn what_windows_cannot_have_in_a_name_is_replaced() {
        assert_eq!(windows_name("a<b>c\"d|e?f*g"), "a_b_c_d_e_f_g");
        assert_eq!(windows_name("tab\there"), "tab_here");
        assert_eq!(windows_name("plain name.tar.gz"), "plain name.tar.gz");
    }

    #[test]
    fn a_reader_let_go_of_stops_the_download() {
        let bytes = file(64 * BLOCK);
        let (said, heard) = channel();
        let mut reader = pipe(
            async move { Ok(std::io::Cursor::new(bytes)) },
            Duration::from_secs(5),
            move |moved, outcome| {
                let _ = said.send((moved, outcome));
            },
        );
        let mut buf = [0u8; 10];
        assert_eq!(reader.read(&mut buf).unwrap(), 10);
        drop(reader);
        let (moved, outcome) = heard.recv_timeout(Duration::from_secs(5)).unwrap();
        // It read ahead no further than the channel holds, and then stopped.
        assert!(moved <= ((AHEAD + 2) * BLOCK) as u64, "{moved}");
        assert!(outcome.is_err());
    }
}
