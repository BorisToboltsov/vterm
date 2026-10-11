// The order the file panels list a folder in (v1.17). Kept here, not in the
// panel: a session panel is rebuilt on every terminal-tab switch, and an order
// that reset each time would not be a choice. One for the app — the SFTP panel
// and the local one, every session — like the column widths. Persisted to
// localStorage under `vterm.filesort`; the orders and the sanitizer are pure
// (`../filesort.ts`).

import { DEFAULT_SORT, nextSort, sameSort, sanitizeSort, type FileSort, type SortKey } from "../filesort";

export const STORAGE_KEY = "vterm.filesort";

function load(): FileSort {
  try {
    return sanitizeSort(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_SORT };
  }
}

export const fileSort = $state<{ sort: FileSort }>({ sort: load() });

/** Order the listings by `sort`. The same order again changes nothing. */
export function setFileSort(sort: FileSort): void {
  const next = sanitizeSort(sort);
  if (!sameSort(fileSort.sort, next)) fileSort.sort = next;
}

/** A click on a column title: that column, or the same one the other way round. */
export function toggleFileSort(key: SortKey): void {
  fileSort.sort = nextSort(fileSort.sort, key);
}

/** Back to folders-then-names (tests). */
export function resetFileSort(): void {
  setFileSort(DEFAULT_SORT);
}

$effect.root(() => {
  $effect(() => {
    const data = JSON.stringify(fileSort.sort);
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch {
      /* storage unavailable — non-fatal */
    }
  });
});
