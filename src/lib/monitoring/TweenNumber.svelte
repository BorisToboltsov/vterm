<script lang="ts">
  // A number that counts to each new reading instead of jumping (v1.33), as the
  // screensaver's rings do: it eases from what is shown to the reading over
  // RING_MS (tween.ts) and lands on it exactly. A reading that comes mid-way
  // starts from where the number stands. Unknown is "—", at once. With reduced
  // motion the number changes at once.
  import { onDestroy, untrack } from "svelte";
  import { retarget, RING_MS, still, tweenAt, type Tween } from "../ui/tween";
  import { motionMs, prefersReducedMotion } from "../ui/motion";

  let {
    value,
    format = (v: number) => String(Math.round(v)),
    class: cls = "",
    testid = undefined,
  }: {
    value: number | null;
    format?: (v: number) => string;
    class?: string;
    testid?: string;
  } = $props();

  const ms = motionMs(RING_MS, prefersReducedMotion());
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

<span class="tabular-nums {cls}" data-testid={testid}>{shown == null ? "—" : format(shown)}</span>
