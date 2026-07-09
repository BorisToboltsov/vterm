// Curated pictogram set for server profiles (Phase 21). Pure data + resolvers,
// DOM-free and unit-tested. Each entry maps a stable key (persisted on the
// profile as `icon`) to a registry glyph (icons.ts) and an i18n label key. The
// colour is a separate small palette (key → Tailwind text/swatch classes, stored
// as `iconColor`). Unknown / empty values fall back to the generic server glyph
// and the muted colour, so old profiles and hand-edited JSON never break.

import type { IconName } from "./icons";
import type { MessageKey } from "./i18n";

export interface ServerIconDef {
  /** Stable key stored on the profile's `icon`. */
  key: string;
  /** Registry glyph (icons.ts). */
  icon: IconName;
  /** i18n key for the human label (tooltip / aria-label). */
  labelKey: MessageKey;
}

/** Key + glyph used when a profile has no (or an unknown) icon. */
export const DEFAULT_SERVER_ICON = "generic";

// Extended set (~24): purpose/role glyphs plus a few tech-flavoured ones. Order
// here is the picker order.
export const SERVER_ICONS: ServerIconDef[] = [
  { key: "generic", icon: "server", labelKey: "serverIcon.generic" },
  { key: "web", icon: "globe", labelKey: "serverIcon.web" },
  { key: "api", icon: "braces", labelKey: "serverIcon.api" },
  { key: "database", icon: "database", labelKey: "serverIcon.database" },
  { key: "cache", icon: "bolt", labelKey: "serverIcon.cache" },
  { key: "shell", icon: "terminal", labelKey: "serverIcon.shell" },
  { key: "code", icon: "code", labelKey: "serverIcon.code" },
  { key: "cloud", icon: "cloud", labelKey: "serverIcon.cloud" },
  { key: "container", icon: "container", labelKey: "serverIcon.container" },
  { key: "kubernetes", icon: "kubernetes", labelKey: "serverIcon.kubernetes" },
  { key: "security", icon: "shield", labelKey: "serverIcon.security" },
  { key: "vpn", icon: "lock", labelKey: "serverIcon.vpn" },
  { key: "proxy", icon: "gateway", labelKey: "serverIcon.proxy" },
  { key: "network", icon: "network", labelKey: "serverIcon.network" },
  { key: "balancer", icon: "loadBalancer", labelKey: "serverIcon.balancer" },
  { key: "mail", icon: "mail", labelKey: "serverIcon.mail" },
  { key: "monitoring", icon: "barChart", labelKey: "serverIcon.monitoring" },
  { key: "storage", icon: "archive", labelKey: "serverIcon.storage" },
  { key: "backup", icon: "save", labelKey: "serverIcon.backup" },
  { key: "compute", icon: "cpu", labelKey: "serverIcon.compute" },
  { key: "memory", icon: "memory", labelKey: "serverIcon.memory" },
  { key: "disk", icon: "disk", labelKey: "serverIcon.disk" },
  { key: "perf", icon: "gauge", labelKey: "serverIcon.perf" },
  { key: "deploy", icon: "rocket", labelKey: "serverIcon.deploy" },
];

const ICON_BY_KEY = new Map(SERVER_ICONS.map((d) => [d.key, d]));

/** The registry glyph for a profile's icon key; the generic server glyph when the
 *  key is empty / unknown. Never throws. */
export function resolveServerIcon(key: string | null | undefined): IconName {
  const def = (key && ICON_BY_KEY.get(key)) || ICON_BY_KEY.get(DEFAULT_SERVER_ICON);
  return def!.icon;
}

/** The i18n label key for a profile's icon key; the generic label when empty /
 *  unknown. Used to name the selection in the collapsed picker header. */
export function resolveServerIconLabelKey(key: string | null | undefined): MessageKey {
  const def = (key && ICON_BY_KEY.get(key)) || ICON_BY_KEY.get(DEFAULT_SERVER_ICON);
  return def!.labelKey;
}

export interface ServerColorDef {
  /** Stable key stored on the profile's `iconColor`. */
  key: string;
  /** Tailwind text-colour class for the glyph. */
  text: string;
  /** Tailwind bg-colour class for the picker swatch. */
  swatch: string;
  /** i18n key for the human label. */
  labelKey: MessageKey;
}

// Categorical palette (fixed hues so they read on any terminal theme, like the
// connection-status dots). Empty `iconColor` → muted (`text-muted`).
export const SERVER_COLORS: ServerColorDef[] = [
  { key: "blue", text: "text-sky-400", swatch: "bg-sky-400", labelKey: "serverColor.blue" },
  { key: "green", text: "text-emerald-400", swatch: "bg-emerald-400", labelKey: "serverColor.green" },
  { key: "amber", text: "text-amber-400", swatch: "bg-amber-400", labelKey: "serverColor.amber" },
  { key: "red", text: "text-rose-400", swatch: "bg-rose-400", labelKey: "serverColor.red" },
  { key: "purple", text: "text-violet-400", swatch: "bg-violet-400", labelKey: "serverColor.purple" },
  { key: "teal", text: "text-teal-400", swatch: "bg-teal-400", labelKey: "serverColor.teal" },
  { key: "slate", text: "text-slate-400", swatch: "bg-slate-400", labelKey: "serverColor.slate" },
];

const COLOR_BY_KEY = new Map(SERVER_COLORS.map((c) => [c.key, c]));

/** Tailwind text-colour class for a profile's glyph; muted when unset / unknown. */
export function resolveServerColorClass(key: string | null | undefined): string {
  const def = key ? COLOR_BY_KEY.get(key) : undefined;
  return def ? def.text : "text-muted";
}
