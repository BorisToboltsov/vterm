// Dragging files, as the page answers it (v1.13–v1.14, ADR 0026–0027; out of
// +page.svelte in v1.25.3): out of a file panel onto a folder of another
// session's panel, a session's tab or its terminal; in from the desktop; over
// from another window; out to the system. The drag is the store's
// (`stores/filedrag`); what a drop means is the pure model's (`filedrop.ts`).
// Here: what this window's tabs make of it — and nothing happens before the
// release but drawing and opening what files are held over.
//
// A move inside a panel is that panel's question (`requestMove`); between two
// sessions a drop is always a copy, through the copy dialog. The system is asked
// to carry the files in one place (`handToSystem`), after the model said it can.

import { dragDrop, dragEnd, dragOutBegin, dragOver, localKinds } from "../api";
import { sideOf } from "../copyto";
import { dragOutBlocker, dragOutSpec, dragOutTold } from "../dragout";
import { checkMove } from "../filemove";
import {
  describeFiles,
  desktopFiles,
  dropMeaning,
  pagePoint,
  type CarriedFiles,
  type DropMeaning,
  type FileDragMessage,
  type FileTarget,
} from "../filedrop";
import { t } from "../i18n";
import { requestMove } from "../stores/filecopy.svelte";
import {
  clearGuestFiles,
  dropGuestFiles,
  fileDrag,
  onFileDrag,
  showGuestFiles,
  type Spring,
} from "../stores/filedrag.svelte";
import { hostEnv } from "../stores/hostenv.svelte";
import { revealPanel } from "../stores/layout.svelte";
import { activateTab, findTab, tabsState, type Tab } from "../stores/tabs.svelte";
import { notifyInfo } from "../stores/toasts.svelte";
import type { CdShell } from "../cdterminal";
import type { DragLook } from "../api";
import { quotePaths } from "../termcmd";
import { DISK, startTransfer } from "../transferflow";
import type { CopyFlow } from "./copyflow.svelte";

/** What the page tells the file-drag flow, each read when it is needed. */
export interface FileDragDeps {
  /** A tab's full title — the files carry it to another window. */
  title: (tab: Tab) => string;
  copy: Pick<CopyFlow, "open" | "mine">;
  /** The shell a local tab runs, for quoting paths typed into it. */
  localShell: (sessionId: string) => CdShell;
  /** Type text into a session's terminal, as a paste. */
  paste: (sessionId: string, text: string) => void;
  /** Whether another window of the app is open — the files may lie over it. */
  otherWindows: () => boolean;
  /** What the label at the pointer looks like, for the window that draws it next. */
  ghostLook: () => DragLook | null;
}

