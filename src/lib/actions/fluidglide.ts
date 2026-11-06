// How the interface moves when its room changes — what and why in
// `../ui/fluidfit.ts`. Every such animation is started here: the fitted screens
// (connecting, empty state), a row whose items go into «⋯» (top bar, status bar,
// a panel's toolbar), a part beside a list, a panel crossing its width threshold,
// a grid changing its columns. Each only ever animates `transform` or `opacity`:
// neither lays anything out, so a glide never moves what a fit has just measured.
// The time comes from `motionMs`: reduced motion places everything at once.

import {
  comesBack,
  drawnBox,
  glideFrom,
  morphFrom,
  rowMoves,
  type Box,
  type Rect,
} from "../ui/fluidfit";
import { MOTION_BASE, motionMs, prefersReducedMotion } from "../ui/motion";

/** The glide's curve: quick off the mark, settling softly. */
export const GLIDE_EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";

/** How long a glide runs now — not at all with reduced motion. */
export const glideMs = (): number => motionMs(MOTION_BASE, prefersReducedMotion());

/** A block's layout box (offsets ignore transforms, so a glide on it does not count). */
const boxOf = (b: HTMLElement): Box => ({
  mid: b.offsetTop + b.offsetHeight / 2,
  height: b.offsetHeight,
});

export interface Glider {
  /** Where each block is drawn now — asked before the screen is laid out anew. */
  drawn(blocks: HTMLElement[]): (Box | undefined)[];
  /**
   * The screen is laid out anew: each block that moved glides from where it was
   * drawn (`from`), one that comes back fades in; with `glide` false they are
   * only placed. Returns the shift each block's glide starts at (0 for none).
   */
  settle(
    blocks: HTMLElement[],
    from: (Box | undefined)[],
    glide: boolean,
    scales?: (block: HTMLElement) => boolean,
  ): number[];
}

/** The glides of one screen: where its blocks were laid out, and the glide each is on. */
export function createGlider(): Glider {
  const laidAt = new WeakMap<HTMLElement, Box>();
  const glides = new WeakMap<HTMLElement, Animation>();

  return {
    drawn: (blocks) =>
      blocks.map((b) => {
        const laid = laidAt.get(b);
        const glide = glides.get(b);
        if (!laid || !glide || glide.playState === "finished") return laid;
        return drawnBox(laid, getComputedStyle(b).transform);
      }),

    settle(blocks, from, glide, scales = () => false) {
      const ms = glide ? glideMs() : 0;
      return blocks.map((b, i) => {
        const to = boxOf(b);
        const was = laidAt.get(b);
        // Laid where it was: a glide it is on still goes to the right place.
        if (was && was.mid === to.mid && was.height === to.height) return 0;
        laidAt.set(b, to);
        glides.get(b)?.cancel();
        glides.delete(b);
        if (!ms || typeof b.animate !== "function") return 0;
        if (comesBack(from[i], to)) {
          b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: GLIDE_EASING });
          return 0;
        }
        const move = glideFrom(from[i], to, scales(b));
        if (!move) return 0;
        const anim = b.animate(
          [{ transform: `translateY(${move.dy}px) scale(${move.scale})` }, { transform: "none" }],
          { duration: ms, easing: GLIDE_EASING },
        );
        glides.set(b, anim);
        return move.dy;
      });
    },
  };
}

/** Where `el` is drawn, from the screen's top-left corner — its glides included. */
export function drawnRect(el: HTMLElement, screen: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  const s = screen.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, width: r.width, height: r.height };
}

/** Where `el` is laid out, from the screen's top-left corner: offsets, so no glide counts.
 *  The screen must be its offset parent. */
export const laidRect = (el: HTMLElement): Rect => ({
  x: el.offsetLeft,
  y: el.offsetTop,
  width: el.offsetWidth,
  height: el.offsetHeight,
});

/**
 * Flies `el`, just laid out, from where another part was drawn (`from`) into its
 * place — an icon from a badge into the title's row. `carried` is the shift its
 * block's glide starts at.
 */
