//! The system's drag on Windows: files of a server, offered as streams
//! (`FILEDESCRIPTOR` + `FILECONTENTS`).
//!
//! Three COM objects, each as thin as it can be made — what they do is in
//! `feed.rs`, which is compiled and tested on every machine:
//!
//!  - the **data object** says which files are dragged (a descriptor laid out
//!    by `descriptor_bytes`) and hands out a stream for each;
//!  - the **stream** is one file, read as it arrives from the server
//!    (`Outflow`);
//!  - the **drop source** is asked, as the pointer moves, whether the drag goes
//!    on — and tells the app's windows where the pointer is.
//!
//! `DoDragDrop` does not return until the button is let go of: it runs a loop
//! of its own on this thread, the one that owns the windows. So the page is
//! answered *before* it is called, and what the end of the drag means for the
//! app is settled after it returns.
//!
//! Whatever took the files reads them after the drop, from a thread of its own
//! (the data object says it may: `IDataObjectAsyncCapability`). But a call into
//! an object made on this thread is still carried out *on this thread* — and a
//! read waits for the server. So each stream is made in the process's
//! multithreaded apartment, where calls from another program arrive on threads
//! COM keeps for the purpose: the window goes on answering while a file comes
//! down.

use super::feed::{descriptor_bytes, Feed, Outflow, Whence};
use std::cell::Cell;
use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use windows::core::{implement, Interface, Ref, Result, BOOL, HRESULT};
use windows::Win32::Foundation::{
    GlobalFree, DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP,
    DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, DV_E_LINDEX, E_NOTIMPL, E_OUTOFMEMORY, E_POINTER,
    OLE_E_ADVISENOTSUPPORTED, STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION, STG_E_INVALIDPOINTER,
    STG_E_READFAULT, STG_E_WRITEFAULT, S_FALSE, S_OK,
};
use windows::Win32::System::Com::Marshal::CoMarshalInterThreadInterfaceInStream;
use windows::Win32::System::Com::StructuredStorage::CoGetInterfaceAndReleaseStream;
use windows::Win32::System::Com::{
    CoIncrementMTAUsage, CoInitializeEx, CoUninitialize, IAdviseSink, IBindCtx, IDataObject,
    IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, ISequentialStream_Impl, IStream, IStream_Impl,
    COINIT_MULTITHREADED, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, LOCKTYPE, STATFLAG, STATSTG,
    STGC, STGMEDIUM, STGMEDIUM_0, STGM_READ, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR,
    STREAM_SEEK_SET, TYMED_HGLOBAL, TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::Shell::{
    IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl, SHCreateStdEnumFmtEtc,
    CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, LoadCursorW, SetCursor, IDC_ARROW, SM_SWAPBUTTON,
};

/// The pointer's place is passed on to the app's windows no more often.
const TELL_EVERY: Duration = Duration::from_millis(30);

/// One step of a stream copied by its own `CopyTo`.
const COPY_BLOCK: usize = 64 * 1024;

/// A stream made off this thread is waited for no longer than this.
const MADE_WITHIN: Duration = Duration::from_secs(2);

/// The two formats a dragged file is offered in, as this session of Windows
/// numbers them.
#[derive(Clone, Copy)]
struct Formats {
    descriptor: u16,
    contents: u16,
}

impl Formats {
    fn register() -> Option<Self> {
        // SAFETY: both names are constants of the system's own headers.
        let (descriptor, contents) = unsafe {
            (
                RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW),
                RegisterClipboardFormatW(CFSTR_FILECONTENTS),
            )
        };
        // A registered format is a number in 0xC000..=0xFFFF; zero — it failed.
        match (u16::try_from(descriptor), u16::try_from(contents)) {
            (Ok(descriptor), Ok(contents)) if descriptor != 0 && contents != 0 => Some(Self {
                descriptor,
                contents,
            }),
            _ => None,
        }
    }

    /// What `EnumFormatEtc` lists: the descriptor in a memory block, the
    /// contents as a stream.
    fn offered(self) -> [FORMATETC; 2] {
        let of = |format: u16, medium: u32| FORMATETC {
            cfFormat: format,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: medium,
        };
        [
            of(self.descriptor, TYMED_HGLOBAL.0 as u32),
            of(self.contents, TYMED_ISTREAM.0 as u32),
        ]
    }
}

