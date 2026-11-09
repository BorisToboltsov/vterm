// The floating label of a dragged tab (ghost.html, ADR 0018): a copy of the tab
// as its strip draws it (v1.36). The backend calls `setGhost` with how it looks;
// nothing here calls back. Text goes in as text, never as markup.
let shown = "";

window.setGhost = (look) => {
  const key = JSON.stringify(look);
  if (key === shown) return;
  shown = key;
  const root = document.documentElement.style;
  const vars = { bg: "bg", fg: "fg", muted: "muted", accent: "accent", dot: "dot", chipBg: "chip-bg", chipFg: "chip-fg" };
  for (const [name, prop] of Object.entries(vars)) {
    if (typeof look[name] === "string" && look[name]) root.setProperty(`--${prop}`, look[name]);
  }
  const tab = document.getElementById("tab");
  if (typeof look.font === "string" && look.font) tab.style.font = look.font;
  document.getElementById("title").textContent = look.title || "";
  for (const id of ["sub", "chip"]) {
    const el = document.getElementById(id);
    el.textContent = look[id] || "";
    el.hidden = !look[id];
  }
};
