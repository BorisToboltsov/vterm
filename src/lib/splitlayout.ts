// Centre layout model (v1.2): the tree of splits that puts terminal tabs side by
// side. The second half of ADR 0015 — the docks hold the tool panels, the centre
// holds the documents (terminals, with their editors as sub-tabs).
//
// Pure data + pure functions — no runes, no DOM, no i18n. The tabs store
// (`stores/tabs.svelte.ts`) holds one `CenterLayout` and only ever replaces it
// with a result of the functions below; the page renders it.
//
// **A tree here, a flat list on screen.** The leaves are *panes* (a tab strip and
// the tab it shows), the inner nodes are two-way splits. The tree is turned into
// rectangles (`layoutRects`), and every terminal is positioned by the rectangle
// of the pane that holds it — the terminals themselves stay in one flat keyed
// list. That is the point of the shape: moving a tab to another pane changes a
// rectangle, never the component tree, so the `Terminal` is not remounted (its
// `onDestroy` disconnects the session).
//
// Tabs are identified by session id; the model knows nothing else about them.

/** `row` — the two halves stand side by side; `col` — one above the other. */
export type SplitDir = "row" | "col";
export type Edge = "left" | "right" | "top" | "bottom";
export const EDGES: readonly Edge[] = ["left", "right", "top", "bottom"];

export interface Pane {
  kind: "pane";
  id: string;
  /** Session ids in strip order. Across all panes every tab appears exactly once. */
  tabs: string[];
  /**
   * The tab the pane shows. Null only for an empty pane — and a pane is empty
   * only while it is the only one (no tab is open): a pane exists because a tab
   * was put in it, and goes when its last tab leaves.
   */
  active: string | null;
}

export interface Split {
  kind: "split";
  id: string;
  dir: SplitDir;
  /** Share of the first half, 0…1. What is drawn is also bound by the pane minimum. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = Pane | Split;

export interface CenterLayout {
  root: LayoutNode;
  /** Id of the pane in focus — the one the docks, the status bar and new tabs follow. */
  focus: string;
  /** Counter the node ids are minted from, so every function stays deterministic. */
  seq: number;
}

/** A ratio never goes further than this, whatever the pixels allow. */
export const RATIO_MIN = 0.05;
export const RATIO_MAX = 0.95;

/** The smallest pane that is still a usable terminal, and the divider between two. */
export interface PaneLimits {
  minW: number;
  minH: number;
  /** Thickness of the line between two panes, px. */
  gap: number;
}

export const PANE_LIMITS: PaneLimits = { minW: 240, minH: 140, gap: 1 };

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** A ratio brought inside the hard limits (NaN and other junk become a half). */
export const clampRatio = (r: number): number =>
  Number.isFinite(r) ? clamp(r, RATIO_MIN, RATIO_MAX) : 0.5;

// ── Reading ────────────────────────────────────────────────────────────────

/** One empty pane, in focus — the centre before any tab is open. */
export function emptyLayout(): CenterLayout {
  return { root: { kind: "pane", id: "p0", tabs: [], active: null }, focus: "p0", seq: 1 };
}

