// Starting a transfer (v1.12): the one path from "the user asked for these files
// to go there" to a job of the backend. Whoever asks — the SFTP panel's upload
// and drop, its download, "copy to another session" — comes through here, so the
// rule of v1.11.3 holds for all of them: nothing replaces a file without leave.
//
//  1. The destination is asked which names it holds (not a panel's listing —
//     that may be minutes old).
//  2. If some are taken — or the folder could not be read — the user is asked
//     once for the whole batch.
//  3. The job is started with leave to replace only what was asked about; the
//     backend refuses anything else that turned out to be taken.
//
// Nothing here waits for the transfer: `startTransfer` resolves when the backend
// has taken the job. Its progress, its end and what went wrong arrive as events
// (`stores/transfers`).

import {
  localList,
  sftpList,
  transferStart,
  type TransferItem,
  type TransferSide,
} from "./api";
import { checkUpload, uploadItems, type UploadCheck } from "./filebrowser";
import { baseName, joinPath } from "./fspath";
import { askReplace } from "./stores/replaceask.svelte";
import { notifyError } from "./stores/toasts.svelte";

/** A side that is this machine, named outside any tab. */
export const DISK: TransferSide = { session: null, local: true, label: "" };

export interface TransferSource {
  path: string;
  isDir: boolean;
  /** Where exactly it lands, when that is not `destDir` + its own name (a save dialog named the file). */
  to?: string;
}

export interface TransferRequest {
  src: TransferSide;
  dst: TransferSide;
  sources: TransferSource[];
  /** The folder the files land in. */
  destDir: string;
  /**
   * Replacing was agreed elsewhere — the system's save dialog asked. The
   * destination is not listed and no question is put.
   */
  agreed?: boolean;
}

/** `dir`/`name` on the destination: POSIX on a server, native on this machine. */
export function destPath(destDir: string, name: string, local: boolean): string {
  return local ? joinPath(destDir, name) : `${destDir}/${name}`.replace(/\/+/g, "/");
}

/** The names the destination folder holds, or null when it cannot be read. */
async function namesIn(dst: TransferSide, dir: string): Promise<string[] | null> {
  try {
    const entries = dst.local || !dst.session ? await localList(dir) : await sftpList(dst.session, dir);
    return entries.map((e) => e.name);
  } catch {
    return null;
  }
}

/**
 * Start the transfer `req` describes. Resolves with the job's id, or null when
 * nothing was started: the user said no, every name was taken and skipped, or
 * the backend refused the job (said in a toast).
 */
export async function startTransfer(req: TransferRequest): Promise<string | null> {
  if (req.sources.length === 0) return null;
  const paths = req.sources.map((s) => s.path);
  let items: TransferItem[];
  if (req.agreed) {
    items = req.sources.map((s) => ({
      from: s.path,
      to: s.to ?? destPath(req.destDir, baseName(s.path), req.dst.local),
      isDir: s.isDir,
      replace: true,
    }));
  } else {
    const names = await namesIn(req.dst, req.destDir);
    const check: UploadCheck | null = names === null ? null : checkUpload(paths, names);
    // Nothing taken — nothing to ask: every name is free, and none may replace.
    const ask = check === null || check.clash.length > 0;
    const go = uploadItems(paths, check, ask ? await askReplace(req.destDir, check) : "skip");
    const dirs = new Map(req.sources.map((s) => [s.path, s] as const));
    items = go.map(({ path, replace }) => ({
      from: path,
      to: dirs.get(path)?.to ?? destPath(req.destDir, baseName(path), req.dst.local),
      isDir: dirs.get(path)?.isDir ?? false,
      replace,
    }));
  }
  if (items.length === 0) return null;
  try {
    return await transferStart({
      id: crypto.randomUUID(),
      src: req.src,
      dst: req.dst,
      items,
      destDir: req.destDir,
    });
  } catch (e) {
    notifyError(String(e));
    return null;
  }
}
