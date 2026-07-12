<script lang="ts">
  // The in-app app logo — the same mark as the OS icon: two cascading terminal
  // windows with a ›_ prompt on the front one. The rounded-square background
  // reflects the active theme: a signature theme paints its dimensional backdrop
  // gradient (so the in-app icon changes with the theme, matching the window
  // chrome), while classic themes fall back to the flat panel colour. On a
  // signature (dark) backdrop the mark is white; on classic themes it uses the
  // theme accent so it stays visible on light palettes too.
  import { settings } from "./settings.svelte";
  import { getTheme } from "./themes";

  let { size = 40, label = "vterm" }: { size?: number; label?: string } = $props();

  const backdrop = $derived(
    settings.theme !== "custom" ? getTheme(settings.theme).backdrop : undefined,
  );
  const bg = $derived(backdrop ?? "var(--color-panel)");
  const primary = $derived(backdrop ? "#ffffff" : "var(--color-accent)");
  const secondary = $derived(backdrop ? "rgba(255,255,255,0.5)" : "var(--color-muted)");
</script>

<div
  class="shrink-0 overflow-hidden border border-edge"
  role="img"
  aria-label={label}
  data-testid="app-logo"
  style="width:{size}px;height:{size}px;border-radius:{size * 0.23}px;background:{bg}"
>
  <svg viewBox="0 0 128 128" width={size} height={size} aria-hidden="true">
    <!-- back window (outline) -->
    <rect
      x="28"
      y="30"
      width="56"
      height="42"
      rx="9"
      fill="none"
      stroke={secondary}
      stroke-width="5"
    />
    <!-- front window (outline) -->
    <rect
      x="44"
      y="52"
      width="58"
      height="44"
      rx="9"
      fill="none"
      stroke={primary}
      stroke-width="6"
    />
    <!-- ›_ prompt inside the front window -->
    <path
      d="M58 66 L69 74 L58 82"
      fill="none"
      stroke={primary}
      stroke-width="6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <rect x="74" y="78" width="16" height="6.5" rx="3.2" fill={primary} />
  </svg>
</div>
