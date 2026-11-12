// Synchronous input, as the page drives it (Phase 22; out of +page.svelte and
// grown in ADR 0064): the command line sent to every member, with the
// confirmation for prod; its history and the group's (↑/↓, Ctrl+R and ⌘R); keys
// mode, which passes the keys of the terminal in focus to the members whose
// screen is the same kind; and "paste into all". Who the members are is the
// broadcast store's; the pure decisions are `terminal/broadcast.ts`,
// `grouphistory.ts` and `groupkeys.ts`. The fan-out is N calls to the existing
// `write_to_terminal` — no new backend, no new channel.

import { annotateRecording, writeToTerminal } from "../api";
import { writtenByCall } from "../api/call";
import { diag } from "../api/diag";
import { isRecording } from "../stores/recordings.svelte";
import { frameCommand } from "../terminal/broadcast";
import {
  CLOSED_HISTORY,
  forgetSession,
  groupRows,
  rememberSent,
  type GroupHistoryView,
  type HostHistory,
  type SentCommand,
} from "../terminal/grouphistory";
import { keysReceivers, mirrorable, pastedText, type Screen } from "../terminal/groupkeys";
import { mergeCommands, recentUniqueCommands } from "../terminal/history";

/** What the flow needs of a member's terminal. */
export interface MemberTerminal {
  pasteInto?: (text: string) => void;
  typedCommands?: () => string[];
}

/** What the page tells the flow, each read when it is needed. */
export interface BroadcastDeps {
  /** The live members, in tab order — who a send goes to. */
  targets: () => string[];
  /** The prod servers' sessions among `ids`. */
  prodOf: (ids: string[]) => string[];
  /** A member's name as its tab shows it. */
  label: (id: string) => string;
  /** The screen a member's terminal shows, as it last reported. */
  screenOf: (id: string) => Screen | null;
  term: (id: string) => MemberTerminal | undefined;
  /** The shell history file of a session (`read_shell_history`). */
  readHistory: (id: string) => Promise<string>;
  /** Prod in the group: every member is recorded before it is written to. */
  ensureGroupRecording: () => Promise<void>;
  /** Input reached `id`: its recording is not idle. */
  activity: (id: string) => void;
  /** Give the keyboard to the terminal in focus (keys mode has no line of its own). */
  focusTerminal: () => void;
}

export type BroadcastMode = "line" | "keys";

