// The session actions of the top bar as entries of the Utilities window (v1.16).
//
// Monitoring, recording, the recordings library, broadcast and server notes were
// buttons of the bar and nothing else. Once a button can be taken off, the
// action behind it needs a place it is still found in — and two of the five
// (broadcast, notes) had no other entry point at all. So each is listed in the
// Utilities window, above the tools: what it is, whether it can run now and why
// not, a button that runs it, and the same pin that puts a tool on the bar.
//
// Pure registry and a pure view (which button, enabled or not, for what
// reason); the labels are resolved through i18n by the component.

import type { IconName } from "../ui/icons";
import type { MessageKey } from "../i18n";
import { SESSION_ACTIONS, type SessionAction } from "../topbar/topbaractions";
import { matchesQuery } from "../ui/util";

/** One session action as the Utilities window lists it. */
export interface SessionActionDef {
  id: SessionAction;
  icon: IconName;
  titleKey: MessageKey;
  descKey: MessageKey;
  /** Bilingual (EN+RU) search keywords — never displayed, only matched. */
  keywords: string;
}

const DEFS: Record<SessionAction, Omit<SessionActionDef, "id">> = {
  monitoring: {
    icon: "barChart",
    titleKey: "topbar.monitoring",
    descKey: "sessionact.monitoring.desc",
    keywords: "monitoring metrics cpu memory ram disk network load charts graphs мониторинг метрики процессор память диск сеть нагрузка графики",
  },
  record: {
    icon: "play",
    titleKey: "sessionact.record.title",
    descKey: "sessionact.record.desc",
    keywords: "record recording rec session asciicast capture audit запись записать сессия рек аудит",
  },
  recordings: {
    icon: "activity",
    titleKey: "recordings.title",
    descKey: "sessionact.recordings.desc",
    keywords: "recordings library replay playback asciicast history записи библиотека воспроизвести просмотр история",
  },
  broadcast: {
    icon: "broadcast",
    titleKey: "broadcast.title",
    descKey: "sessionact.broadcast.desc",
    keywords: "broadcast synchronized sync input group multi servers tabs синхронный ввод группа рассылка несколько серверов вкладки",
  },
  notes: {
    icon: "note",
    titleKey: "sessionact.notes.title",
    descKey: "sessionact.notes.desc",
    keywords: "notes server markdown memo заметки сервер маркдаун записка",
  },
};

/** The session actions, in the order the window lists them. */
export const SESSION_ACTION_DEFS: readonly SessionActionDef[] = SESSION_ACTIONS.map((id) => ({
  id,
  ...DEFS[id],
}));

/** The key a session action is selected by in the window — apart from any tool's id. */
export const sessionKey = (id: SessionAction): string => `session:${id}`;

/** The session action a selection key names, or null for a tool's. */
export function keySession(key: string): SessionAction | null {
  const id = key.startsWith("session:") ? key.slice("session:".length) : "";
  return (SESSION_ACTIONS as readonly string[]).includes(id) ? (id as SessionAction) : null;
}

/** Session actions whose keywords match the search (all when it is blank). */
export function sessionActionsMatching(search: string): SessionActionDef[] {
  if (!search.trim()) return [...SESSION_ACTION_DEFS];
  return SESSION_ACTION_DEFS.filter((a) => matchesQuery(`${a.keywords} ${a.id}`, search));
}

/** What the page knows that decides whether each action can run now. */
export interface SessionActionState {
  /** The tab in focus has a session that can be monitored. */
  connected: boolean;
  /** The tab in focus (or the broadcast group) can be recorded. */
  canRecord: boolean;
  recording: boolean;
  /** There is a tab in focus to put into the broadcast group. */
  canBroadcast: boolean;
  broadcastActive: boolean;
  /** The server the notes would open for: its name, or null with none in reach. */
  notesFor: string | null;
}

/** What the window shows for an action right now. */
export interface SessionActionView {
  /** Label of the button that runs it. */
  buttonKey: MessageKey;
  /** The action cannot run now. */
  disabled: boolean;
  /** Why not — shown in place of a silent grey button. Null while it can. */
  reasonKey: MessageKey | null;
  /** The action is a state that is on right now (a recording, a broadcast). */
  on: boolean;
  /** Said next to the button while `on`. */
  onKey: MessageKey | null;
  /** Running it opens something over the window, so the window steps aside. */
  opens: boolean;
}

/** The button, its state and the reason for it, for one action. */
export function sessionActionView(id: SessionAction, s: SessionActionState): SessionActionView {
  switch (id) {
    case "monitoring":
      return {
        buttonKey: "sessionact.monitoring.run",
        disabled: !s.connected,
        reasonKey: s.connected ? null : "sessionact.needSession",
        on: false,
        onKey: null,
        opens: true,
      };
    case "record":
      return {
        buttonKey: s.recording ? "recordings.stop" : "recordings.start",
        disabled: !s.canRecord,
        reasonKey: s.canRecord ? null : "sessionact.needSession",
        on: s.recording,
        onKey: s.recording ? "sessionact.record.on" : null,
        opens: false,
      };
    case "recordings":
      return {
        buttonKey: "sessionact.recordings.run",
        disabled: false,
        reasonKey: null,
        on: false,
        onKey: null,
        opens: true,
      };
    case "broadcast":
      return {
        buttonKey: s.broadcastActive ? "broadcast.removeFromGroup" : "broadcast.addToGroup",
        disabled: !s.canBroadcast,
        reasonKey: s.canBroadcast ? null : "sessionact.needTab",
        on: s.broadcastActive,
        onKey: s.broadcastActive ? "sessionact.broadcast.on" : null,
        opens: false,
      };
    case "notes":
      return {
        buttonKey: "sessionact.notes.run",
        disabled: s.notesFor === null,
        reasonKey: s.notesFor === null ? "sessionact.needServer" : null,
        on: false,
        onKey: null,
        opens: true,
      };
  }
}
