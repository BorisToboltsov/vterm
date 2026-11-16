// The minimap (ADR 0076): the file in miniature at the right edge, as blocks,
// loaded the first time it is switched on — most sessions never draw it.

import type { Extension } from "@codemirror/state";

export async function minimapExtension(): Promise<Extension> {
  const { showMinimap } = await import("@replit/codemirror-minimap");
  return showMinimap.compute(["doc"], () => ({
    create: () => ({ dom: document.createElement("div") }),
    displayText: "blocks",
    showOverlay: "always",
  }));
}
