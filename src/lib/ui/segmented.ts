// Keyboard model of the segmented control (SegmentedControl.svelte). It is a
// WAI-ARIA radio group: one tab stop, arrows move the choice and wrap, Home/End
// jump to the ends. Pure so the wrap rules are tested without a DOM (ADR 0003).

/** The index an arrow/Home/End key moves to from `i` among `n` options, or null
 *  when the key is not a navigation key (let it through untouched). */
export function segmentStep(key: string, i: number, n: number): number | null {
  if (n <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (i + 1) % n;
    case "ArrowLeft":
    case "ArrowUp":
      return (i - 1 + n) % n;
    case "Home":
      return 0;
    case "End":
      return n - 1;
    default:
      return null;
  }
}
