// Panel layout store (Svelte 5 runes): resizable widths + collapse state for the
// left server list and the right SFTP panel. Extracted from +page.svelte so the
// layout is one source of truth, persisted to localStorage.
//
// The SFTP panel's collapsed state is intentionally NOT persisted — it always
// starts collapsed (a thin strip) and is expanded to connect SFTP.

export const LEFT_MIN = 160;
export const LEFT_MAX = 560;
export const SFTP_MIN = 240;
export const SFTP_MAX = 720;

/** Which tab the right dock shows (Phase 17.2: SFTP/files vs AI chat; Phase 29: git). */
export type DockTab = "files" | "ai" | "git";

/** Clamp `v` into the inclusive `[lo, hi]` range. */
export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

export interface Layout {
  leftWidth: number;
  leftCollapsed: boolean;
  sftpWidth: number;
  sftpCollapsed: boolean;
  /** Active right-dock tab (persisted). */
  dockTab: DockTab;
}

const STORAGE_KEY = "vterm.layout";

const DEFAULTS: Layout = {
  leftWidth: 256,
  leftCollapsed: false,
  sftpWidth: 384,
  sftpCollapsed: true,
  dockTab: "files",
};

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      leftWidth:
        typeof raw.leftWidth === "number"
          ? clamp(raw.leftWidth, LEFT_MIN, LEFT_MAX)
          : DEFAULTS.leftWidth,
      leftCollapsed: raw.leftCollapsed === true,
      sftpWidth:
        typeof raw.sftpWidth === "number"
          ? clamp(raw.sftpWidth, SFTP_MIN, SFTP_MAX)
          : DEFAULTS.sftpWidth,
      // Not persisted — always starts collapsed.
      sftpCollapsed: true,
      dockTab:
        raw.dockTab === "ai" || raw.dockTab === "git" ? raw.dockTab : "files",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const layout = $state<Layout>(load());

/** Reset layout to defaults (used by tests and a potential "reset UI" action). */
export function resetLayout(): void {
  Object.assign(layout, { ...DEFAULTS });
}

// Persist widths + left-collapse on change (sftpCollapsed deliberately omitted).
$effect.root(() => {
  $effect(() => {
    const data = JSON.stringify({
      leftWidth: layout.leftWidth,
      leftCollapsed: layout.leftCollapsed,
      sftpWidth: layout.sftpWidth,
      dockTab: layout.dockTab,
    });
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch {
      /* storage unavailable — non-fatal */
    }
  });
});
