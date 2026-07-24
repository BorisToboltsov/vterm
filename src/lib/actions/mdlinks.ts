// Click interception for `{@html renderMarkdown(…)}` output (Phase 44.3).
//
// Lifted out of HelpPanel, where it guarded the one caller whose input was already
// trusted, while the four callers rendering untrusted markdown (AiChat,
// RecordingsPanel, EditorTab, NotesModal) had no interception at all. Any surface
// that mounts rendered markdown MUST apply this action — enforced by
// mdlink.guard.test.ts.
//
// Two things must never happen when a link inside rendered markdown is clicked:
//   * the WebView navigating anywhere. The window has no URL bar, so a page loaded
//     in place is indistinguishable from the app itself — a phishing surface handed
//     to whoever wrote the markdown. `preventDefault()` is therefore unconditional,
//     before any decision about the target.
//   * a non-http(s) scheme reaching the OS. `markdown.ts:safeUrl` already refuses
//     those at render time; re-checking here keeps the two halves independent, so
//     neither silently becomes the only thing standing between a `javascript:` URL
//     and `invoke()`.
//
// Middle-click and ⌘/Ctrl-click are swallowed too: both open a target bypassing the
// plain-click path, and "open in new window" for a WebView means a new WebView.

import { openUrl } from "@tauri-apps/plugin-opener";

const HTTP = /^https?:\/\//i;
const MAILTO = /^mailto:/i;

function handle(e: MouseEvent) {
  const a = (e.target as HTMLElement | null)?.closest?.("a[data-md-link]") as
    | HTMLAnchorElement
    | null;
  if (!a) return;
  // Unconditional: even a target we end up refusing must not navigate.
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  // In-page anchor (`#slug`) — the bundled manual's table of contents. Scroll the
  // matching heading into view WITHIN this container (never the document), so it is
  // a scroll, not a navigation, and separate rendered blocks can't collide. Wrapped
  // in try/catch: a hostile `.md` could carry a `#`-target that is not a valid
  // selector or a malformed %-escape — it must be inert, not throw.
  if (href.startsWith("#")) {
    const container = e.currentTarget as HTMLElement | null;
    try {
      const id = decodeURIComponent(href.slice(1));
      const target = id ? container?.querySelector(`[id="${id}"]`) : null;
      if (target instanceof HTMLElement) {
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      }
    } catch {
      /* not a resolvable anchor — stay inert */
    }
    return;
  }
  if (HTTP.test(href) || MAILTO.test(href)) openUrl(href).catch(() => {});
  // Anything else (relative repo links in the bundled manual, or a scheme that
  // slipped past render-time validation) is deliberately inert.
}

// `auxclick` covers middle-click, which does not fire `click` in WebKit/Chromium.
function handleAux(e: MouseEvent) {
  if (e.button === 1) handle(e);
}

/** Svelte action: intercept link clicks inside a rendered-markdown container. */
export function mdLinks(node: HTMLElement) {
  node.addEventListener("click", handle);
  node.addEventListener("auxclick", handleAux);
  return {
    destroy() {
      node.removeEventListener("click", handle);
      node.removeEventListener("auxclick", handleAux);
    },
  };
}
