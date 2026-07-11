<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { tooltip } from "./actions/tooltip";
  import { Terminal, type IMarker } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { SearchAddon } from "@xterm/addon-search";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import "@xterm/xterm/css/xterm.css";
  import { debounce } from "./util";
  import { parseOsc7 } from "./osc";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";
  import { notifySuccess } from "./stores/toasts.svelte";
  import { buildMatcher, contextSnippet, findMatchRows, matchCountLabel } from "./search";
  import { applyHighlight, compileRules } from "./highlight";
  import { toLogEntry, type JsonLogEntry } from "./jsonlog";
  import JsonLogView from "./JsonLogView.svelte";
  import ViewModeToggle from "./ViewModeToggle.svelte";
  import CommandHistory from "./CommandHistory.svelte";
  import { recentUniqueCommands, mergeCommands, createCommandCapture } from "./history";
  import {
    closedEvent,
    connectSession,
    disconnect,
    openLocalTerminal,
    outputEvent,
    phaseEvent,
    readShellHistory,
    resizePty,
    writeToTerminal,
  } from "./api";
  import type { ConnPhase } from "./connphase";
  import { accumulatePinch } from "./termzoom";
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
    onphase,
    onresize,
    onactivity,
    oncwd,
  }: {
    sessionId: string;
    serverId: string;
    secret: string | null;
    remember: boolean;
    /** Local-shell PTY tab instead of an SSH connection. */
    local?: boolean;
    onstatus?: (status: Status, detail?: string) => void;
    /** Reports SSH connection-phase progress for the connecting overlay. */
    onphase?: (phase: ConnPhase) => void;
    /** Reports the live terminal grid size (used for the recording header). */
    onresize?: (cols: number, rows: number) => void;
    /** Fired on user keystrokes (used to re-arm the recording idle timer). */
    onactivity?: () => void;
    /** The shell's cwd, parsed from an OSC 7 sequence (shell integration). */
    oncwd?: (path: string) => void;
  } = $props();

  let container: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  // Terminal background for the container's padding strip (see the markup below),
  // so the inset around the text matches xterm's canvas instead of the panel.
  const termBg = $derived(activeTerminalTheme().background ?? "");
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
  // Match options live in settings (remembered across opens, tabs and restarts).
  const opts = $derived(settings.searchOptions);
  const search = $state({
    open: false,
    query: "",
    index: -1,
    count: 0,
  });
  const searchEnabled = $derived(settings.smartLogs.enabled);
  const countLabel = $derived(matchCountLabel(search.index, search.count));
  // In regex mode, a malformed pattern matches nothing — surface that instead of
  // failing silently (mirrors the highlight-rules editor).
  const searchInvalid = $derived(
    opts.regex &&
      search.query.length > 0 &&
      buildMatcher(search.query, {
        regex: true,
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
      }) === null,
  );

  // ── Ctrl+R command-history overlay (Phase 23) ──────────────────────────────
  // Reverse-search over the session's shell history file (read on open via the
  // backend). Gated by settings.historySearch; when off, Ctrl+R passes through to
  // the remote shell's own reverse-search. Accepting a command clears the current
  // prompt line and types it (no newline) — the user reviews and runs it.
  const historyEnabled = $derived(settings.historySearch);
  let history = $state({
    open: false,
    loading: false,
    error: null as string | null,
    items: [] as string[],
  });

  // Client-side capture (source A): commands typed in this session, newest-first,
  // so the Ctrl+R list has the current session's history before the shell flushes
  // its file on exit. Fed from `term.onData`; merged above the file history.
  const capture = createCommandCapture();
  let capturedCommands: string[] = [];
  const CAPTURE_CAP = 500;

  function recordTyped(data: string) {
    for (const cmd of capture.feed(data)) {
      capturedCommands = [cmd, ...capturedCommands.filter((c) => c !== cmd)].slice(0, CAPTURE_CAP);
    }
  }

  async function openHistory() {
    history.open = true;
    history.loading = true;
    history.error = null;
    try {
      const raw = await readShellHistory(sessionId);
      // Live-typed commands first, then the shell history file (deduped).
      history.items = mergeCommands(capturedCommands, recentUniqueCommands(raw));
    } catch (e) {
      // Even if the file read fails, still show what we captured this session.
      history.items = capturedCommands;
      history.error = capturedCommands.length ? null : String(e);
    } finally {
      history.loading = false;
    }
  }

  /** Put a recalled command on the prompt: clear the line (Ctrl-A, Ctrl-K) then
   *  type it, leaving the cursor at the end for review — never auto-runs. */
  function acceptHistory(command: string) {
    history.open = false;
    writeToTerminal(sessionId, encoder.encode(`\x01\x0b${command}`)).catch(() => {});
    term?.focus();
  }

  // ── Regex highlighting + clickable links (Phase 10) ────────────────────────
  // Output is decoded with a streaming decoder (handles multibyte chars split
  // across chunks) and, when highlighting is on and we're on the normal screen
  // buffer (not a full-screen TUI), matched tokens are wrapped in ANSI colours
  // before reaching xterm. Pure logic lives in highlight.ts.
  const decoder = new TextDecoder();
  const highlightEnabled = $derived(settings.smartLogs.enabled);
  const compiledRules = $derived(
    highlightEnabled ? compileRules(settings.highlightRules) : [],
  );
  let webLinks: WebLinksAddon | undefined;

  // ── Structured JSON log view (Phase 10) ────────────────────────────────────
  // A raw↔structured toggle; in structured mode the output stream is parsed line
  // by line into a filterable table (JsonLogView). Parsing only runs while the
  // structured view is open (zero overhead otherwise); toggling it on first
  // seeds from the existing scrollback so recent logs show immediately.
  const MAX_JSON_ENTRIES = 2000;
  const jsonViewEnabled = $derived(settings.smartLogs.enabled);
  // Latched once the session first connects. The raw↔table toggle is hidden until
  // then so it doesn't float over the connecting overlay while a tab is still
  // establishing its SSH session (local shells connect near-instantly).
  let connected = $state(false);
  let structured = $state(false);
  let jsonEntries = $state<JsonLogEntry[]>([]);
  let jsonBuffer = "";
  let jsonSeq = 0;
  // After "Clear", a marker at the then-current bottom: re-seeding reads only
  // lines after it, so cleared output stays gone and we wait for new output.
  let seedMark: IMarker | undefined;

  function pushEntry(line: string) {
    const entry = toLogEntry(line, jsonSeq);
    if (!entry) return;
    jsonSeq++;
    jsonEntries.push(entry);
    if (jsonEntries.length > MAX_JSON_ENTRIES) {
      jsonEntries.splice(0, jsonEntries.length - MAX_JSON_ENTRIES);
    }
  }

  /** Feed live output (already decoded) to the JSON parser, line by line. */
  function feedJson(text: string) {
    jsonBuffer += text;
    let nl: number;
    while ((nl = jsonBuffer.indexOf("\n")) >= 0) {
      pushEntry(jsonBuffer.slice(0, nl).replace(/\r$/, ""));
      jsonBuffer = jsonBuffer.slice(nl + 1);
    }
  }

  /**
   * Seed the table from the current scrollback when structured mode opens.
   * Long lines wrap across several buffer rows (`isWrapped`), so rows are
   * stitched back into their logical line before parsing — otherwise a wrapped
   * JSON object would be split into unparseable fragments.
   */
  function seedJsonFromBuffer() {
    jsonEntries = [];
    jsonSeq = 0;
    jsonBuffer = "";
    const buf = term.buffer.active;
    // Start after the "cleared" watermark (if still in scrollback) so previously
    // cleared output isn't re-read; otherwise seed the whole scrollback.
    const start =
      seedMark && !seedMark.isDisposed && seedMark.line >= 0 ? seedMark.line + 1 : 0;
    let acc = "";
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(false);
      if (line.isWrapped) {
        acc += text; // continuation of the previous row
      } else {
        if (acc) pushEntry(acc);
        acc = text;
      }
    }
    if (acc) pushEntry(acc);
  }

  function setStructured(on: boolean) {
    if (on === structured) return;
    if (on) seedJsonFromBuffer();
    structured = on;
  }

  /**
   * Wipe accumulated entries — a clean slate before viewing a different log.
   * Drops a watermark at the current bottom so leaving and re-entering the
   * structured view doesn't re-read the just-cleared output (only newer lines).
   */
  function clearJson() {
    jsonEntries = [];
    jsonSeq = 0;
    jsonBuffer = "";
    seedMark?.dispose();
    seedMark = term.registerMarker(0) ?? undefined;
  }

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
      regex: opts.regex,
      caseSensitive: opts.caseSensitive,
      wholeWord: opts.wholeWord,
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
    if (!search.query || searchInvalid) {
      // Empty query or a malformed regex: clear highlights, show no count.
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
      caseSensitive: opts.caseSensitive,
      wholeWord: opts.wholeWord,
      regex: opts.regex,
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

  /**
   * The text on the current cursor line up to the cursor — i.e. the live shell
   * prompt the user is about to type after. Used to seed a recording so its first
   * command has a prompt in front of it (the prompt was printed before REC). The
   * cursor column bound keeps the prompt's trailing space without padding.
   */
  export function currentPromptLine(): string {
    if (!term) return "";
    const buf = term.buffer.active;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    return line ? line.translateToString(false, 0, buf.cursorX) : "";
  }

  /** The current text selection (empty when nothing is selected). For AI context. */
  export function selectionText(): string {
    return term?.getSelection() ?? "";
  }

  /**
   * Plain-text scrollback, wrapped rows stitched back into logical lines and
   * trailing blank lines trimmed. With `maxLines`, only the last N lines are
   * returned (the recent output tail — the default AI context tier). Feeds the
   * assistant; redaction + consent happen before anything leaves the machine.
   */
  export function bufferText(maxLines?: number): string {
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    let acc = "";
    let started = false;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped) {
        acc += line.translateToString(false);
      } else {
        if (started) lines.push(acc);
        acc = text;
        started = true;
      }
    }
    if (started) lines.push(acc);
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    const slice = maxLines && maxLines > 0 ? lines.slice(-maxLines) : lines;
    return slice.join("\n");
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
    onresize?.(term.cols, term.rows);

    // Moving focus back to the terminal (e.g. a click on the console) closes the
    // Ctrl+R history palette — xterm focuses its hidden textarea on such clicks.
    term.textarea?.addEventListener("focus", () => {
      if (history.open) history.open = false;
    });

    // Capture-phase, non-passive so preventDefault beats xterm's scroll + page zoom.
    container.addEventListener("wheel", onZoomWheel, { capture: true, passive: false });

    // Shell integration: OSC 7 reports the shell's cwd (file:// URI) on `cd`. We
    // surface it so the file panels can follow the terminal (opt-in per tab). No-op
    // when the shell doesn't emit it — we never guess the path from the prompt.
    term.parser.registerOscHandler(7, (payload) => {
      const path = parseOsc7(payload);
      if (path) oncwd?.(path);
      return true;
    });

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
      onactivity?.();
      if (historyEnabled) recordTyped(d);
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
      // Ctrl+R opens our command-history overlay instead of the shell's
      // reverse-search (opt-out via settings.historySearch).
      if (historyEnabled && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === "r") {
        e.preventDefault();
        openHistory();
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
        // Mirror raw output into the structured view while it's open.
        if (structured) feedJson(text);
      }),
    );
    unlisten.push(
      await listen(closedEvent(sessionId), () => {
        onstatus?.("closed");
        const msg = local ? "[shell exited]" : "[connection closed]";
        term.write(`\r\n\x1b[33m${msg}\x1b[0m\r\n`);
      }),
    );
    // Real SSH connection-phase progress for the connecting overlay (SSH only).
    if (!local) {
      unlisten.push(
        await listen<ConnPhase>(phaseEvent(sessionId), (e) => onphase?.(e.payload)),
      );
    }

    connected = false;
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
      connected = true;
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
        onresize?.(term.cols, term.rows);
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

  // Trackpad pinch (and Ctrl+wheel) zoom the console font. The browser reports
  // both as a wheel event with ctrlKey set. Handled in the capture phase so we
  // preventDefault before xterm's own viewport handler scrolls the buffer, and
  // before the WebView zooms the whole page. Stepping math lives in termzoom.ts.
  let pinchAccum = 0;
  function onZoomWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    const { size, accum } = accumulatePinch(settings.fontSize, pinchAccum, e.deltaY);
    pinchAccum = accum;
    // The appearance $effect live-applies the new size and refits the terminal.
    if (size !== settings.fontSize) settings.fontSize = size;
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
      onresize?.(term.cols, term.rows);
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

  // Leaving the structured view (and dropping its data) the moment the feature
  // is switched off keeps the terminal in its plain state.
  $effect(() => {
    if (!jsonViewEnabled && structured) structured = false;
  });

  onDestroy(() => {
    observer?.disconnect();
    container?.removeEventListener("wheel", onZoomWheel, { capture: true });
    unlisten.forEach((u) => u());
    disconnect(sessionId).catch(() => {});
    searchAddon?.dispose();
    webLinks?.dispose();
    seedMark?.dispose();
    webgl?.dispose();
    term?.dispose();
  });
