<script lang="ts">
  // A number that counts to each new reading instead of jumping (v1.33), as the
  // screensaver's rings do: it eases from what is shown to the reading over
  // RING_MS (tween.ts) and lands on it exactly. A reading that comes mid-way
  // starts from where the number stands. Unknown is "—", at once. With reduced
  // motion the number changes at once. The status bar counts shorter (`ms`) and
  // shows the unit apart from the number, dimmer (`unit`).
  import { onDestroy, untrack } from "svelte";
  import { retarget, RING_MS, still, tweenAt, type Tween } from "../ui/tween";
  import { motionMs, reducedMotion } from "../ui/motion";

  let {
    value,
    format = (v: number) => String(Math.round(v)),
    unit = undefined,
    duration = RING_MS,
    class: cls = "",
    numClass = "",
    unitClass = "",
    testid = undefined,
  }: {
    value: number | null;
    /** The number as text — without the unit when `unit` is given. */
    format?: (v: number) => string;
    /** The unit of the value shown, drawn after the number in a dimmer face. */
    unit?: (v: number) => string;
    /** How long a count takes (ms) before reduced motion. */
    duration?: number;
    class?: string;
    /** Classes of the number alone (a fixed width to right-align it in). */
    numClass?: string;
    /** Classes of the unit alone (a fixed slot, so "KB/s" → "MB/s" moves nothing). */
    unitClass?: string;
    testid?: string;
  } = $props();

  // svelte-ignore state_referenced_locally
  const ms = motionMs(duration, reducedMotion());
  let tw = $state.raw<Tween>(still(null));
  let now = $state(0);
  let raf = 0;

  function step(at: number) {
    raf = 0;
    now = at;
    if (at - tw.at < ms) raf = requestAnimationFrame(step);
  }

  $effect(() => {
    const v = value;
    untrack(() => {
      const at = performance.now();
      tw = retarget(tw, v, at, ms, null);
      now = at;
      if (!raf && ms > 0) raf = requestAnimationFrame(step);
    });
  });
  onDestroy(() => cancelAnimationFrame(raf));

  // Mid-way the eased value is shown; on arrival — the reading itself, so the
  // last digit is never off by a rounding of the curve.
  const shown = $derived(now - tw.at >= ms ? tw.to : tweenAt(tw, now, ms));
</script>

{#if unit}
  <span class="tabular-nums {cls}" data-testid={testid}
    ><span class="inline-block text-right {numClass}">{shown == null ? "—" : format(shown)}</span
    >{#if shown != null}<span class="ml-0.5 text-meta text-muted {unitClass}">{unit(shown)}</span>{/if}</span
  >
{:else}
  <span class="tabular-nums {cls}" data-testid={testid}>{shown == null ? "—" : format(shown)}</span>
{/if}