export function morph(el: HTMLElement, from: Rect | undefined, carried: number): void {
  const ms = glideMs();
  if (!ms || typeof el.animate !== "function") return;
  const move = morphFrom(from, laidRect(el), carried);
  if (!move) return;
  el.animate(
    [{ transform: `translate(${move.dx}px, ${move.dy}px) scale(${move.scale})` }, { transform: "none" }],
    { duration: ms, easing: GLIDE_EASING },
  );
}

// ── A row whose items go into «⋯» ─────────────────────────────────────────────

export interface RowGlide {
  /** Where the row's items are drawn now, and a picture of each — asked before the row changes. */
  snapshot(): void;
  /** The row has changed: each item moves on from where it was drawn. */
  play(): void;
}

/** Inherited text styles a picture taken out of its row must carry along. */
const CARRIED = ["color", "font", "letterSpacing", "lineHeight", "whiteSpace"] as const;

/** A copy of `el` to draw once more where it was: inert, unseen by tests and readers. */
function pictureOf(el: HTMLElement): HTMLElement {
  const pic = el.cloneNode(true) as HTMLElement;
  const style = getComputedStyle(el);
  for (const prop of CARRIED) pic.style[prop] = style[prop];
  for (const node of [pic, ...pic.querySelectorAll<HTMLElement>("*")]) {
    node.removeAttribute("id");
    node.removeAttribute("data-testid");
    node.removeAttribute("tabindex");
  }
  pic.setAttribute("aria-hidden", "true");
  pic.inert = true;
  return pic;
}

/**
 * The glide of a row whose items go into «⋯» as the room goes (the status bar, a
 * panel's toolbar). Its items are its elements with `data-row-key`, one of them
 * maybe «⋯» (`more`); an item `shown` says no to is not drawn. An item that goes is
 * drawn once more where it was — a picture of it, over everything — and flies
 * into «⋯»; one that comes back flies out of it; the rest glide to their places.
 * `base` is the row's own time (`motionMs` takes it away with reduced motion).
 */
export function createRowGlide(
  row: () => HTMLElement | null,
  {
    more = null as string | null,
    base = MOTION_BASE,
    shown = (el: HTMLElement): boolean => el.getAttribute("aria-hidden") !== "true",
  } = {},
): RowGlide {
  type Seen = { row: HTMLElement; rects: Map<string, Rect>; pictures: Map<string, HTMLElement> };
  let before: Seen | null = null;
  const running = new Set<Animation>();
  const items = (el: HTMLElement): HTMLElement[] =>
    [...el.querySelectorAll<HTMLElement>("[data-row-key]")].filter(shown);
  const run = (el: HTMLElement, frames: Keyframe[], ms: number): Animation | null => {
    if (typeof el.animate !== "function") return null;
    const anim = el.animate(frames, { duration: ms, easing: GLIDE_EASING });
    running.add(anim);
    const done = (): void => void running.delete(anim);
    anim.onfinish = done;
    anim.oncancel = done;
    return anim;
  };

  return {
    snapshot() {
      const el = row();
      if (!el || !el.isConnected) {
        before = null;
        return;
      }
      const rects = new Map<string, Rect>();
      const pictures = new Map<string, HTMLElement>();
      for (const item of items(el)) {
        const key = item.dataset.rowKey ?? "";
        rects.set(key, drawnRect(item, el));
        pictures.set(key, pictureOf(item));
      }
      before = { row: el, rects, pictures };
    },

    play() {
      const was = before;
      before = null;
      const el = row();
      // Another row (the bar drawn for another session) moves from nowhere.
      if (!was || !el || was.row !== el || !el.isConnected) return;
      const ms = motionMs(base, prefersReducedMotion());
      if (!ms) return;
      for (const anim of [...running]) anim.cancel();
      const now = new Map(items(el).map((item) => [item.dataset.rowKey ?? "", item] as const));
      const after = new Map([...now].map(([key, item]) => [key, drawnRect(item, el)] as const));
      const origin = el.getBoundingClientRect();
      for (const move of rowMoves(was.rects, after, more)) {
        if (move.kind === "glide") {
          run(now.get(move.key)!, [{ transform: `translate(${move.dx}px, ${move.dy}px)` }, { transform: "none" }], ms);
        } else if (move.kind === "enter") {
          const from = morphFrom(move.from ?? undefined, move.to);
          run(
            now.get(move.key)!,
            [
              {
                transform: from ? `translate(${from.dx}px, ${from.dy}px) scale(${from.scale})` : "scale(0.6)",
                opacity: 0,
              },
              { transform: "none", opacity: 1 },
            ],
            ms,
          );
        } else {
          const pic = was.pictures.get(move.key);
          if (!pic) continue;
          Object.assign(pic.style, {
            position: "fixed",
            left: `${origin.left + move.from.x}px`,
            top: `${origin.top + move.from.y}px`,
            width: `${move.from.width}px`,
            height: `${move.from.height}px`,
            margin: "0",
            boxSizing: "border-box",
            pointerEvents: "none",
            zIndex: "60",
          });
          document.body.append(pic);
          const to = move.to ? morphFrom(move.to, move.from) : null;
          const anim = run(
            pic,
            [
              { transform: "none", opacity: 1 },
              { transform: to ? `translate(${to.dx}px, ${to.dy}px) scale(${to.scale})` : "scale(0.6)", opacity: 0 },
            ],
            ms,
          );
          if (!anim) pic.remove();
          else anim.finished.then(() => pic.remove(), () => pic.remove());
        }
      }
    },
  };
}