/** Every pane, in reading order (left to right, top to bottom within a split). */
export function panes(layout: CenterLayout): Pane[] {
  const out: Pane[] = [];
  const walk = (n: LayoutNode): void => {
    if (n.kind === "pane") out.push(n);
    else {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(layout.root);
  return out;
}

/** Every tab, pane by pane in reading order — the order a single strip would show. */
export const orderedTabs = (layout: CenterLayout): string[] =>
  panes(layout).flatMap((p) => p.tabs);

export const findPane = (layout: CenterLayout, id: string): Pane | null =>
  panes(layout).find((p) => p.id === id) ?? null;

/** The pane holding `tab`, or null when no pane does. */
export const paneOf = (layout: CenterLayout, tab: string): Pane | null =>
  panes(layout).find((p) => p.tabs.includes(tab)) ?? null;

/** The pane in focus. Always exists: `focus` names a pane of the tree. */
export const focusedPane = (layout: CenterLayout): Pane =>
  findPane(layout, layout.focus) ?? panes(layout)[0];

/** The session in focus: the tab shown by the focused pane (null — an empty pane). */
export const activeTab = (layout: CenterLayout): string | null => focusedPane(layout).active;

/** The tabs on screen — the one each pane shows. */
export const shownTabs = (layout: CenterLayout): string[] =>
  panes(layout).flatMap((p) => (p.active === null ? [] : [p.active]));

/** The pane after (`+1`) or before (`-1`) `id` in reading order, wrapping round. */
export function neighbourPane(layout: CenterLayout, id: string, step: 1 | -1): Pane {
  const all = panes(layout);
  const at = Math.max(0, all.findIndex((p) => p.id === id));
  return all[(at + step + all.length) % all.length];
}

// ── Rebuilding the tree ────────────────────────────────────────────────────

/** The tree with pane `id` replaced by `fn(pane)`; the same node when nothing changed. */
function mapPane(node: LayoutNode, id: string, fn: (p: Pane) => LayoutNode): LayoutNode {
  if (node.kind === "pane") return node.id === id ? fn(node) : node;
  const a = mapPane(node.a, id, fn);
  const b = mapPane(node.b, id, fn);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

const firstPane = (n: LayoutNode): Pane => (n.kind === "pane" ? n : firstPane(n.a));
const lastPane = (n: LayoutNode): Pane => (n.kind === "pane" ? n : lastPane(n.b));

/**
 * The tree without pane `id`: its split is replaced by the other half, which
 * takes the whole of the freed space. Returns the pane that now stands where the
 * removed one was — the natural place for focus to go.
 */
function dropPane(
  node: LayoutNode,
  id: string,
): { node: LayoutNode; heir: Pane | null } {
  if (node.kind === "pane") return { node, heir: null };
  if (node.a.kind === "pane" && node.a.id === id) return { node: node.b, heir: firstPane(node.b) };
  if (node.b.kind === "pane" && node.b.id === id) return { node: node.a, heir: lastPane(node.a) };
  const a = dropPane(node.a, id);
  if (a.heir) return { node: { ...node, a: a.node }, heir: a.heir };
  const b = dropPane(node.b, id);
  if (b.heir) return { node: { ...node, b: b.node }, heir: b.heir };
  return { node, heir: null };
}

/**
 * Remove a pane that has no tabs left, unless it is the only one. Focus follows
 * to the pane that took its place when the removed pane had it.
 */
function pruneEmpty(layout: CenterLayout, id: string): CenterLayout {
  const pane = findPane(layout, id);
  if (!pane || pane.tabs.length > 0 || layout.root.kind === "pane") return layout;
  const { node, heir } = dropPane(layout.root, id);
  if (!heir) return layout;
  return { ...layout, root: node, focus: layout.focus === id ? heir.id : layout.focus };
}

/** The pane's tabs without `tab`; the shown tab passes to the neighbour in its slot. */
function without(pane: Pane, tab: string): Pane {
  const at = pane.tabs.indexOf(tab);
  if (at < 0) return pane;
  const tabs = pane.tabs.filter((t) => t !== tab);
  const active = pane.active === tab ? (tabs[at] ?? tabs[at - 1] ?? null) : pane.active;
  return { ...pane, tabs, active };
}

// ── Operations ─────────────────────────────────────────────────────────────

/** Give focus to a pane (a no-op for an unknown id). */
export function focusPane(layout: CenterLayout, id: string): CenterLayout {
  return layout.focus === id || !findPane(layout, id) ? layout : { ...layout, focus: id };
}

/** Show `tab` in its pane and focus that pane. */
export function activateTab(layout: CenterLayout, tab: string): CenterLayout {
  const pane = paneOf(layout, tab);
  if (!pane) return layout;
  if (pane.active === tab) return focusPane(layout, pane.id);
  const root = mapPane(layout.root, pane.id, (p) => ({ ...p, active: tab }));
  return { ...layout, root, focus: pane.id };
}

/**
 * Open a new tab: it goes to the end of pane `into` (the focused one by default),
 * is shown there, and the pane takes focus. A tab the layout already holds is
 * only brought to the front.
 */
export function addTab(layout: CenterLayout, tab: string, into?: string): CenterLayout {
  if (paneOf(layout, tab)) return activateTab(layout, tab);
  const target = (into && findPane(layout, into)) || focusedPane(layout);
  const root = mapPane(layout.root, target.id, (p) => ({
    ...p,
    tabs: [...p.tabs, tab],
    active: tab,
  }));
  return { ...layout, root, focus: target.id };
}

/** Where a tab that arrives with another one stands in that one's pane. */
export type Beside = "after" | "before" | "end";

/**
 * Put `tab` into the pane that holds `beside` without showing it and without
 * moving the focus — for a tab that arrives *with* another one: what the panes
 * show stays what it was. A session's open files stand right `after` it when
 * the session moves to this window; the other tabs of a pane that moves whole
 * (v1.10) stand right `before` the tab it showed, or at the `end` of its pane.
 * With `beside` in no pane the tab goes where a new tab goes, still unseen
 * unless that pane was empty.
 */
export function addTabBehind(
  layout: CenterLayout,
  tab: string,
  beside: string,
  where: Beside = "after",
): CenterLayout {
  if (paneOf(layout, tab)) return layout;
  const target = paneOf(layout, beside) ?? focusedPane(layout);
  const found = target.tabs.indexOf(beside);
  const at = found < 0 || where === "end" ? target.tabs.length : where === "before" ? found : found + 1;
  const tabs = [...target.tabs.slice(0, at), tab, ...target.tabs.slice(at)];
  const root = mapPane(layout.root, target.id, (p) => ({ ...p, tabs, active: p.active ?? tab }));
  return { ...layout, root };
}

/**
 * Close a tab. Its pane shows the neighbour instead; a pane left with no tabs is
 * removed (the other half of its split takes the space), unless it is the last.
 */
export function removeTab(layout: CenterLayout, tab: string): CenterLayout {
  const pane = paneOf(layout, tab);
  if (!pane) return layout;
  const root = mapPane(layout.root, pane.id, (p) => without(p, tab));
  return pruneEmpty({ ...layout, root }, pane.id);
}

/**
 * Move a tab to pane `to` at `index` — its position among that pane's *other*
 * tabs (omitted or out of range = the end). Within one pane this is a reorder
 * and changes neither the shown tab nor the focus. Across panes the tab is shown
 * in its new pane and that pane takes focus: a tab that was just moved somewhere
 * and cannot be seen there looks lost.
 */
export function moveTab(
  layout: CenterLayout,
  tab: string,
  to: string,
  index?: number | null,
): CenterLayout {
  const from = paneOf(layout, tab);
  const target = findPane(layout, to);
  if (!from || !target) return layout;
  const others = target.tabs.filter((t) => t !== tab);
  const at =
    index === null || index === undefined || !Number.isFinite(index)
      ? others.length
      : clamp(Math.trunc(index), 0, others.length);
  const tabs = [...others.slice(0, at), tab, ...others.slice(at)];
  if (from.id === target.id) {
    if (tabs.every((t, i) => t === target.tabs[i])) return layout;
    return { ...layout, root: mapPane(layout.root, target.id, (p) => ({ ...p, tabs })) };
  }
  let root = mapPane(layout.root, from.id, (p) => without(p, tab));
  root = mapPane(root, target.id, (p) => ({ ...p, tabs, active: tab }));
  return pruneEmpty({ ...layout, root, focus: target.id }, from.id);
}

/** The split that puts a new pane at `edge` of an existing node. */
function splitNode(id: string, node: LayoutNode, fresh: Pane, edge: Edge): Split {
  const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "col";
  const first = edge === "left" || edge === "top";
  return { kind: "split", id, dir, ratio: 0.5, a: first ? fresh : node, b: first ? node : fresh };
}

/** A new empty pane at `edge` of pane `at`, in focus — a step of `splitWithTab` only. */
function withNewPane(layout: CenterLayout, at: string, edge: Edge): CenterLayout {
  const fresh: Pane = { kind: "pane", id: `p${layout.seq}`, tabs: [], active: null };
  const root = mapPane(layout.root, at, (p) => splitNode(`s${layout.seq + 1}`, p, fresh, edge));
  return { root, focus: fresh.id, seq: layout.seq + 2 };
}

/**
 * Move a tab into a new pane at `edge` of pane `at`; the new pane takes half of
 * that pane's space, shows the tab and gets the focus. This is the only way a
 * pane comes to be — there is no empty pane to open first. A pane's only tab
 * cannot be split off its own pane: that would change nothing on screen.
 */
export function splitWithTab(
  layout: CenterLayout,
  tab: string,
  at: string,
  edge: Edge,
): CenterLayout {
  const from = paneOf(layout, tab);
  if (!from || !findPane(layout, at)) return layout;
  if (from.id === at && from.tabs.length === 1) return layout;
  const split = withNewPane(layout, at, edge);
  return moveTab(split, tab, split.focus);
}

/**
 * Undo every split: one pane holding all the tabs in reading order, showing the
 * tab that was in focus.
 */
export function joinPanes(layout: CenterLayout): CenterLayout {
  if (layout.root.kind === "pane") return layout;
  const tabs = orderedTabs(layout);
  const active = activeTab(layout) ?? shownTabs(layout)[0] ?? null;
  return { ...layout, root: { kind: "pane", id: layout.focus, tabs, active } };
}

/**
 * The grid that fits in `bounds` when `cols` columns are asked for: how many
 * columns it really gets, and how many panes it holds, with every pane keeping
 * its minimum — never less than one of each. The limit is pixels, as everywhere
 * in this model: a grid is not "as many as asked", it is as many as stay usable.
 */
export function gridFit(
  bounds: { width: number; height: number },
  cols: number,
  lim: PaneLimits = PANE_LIMITS,
): { cols: number; panes: number } {
  const fit = (total: number, min: number): number =>
    Math.max(1, Math.floor((Math.max(0, total) + lim.gap) / (min + lim.gap)));
  const across = Math.min(Math.max(1, Math.trunc(cols) || 1), fit(bounds.width, lim.minW));
  return { cols: across, panes: across * fit(bounds.height, lim.minH) };
}

/** `nodes` side by side (`row`) or one above the other (`col`), in equal shares. */
function chain(nodes: LayoutNode[], dir: SplitDir, mint: () => string): LayoutNode {
  if (nodes.length === 1) return nodes[0];
  const [first, ...rest] = nodes;
  return {
    kind: "split",
    id: mint(),
    dir,
    // The first takes its share of what is left: 1/k of k equal parts.
    ratio: clampRatio(1 / nodes.length),
    a: first,
    b: chain(rest, dir, mint),
  };
}

/**
 * Lay tabs out as a grid of panes with one command (v1.9): each of `tabs` gets a
 * pane of its own, `cols` to a row, in the order given; every other tab of the
 * layout joins the first pane, behind the tab it shows. The pane that showed the
 * tab in focus keeps the focus when that tab is one of the tiled, otherwise the
 * first pane takes it.
 *
 * Tabs the layout does not hold are skipped; with none left to tile nothing
 * changes. How many fit, and in how many columns, is the caller's question
 * (`gridFit`) — this lays out what it is given.
 */
export function tileTabs(layout: CenterLayout, tabs: readonly string[], cols: number): CenterLayout {
  const held = new Set(orderedTabs(layout));
  const tiled = [...new Set(tabs)].filter((tab) => held.has(tab));
  if (tiled.length === 0) return layout;
  const across = Math.max(1, Math.min(tiled.length, Math.trunc(cols) || 1));
  const rest = orderedTabs(layout).filter((tab) => !tiled.includes(tab));

  let seq = layout.seq;
  const mint = (kind: "p" | "s") => `${kind}${seq++}`;
  const paneFor = new Map<string, string>();
  const made: Pane[] = tiled.map((tab, i) => {
    const pane: Pane = {
      kind: "pane",
      id: mint("p"),
      tabs: i === 0 ? [tab, ...rest] : [tab],
      active: tab,
    };
    paneFor.set(tab, pane.id);
    return pane;
  });
  const rows: LayoutNode[] = [];
  for (let i = 0; i < made.length; i += across) {
    rows.push(chain(made.slice(i, i + across), "row", () => mint("s")));
  }
  const root = chain(rows, "col", () => mint("s"));
  const active = activeTab(layout);
  return { root, focus: (active !== null && paneFor.get(active)) || made[0].id, seq };
}

/** Set a split's ratio (clamped to the hard limits). */
export function setRatio(layout: CenterLayout, split: string, ratio: number): CenterLayout {
  const next = clampRatio(ratio);
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.kind === "pane") return n;
    if (n.id === split) return n.ratio === next ? n : { ...n, ratio: next };
    const a = walk(n.a);
    const b = walk(n.b);
    return a === n.a && b === n.b ? n : { ...n, a, b };
  };
  const root = walk(layout.root);
  return root === layout.root ? layout : { ...layout, root };
}

// ── Geometry ───────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The line between the two halves of a split, and what dragging it may do. */
export interface Divider {
  split: string;
  dir: SplitDir;
  rect: Rect;
  /** Where the split's own space starts along its axis, px. */
  start: number;
  /** That space without the divider — what the ratio is a share of. */
  avail: number;
  /** The ratio as drawn (the stored one, bound by the pane minimum). */
  ratio: number;
  /** The range a drag may set, so that neither half goes under its minimum. */
  min: number;
  max: number;
}

export interface Placement {
  panes: Record<string, Rect>;
  dividers: Divider[];
}

/** The least space a subtree needs along an axis for every pane to keep its minimum. */
function minExtent(node: LayoutNode, axis: SplitDir, lim: PaneLimits): number {
  if (node.kind === "pane") return axis === "row" ? lim.minW : lim.minH;
  const a = minExtent(node.a, axis, lim);
  const b = minExtent(node.b, axis, lim);
  return node.dir === axis ? a + lim.gap + b : Math.max(a, b);
}

/**
 * Turn the tree into rectangles inside `bounds`. Every pane gets at least the
 * minimum while the space allows; when it does not (a window dragged very
 * small), the halves shrink in proportion to their minimums rather than one of
 * them vanishing.
 */
export function layoutRects(
  root: LayoutNode,
  bounds: { width: number; height: number },
  lim: PaneLimits = PANE_LIMITS,
): Placement {
  const out: Placement = { panes: {}, dividers: [] };
  const place = (node: LayoutNode, r: Rect): void => {
    if (node.kind === "pane") {
      out.panes[node.id] = r;
      return;
    }
    const row = node.dir === "row";
    const total = row ? r.w : r.h;
    const start = row ? r.x : r.y;
    // A split thinner than its own divider line gives the line what there is.
    const gap = Math.min(lim.gap, Math.max(0, total));
    const avail = Math.max(0, total - gap);
    const minA = minExtent(node.a, node.dir, lim);
    const minB = minExtent(node.b, node.dir, lim);
    const fits = avail >= minA + minB;
    const first = fits
      ? clamp(Math.round(avail * clampRatio(node.ratio)), minA, avail - minB)
      : Math.round((avail * minA) / (minA + minB));
    const second = avail - first;
    place(node.a, row ? { ...r, w: first } : { ...r, h: first });
    place(
      node.b,
      row ? { ...r, x: r.x + first + gap, w: second } : { ...r, y: r.y + first + gap, h: second },
    );
    const drawn = avail > 0 ? first / avail : 0.5;
    out.dividers.push({
      split: node.id,
      dir: node.dir,
      rect: row
        ? { x: r.x + first, y: r.y, w: gap, h: r.h }
        : { x: r.x, y: r.y + first, w: r.w, h: gap },
      start,
      avail,
      ratio: drawn,
      min: fits ? Math.min(drawn, Math.max(RATIO_MIN, minA / avail)) : drawn,
      max: fits ? Math.max(drawn, Math.min(RATIO_MAX, 1 - minB / avail)) : drawn,
    });
  };
  place(root, { x: 0, y: 0, w: Math.max(0, bounds.width), h: Math.max(0, bounds.height) });
  return out;
}

/** The ratio a divider takes when dragged to `pos` (px along its axis). */
export function ratioAt(d: Divider, pos: number): number {
  if (!(d.avail > 0)) return d.ratio;
  return clamp((pos - d.start) / d.avail, d.min, d.max);
}

/** The ratio after moving a divider by `px` (keyboard resize). */
export const nudgedRatio = (d: Divider, px: number): number =>
  ratioAt(d, d.start + d.ratio * d.avail + px);

/**
 * Whether a pane of this size can be split at `edge` with both halves keeping
 * the minimum. Splitting a pane that is too small would only produce two panes
 * drawn below it.
 */
export function canSplit(rect: Rect | undefined, edge: Edge, lim: PaneLimits = PANE_LIMITS): boolean {
  if (!rect) return false;
  return edge === "left" || edge === "right"
    ? rect.w >= 2 * lim.minW + lim.gap
    : rect.h >= 2 * lim.minH + lim.gap;
}

// ── Dropping a dragged tab ─────────────────────────────────────────────────

/** Where over a pane the pointer is: near an edge (a split there) or in the middle. */
export type PaneZone = Edge | "center";

/** Share of a pane, from each edge, that reads as "split here". */
export const EDGE_SHARE = 0.25;

/**
 * The zone of `rect` a point falls in. Near two edges at once (a corner) the
 * nearer one wins, measured as a share of the pane so a wide pane does not make
 * its left and right zones swallow the top and bottom ones.
 */
export function paneZone(rect: Rect, x: number, y: number): PaneZone {
  if (!(rect.w > 0) || !(rect.h > 0)) return "center";
  const u = (x - rect.x) / rect.w;
  const v = (y - rect.y) / rect.h;
  const near: [Edge, number][] = [
    ["left", u],
    ["right", 1 - u],
    ["top", v],
    ["bottom", 1 - v],
  ];
  const [edge, dist] = near.reduce((best, cur) => (cur[1] < best[1] ? cur : best));
  return dist < EDGE_SHARE ? edge : "center";
}

/** The part of a pane a drop on `zone` would give the tab — what the overlay tints. */
export function zoneRect(rect: Rect, zone: PaneZone): Rect {
  switch (zone) {
    case "left":
      return { ...rect, w: rect.w / 2 };
    case "right":
      return { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 };
    case "top":
      return { ...rect, h: rect.h / 2 };
    case "bottom":
      return { ...rect, y: rect.y + rect.h / 2, h: rect.h / 2 };
    default:
      return rect;
  }
}

/** Where a dragged tab would land. */
export type TabDrop =
  /** In a pane's strip, at `index` among that pane's other tabs. */
  | { kind: "strip"; pane: string; index: number }
  /** On a pane's body: its middle (join the pane) or an edge (a new pane there). */
  | { kind: "pane"; pane: string; zone: PaneZone };

/** The layout after dropping `tab` on `drop`. */
export function applyDrop(layout: CenterLayout, tab: string, drop: TabDrop): CenterLayout {
  switch (drop.kind) {
    case "strip":
      return moveTab(layout, tab, drop.pane, drop.index);
    default:
      if (drop.zone !== "center") return splitWithTab(layout, tab, drop.pane, drop.zone);
      // The body of the tab's own pane is where it already is — not "to the end".
      return paneOf(layout, tab)?.id === drop.pane ? layout : moveTab(layout, tab, drop.pane);
  }
}

/**
 * Whether a drop would change anything. A target that changes nothing is not
 * offered: the tab's own slot, the body of its own pane, an edge of a pane it is
 * alone in.
 */
export function dropChanges(layout: CenterLayout, tab: string, drop: TabDrop): boolean {
  const from = paneOf(layout, tab);
  if (!from) return false;
  switch (drop.kind) {
    case "strip":
      return from.id !== drop.pane
        ? findPane(layout, drop.pane) !== null
        : moveTab(layout, tab, drop.pane, drop.index) !== layout;
    default:
      return applyDrop(layout, tab, drop) !== layout;
  }
}

/**
 * The tabs a pane's strip draws while `tab` is in the air over `drop`: the order
 * the drop would give, so the other tabs make room. Only a drop on a strip is
 * previewed this way — over a pane's body the strips keep the committed order,
 * and a tint over the body shows where the tab would go.
 */
export function previewTabs(
  layout: CenterLayout,
  pane: string,
  tab: string | null,
  drop: TabDrop | null,
): string[] {
  const own = findPane(layout, pane)?.tabs ?? [];
  if (tab === null || drop?.kind !== "strip") return own;
  const next = findPane(moveTab(layout, tab, drop.pane, drop.index), pane);
  // The pane the tab is leaving may be gone from the result (it was its last
  // tab); until the drop it is still on screen, and its strip closes up too.
  return next ? next.tabs : own.filter((t) => t !== tab);
}

// ── A tab arriving from another window (v1.4, ADR 0018) ────────────────────

/** `tab` put into `pane` at `index` among its tabs (out of range = the end), shown and in focus. */
function insertTab(
  layout: CenterLayout,
  tab: string,
  pane: Pane,
  index?: number | null,
): CenterLayout {
  const at =
    index === null || index === undefined || !Number.isFinite(index)
      ? pane.tabs.length
      : clamp(Math.trunc(index), 0, pane.tabs.length);
  const tabs = [...pane.tabs.slice(0, at), tab, ...pane.tabs.slice(at)];
  const root = mapPane(layout.root, pane.id, (p) => ({ ...p, tabs, active: tab }));
  return { ...layout, root, focus: pane.id };
}

/**
 * Put a tab that is not in the layout yet where it was dropped: at a slot of a
 * strip, into a pane, or into a new pane at a pane's edge. It is shown there
 * and its pane takes the focus. With no drop — or one that names a pane that is
 * gone — it goes where a new tab goes: the end of the pane in focus.
 *
 * This is not "open the tab, then move it": opening it would first make the
 * focused pane show it, and moving it on would leave that pane showing a
 * neighbour instead of what it showed before. Here no pane but the one the tab
 * lands in changes what it shows.
 *
 * An empty pane is the only pane there is (no tab is open); it is not split —
 * the tab simply becomes its first.
 */
export function placeTab(layout: CenterLayout, tab: string, drop: TabDrop | null): CenterLayout {
  if (paneOf(layout, tab)) return activateTab(layout, tab);
  const pane = drop ? findPane(layout, drop.pane) : null;
  if (!pane || !drop) return insertTab(layout, tab, focusedPane(layout));
  if (drop.kind === "strip") return insertTab(layout, tab, pane, drop.index);
  if (drop.zone === "center" || pane.tabs.length === 0) {
    return insertTab(layout, tab, pane);
  }
  const split = withNewPane(layout, pane.id, drop.zone);
  return insertTab(split, tab, focusedPane(split));
}

/**
 * Where the first tab of a pane that moved here whole (v1.10) lands: a pane of
 * its own beside the one in focus — below it when there is no room beside —
 * so the pane arrives as a pane. `null` (it joins the pane in focus) when that
 * pane is empty, or too small to be split either way.
 */
export function arrivalDrop(
  layout: CenterLayout,
  rects: Readonly<Record<string, Rect>>,
  lim: PaneLimits = PANE_LIMITS,
): TabDrop | null {
  const pane = focusedPane(layout);
  if (pane.tabs.length === 0) return null;
  const rect = rects[pane.id];
  if (canSplit(rect, "right", lim)) return { kind: "pane", pane: pane.id, zone: "right" };
  if (canSplit(rect, "bottom", lim)) return { kind: "pane", pane: pane.id, zone: "bottom" };
  return null;
}

/**
 * What a pane's strip shows while a tab from another window is held over this
 * one: its own tabs, with a place kept for the newcomer (`incoming`, an id no
 * real tab has) where `placeTab` would put it. A drop on a pane's edge makes a
 * new pane — that is shown by the tint over the pane, not in any strip.
 */
export function previewIncoming(
  layout: CenterLayout,
  pane: string,
  incoming: string,
  drop: TabDrop | null,
): string[] {
  const own = findPane(layout, pane)?.tabs ?? [];
  return findPane(placeTab(layout, incoming, drop), pane)?.tabs ?? own;
}

// ── A layout read back from storage (v1.6, ADR 0019) ───────────────────────

/** What is written down of a layout: the tree and the pane in focus. */
export interface SavedLayout {
  root: LayoutNode;
  focus: string;
}

/** The part of a layout worth saving; the id counter is recomputed on the way back. */
export const savedLayout = (layout: CenterLayout): SavedLayout => ({
  root: layout.root,
  focus: layout.focus,
});

/** Splits nested deeper than this were not written by this model; what lies below becomes one pane. */
const MAX_DEPTH = 24;
/** Nodes looked at under a subtree that is too deep, before the rest is given up on. */
const MAX_GATHERED = 4096;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The layout to start with, from a saved one and the tabs that are being
 * restored. The only way a stored tree reaches the store (`centerlayout.guard`).
 *
 * What was saved is read, not trusted — it sat in `localStorage`, and the tabs
 * it names may no longer all exist (a server was deleted meanwhile). So the tree
 * is rebuilt rather than checked: every tab of `tabs` ends up in exactly one
 * pane and no other tab does, a pane left without tabs goes with its split,
 * ratios are brought into range, node ids are minted afresh. A tab the tree does
 * not mention — one that came back from another window — joins the pane in
 * focus without being shown: the panes go on showing what they showed.
 */
export function loadLayout(raw: unknown, tabs: readonly string[]): CenterLayout {
  const known = new Set(tabs);
  const placed = new Set<string>();
  const wanted = isRecord(raw) && typeof raw.focus === "string" ? raw.focus : null;
  let seq = 0;
  let focus: string | null = null;

  /** The tabs of a saved pane that are being restored and stand nowhere yet. */
  const take = (list: unknown): string[] => {
    const out: string[] = [];
    if (!Array.isArray(list)) return out;
    for (const tab of list) {
      if (typeof tab !== "string" || !known.has(tab) || placed.has(tab)) continue;
      placed.add(tab);
      out.push(tab);
    }
    return out;
  };

  /** Every tab under a subtree that is too deep to rebuild, as one strip. */
  const gather = (node: unknown): string[] => {
    const out: string[] = [];
    const todo: unknown[] = [node];
    for (let seen = 0; todo.length > 0 && seen < MAX_GATHERED; seen++) {
      const n = todo.pop();
      if (!isRecord(n)) continue;
      if (n.kind === "split") todo.push(n.b, n.a);
      else out.push(...take(n.tabs));
    }
    return out;
  };

  const build = (node: unknown, depth: number): LayoutNode | null => {
    if (!isRecord(node)) return null;
    if (node.kind === "split" && depth < MAX_DEPTH) {
      const a = build(node.a, depth + 1);
      const b = build(node.b, depth + 1);
      if (!a || !b) return a ?? b;
      const ratio = clampRatio(typeof node.ratio === "number" ? node.ratio : NaN);
      return { kind: "split", id: `s${seq++}`, dir: node.dir === "col" ? "col" : "row", ratio, a, b };
    }
    const own = node.kind === "split" ? gather(node) : take(node.tabs);
    if (own.length === 0) return null;
    const id = `p${seq++}`;
    if (focus === null && wanted !== null && node.id === wanted) focus = id;
    const active = typeof node.active === "string" && own.includes(node.active) ? node.active : own[0];
    return { kind: "pane", id, tabs: own, active };
  };

  const root = build(isRecord(raw) ? raw.root : null, 0);
  const rest = [...known].filter((tab) => !placed.has(tab));
  if (!root) {
    if (rest.length === 0) return emptyLayout();
    return { root: { kind: "pane", id: "p0", tabs: rest, active: rest[0] }, focus: "p0", seq: 1 };
  }
  const target = focus ?? firstPane(root).id;
  return {
    root: rest.length === 0 ? root : mapPane(root, target, (p) => ({ ...p, tabs: [...p.tabs, ...rest] })),
    focus: target,
    seq,
  };
}

// ── Invariants ─────────────────────────────────────────────────────────────

/**
 * What is wrong with a layout, as a list (empty = sound). The store never
 * produces an unsound layout; this is what the property tests hold every
 * operation to.
 */
export function layoutProblems(layout: CenterLayout, tabs?: readonly string[]): string[] {
  const out: string[] = [];
  const all = panes(layout);
  const ids = new Set<string>();
  const seen = new Set<string>();
  const walk = (n: LayoutNode): void => {
    if (ids.has(n.id)) out.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    if (n.kind === "split") {
      if (!(n.ratio >= RATIO_MIN && n.ratio <= RATIO_MAX)) out.push(`ratio out of range in ${n.id}`);
      walk(n.a);
      walk(n.b);
    }
  };
  walk(layout.root);
  for (const p of all) {
    for (const t of p.tabs) {
      if (seen.has(t)) out.push(`tab ${t} is in more than one place`);
      seen.add(t);
    }
    if (p.tabs.length === 0 ? p.active !== null : !p.tabs.includes(p.active as string)) {
      out.push(`pane ${p.id} shows a tab it does not hold`);
    }
  }
  if (!all.some((p) => p.id === layout.focus)) out.push("focus names no pane");
  if (all.length > 1) {
    for (const p of all) if (p.tabs.length === 0) out.push(`pane ${p.id} is empty`);
  }
  if (tabs) {
    for (const t of tabs) if (!seen.has(t)) out.push(`tab ${t} is in no pane`);
    for (const t of seen) if (!tabs.includes(t)) out.push(`pane holds unknown tab ${t}`);
  }
  return out;
}