export function createBroadcastFlow(deps: BroadcastDeps) {
  const encoder = new TextEncoder();
  let mode = $state<BroadcastMode>("line");
  // A command awaiting confirmation because the group includes a prod server.
  let pending = $state<{ frame: string; targets: string[]; cmd: string } | null>(null);
  // Keys mode asked for with prod in the group: on only after the confirmation.
  let keysAsk = $state(false);
  // The prod members keys mode was confirmed for — one that joins later gets no keys until asked.
  let keysProd = new Set<string>();
  let sent = $state.raw<SentCommand[]>([]);
  let history = $state.raw<GroupHistoryView>(CLOSED_HISTORY);
  let historySeq = 0;
  let pasteAsk = $state<{ text: string } | null>(null);

  const labels = (ids: string[]) => ids.map((id) => deps.label(id));

  /**
   * The keys plan from `source`: who gets them, who is on another screen, and
   * the prod members that joined after keys mode was confirmed — held back until asked.
   */
  function keysPlan(source: string) {
    const plan = keysReceivers(source, deps.targets(), deps.screenOf);
    const unconfirmed = new Set(deps.prodOf(plan.to).filter((id) => !keysProd.has(id)));
    return {
      to: plan.to.filter((id) => !unconfirmed.has(id)),
      skipped: plan.skipped,
      held: plan.to.filter((id) => unconfirmed.has(id)),
    };
  }

  /** The fan-out: one `write_to_terminal` per target, and an audit line into each recording. */
  function doBroadcast(frame: string, targets: string[], cmd: string) {
    const bytes = encoder.encode(frame);
    for (const id of targets) {
      writeToTerminal(id, bytes).catch(writtenByCall);
      if (isRecording(id)) annotateRecording(id, `broadcast: ${cmd}`).catch(writtenByCall);
      deps.activity(id);
    }
    sent = rememberSent(sent, cmd, targets);
    diag.info(
      "terminal",
      `broadcast a command to ${targets.length} sessions`,
      { sessions: targets.length, prod: deps.prodOf(targets).length },
      { code: "group-sent" },
    );
  }

  function setMode(next: BroadcastMode) {
    mode = next;
    if (next === "line") keysProd = new Set();
    const sessions = deps.targets().length;
    if (next === "keys") diag.info("terminal", "keys mode of synchronous input on", { sessions }, { code: "group-keys-on" });
    else diag.info("terminal", "keys mode of synchronous input off", { sessions }, { code: "group-keys-off" });
    if (next === "keys") deps.focusTerminal();
  }

  return {
    get mode() {
      return mode;
    },
    get pending() {
      return pending;
    },
    /** The prod members a pending command would reach, by name. */
    get pendingProd() {
      return pending ? labels(deps.prodOf(pending.targets)) : [];
    },
    get keysAsk() {
      return keysAsk;
    },
    /** What the line sent, newest first — what ↑ recalls. */
    get recent() {
      return sent.map((s) => s.cmd);
    },
    get history() {
      return history;
    },
    get pasteAsk() {
      return pasteAsk;
    },

    /** Send the composed command to every live member (prod → confirm first). */
    send(cmd: string) {
      const frame = frameCommand(cmd);
      if (!frame) return;
      const targets = deps.targets();
      if (targets.length === 0) return;
      if (deps.prodOf(targets).length > 0) {
        pending = { frame, targets, cmd };
        return;
      }
      doBroadcast(frame, targets, cmd);
    },

    async confirmSend() {
      const pb = pending;
      pending = null;
      if (!pb) return;
      // Prod broadcast → record the whole group first (audit trail), then send.
      await deps.ensureGroupRecording();
      doBroadcast(pb.frame, pb.targets, pb.cmd);
    },

    cancelSend() {
      pending = null;
    },

    /** Switch between the line and keys mode — keys with prod in the group only after the question. */
    switchMode(next: BroadcastMode) {
      if (next === mode) return;
      if (next === "keys" && deps.prodOf(deps.targets()).length > 0) {
        keysAsk = true;
        return;
      }
      setMode(next);
    },

    async confirmKeys() {
      keysAsk = false;
      keysProd = new Set(deps.prodOf(deps.targets()));
      await deps.ensureGroupRecording();
      setMode("keys");
    },

    cancelKeys() {
      keysAsk = false;
    },

    /** The group is gone: back to the line, nothing open. */
    reset() {
      if (mode === "keys") setMode("line");
      pending = null;
      keysAsk = false;
      pasteAsk = null;
      history = CLOSED_HISTORY;
    },

    /** Who the keys typed into `source` go to, by name — for the line's status. */
    keysStatus(source: string | null) {
      if (!source) return { to: [], skipped: [], held: [] };
      const plan = keysPlan(source);
      return { to: labels(plan.to), skipped: labels(plan.skipped), held: labels(plan.held) };
    },

    /** Keys mode: what the terminal in focus was given goes to the members on the same kind of screen. */
    keys(source: string, data: string) {
      if (mode !== "keys") return;
      const { to } = keysPlan(source);
      if (to.length === 0) return;
      const paste = pastedText(data);
      if (paste !== null) {
        for (const id of to) {
          deps.term(id)?.pasteInto?.(paste);
          deps.activity(id);
        }
        return;
      }
      const keys = mirrorable(data);
      if (keys.length === 0) return;
      const bytes = encoder.encode(keys);
      for (const id of to) {
        writeToTerminal(id, bytes).catch(writtenByCall);
        deps.activity(id);
      }
    },

    /** Ctrl+R / ⌘R in the line: what the line sent and what the members' shells remember. */
    async openHistory() {
      const ids = deps.targets();
      const seq = ++historySeq;
      history = { open: true, loading: true, rows: groupRows(sent, []), unread: [], members: ids.length };
      const unread: string[] = [];
      const hosts: HostHistory[] = await Promise.all(
        ids.map(async (id): Promise<HostHistory> => {
          const typed = deps.term(id)?.typedCommands?.() ?? [];
          try {
            const raw = await deps.readHistory(id);
            return { id, label: deps.label(id), commands: mergeCommands(typed, recentUniqueCommands(raw)) };
          } catch {
            // `call()` wrote the refusal; the list names the member under itself.
            writtenByCall();
            unread.push(deps.label(id));
            return { id, label: deps.label(id), commands: typed.length > 0 ? typed : null };
          }
        }),
      );
      if (seq !== historySeq) return;
      history = { open: true, loading: false, rows: groupRows(sent, hosts), unread, members: ids.length };
    },

    closeHistory() {
      historySeq++;
      history = CLOSED_HISTORY;
    },

    /** Open "paste into all", with a block pasted into the line, or empty. */
    openPaste(text: string) {
      pasteAsk = { text };
    },

    cancelPaste() {
      pasteAsk = null;
    },

    /** Paste `text` into every live member's terminal, each with its own paste. */
    async paste(text: string) {
      pasteAsk = null;
      const targets = deps.targets();
      if (text.length === 0 || targets.length === 0) return;
      if (deps.prodOf(targets).length > 0) await deps.ensureGroupRecording();
      for (const id of targets) {
        deps.term(id)?.pasteInto?.(text);
        deps.activity(id);
      }
      diag.info(
        "terminal",
        `pasted a block into ${targets.length} sessions`,
        { sessions: targets.length, lines: text.split("\n").length },
        { code: "group-pasted" },
      );
    },

    /** A tab closed: what the line sent no longer names it. */
    forget(sessionId: string) {
      sent = forgetSession(sent, sessionId);
      keysProd.delete(sessionId);
    },
  };
}

export type BroadcastFlow = ReturnType<typeof createBroadcastFlow>;
