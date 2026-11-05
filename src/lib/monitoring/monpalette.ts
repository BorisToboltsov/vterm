// Colours of the monitoring page (v1.33). Pure. A series takes one of the
// theme's line colours (`--color-rail-*`, held at ≥ 3:1 on both panels by
// themes.test.ts), so a chart reads on every theme — the old hex constants
// were tuned for near-black and faded on the light ones. A state (ok, warn,
// crit) takes the semantic tokens.

import type { ThresholdLevel } from "./thresholds";

const rail = (n: number) => `var(--color-rail-${n})`;

/** The colour of each kind of series, the same in every section. */
export const SERIES = {
  cpu: rail(1),
  ram: rail(0),
  load: rail(3),
  rx: rail(4),
  tx: rail(2),
  read: rail(4),
  write: rail(2),
  temp: rail(5),
  user: rail(0),
  system: rail(2),
  iowait: rail(3),
  steal: rail(5),
  cache: rail(4),
  swap: rail(2),
  gpu: rail(1),
  vram: rail(0),
  power: rail(3),
} as const;

const TCP: Record<string, number> = {
  ESTAB: 0,
  LISTEN: 1,
  "TIME-WAIT": 3,
  "CLOSE-WAIT": 5,
  "SYN-SENT": 4,
  "SYN-RECV": 4,
  "FIN-WAIT-1": 2,
  "FIN-WAIT-2": 2,
  "LAST-ACK": 6,
  CLOSING: 6,
};

/**
 * A TCP state's colour, by its name. It used to be by position in the list, and
 * the list is sorted by name, so a CLOSE-WAIT appearing repainted every state
 * after it.
 */
export function tcpColor(state: string): string {
  return rail(TCP[state.toUpperCase()] ?? 6);
}

/** The fill of a state: accent when fine, the semantic tokens otherwise. */
export function levelFill(level: ThresholdLevel): string {
  return level === "crit" ? "var(--color-bad)" : level === "warn" ? "var(--color-warn)" : "var(--color-accent)";
}

/** The colour of a status dot. */
export function levelDot(level: ThresholdLevel): string {
  return level === "crit" ? "var(--color-bad)" : level === "warn" ? "var(--color-warn)" : "var(--color-ok)";
}
