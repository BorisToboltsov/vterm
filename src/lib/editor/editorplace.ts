// Where in a line the cursor lands for a place named outside the editor: a
// column after `x.c:42:5` in terminal output (gcc, rustc, eslint, tsc count it
// from 1). Pure: the editor hands in the line's length, gets back an offset.

/**
 * The offset into a line of `length` characters for 1-based `column`: the
 * line's start without a column, its end for a column past it — a file edited
 * since the output was printed still opens on its line.
 */
export function columnOffset(length: number, column?: number | null): number {
  if (!column || !Number.isFinite(column) || column <= 1) return 0;
  return Math.min(Math.floor(column) - 1, Math.max(0, length));
}
