// Reusable "info" tooltip action (Phase 20.17). A styled dark bubble shown above
// the trigger, mounted on `document.body` so a scroll container's `overflow` never
// clips it (positioned `fixed` by the trigger's rect). Replaces the slow, unstyled
// native `title`. Styling lives in app.css (`.vt-tooltip`); the accessible text
// stays on the trigger's own `aria-label`, so this action is purely the visual layer.
//
// Timing (Phase 20.17.3) mirrors Radix/MUI: a short open-delay on hover so casual
// mouse-overs don't flicker, but keyboard `focus` and hiding are instant. A shared
// "skip window" makes the next tooltip appear immediately while the pointer sweeps a
// dense toolbar (you wait for the first, not each one).

const OPEN_DELAY = 500; // ms before a hovered tooltip appears
const SKIP_WINDOW = 300; // ms: if another tooltip was just visible, skip the delay
const GAP = 8; // px between the trigger and the bubble (and viewport edges)

// Shared across every trigger: when the last tooltip was dismissed.
let lastHidden = 0;

export function tooltip(node: HTMLElement, text: string | undefined) {
  let content = text;
  let tip: HTMLDivElement | null = null;
  let arrow: HTMLDivElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | undefined;

  function place() {
    if (!tip || !arrow) return;
    const r = node.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const cx = r.left + r.width / 2;
    const left = Math.max(GAP, Math.min(cx - tw / 2, window.innerWidth - tw - GAP));
    // Prefer above; fall below when there isn't room (keeps it on-screen).
    const above = r.top - th - GAP;
    const below = above < GAP;
    const top = below ? r.bottom + GAP : above;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    arrow.style.left = `${Math.round(cx - left - 4)}px`;
    arrow.classList.toggle("vt-tooltip-arrow-below", below);
  }

  function render() {
    if (tip || !content) return;
    tip = document.createElement("div");
    tip.className = "vt-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = content;
    arrow = document.createElement("div");
    arrow.className = "vt-tooltip-arrow";
    tip.appendChild(arrow);
    document.body.appendChild(tip);
    place();
    const el = tip;
    requestAnimationFrame(() => el.classList.add("vt-tooltip-in"));
  }

  // `immediate` (keyboard focus) skips the delay; hovering skips it too when another
  // tooltip was visible moments ago (dense-toolbar sweep).
  function open(immediate: boolean) {
    if (tip) return;
    clearTimeout(showTimer);
    if (immediate || Date.now() - lastHidden < SKIP_WINDOW) render();
    else showTimer = setTimeout(render, OPEN_DELAY);
  }

  function hide() {
    clearTimeout(showTimer);
    if (tip) {
      tip.remove();
      tip = null;
      arrow = null;
      lastHidden = Date.now();
    }
  }

  const onEnter = () => open(false);
  const onFocus = () => open(true);
  node.addEventListener("mouseenter", onEnter);
  node.addEventListener("mouseleave", hide);
  node.addEventListener("focus", onFocus);
  node.addEventListener("blur", hide);
  // A fixed bubble goes stale when the page scrolls/resizes — simplest correct
  // behaviour is to dismiss it (capture scroll so inner containers count too).
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);

  return {
    update(next: string | undefined) {
      content = next;
      if (tip) tip.firstChild!.textContent = content ?? "";
    },
    destroy() {
      hide();
      node.removeEventListener("mouseenter", onEnter);
      node.removeEventListener("mouseleave", hide);
      node.removeEventListener("focus", onFocus);
      node.removeEventListener("blur", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    },
  };
}