/** What the system says of a drag over the window from outside it. */
export type DesktopDragEvent =
  | { type: "enter" | "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "leave" };

export function createFileDragFlow(deps: FileDragDeps) {
  const dropTabs = $derived(
    tabsState.list.map((tab) => ({
      sessionId: tab.sessionId,
      kind: tab.kind,
      connected: tab.status.startsWith("Connected"),
    })),
  );
  /** The session whose tab or terminal the files in the air would land on. */
  const overSession = $derived(
    fileDrag.files !== null && fileDrag.over?.kind === "session" ? fileDrag.over.session : null,
  );

  /** What letting go over `target` would do — null, and it is not offered. */
  function meaningOf(files: CarriedFiles, target: FileTarget): DropMeaning | null {
    const meaning = dropMeaning(files, target, dropTabs);
    // Into the folder they are in, or a folder into itself: no move at all.
    if (meaning?.kind === "move" && !files.entries.some((e) => checkMove(e.path, meaning.dir).ok)) {
      return null;
    }
    return meaning;
  }

  /** The files, with which of them are folders — a drop from the desktop only names paths. */
  async function withKinds(files: CarriedFiles): Promise<CarriedFiles> {
    if (files.from !== null) return files;
    let kinds: boolean[] = [];
    try {
      kinds = await localKinds(files.entries.map((e) => e.path));
    } catch {
      /* unknown: each is sent as a file, and the transfer says what is wrong */
    }
    return { ...files, entries: files.entries.map((e, i) => ({ ...e, isDir: kinds[i] ?? false })) };
  }

  /** Files were let go of over a target: do what it means. */
  async function drop(files: CarriedFiles, meaning: DropMeaning) {
    switch (meaning.kind) {
      case "move":
        requestMove({ session: meaning.session, paths: files.entries.map((e) => e.path), dir: meaning.dir });
        return;
      case "copy": {
        const carried = await withKinds(files);
        void deps.copy.open(
          { from: carried.from, local: carried.local, label: carried.label, to: meaning.to, entries: carried.entries },
          meaning.dir,
        );
        return;
      }
      case "send": {
        // From the desktop into a folder a panel shows: sent at once, as a
        // drop always was — a name already there is still asked about.
        const target = deps.copy.mine.find((x) => x.sessionId === meaning.to);
        if (!target) return;
        const carried = await withKinds(files);
        void startTransfer({
          src: DISK,
          dst: sideOf(target),
          sources: carried.entries.map((e) => ({ path: e.path, isDir: e.isDir })),
          destDir: meaning.dir,
        });
        return;
      }
      case "paste": {
        // Onto a local terminal: the paths are typed into it, quoted for the
        // shell that runs there. One that cannot be written safely types nothing.
        const text = quotePaths(
          files.entries.map((e) => e.path),
          deps.localShell(meaning.to),
        );
        if (text === null) notifyInfo(t("filedrag.cannotPaste"));
        else deps.paste(meaning.to, `${text} `);
        return;
      }
    }
  }

  /** Files were held over it long enough: open it under them. */
  function spring(what: Spring) {
    if (what.kind === "files") revealPanel("files");
    else if (tabsState.activeId !== what.id) activateTab(what.id);
  }

  /** The files, named after their tab — another window has no other way to know. */
  function labelled(files: CarriedFiles): CarriedFiles {
    const from = files.from ? findTab(files.from) : null;
    return from ? { ...files, label: deps.title(from) } : files;
  }

  /** The system was asked to carry the files of this drag and would not. */
  let systemDeclined = false;

  /**
   * Files have left the window: hand the drag to the system, if it can carry
   * them (v1.14) — files of a server whose session is up, on a system that
   * knows how. Anything else stays the page's own drag, as it always was.
   */
  async function handToSystem(files: CarriedFiles): Promise<boolean> {
    systemDeclined = false;
    const mine = labelled(files);
    if (dragOutBlocker(mine, dropTabs, hostEnv.os) !== null) return false;
    const spec = dragOutSpec(mine);
    const took = spec ? await dragOutBegin(spec).catch(() => false) : false;
    // Nothing here stood in the way, and still it would not: a name it cannot
    // give a file, a folder behind a link, a file the server gives no length.
    systemDeclined = !took;
    return took;
  }

  /**
   * Files were let go of over none of the app's windows while the drag was
   * still the page's: the system was not carrying them. Where it plainly could
   * have been meant to, say why it was not — a drop that does nothing, with no
   * word, reads as a drop that was lost.
   */
  function tellNotCarried(files: CarriedFiles) {
    const why = dragOutBlocker(files, dropTabs, hostEnv.os);
    if (why === null) {
      if (systemDeclined) notifyInfo(t("dragout.declined"));
      return;
    }
    if (!dragOutTold(why)) return;
    notifyInfo(t(why === "folders" ? "dragout.foldersNotCarried" : "dragout.sessionDown"));
  }

  $effect(() => {
    onFileDrag({
      meaning: meaningOf,
      drop: (files, meaning) => void drop(labelled(files), meaning),
      spring,
      // Outside the window the files are another window's to draw, or the
      // floating label's — the same relay a tab uses. Inside it, with no other
      // window that could lie on top, the backend has nothing to add.
      over: async (files) => {
        if (!fileDrag.outside && !deps.otherWindows()) return null;
        return dragOver(describeFiles(labelled(files)), deps.ghostLook());
      },
      // Let go of out there: asked anew — the release is the gesture. The
      // window under the pointer does the rest; over none of them, nothing.
      release: (files) =>
        void dragDrop(describeFiles(labelled(files)))
          .catch(() => null)
          .then((under) => {
            if (under === null) tellNotCarried(files);
            return dragEnd().catch(() => {});
          }),
      left: () => void dragEnd().catch(() => {}),
      out: handToSystem,
    });
    return () => onFileDrag(null);
  });

  // Files the system drags in from the desktop. It names them when they enter
  // and when they are dropped; in between it only says where the pointer is.
  // A drag that names no files is not one of these — the app's own files,
  // promised to the system and passing back over a window (v1.14), arrive just
  // so: this window is told of them through the backend, and what the system
  // says of them here must not clear what the backend has it draw.
  let desktopCarried: CarriedFiles | null = null;

  return {
    /** The session whose tab or terminal the files in the air would land on. */
    get overSession() {
      return overSession;
    },

    /** Files of another window, held over this one or let go of here. */
    heardOtherWindow(msg: FileDragMessage) {
      if (msg.kind === "leave") clearGuestFiles();
      else if (msg.kind === "over") showGuestFiles(msg.files, msg.x, msg.y);
      else dropGuestFiles(msg.files, msg.x, msg.y);
    },

    /** What the system says of files dragged over the window from the desktop. */
    heardDesktop(ev: DesktopDragEvent) {
      const named = desktopCarried !== null;
      if (ev.type === "leave") {
        desktopCarried = null;
        if (named) clearGuestFiles();
        return;
      }
      // The system speaks in physical pixels; the targets are found in the page's.
      const at = pagePoint(ev.position, window.devicePixelRatio);
      if (ev.type === "enter") desktopCarried = ev.paths.length > 0 ? desktopFiles(ev.paths) : null;
      if (ev.type === "drop") {
        desktopCarried = null;
        if (ev.paths.length > 0) dropGuestFiles(desktopFiles(ev.paths), at.x, at.y);
        else if (named) clearGuestFiles();
        return;
      }
      if (desktopCarried) showGuestFiles(desktopCarried, at.x, at.y);
    },
  };
}

export type FileDragFlow = ReturnType<typeof createFileDragFlow>;
