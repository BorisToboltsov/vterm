<script lang="ts">
  // Idle screensaver overlay (Phase 0.28 "Заставки простоя"). A full-window canvas
  // painted ON TOP of the app — same layering contract as ThemeOverlay — after a
  // period of inactivity ("no input AND no output"). It draws a COPY of the live
  // terminal buffer (never writes to the PTY) and never talks to the network beyond
  // the existing metrics poll. Heavy canvas rendering lives here (excluded from
  // coverage, like MonitoringOverlay); the decidable logic is in idle.ts / idlefx.ts.
  //
  // Effects: card (default), matrix, parallax (spotlight), signal (weak-signal CRT).
  // NO SIGNAL is a separate takeover for a real connection drop (see connlost.ts),
  // forced via the `noSignal` prop regardless of the idle timer.
  import { untrack } from "svelte";
  import { settings, activeTerminalTheme } from "../settings/settings.svelte";
  import {
    ACTIVITY_EVENTS,
    dismissesScreensaver,
    isIdle,
    screensaverAllowed,
    swallowDismiss,
  } from "./idle";
  import { bufferGrid, cardTier, clipText, tokenizeBuffer, type CardTier, type WordToken } from "./idlefx";
  import {
    awayGaps,
    awayPush,
    awayStory,
    bandRuns,
    chartFrom,
    chartHit,
    CHART_MS,
    clockLabel,
    shiftOffset,
    emptyAway,
    gapReading,
    HOVER_SLACK,
    HOVER_STILL_MS,
    hoverShown,
    loadCeiling,
    procName,
    pulseLayout,
    pulseMark,
    pulseOf,
    serverOffset,
    serverZone,
    shifted,
    smallLayout,
    spanLabel,
    spanMid,
    standbyTransfer,
    timeAtX,
    timeX,
    verdictLine,
    windowPeak,
    type AwayGap,
    type AwayHistory,
    type AwayKey,
    type AwayReading,
    type AwaySpan,
    type AwayStory,
    type AwayThresholds,
    type NumbersBox,
    type PulseBox,
    type PulseOf,
    type SmallForm,
    type StandbyTransfer,
    type TextBox,
    type VerdictLine,
  } from "./standby";
  import {
    BAR_MS,
    easeOut,
    LINE_MS,
    progress,
    SCALE_MS,
    TIER_MS,
    retarget,
    RING_MS,
    still,
    tweenAt,
    type Tween,
  } from "../ui/tween";
  import { motionMs, reducedMotion } from "../ui/motion";
  import type { Metrics } from "../api";
  import { feedOf, pollEveryMs, watchMetrics } from "../stores/metricsfeed.svelte";
  import { fmtBytes, fmtPct, fmtRate, memPct } from "../monitoring/format";
  import { thresholdLevel, type ThresholdLevel } from "../monitoring/thresholds";
  import { loadHealth, loadZones } from "../monitoring/monhealth";
  import { barProblems } from "../monitoring/barmodel";
  import { fmtEta } from "../files/transfer";
  import { transfersState } from "../stores/transfers.svelte";
  import { currentLocale, t } from "../i18n";

  let {
    sessionId = null,
    tabs = 0,
    alias = "",
    bufferText = () => "",
    outputTick = 0,
    noSignal = false,
    prod = false,
    targetEl = null,
    onnosignaldismiss = () => {},
  }: {
    /** Connected SSH session for live metrics on the card, or null (ambient card). */
    sessionId?: string | null;
    /** Tabs open in this window: with none, the screensaver never starts. */
    tabs?: number;
    /** Host/alias shown on the card. */
    alias?: string;
    /** Snapshot the active terminal's visible text (for matrix/parallax/signal). */
    bufferText?: () => string;
    /** Bumps whenever the active terminal produces output (the "no output" rule). */
    outputTick?: number;
    /** Force the NO SIGNAL takeover (a real, unexpected disconnect). */
    noSignal?: boolean;
    /** The card's session is a production server: a red frame and a `prod` chip, as on its terminal. */
    prod?: boolean;
    /** The terminal-panes element the overlay covers (null → whole window). */
    targetEl?: HTMLElement | null;
    onnosignaldismiss?: () => void;
  } = $props();

  const reduce = reducedMotion();

  let active = $state(false);
  let canvas = $state<HTMLCanvasElement>();
  let raf = 0;
  let lastActivity = performance.now();
  let started = performance.now();

  // The effect actually shown: NO SIGNAL wins, else the configured screensaver.
  const shownEffect = $derived(noSignal ? "nosignal" : settings.idleEffect);

  // Snapshot captured at activation (so matrix/signal reveal the frozen console).
  let snapText = "";
  let tokens: WordToken[] = [];

  // ── live metrics for the card ──────────────────────────────────────────────
  // Null until this activation's first sample: the card must not show numbers
  // left over from the previous screensaver — often another host's (principle 5).
  let cpu: number | null = null;
  let mem: number | null = null;
  // Null = this host has no load average (Windows) — shown as "—", not 0.00.
  let load1: number | null = null;
  let cpuCount: number | null = null;
  let host = "";
  // Stops watching the session's feed (stores/metricsfeed): the card reads the
  // same polls as the status bar instead of asking on a timer of its own.
  let unwatch: (() => void) | undefined;
  // What the standby screen adds (v1.31), each null until reported.
  let diskUsed: number | null = null;
  let diskTotal: number | null = null;
  // The newest reading whole: the verdict and the pulse's metric read it (ADR 0065, ADR 0075).
  let lastMetrics: Metrics | null = null;
  // The server clock's lead over this machine's, minutes, and its zone. Null —
  // the host did not say (a local tab): the card shows this machine's time.
  let offsetMin: number | null = null;
  let zone = "";
  // Everything read since the screensaver rose; when the user was last seen.
  // The history learns the poll's beat on each activation: a silence longer
  // than three beats is a gap (a hidden window skips its polls).
  let away: AwayHistory = emptyAway(pollEveryMs(false));
  let leftAt = Date.now();

  // ── What the card shows runs to each reading (v1.33) ─────────────────────────
  // A reading used to land in one frame — rings, numbers and charts jumped every
  // poll. Each value now eases from where it stands to the reading, and a number
  // counts on the way (`tween.ts`); the right edge of a chart moves to the newest
  // point, so the line draws itself on and the rest closes up. Durations go
  // through `motionMs`: with reduced motion every change is instant, as before.
  let shownTw: Record<ShownKey, Tween> = noneShown();
  type ShownKey = "cpu" | "mem" | "load" | "disk";
  function noneShown(): Record<ShownKey, Tween> {
    return { cpu: still(null), mem: still(null), load: still(null), disk: still(null) };
  }
  // The pulse's right edge (wall-clock ms).
  let axisTw: Tween = still(null);
  // The top of the load pulse, moving to a new ceiling rather than jumping.
  let loadTopTw: Tween = still(null);
  // A transfer's bar, per transfer.
  let bar: { id: string; tw: Tween } = { id: "", tw: still(null) };
  // The moment the frame being drawn shows (`performance.now()`).
  let frameAt = 0;
  const ms = (base: number) => motionMs(base, reduce);
  const shown = (tw: Tween) => tweenAt(tw, frameAt, ms(RING_MS));

  /** One more poll of the time away; the history's right edge sets off towards it. */
  function remember(r: AwayReading) {
    away = awayPush(away, r, awayThresholds());
    axisTw = retarget(axisTw, away.lastAt, performance.now(), ms(LINE_MS), null);
  }

  const awayThresholds = (): AwayThresholds => ({
    cpu: settings.statusBarThresholds.cpu,
    ram: settings.statusBarThresholds.ram,
    load: settings.statusBarThresholds.load,
  });

  /** One poll of the feed: a reading at `at`, or null — that poll failed. */
  function onReading(m: Metrics | null, at = Date.now()) {
    if (m) {
      cpu = m.cpuPct ?? cpu;
      mem = memPct(m.memUsed, m.memTotal) ?? mem;
      load1 = m.load1;
      cpuCount = m.cpuCount ?? cpuCount;
      host = m.hostname || alias || host;
      diskUsed = m.diskUsed;
      diskTotal = m.diskTotal;
      lastMetrics = m;
      offsetMin = serverOffset(m.serverTime, at);
      zone = serverZone(m.serverTime);
      remember({
        at,
        cpuPct: m.cpuPct,
        memPct: memPct(m.memUsed, m.memTotal),
        load1: m.load1,
        cpuCount: m.cpuCount,
        topProc: m.topProc,
        memUsed: m.memUsed,
        memTotal: m.memTotal,
        uptimeSecs: m.uptimeSecs,
      });
    } else {
      // The numbers keep their last values, but the history does not pretend
      // to have seen this moment: a gap, not a line drawn through it.
      remember(gapReading(at));
    }
    // What is shown sets off towards the reading from wherever it stands.
    const t = performance.now();
    shownTw = {
      cpu: retarget(shownTw.cpu, cpu, t, ms(RING_MS)),
      mem: retarget(shownTw.mem, mem, t, ms(RING_MS)),
      load: retarget(shownTw.load, load1, t, ms(RING_MS)),
      disk: retarget(shownTw.disk, diskUsed != null && diskTotal ? (diskUsed / diskTotal) * 100 : null, t, ms(RING_MS)),
    };
    // Reduced motion has no rAF loop: the frame drawn at activation predates
    // the first sample, so without this the chart would never get its lines.
    // (Windows turns reduced motion on with "Animation effects" off — common.)
    if (active && reduce) draw(performance.now() - started);
  }

  function activate() {
    if (active) return;
    active = true;
    started = performance.now();
    tierNow = tierWas = null;
    snapText = "";
    try {
      snapText = bufferText();
    } catch {
      snapText = "";
    }
    tokens = tokenizeBuffer(snapText);
    pointer = null;
    movedAt = null;
    if (shownEffect === "card" && sessionId) {
      host = alias;
      cpu = mem = load1 = cpuCount = null;
      diskUsed = diskTotal = offsetMin = null;
      lastMetrics = null;
      zone = "";
      away = emptyAway(pollEveryMs(false));
      shownTw = noneShown();
      axisTw = loadTopTw = still(null);
      leftAt = Date.now() - (performance.now() - lastActivity);
      // What the feed already read shows at once; then every poll of its beat.
      const id = sessionId;
      const f = feedOf(id);
      if (f.metrics && f.at != null) onReading(f.metrics, f.at);
      unwatch = watchMetrics(id, { done: (m) => onReading(m) });
    }
    // Grab focus away from the terminal so the dismiss keydown lands on us.
    queueMicrotask(() => canvas?.focus());
    loop();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(raf);
    raf = 0;
    unwatch?.();
    unwatch = undefined;
    clearTimeout(stillTimer);
    pointer = null;
    movedAt = null;
    if (noSignal) onnosignaldismiss();
  }

  // ── The pointer over the history (v1.33) ─────────────────────────────────────
  // A move never dismisses the screensaver (only a click or a key does), so the
  // history of the time away can answer the pointer: the point under it, told in
  // a tooltip. The pointer is kept in canvas px; the layout is drawn moved by the
  // burn-in shift, so it is read against the shift its frame was drawn with.
  // A pointer at rest stops showing the tooltip after `HOVER_STILL_MS`.
  let pointer: { x: number; y: number } | null = null;
  let movedAt: number | null = null;
  let drift = { dx: 0, dy: 0 };
  let stillTimer: ReturnType<typeof setTimeout> | undefined;

  function onPointerMove(e: PointerEvent) {
    pointer = { x: e.offsetX, y: e.offsetY };
    movedAt = performance.now();
    if (!reduce || !active) return;
    // No animation loop: draw this move now, and the pointer coming to rest later.
    draw(performance.now() - started);
    clearTimeout(stillTimer);
    stillTimer = setTimeout(() => {
      if (active) draw(performance.now() - started);
    }, HOVER_STILL_MS + 50);
  }

  function onPointerLeave() {
    pointer = null;
    movedAt = null;
    if (reduce && active) draw(performance.now() - started);
  }

  // Any real user activity re-arms the timer and, if the screensaver is up,
  // dismisses it. The dismiss gesture is swallowed ONLY when it lands on the
  // screensaver itself (the canvas covers the terminal region and holds focus),
  // so it never reaches the terminal beneath. A gesture on other UI — the right
  // dock (SFTP/AI/git menu), sidebar, modals — dismisses the screensaver but is
  // let through, so that control still responds to the same click.
  function onUserActivity(e: Event) {
    lastActivity = performance.now();
    if (!active || !dismissesScreensaver(e.type)) return;
    if (swallowDismiss(e.target as Node | null, canvas)) {
      e.preventDefault();
      e.stopPropagation();
    }
    deactivate();
  }

  // Output keeps the terminal "busy": re-arm on every chunk (never covers a
  // terminal that is actively printing). `outputTick` is the ONLY dependency —
  // reading `active`/`noSignal` reactively here would (wrongly) re-run this on
  // activation and immediately dismiss the screensaver, so untrack that read.
  $effect(() => {
    void outputTick;
    untrack(() => {
      lastActivity = performance.now();
      if (active && !noSignal) deactivate();
    });
  });

  // NO SIGNAL forces the takeover on/off immediately.
  $effect(() => {
    if (noSignal && !active) activate();
    else if (!noSignal && active && shownEffect === "nosignal") deactivate();
  });

  // The last tab closed under a showing screensaver (a server deleted in another
  // window closes its tabs here): nothing is left to cover.
  $effect(() => {
    if (tabs > 0) return;
    untrack(() => {
      if (active && !noSignal) deactivate();
    });
  });

  // Idle poll: one cheap tick a second decides whether to raise the screensaver.
  $effect(() => {
    const id = setInterval(() => {
      if (active || noSignal) return;
      if (!screensaverAllowed(settings.idleEffect, tabs)) return;
      if (isIdle(lastActivity, performance.now(), settings.idleTimeoutSec)) activate();
    }, 1000);
    return () => clearInterval(id);
  });

  $effect(() => {
    // Real user activity only. NOTE: do NOT listen for `focus` in the capture
    // phase — focus events don't bubble but capture-phase reaches the window for
    // EVERY element, and xterm re-focuses its hidden textarea constantly, which
    // would reset the idle timer forever whenever a terminal is connected. Pointer
    // moves fire only on actual movement. Every event re-arms the idle timer; only
    // a click or a key dismisses a showing screensaver (`dismissesScreensaver`).
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onUserActivity, { capture: true, passive: !dismissesScreensaver(ev) });
    }
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onUserActivity, { capture: true });
    };
  });

  // ── rendering ───────────────────────────────────────────────────────────────
  function loop() {
    if (!active) return;
    draw(performance.now() - started);
    if (!reduce) raf = requestAnimationFrame(loop);
  }

  // Reduced motion has no rAF loop. The canvas mounts only once `active` flips
  // (`loop()` in `activate` runs before it exists), so this effect paints the
  // static frame; `onReading` repaints it after every sample.
  $effect(() => {
    if (active && reduce && canvas) draw(performance.now() - started);
  });

  interface Ctx2 {
    ctx: CanvasRenderingContext2D;
    W: number;
    H: number;
  }
  function setup(): Ctx2 | null {
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Cover only the target rect (measured each frame so it tracks panel resize /
    // window resize / tab changes) — the terminal-panes area, or the central
    // column when no tab is open. Fall back to the whole window only if unset.
    const r = targetEl?.getBoundingClientRect();
    const left = r ? r.left : 0;
    const top = r ? r.top : 0;
    const W = r && r.width > 0 ? r.width : window.innerWidth;
    const H = r && r.height > 0 ? r.height : window.innerHeight;
    canvas.style.left = `${left}px`;
    canvas.style.top = `${top}px`;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W, H };
  }

  function draw(now: number) {
    frameAt = performance.now();
    const s = setup();
    if (!s) return;
    const { ctx, W, H } = s;
    const p = activeTerminalTheme();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.globalAlpha = 1;
    if (shownEffect === "matrix") drawMatrix(ctx, W, H, now, p);
    else if (shownEffect === "parallax") drawParallax(ctx, W, H, now, p);
    else if (shownEffect === "signal") drawSignal(ctx, W, H, now, p);
    else if (shownEffect === "nosignal") drawNoSignal(ctx, W, H, now, p);
    else drawCard(ctx, W, H, now, p);
  }

  const CW = 9;
  const CH = 19;
  const HEX = "0123456789ABCDEF";
  function hash(c: number, r: number) {
    return ((c * 928371 + r * 1237) >>> 0) % 9973;
  }

  type Pal = ReturnType<typeof activeTerminalTheme>;

  // Dense hex rain seeded from the console, with depth layers and gaps. Uses a
  // lazily-built per-column state stored on the component.
  let mx: {
    cols: { y: number; sweep: number; relAt: number; dep: number; trail: number }[];
    grid: string[][];
    w: number;
  } | null = null;
  function drawMatrix(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal) {
    const COLS = Math.floor(W / CW);
    const ROWS = Math.floor(H / CH);
    if (!mx || mx.w !== COLS) {
      const grid = bufferGrid(snapText, COLS, ROWS);
      mx = {
        w: COLS,
        grid,
        cols: Array.from({ length: COLS }, () => ({
          y: -1,
          sweep: -1,
          relAt: Math.random() * 1400,
          dep: 0.5 + Math.random() * 0.5,
          trail: (10 + Math.random() * 8) | 0,
        })),
      };
    }
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, W, H);
    for (let c = 0; c < COLS; c++) {
      const col = mx.cols[c];
      const eff = 0.11 * (0.5 + 0.5 * col.dep);
      const da = 0.4 + 0.6 * col.dep;
      const fs = (12 + col.dep * 4) | 0;
      ctx.font = `${fs}px ui-monospace,Menlo,monospace`;
      if (now - col.relAt < 700) {
        ctx.font = `${CH - 4}px ui-monospace,Menlo,monospace`;
        for (let r = 0; r < ROWS; r++) {
          const ch = mx.grid[r]?.[c] ?? " ";
          if (ch !== " ") {
            // Held copy in the terminal's own text colour so the takeover starts
            // seamlessly; columns turn green only as they begin to fall.
            ctx.fillStyle = p.foreground;
            ctx.fillText(ch, c * CW, r * CH + 2);
          }
        }
        continue;
      }
      if (col.sweep < 0) {
        col.sweep = 0;
        col.y = 0;
      }
      col.y += eff;
      const hr = Math.floor(col.y);
      for (let r = 0; r < ROWS; r++) {
        if (r > hr) {
          // Not yet reached by the falling head — still the real console text,
          // in the terminal's foreground colour (seamless with what was on screen).
          if (col.sweep === 0 && mx.grid[r]?.[c] && mx.grid[r][c] !== " ") {
            ctx.fillStyle = hexAlpha(p.foreground, da);
            ctx.fillText(mx.grid[r][c], c * CW, r * CH + 2);
          }
          continue;
        }
        const d = hr - r;
        if (d > col.trail) continue;
        const realHead = d === 0 && col.sweep === 0 && mx.grid[r]?.[c] && mx.grid[r][c] !== " ";
        const g = realHead ? mx.grid[r][c] : HEX[(hash(c, r) + Math.floor(now / 240)) % 16];
        // Falling column: bright leading glyph, then a green trail (classic matrix).
        if (d === 0) ctx.fillStyle = hexAlpha(p.brightWhite || p.foreground, da);
        else ctx.fillStyle = hexAlpha(p.green, Math.max(0, 1 - d / col.trail) * da);
        ctx.fillText(g, c * CW, r * CH + 2);
      }
      if (col.y > ROWS + col.trail) {
        col.sweep++;
        col.y = -(2 + Math.random() * 8);
        col.trail = (10 + Math.random() * 8) | 0;
      }
    }
  }

  // Parallax words with a moving spotlight band (the chosen "Прожектор").
  let px: { items: { t: string; x: number; y: number; z: number; vx: number }[] } | null = null;
  function drawParallax(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal) {
    if (!px) {
      const pool = tokens.length ? tokens : [{ text: "vterm", kind: "plain" as const }];
      px = {
        items: Array.from({ length: 54 }, () => {
          const tk = pool[(Math.random() * pool.length) | 0];
          const z = 0.22 + Math.random() * 0.78;
          return { t: tk.text, x: Math.random() * W, y: Math.random() * H, z, vx: -(0.25 + Math.random() * 0.7) };
        }),
      };
    }
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, W, H);
    const band = H / 2 + Math.sin(now / 1400) * (H * 0.34);
    const bw = 90;
    for (const it of px.items) {
      it.x += it.vx * it.z;
      if (it.x < -160) {
        it.x = W + 60;
        it.y = Math.random() * H;
      }
      const lit = Math.max(0, 1 - Math.abs(it.y - band) / bw);
      ctx.font = `500 ${(11 + it.z * 13) | 0}px ui-monospace,Menlo,monospace`;
      ctx.fillStyle = lit > 0.1 ? hexAlpha(p.foreground, 0.15 + lit * 0.85) : hexAlpha(p.brightBlack || p.foreground, 0.14);
      ctx.fillText(it.t, it.x, it.y);
    }
    hint(ctx, W, H, p);
  }

  // Weak-signal CRT: readable console with a constant degradation + light ripple.
  function drawSignal(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal) {
    const COLS = Math.floor(W / CW);
    const ROWS = Math.floor(H / CH);
    const grid = bufferGrid(snapText, COLS, ROWS);
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${CH - 4}px ui-monospace,Menlo,monospace`;
    const jitter = reduce ? 0 : Math.sin(now / 130) * 0.6;
    for (let r = 0; r < ROWS; r++) {
      const dx = reduce ? 0 : Math.sin(r * 0.6 + now / 260) * 1.2 + jitter;
      for (let c = 0; c < COLS; c++) {
        const ch = grid[r]?.[c] ?? " ";
        if (ch === " ") continue;
        // constant chromatic fringe (fixed offsets, not flicker)
        ctx.fillStyle = hexAlpha(p.red, 0.35);
        ctx.fillText(ch, c * CW - 1.2 + dx, r * CH + 2);
        ctx.fillStyle = hexAlpha(p.blue, 0.35);
        ctx.fillText(ch, c * CW + 1.2 + dx, r * CH + 2);
        ctx.fillStyle = hexAlpha(p.foreground, 0.92);
        ctx.fillText(ch, c * CW + dx, r * CH + 2);
      }
    }
    scanlines(ctx, W, H);
    vignette(ctx, W, H);
  }

  function drawNoSignal(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal) {
    ctx.fillStyle = "#070707";
    ctx.fillRect(0, 0, W, H);
    if (!reduce) {
      for (let i = 0; i < 2600; i++) {
        const v = (Math.random() * 255) | 0;
        ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
        ctx.fillRect(Math.random() * W, Math.random() * H, Math.random() < 0.5 ? 2 : 1, 1);
      }
      const by = (now * 0.06) % H;
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(0, by, W, 10);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    }
    const bw = 200;
    const bx = W / 2 - bw / 2;
    const by = H / 2 - 26;
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(bx, by, bw, 54);
    ctx.strokeStyle = p.red;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, 53);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = p.red;
    ctx.font = "600 20px ui-monospace,Menlo,monospace";
    ctx.fillText("NO SIGNAL", W / 2, by + 18);
    ctx.fillStyle = hexAlpha(p.foreground, 0.6);
    ctx.font = "12px ui-monospace,monospace";
    ctx.fillText(t("idle.connectionLost"), W / 2, by + 40);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    scanlines(ctx, W, H);
  }

  // The server's standby screen. The terminal area is whatever the docks leave,
  // so it is laid out for the room there is (`cardTier`): the full or short form
  // (`pulseLayout`), or a small one (`smallLayout`, ADR 0082) — one look at
  // every size.
  // When the user asks for it (Settings → Screensaver, off by default), the whole
  // layout shifts a couple of pixels along a small path every chosen interval
  // (`shiftOffset`): a card left up for hours would otherwise hold the same
  // pixels lit. The prod frame marks the area's edge, so it is drawn after, in place.
  function drawCard(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal) {
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, W, H);
    const tier = cardTier(W, H);
    // A new room takes another layout: the old one gives way to it (TIER_MS)
    // rather than vanishing in one frame. The first layout of a showing just shows.
    if (tier !== tierNow) {
      tierWas = tierNow;
      tierNow = tier;
      tierAt = now;
    }
    const k = tierWas ? easeOut(progress(tierAt, now, ms(TIER_MS))) : 1;
    if (k >= 1) tierWas = null;
    const { dx, dy } = shiftOffset(now, settings.idleShiftEverySec);
    drift = { dx, dy };
    ctx.save();
    ctx.translate(dx, dy);
    if (tierWas) {
      ctx.globalAlpha = 1 - k;
      drawTier(tierWas, ctx, W, H, now, p);
      ctx.globalAlpha = k;
    }
    drawTier(tier, ctx, W, H, now, p);
    ctx.globalAlpha = 1;
    ctx.restore();
    if (prod && sessionId) prodFrame(ctx, W, H, p);
  }

  // The layout drawn now, the one giving way to it, and when it began to.
  let tierNow: CardTier | null = null;
  let tierWas: CardTier | null = null;
  let tierAt = 0;
  function drawTier(tier: CardTier, ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal) {
    if (tier === "standby" || tier === "compact") drawStandby(ctx, W, H, now, p, tier === "standby");
    else drawSmall(ctx, W, H, now, p, tier);
  }

  const MONO = "ui-monospace,Menlo,monospace";
  const cardName = () => host || alias || "vterm";
  function statusDot(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, now: number, p: Pal) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 620);
    ctx.fillStyle = hexAlpha(p.green, sessionId ? 0.5 + 0.5 * pulse : 0.35);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 7);
    ctx.fill();
  }
  /** `text` cut to `maxW` px in the font the context is set to (a monospace one). */
  function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
    return clipText(text, maxW / ctx.measureText("0").width);
  }

  // ── The standby screen (v1.31, ADR 0075) ─────────────────────────────────────
  // For an area with room to spare, and calm by design: the server's clock, the
  // host and the status bar's verdict, one line — the pulse — over the last half
  // hour with one sentence about the time away above it, four quiet numbers under
  // it, a transfer under way. Colour only where a threshold is crossed. `big` —
  // the full form (`standby`), else the short one (`compact`). Where everything
  // stands and what is said is standby.ts; this only paints it.
  const muted = (p: Pal) => hexAlpha(p.foreground, 0.55);
  const faint = (p: Pal) => hexAlpha(p.foreground, 0.28);
  const levelColor = (level: ThresholdLevel, p: Pal) =>
    level === "crit" ? p.red : level === "warn" ? p.yellow : p.foreground;

  // One formatter per language and form, not one per frame.
  const dateFormats = new Map<string, Intl.DateTimeFormat>();
  function dateFormat(locale: string, long: boolean): Intl.DateTimeFormat {
    const key = `${locale}:${long}`;
    let f = dateFormats.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(
        locale,
        long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" },
      );
      dateFormats.set(key, f);
    }
    return f;
  }

  function drawStandby(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal, big: boolean) {
    const wall = Date.now();
    const off = offsetMin ?? 0;
    const tr = standbyTransfer(Object.values(transfersState.map), transfersState.rates);
    const lay = pulseLayout(W, H, big, { yourTime: offsetMin != null && offsetMin !== 0, transfer: tr != null });
    const P = lay.pad;
    // The clock: the server's, run live from its offset; this machine's when it did not say.
    ctx.font = `200 ${lay.clockSize}px ${MONO}`;
    ctx.fillStyle = p.foreground;
    ctx.fillText(clockLabel(wall, off), P - lay.clockSize * 0.04, lay.clockY);
    const leftW = (W - 2 * P) * 0.48;
    const date = dateFormat(currentLocale(), big).format(shifted(wall, off));
    const where =
      offsetMin == null
        ? t("idle.localTime")
        : big
          ? [t("idle.serverTime"), zone].filter(Boolean).join(", ")
          : zone || t("idle.serverTime");
    ctx.font = `${lay.dateSize}px ${MONO}`;
    ctx.fillStyle = muted(p);
    ctx.fillText(fit(ctx, `${date} · ${where}`, leftW), P, lay.dateY);
    if (offsetMin != null && offsetMin !== 0) {
      ctx.font = `${lay.smallSize}px ${MONO}`;
      ctx.fillStyle = faint(p);
      ctx.fillText(fit(ctx, t("idle.yourTime", { time: clockLabel(wall, 0) }), leftW), P, lay.yourTimeY);
    }

    // The host, flush right: its dot, its name, a `prod` chip; under it, how it is.
    const right = W - P;
    const room = right - (P + leftW + (big ? 40 : 20));
    drawHost(ctx, { x: right, y: lay.hostY, size: lay.hostSize, align: "right", w: room }, now, p, big);
    ctx.font = `300 ${lay.verdictSize}px ${MONO}`;
    ctx.textAlign = "right";
    if (!sessionId) {
      ctx.fillStyle = muted(p);
      ctx.fillText(fit(ctx, t("idle.noSessions"), room), right, lay.verdictY);
      ctx.textAlign = "left";
      if (tr && lay.transfer) drawTransfer(ctx, P, lay.transfer.y, W - 2 * P, lay.transfer.h, p, big, tr);
      hint(ctx, W, H, p);
      return;
    }
    // How the host is now — the status bar's own verdict, in its words and its level.
    const problems = barProblems(lastMetrics, settings.statusBarThresholds);
    const verdict = verdictLine(lastMetrics != null, problems);
    if (verdict.kind !== "none") {
      ctx.fillStyle = levelColor(verdict.kind === "problem" ? verdict.problem.level : "ok", p);
      ctx.fillText(fit(ctx, verdictText(verdict), room), right, lay.verdictY);
    }
    ctx.textAlign = "left";

    // The pulse with the sentence about the time away, the four numbers, a transfer.
    const tip = drawPulse(ctx, lay, pulseOf(problems), storyText(awayStory(away, leftAt), wall), now, p, big);
    drawNumbers(
      ctx,
      {
        kind: "grid",
        x: lay.chart.x,
        y: lay.labelY,
        w: lay.chart.w,
        cols: 4,
        labelSize: lay.labelSize,
        valueSize: lay.valueSize,
        gap: lay.valueY - lay.labelY - lay.labelSize,
        rowGap: 0,
      },
      p,
    );
    if (tr && lay.transfer) drawTransfer(ctx, P, lay.transfer.y, W - 2 * P, lay.transfer.h, p, big, tr);
    if (tip) tooltip(ctx, tip.rows, tip.x, tip.gx, tip.gw, tip.gy, lay.headY, tip.bottom, p, big);
    hint(ctx, W, H, p);
  }

  /** The host's line in `b`: its dot, its name, a `prod` chip — aligned at `b.x`, cut to `b.w`. */
  function drawHost(ctx: CanvasRenderingContext2D, b: TextBox, now: number, p: Pal, big: boolean) {
    const chipSize = big ? 15 : Math.max(10, Math.round(b.size * 0.68));
    const chipGap = big ? 14 : 10;
    ctx.font = `500 ${chipSize}px ${MONO}`;
    const chipW = prod && sessionId ? ctx.measureText("prod").width + chipSize + chipGap : 0;
    ctx.font = `500 ${b.size}px ${MONO}`;
    const name = fit(ctx, cardName(), b.w - chipW - b.size);
    const nameW = ctx.measureText(name).width;
    const nameX = b.align === "right" ? b.x - chipW - nameW : b.x + b.size;
    ctx.textAlign = "left";
    ctx.fillStyle = p.foreground;
    ctx.fillText(name, nameX, b.y);
    statusDot(ctx, nameX - b.size * 0.55, b.y + b.size * 0.55, big ? 6 : Math.max(3, b.size * 0.27), now, p);
    if (chipW) prodChip(ctx, nameX + nameW + chipGap, b.y + (big ? 5 : 3), chipSize, p);
  }

  /** `text` in `b`, in `font`, cut to its width. */
  function textIn(ctx: CanvasRenderingContext2D, b: TextBox, text: string, weight: number, color: string) {
    ctx.font = `${weight} ${b.size}px ${MONO}`;
    ctx.fillStyle = color;
    ctx.textAlign = b.align;
    ctx.fillText(fit(ctx, text, b.w), b.x, b.y);
    ctx.textAlign = "left";
  }

  /**
   * The standby screen in its small forms (ADR 0082): the same clock, host and
   * verdict, pulse, sentence and numbers, smaller, wherever `smallLayout` found
   * room for them — never the old card. No transfer here: it has no room.
   */
  function drawSmall(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal, form: SmallForm) {
    const wall = Date.now();
    const off = offsetMin ?? 0;
    const lay = smallLayout(form, W, H, { session: sessionId != null });
    if (lay.clock) {
      ctx.font = `200 ${lay.clock.size}px ${MONO}`;
      ctx.fillStyle = p.foreground;
      ctx.fillText(clockLabel(wall, off), lay.clock.x - lay.clock.size * 0.04, lay.clock.y);
    }
    if (lay.date) {
      const where = offsetMin == null ? t("idle.localTime") : zone || t("idle.serverTime");
      textIn(ctx, lay.date, `${dateFormat(currentLocale(), false).format(shifted(wall, off))} · ${where}`, 400, muted(p));
    }
    drawHost(ctx, lay.host, now, p, false);
    if (!sessionId) {
      if (lay.verdict) textIn(ctx, lay.verdict, t("idle.noSessions"), 300, muted(p));
      if (lay.hint) hintAt(ctx, lay.hint, p);
      return;
    }
    // How the host is now — the status bar's own verdict, in its words and its level.
    const problems = barProblems(lastMetrics, settings.statusBarThresholds);
    const verdict = verdictLine(lastMetrics != null, problems);
    if (lay.verdict && verdict.kind !== "none") {
      textIn(ctx, lay.verdict, verdictText(verdict), 300, levelColor(verdict.kind === "problem" ? verdict.problem.level : "ok", p));
    }
    // The time away in one sentence: in the pulse's heading, or on lines of its own in a column.
    const story = storyText(awayStory(away, leftAt), wall);
    if (lay.story && story) {
      const cut = story.indexOf(": ");
      const lead = cut < 0 ? story : `${story.slice(0, cut)}:`;
      const body = cut < 0 ? "" : story.slice(cut + 2);
      textIn(ctx, lay.story, lead, 400, muted(p));
      if (body) textIn(ctx, { ...lay.story, y: lay.story.y + lay.story.size + 4 }, body, 400, muted(p));
    }
    const tip = lay.pulse ? drawPulse(ctx, lay.pulse, pulseOf(problems), story, now, p, false) : null;
    if (lay.numbers) drawNumbers(ctx, lay.numbers, p);
    if (tip && lay.pulse) tooltip(ctx, tip.rows, tip.x, tip.gx, tip.gw, tip.gy, lay.pulse.headY ?? lay.pulse.chart.y, tip.bottom, p, false);
    if (lay.hint) hintAt(ctx, lay.hint, p);
  }

  /** The verdict in words: "fine now", or the first problem and how many more. */
  function verdictText(verdict: Exclude<VerdictLine, { kind: "none" }>): string {
    return verdict.kind === "ok"
      ? t("idle.verdictOk")
      : [t(verdict.problem.key, verdict.problem.params), verdict.more ? t("idle.verdictMore", { n: verdict.more }) : ""]
          .filter(Boolean)
          .join(" · ");
  }

  const fmtValue = (key: AwayKey, v: number) => (key === "load" ? v.toFixed(2) : fmtPct(v));
  /** A metric as the heading, the numbers and the tooltip name it… */
  const pulseName = (key: AwayKey) => (key === "cpu" ? "CPU" : key === "mem" ? t("mon.memory") : "LOAD");
  /** …and as the sentence about the time away does. */
  const storyName = (key: AwayKey) =>
    key === "cpu" ? "CPU" : key === "mem" ? t("mon.memory").toLocaleLowerCase(currentLocale()) : "load";

  /** The level a value of `key` stands at against the status bar's thresholds. */
  function levelOf(key: AwayKey, v: number | null, cores: number | null): ThresholdLevel {
    const th = settings.statusBarThresholds;
    if (key === "cpu") return thresholdLevel(v, th.cpu);
    if (key === "mem") return thresholdLevel(v, th.ram);
    return loadHealth(v, v != null && cores ? v / cores : null, th.load);
  }

  /** Where the pulse's metric turns to a warning, in its own units, or null — no threshold for it. */
  function warnLine(key: AwayKey): number | null {
    const th = settings.statusBarThresholds;
    if (key === "cpu") return th.cpu.warn;
    if (key === "mem") return th.ram.warn;
    return cpuCount != null && cpuCount > 0 ? loadZones(cpuCount, th.load).warn : null;
  }

  /**
   * The time away in one sentence (ADR 0075): how long the user was away, then
   * a restart, a metric still over its threshold, the highest peak, the longest
   * stretch nothing was read in — or that nothing happened — and how many more
   * events there were. Empty before the first reading.
   */
  function storyText(story: AwayStory, wall: number): string {
    if (story.kind === "none") return "";
    const off = offsetMin ?? 0;
    let body: string;
    if (story.kind === "calm") body = t("idle.storyCalm");
    else if (story.kind === "reboot") body = t("idle.storyReboot", { time: clockLabel(story.at, off) });
    else if (story.kind === "gap") {
      body = t("idle.storyGap", { span: spanLabel(story.gap.to - story.gap.from), time: clockLabel(story.gap.from, off) });
    } else if (story.kind === "open") {
      body = t("idle.storyOpen", { name: storyName(story.event.key), span: spanLabel(story.event.end - story.event.start) });
    } else {
      const e = story.event;
      body = [
        t("idle.storyPeak", { name: storyName(e.key), peak: fmtValue(e.key, e.peak), time: clockLabel(e.peakAt, off) }),
        procName(e.top),
        e.end > e.start ? spanLabel(e.end - e.start) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    const more = "more" in story && story.more > 0 ? ` · ${t("idle.verdictMore", { n: story.more })}` : "";
    return `${t("idle.away")} (${spanLabel(wall - leftAt)}): ${body}${more}`;
  }

  /** What the tooltip says about what is under the pointer, and the box it may stand in. */
  interface HistoryTip {
    rows: TipRow[];
    x: number;
    gx: number;
    gw: number;
    gy: number;
    bottom: number;
  }

  /** The pointer over the layout as drawn — the burn-in shift taken off — or null when it shows no tooltip. */
  function hovered(): { x: number; y: number } | null {
    if (!pointer || !hoverShown(movedAt, performance.now())) return null;
    const x = pointer.x - drift.dx;
    const y = pointer.y - drift.dy;
    return { x, y };
  }

  /** A line through `pts`, smoothed: a curve through the middles of its segments. */
  function smoothPath(ctx: CanvasRenderingContext2D, pts: readonly { x: number; y: number }[]) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  /**
   * The pulse in the layout's box: one metric over the last `CHART_MS` — CPU,
   * or the one the verdict is about, in that problem's colour over its warning
   * line — the mean of each bucket with a soft fill under it, the newest point
   * breathing at its end, one mark at the highest peak in sight. Above it, the
   * metric on the left and the sentence about the time away on the right; under
   * it, where the window begins and "now". The window slides right to left and
   * never squeezes; a moment is the tooltip's. Returns what the tooltip says
   * about what is under the pointer, or null.
   */
  function drawPulse(
    ctx: CanvasRenderingContext2D,
    lay: PulseBox,
    pulse: PulseOf,
    story: string,
    now: number,
    p: Pal,
    big: boolean,
  ): HistoryTip | null {
    const { x: gx, y: gy, w: gw, h: gh } = lay.chart;
    const key = pulse.key;
    const base = levelColor(pulse.level, p);
    const color = pulse.level === "ok" ? hexAlpha(p.foreground, 0.75) : base;
    // The right edge on its way to the newest poll: the line slides left, the scale holds.
    const to = tweenAt(axisTw, frameAt, ms(LINE_MS)) ?? away.lastAt ?? Date.now();
    const from = chartFrom(to);
    const off = offsetMin ?? 0;
    const pos = (at: number) => timeX(at, from, to, gx, gw);
    const small = `${lay.smallSize}px ${MONO}`;

    // The heading: the metric and its window; the sentence about the time away beside it.
    if (lay.headY != null) {
      const head = `${pulseName(key).toLocaleUpperCase(currentLocale())} · ${spanLabel(CHART_MS)}`;
      ctx.font = `500 ${lay.headSize}px ${MONO}`;
      ctx.fillStyle = muted(p);
      ctx.fillText(head, gx, lay.headY);
      if (story) {
        const room = gw - ctx.measureText(head).width - 24;
        ctx.font = `${lay.headSize}px ${MONO}`;
        ctx.textAlign = "right";
        ctx.fillText(fit(ctx, story, room), gx + gw, lay.headY);
        ctx.textAlign = "left";
      }
    }

    // CPU and memory against 100 %; load against the cores or the highest load
    // in sight — its ceiling moves, never jumps. The top of the box is the mark's.
    const wantTop = loadCeiling(windowPeak(away.buckets, "load", from), cpuCount);
    loadTopTw = retarget(loadTopTw, wantTop, frameAt, ms(SCALE_MS), null);
    const loadTop = tweenAt(loadTopTw, frameAt, ms(SCALE_MS)) ?? wantTop;
    const top = key === "load" ? loadTop : 100;
    const py = gy + lay.markRoom;
    const ph = Math.max(1, gh - lay.markRoom);
    const yOf = (v: number) => py + ph - Math.min(1, Math.max(0, v / top)) * ph;

    const gaps = awayGaps(away.buckets, away.bucketMs, away.pending, away.lastAt);
    const ptr = hovered();
    const onPulse = ptr != null && ptr.y >= gy - HOVER_SLACK && ptr.y <= gy + gh + HOVER_SLACK;
    const hitAt = ptr && onPulse ? timeAtX(ptr.x, from, to, gx, gw) : null;
    const hit = hitAt == null ? null : chartHit(away.buckets, gaps, hitAt, from, to);
    const hitSpan = hit && "span" in hit ? away.buckets[hit.span] : null;

    // Where nothing was read: shaded, and named where there is room. The line breaks there.
    ctx.font = small;
    for (const g of gaps) {
      const x0 = Math.max(gx, pos(g.from));
      const x1 = Math.min(gx + gw, pos(g.to));
      if (x1 - x0 < 1) continue;
      ctx.fillStyle = hexAlpha(p.foreground, hit && "gap" in hit && hit.gap === g ? 0.07 : 0.03);
      ctx.fillRect(x0, py, x1 - x0, ph);
      const text = `${t("idle.tipNoData")} · ${spanLabel(g.to - g.from)}`;
      if (x1 - x0 >= ctx.measureText(text).width + 24) {
        ctx.fillStyle = faint(p);
        ctx.textAlign = "center";
        ctx.fillText(text, (x0 + x1) / 2, py + 4);
        ctx.textAlign = "left";
      }
    }
    // The floor, and the warning line while the verdict is about this metric.
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexAlpha(p.foreground, 0.08);
    ctx.beginPath();
    ctx.moveTo(gx, Math.round(gy + gh) + 0.5);
    ctx.lineTo(gx + gw, Math.round(gy + gh) + 0.5);
    ctx.stroke();
    const warn = pulse.level === "ok" ? null : warnLine(key);
    if (warn != null) {
      const wy = Math.round(yOf(warn)) + 0.5;
      ctx.strokeStyle = hexAlpha(base, 0.35);
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(gx, wy);
      ctx.lineTo(gx + gw, wy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The line — each bucket's mean, smoothed — with a soft fill under it, cut at the box's sides.
    ctx.save();
    ctx.beginPath();
    ctx.rect(gx, gy - 2, gw, gh + 4);
    ctx.clip();
    let end: { x: number; y: number } | null = null;
    for (const run of bandRuns(away.buckets, key, away.bucketMs)) {
      const pts = run.map((pt) => ({ x: pos(pt.at), y: yOf(pt.mean) }));
      if (pts.length > 1) {
        ctx.beginPath();
        smoothPath(ctx, pts);
        ctx.lineTo(pts[pts.length - 1].x, gy + gh);
        ctx.lineTo(pts[0].x, gy + gh);
        ctx.closePath();
        ctx.fillStyle = hexAlpha(base, 0.06);
        ctx.fill();
      }
      ctx.beginPath();
      smoothPath(ctx, pts);
      if (pts.length === 1) ctx.lineTo(pts[0].x + 1, pts[0].y);
      ctx.strokeStyle = color;
      ctx.lineWidth = big ? 2 : 1.6;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.lineJoin = "miter";
      end = pts[pts.length - 1];
    }
    ctx.restore();

    // One mark: the highest peak of this metric in sight — how high, who, when.
    const mark = pulseMark(away.events, key, from, to);
    const mx = mark ? pos(mark.peakAt) : NaN;
    if (mark && lay.markRoom > 0 && mx >= gx && mx <= gx + gw) {
      const my = yOf(mark.peak);
      ctx.fillStyle = levelColor(mark.level, p);
      ctx.beginPath();
      ctx.arc(mx, my, big ? 4 : 3, 0, 7);
      ctx.fill();
      const text = [fmtValue(key, mark.peak), procName(mark.top), clockLabel(mark.peakAt, off)].filter(Boolean).join(" · ");
      ctx.font = small;
      const half = ctx.measureText(text).width / 2;
      ctx.textAlign = "center";
      ctx.fillText(text, Math.min(gx + gw - half, Math.max(gx + half, mx)), Math.max(gy, my - (big ? 24 : 18)));
      ctx.textAlign = "left";
    }

    // Where the line is now — breathing — unless the newest poll read nothing.
    if (end && away.pending == null && end.x <= gx + gw + 0.5) {
      const breath = 0.5 + 0.5 * Math.sin(now / 620);
      ctx.fillStyle = hexAlpha(base, 0.1 + 0.2 * breath);
      ctx.beginPath();
      ctx.arc(end.x, end.y, big ? 9 : 7, 0, 7);
      ctx.fill();
      ctx.fillStyle = p.background;
      ctx.beginPath();
      ctx.arc(end.x, end.y, big ? 4.5 : 3.5, 0, 7);
      ctx.fill();
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.arc(end.x, end.y, big ? 3.2 : 2.6, 0, 7);
      ctx.fill();
    }

    // The moment under the pointer: a thin line down the box, a dot on the line.
    let tip: HistoryTip | null = null;
    if (hitSpan) {
      const hx = Math.round(pos(spanMid(hitSpan))) + 0.5;
      ctx.strokeStyle = hexAlpha(p.foreground, 0.22);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, py);
      ctx.lineTo(hx, gy + gh);
      ctx.stroke();
      const a = hitSpan[key];
      if (a) {
        ctx.fillStyle = base;
        ctx.beginPath();
        ctx.arc(hx, yOf(a.sum / a.n), big ? 3.5 : 3, 0, 7);
        ctx.fill();
      }
      tip = { rows: bucketRows(key, hitSpan, p), x: hx, gx, gw, gy, bottom: gy + gh };
    } else if (hit && "gap" in hit) {
      const x0 = Math.max(gx, pos(hit.gap.from));
      const x1 = Math.min(gx + gw, pos(hit.gap.to));
      tip = { rows: gapRows(hit.gap), x: (x0 + x1) / 2, gx, gw, gy, bottom: gy + gh };
    }

    // Where the window begins, and "now".
    if (lay.axisY != null) {
      ctx.font = small;
      ctx.fillStyle = faint(p);
      ctx.fillText(clockLabel(from, off), gx, lay.axisY);
      ctx.textAlign = "right";
      ctx.fillText(t("idle.now"), gx + gw, lay.axisY);
      ctx.textAlign = "left";
    }
    return tip;
  }

  /**
   * The four numbers under the pulse — CPU, memory, load, disk — each running
   * to its reading, in the foreground colour until it crosses its threshold.
   */
  function drawNumbers(ctx: CanvasRenderingContext2D, box: NumbersBox, p: Pal) {
    const sCpu = shown(shownTw.cpu);
    const sMem = shown(shownTw.mem);
    const sLoad = shown(shownTw.load);
    const sDisk = shown(shownTw.disk);
    const items: [label: string, value: string, level: ThresholdLevel][] = [
      [pulseName("cpu"), fmtPct(sCpu), levelOf("cpu", sCpu, cpuCount)],
      [pulseName("mem"), fmtPct(sMem), levelOf("mem", sMem, cpuCount)],
      [pulseName("load"), sLoad == null ? "—" : sLoad.toFixed(2), levelOf("load", sLoad, cpuCount)],
      [t("idle.factDisk"), fmtPct(sDisk), thresholdLevel(sDisk, settings.statusBarThresholds.disk)],
    ];
    const upper = (label: string) => label.toLocaleUpperCase(currentLocale());
    if (box.kind === "line") {
      // One line of `LABEL value`, as many whole ones as the width holds.
      const gap = box.size * 1.4;
      let x = box.x;
      for (const [label, value, level] of items) {
        ctx.font = `500 ${box.size}px ${MONO}`;
        const lw = ctx.measureText(`${upper(label)} `).width;
        const vw = ctx.measureText(value).width;
        if (x + lw + vw > box.x + box.w) break;
        ctx.fillStyle = muted(p);
        ctx.fillText(`${upper(label)} `, x, box.y);
        ctx.fillStyle = levelColor(level, p);
        ctx.fillText(value, x + lw, box.y);
        x += lw + vw + gap;
      }
      return;
    }
    // A grid: a label over its value, `cols` to a row.
    const cw = box.w / box.cols;
    const rowH = box.labelSize + box.gap + box.valueSize + box.rowGap;
    items.forEach(([label, value, level], i) => {
      const x = box.x + (i % box.cols) * cw;
      const y = box.y + Math.floor(i / box.cols) * rowH;
      ctx.font = `500 ${box.labelSize}px ${MONO}`;
      ctx.fillStyle = muted(p);
      ctx.fillText(fit(ctx, upper(label), cw - 12), x, y);
      ctx.font = `200 ${box.valueSize}px ${MONO}`;
      ctx.fillStyle = levelColor(level, p);
      ctx.fillText(fit(ctx, value, cw - 12), x - box.valueSize * 0.04, y + box.labelSize + box.gap);
    });
  }

  /** One line of the tooltip. */
  type TipRow =
    | { kind: "head"; text: string }
    | { kind: "metric"; label: string; value: string; valueColor: string; aside: string }
    | { kind: "note"; text: string; aside: string };

  /** "14:02–14:10", or one time when both read the same. */
  function clockRange(a: number, b: number): string {
    const off = offsetMin ?? 0;
    const from = clockLabel(a, off);
    const to = clockLabel(b, off);
    return from === to ? from : `${from}–${to}`;
  }

  /** A stretch of the pulse nothing was read in: when, how long, and why. */
  function gapRows(g: AwayGap): TipRow[] {
    return [
      { kind: "head", text: `${clockRange(g.from, g.to)} · ${spanLabel(g.to - g.from)}` },
      {
        kind: "note",
        text: t("idle.tipNoData"),
        aside: t(g.kind === "failed" ? "idle.tipPollFailed" : "idle.tipNotPolled"),
      },
    ];
  }

  /** A bucket of the pulse, short: when, the metric's mean coloured by the thresholds, the busiest process. */
  function bucketRows(key: AwayKey, s: AwaySpan, p: Pal): TipRow[] {
    const a = s[key];
    const mean = a ? a.sum / a.n : null;
    return [
      { kind: "head", text: clockRange(s.first, s.last) },
      {
        kind: "metric",
        label: pulseName(key).toLocaleUpperCase(currentLocale()),
        value: mean == null ? "—" : fmtValue(key, mean),
        valueColor: levelColor(levelOf(key, mean, s.cores), p),
        // The busiest process is CPU's: it says nothing of memory.
        aside: key === "mem" ? "" : s.top,
      },
    ];
  }

  /** The tooltip: right of the point, left of it at the pulse's right edge, inside `top…bottom`. */
  function tooltip(
    ctx: CanvasRenderingContext2D,
    rows: TipRow[],
    x: number,
    gx: number,
    gw: number,
    gy: number,
    top: number,
    bottom: number,
    p: Pal,
    big: boolean,
  ) {
    const s = big ? 13 : 11;
    const lh = Math.round(s * 1.75);
    const padX = big ? 14 : 10;
    const padY = big ? 8 : 6;
    const rowH = (r: TipRow) => (r.kind === "note" ? lh + Math.round(lh * 0.8) : lh);
    const F = {
      head: `600 ${s}px ${MONO}`,
      body: `${s}px ${MONO}`,
      label: `500 ${s - 1}px ${MONO}`,
      value: `500 ${s}px ${MONO}`,
    };
    const textW = (font: string, text: string) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    const labelW = Math.max(0, ...rows.map((r) => (r.kind === "metric" ? textW(F.label, r.label) : 0))) + s * 0.8;
    const widthOf = (r: TipRow): number => {
      if (r.kind === "head") return textW(F.head, r.text);
      if (r.kind === "metric") return labelW + textW(F.value, r.value) + (r.aside ? 14 + textW(F.body, r.aside) : 0);
      return Math.max(textW(F.body, r.text), textW(F.body, r.aside));
    };
    const inner = Math.min(Math.min(gw, big ? 420 : 320) - padX * 2, Math.max(...rows.map(widthOf)));
    const w = inner + padX * 2;
    const h = padY * 2 + rows.reduce((sum, r) => sum + rowH(r), 0);
    const gapX = big ? 16 : 12;
    let bx = x + gapX + w > gx + gw ? x - gapX - w : x + gapX;
    bx = Math.max(gx, bx);
    const by = Math.max(top, Math.min(gy + (big ? 14 : 8), bottom - h));
    const r = big ? 10 : 7;
    ctx.fillStyle = p.background;
    roundRect(ctx, bx, by, w, h, r);
    ctx.fill();
    ctx.fillStyle = hexAlpha(p.foreground, 0.07);
    roundRect(ctx, bx, by, w, h, r);
    ctx.fill();
    ctx.strokeStyle = hexAlpha(p.foreground, 0.16);
    ctx.lineWidth = 1;
    roundRect(ctx, bx + 0.5, by + 0.5, w - 1, h - 1, r);
    ctx.stroke();
    const x0 = bx + padX;
    const right = bx + w - padX;
    let y = by + padY;
    for (const row of rows) {
      const ty = y + (lh - s) / 2;
      if (row.kind === "head") {
        ctx.font = F.head;
        ctx.fillStyle = p.foreground;
        ctx.fillText(fit(ctx, row.text, inner), x0, ty);
      } else if (row.kind === "metric") {
        ctx.font = F.label;
        ctx.fillStyle = muted(p);
        ctx.fillText(row.label, x0, ty + 1);
        ctx.font = F.value;
        ctx.fillStyle = row.valueColor;
        ctx.fillText(row.value, x0 + labelW, ty);
        if (row.aside) {
          const ax = x0 + labelW + ctx.measureText(row.value).width + 14;
          ctx.font = F.body;
          ctx.fillStyle = faint(p);
          ctx.fillText(fit(ctx, row.aside, right - ax), ax, ty);
        }
      } else {
        ctx.font = F.body;
        ctx.fillStyle = p.foreground;
        ctx.fillText(fit(ctx, row.text, inner), x0, ty);
        ctx.fillStyle = muted(p);
        ctx.fillText(fit(ctx, row.aside, inner), x0, ty + Math.round(lh * 0.8));
      }
      y += rowH(row);
    }
  }

  /** A transfer under way: what moves where, how far along, how fast; a bar along the bottom. */
  function drawTransfer(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    p: Pal,
    big: boolean,
    tr: StandbyTransfer,
  ) {
    const pad = big ? 22 : 12;
    const r = big ? 14 : 9;
    // The bar and its percentage run to each progress report; another transfer starts in place.
    bar = bar.id === tr.row.id ? { id: bar.id, tw: retarget(bar.tw, tr.pct, frameAt, ms(BAR_MS)) } : { id: tr.row.id, tw: still(tr.pct) };
    const pct = tweenAt(bar.tw, frameAt, ms(BAR_MS)) ?? tr.pct;
    ctx.fillStyle = hexAlpha(p.blue, 0.07);
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.strokeStyle = hexAlpha(p.blue, 0.22);
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
    ctx.stroke();
    const ic = big ? 18 : 12;
    const icx = x + pad + ic;
    const icy = y + h / 2 - (big ? 3 : 2);
    ctx.fillStyle = hexAlpha(p.blue, 0.16);
    ctx.beginPath();
    ctx.arc(icx, icy, ic, 0, 7);
    ctx.fill();
    ctx.fillStyle = p.blue;
    ctx.font = `${Math.round(ic * 1.1)}px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tr.row.direction === "upload" ? "↑" : tr.row.direction === "download" ? "↓" : "→", icx, icy + 1);
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillStyle = p.foreground;
    ctx.font = `200 ${big ? 30 : 18}px ${MONO}`;
    ctx.fillText(`${Math.round(pct)}%`, x + w - pad, y + (big ? 14 : 8));
    let rightW = ctx.measureText("100%").width;
    if (big && tr.more > 0) {
      ctx.font = `12px ${MONO}`;
      ctx.fillStyle = muted(p);
      const more = t("idle.moreTransfers", { count: tr.more });
      ctx.fillText(more, x + w - pad, y + 50);
      rightW = Math.max(rightW, ctx.measureText(more).width);
    }
    ctx.textAlign = "left";
    const tx = icx + ic + (big ? 16 : 10);
    const room = x + w - pad - rightW - 16 - tx;
    const row = tr.row;
    const dest = row.destDir ? (big && row.dstLabel ? `${row.dstLabel}:${row.destDir}` : row.destDir) : "";
    ctx.font = `${big ? 16 : 12}px ${MONO}`;
    const nameText = fit(ctx, row.name, dest ? room * 0.6 : room);
    ctx.fillStyle = p.foreground;
    ctx.fillText(nameText, tx, y + (big ? 18 : 9));
    if (dest) {
      const nw = ctx.measureText(`${nameText} `).width;
      ctx.fillStyle = muted(p);
      ctx.fillText(fit(ctx, `→ ${dest}`, room - nw), tx + nw, y + (big ? 18 : 9));
    }
    const detail = [
      big && row.srcLabel ? t("idle.from", { name: row.srcLabel }) : "",
      row.fileCount ? t("idle.fileOf", { i: Math.min((row.fileIndex ?? 0) + 1, row.fileCount), n: row.fileCount }) : "",
      `${fmtBytes(row.transferred)} / ${fmtBytes(row.total)}`,
      fmtRate(tr.rate),
      tr.eta != null ? t("sftp.eta", { time: fmtEta(tr.eta) }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    ctx.font = `${big ? 13 : 11}px ${MONO}`;
    ctx.fillStyle = muted(p);
    ctx.fillText(fit(ctx, detail, room), tx, y + (big ? 44 : 27));
    // The bar, clipped to the strip's rounded corners.
    const bh = big ? 5 : 3;
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.fillStyle = hexAlpha(p.blue, 0.12);
    ctx.fillRect(x, y + h - bh, w, bh);
    ctx.fillStyle = p.blue;
    ctx.fillRect(x, y + h - bh, (w * pct) / 100, bh);
    ctx.restore();
  }

  /** The `prod` chip beside the host, the same word the tab carries. */
  function prodChip(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, p: Pal) {
    ctx.font = `500 ${size}px ${MONO}`;
    const w = ctx.measureText("prod").width + size;
    const padY = size * 0.3;
    ctx.strokeStyle = hexAlpha(p.red, 0.65);
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y - padY + 0.5, w, size + padY * 2, size * 0.45);
    ctx.stroke();
    ctx.fillStyle = p.red;
    ctx.fillText("prod", x + size * 0.5, y);
  }

  /** The red frame a production terminal carries, along the edge of the area — it does not shift. */
  function prodFrame(ctx: CanvasRenderingContext2D, W: number, H: number, p: Pal) {
    ctx.strokeStyle = hexAlpha(p.red, 0.6);
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
  }

  // ── small canvas helpers ────────────────────────────────────────────────────
  function hint(ctx: CanvasRenderingContext2D, W: number, H: number, p: Pal) {
    hintAt(ctx, { x: W / 2, y: H - 28, size: 12, align: "center", w: W - 32 }, p);
  }
  /** "Press any key" where a layout put it. */
  function hintAt(ctx: CanvasRenderingContext2D, b: TextBox, p: Pal) {
    textIn(ctx, b, t("idle.dismissHint"), 400, hexAlpha(p.foreground, 0.28));
  }
  function scanlines(ctx: CanvasRenderingContext2D, W: number, H: number) {
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
  }
  function vignette(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.38, W / 2, H / 2, W * 0.72);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.42)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // Apply an alpha to a #rrggbb (or #rgb) theme colour; falls back opaque.
  function hexAlpha(hex: string, a: number): string {
    const h = hex?.replace("#", "") ?? "";
    let r: number, g: number, b: number;
    if (h.length === 6) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    } else if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
    } else {
      return hex;
    }
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
  }

  // Rebuild per-effect state when the shown effect changes.
  $effect(() => {
    void shownEffect;
    mx = null;
    px = null;
  });
</script>

{#if active}
  <canvas
    bind:this={canvas}
    tabindex="-1"
    data-testid="idle-overlay"
    aria-hidden="true"
    onpointermove={onPointerMove}
    onpointerleave={onPointerLeave}
    style="position:fixed;left:0;top:0;z-index:35;outline:none;"
  ></canvas>
{/if}
