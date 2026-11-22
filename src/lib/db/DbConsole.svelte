<script lang="ts">
  // A database's SQL console (ADR 0080), a document of the connection that
  // reaches it. ⌘/Ctrl+Enter runs the statement under the caret (or the
  // selection), one statement at a time; a statement the classifier is unsure
  // of, one easy to regret, or one that needs read-only lifted is asked about
  // first — in red on a prod server. The answer, the plan and the edits of the
  // last answer share the lower half.
  import { holdSelection } from "../actions/drag";
  import { tooltip } from "../actions/tooltip";
  import { writeClipboard } from "../app/clipboard";
  import { t } from "../i18n";
  import {
    applyDbEdits,
    cancelDb,
    catalogOf,
    checkRun,
    dbDoc,
    discardDbEdits,
    editDbCell,
    pendingCount,
    pendingStatements,
    planOf,
    prepareEdit,
    runSql,
    setTxMode,
    toggleDbRowDelete,
    type RunCheck,
  } from "../stores/db.svelte";
  import { notifySuccess } from "../stores/toasts.svelte";
  import { setConsoleText, type EditorDoc } from "../stores/workspaces.svelte";
  import type { DbProfile } from "../types";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import Icon from "../ui/Icon.svelte";
  import DbResultGrid from "./DbResultGrid.svelte";
  import DbPlanView from "./DbPlanView.svelte";
  import DbStatus from "./DbStatus.svelte";
  import { completionNames } from "./dbcatalog";
  import { cellEditable, rowEditable } from "./dbedit";
  import { failureText } from "./dberror";
  import { exportRows, type ExportFormat } from "./dbgrid";
  import { consoleArgv, profileTitle } from "./dbprofile";
  import { auditLine } from "./sqlclass";
  import { nameParts, offsetOfChar, splitSql, statementAt } from "./sqlsplit";
  import SqlEditor from "./SqlEditor.svelte";

  let {
    sessionId,
    doc,
    profile,
    serverName,
    onTerminal,
    onAsk,
  }: {
    sessionId: string;
    doc: EditorDoc;
    /** The database's profile as it stands now; null — it was removed. */
    profile: DbProfile | null;
    /** Where it is reached from: the server's name, or "this computer". */
    serverName: string;
    /** Type a command into the connection's terminal (the user's own client). */
    onTerminal: (argv: string[]) => void;
    onAsk?: (context: string) => void;
  } = $props();

  const d = $derived(dbDoc(doc.id));
  const kind = $derived(doc.db!.kind);
  const catalog = $derived(d ? catalogOf(d.place, d.dbId) : null);
  const names = $derived(catalog?.catalog ? completionNames(catalog.catalog) : {});
  const pending = $derived(d ? pendingCount(doc.id) : 0);
  const prod = $derived(d?.conn?.prod ?? false);

  let tab = $state<"result" | "plan" | "edits">("result");
  let editorApi: { caret: () => { from: number; to: number }; insert: (text: string) => void; focus: () => void } | null = null;
  let errorAt = $state<{ from: number; to: number } | null>(null);
  let menu = $state<OpenMenu | null>(null);
  let asking = $state<{ check: RunCheck; statement: string; resolve: (yes: boolean) => void } | null>(null);
  let applying = $state(false);
  let discarding = $state<{ resolve: (yes: boolean) => void } | null>(null);
  let split = $state(0.42);
  let now = $state(Date.now());
  // The clock ticks only while a statement runs.
  const running = $derived(!!d?.running);
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });

  function ask(check: RunCheck, statement: string): Promise<boolean> {
    return new Promise((resolve) => (asking = { check, statement, resolve }));
  }

  function answer(yes: boolean) {
    asking?.resolve(yes);
    asking = null;
  }

  function mayDiscard(): Promise<boolean> {
    if (pendingCount(doc.id) === 0) return Promise.resolve(true);
    return new Promise((resolve) => (discarding = { resolve }));
  }

  function answerDiscard(yes: boolean) {
    if (yes) discardDbEdits(doc.id);
    discarding?.resolve(yes);
    discarding = null;
  }

  /** Run the statements of `text` (starting at `base` in the console) one by one, stopping at the first error. */
  async function runPieces(text: string, base: number, onlyAt: number | null, marks = true) {
    if (!d?.conn || d.running || asking || discarding) return;
    const pieces = splitSql(text, kind);
    const todo = onlyAt === null ? pieces : [statementAt(pieces, onlyAt)].filter((p) => p !== null);
    if (todo.length === 0 || !(await mayDiscard())) return;
    errorAt = null;
    tab = "result";
    for (const p of todo) {
      const check = checkRun(doc.id, p.text);
      if (!check) return;
      if (check.ask && !(await ask(check, p.text))) return;
      let res = await runSql(doc.id, p.text, check.lift);
      if (res === "readOnly") {
        // The backend found a change where the classifier here saw none: the same question.
        if (!(await ask({ ...check, lift: true, ask: true }, p.text))) return;
        res = await runSql(doc.id, p.text, true);
      }
      if (!res || res === "readOnly") return;
      const error = res.outcome.error;
      if (!error) continue;
      if (marks && error.position) {
        const at = Math.min(offsetOfChar(p.text, error.position), Math.max(0, p.text.length - 1));
        errorAt = { from: base + p.from + at, to: base + p.from + Math.min(p.text.length, at + 8) };
      }
      return;
    }
  }

  function runHere(text: string, offset: number, selection: boolean) {
    if (selection) void runPieces(text, offset, null);
    else void runPieces(doc.content, 0, offset);
  }

  function runCurrent() {
    const c = editorApi?.caret() ?? { from: doc.content.length, to: doc.content.length };
    if (c.to > c.from) runHere(doc.content.slice(c.from, c.to), c.from, true);
    else runHere("", c.from, false);
  }

  /** The statement a toolbar action is about: the selection, else the one under the caret. */
  function currentStatement(): string | null {
    const c = editorApi?.caret() ?? { from: 0, to: 0 };
    if (c.to > c.from) return splitSql(doc.content.slice(c.from, c.to), kind)[0]?.text ?? null;
    return statementAt(splitSql(doc.content, kind), c.from)?.text ?? null;
  }

  function plan(analyze: boolean) {
    const s = currentStatement();
    if (!s) return;
    tab = "plan";
    void planOf(doc.id, s, analyze);
  }

  function planMenu(e: MouseEvent) {
    const s = currentStatement();
    const check = s ? checkRun(doc.id, s) : null;
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { icon: "hierarchy", label: t("db.plan.estimateRun"), disabled: !check?.cls.explainable, onSelect: () => plan(false) },
        { icon: "play", label: t("db.plan.analyzeRun"), disabled: !check?.cls.analyzable, onSelect: () => plan(true) },
      ],
    };
  }

  function exportMenu(e: MouseEvent) {
    const out = d?.result?.outcome;
    if (!out) return;
    const pick = (format: ExportFormat) => () => {
      const parts = nameParts(d?.result?.cls.tables[0] ?? "t");
      const name = parts.pop() ?? "t";
      void writeClipboard(exportRows(out, format, kind, { schema: parts.pop() ?? null, name })).then(() =>
        notifySuccess(t("db.export.copied", { rows: out.rows.length }), { source: "db", sessionId }),
      );
    };
    const items: MenuItem[] = (["csv", "tsv", "json", "markdown", "insert"] as const).map((f) => ({ icon: "copy", label: t(`db.export.${f}`), onSelect: pick(f) }));
    menu = { x: e.clientX, y: e.clientY, items };
  }

  function historyMenu(e: MouseEvent) {
    const items: MenuItem[] = (d?.history ?? []).slice(0, 20).map((h) => ({
      label: h.length > 80 ? `${h.slice(0, 80).replace(/\s+/g, " ")}…` : h.replace(/\s+/g, " "),
      onSelect: () => editorApi?.insert(`${h};`),
    }));
    if (items.length === 0) items.push({ label: t("db.history.empty"), disabled: true, onSelect: () => {} });
    menu = { x: e.clientX, y: e.clientY, items };
  }

  function txMenu(e: MouseEvent) {
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t("db.tx.auto"), checked: d?.tx === "auto", disabled: d?.txState !== "none", onSelect: () => setTxMode(doc.id, "auto") },
        { label: t("db.tx.manual"), checked: d?.tx === "manual", onSelect: () => setTxMode(doc.id, "manual") },
      ],
    };
  }

  function askTitle(c: RunCheck): string {
    if (c.cls.confirm === "noWhere") return t("db.ask.noWhere", { verb: c.cls.verb });
    if (c.cls.confirm === "drop") return t("db.ask.drop", { verb: c.cls.verb });
    if (c.cls.confirm === "alter") return t("db.ask.alter");
    if (c.cls.confirm === "grants") return t("db.ask.grants");
    return t("db.ask.lift", { what: auditLine(c.cls) });
  }

  function startDrag(e: PointerEvent) {
    const host = (e.currentTarget as HTMLElement).parentElement;
    if (!host) return;
    // Nothing of the page is selected while the border is dragged (WebKit would).
    holdSelection();
    const box = host.getBoundingClientRect();
    const move = (ev: PointerEvent) => (split = Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const canEdit = $derived.by(() => {
    const target = d?.edit.target;
    const out = d?.result?.outcome;
    if (!target || typeof target === "string" || !out) return null;
    return (row: number, col: number) => cellEditable(out, target, row, col);
  });
  const canDelete = $derived.by(() => {
    const target = d?.edit.target;
    const out = d?.result?.outcome;
    if (!target || typeof target === "string" || !out) return null;
    return (row: number) => rowEditable(out, target, row);
  });
  const notEditable = $derived(typeof d?.edit.target === "string" ? d.edit.target : null);
  const elapsed = $derived(d?.running ? Math.max(0, now - d.running.since) : 0);
  const secs = (ms: number) => (ms < 1000 ? `${ms} ${t("db.ms")}` : `${(ms / 1000).toFixed(1)} ${t("db.s")}`);
</script>

<div class="flex h-full min-h-0 flex-col bg-panel" data-testid="db-console">
  <!-- Toolbar -->
  <div class="flex shrink-0 flex-wrap items-center gap-1 whitespace-nowrap border-b border-edge px-2 py-1 text-xs">
    <button
      type="button"
      class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-accent enabled:hover:border-accent disabled:opacity-40"
      disabled={!d?.conn || !!d?.running}
      onclick={runCurrent}
      data-testid="db-run"
      use:tooltip={t("db.runHint")}
    >
      <Icon name="play" size={12} />{t("db.run")} <span class="text-caption text-muted">⌘↵</span>
    </button>
    <button
      type="button"
      class="rounded p-1 text-muted enabled:hover:bg-edge enabled:hover:text-text disabled:opacity-40"
      disabled={!d?.conn || !!d?.running}
      aria-label={t("db.runAll")}
      use:tooltip={t("db.runAll")}
      onclick={() => void runPieces(doc.content, 0, null)}
    >
      <Icon name="listCheck" size={13} />
    </button>
    {#if d?.running}
      <button type="button" class="flex items-center gap-1 rounded border border-danger/50 px-2 py-0.5 text-danger" onclick={() => void cancelDb(doc.id)} data-testid="db-stop">
        <Icon name="stop" size={12} />{t("db.stop")}
      </button>
    {/if}
    <button
      type="button"
      class="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted enabled:hover:bg-edge enabled:hover:text-text disabled:opacity-40"
      disabled={!d?.conn || !!d?.running}
      onclick={planMenu}
      data-testid="db-plan-menu"
    >
      <Icon name="hierarchy" size={13} />{t("db.tab.plan")}<Icon name="chevronDown" size={11} />
    </button>
    <button type="button" class="flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-meta text-muted hover:text-text" onclick={txMenu} data-testid="db-tx">
      {d?.tx === "manual" ? t("db.tx.manual") : t("db.tx.auto")}<Icon name="chevronDown" size={11} />
    </button>
    {#if d?.conn && d.txState !== "none"}
      <span class="text-meta {d.txState === 'aborted' ? 'text-bad' : 'text-warn'}" data-testid="db-tx-state">{d.txState === "aborted" ? t("db.tx.aborted") : t("db.tx.open")}</span>
      {#if d.txState === "open"}
        <button type="button" class="rounded border border-edge px-1.5 py-0.5 text-meta text-text hover:border-accent disabled:opacity-40" disabled={!!d.running} onclick={() => void runPieces("COMMIT", 0, null, false)}>COMMIT</button>
      {/if}
      <button type="button" class="rounded border border-edge px-1.5 py-0.5 text-meta text-text hover:border-danger disabled:opacity-40" disabled={!!d.running} onclick={() => void runPieces("ROLLBACK", 0, null, false)}>ROLLBACK</button>
    {/if}
    {#if d?.conn?.readOnly}
      <span class="flex items-center gap-1 rounded border border-warn/40 px-1.5 text-meta text-warn" use:tooltip={prod ? t("db.readOnlyProd") : t("db.readOnlyProfile")} data-testid="db-readonly">
        <Icon name="lock" size={11} />{t("db.readOnly")}
      </span>
    {/if}
    <span class="ml-auto min-w-0 flex-1 basis-24 truncate text-right text-meta text-muted">
      {profile ? profileTitle(profile) : ""} · {serverName}{#if d?.conn?.version} · {d.conn.version.split(" ")[0]}{/if}
    </span>
    <button type="button" class="rounded p-1 text-muted hover:bg-edge hover:text-text" aria-label={t("db.history")} use:tooltip={t("db.history")} onclick={historyMenu}>
      <Icon name="history" size={13} />
    </button>
    {#if profile}
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-edge hover:text-text"
        aria-label={t("db.openClient")}
        use:tooltip={t("db.openClient")}
        onclick={() => onTerminal(consoleArgv(profile))}
      >
        <Icon name="terminal" size={13} />
      </button>
    {/if}
  </div>

  {#if !d || d.status !== "ready"}
    <DbStatus docId={doc.id} {profile} />
  {:else if d.failure}
    <p class="shrink-0 border-b border-edge px-3 py-1.5 text-xs text-warn" data-testid="db-refused">{failureText(d.failure)}</p>
  {/if}

  <div class="relative flex min-h-0 flex-1 flex-col">
    <div class="min-h-0" style="height: {Math.round(split * 100)}%">
      <SqlEditor
        value={doc.content}
        {kind}
        {names}
        defaultSchema={catalog?.catalog?.current ?? null}
        {errorAt}
        onchange={(text) => setConsoleText(sessionId, doc.id, text)}
        onrun={runHere}
        onrunAll={() => void runPieces(doc.content, 0, null)}
        onready={(api) => (editorApi = api)}
      />
    </div>
    <div
      class="h-1 shrink-0 cursor-row-resize border-y border-edge bg-panel-alt hover:bg-accent"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("db.resize")}
      onpointerdown={startDrag}
    ></div>
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-2 border-b border-edge bg-panel-alt px-2 py-1 text-xs">
        <div class="inline-flex overflow-hidden rounded border border-edge" role="tablist">
          {#each [["result", d?.result ? t("db.tab.resultOf", { rows: d.result.outcome.rows.length, ms: secs(d.result.outcome.elapsedMs) }) : t("db.tab.result")], ["plan", t("db.tab.plan")], ["edits", pending ? t("db.tab.editsOf", { n: pending }) : t("db.tab.edits")]] as [id, label] (id)}
            <button
              type="button"
              role="tab"
              aria-selected={tab === id}
              class="border-l border-edge px-2.5 py-0.5 first:border-l-0 {tab === id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-edge hover:text-text'}"
              onclick={() => {
                tab = id as typeof tab;
                if (id === "edits") void prepareEdit(doc.id);
              }}>{label}</button
            >
          {/each}
        </div>
        <span class="ml-auto"></span>
        {#if d?.result?.outcome.rows.length}
          <button type="button" class="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text" onclick={exportMenu}>
            <Icon name="copy" size={12} />{t("db.export")}<Icon name="chevronDown" size={11} />
          </button>
        {/if}
        {#if onAsk && d?.result?.outcome.error}
          {@const r = d.result}
          <button
            type="button"
            class="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text"
            onclick={() => onAsk?.(`${r.statement}\n\n${r.outcome.error?.message}${r.outcome.error?.detail ? `\n${r.outcome.error.detail}` : ""}${r.outcome.error?.hint ? `\n${r.outcome.error.hint}` : ""}`)}
          >
            <Icon name="aiMark" size={12} />{t("db.askError")}
          </button>
        {/if}
      </div>
      <div class="min-h-0 flex-1">
        {#if d?.running && tab !== "edits"}
          <div class="flex h-full items-center justify-center gap-2 text-xs text-muted" data-testid="db-running">
            <Icon name="loader" size={14} class="animate-spin" />{t("db.running", { time: secs(elapsed) })}
          </div>
        {:else if tab === "plan"}
          {#if d?.plan}
            <DbPlanView state={d.plan} {kind} oninsert={(text) => editorApi?.insert(text)} onask={onAsk} />
          {:else}
            <p class="p-3 text-xs text-muted">{t("db.plan.none")}</p>
          {/if}
        {:else if tab === "edits"}
          <div class="flex h-full min-h-0 flex-col p-2 text-xs" data-testid="db-edits">
            {#if notEditable}
              <p class="text-muted">{t(`db.edit.not.${notEditable}`)}</p>
            {:else if pending === 0}
              <p class="text-muted">{t("db.edit.none")}</p>
            {:else}
              <pre class="min-h-0 flex-1 overflow-auto rounded border border-edge bg-panel-alt p-2 font-mono text-meta text-text">{pendingStatements(doc.id).join(";\n")};</pre>
              {#if d?.edit.error}<p class="mt-1 text-bad">{d.edit.error}</p>{/if}
              <div class="mt-2 flex items-center gap-2">
                {#if d?.conn?.readOnly}<span class="flex items-center gap-1 text-warn"><Icon name="lock" size={12} />{t("db.edit.readOnly")}</span>{/if}
                <span class="ml-auto"></span>
                <button type="button" class="rounded border border-edge px-2 py-0.5 text-text hover:border-accent" onclick={() => discardDbEdits(doc.id)}>{t("db.edit.discard")}</button>
                <button
                  type="button"
                  class="rounded border px-2 py-0.5 {prod || d?.conn?.readOnly ? 'border-danger/60 text-danger' : 'border-accent/60 text-accent'} disabled:opacity-40"
                  disabled={!d?.conn || !!d.running || d.edit.applying || d.tx === "manual" || d.txState !== "none"}
                  use:tooltip={d?.tx === "manual" || d?.txState !== "none" ? t("db.edit.inTx") : ""}
                  onclick={() => (applying = true)}
                  data-testid="db-apply">{t("db.edit.apply")}</button
                >
              </div>
            {/if}
          </div>
        {:else if d?.result}
          {@const out = d.result.outcome}
          {#if out.error}
            <div class="space-y-1 p-3 text-xs" data-testid="db-error">
              <p class="text-bad">{out.error.message}</p>
              {#if out.error.detail}<p class="text-muted">{out.error.detail}</p>{/if}
              {#if out.error.hint}<p class="text-muted">{t("db.hint", { hint: out.error.hint })}</p>{/if}
              <p class="font-mono text-meta text-muted">{out.error.code ? `${out.error.code}` : ""}{#if out.error.position} · {t("db.errorAt", { pos: out.error.position })}{/if}</p>
            </div>
          {:else if out.columns.length > 0}
            <div class="flex h-full min-h-0 flex-col">
              <div class="min-h-0 flex-1">
                <DbResultGrid
                  outcome={out}
                  edits={d.edit.edits}
                  {canEdit}
                  {canDelete}
                  onedit={(r, c, v) => editDbCell(doc.id, r, c, v)}
                  ondelete={(r) => toggleDbRowDelete(doc.id, r)}
                  onwantEdit={() => void prepareEdit(doc.id)}
                />
              </div>
              <div class="flex shrink-0 flex-wrap items-center gap-x-3 border-t border-edge px-2 py-0.5 text-meta text-muted">
                <span>{t("db.rows", { n: out.rows.length })}</span>
                {#if out.truncated}<span class="text-warn">{t("db.truncated", { n: out.rows.length })}</span>{/if}
                {#if out.cut.length}<span class="text-warn">{t("db.cutCells", { n: out.cut.length })}</span>{/if}
                {#if notEditable}<span>{t(`db.edit.not.${notEditable}`)}</span>{/if}
                {#each out.notices as n, i (i)}<span class="truncate">{n}</span>{/each}
              </div>
            </div>
          {:else}
            <div class="space-y-1 p-3 text-xs">
              <p class="text-text">{out.affected !== null ? t("db.affected", { n: out.affected, ms: secs(out.elapsedMs) }) : t("db.done", { ms: secs(out.elapsedMs) })}</p>
              {#each out.notices as n, i (i)}<p class="text-muted">{n}</p>{/each}
            </div>
          {/if}
        {:else}
          <p class="p-3 text-xs text-muted">{t("db.empty")}</p>
        {/if}
      </div>
    </div>
  </div>
</div>

<ContextMenu {menu} onclose={() => (menu = null)} />

<ConfirmDialog
  open={asking !== null}
  title={asking ? askTitle(asking.check) : ""}
  confirmLabel={t("db.ask.run")}
  danger={!!asking && (prod || asking.check.lift || asking.check.cls.confirm === "drop" || asking.check.cls.confirm === "noWhere")}
  onconfirm={() => answer(true)}
  oncancel={() => answer(false)}
>
  {#if asking}
    <pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-panel-alt p-2 font-mono text-meta text-text">{asking.statement.length > 600 ? `${asking.statement.slice(0, 600)}…` : asking.statement}</pre>
    {#if asking.check.lift}<p class="mt-2 text-xs text-warn">{prod ? t("db.ask.liftProd") : t("db.ask.liftProfile")}</p>{/if}
    {#if prod}<p class="mt-2 text-xs text-danger">{t("db.ask.prod", { server: serverName })}</p>{/if}
  {/if}
</ConfirmDialog>

<ConfirmDialog
  open={discarding !== null}
  title={t("db.edit.dropTitle", { n: pending })}
  confirmLabel={t("db.edit.dropRun")}
  danger
  onconfirm={() => answerDiscard(true)}
  oncancel={() => answerDiscard(false)}
>
  <p class="text-xs text-muted">{t("db.edit.dropBody")}</p>
</ConfirmDialog>

<ConfirmDialog
  open={applying}
  title={t("db.edit.confirmTitle", { n: pendingStatements(doc.id).length })}
  confirmLabel={t("db.edit.apply")}
  danger={prod || !!d?.conn?.readOnly}
  onconfirm={() => {
    applying = false;
    void applyDbEdits(doc.id, !!d?.conn?.readOnly);
  }}
  oncancel={() => (applying = false)}
>
  <p class="text-xs text-muted">{t("db.edit.confirmBody")}</p>
  {#if prod}<p class="mt-2 text-xs text-danger">{t("db.ask.prod", { server: serverName })}</p>{/if}
</ConfirmDialog>