/// What a caller of the data object asked for.
enum Asked {
    Descriptor,
    /// The contents of the file at this index; negative — "all there is".
    Contents(i32),
}

/// The files of a drag, as another program sees them.
#[implement(IDataObject, IDataObjectAsyncCapability)]
struct DataObject {
    feed: Arc<Feed>,
    formats: Formats,
    descriptor: Vec<u8>,
    /// Whether what took the files may read them after the drop has returned.
    asynchronous: Cell<bool>,
    in_operation: Cell<bool>,
}

impl DataObject {
    fn asked(&self, format: *const FORMATETC) -> Result<Asked> {
        // SAFETY: the caller's pointer, read only if it is one.
        let format = unsafe { format.as_ref() }.ok_or(E_POINTER)?;
        if format.dwAspect != DVASPECT_CONTENT.0 {
            return Err(DV_E_FORMATETC.into());
        }
        if format.cfFormat == self.formats.descriptor && format.tymed & TYMED_HGLOBAL.0 as u32 != 0
        {
            return Ok(Asked::Descriptor);
        }
        if format.cfFormat == self.formats.contents && format.tymed & TYMED_ISTREAM.0 as u32 != 0 {
            return Ok(Asked::Contents(format.lindex));
        }
        Err(DV_E_FORMATETC.into())
    }

    /// Which file an index of the contents format names.
    fn index(&self, lindex: i32) -> Result<usize> {
        let count = self.feed.items().len();
        match usize::try_from(lindex) {
            Ok(index) if index < count => Ok(index),
            // "All there is" is the one file, when there is one.
            Err(_) if count == 1 => Ok(0),
            _ => Err(DV_E_LINDEX.into()),
        }
    }
}

impl IDataObject_Impl for DataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> Result<STGMEDIUM> {
        match self.asked(pformatetcin)? {
            Asked::Descriptor => memory_block(&self.descriptor),
            Asked::Contents(lindex) => {
                let stream = stream_of(&self.feed, self.index(lindex)?)?;
                Ok(STGMEDIUM {
                    tymed: TYMED_ISTREAM.0 as u32,
                    u: STGMEDIUM_0 {
                        pstm: ManuallyDrop::new(Some(stream)),
                    },
                    pUnkForRelease: ManuallyDrop::new(None),
                })
            }
        }
    }

    fn GetDataHere(&self, _pformatetc: *const FORMATETC, _pmedium: *mut STGMEDIUM) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        match self.asked(pformatetc) {
            Ok(_) => S_OK,
            Err(error) => error.code(),
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        pformatectin: *const FORMATETC,
        pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        // SAFETY: the caller's pointers, used only if they are ones.
        unsafe {
            if let (Some(given), Some(out)) = (pformatectin.as_ref(), pformatetcout.as_mut()) {
                *out = *given;
                out.ptd = std::ptr::null_mut();
            }
        }
        DATA_S_SAMEFORMATETC
    }

    /// Nothing is taken in: the object is what is on the server, and whoever
    /// wants to leave a note on it (the shell does) is told no.
    fn SetData(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *const STGMEDIUM,
        _frelease: BOOL,
    ) -> Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> Result<IEnumFORMATETC> {
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        // SAFETY: a plain array of plain structures, copied by the callee.
        unsafe { SHCreateStdEnumFmtEtc(&self.formats.offered()) }
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: Ref<'_, IAdviseSink>,
    ) -> Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _dwconnection: u32) -> Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

