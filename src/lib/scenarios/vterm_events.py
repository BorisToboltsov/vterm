# vterm: the events of a playbook run as JSON lines, for the run view (ADR 0071).
#
# Placed by vterm in the temporary folder of one run and found through
# ANSIBLE_CALLBACK_PLUGINS; writes to $VTERM_EVENTS. A notification callback:
# the terminal shows Ansible's own output as always. Results reach callbacks
# already cleaned (no_log censored by Ansible); messages and diffs are cut short.
from __future__ import annotations

import json
import os
import time

from ansible.plugins.callback import CallbackBase

try:
    from ansible import context
except ImportError:  # very old Ansible
    context = None

DOCUMENTATION = """
name: vterm_events
type: notification
short_description: Events of a run for vterm
description:
  - Writes plays, tasks, results and the recap of a run as JSON lines to the file in VTERM_EVENTS.
"""

MSG_MAX = 2000
DIFF_MAX = 16000


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "notification"
    CALLBACK_NAME = "vterm_events"
    CALLBACK_NEEDS_ENABLED = False
    CALLBACK_NEEDS_WHITELIST = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._fh = None
        path = os.environ.get("VTERM_EVENTS")
        if path:
            try:
                self._fh = open(path, "a", encoding="utf-8")
            except OSError:
                self._fh = None

    def _emit(self, **event):
        if self._fh is None:
            return
        event["t"] = round(time.time(), 3)
        try:
            self._fh.write(json.dumps(event, default=str, ensure_ascii=False) + "\n")
            self._fh.flush()
        except Exception:  # never break the run over the view
            pass

    @staticmethod
    def _cut(value, limit):
        if value is None:
            return None
        text = value if isinstance(value, str) else json.dumps(value, default=str, ensure_ascii=False)
        return text if len(text) <= limit else text[:limit] + "…"

    def _result(self, kind, result, **extra):
        res = result._result if isinstance(result._result, dict) else {}
        hidden = res.get("_ansible_no_log") or res.get("censored")
        msg = None if hidden else (res.get("msg") or res.get("stderr") or res.get("reason"))
        self._emit(
            e="result",
            status=kind,
            host=result._host.get_name(),
            task=str(result._task._uuid),
            changed=bool(res.get("changed")),
            msg=self._cut("(hidden: no_log)" if hidden else msg, MSG_MAX),
            rc=res.get("rc"),
            **extra,
        )

    def v2_playbook_on_start(self, playbook):
        check = False
        if context is not None:
            try:
                check = bool(context.CLIARGS.get("check"))
            except Exception:
                check = False
        self._emit(e="start", file=os.path.basename(getattr(playbook, "_file_name", "") or ""), check=check)

    def v2_playbook_on_play_start(self, play):
        self._emit(e="play", id=str(play._uuid), name=(play.get_name() or "").strip())

    def _task(self, task, handler):
        role = task._role.get_name() if getattr(task, "_role", None) else None
        self._emit(e="task", id=str(task._uuid), name=(task.get_name() or "").strip(), role=role, handler=handler)

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._task(task, False)

    def v2_playbook_on_handler_task_start(self, task):
        self._task(task, True)

    def v2_runner_on_start(self, host, task):
        self._emit(e="running", host=host.get_name(), task=str(task._uuid))

    def v2_runner_on_ok(self, result):
        changed = isinstance(result._result, dict) and bool(result._result.get("changed"))
        self._result("changed" if changed else "ok", result)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._result("failed", result, ignored=bool(ignore_errors))

    def v2_runner_on_skipped(self, result):
        self._result("skipped", result)

    def v2_runner_on_unreachable(self, result):
        self._result("unreachable", result)

    def v2_on_file_diff(self, result):
        res = result._result if isinstance(result._result, dict) else {}
        if res.get("_ansible_no_log") or "diff" not in res:
            return
        try:
            text = self._get_diff(res["diff"])
        except Exception:
            return
        if text:
            self._emit(e="diff", host=result._host.get_name(), task=str(result._task._uuid), diff=self._cut(text, DIFF_MAX))

    def v2_playbook_on_stats(self, stats):
        hosts = {}
        for host in sorted(stats.processed.keys()):
            hosts[host] = stats.summarize(host)
        self._emit(e="stats", hosts=hosts)
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass
            self._fh = None
