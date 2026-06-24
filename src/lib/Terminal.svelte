<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { SearchAddon } from "@xterm/addon-search";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import "@xterm/xterm/css/xterm.css";
  import { debounce } from "./util";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";
  import { notifySuccess } from "./stores/toasts.svelte";
  import { contextSnippet, findMatchRows, matchCountLabel } from "./search";
  import { applyHighlight, compileRules } from "./highlight";
  import {
    closedEvent,
    connectSession,
    disconnect,
    openLocalTerminal,
    outputEvent,
    resizePty,
    writeToTerminal,
  } from "./api";
  import { settings, activeTerminalTheme } from "./settings.svelte";
  import { readClipboard, writeClipboard } from "./clipboard";

  type Status = "connecting" | "connected" | "closed" | "error";

  let {
    sessionId,
    serverId,
    secret,
    remember,
    local = false,
    onstatus,
  }: {
    sessionId: string;
    serverId: string;
    secret: string | null;
    remember: boolean;
    /** Local-shell PTY tab instead of an SSH connection. */
    local?: boolean;
    onstatus?: (status: Status, detail?: string) => void;
  } = $props();

  let container: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  let webgl: WebglAddon | undefined;
  let observer: ResizeObserver;
  let flashing = $state(false);
  const unlisten: UnlistenFn[] = [];
  const encoder = new TextEncoder();

  // ── Full-buffer search (Phase 10) ──────────────────────────────────────────
  // The SearchAddon handles scroll-to-match + highlight decorations; the pure
  // helpers in search.ts power "copy match with context". Gated by settings so
  // the master toggle returns the terminal to its plain behaviour.
  let searchAddon: SearchAddon | undefined;
  let searchInput = $state<HTMLInputElement>();
  const search = $state({
    open: false,
    query: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    index: -1,
    count: 0,
  });
  const searchEnabled = $derived(settings.smartLogs.enabled && settings.smartLogs.search);
  const countLabel = $derived(matchCountLabel(search.index, search.count));

  // ── Regex highlighting + clickable links (Phase 10) ────────────────────────
  // Output is decoded with a streaming decoder (handles multibyte chars split
  // across chunks) and, when highlighting is on and we're on the normal screen
  // buffer (not a full-screen TUI), matched tokens are wrapped in ANSI colours
  // before reaching xterm. Pure logic lives in highlight.ts.
  const decoder = new TextDecoder();
  const highlightEnabled = $derived(settings.smartLogs.enabled && settings.smartLogs.highlight);
  const compiledRules = $derived(
    highlightEnabled ? compileRules(settings.highlightRules) : [],
  );
  let webLinks: WebLinksAddon | undefined;

  /** The current theme's accent colour (the UI palette's `--color-accent`). */
  function accentColor(): string {
    if (typeof document !== "undefined") {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue("--color-accent")
        .trim();
      if (v) return v;
    }
    return activeTerminalTheme().foreground;
  }

  /**
   * Search options incl. highlight decoration colours (xterm wants #RRGGBB).
   * The fill is the theme's own `selectionBackground` — it's coordinated with
   * each theme and, being the colour text is already shown selected on, keeps
   * the terminal's light glyphs readable (a yellow fill washed them out). Solid,
   * no transparency. The active match is marked by a border in the theme's
   * **accent** colour plus the grow-in pulse (see the style block), so it stands
   * out in-theme without an unreadable fill.
   */
  function searchOpts() {
    const th = activeTerminalTheme();
    const accent = accentColor();
    return {
      regex: search.regex,
      caseSensitive: search.caseSensitive,
      wholeWord: search.wholeWord,
      decorations: {
        matchBackground: th.selectionBackground,
        matchOverviewRuler: th.selectionBackground,
        activeMatchBackground: th.selectionBackground,
        activeMatchBorder: accent,
        activeMatchColorOverviewRuler: accent,
      },
    };
  }

  function runSearch() {
    if (!searchAddon) return;
    if (!search.query) {
      searchAddon.clearDecorations();
      search.index = -1;
      search.count = 0;
      return;
    }
    searchAddon.findNext(search.query, { ...searchOpts(), incremental: true });
  }

  function nextMatch() {
    if (search.query) searchAddon?.findNext(search.query, searchOpts());
  }
  function prevMatch() {
    if (search.query) searchAddon?.findPrevious(search.query, searchOpts());
  }

  function openSearch() {
    search.open = true;
    const sel = term.getSelection();
    if (sel && !sel.includes("\n")) search.query = sel;
    // Wait for the input to render before focusing/searching.
    queueMicrotask(() => {
      searchInput?.focus();
      searchInput?.select();
      runSearch();
    });
  }

  function closeSearch() {
    search.open = false;
    searchAddon?.clearDecorations();
    search.index = -1;
    search.count = 0;
    term?.focus();
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) prevMatch();
      else nextMatch();
    }
  }

  /** Copy the active match's line plus ±5 lines of context to the clipboard. */
  function copyContext() {
    if (!search.query || search.count === 0) return;
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    const rows = findMatchRows(lines, search.query, {
      caseSensitive: search.caseSensitive,
      wholeWord: search.wholeWord,
      regex: search.regex,
    });
    if (rows.length === 0) return;
    // Map the addon's per-match active index onto a matching row (best-effort;
    // a row with several matches collapses to one, which is fine for context).
    const i = search.index >= 0 ? Math.min(search.index, rows.length - 1) : 0;
    writeClipboard(contextSnippet(lines, rows[i], 5));
    notifySuccess(t("search.copied"));
  }

  function copySelection() {
    const sel = term.getSelection();
    if (sel) writeClipboard(sel);
  }

  async function paste() {
    const text = await readClipboard();
    if (text) writeToTerminal(sessionId, encoder.encode(text)).catch(() => {});
  }

  onMount(async () => {
    const t = activeTerminalTheme();
    term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
      // Search highlight decorations (addon-search) use xterm's decoration API,
      // which is still "proposed" in xterm 6 and throws unless opted in.
      allowProposedApi: true,
      theme: t,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    // Search addon is always loaded (cheap); the UI/hotkey are gated by settings
    // so toggling the feature off at runtime needs no remount.
    searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddon.onDidChangeResults((e) => {
      search.index = e.resultIndex;
      search.count = e.resultCount;
    });
    term.open(container);
    fit.fit();

    // GPU-accelerated rendering for smooth output under heavy load. Falls back
    // to the DOM renderer if WebGL is unavailable or its context is lost.
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        webgl = undefined;
      });
      term.loadAddon(addon);
      webgl = addon;
    } catch {
      /* no WebGL — xterm keeps its default renderer */
    }

    // Forward keystrokes to the remote shell.
    term.onData((d) => {
      writeToTerminal(sessionId, encoder.encode(d)).catch(() => {});
    });

    // Copy-on-select (optional) and bell handling.
    term.onSelectionChange(() => {
      if (settings.copyOnSelect) copySelection();
    });
    term.onBell(() => {
      if (settings.bell === "visual") {
        flashing = true;
        setTimeout(() => (flashing = false), 160);
      } else if (settings.bell === "sound") {
        beep();
      }
    });

    // Clipboard shortcuts: Cmd+C/V (macOS) or Ctrl+Shift+C/V (Win/Linux).
    // Plain Ctrl+C is left untouched so it still sends SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Cmd+F (macOS) or Ctrl+Shift+F (Win/Linux) opens full-buffer search.
      // Plain Ctrl+F is left for the remote shell (readline forward-char).
      const findCombo =
        (e.metaKey && e.key === "f") || (e.ctrlKey && e.shiftKey && e.key === "F");
      if (findCombo && searchEnabled) {
        e.preventDefault();
        openSearch();
        return false;
      }
      const copyCombo =
        (e.metaKey && e.key === "c") || (e.ctrlKey && e.shiftKey && e.key === "C");
      const pasteCombo =
        (e.metaKey && e.key === "v") || (e.ctrlKey && e.shiftKey && e.key === "V");
      if (copyCombo && term.hasSelection()) {
        // preventDefault stops the browser's native copy from also firing.
        e.preventDefault();
        copySelection();
        return false;
      }
      if (pasteCombo) {
        // Without preventDefault the browser also fires a native `paste`,
        // which xterm handles too — pasting the text twice.
        e.preventDefault();
        paste();
        return false;
      }
      return true;
    });

    // Stream output and close events BEFORE connecting (don't miss the banner).
    unlisten.push(
      await listen<number[]>(outputEvent(sessionId), (e) => {
        const text = decoder.decode(new Uint8Array(e.payload), { stream: true });
        // Only colour the normal buffer — never a full-screen app (vim/htop).
        const onNormalBuffer = term.buffer.active.type === "normal";
        term.write(
          highlightEnabled && onNormalBuffer ? applyHighlight(text, compiledRules) : text,
        );
      }),
    );
    unlisten.push(
      await listen(closedEvent(sessionId), () => {
        onstatus?.("closed");
        const msg = local ? "[shell exited]" : "[connection closed]";
        term.write(`\r\n\x1b[33m${msg}\x1b[0m\r\n`);
      }),
    );

    onstatus?.("connecting");
    try {
      if (local) {
        await openLocalTerminal(sessionId, term.cols, term.rows);
      } else {
        await connectSession(
          sessionId,
          serverId,
          secret,
          remember,
          term.cols,
          term.rows,
          {
            termType: settings.termType,
            connectTimeout: settings.connectTimeout,
            keepaliveInterval: settings.keepaliveInterval,
            hostKeyPolicy: settings.hostKeyPolicy,
          },
        );
      }
      onstatus?.("connected");
      term.focus();
    } catch (err) {
      onstatus?.("error", String(err));
      term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
      return;
    }

    // Keep the remote PTY in sync with the widget size. Debounced so a burst of
    // resize callbacks (e.g. while dragging a panel divider) triggers a single
    // refit + one resize round-trip to the server.
    const refit = debounce(() => {
      try {
        fit.fit();
        resizePty(sessionId, term.cols, term.rows).catch(() => {});
      } catch {
        /* container not measurable yet */
      }
    }, 80);
    observer = new ResizeObserver(() => refit());
    observer.observe(container);
  });

  /** Middle-click paste (optional) — classic X11 terminal behavior. */
  function onMouseDown(e: MouseEvent) {
    if (e.button === 1 && settings.middleClickPaste) {
      e.preventDefault();
      paste();
    }
  }

  // A short WebAudio blip for the audible bell (no asset needed).
  function beep() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
      osc.onended = () => ctx.close();
    } catch {
      /* audio unavailable */
    }
  }

  /** Re-measure after a (possibly async-loaded) font is ready and refit. */
  function applyFontAndFit() {
    try {
      fit?.fit();
      term.refresh(0, term.rows - 1);
      resizePty(sessionId, term.cols, term.rows).catch(() => {});
    } catch {
      /* not measurable yet */
    }
  }

  // Live-apply appearance settings to the running terminal.
  $effect(() => {
    if (!term) return;
    const t = activeTerminalTheme();
    const fontFamily = settings.fontFamily;
    const fontSize = settings.fontSize;
    term.options.theme = { ...t };
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.options.lineHeight = settings.lineHeight;
    term.options.cursorBlink = settings.cursorBlink;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.scrollback = settings.scrollback;
    applyFontAndFit();
    // Bundled fonts load asynchronously — once the chosen face is ready,
    // re-measure so xterm doesn't stay on the fallback glyphs.
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.load(`${fontSize}px ${fontFamily}`).then(applyFontAndFit).catch(() => {});
    }
  });

  // Closing the search box when the feature is disabled mid-session keeps the
  // terminal in its plain state the moment the master toggle flips off.
  $effect(() => {
    if (!searchEnabled && search.open) closeSearch();
  });

  // Clickable links follow the highlight toggle. The handler opens only http(s)
  // externally, on an explicit click (offline invariant) — via the Tauri opener.
  $effect(() => {
    if (!term) return;
    if (highlightEnabled && !webLinks) {
      webLinks = new WebLinksAddon((_event, uri) => {
        if (/^https?:\/\//i.test(uri)) openUrl(uri).catch(() => {});
      });
      term.loadAddon(webLinks);
    } else if (!highlightEnabled && webLinks) {
      webLinks.dispose();
      webLinks = undefined;
    }
  });

  onDestroy(() => {
    observer?.disconnect();
    unlisten.forEach((u) => u());
    disconnect(sessionId).catch(() => {});
    searchAddon?.dispose();
    webLinks?.dispose();
    webgl?.dispose();
    term?.dispose();
  });
</script>

<div class="relative h-full w-full">
  <div
    bind:this={container}
    onmousedown={onMouseDown}
    role="presentation"
    class="h-full w-full"
  ></div>
  <!-- Full-buffer search overlay (Phase 10). -->
  {#if search.open}
    <div
      class="absolute right-2 top-2 z-20 flex items-center gap-1 rounded border border-edge bg-panel-alt/95 px-2 py-1 shadow-lg"
      data-testid="terminal-search"
    >
      <Icon name="search" size={14} class="text-muted" />
      <input
        bind:this={searchInput}
        bind:value={search.query}
        oninput={runSearch}
        onkeydown={onSearchKey}
        type="text"
        spellcheck="false"
        placeholder={t("search.placeholder")}
        aria-label={t("search.placeholder")}
        class="w-44 bg-transparent text-sm text-text outline-none placeholder:text-muted"
      />
      <span class="min-w-14 text-right text-xs tabular-nums text-muted">
        {#if search.query}{countLabel || t("search.noResults")}{/if}
      </span>
      <button
        type="button"
        onclick={() => {
          search.caseSensitive = !search.caseSensitive;
          runSearch();
        }}
        title={t("search.caseSensitive")}
        aria-label={t("search.caseSensitive")}
        aria-pressed={search.caseSensitive}
        class="rounded px-1 text-xs font-medium {search.caseSensitive
          ? 'bg-edge text-accent'
          : 'text-muted hover:text-accent'}">Aa</button
      >
      <button
        type="button"
        onclick={() => {
          search.wholeWord = !search.wholeWord;
          runSearch();
        }}
        title={t("search.wholeWord")}
        aria-label={t("search.wholeWord")}
        aria-pressed={search.wholeWord}
        class="rounded px-1 text-xs font-medium {search.wholeWord
          ? 'bg-edge text-accent'
          : 'text-muted hover:text-accent'}">W</button
      >
      <button
        type="button"
        onclick={() => {
          search.regex = !search.regex;
          runSearch();
        }}
        title={t("search.regex")}
        aria-label={t("search.regex")}
        aria-pressed={search.regex}
        class="rounded px-1 text-xs font-medium {search.regex
          ? 'bg-edge text-accent'
          : 'text-muted hover:text-accent'}">.*</button
      >
      <button
        type="button"
        onclick={prevMatch}
        title={t("search.prev")}
        aria-label={t("search.prev")}
        class="rounded p-0.5 text-muted hover:text-accent"
      >
        <Icon name="chevronUp" size={14} />
      </button>
      <button
        type="button"
        onclick={nextMatch}
        title={t("search.next")}
        aria-label={t("search.next")}
        class="rounded p-0.5 text-muted hover:text-accent"
      >
        <Icon name="chevronDown" size={14} />
      </button>
      <button
        type="button"
        onclick={copyContext}
        title={t("search.copyContext")}
        aria-label={t("search.copyContext")}
        class="rounded p-0.5 text-muted hover:text-accent"
      >
        <Icon name="copy" size={13} />
      </button>
      <button
        type="button"
        onclick={closeSearch}
        title={t("search.close")}
        aria-label={t("search.close")}
        class="rounded p-0.5 text-muted hover:text-danger"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  {/if}
  <!-- Visual bell: a brief flash drawn on top of the terminal. -->
  {#if flashing}
    <div
      class="pointer-events-none absolute inset-0 bg-accent/25 ring-2 ring-inset ring-accent"
    ></div>
  {/if}
</div>

<style>
  /* addon-search renders match highlights as global DOM decorations
     (.xterm-find-result-decoration; the active one also gets
     .xterm-find-active-result-decoration), so these need :global. The active
     match grows in briefly when we navigate to it, making the jump obvious.
     Honors prefers-reduced-motion via the global guard in app.css plus the
     explicit override below. */
  :global(.xterm-find-result-decoration) {
    border-radius: 2px;
  }
  :global(.xterm-find-active-result-decoration) {
    border-radius: 2px;
    transform-origin: center;
    animation: vterm-find-active-in var(--motion-base, 200ms) ease-out;
  }
  @keyframes -global-vterm-find-active-in {
    from {
      transform: scale(0.5);
    }
    60% {
      transform: scale(1.18);
    }
    to {
      transform: scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.xterm-find-active-result-decoration) {
      animation: none;
    }
  }
</style>