impl IDataObjectAsyncCapability_Impl for DataObject_Impl {
    fn SetAsyncMode(&self, fdoopasync: BOOL) -> Result<()> {
        self.asynchronous.set(fdoopasync.as_bool());
        Ok(())
    }

    fn GetAsyncMode(&self) -> Result<BOOL> {
        Ok(self.asynchronous.get().into())
    }

    fn StartOperation(&self, _pbcreserved: Ref<'_, IBindCtx>) -> Result<()> {
        self.in_operation.set(true);
        Ok(())
    }

    fn InOperation(&self) -> Result<BOOL> {
        Ok(self.in_operation.get().into())
    }

    fn EndOperation(
        &self,
        _hresult: HRESULT,
        _pbcreserved: Ref<'_, IBindCtx>,
        _dweffects: u32,
    ) -> Result<()> {
        self.in_operation.set(false);
        Ok(())
    }
}

/// `bytes` in a movable memory block — which whoever asked for it frees.
fn memory_block(bytes: &[u8]) -> Result<STGMEDIUM> {
    // SAFETY: the block is as long as what is copied into it, and is written
    // only while locked.
    unsafe {
        let block = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
        let at = GlobalLock(block);
        if at.is_null() {
            let _ = GlobalFree(Some(block));
            return Err(E_OUTOFMEMORY.into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), at.cast::<u8>(), bytes.len());
        // "No longer locked" is reported the way a failure is; it is not one.
        let _ = GlobalUnlock(block);
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: block },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }
}

/// One file of a server as a stream: read once, front to back.
#[implement(IStream)]
struct RemoteStream {
    /// Calls arrive on whichever thread COM has free; one at a time gets in.
    flow: Mutex<Outflow>,
}

impl RemoteStream {
    fn new(flow: Outflow) -> Self {
        Self {
            flow: Mutex::new(flow),
        }
    }

    fn flow(&self) -> MutexGuard<'_, Outflow> {
        // A read that panicked has not made the next one wrong.
        self.flow.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl ISequentialStream_Impl for RemoteStream_Impl {
    fn Read(&self, pv: *mut c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if pv.is_null() {
            return STG_E_INVALIDPOINTER;
        }
        // SAFETY: the caller's buffer, `cb` bytes long by the contract of `Read`.
        let out = unsafe { std::slice::from_raw_parts_mut(pv.cast::<u8>(), cb as usize) };
        let (read, outcome) = match self.flow().read(out) {
            Ok(read) if read == out.len() => (read, S_OK),
            // Fewer than asked for: the file has ended.
            Ok(read) => (read, S_FALSE),
            // Never "no more bytes": a cut-off file would pass for a whole one.
            Err(_) => (0, STG_E_READFAULT),
        };
        // SAFETY: the caller's pointer, written only if it is one.
        if let Some(count) = unsafe { pcbread.as_mut() } {
            *count = read as u32;
        }
        outcome
    }

    fn Write(&self, _pv: *const c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
        STG_E_ACCESSDENIED
    }
}

impl IStream_Impl for RemoteStream_Impl {
    fn Seek(&self, dlibmove: i64, dworigin: STREAM_SEEK, plibnewposition: *mut u64) -> Result<()> {
        let whence = if dworigin == STREAM_SEEK_SET {
            Whence::Start
        } else if dworigin == STREAM_SEEK_CUR {
            Whence::Here
        } else {
            Whence::End
        };
        let at = self
            .flow()
            .seek(dlibmove, whence)
            .ok_or(STG_E_INVALIDFUNCTION)?;
        // SAFETY: the caller's pointer, written only if it is one.
        if let Some(position) = unsafe { plibnewposition.as_mut() } {
            *position = at;
        }
        Ok(())
    }

    fn SetSize(&self, _libnewsize: u64) -> Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }

