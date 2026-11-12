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
  import {
    bufferGrid,
    cardTier,
    clipText,
    HIST_KEEP,
    HIST_POINTS,
    idleSample,
    NO_SAMPLE,
    pushSample,
    tokenizeBuffer,
    type CardTier,
    type IdleSample,
    type WordToken,
  } from "./idlefx";
  import {
    awayGaps,
    awayPush,
    bandRuns,
    chartFrom,
    chartHit,
    CHART_MS,
    clockLabel,
    shiftOffset,
    emptyAway,
    eventsAt,
    gapReading,
    gutterRing,
    historyLayout,
    HOVER_SLACK,
    HOVER_STILL_MS,
    hoverShown,
    loadCeiling,
    ringFraction,
    serverOffset,
    serverZone,
    shifted,
    silentSince,
    slotGap,
    spanLabel,
    spanMid,
    standbyTransfer,
    stripHit,
    stripSlots,
    stripView,
    stripX,
    swapShare,
    timeAtX,
    timeRuns,
    timeTicks,
    timeX,
    verdictLine,
    windowPeak,
    type AwayGap,
    type AwayHistory,
    type AwayKey,
    type AwayReading,
    type AwaySpan,
    type AwayThresholds,
    type GapKind,
    type HistoryLayout,
    type StandbyTransfer,
    type StripSlot,
    type StripView,
  } from "./standby";
  import {
    BAR_MS,
    easeOut,
    LINE_MS,
    MERGE_MS,
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
  import { diskFree, fmtBytes, fmtPct, fmtRate, fmtUptime, memPct } from "../monitoring/format";
  import { thresholdLevel, type ThresholdLevel } from "../monitoring/thresholds";
  import { loadHealth } from "../monitoring/monhealth";
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
  let uptimeSecs: number | null = null;
  let host = "";
  let hist: IdleSample[] = [];
  // Stops watching the session's feed (stores/metricsfeed): the card reads the
  // same polls as the status bar instead of asking on a timer of its own.
  let unwatch: (() => void) | undefined;
  // What the standby screen adds (v1.31), each null/"" until reported.
  let load5: number | null = null;
  let load15: number | null = null;
  let memUsed: number | null = null;
  let memTotal: number | null = null;
  let diskUsed: number | null = null;
  let diskTotal: number | null = null;
  let cpuTemp: number | null = null;
  // The newest reading whole: the verdict and the facts above the charts read it (ADR 0065).
  let lastMetrics: Metrics | null = null;
  let osName = "";
  let login = "";
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
  type ShownKey = "cpu" | "mem" | "load" | "disk" | "swap" | "rx" | "tx" | "temp";
  function noneShown(): Record<ShownKey, Tween> {
    return { cpu: still(null), mem: still(null), load: still(null), disk: still(null), swap: still(null), rx: still(null), tx: still(null), temp: still(null) };
  }
  // The history's right edge (wall-clock ms) and the small chart's (sample number).
  let axisTw: Tween = still(null);
  let histTw: Tween = still(null);
  // The number of the newest sample in `hist`.
  let histSeq = -1;
  // The top of the load chart, moving to a new ceiling rather than jumping.
  let loadTopTw: Tween = still(null);
  // The strip as drawn, and the one it stepped up from, fading out under it.
  let strip: { view: StripView; was: StripView | null; at: number } | null = null;
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

  /** One more sample of the small cards' chart. */
  function pushHist(s: IdleSample) {
    hist = pushSample(hist, s, HIST_KEEP);
    histSeq += 1;
  }

  const awayThresholds = (): AwayThresholds => ({
    cpu: settings.statusBarThresholds.cpu,
    ram: settings.statusBarThresholds.ram,
    load: settings.statusBarThresholds.load,
  });

  /** One poll of the feed: a reading at `at`, or null — that poll failed. */
  function onReading(m: Metrics | null, at = Date.now()) {
    // A silence longer than a gap — a hidden window skips its polls, a sleeping
    // computer makes none — breaks the small chart too: nothing was read in it.
    if (silentSince(away.lastAt, at, away.gapMs)) pushHist(NO_SAMPLE);
    if (m) {
      cpu = m.cpuPct ?? cpu;
      mem = memPct(m.memUsed, m.memTotal) ?? mem;
      load1 = m.load1;
      cpuCount = m.cpuCount ?? cpuCount;
      uptimeSecs = m.uptimeSecs ?? uptimeSecs;
      host = m.hostname || alias || host;
      pushHist(idleSample(m.cpuPct, memPct(m.memUsed, m.memTotal), load1, cpuCount));
      load5 = m.load5;
      load15 = m.load15;
      memUsed = m.memUsed;
      memTotal = m.memTotal;
      diskUsed = m.diskUsed;
      diskTotal = m.diskTotal;
      cpuTemp = m.cpuTemp;
      lastMetrics = m;
      osName = m.prettyName || m.os;
      login = m.user && m.ip ? `${m.user}@${m.ip}` : m.user || m.ip;
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
      });
    } else {
      // The numbers keep their last values, but the history does not pretend
      // to have seen this moment: a gap, not a line drawn through it.
      pushHist(NO_SAMPLE);
      remember(gapReading(at));
    }
    // What is shown sets off towards the reading from wherever it stands.
    const t = performance.now();
    const swap = swapShare(lastMetrics?.swapUsed ?? null, lastMetrics?.swapTotal ?? null);
    shownTw = {
      cpu: retarget(shownTw.cpu, cpu, t, ms(RING_MS)),
      mem: retarget(shownTw.mem, mem, t, ms(RING_MS)),
      load: retarget(shownTw.load, load1, t, ms(RING_MS)),
      disk: retarget(shownTw.disk, diskUsed != null && diskTotal ? (diskUsed / diskTotal) * 100 : null, t, ms(RING_MS)),
      swap: retarget(shownTw.swap, typeof swap === "number" ? swap * 100 : null, t, ms(RING_MS)),
      rx: retarget(shownTw.rx, lastMetrics?.netRxRate ?? null, t, ms(RING_MS), null),
      tx: retarget(shownTw.tx, lastMetrics?.netTxRate ?? null, t, ms(RING_MS), null),
      temp: retarget(shownTw.temp, cpuTemp, t, ms(RING_MS), null),
    };
    histTw = retarget(histTw, histSeq < 0 ? null : histSeq, t, ms(LINE_MS), null);
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
      hist = [];
      cpu = mem = load1 = cpuCount = uptimeSecs = null;
      load5 = load15 = memUsed = memTotal = diskUsed = diskTotal = cpuTemp = offsetMin = null;
      lastMetrics = null;
      osName = login = zone = "";
      away = emptyAway(pollEveryMs(false));
      shownTw = noneShown();
      axisTw = histTw = loadTopTw = still(null);
      histSeq = -1;
      strip = null;
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

  // Server card with a CPU / memory / load chart. The terminal area is whatever
  // the docks leave, so the card is laid out for the room there is (`cardTier`):
  // the card itself, or one of its smaller forms.
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
    else if (tier === "full") drawCardFull(ctx, W, H, now, p);
    else if (tier === "wide" || tier === "row") drawCardWide(ctx, W, H, now, p, tier === "wide");
    else if (tier === "stack") drawCardStack(ctx, W, H, now, p);
    else drawCardSmall(ctx, W, H, now, p, tier === "mini");
  }

  const MONO = "ui-monospace,Menlo,monospace";
  type CardMetric = [label: string, value: string, color: string, key: keyof IdleSample];
  // The dot before each label is the legend of its chart line. The numbers
  // count to each reading (`shown`).
  function cardMetrics(p: Pal): CardMetric[] {
    const load = shown(shownTw.load);
    return [
      ["CPU", fmtPct(shown(shownTw.cpu)), p.green, "cpu"],
      ["MEM", fmtPct(shown(shownTw.mem)), p.blue, "mem"],
      ["LOAD", load != null ? load.toFixed(2) : "—", p.yellow, "load"],
    ];
  }
  const cardName = () => host || alias || "vterm";
  // The line under (or beside) the host: a clock without a session to report on.
  function cardStatus(): string {
    if (sessionId) {
      return `${t("idle.online")} · ${t("idle.uptime")} ${uptimeSecs != null ? fmtUptime(uptimeSecs) : "—"}`;
    }
    const d = new Date();
    const pad = (n: number) => `${n}`.padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
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
  // The dashed top line is 100 % (load = every core busy); the axes are drawn
  // even before data, so the chart area is always visible — a near-idle CPU
  // line otherwise hugs the floor unseen.
  function chartAxes(ctx: CanvasRenderingContext2D, gx: number, gy: number, gw: number, gh: number, p: Pal) {
    ctx.strokeStyle = hexAlpha(p.foreground, 0.22);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(gx, gy + 0.5);
    ctx.lineTo(gx + gw, gy + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(gx + 0.5, gy);
    ctx.lineTo(gx + 0.5, gy + gh + 0.5);
    ctx.lineTo(gx + gw, gy + gh + 0.5);
    ctx.stroke();
  }
  function drawSeries(
    ctx: CanvasRenderingContext2D,
    key: keyof IdleSample,
    color: string,
    gx: number,
    gy: number,
    gw: number,
    gh: number,
    fill: boolean,
  ) {
    // Samples are placed by number; the right edge runs to the newest, so a new
    // sample draws itself on and, once the chart is full, the line slides left.
    const end = tweenAt(histTw, frameAt, ms(LINE_MS));
    if (end == null) return;
    const first = histSeq - (hist.length - 1);
    const pts = hist.map((sample, i) => ({ ...sample, at: first + i }));
    const runs = timeRuns(pts, key, Math.max(first, end - (HIST_POINTS - 1)), end, gx, gy, gw, gh);
    for (const run of runs) {
      if (fill && run.length > 1) {
        ctx.beginPath();
        ctx.moveTo(run[0].x, gy + gh);
        run.forEach((pt) => ctx.lineTo(pt.x, pt.y));
        ctx.lineTo(run[run.length - 1].x, gy + gh);
        ctx.closePath();
        ctx.fillStyle = hexAlpha(color, 0.1);
        ctx.fill();
      }
      ctx.beginPath();
      run.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      if (run.length === 1) ctx.lineTo(run[0].x + 1, run[0].y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  // Three series on one 0…1 axis. Only CPU gets the soft fill — three filled
  // areas would muddy each other.
  function sharedChart(ctx: CanvasRenderingContext2D, gx: number, gy: number, gw: number, gh: number, p: Pal) {
    chartAxes(ctx, gx, gy, gw, gh, p);
    drawSeries(ctx, "mem", p.blue, gx, gy, gw, gh, false);
    drawSeries(ctx, "load", p.yellow, gx, gy, gw, gh, false);
    drawSeries(ctx, "cpu", p.green, gx, gy, gw, gh, true);
  }

  // The card (the Away layout): header, three large numbers, the chart below.
  function drawCardFull(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal) {
    const cardW = Math.min(560, W - 80);
    const cardH = Math.min(320, H - 80);
    const x = (W - cardW) / 2;
    const y = (H - cardH) / 2;
    ctx.fillStyle = hexAlpha(p.foreground, 0.04);
    roundRect(ctx, x, y, cardW, cardH, 14);
    ctx.fill();
    statusDot(ctx, x + 30, y + 34, 5, now, p);
    ctx.fillStyle = p.foreground;
    ctx.font = "500 18px ui-monospace,Menlo,monospace";
    ctx.fillText(fit(ctx, cardName(), cardW - 68), x + 44, y + 27);
    ctx.fillStyle = hexAlpha(p.foreground, 0.55);
    ctx.font = "12px ui-monospace,monospace";
    ctx.fillText(cardStatus(), x + 44, y + 48);
    if (!sessionId) {
      ctx.fillStyle = p.foreground;
      ctx.font = "500 15px ui-monospace,monospace";
      ctx.textAlign = "center";
      ctx.fillText(t("idle.noSessions"), W / 2, y + cardH / 2);
      ctx.textAlign = "left";
    } else {
      const cw = (cardW - 60) / 3;
      cardMetrics(p).forEach(([label, val, color], i) => {
        const mx0 = x + 30 + i * cw;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(mx0 + 3, y + 89.5, 3, 0, 7);
        ctx.fill();
        ctx.fillStyle = hexAlpha(p.foreground, 0.55);
        ctx.font = "500 11px ui-monospace,monospace";
        ctx.fillText(label, mx0 + 11, y + 84);
        ctx.fillStyle = p.foreground;
        ctx.font = "200 34px ui-monospace,monospace";
        ctx.fillText(val, mx0, y + 96);
      });
      // Below the numbers (≈ y+140) down to a 24 px margin; shrinks on a short card.
      const gh = Math.max(24, Math.min(100, cardH - 164));
      sharedChart(ctx, x + 24, y + cardH - 24 - gh, cardW - 48, gh, p);
    }
    hint(ctx, W, H, p);
  }

  // Low and wide: the numbers join the header line and the chart takes all the
  // room under it. Without `chart` (too low for one) — that line alone.
  function drawCardWide(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    now: number,
    p: Pal,
    chart: boolean,
  ) {
    const top = chart ? 14 : Math.max(0, H / 2 - 9);
    // Numbers stand at the right end; the host takes what is left of the line.
    let right = W - 18;
    if (sessionId) {
      for (const [label, val, color] of cardMetrics(p).reverse()) {
        ctx.font = `500 14px ${MONO}`;
        const vw = ctx.measureText(val).width;
        ctx.fillStyle = p.foreground;
        ctx.fillText(val, right - vw, top);
        ctx.font = `500 11px ${MONO}`;
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = hexAlpha(p.foreground, 0.55);
        ctx.fillText(label, right - vw - 6 - lw, top + 2);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(right - vw - lw - 14, top + 8, 3, 0, 7);
        ctx.fill();
        right -= vw + lw + 34;
      }
    }
    statusDot(ctx, 22, top + 8, 4, now, p);
    ctx.font = `500 14px ${MONO}`;
    const name = fit(ctx, cardName(), right - 34);
    ctx.fillStyle = p.foreground;
    ctx.fillText(name, 34, top);
    const after = 34 + ctx.measureText(name).width + 10;
    ctx.font = `11px ${MONO}`;
    const status = `· ${cardStatus()}`;
    if (after + ctx.measureText(status).width <= right) {
      ctx.fillStyle = hexAlpha(p.foreground, 0.55);
      ctx.fillText(status, after, top + 2);
    }
    if (!chart) return;
    if (!sessionId) {
      ctx.fillStyle = p.foreground;
      ctx.font = `500 13px ${MONO}`;
      ctx.textAlign = "center";
      ctx.fillText(t("idle.noSessions"), W / 2, 46 + (H - 46) / 2 - 8);
      ctx.textAlign = "left";
      return;
    }
    sharedChart(ctx, 16, 46, W - 32, H - 46 - 14, p);
  }

  // Narrow and tall: a column of three rows, each number with a line of its own
  // (so no legend is needed). The column is centred in an area taller than it.
  function drawCardStack(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal) {
    const head = 74;
    const rh = Math.min(96, (H - head - 16) / 3);
    const y = Math.max(0, (H - head - rh * 3) / 2 - 4);
    statusDot(ctx, 24, y + 27, 4, now, p);
    ctx.font = `500 15px ${MONO}`;
    ctx.fillStyle = p.foreground;
    ctx.fillText(fit(ctx, cardName(), W - 52), 36, y + 18);
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = hexAlpha(p.foreground, 0.55);
    ctx.fillText(fit(ctx, cardStatus(), W - 52), 36, y + 40);
    if (!sessionId) {
      ctx.fillStyle = p.foreground;
      ctx.font = `500 13px ${MONO}`;
      ctx.fillText(fit(ctx, t("idle.noSessions"), W - 40), 20, y + head + 12);
      return;
    }
    cardMetrics(p).forEach(([label, val, color, key], i) => {
      const ry = y + head + i * rh;
      ctx.fillStyle = hexAlpha(p.foreground, 0.04);
      roundRect(ctx, 14, ry, W - 28, rh - 8, 10);
      ctx.fill();
      ctx.fillStyle = hexAlpha(p.foreground, 0.55);
      ctx.font = `500 11px ${MONO}`;
      ctx.fillText(label, 26, ry + 8);
      ctx.fillStyle = p.foreground;
      ctx.font = `300 22px ${MONO}`;
      ctx.fillText(val, 26, ry + 23);
      drawSeries(ctx, key, color, 120, ry + 10, W - 146, rh - 28, true);
    });
  }

  // No room for a chart: the host over the three numbers (`numbers`), or — in an
  // area that fits nothing else — the host alone.
  function drawCardSmall(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    now: number,
    p: Pal,
    numbers: boolean,
  ) {
    if (!numbers) {
      statusDot(ctx, 18, H / 2, 4, now, p);
      ctx.font = `500 14px ${MONO}`;
      ctx.fillStyle = p.foreground;
      ctx.fillText(fit(ctx, cardName(), W - 42), 30, H / 2 - 8);
      return;
    }
    const cy = H / 2 - 3;
    statusDot(ctx, 24, cy - 27, 4, now, p);
    ctx.font = `500 14px ${MONO}`;
    ctx.fillStyle = p.foreground;
    ctx.fillText(fit(ctx, cardName(), W - 52), 36, cy - 36);
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = hexAlpha(p.foreground, 0.55);
    ctx.fillText(fit(ctx, cardStatus(), W - 52), 36, cy - 15);
    if (!sessionId) {
      ctx.fillStyle = p.foreground;
      ctx.font = `500 12px ${MONO}`;
      ctx.fillText(fit(ctx, t("idle.noSessions"), W - 40), 20, cy + 16);
      return;
    }
    const cw = (W - 40) / 3;
    cardMetrics(p).forEach(([label, val, color], i) => {
      const mx0 = 20 + i * cw;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(mx0 + 3, cy + 18, 3, 0, 7);
      ctx.fill();
      ctx.fillStyle = hexAlpha(p.foreground, 0.55);
      ctx.font = `500 11px ${MONO}`;
      ctx.fillText(label, mx0 + 10, cy + 12);
      ctx.fillStyle = p.foreground;
      ctx.font = `500 15px ${MONO}`;
      ctx.fillText(val, mx0, cy + 28);
    });
  }

  // ── The standby screen (v1.31) ───────────────────────────────────────────────
  // For an area with room to spare: the server's clock beside the host and four
  // rings (CPU, MEM, LOAD against the cores, DISK), under them the history of the
  // whole time away with what happened in it, and a transfer under way under
  // that. `big` — the full form (`standby`), else the short one (`compact`).
  // What is shown and when is standby.ts; this only paints it.
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
    const P = big ? 64 : 26;
    const wall = Date.now();
    const off = offsetMin ?? 0;
    // The clock: the server's, run live from its offset; this machine's when it did not say.
    // The short form grows with a wide area too (a low strip under a raised dock),
    // but stays within what its fixed lines beside it allow.
    const f = big ? Math.min(H * 0.2, W * 0.115) : Math.min(H * 0.16, Math.max(74, W * 0.06), 110);
    const rx0 = big ? Math.max(P + f * 3.2, W * 0.5) : Math.max(P + f * 3.3, W * 0.38);
    const leftW = rx0 - P - 20;
    ctx.fillStyle = p.foreground;
    ctx.font = `200 ${Math.round(f)}px ${MONO}`;
    ctx.fillText(clockLabel(wall, off), P - f * 0.04, P - f * 0.06);
    const date = dateFormat(currentLocale(), big).format(shifted(wall, off));
    const where =
      offsetMin == null
        ? t("idle.localTime")
        : big
          ? [t("idle.serverTime"), zone].filter(Boolean).join(", ")
          : zone || t("idle.serverTime");
    const df = big ? Math.round(f * 0.1) : 11;
    ctx.font = `${df}px ${MONO}`;
    ctx.fillStyle = muted(p);
    const dateY = P + f * 0.98;
    ctx.fillText(fit(ctx, `${date} · ${where}`, leftW), P, dateY);
    if (offsetMin != null && offsetMin !== 0) {
      ctx.font = `${big ? Math.round(f * 0.077) : 11}px ${MONO}`;
      ctx.fillStyle = faint(p);
      ctx.fillText(fit(ctx, t("idle.yourTime", { time: clockLabel(wall, 0) }), leftW), P, dateY + (big ? f * 0.15 : 16));
    }

    // The host, a `prod` chip, how it is.
    const rw = W - P - rx0;
    const nx = rx0 + (big ? 28 : 18);
    statusDot(ctx, rx0 + (big ? 9 : 6), P + (big ? 18 : 9), big ? 7 : 5, now, p);
    ctx.font = `500 ${big ? 30 : 17}px ${MONO}`;
    ctx.fillStyle = p.foreground;
    const chipW = prod && sessionId ? (big ? 64 : 46) : 0;
    const name = fit(ctx, cardName(), rw - (nx - rx0) - chipW);
    ctx.fillText(name, nx, P + (big ? 2 : 1));
    if (chipW) prodChip(ctx, nx + ctx.measureText(name).width + (big ? 14 : 10), P + (big ? 5 : 2), big ? 15 : 11, p);
    const status = sessionId
      ? [
          `${t("idle.online")} · ${t("idle.uptime")} ${uptimeSecs != null ? fmtUptime(uptimeSecs) : "—"}`,
          ...(big ? [osName, login] : []),
        ]
          .filter(Boolean)
          .join(" · ")
      : t("idle.noSessions");
    ctx.font = `${big ? 14 : 11}px ${MONO}`;
    ctx.fillStyle = muted(p);
    ctx.fillText(fit(ctx, status, rw - (nx - rx0)), nx, P + (big ? 46 : 25));

    const tr = standbyTransfer(Object.values(transfersState.map), transfersState.rates);
    const jobH = tr ? (big ? 100 : 58) : 0;
    if (!sessionId) {
      if (tr) drawTransfer(ctx, P, H - (big ? 76 + 78 : 50 + 44), W - 2 * P, big ? 78 : 44, p, big, tr);
      hint(ctx, W, H, p);
      return;
    }

    // How the host is now — the status bar's own verdict — and what the charts do
    // not show: disk, swap, network, temperature (ADR 0065). CPU, memory and load
    // are told once, by the rings at the start of their charts.
    const tw = rw - (nx - rx0);
    const vy = P + (big ? 46 : 25) + (big ? 38 : 20);
    const verdict = verdictLine(lastMetrics != null, barProblems(lastMetrics, settings.statusBarThresholds));
    if (verdict.kind !== "none") {
      const level = verdict.kind === "problem" ? verdict.problem.level : "ok";
      const color = level === "crit" ? p.red : level === "warn" ? p.yellow : p.green;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(rx0 + (big ? 9 : 6), vy + (big ? 9 : 7), big ? 5 : 4, 0, 7);
      ctx.fill();
      const text =
        verdict.kind === "ok"
          ? t("idle.verdictOk")
          : [t(verdict.problem.key, verdict.problem.params), verdict.more ? t("idle.verdictMore", { n: verdict.more }) : ""]
              .filter(Boolean)
              .join(" · ");
      ctx.font = `500 ${big ? 17 : 12}px ${MONO}`;
      ctx.fillText(fit(ctx, text, tw), nx, vy);
    }
    const factsBottom = drawFacts(ctx, nx, vy + (big ? 44 : 26), tw, p, big);

    // The history of the time away, the transfer under it.
    // The heading in small capitals; the duration keeps its own case ("53m", not "53M").
    const header = `${t("idle.away").toLocaleUpperCase(currentLocale())} · ${fmtUptime(Math.max(0, Math.round((wall - leftAt) / 1000)))}`;
    const reach = t("idle.chartLast", { span: spanLabel(CHART_MS) });
    if (big) {
      // Under the clock and the facts, whichever reaches lower.
      const y = Math.max(P + f * 1.36, factsBottom + 16) + 26;
      label(ctx, header, P, y, 12, p);
      aside(ctx, reach, W - P, y, 12, p);
      const ty = y + 26;
      const tileH = H - ty - 76 - jobH;
      ctx.fillStyle = hexAlpha(p.foreground, 0.04);
      roundRect(ctx, P, ty, W - 2 * P, tileH, 16);
      ctx.fill();
      const tip = drawAway(ctx, P + 28, ty + 26, W - 2 * P - 56, tileH - 26 - 18, p, true);
      if (tr) drawTransfer(ctx, P, ty + tileH + 22, W - 2 * P, 78, p, true, tr);
      if (tip) tooltip(ctx, tip.rows, tip.x, tip.gx, tip.gw, tip.gy, ty + 10, tip.bottom, p, true);
    } else {
      const y = Math.max(P + f * 1.4 + 22, factsBottom + 8) + 8;
      label(ctx, header, P, y, 10, p);
      aside(ctx, reach, W - P, y, 10, p);
      const gy = y + 26;
      const gh = H - gy - 46 - jobH;
      const tip = drawAway(ctx, P, gy, W - 2 * P, gh, p, false);
      if (tr) drawTransfer(ctx, P, gy + gh + 10, W - 2 * P, 44, p, false, tr);
      if (tip) tooltip(ctx, tip.rows, tip.x, tip.gx, tip.gw, tip.gy, y + 18, tip.bottom, p, false);
    }
    hint(ctx, W, H, p);
  }

  /** A small capitals label: the history's heading. */
  function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, p: Pal) {
    ctx.font = `500 ${size}px ${MONO}`;
    ctx.fillStyle = muted(p);
    ctx.fillText(text, x, y);
  }

  /** A faint note set flush right at `right`. */
  function aside(ctx: CanvasRenderingContext2D, text: string, right: number, y: number, size: number, p: Pal) {
    ctx.font = `${size}px ${MONO}`;
    ctx.fillStyle = faint(p);
    ctx.textAlign = "right";
    ctx.fillText(text, right, y);
    ctx.textAlign = "left";
  }

  /** One fact above the charts: its name, its value coloured by the thresholds, a bar when it has a ceiling, a note. */
  interface Fact {
    label: string;
    value: string;
    level: ThresholdLevel;
    share: number | null;
    color: string;
    note: string;
  }

  /**
   * What the charts do not show, two to a row from (`x`, `y`) across `w`: disk
   * and swap against their size, network and temperature as they read. Each
   * value runs to its reading like the rest. Returns the bottom of the block.
   */
  function drawFacts(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, p: Pal, big: boolean): number {
    const th = settings.statusBarThresholds;
    const sDisk = shown(shownTw.disk);
    const sSwap = shown(shownTw.swap);
    const sRx = shown(shownTw.rx);
    const sTx = shown(shownTw.tx);
    const sTemp = shown(shownTw.temp);
    const free = diskFree(diskUsed, diskTotal);
    const swap = swapShare(lastMetrics?.swapUsed ?? null, lastMetrics?.swapTotal ?? null);
    const swapBytes =
      typeof swap === "number" && lastMetrics?.swapUsed != null && lastMetrics.swapTotal != null
        ? `${fmtBytes(lastMetrics.swapUsed)} / ${fmtBytes(lastMetrics.swapTotal)}`
        : "";
    const facts: Fact[] = [
      {
        label: t("idle.factDisk"),
        value: fmtPct(sDisk),
        level: thresholdLevel(sDisk, th.disk),
        share: ringFraction(sDisk, 100),
        color: p.magenta,
        note: free != null ? t("idle.diskFree", { size: fmtBytes(free) }) : "",
      },
      {
        label: t("mon.swap"),
        value: swap === "none" ? t("idle.noSwap") : fmtPct(sSwap),
        level: swap === "none" ? "ok" : thresholdLevel(sSwap, th.swap),
        share: swap === "none" ? null : ringFraction(sSwap, 100),
        color: p.blue,
        note: swapBytes,
      },
      {
        label: t("mon.network"),
        value: sRx == null && sTx == null ? "—" : `↓${fmtRate(sRx)} ↑${fmtRate(sTx)}`,
        level: "ok",
        share: null,
        color: p.foreground,
        note: "",
      },
      {
        label: t("mon.temperature"),
        value: sTemp == null ? "—" : `${Math.round(sTemp)} °C`,
        level: thresholdLevel(sTemp, th.cpuTemp),
        share: null,
        color: p.foreground,
        note: "",
      },
    ];
    const gap = big ? 40 : 24;
    const cw = (w - gap) / 2;
    const rowH = big ? 64 : 28;
    facts.forEach((f, i) => {
      const fx = x + (i % 2) * (cw + gap);
      const fy = y + Math.floor(i / 2) * rowH;
      ctx.font = `500 ${big ? 12 : 11}px ${MONO}`;
      ctx.fillStyle = muted(p);
      const name = f.label.toLocaleUpperCase(currentLocale());
      ctx.fillText(name, fx, fy + (big ? 6 : 2));
      const nameW = ctx.measureText(name).width;
      // A long value (the network's two rates) steps down a size before it is cut.
      const room = cw - nameW - 10;
      const sizes = big ? [22, 17] : [14, 12];
      for (const size of sizes) {
        ctx.font = `300 ${size}px ${MONO}`;
        if (ctx.measureText(f.value).width <= room) break;
      }
      ctx.fillStyle = levelColor(f.level, p);
      ctx.textAlign = "right";
      ctx.fillText(fit(ctx, f.value, room), fx + cw, fy + (big ? 2 : 0));
      ctx.textAlign = "left";
      if (f.share != null) {
        const by = fy + (big ? 30 : 19);
        const bh = big ? 4 : 3;
        ctx.fillStyle = hexAlpha(p.foreground, 0.08);
        ctx.fillRect(fx, by, cw, bh);
        ctx.fillStyle = f.color;
        ctx.fillRect(fx, by, cw * f.share, bh);
      }
      if (big && f.note) {
        ctx.font = `12px ${MONO}`;
        ctx.fillStyle = faint(p);
        ctx.fillText(fit(ctx, f.note, cw), fx, fy + 40);
      }
    });
    return y + 2 * rowH;
  }

  /** A ring at the start of a chart: its track, the filled share, the value inside. */
  function miniRing(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    frac: number | null,
    color: string,
    value: string,
    valueColor: string,
    big: boolean,
    p: Pal,
  ) {
    const lw = big ? 4 : 3;
    const r = R - lw / 2;
    ctx.lineWidth = lw;
    ctx.strokeStyle = hexAlpha(p.foreground, 0.08);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (frac != null && frac > 0) {
      ctx.lineCap = "round";
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
      ctx.lineCap = "butt";
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = valueColor;
    ctx.font = `300 ${Math.max(11, Math.round(R * 0.5))}px ${MONO}`;
    ctx.fillText(fit(ctx, value, 2 * r - lw - 2), cx, cy + 1);
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
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

  /** The three charts, top to bottom. */
  const SERIES: [AwayKey, string][] = [
    ["cpu", "CPU"],
    ["mem", "MEM"],
    ["load", "LOAD"],
  ];
  const seriesColor = (key: AwayKey, p: Pal) => (key === "cpu" ? p.green : key === "mem" ? p.blue : p.yellow);
  const fmtValue = (key: AwayKey, v: number) => (key === "load" ? v.toFixed(2) : fmtPct(v));

  /** The level a value of `key` stands at against the status bar's thresholds. */
  function levelOf(key: AwayKey, v: number | null, cores: number | null): ThresholdLevel {
    const th = settings.statusBarThresholds;
    if (key === "cpu") return thresholdLevel(v, th.cpu);
    if (key === "mem") return thresholdLevel(v, th.ram);
    return loadHealth(v, v != null && cores ? v / cores : null, th.load);
  }

  /** The pointer over the layout as drawn — the burn-in shift taken off — or null when it shows no tooltip. */
  function hovered(): { x: number; y: number } | null {
    if (!pointer || !hoverShown(movedAt, performance.now())) return null;
    const x = pointer.x - drift.dx;
    const y = pointer.y - drift.dy;
    return { x, y };
  }

  /**
   * The history of the time away in a `w × h` block at (`x`, `y`): CPU, memory
   * and load, each on a chart of its own over the last `CHART_MS` — the mean as
   * a line, lowest to highest as a band around it — and under them the strip of
   * the whole time away. The window slides right to left and never squeezes;
   * what happened at a moment is the tooltip's. Returns what the tooltip says
   * about what is under the pointer, or null.
   */
  function drawAway(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    p: Pal,
    big: boolean,
  ): HistoryTip | null {
    const lay = historyLayout(h, big);
    const gut = big ? 210 : 116;
    const gx = x + gut;
    const gw = Math.max(1, w - gut);
    const chartH = lay.axisY;
    // The right edge on its way to the newest poll: the lines slide left, the scale holds.
    const to = tweenAt(axisTw, frameAt, ms(LINE_MS)) ?? away.lastAt ?? Date.now();
    const from = chartFrom(to);
    const off = offsetMin ?? 0;
    const pos = (at: number) => timeX(at, from, to, gx, gw);
    const small = `${big ? 11 : 10}px ${MONO}`;
    const gaps = awayGaps(away.buckets, away.bucketMs, away.pending, away.lastAt);
    const ptr = hovered();
    const onCharts = ptr != null && ptr.y >= y - HOVER_SLACK && ptr.y <= y + chartH + HOVER_SLACK;
    const hitAt = ptr && onCharts ? timeAtX(ptr.x, from, to, gx, gw) : null;
    const hit = hitAt == null ? null : chartHit(away.buckets, gaps, hitAt, from, to);
    const hitSpan = hit && "span" in hit ? away.buckets[hit.span] : null;

    // Where nothing was read: shaded, and named where there is room. The lines break there.
    ctx.font = small;
    for (const g of gaps) {
      const x0 = Math.max(gx, pos(g.from));
      const x1 = Math.min(gx + gw, pos(g.to));
      if (x1 - x0 < 1) continue;
      ctx.fillStyle = hexAlpha(p.foreground, hit && "gap" in hit && hit.gap === g ? 0.08 : 0.035);
      ctx.fillRect(x0, y, x1 - x0, chartH);
      const text = `${t("idle.tipNoData")} · ${spanLabel(g.to - g.from)}`;
      if (x1 - x0 >= ctx.measureText(text).width + 24) {
        ctx.fillStyle = faint(p);
        ctx.textAlign = "center";
        ctx.fillText(text, (x0 + x1) / 2, y + 4);
        ctx.textAlign = "left";
      }
    }
    // When the user left, while it is in sight: the history begins about there.
    if (leftAt > from && leftAt < to) {
      const lx = Math.round(pos(leftAt)) + 0.5;
      ctx.strokeStyle = hexAlpha(p.foreground, 0.25);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(lx, y);
      ctx.lineTo(lx, y + chartH);
      ctx.stroke();
      ctx.setLineDash([]);
      const text = t("idle.leftAt", { time: clockLabel(leftAt, off) });
      ctx.fillStyle = faint(p);
      if (lx - gx >= ctx.measureText(text).width + 12) {
        ctx.textAlign = "right";
        ctx.fillText(text, lx - 6, y + 4);
        ctx.textAlign = "left";
      } else ctx.fillText(text, lx + 6, y + 4);
    }

    // Three charts, each on its own scale: CPU and memory against 100 %, load
    // against the cores or the highest load in sight — its ceiling moves, never jumps.
    const wantTop = loadCeiling(windowPeak(away.buckets, "load", from), cpuCount);
    loadTopTw = retarget(loadTopTw, wantTop, frameAt, ms(SCALE_MS), null);
    const loadTop = tweenAt(loadTopTw, frameAt, ms(SCALE_MS)) ?? wantTop;
    const values: Record<AwayKey, number | null> = {
      cpu: shown(shownTw.cpu),
      mem: shown(shownTw.mem),
      load: shown(shownTw.load),
    };
    SERIES.forEach(([key, name], i) => {
      const ry = y + lay.rowY[i];
      const rh = lay.rowH;
      const color = seriesColor(key, p);
      const top = key === "load" ? loadTop : 100;
      const yOf = (v: number) => ry + rh - Math.min(1, Math.max(0, v / top)) * rh;
      // The floor, and a line to read the height by: half for CPU and memory, the cores for load.
      ctx.lineWidth = 1;
      ctx.strokeStyle = hexAlpha(p.foreground, 0.16);
      ctx.beginPath();
      ctx.moveTo(gx, Math.round(ry + rh) + 0.5);
      ctx.lineTo(gx + gw, Math.round(ry + rh) + 0.5);
      ctx.stroke();
      if (key !== "load") {
        const my = Math.round(yOf(50)) + 0.5;
        ctx.strokeStyle = hexAlpha(p.foreground, 0.06);
        ctx.beginPath();
        ctx.moveTo(gx, my);
        ctx.lineTo(gx + gw, my);
        ctx.stroke();
      } else if (cpuCount != null && cpuCount > 0) {
        const cy = Math.round(yOf(cpuCount)) + 0.5;
        ctx.strokeStyle = hexAlpha(p.yellow, 0.4);
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(gx, cy);
        ctx.lineTo(gx + gw, cy);
        ctx.stroke();
        ctx.setLineDash([]);
        if (rh >= 28) {
          ctx.font = small;
          ctx.fillStyle = faint(p);
          ctx.textAlign = "right";
          ctx.fillText(t("idle.cores", { n: cpuCount }), gx + gw, cy - (big ? 15 : 13));
          ctx.textAlign = "left";
        }
      }
      // The band and the mean, cut at the chart's sides.
      ctx.save();
      ctx.beginPath();
      ctx.rect(gx, ry - 3, gw, rh + 6);
      ctx.clip();
      let end: { x: number; y: number } | null = null;
      for (const run of bandRuns(away.buckets, key, away.bucketMs)) {
        if (run.length > 1) {
          ctx.beginPath();
          run.forEach((pt, j) => (j ? ctx.lineTo(pos(pt.at), yOf(pt.hi)) : ctx.moveTo(pos(pt.at), yOf(pt.hi))));
          for (let j = run.length - 1; j >= 0; j--) ctx.lineTo(pos(run[j].at), yOf(run[j].lo));
          ctx.closePath();
          ctx.fillStyle = hexAlpha(color, 0.2);
          ctx.fill();
        }
        ctx.beginPath();
        run.forEach((pt, j) => (j ? ctx.lineTo(pos(pt.at), yOf(pt.mean)) : ctx.moveTo(pos(pt.at), yOf(pt.mean))));
        if (run.length === 1) ctx.lineTo(pos(run[0].at) + 1, yOf(run[0].mean));
        ctx.strokeStyle = color;
        ctx.lineWidth = big ? 1.8 : 1.4;
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.lineJoin = "miter";
        const last = run[run.length - 1];
        end = { x: pos(last.at), y: yOf(last.mean) };
      }
      ctx.restore();
      // Where the line is now — unless the newest poll read nothing.
      const dots: { x: number; y: number }[] = [];
      if (end && away.pending == null && end.x <= gx + gw + 0.5) dots.push(end);
      const a = hitSpan?.[key];
      if (hitSpan && a) dots.push({ x: pos(spanMid(hitSpan)), y: yOf(a.sum / a.n) });
      for (const d of dots) {
        ctx.fillStyle = p.background;
        ctx.beginPath();
        ctx.arc(d.x, d.y, big ? 5.5 : 4.5, 0, 7);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(d.x, d.y, big ? 3.5 : 3, 0, 7);
        ctx.fill();
      }
      // Its ring — the value now, at the start of its own chart, told nowhere else
      // (ADR 0065) — its name, the highest in sight and, with room, what it is out of.
      const v = values[key];
      const vColor = v == null ? faint(p) : levelColor(levelOf(key, v, cpuCount), p);
      const vText = v == null ? "—" : fmtValue(key, v);
      const peak = windowPeak(away.buckets, key, from);
      const peakText = peak == null ? "" : t("idle.peak", { value: key === "load" ? peak.toFixed(1) : `${Math.round(peak)}%` });
      const R = gutterRing(rh, big);
      if (R == null) {
        // Too low for a ring: the name and the value on one line.
        ctx.font = `500 ${big ? 12 : 10}px ${MONO}`;
        ctx.fillStyle = muted(p);
        ctx.fillText(name, x, ry);
        const nw = ctx.measureText(`${name} `).width;
        ctx.font = `${big ? 13 : 11}px ${MONO}`;
        ctx.fillStyle = vColor;
        ctx.fillText(fit(ctx, vText, gut - nw - 4), x + nw, ry - 1);
      } else {
        const cy = ry + rh / 2;
        miniRing(ctx, x + R, cy, R, key === "load" ? ringFraction(v, cpuCount) : ringFraction(v, 100), color, vText, vColor, big, p);
        const lx = x + 2 * R + (big ? 14 : 9);
        const room = gut - (lx - x) - 4;
        const detail = !big
          ? ""
          : key === "cpu"
            ? cpuCount != null
              ? t("idle.cores", { n: cpuCount })
              : ""
            : key === "mem"
              ? memUsed != null && memTotal != null
                ? `${fmtBytes(memUsed)} / ${fmtBytes(memTotal)}`
                : ""
              : load5 != null && load15 != null
                ? `5m ${load5.toFixed(2)} · 15m ${load15.toFixed(2)}`
                : "";
        const lines: [string, string, string][] = [
          [name, `500 ${big ? 12 : 11}px ${MONO}`, muted(p)],
          ...(peakText ? ([[peakText, small, faint(p)]] as [string, string, string][]) : []),
          ...(detail ? ([[detail, small, faint(p)]] as [string, string, string][]) : []),
        ];
        const lh = big ? 17 : 14;
        let ly = cy - (lines.length * lh) / 2 + 1;
        for (const [text, font, fill] of lines) {
          ctx.font = font;
          ctx.fillStyle = fill;
          ctx.fillText(fit(ctx, text, room), lx, ly);
          ly += lh;
        }
      }
    });
    // The moment under the pointer: a thin line down all three charts.
    const hx = hitSpan ? pos(spanMid(hitSpan)) : null;
    if (hx != null) {
      const lx = Math.round(hx) + 0.5;
      ctx.strokeStyle = hexAlpha(p.foreground, 0.22);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lx, y);
      ctx.lineTo(lx, y + chartH);
      ctx.stroke();
    }

    // The time axis: round minutes of the server's clock, sliding with the charts.
    const ay = y + lay.axisY + (big ? 8 : 5);
    const clear = (tx: number) => hx == null || Math.abs(tx - hx) >= 56;
    ctx.font = small;
    ctx.fillStyle = faint(p);
    ctx.textAlign = "right";
    if (clear(gx + gw - 20)) ctx.fillText(t("idle.now"), gx + gw, ay);
    ctx.textAlign = "center";
    for (const at of timeTicks(from, to, off, Math.max(2, Math.floor(gw / (big ? 150 : 110))))) {
      const tx = pos(at);
      if (tx > gx + 20 && tx + 24 < gx + gw - 60 && clear(tx)) ctx.fillText(clockLabel(at, off), tx, ay);
    }
    ctx.textAlign = "left";
    if (hitSpan && hx != null && big) timeChip(ctx, hx, ay - 4, clockLabel(spanMid(hitSpan), off), p);

    // The strip of the whole time away, a step coarser whenever it runs out of room.
    let tip: HistoryTip | null = null;
    if (hitSpan) tip = { rows: bucketRows(hitSpan, big, p), x: hx ?? gx, gx, gw, gy: y, bottom: y + h };
    else if (hit && "gap" in hit) {
      const gx0 = Math.max(gx, pos(hit.gap.from));
      const gx1 = Math.min(gx + gw, pos(hit.gap.to));
      tip = { rows: gapRows(hit.gap), x: (gx0 + gx1) / 2, gx, gw, gy: y, bottom: y + h };
    }
    const since = away.firstAt;
    if (since == null) return tip;
    const sy = y + lay.stripY;
    const cy = y + lay.cellY;
    const rowsH = lay.stripRows * lay.cellStep - (lay.cellStep - lay.cellH);
    label(ctx, t("idle.stripTitle").toLocaleUpperCase(currentLocale()), gx, sy, big ? 11 : 10, p);
    aside(ctx, t("idle.stripFrame"), gx + gw, sy, big ? 11 : 10, p);
    const view = stripView(away.cells, away.step, since, to, Math.max(8, Math.floor(gw / (big ? 5 : 4))));
    // A step up redraws every cell: the old strip gives way to the new one.
    if (!strip || strip.view.count !== view.count) strip = { view, was: null, at: frameAt };
    else if (strip.view.step !== view.step) strip = { view, was: strip.view, at: frameAt };
    else strip.view = view;
    const k = strip.was ? easeOut(progress(strip.at, frameAt, ms(MERGE_MS))) : 1;
    const base = ctx.globalAlpha;
    if (strip.was && k < 1) {
      ctx.globalAlpha = base * (1 - k);
      drawStrip(ctx, { ...strip.was, from: to - strip.was.count * strip.was.step }, since, to, gx, gw, cy, lay, p);
      ctx.globalAlpha = base * k;
    } else strip.was = null;
    const slots = drawStrip(ctx, view, since, to, gx, gw, cy, lay, p);
    ctx.globalAlpha = base;
    // The charts' half hour, framed.
    const fx = Math.max(gx, stripX(view, from, gx, gw));
    ctx.strokeStyle = hexAlpha(p.foreground, 0.5);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(fx) - 1.5, Math.round(cy) - 3.5, gx + gw - Math.round(fx) + 3, rowsH + 7);
    if (big && lay.stripRows === 3) {
      ctx.font = small;
      ctx.fillStyle = faint(p);
      SERIES.forEach(([, name], i) => ctx.fillText(name, x, cy + i * lay.cellStep - 2));
    }
    ctx.font = small;
    ctx.fillStyle = faint(p);
    ctx.fillText(clockLabel(since, off), Math.max(gx, stripX(view, since, gx, gw)), y + lay.stripLabelY);
    ctx.textAlign = "right";
    ctx.fillText(t("idle.now"), gx + gw, y + lay.stripLabelY);
    ctx.textAlign = "left";
    // The slot under the pointer: outlined, and told in the tooltip.
    if (ptr && !onCharts && ptr.y >= cy - 6 && ptr.y <= cy + rowsH + 6) {
      const i = stripHit(slots, view, ptr.x, gx, gw);
      if (i >= 0) {
        const cw = gw / view.count;
        const sx = stripX(view, slots[i].at, gx, gw);
        ctx.strokeStyle = hexAlpha(p.foreground, 0.85);
        ctx.strokeRect(Math.round(sx) - 0.5, Math.round(cy) - 2.5, Math.max(2, Math.round(cw)), rowsH + 5);
        tip = { rows: slotRows(slots, i, view.step, big, p), x: sx + cw / 2, gx, gw, gy: y, bottom: cy - 8 };
      }
    }
    return tip;
  }

  /** A level as the colour of its cell: nothing read is barely there, ok is quiet, over a threshold is its colour. */
  function cellColor(level: ThresholdLevel | null | undefined, p: Pal): string {
    if (level === "crit") return p.red;
    if (level === "warn") return p.yellow;
    if (level === "ok") return hexAlpha(p.foreground, 0.16);
    return hexAlpha(p.foreground, 0.045);
  }

  /** The worst of a cell's three levels — the strip's single row. */
  const worstOf = (l: Record<AwayKey, ThresholdLevel | null>): ThresholdLevel | null =>
    [l.cpu, l.mem, l.load].reduce<ThresholdLevel | null>(
      (a, b) => (b == null ? a : a == null || (b === "crit" || (b === "warn" && a === "ok")) ? b : a),
      null,
    );

  /**
   * The slots of `view` from `since` to `to`, a row a metric (or one row, the
   * worst of the three), cut at the strip's sides. Returns the slots drawn.
   */
  function drawStrip(
    ctx: CanvasRenderingContext2D,
    view: StripView,
    since: number,
    to: number,
    gx: number,
    gw: number,
    top: number,
    lay: HistoryLayout,
    p: Pal,
  ): StripSlot[] {
    const slots = stripSlots(view, since, to);
    const cw = gw / view.count;
    const rows: (AwayKey | null)[] = lay.stripRows === 3 ? ["cpu", "mem", "load"] : [null];
    ctx.save();
    ctx.beginPath();
    ctx.rect(gx, top - 1, gw, rows.length * lay.cellStep + 2);
    ctx.clip();
    rows.forEach((key, row) => {
      const ry = top + row * lay.cellStep;
      for (const slot of slots) {
        const level = slot.cell ? (key ? slot.cell.level[key] : worstOf(slot.cell.level)) : undefined;
        ctx.fillStyle = cellColor(level, p);
        ctx.fillRect(stripX(view, slot.at, gx, gw), ry, Math.max(1, cw - (cw >= 4 ? 1.2 : 0.5)), lay.cellH);
      }
    });
    ctx.restore();
    return slots;
  }

  /** One line of the tooltip. */
  type TipRow =
    | { kind: "head"; text: string; aside: string }
    | { kind: "sub"; text: string }
    | { kind: "metric"; color: string; label: string; value: string; valueColor: string; aside: string }
    | { kind: "rule" }
    | { kind: "event"; color: string; text: string; aside: string }
    | { kind: "note"; text: string; aside: string };

  /** "14:02–14:10", or one time when both read the same. */
  function clockRange(a: number, b: number): string {
    const off = offsetMin ?? 0;
    const from = clockLabel(a, off);
    const to = clockLabel(b, off);
    return from === to ? from : `${from}–${to}`;
  }

  /** That nothing was read, and why. */
  const gapNote = (kind: GapKind): TipRow => ({
    kind: "note",
    text: t("idle.tipNoData"),
    aside: t(kind === "failed" ? "idle.tipPollFailed" : "idle.tipNotPolled"),
  });

  /** A stretch of the charts nothing was read in. */
  function gapRows(g: AwayGap): TipRow[] {
    return [{ kind: "head", text: clockRange(g.from, g.to), aside: spanLabel(g.to - g.from) }, gapNote(g.kind)];
  }

  /** What each metric says beside its value: the busiest process, the bytes, the cores. */
  function besides(key: AwayKey, s: AwaySpan, big: boolean): string {
    if (key === "cpu") return s.top;
    if (key === "mem") return big && s.memUsed != null && s.memTotal != null ? `${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}` : "";
    return s.cores != null ? t("idle.cores", { n: s.cores }) : "";
  }

  /** A bucket of the charts: the mean of each metric, coloured by the thresholds, lowest to highest beside it. */
  function bucketRows(s: AwaySpan, big: boolean, p: Pal): TipRow[] {
    const rows: TipRow[] = [
      { kind: "head", text: clockRange(s.first, s.last), aside: t("idle.tipAgo", { span: spanLabel(Date.now() - s.last) }) },
    ];
    if (s.n > 1) rows.push({ kind: "sub", text: t("idle.tipMean", { span: spanLabel(away.bucketMs) }) });
    for (const [key, name] of SERIES) {
      const a = s[key];
      const mean = a ? a.sum / a.n : null;
      const range = a && a.hi > a.lo ? `${fmtValue(key, a.lo)}–${fmtValue(key, a.hi)}` : "";
      rows.push({
        kind: "metric",
        color: seriesColor(key, p),
        label: name,
        value: mean == null ? "—" : fmtValue(key, mean),
        valueColor: levelColor(levelOf(key, mean, s.cores), p),
        aside: [range, besides(key, s, big)].filter(Boolean).join(" · "),
      });
    }
    return [...rows, ...eventRows(s.first, s.last, big, p)];
  }

  /** A slot of the strip: the highest of each metric in it, coloured by the worst level reached — or that nothing was read. */
  function slotRows(slots: readonly StripSlot[], i: number, len: number, big: boolean, p: Pal): TipRow[] {
    const slot = slots[i];
    const head = clockRange(slot.at, slot.at + len);
    const cell = slot.cell;
    if (!cell) return [{ kind: "head", text: head, aside: "" }, gapNote(slotGap(slots, i, away.pending))];
    const rows: TipRow[] = [
      { kind: "head", text: head, aside: t("idle.tipAgo", { span: spanLabel(Date.now() - cell.last) }) },
    ];
    if (cell.n > 1) rows.push({ kind: "sub", text: t("idle.tipPeak", { span: spanLabel(len) }) });
    for (const [key, name] of SERIES) {
      const a = cell[key];
      rows.push({
        kind: "metric",
        color: seriesColor(key, p),
        label: name,
        value: a ? fmtValue(key, a.hi) : "—",
        valueColor: levelColor(cell.level[key] ?? "ok", p),
        aside: besides(key, cell, big),
      });
    }
    return [...rows, ...eventRows(cell.first, cell.last, big, p)];
  }

  /** The events a stretch shares time with: under a rule, each with when it was and its peak. */
  function eventRows(from: number, to: number, big: boolean, p: Pal): TipRow[] {
    const off = offsetMin ?? 0;
    const events = eventsAt(away.events, from, to);
    const rows: TipRow[] = events.length ? [{ kind: "rule" }] : [];
    for (const e of events) {
      const name = e.key === "cpu" ? "CPU" : e.key === "mem" ? "MEM" : "LOAD";
      const color = e.level === "crit" ? p.red : p.yellow;
      const peak = t("idle.tipPeakAt", {
        peak: e.key === "load" ? e.peak.toFixed(2) : `${Math.round(e.peak)}%`,
        time: clockLabel(e.peakAt, off),
      });
      const over = t("idle.tipOver", { name });
      if (!big) {
        rows.push({ kind: "event", color, text: `${over} · ${peak}`, aside: "" });
        continue;
      }
      const end = e.open ? t("idle.now") : clockLabel(e.end, off);
      const when =
        e.end > e.start
          ? `${e.open ? `${clockLabel(e.start, off)}–${end}` : clockRange(e.start, e.end)} · ${spanLabel(e.end - e.start)}`
          : clockLabel(e.start, off);
      rows.push({ kind: "event", color, text: over, aside: `${when} · ${peak}` });
    }
    return rows;
  }

  /** The time under the pointer, on the axis. */
  function timeChip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, p: Pal) {
    ctx.font = `500 11px ${MONO}`;
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = p.background;
    roundRect(ctx, x - w / 2, y, w, 18, 5);
    ctx.fill();
    ctx.fillStyle = hexAlpha(p.foreground, 0.14);
    roundRect(ctx, x - w / 2, y, w, 18, 5);
    ctx.fill();
    ctx.fillStyle = p.foreground;
    ctx.textAlign = "center";
    ctx.fillText(text, x, y + 4);
    ctx.textAlign = "left";
  }

  /**
   * The tooltip: right of the point, left of it at the chart's right edge, its
   * top level with the chart's and inside `top…bottom`. Events that do not fit
   * are counted, not cut silently.
   */
  function tooltip(
    ctx: CanvasRenderingContext2D,
    all: TipRow[],
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
    const rowH = (r: TipRow) =>
      r.kind === "rule"
        ? 9
        : r.kind === "sub"
          ? Math.round(lh * 0.75)
          : (r.kind === "event" || r.kind === "note") && r.aside
            ? lh + Math.round(lh * 0.8)
            : lh;
    const height = (rows: TipRow[]) => padY * 2 + rows.reduce((h, r) => h + rowH(r), 0);
    const total = all.filter((r) => r.kind === "event").length;
    let rows = all;
    for (let shown = total - 1; shown >= 0 && height(rows) > bottom - top; shown--) {
      let seen = 0;
      rows = all.filter((r) => (r.kind === "event" ? seen++ < shown : r.kind !== "rule" || shown > 0));
      rows.push({ kind: "sub", text: t("idle.tipMore", { count: total - shown }) });
    }
    const F = {
      head: `600 ${s}px ${MONO}`,
      body: `${s}px ${MONO}`,
      small: `${s - 2}px ${MONO}`,
      label: `500 ${s - 1}px ${MONO}`,
      value: `500 ${s}px ${MONO}`,
      event: `${s - 1}px ${MONO}`,
    };
    const textW = (font: string, text: string) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    const col1 = s * 4.2;
    const valW = Math.max(0, ...rows.map((r) => (r.kind === "metric" ? textW(F.value, r.value) : 0)));
    const widthOf = (r: TipRow): number => {
      if (r.kind === "head") return textW(F.head, r.text) + (r.aside ? 10 + textW(F.body, r.aside) : 0);
      if (r.kind === "sub") return textW(F.small, r.text);
      if (r.kind === "metric") return col1 + valW + (r.aside ? 14 + textW(F.body, r.aside) : 0);
      if (r.kind === "event") return s * 1.3 + Math.max(textW(F.event, r.text), r.aside ? textW(F.event, r.aside) : 0);
      if (r.kind === "note") return Math.max(textW(F.body, r.text), textW(F.body, r.aside));
      return 0;
    };
    const inner = Math.min(Math.min(gw, big ? 480 : 360) - padX * 2, Math.max(...rows.map(widthOf)));
    const w = inner + padX * 2;
    const h = height(rows);
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
      if (row.kind === "rule") {
        ctx.fillStyle = hexAlpha(p.foreground, 0.1);
        ctx.fillRect(x0, y + 4, inner, 1);
      } else if (row.kind === "head") {
        ctx.font = F.head;
        ctx.fillStyle = p.foreground;
        ctx.fillText(row.text, x0, ty);
        const hw = ctx.measureText(row.text).width + 10;
        ctx.font = F.body;
        ctx.fillStyle = muted(p);
        if (row.aside) ctx.fillText(fit(ctx, row.aside, right - x0 - hw), x0 + hw, ty);
      } else if (row.kind === "sub") {
        ctx.font = F.small;
        ctx.fillStyle = faint(p);
        ctx.fillText(fit(ctx, row.text, inner), x0, y + 1);
      } else if (row.kind === "metric") {
        ctx.fillStyle = row.color;
        ctx.beginPath();
        ctx.arc(x0 + s * 0.3, ty + s * 0.5, s * 0.3, 0, 7);
        ctx.fill();
        ctx.font = F.label;
        ctx.fillStyle = muted(p);
        ctx.fillText(row.label, x0 + s * 1.1, ty + 1);
        ctx.font = F.value;
        ctx.fillStyle = row.valueColor;
        ctx.textAlign = "right";
        ctx.fillText(row.value, x0 + col1 + valW, ty);
        ctx.textAlign = "left";
        if (row.aside) {
          const ax = x0 + col1 + valW + 14;
          ctx.font = F.body;
          ctx.fillStyle = faint(p);
          ctx.fillText(fit(ctx, row.aside, right - ax), ax, ty);
        }
      } else if (row.kind === "event") {
        ctx.fillStyle = row.color;
        ctx.beginPath();
        ctx.moveTo(x0, ty + s * 0.85);
        ctx.lineTo(x0 + s * 0.42, ty + s * 0.1);
        ctx.lineTo(x0 + s * 0.84, ty + s * 0.85);
        ctx.closePath();
        ctx.fill();
        const ex = x0 + s * 1.3;
        ctx.font = F.event;
        ctx.fillText(fit(ctx, row.text, right - ex), ex, ty);
        if (row.aside) {
          ctx.fillStyle = muted(p);
          ctx.fillText(fit(ctx, row.aside, right - ex), ex, ty + Math.round(lh * 0.8));
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
    ctx.textAlign = "center";
    ctx.fillStyle = hexAlpha(p.foreground, 0.28);
    ctx.font = "12px ui-monospace,monospace";
    ctx.fillText(t("idle.dismissHint"), W / 2, H - 28);
    ctx.textAlign = "left";
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