/** What a Svelte transition draws: for how long, how, and its CSS at each step. */
type TransitionStyle = { duration: number; easing: (t: number) => number; css: (t: number, u: number) => string };

/** How big each bar's «⋯» was when last seen — for the change that takes it away. */
const moreSize = new WeakMap<Element, { width: number; height: number }>();

/**
 * Svelte transition: a top-bar button goes into «⋯» (`more`, a selector among its
 * siblings) and comes back out of it. Svelte keeps a button that goes where it
 * stood while the others glide. Deferred (a function): «⋯» is drawn after the
 * buttons in the same change, so it is looked for once the change is in the DOM.
 * When the last buttons come back «⋯» goes in that same change: they come out of
 * where it stood — the bar's right end, «⋯» being its last button.
 */
export function viaMore(
  node: Element,
  { duration, more }: { duration: number; more: string },
): () => TransitionStyle {
  return () => {
    const bar = node.parentElement;
    const box = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    const target = bar?.querySelector(more);
    let from: Rect | undefined;
    if (bar && target) {
      from = box(target);
      moreSize.set(bar, { width: from.width, height: from.height });
    } else if (bar && moreSize.has(bar)) {
      const { width, height } = moreSize.get(bar)!;
      const b = box(bar);
      from = { x: b.x + b.width - width, y: b.y + (b.height - height) / 2, width, height };
    }
    const at = morphFrom(from, box(node));
    return {
      duration,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      css: at
        ? (t, u) => `transform: translate(${u * at.dx}px, ${u * at.dy}px) scale(${1 - u * (1 - at.scale)}); opacity: ${t}`
        : (t, u) => `transform: scale(${1 - u * 0.4}); opacity: ${t}`,
    };
  };
}

/**
 * Svelte transition: the part beside a list (a commit, a container's details, the
 * search) slides in from its side and out to it, fading. Going, it is taken out of
 * the flow where it stands — the list takes the room at once instead of waiting
 * for it to leave. Its parent must be the positioned one.
 */
