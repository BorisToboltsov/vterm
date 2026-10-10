//! The system's drag on macOS: files of a server, promised to whoever takes
//! them (`NSFilePromiseProvider`).
//!
//! One object is both the source of the dragging session and the delegate of
//! every promise in it. As the source it is told where the pointer is and where
//! it was let go of — and says so to the app's windows, which draw the files
//! and take a drop that lands on one of them. As the delegate it is asked, once
//! something outside the app has accepted the drop, what each file is called
//! and — given the URL to write it to — fetches it.
//!
//! Everything here runs on the main thread: AppKit calls the source there, and
//! the promises are asked to be written there too (`operationQueue…`). Writing
//! only starts a job and returns; the completion block is called back on the
//! main thread when the job has ended.

use super::{OutItem, OutSpec};
use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource,
    NSEvent, NSEventModifierFlags, NSEventType, NSFilePromiseProvider,
    NSFilePromiseProviderDelegate, NSImage, NSWindow, NSWorkspace,
};
use objc2_foundation::{
    NSArray, NSError, NSObject, NSObjectProtocol, NSOperationQueue, NSPoint, NSProcessInfo, NSRect,
    NSSize, NSString, NSURL,
};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use tauri::{AppHandle, WebviewWindow};

/// The pointer's place is passed on to the app's windows no more often.
const TELL_EVERY: Duration = Duration::from_millis(30);

/// Side of the picture each file gets in the drag, pt.
const ICON: f64 = 32.0;

pub struct Ivars {
    app: AppHandle,
    /// Label of the window the drag began in.
    source: String,
    spec: OutSpec,
    /// Each promise, and the file it stands for.
    promises: RefCell<Vec<(Retained<NSFilePromiseProvider>, OutItem)>>,
    told: Cell<Instant>,
}

define_class!(
    // SAFETY:
    // - `NSObject` has no subclassing requirements.
    // - `Source` does not implement `Drop`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VtermDragOutSource"]
    #[ivars = Ivars]
    pub struct Source;

    unsafe impl NSObjectProtocol for Source {}

    unsafe impl NSDraggingSource for Source {
        /// Whatever takes the files gets a copy: the file stays on its server.
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn operation_mask(
            &self,
            _session: &NSDraggingSession,
            _context: NSDraggingContext,
        ) -> NSDragOperation {
            NSDragOperation::Copy
        }

        #[unsafe(method(draggingSession:movedToPoint:))]
        fn moved(&self, session: &NSDraggingSession, _screen_point: NSPoint) {
            let ivars = self.ivars();
            if ivars.told.get().elapsed() < TELL_EVERY {
                return;
            }
            ivars.told.set(Instant::now());
            let over_app =
                crate::appwin::system_drag_moved(&ivars.app, &ivars.source, &ivars.spec.carried);
            // Files that fly back to where they came from say "nobody took
            // them". Over a window of the app that would be a lie: the window
            // takes them itself, by its own rules, a moment later.
            session.setAnimatesToStartingPositionsOnCancelOrFail(!over_app);
        }

        /// The session is over. With no operation nobody took the files — Esc,
        /// or a place that takes nothing. Otherwise: over a window of the app
        /// they are that window's now (it asks where they go, as for any drop);
        /// anywhere else nothing is done here — what took them asks for each
        /// promise.
        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(
            &self,
            _session: &NSDraggingSession,
            _screen_point: NSPoint,
            operation: NSDragOperation,
        ) {
            let ivars = self.ivars();
            if operation == NSDragOperation::None {
                crate::appwin::system_drag_cancelled(&ivars.app, &ivars.source);
            } else {
                crate::appwin::system_drag_ended(&ivars.app, &ivars.source, &ivars.spec.carried);
            }
        }
    }

    unsafe impl NSFilePromiseProviderDelegate for Source {
        #[unsafe(method_id(filePromiseProvider:fileNameForType:))]
        fn file_name(
            &self,
            provider: &NSFilePromiseProvider,
            _file_type: &NSString,
        ) -> Retained<NSString> {
            // A name that could not be given to a file here was never promised
            // (`dragout::promised`); a promise this object does not know of is
            // not one of its own.
            let name = self
                .item_of(provider)
                .map(|item| item.name)
                .unwrap_or_default();
            NSString::from_str(&name)
        }

        #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
        fn write(
            &self,
            provider: &NSFilePromiseProvider,
            url: &NSURL,
            completion: &DynBlock<dyn Fn(*mut NSError)>,
        ) {
            let ivars = self.ivars();
            let dest = url.path().map(|path| path.to_string());
            let (Some(item), Some(dest)) = (self.item_of(provider), dest) else {
                completion.call((Retained::as_ptr(&failure()) as *mut NSError,));
                return;
            };
            let done = Done(completion.copy());
            let (app, origin, spec) = (ivars.app.clone(), ivars.source.clone(), ivars.spec.clone());
            tauri::async_runtime::spawn(async move {
                let fetched = super::fetch(&app, &origin, &spec, &item, &dest).await;
                // The block is AppKit's: it is called where it was given.
                let _ = app.run_on_main_thread(move || done.call(fetched.is_ok()));
            });
        }

        /// Promises are asked for on the main thread — where this object lives.
        #[unsafe(method_id(operationQueueForFilePromiseProvider:))]
        fn queue(&self, _provider: &NSFilePromiseProvider) -> Retained<NSOperationQueue> {
            NSOperationQueue::mainQueue()
        }
    }
);

