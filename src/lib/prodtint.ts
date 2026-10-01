// Prod terminal background tint (v1.0.42): the terminal of a prod session gets
// its theme background mixed with a colour — "barely there", so you feel where you
// are typing without losing the theme. xterm takes a concrete colour string (its
// renderer paints the canvas itself), so the mix is computed here as hex rather
// than left to CSS `color-mix` (colormix.ts). Pure; the setting lives in
// settings.prodTint.
import { isHexColor, mixHex } from "./colormix";

export interface ProdTint {
  enabled: boolean;
  /** The colour mixed into the background, `#rrggbb`. */
  color: string;
  /** How much of it, in percent. */
  strength: number;
}

export const PROD_TINT_MIN = 3;
export const PROD_TINT_MAX = 25;

export const DEFAULT_PROD_TINT: ProdTint = { enabled: true, color: "#7a1f2b", strength: 8 };

/** The background a terminal paints: tinted for an enabled prod tint, else as is. */
export function terminalBackground(bg: string, tint: ProdTint | null): string {
  return tint?.enabled ? mixHex(bg, tint.color, tint.strength) : bg;
}

/** Stored value → a valid tint (bad colour → default, strength clamped). */
export function sanitizeProdTint(raw: unknown): ProdTint {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ProdTint>;
  const strength = typeof r.strength === "number" && Number.isFinite(r.strength)
    ? Math.round(Math.min(Math.max(r.strength, PROD_TINT_MIN), PROD_TINT_MAX))
    : DEFAULT_PROD_TINT.strength;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_PROD_TINT.enabled,
    color: typeof r.color === "string" && isHexColor(r.color) ? r.color : DEFAULT_PROD_TINT.color,
    strength,
  };
}
