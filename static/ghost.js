// The floating label of a dragged tab (ghost.html, ADR 0018). The backend calls
// `setGhost` with how the label looks; nothing here calls back.
let shown = "";

window.setGhost = (look) => {
  const key = JSON.stringify(look);
  if (key === shown) return;
  shown = key;
  const root = document.documentElement.style;
  for (const name of ["bg", "fg", "accent", "dot"]) {
    if (typeof look[name] === "string" && look[name]) root.setProperty(`--${name}`, look[name]);
  }
  document.getElementById("title").textContent = look.title || "";
};
