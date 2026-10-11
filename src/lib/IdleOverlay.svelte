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
  import { settings, activeTerminalTheme } from "./settings.svelte";
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
    idleSample,
    pushSample,
    seriesRuns,
    tokenizeBuffer,
    type IdleSample,
    type WordToken,
  } from "./idlefx";
  import { fetchMetrics } from "./api";
  import { fmtPct, fmtUptime, memPct } from "./format";
  import { t } from "./i18n";

  let {
    sessionId = null,
    tabs = 0,
    alias = "",
    bufferText = () => "",
    outputTick = 0,
    noSignal = false,
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
    /** The terminal-panes element the overlay covers (null → whole window). */
    targetEl?: HTMLElement | null;
    onnosignaldismiss?: () => void;
  } = $props();

  const reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  let metricsTimer: ReturnType<typeof setInterval> | undefined;

  async function pollMetrics() {
    if (!sessionId) return;
    try {
      const m = await fetchMetrics(sessionId);
      cpu = m.cpuPct ?? cpu;
      mem = memPct(m.memUsed, m.memTotal) ?? mem;
      load1 = m.load1;
      cpuCount = m.cpuCount ?? cpuCount;
      uptimeSecs = m.uptimeSecs ?? uptimeSecs;
      host = m.hostname || alias || host;
      hist = pushSample(hist, idleSample(m.cpuPct, memPct(m.memUsed, m.memTotal), load1, cpuCount));
      // Reduced motion has no rAF loop: the frame drawn at activation predates
      // the first sample, so without this the chart would never get its lines.
      // (Windows turns reduced motion on with "Animation effects" off — common.)
      if (active && reduce) draw(performance.now() - started);
    } catch {
      /* transient — keep last values */
    }
  }

  function activate() {
    if (active) return;
    active = true;
    started = performance.now();
    snapText = "";
    try {
      snapText = bufferText();
    } catch {
      snapText = "";
    }
    tokens = tokenizeBuffer(snapText);
    if (shownEffect === "card" && sessionId) {
      host = alias;
      hist = [];
      cpu = mem = load1 = cpuCount = uptimeSecs = null;
      void pollMetrics();
      const every = Math.max(2, settings.statusPollInterval) * 1000;
      metricsTimer = setInterval(pollMetrics, every);
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
    clearInterval(metricsTimer);
    metricsTimer = undefined;
    if (noSignal) onnosignaldismiss();
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
  // static frame; `pollMetrics` repaints it after every sample.
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
  function drawCard(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, p: Pal) {
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, W, H);
    const tier = cardTier(W, H);
    if (tier === "full") drawCardFull(ctx, W, H, now, p);
    else if (tier === "wide" || tier === "row") drawCardWide(ctx, W, H, now, p, tier === "wide");
    else if (tier === "stack") drawCardStack(ctx, W, H, now, p);
    else drawCardSmall(ctx, W, H, now, p, tier === "mini");
  }

  const MONO = "ui-monospace,Menlo,monospace";
  type CardMetric = [label: string, value: string, color: string, key: keyof IdleSample];
  // The dot before each label is the legend of its chart line.
  function cardMetrics(p: Pal): CardMetric[] {
    return [
      ["CPU", fmtPct(cpu), p.green, "cpu"],
      ["MEM", fmtPct(mem), p.blue, "mem"],
      ["LOAD", load1 != null ? load1.toFixed(2) : "—", p.yellow, "load"],
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
    const runs = seriesRuns(
      hist.map((sample) => sample[key]),
      gx,
      gy,
      gw,
      gh,
    );
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
    let r = 255,
      g = 255,
      b = 255;
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
    style="position:fixed;left:0;top:0;z-index:35;outline:none;"
  ></canvas>
{/if}
