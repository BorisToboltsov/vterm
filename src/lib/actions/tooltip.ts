// Reusable "info" tooltip action (Phase 20.17). A styled dark bubble shown above
// the trigger on hover/focus, mounted on `document.body` so a scroll container's
// `overflow` never clips it (it's positioned `fixed` by the trigger's rect).
// Replaces the slow, unstyled native `title`. Styling lives in app.css
// (`.vt-tooltip`); the accessible text stays on the trigger's own `aria-label`,
// so this action is purely the visual layer.

const GAP = 8; // px between the trigger and the bubble (and viewport edges)

export function tooltip(node: HTMLElement, text: string | undefined) {
  let content = text;
  let tip: HTMLDivElement | null = null;
  let arrow: HTMLDivElement | null = null;

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

  function show() {
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

  function hide() {
    tip?.remove();
    tip = null;
    arrow = null;
  }

  node.addEventListener("mouseenter", show);
  node.addEventListener("mouseleave", hide);
  node.addEventListener("focus", show);
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
      node.removeEventListener("mouseenter", show);
      node.removeEventListener("mouseleave", hide);
      node.removeEventListener("focus", show);
      node.removeEventListener("blur", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    },
  };
}