impl Source {
    fn new(mtm: MainThreadMarker, ivars: Ivars) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ivars);
        // SAFETY: `NSObject`'s `init`, on a freshly allocated object.
        unsafe { msg_send![super(this), init] }
    }

    /// The file a promise stands for.
    fn item_of(&self, provider: &NSFilePromiseProvider) -> Option<OutItem> {
        self.ivars()
            .promises
            .borrow()
            .iter()
            .find(|(known, _)| std::ptr::eq(Retained::as_ptr(known), provider))
            .map(|(_, item)| item.clone())
    }
}

/// The completion block of a promise, carried to the task that fetches the
/// file and back.
struct Done(RcBlock<dyn Fn(*mut NSError)>);

// SAFETY: the block is only ever called on the main thread — it is moved into
// the fetching task as a whole and handed straight back to `run_on_main_thread`.
unsafe impl Send for Done {}

impl Done {
    fn call(self, ok: bool) {
        if ok {
            self.0.call((std::ptr::null_mut(),));
        } else {
            self.0.call((Retained::as_ptr(&failure()) as *mut NSError,));
        }
    }
}

/// "The file is not there." What went wrong is said in the app, by the job.
fn failure() -> Retained<NSError> {
    let domain = NSString::from_str("su.vcore.vterm.dragout");
    // SAFETY: a domain, a code and no user info — nothing to get wrong.
    unsafe { NSError::errorWithDomain_code_userInfo(&domain, 1, None) }
}

/// The picture of a file in the drag: the system's own for its kind.
#[allow(deprecated)] // `iconForFileType:` takes a bare extension; its successor needs a type.
fn icon(item: &OutItem) -> Retained<NSImage> {
    let workspace = NSWorkspace::sharedWorkspace();
    if item.is_dir {
        // The icon of a folder that is certainly there — a folder's.
        return workspace.iconForFile(&NSString::from_str("/usr"));
    }
    let extension = std::path::Path::new(&item.name)
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    workspace.iconForFileType(&NSString::from_str(&extension))
}

thread_local! {
    // The sources of the last few drags. A promise holds its delegate weakly,
    // and whatever took the files asks for them after the session has ended —
    // so the source has to outlive it, by how long nobody says.
    static LIVE: RefCell<VecDeque<Retained<Source>>> = const { RefCell::new(VecDeque::new()) };
}
const KEPT: usize = 4;

