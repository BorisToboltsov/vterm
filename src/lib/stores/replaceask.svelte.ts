// The question a transfer onto taken names waits on (v1.11.3; one per window
// since v1.12). A transfer is started from several places — the SFTP panel's
// upload and drop, "copy to another session" — and each must ask before it
// replaces a file. The dialog is one (`ReplaceDialog`, mounted by the page); the
// questions queue here, so two transfers started back to back are asked about
// one after the other, not on top of each other.

import { replaceList, type ReplaceAnswer, type UploadCheck } from "../filebrowser";

export interface ReplaceQuestion {
  /** The folder the files land in. */
  dest: string;
  /** Names already there; null — the folder could not be listed. */
  names: string[] | null;
  /** How many more are taken than `names` lists. */
  more: number;
  /** Some of the batch is free to go: "skip the taken ones" means something. */
  canSkip: boolean;
  answer: (a: ReplaceAnswer) => void;
}

const queue = $state<ReplaceQuestion[]>([]);

/** The question on screen now, or null. */
export const currentReplaceQuestion = (): ReplaceQuestion | null => queue[0] ?? null;

/**
 * Ask whether the names `check` found taken in `dest` may be replaced. `check`
 * null — the folder could not be listed, so which names are taken is not known.
 */
export function askReplace(dest: string, check: UploadCheck | null): Promise<ReplaceAnswer> {
  const listed = check ? replaceList(check.clash) : null;
  return new Promise((resolve) => {
    const question: ReplaceQuestion = {
      dest,
      names: listed?.names ?? null,
      more: listed?.more ?? 0,
      canSkip: !!check && check.fresh.length > 0,
      answer: (a) => {
        const at = queue.findIndex((q) => q.answer === question.answer);
        if (at >= 0) queue.splice(at, 1);
        resolve(a);
      },
    };
    queue.push(question);
  });
}

/** Answer the question on screen (the dialog's buttons). */
export function answerReplace(a: ReplaceAnswer): void {
  queue[0]?.answer(a);
}

/** Drop every question unanswered — each as a cancel (tests, window teardown). */
export function clearReplaceQuestions(): void {
  while (queue.length > 0) queue[0].answer("cancel");
}
