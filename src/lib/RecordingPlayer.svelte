<script lang="ts">
  // Built-in asciicast player: replays a recording's output stream into a
  // read-only xterm with play/pause, scrubbing and speed. Seeking is "reset +
  // replay output up to t" (terminal state is cumulative). Pure timing helpers
  // (outputUpTo/formatTime/castDuration) live in recording.ts.
  import { onMount, onDestroy } from "svelte";
  import { tooltip } from "./actions/tooltip";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";
  import { settings, activeTerminalTheme } from "./settings.svelte";
  import {
    parseCast,
    outputUpTo,
    castDuration,
    formatTime,
    playbackSpeeds,
    activityBuckets,
    type ActivityBucket,
    type CastEvent,
  } from "./recording";

  let {
    content,
    title,
    width = 80,
    height = 24,
    onback,
  }: {
    content: string;
    title: string;
    width?: number;
    height?: number;
    onback?: () => void;
  } = $props();

  let container: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  let observer: ResizeObserver | undefined;
  let events: CastEvent[] = [];
  let cursor = 0; // index of the next event to emit
  let raf = 0;
  let last = 0;

  let duration = $state(0);
  let playhead = $state(0);
  let playing = $state(false);
  // Speed presets + initial selection depend on the recording's timing: synthetic
  // (non-timed) recordings use a slower scale (see playbackSpeeds in recording.ts).
  let speeds = $state<number[]>([0.5, 1, 2, 4]);
  let speed = $state(1);
  // Output-density strip drawn behind the scrubber. Computed once after parsing —
  // the recording is immutable, so there is nothing to recompute per frame.
  let buckets = $state<ActivityBucket[]>([]);
  /** Column count: dense enough to show shape, coarse enough to stay ≥2px wide. */
  const BUCKETS = 80;

  function emitUpTo(target: number) {
    const t2 = Math.min(target, duration);
    while (cursor < events.length && events[cursor].time <= t2) {
      const e = events[cursor];
      if (e.kind === "o") term.write(e.data);
      cursor++;
    }
    playhead = t2;
  }

  function tick(now: number) {
    if (!playing) return;
    emitUpTo(playhead + ((now - last) / 1000) * speed);
    last = now;
    if (playhead >= duration) playing = false;
    else raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!term || duration === 0) return; // empty recording — nothing to play
    if (playhead >= duration) seek(0); // replay from the start
    playing = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
  }

  function toggle() {
    playing ? pause() : play();
  }

  /** Jump to time `t`: reset the terminal and replay output up to that point. */
  function seek(target: number) {
    const t2 = Math.max(0, Math.min(target, duration));
    term.reset();
    term.write(outputUpTo(events, t2));
    const next = events.findIndex((e) => e.time > t2);
    cursor = next === -1 ? events.length : next;
    playhead = t2;
  }

  function onScrub(e: Event) {
    pause();
    seek(Number((e.currentTarget as HTMLInputElement).value));
  }

  /**
   * Fit the terminal's row count to the visible viewport while keeping the
   * recording's own column width (so wrapping matches what was recorded). xterm's
   * own viewport then owns the vertical scroll: it auto-follows new output and is
   * scrollable (wheel/scrollbar) up through the scrollback — no outer scrollbar.
   */
  function refitRows() {
    try {
      const dims = fit.proposeDimensions();
      if (dims && dims.rows > 0) term.resize(Math.max(1, width), dims.rows);
    } catch {
      /* container not measurable yet */
    }
  }

  onMount(() => {
    const parsed = parseCast(content);
    events = parsed.events;
    duration = castDuration(content);
    const preset = playbackSpeeds(parsed.header);
    speeds = preset.speeds;
    speed = preset.initial;
    buckets = activityBuckets(events, BUCKETS, duration);
    const th = activeTerminalTheme();
    term = new Terminal({
      cols: Math.max(1, width),
      rows: Math.max(1, height),
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      // Keep history so the viewport can follow new output and scroll back.
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false,
      theme: { ...th },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    refitRows(); // size rows to the viewport before the first paint (no flash)
    // Re-fit when the modal (and so the viewport) is resized.
    observer = new ResizeObserver(() => refitRows());
    observer.observe(container);
    play(); // auto-start
  });

  onDestroy(() => {
    pause();
    observer?.disconnect();
    term?.dispose();
  });
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center gap-2">
    <button
      type="button"
      onclick={onback}
      class="flex items-center gap-1 rounded p-1 text-muted hover:text-accent"
      use:tooltip={t("player.back")}
      aria-label={t("player.back")}
    >
      <Icon name="chevronLeft" size={16} />
    </button>
    <span class="truncate text-sm text-text" {title}>{title}</span>
  </div>

  <!-- Terminal surface (read-only). Fixed height so the terminal's rows fit the
       viewport: xterm's own viewport owns the vertical scroll (auto-follows new
       output, wheel-scrolls back through history), so we hide outer vertical
       overflow and keep only horizontal scroll for recordings wider than the modal. -->
  <div class="h-[55vh] overflow-x-auto overflow-y-hidden rounded border border-edge bg-panel p-1">
    <div bind:this={container} class="h-full"></div>
  </div>

  <!-- Transport controls (hidden for an empty recording). -->
  {#if duration > 0}
    <div class="flex items-center gap-3">
      <button
        type="button"
        onclick={toggle}
        class="flex items-center rounded p-1 text-muted hover:text-accent"
        use:tooltip={playing ? t("player.pause") : t("player.play")}
        aria-label={playing ? t("player.pause") : t("player.play")}
      >
        <Icon name={playing ? "pause" : "play"} size={18} />
      </button>
      <button
        type="button"
        onclick={() => seek(0)}
        class="flex items-center rounded p-1 text-muted hover:text-accent"
        use:tooltip={t("player.restart")}
        aria-label={t("player.restart")}
      >
        <Icon name="refresh" size={15} />
      </button>
      <!-- Scrubber over an output-density strip. The strip is decorative
           (`aria-hidden`) and sits *behind* the real range input, so click-to-seek,
           arrow-key seeking and the accessible name all stay native — a
           hand-rolled click-target would have quietly dropped the keyboard path. -->
      <div class="relative min-w-0 flex-1">
        <div class="pointer-events-none absolute inset-x-0 top-0 flex h-5 items-end gap-px" aria-hidden="true">
          {#each buckets as b, i (i)}
            {@const played = duration > 0 && (i + 1) / buckets.length <= playhead / duration}
            <span
              class="min-w-0 flex-1 rounded-[1px]"
              style="height: {b.level > 0 ? Math.max(8, b.level * 100) : 0}%;
                     background-color: var({b.burst ? '--color-warn' : '--color-accent'});
                     opacity: {played ? 1 : 0.35}"
            ></span>
          {/each}
        </div>
        <input
          type="range"
          min="0"
          max={duration}
          step="0.05"
          value={playhead}
          oninput={onScrub}
          aria-label={t("player.seek")}
          class="player-scrub relative h-5 w-full cursor-pointer accent-accent"
        />
      </div>
      <span class="shrink-0 text-xs tabular-nums text-muted">
        {formatTime(playhead)} / {formatTime(duration)}
      </span>
      <div class="flex shrink-0 items-center gap-1">
        {#each speeds as sp}
          <button
            type="button"
            onclick={() => (speed = sp)}
            aria-pressed={speed === sp}
            class="rounded px-1.5 py-0.5 text-meta font-medium {speed === sp
              ? 'bg-edge text-accent'
              : 'text-muted hover:text-accent'}">{sp}×</button
          >
        {/each}
      </div>
    </div>
  {:else}
    <p class="text-xs text-muted">{t("player.empty")}</p>
  {/if}
</div>

<style>
  /* The range input carries the interaction; the density strip behind it carries
     the picture. So the track is made transparent and the thumb becomes a thin
     playhead line rather than a knob that would cover three columns of the strip. */
  .player-scrub {
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
  }
  .player-scrub::-webkit-slider-runnable-track {
    height: 100%;
    background: transparent;
  }
  .player-scrub::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 2px;
    height: 20px;
    border-radius: 1px;
    background: var(--color-text);
  }
  .player-scrub::-moz-range-track {
    height: 100%;
    background: transparent;
  }
  .player-scrub::-moz-range-thumb {
    width: 2px;
    height: 20px;
    border: 0;
    border-radius: 1px;
    background: var(--color-text);
  }
</style>