export function aside(
  node: HTMLElement,
  { duration }: { duration: number },
  options?: { direction?: "in" | "out" | "both" },
): TransitionStyle {
  if (options?.direction === "out" && duration > 0) {
    const { offsetLeft, offsetTop, offsetWidth, offsetHeight } = node;
    Object.assign(node.style, {
      position: "absolute",
      left: `${offsetLeft}px`,
      top: `${offsetTop}px`,
      width: `${offsetWidth}px`,
      height: `${offsetHeight}px`,
    });
  }
  return {
    duration,
    easing: (t) => 1 - Math.pow(1 - t, 3),
    css: (t, u) => `transform: translateX(${u * 40}%); opacity: ${t}`,
  };
}

// ── A panel crossing its width threshold ──────────────────────────────────────

export interface PanelMorph {
  /** Where the panel's lasting blocks (`data-morph`) are drawn now. */
  record(): void;
  /** The panel has taken its other layout: it shows up anew, its lasting blocks glide over. */
  play(): void;
}

/**
 * A panel's switch between its narrow and wide layout (`wideWhen`). The CSS half of
 * the switch (`@wide:`) is laid out before anyone hears of it, so where the blocks
 * stood is what was recorded the last time the panel was measured — every frame
 * while a dock is dragged. The new layout fades in; the blocks that are in both
 * (`data-morph`: the filter's row, the list) glide from where they stood.
 */
export function createPanelMorph(node: HTMLElement): PanelMorph {
  let last = new Map<Element, Rect>();
  const running = new Set<Animation>();
  const blocks = (): HTMLElement[] => [...node.querySelectorAll<HTMLElement>("[data-morph]")];
  const record = (): void => {
    last = new Map(blocks().map((b) => [b, drawnRect(b, node)] as const));
  };
  return {
    record,
    play() {
      const ms = glideMs();
      if (!ms || typeof node.animate !== "function") return record();
      for (const anim of [...running]) anim.cancel();
      const keep = (anim: Animation): void => {
        running.add(anim);
        const done = (): void => void running.delete(anim);
        anim.onfinish = done;
        anim.oncancel = done;
      };
      keep(node.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: ms, easing: GLIDE_EASING }));
      for (const b of blocks()) {
        const from = last.get(b);
        if (!from || typeof b.animate !== "function") continue;
        const to = drawnRect(b, node);
        const dx = from.x - to.x;
        const dy = from.y - to.y;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        keep(b.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: ms, easing: GLIDE_EASING }));
      }
      record();
    },
  };
}

// ── A grid changing its number of columns ─────────────────────────────────────

/**
 * `use:gridGlide` — the cards of every grid inside glide to their new places when
 * the grid changes how many columns it has (a window made narrower takes the
 * monitoring page's two columns to one). Between such changes nothing moves: the
 * cards only follow their columns' width.
 */
export function gridGlide(node: HTMLElement) {
  type Seen = { cols: number; rects: Map<Element, Rect> };
  const seen = new WeakMap<HTMLElement, Seen>();
  const running = new WeakMap<Element, Animation>();
  const tracks = (grid: HTMLElement): number =>
    getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;

  const check = (): void => {
    const ms = glideMs();
    for (const grid of node.querySelectorAll<HTMLElement>(".grid")) {
      const kids = [...grid.children] as HTMLElement[];
      if (kids.length < 2) continue;
      const cols = tracks(grid);
      const prev = seen.get(grid);
      if (prev && prev.cols !== cols && ms) {
        for (const k of kids) running.get(k)?.cancel();
        for (const k of kids) {
          const from = prev.rects.get(k);
          if (!from || typeof k.animate !== "function") continue;
          const to = drawnRect(k, grid);
          const dx = from.x - to.x;
          const dy = from.y - to.y;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
          running.set(k, k.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: ms, easing: GLIDE_EASING }));
        }
      }
      seen.set(grid, { cols, rects: new Map(kids.map((k) => [k, drawnRect(k, grid)] as const)) });
    }
  };

  const observer = new ResizeObserver(check);
  observer.observe(node);
  check();
  return {
    destroy(): void {
      observer.disconnect();
    },
  };
}