    fn CopyTo(
        &self,
        pstm: Ref<'_, IStream>,
        cb: u64,
        pcbread: *mut u64,
        pcbwritten: *mut u64,
    ) -> Result<()> {
        let to = pstm.ok()?;
        let mut flow = self.flow();
        let mut block = vec![0u8; COPY_BLOCK];
        let (mut read, mut written) = (0u64, 0u64);
        let mut outcome = Ok(());
        while read < cb {
            let want = (cb - read).min(block.len() as u64) as usize;
            let got = match flow.read(&mut block[..want]) {
                Ok(got) => got,
                Err(_) => {
                    outcome = Err(STG_E_READFAULT.into());
                    break;
                }
            };
            if got == 0 {
                break;
            }
            read += got as u64;
            let mut put = 0u32;
            // SAFETY: `got` bytes of a buffer this function owns.
            let wrote = unsafe { to.Write(block.as_ptr().cast(), got as u32, Some(&mut put)) };
            written += u64::from(put);
            if wrote.is_err() || put as usize != got {
                outcome = Err(STG_E_WRITEFAULT.into());
                break;
            }
            if got < want {
                break;
            }
        }
        // SAFETY: the caller's pointers, written only if they are ones.
        unsafe {
            if let Some(count) = pcbread.as_mut() {
                *count = read;
            }
            if let Some(count) = pcbwritten.as_mut() {
                *count = written;
            }
        }
        outcome
    }

    fn Commit(&self, _grfcommitflags: &STGC) -> Result<()> {
        Ok(())
    }

    fn Revert(&self) -> Result<()> {
        Ok(())
    }

    fn LockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: &LOCKTYPE) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn Stat(&self, pstatstg: *mut STATSTG, _grfstatflag: &STATFLAG) -> Result<()> {
        // SAFETY: the caller's pointer, written only if it is one.
        let stat = unsafe { pstatstg.as_mut() }.ok_or(E_POINTER)?;
        // No name: there is none to give that the caller would have to free.
        *stat = STATSTG {
            r#type: STGTY_STREAM.0 as u32,
            cbSize: self.flow().size().unwrap_or(0),
            grfMode: STGM_READ,
            ..Default::default()
        };
        Ok(())
    }

    fn Clone(&self) -> Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

/// A reference to a stream, carried from the thread that made it to this one.
struct Carried(IStream);

// SAFETY: what is carried is not the stream but the system's own packet for
// passing one between threads (`CoMarshalInterThreadInterfaceInStream`), which
// is made to be handed to another thread — and is used there exactly once.
unsafe impl Send for Carried {}

/// Whether the process's multithreaded apartment is kept alive: asked for once,
/// and never given back — streams made in it are read long after the thread
/// that made them is gone.
fn apartment_kept() -> bool {
    static KEPT: OnceLock<bool> = OnceLock::new();
    // SAFETY: no arguments; the cookie it returns is deliberately never spent.
    *KEPT.get_or_init(|| unsafe { CoIncrementMTAUsage() }.is_ok())
}

/// Make `stream` where calls into it do not come to this thread, and bring a
/// reference to it back. `None` — it could not be done; nothing was made.
fn made_elsewhere(stream: RemoteStream) -> Option<IStream> {
    if !apartment_kept() {
        return None;
    }
    let (said, heard) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("vterm-dragout".into())
        .spawn(move || {
            // SAFETY: a thread of our own joins the multithreaded apartment,
            // makes the object there, packs a reference to it for another
            // thread and leaves; the apartment — and the object — stay
            // (`apartment_kept`).
            let carried = unsafe {
                let joined = CoInitializeEx(None, COINIT_MULTITHREADED);
                let made: IStream = stream.into();
                let carried = CoMarshalInterThreadInterfaceInStream(&IStream::IID, &made)
                    .ok()
                    .map(Carried);
                drop(made);
                if joined.is_ok() {
                    CoUninitialize();
                }
                carried
            };
            let _ = said.send(carried);
        })
        .ok()?;
    let carried = heard.recv_timeout(MADE_WITHIN).ok()??;
    // SAFETY: the packet made above, unpacked once, on the thread it was for.
    unsafe { CoGetInterfaceAndReleaseStream(&carried.0) }.ok()
}