/// Begin the system's drag of `spec` from `window`. False — it was not begun:
/// the button is up, or the window is gone.
pub fn begin(app: &AppHandle, window: &WebviewWindow, spec: OutSpec) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    // The button has to be down still. The page asked a moment ago; a session
    // begun after it was let go of is one nothing would ever end.
    if NSEvent::pressedMouseButtons() & 1 == 0 {
        return false;
    }
    let Ok(ptr) = window.ns_window() else {
        return false;
    };
    // SAFETY: the pointer is the NSWindow of a window Tauri keeps alive; we are
    // on the main thread (the marker above).
    let Some(ns_window) = (unsafe { ptr.cast::<NSWindow>().as_ref() }) else {
        return false;
    };
    let Some(view) = ns_window.contentView() else {
        return false;
    };
    // A session begins from a mouse event. The one being handled right now is
    // whatever the app was doing when the page's call arrived — so one is made:
    // "dragged, here, now", in this window.
    let at = ns_window.convertPointFromScreen(NSEvent::mouseLocation());
    let Some(event) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDragged,
        at,
        NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(),
        ns_window.windowNumber(),
        None,
        0,
        1,
        1.0,
    ) else {
        return false;
    };

    let source = Source::new(
        mtm,
        Ivars {
            app: app.clone(),
            source: window.label().to_string(),
            spec: spec.clone(),
            promises: RefCell::new(Vec::new()),
            told: Cell::new(Instant::now()),
        },
    );
    let delegate = ProtocolObject::<dyn NSFilePromiseProviderDelegate>::from_ref(&*source);
    let in_view = view.convertPoint_fromView(at, None);
    let mut items: Vec<Retained<NSDraggingItem>> = Vec::with_capacity(spec.items.len());
    let mut promises = Vec::with_capacity(spec.items.len());
    for (i, item) in spec.items.iter().enumerate() {
        let kind = NSString::from_str(if item.is_dir {
            "public.folder"
        } else {
            "public.data"
        });
        let provider = NSFilePromiseProvider::initWithFileType_delegate(
            NSFilePromiseProvider::alloc(),
            &kind,
            delegate,
        );
        let dragged = NSDraggingItem::initWithPasteboardWriter(
            NSDraggingItem::alloc(),
            ProtocolObject::from_ref(&*provider),
        );
        // Under the pointer, each next file a step behind the one before.
        let step = (i.min(4) as f64) * 3.0;
        let frame = NSRect::new(
            NSPoint::new(in_view.x - ICON / 2.0 + step, in_view.y - ICON / 2.0 - step),
            NSSize::new(ICON, ICON),
        );
        let picture = icon(item);
        let picture: &AnyObject = picture.as_ref();
        // SAFETY: the contents of a dragging frame may be an `NSImage`.
        unsafe { dragged.setDraggingFrame_contents(frame, Some(picture)) };
        items.push(dragged);
        promises.push((provider, item.clone()));
    }
    source.ivars().promises.replace(promises);

    let _session = view.beginDraggingSessionWithItems_event_source(
        &NSArray::from_retained_slice(&items),
        &event,
        ProtocolObject::<dyn NSDraggingSource>::from_ref(&*source),
    );
    LIVE.with(|live| {
        let mut live = live.borrow_mut();
        live.push_back(source);
        while live.len() > KEPT {
            live.pop_front();
        }
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::AnyProtocol;
    use objc2::{sel, ClassType};

    /// The class is put together when it is first asked for — and in a debug
    /// build that is where a method whose types do not match the protocol it
    /// claims to implement is refused. A drag cannot be begun in a test (it
    /// takes a window and a pressed button), but this much of it can be shown
    /// to hold: the object the system will call answers what it will be asked.
    #[test]
    fn the_drag_source_answers_what_the_system_asks_of_it() {
        let class = Source::class();
        for selector in [
            sel!(draggingSession:sourceOperationMaskForDraggingContext:),
            sel!(draggingSession:movedToPoint:),
            sel!(draggingSession:endedAtPoint:operation:),
            sel!(filePromiseProvider:fileNameForType:),
            sel!(filePromiseProvider:writePromiseToURL:completionHandler:),
            sel!(operationQueueForFilePromiseProvider:),
        ] {
            assert!(
                class.instance_method(selector).is_some(),
                "the drag source does not answer {selector:?}"
            );
        }
        for protocol in [c"NSDraggingSource", c"NSFilePromiseProviderDelegate"] {
            let protocol = AnyProtocol::get(protocol).expect("the protocol is AppKit's");
            assert!(class.conforms_to(protocol), "not a {protocol:?}");
        }
    }
}
