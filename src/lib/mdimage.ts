// Inline images for the markdown preview (Phase 44.4). Pure classification and
// path arithmetic — the byte-fetching lives in EditorTab, the reading itself in
// Rust (`sftp_read_bytes` / `read_local_bytes`).
//
// The preview renders `![alt](src)` only when the bytes can be turned into a
// `data:` URL, because that is the ONLY image source the app is allowed to have:
//
//   * remote `http(s)` targets — the README badges everyone starts with — cannot
//     load at all. The CSP in tauri.conf.json ends at `img-src 'self' data: asset:`
//     and the offline invariant forbids the WebView reaching the network. Widening
//     either to make shields.io render would hand every opened .md a way to phone
//     home: an `<img>` fetch is a GET with the file's own URL, so a hostile
//     document would learn when and from where it was read. A badge therefore
//     renders as the honest placeholder, not as a broken image icon.
//   * a local/remote FILE next to the document is fetched over the channel the
//     document itself came from (SFTP session or local FS) and inlined as base64.
//     That reads with rights the user already exercised by opening the file, and
//     the bytes never leave the machine.
//
// Rasters only. SVG is a document, not a bitmap: its inertness inside `<img>` is
// an engine behaviour we do not control, and no README needs it here (badges are
// remote regardless). A refused type gets the same placeholder as a remote one —
// see `classifyImage`.

import { isWindowsPath, parentOf, resolveRelative } from "./fspath";

/** Extension → MIME for the image types the preview will inline. */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/**
 * Per-image byte ceiling. Well below the editor's own open limit: a preview may
 * pull a dozen of these at once, and every one is held in memory twice (raw on the
 * Rust side, base64 — a third larger — in the WebView).
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** How many images one document may inline, so a generated .md can't fan out. */
export const MAX_IMAGES = 24;

/** A `data:` URL already spelled out in the source, restricted to our MIME set. */
const DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,[A-Za-z0-9+/=]*$/i;

/** Anything carrying a scheme, plus protocol-relative `//host/x`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * MIME for an image reference, or null when the extension is not one we inline.
 * Query and fragment are stripped first: `logo.png?v=2` is still a PNG.
 */
export function imageMime(src: string): string | null {
  const clean = src.split(/[?#]/)[0];
  const i = clean.lastIndexOf(".");
  if (i < 0) return null;
  return IMAGE_MIME[clean.slice(i + 1).toLowerCase()] ?? null;
}

/** What a markdown image target turns out to be. */
export type ImageRef =
  /** Readable file — fetch these bytes and inline them. */
  | { kind: "file"; path: string; mime: string }
  /** Already an inline `data:` image; usable as-is. */
  | { kind: "data"; url: string }
  /** Off-machine target: refused by CSP and by the offline invariant. */
  | { kind: "remote" }
  /** A local target we will not render (unknown/unsupported type, or unresolvable). */
  | { kind: "unsupported" };

/**
 * Classify one `![](src)` target for a document at `docPath`.
 *
 * The distinction that matters to the reader is `remote` vs `unsupported`: the
 * first can never work here and the second is about this particular file, and the
 * preview says so differently. Collapsing them into one "broken image" is the same
 * dishonesty as a fake connection sub-stage.
 */
export function classifyImage(docPath: string, src: string): ImageRef {
  const target = src.trim();
  if (!target) return { kind: "unsupported" };
  if (DATA_URL.test(target)) return { kind: "data", url: target };
  // `//host/x` is not a relative path, and a `data:` URL that failed the test
  // above is a type we refuse — neither is reachable, both count as off-machine.
  if (target.startsWith("//")) return { kind: "remote" };
  if (HAS_SCHEME.test(target) && !isWindowsPath(target)) return { kind: "remote" };
  const mime = imageMime(target);
  if (!mime) return { kind: "unsupported" };
  const path = resolveRelative(parentOf(docPath), target);
  return path ? { kind: "file", path, mime } : { kind: "unsupported" };
}

/** Assemble the `data:` URL the preview puts in an `<img src>`. */
export function dataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}
