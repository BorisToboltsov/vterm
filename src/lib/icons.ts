// Central SVG icon registry. One source of truth for the line-icons used across
// the UI (replacing scattered emoji like 📁/📄/✎/×). Each entry is the inner
// markup of a 24×24, currentColor, stroke-based icon — see Icon.svelte.
//
// Extensible by design (Phase 6.5): add a key here and it's available everywhere
// as <Icon name="…" />.

export const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  file: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 3h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>',
  symlink:
    '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 3h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 17l5-5M14 16v-4h-4"/>',
  server:
    '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
  chevronRight: '<path d="M9 18l6-6-6-6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  upload: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  download: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 6 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 1.6 14H1a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 3 6a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 1.6V1a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 3a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 22.4 9H23a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  alert:
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',

  // Status-bar resource icons (centralised here as the single source of truth).
  cpu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3"/>',
  memory:
    '<rect x="2" y="7" width="20" height="9" rx="1"/><path d="M5 16v3M9 16v3M15 16v3M19 16v3"/><path d="M7 10v3M12 10v3M17 10v3"/>',
  disk: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="12" r="2.4"/><path d="M15 9.5v5"/>',

  // OS family marks for the status bar (line style, matching the icon set).
  osApple:
    '<path d="M16 13.5c0 2.5-1.8 4.8-3 4.8-.8 0-1.3-.4-2-.4s-1.2.4-2 .4c-1.2 0-3-2.3-3-4.8 0-2.8 1.8-4.5 3.6-4.5.9 0 1.4.4 1.4.4s.5-.4 1.4-.4c1.8 0 3.6 1.7 3.6 4.5z"/><path d="M12 8.5c0-1.5 1.1-2.8 2.6-3"/>',
  osLinux:
    '<path d="M9.5 5.5a2.5 2.5 0 0 1 5 0v3c0 1 .6 1.8 1.4 2.6 1.8 1.8 2.3 4.6 1.4 6.4-.7 1.4-2.3 1-2.7-.1-.4 1.1-1.9 1.1-2.6 1.1h-1c-.7 0-2.2 0-2.6-1.1-.4 1.1-2 1.5-2.7.1-.9-1.8-.4-4.6 1.4-6.4.8-.8 1.4-1.6 1.4-2.6z"/><path d="M11 7.5h.01M13 7.5h.01"/>',
  osWindows:
    '<rect x="3" y="3.5" width="7.5" height="7.5" rx="0.5"/><rect x="13.5" y="3.5" width="7.5" height="7.5" rx="0.5"/><rect x="3" y="13" width="7.5" height="7.5" rx="0.5"/><rect x="13.5" y="13" width="7.5" height="7.5" rx="0.5"/>',
  osBsd:
    '<path d="M6 7c-1-2.5.8-4.2 1.8-3.2M18 7c1-2.5-.8-4.2-1.8-3.2"/><circle cx="12" cy="13" r="7"/><path d="M9.5 12h.01M14.5 12h.01"/><path d="M9.5 16c1.6 1.3 3.4 1.3 5 0"/>',
  osUnknown:
    '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.4 2.4 0 0 1 4.6.9c0 1.6-2.2 1.9-2.2 3.4"/><path d="M12 17h.01"/>',
} as const;

export type IconName = keyof typeof ICONS;