/// The stream for the file at `index`.
fn stream_of(feed: &Arc<Feed>, index: usize) -> Result<IStream> {
    let stream = || feed.outflow(index).map(RemoteStream::new);
    if let Some(made) = stream().and_then(made_elsewhere) {
        return Ok(made);
    }
    // Made here it is read here, and the window waits for the server with it:
    // slower to answer — but the file still arrives.
    stream().map(Into::into).ok_or_else(|| DV_E_LINDEX.into())
}

/// The side of the drag that is asked whether it goes on.
#[implement(IDropSource)]
struct DropSource {
    feed: Arc<Feed>,
    told: Cell<Instant>,
    /// Whether the pointer was over a window of the app when last told.
    over_app: Cell<bool>,
    /// Set when the button was let go of — as against Esc.
    let_go: Rc<Cell<bool>>,
}

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        if grfkeystate.0 & MK_LBUTTON.0 == 0 {
            self.let_go.set(true);
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        if self.told.get().elapsed() >= TELL_EVERY {
            self.told.set(Instant::now());
            self.over_app.set(self.feed.moved());
        }
        if !self.over_app.get() {
            return DRAGDROP_S_USEDEFAULTCURSORS;
        }
        // Over a window of the app the system would show "not here": the
        // window is no taker of streams. It takes the files by its own rules
        // and draws them itself — the pointer stays a pointer.
        // SAFETY: a cursor of the system's own, set for this thread.
        unsafe {
            if let Ok(arrow) = LoadCursorW(None, IDC_ARROW) {
                SetCursor(Some(arrow));
            }
        }
        S_OK
    }
}

/// Whether the button a drag is made with is down. With the buttons swapped
/// that is the right one: this asks the mouse, not what the system calls it.
fn button_down() -> bool {
    // SAFETY: two reads of the system's state, no arguments to get wrong.
    unsafe {
        let primary = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
            VK_RBUTTON
        } else {
            VK_LBUTTON
        };
        GetAsyncKeyState(i32::from(primary.0)) < 0
    }
}

/// Begin the system's drag of the files of `feed`, on the thread that owns the
/// windows. `answer` hears whether it was begun — before the drag is over:
/// this function returns only when it is.
pub fn begin(feed: Arc<Feed>, answer: impl FnOnce(bool)) {
    // The button has to be down still. The page asked a moment ago; a drag
    // begun after it was let go of would wait for a click to end it.
    let formats = if button_down() {
        Formats::register()
    } else {
        None
    };
    let Some(formats) = formats else {
        answer(false);
        return;
    };
    let let_go = Rc::new(Cell::new(false));
    let data: IDataObject = DataObject {
        descriptor: descriptor_bytes(feed.items()),
        feed: feed.clone(),
        formats,
        // After the drop, on a thread of the taker's — not inside it, with
        // this thread waiting.
        asynchronous: Cell::new(true),
        in_operation: Cell::new(false),
    }
    .into();
    let source: IDropSource = DropSource {
        feed: feed.clone(),
        told: Cell::new(Instant::now()),
        over_app: Cell::new(false),
        let_go: let_go.clone(),
    }
    .into();
    answer(true);
    let mut effect = DROPEFFECT_NONE;
    // SAFETY: both objects outlive the call; OLE is initialised on this thread
    // by the windowing library, which registers the windows' own drop targets.
    let _ = unsafe { DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect) };
    // Let go of over a window of the app, the files are that window's: it is
    // no taker of streams, so the system has told it nothing — the app does.
    if let_go.get() {
        feed.ended();
    } else {
        feed.cancelled();
    }
}
