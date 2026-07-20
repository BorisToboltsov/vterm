// Turning a corrupt-config warning from the backend into the message the user
// sees. Pure, so the branch that matters can be tested without a DOM: whether the
// user's data was rescued or is still at risk are two different pieces of news,
// and collapsing them into one polite sentence would be the same mistake the
// silent empty list made in the first place.

import type { StoreWarning } from "./api/core";
import type { MessageKey, MessageParams } from "./i18n/messages";

/** A translatable message: the key to look up plus its interpolation params. */
export interface WarningMessage {
  key: MessageKey;
  params: MessageParams;
}

/** Basename of a path, for a message that should not be a wall of directories. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * The toast for one quarantined config file.
 *
 * `quarantined` present → the original bytes survive at that path, so the message
 * says where. `quarantined` null → the file could not even be moved aside, which
 * is the worse case and must not read like the recoverable one.
 */
export function storeWarningMessage(w: StoreWarning): WarningMessage {
  const file = baseName(w.file);
  return w.quarantined
    ? { key: "store.corruptSaved", params: { file, saved: w.quarantined } }
    : { key: "store.corruptStuck", params: { file: w.file } };
}
