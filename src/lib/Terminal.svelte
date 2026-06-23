<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import "@xterm/xterm/css/xterm.css";
  import { debounce } from "./util";
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
      theme: t,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
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
        term.write(new Uint8Array(e.payload));
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

  onDestroy(() => {
    observer?.disconnect();
    unlisten.forEach((u) => u());
    disconnect(sessionId).catch(() => {});
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
  <!-- Visual bell: a brief flash drawn on top of the terminal. -->
  {#if flashing}
    <div
      class="pointer-events-none absolute inset-0 bg-accent/25 ring-2 ring-inset ring-accent"
    ></div>
  {/if}
</div>