</script>

<div class="relative h-full w-full @container">
  <!-- px-2 pt-1: lift the console text off the left edge and the tab-bar border.
       FitAddon reads the container's content width (padding excluded), so columns
       still fit exactly; the padding strip is tinted with the terminal bg to blend. -->
  <div
    bind:this={container}
    onmousedown={onMouseDown}
    role="presentation"
    class="h-full w-full px-2 pt-1"
    style="background-color: {termBg}"
  ></div>
  <!-- Structured JSON log view + raw↔table toggle (Phase 10). In structured mode
       the toggle lives inside the table toolbar; in raw mode it floats top-right. -->
  {#if structured}
    <div class="absolute inset-0 z-10">
      <JsonLogView entries={jsonEntries} onClear={clearJson} onShowRaw={() => setStructured(false)} />
    </div>
  {:else if jsonViewEnabled && connected}
    <div class="absolute right-2 top-2 z-30">
      <ViewModeToggle {structured} compact onSelect={setStructured} />
    </div>
  {/if}
  <!-- Ctrl+R command-history overlay (Phase 23). -->
  <CommandHistory
    open={history.open}
    items={history.items}
    loading={history.loading}
    error={history.error}
    onaccept={acceptHistory}
    onclose={() => {
      history.open = false;
      term?.focus();
    }}
  />
  <!-- Full-buffer search overlay (Phase 10). -->
  {#if search.open}
    <!-- Stacks below the floating raw↔table toggle (top-right) when it's shown. -->
    <div
      class="absolute right-2 z-20 flex items-center gap-1 rounded border border-edge bg-panel-alt/95 px-2 py-1 shadow-lg {jsonViewEnabled &&
      connected &&
      !structured
        ? 'top-11'
        : 'top-2'}"
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
      <span
        role="status"
        aria-live="polite"
        class="min-w-14 text-right text-xs tabular-nums {searchInvalid ? 'text-danger' : 'text-muted'}"
      >
        {#if searchInvalid}
          {t("search.invalidRegex")}
        {:else if search.query}{countLabel || t("search.noResults")}{/if}
      </span>
      <button
        type="button"
        onclick={() => {
          settings.searchOptions.caseSensitive = !opts.caseSensitive;
          runSearch();
        }}
        use:tooltip={t("search.caseSensitive")}
        aria-label={t("search.caseSensitive")}
        aria-pressed={opts.caseSensitive}
        class="rounded px-1 text-xs font-medium {opts.caseSensitive
          ? 'bg-edge text-accent'
          : 'text-muted hover:text-accent'}">Aa</button
      >
      <button
        type="button"
        onclick={() => {
          settings.searchOptions.wholeWord = !opts.wholeWord;
          runSearch();
        }}
        use:tooltip={t("search.wholeWord")}
        aria-label={t("search.wholeWord")}
        aria-pressed={opts.wholeWord}
        class="rounded px-1 text-xs font-medium {opts.wholeWord
          ? 'bg-edge text-accent'
          : 'text-muted hover:text-accent'}">W</button
      >
      <button
        type="button"
        onclick={() => {
          settings.searchOptions.regex = !opts.regex;
          runSearch();
        }}
        use:tooltip={t("search.regex")}
        aria-label={t("search.regex")}
        aria-pressed={opts.regex}
        class="rounded px-1 text-xs font-medium {opts.regex
          ? 'bg-edge text-accent'
          : 'text-muted hover:text-accent'}">.*</button
      >
      <button
        type="button"
        onclick={prevMatch}
        use:tooltip={t("search.prev")}
        aria-label={t("search.prev")}
        class="rounded p-0.5 text-muted hover:text-accent"
      >
        <Icon name="chevronUp" size={14} />
      </button>
      <button
        type="button"
        onclick={nextMatch}
        use:tooltip={t("search.next")}
        aria-label={t("search.next")}
        class="rounded p-0.5 text-muted hover:text-accent"
      >
        <Icon name="chevronDown" size={14} />
      </button>
      <button
        type="button"
        onclick={copyContext}
        use:tooltip={t("search.copyContext")}
        aria-label={t("search.copyContext")}
        class="rounded p-0.5 text-muted hover:text-accent"
      >
        <Icon name="copy" size={13} />
      </button>
      <button
        type="button"
        onclick={closeSearch}
        use:tooltip={t("search.close")}
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
