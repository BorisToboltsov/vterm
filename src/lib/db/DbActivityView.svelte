<script lang="ts">
  // A database's activity (ADR 0080): connections against their limit, who is
  // working and who waits on whose lock, replicas, the statements that cost
  // the most — read every few seconds while the view is on screen, one read in
  // flight (`singleFlight`), a failing read said as a strip. Stopping a
  // statement or ending a session is asked first — in red on a prod server.
  import { onDestroy, untrack } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { diag } from "../api/diag";
  import { t } from "../i18n";
  import { settings } from "../settings/settings.svelte";
  import { dbDoc, readActivity, stopDbSession } from "../stores/db.svelte";
  import { notifyError, notifySuccess } from "../stores/toasts.svelte";
  import type { DbProfile } from "../types";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import Icon from "../ui/Icon.svelte";
  import PollFailStrip from "../ui/PollFailStrip.svelte";
  import { pollFailed, singleFlight, type PollFailure } from "../ui/poll";
  import { blockingTree, dbProblems, type DbProblem, type DbSession } from "./dbactivity";
  import DbStatus from "./DbStatus.svelte";
  import { profileTitle } from "./dbprofile";

  let {
    sessionId,
    docId,
    visible,
    profile,
    serverName,
  }: {
    sessionId: string;
    docId: string;
    /** On screen: only then is the server read. */
    visible: boolean;
    profile: DbProfile | null;
    serverName: string;
  } = $props();

  const d = $derived(dbDoc(docId));
  const a = $derived(d?.activity?.data ?? null);
  const problems = $derived(a ? dbProblems(a, settings.dbThresholds) : []);
  const tree = $derived(a ? blockingTree(a.sessions) : []);
  const prod = $derived(d?.conn?.prod ?? false);
  let failure = $state<PollFailure | null>(null);
  let stopping = $state<{ session: DbSession; terminate: boolean } | null>(null);
  let showIdle = $state(false);

  const read = singleFlight(async () => {
    if (!dbDoc(docId)?.conn) return;
    await readActivity(docId);
    const now = dbDoc(docId)?.activity;
    if (now?.failedAt && now.error) {
      const next = pollFailed(failure, now.error, Date.now());
      failure = next.failure;
      // The server's words stay on the strip: they may quote what it holds.
      if (next.news) diag.warn("db", "the activity was not read: the view shows its last answer");
    } else failure = null;
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  // Not the document: each answer is a new one, and the effect would read again at once.
  const polling = $derived(visible && d?.status === "ready");
  $effect(() => {
    const on = polling;
    const every = settings.dbActivitySec;
    untrack(() => {
      if (timer) clearInterval(timer);
      timer = null;
      if (!on) return;
      void read();
      timer = setInterval(() => void read(), every * 1000);
    });
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  const dur = (s: number | null) => {
    if (s === null) return "—";
    if (s < 60) return `${s} ${t("db.s")}`;
    if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    return `${Math.floor(s / 3600)} ${t("db.h")} ${Math.floor((s % 3600) / 60)} ${t("db.min")}`;
  };

  function problemText(p: DbProblem): string {
    switch (p.kind) {
      case "idleTx":
        return t("db.act.p.idleTx", { id: p.session?.id ?? "", user: p.session?.user ?? "", time: dur(p.value), n: p.waiting ?? 0 });
      case "lockWait":
        return t("db.act.p.lockWait", { id: p.session?.id ?? "", time: dur(p.value), by: p.session?.blockedBy.join(", ") ?? "" });
      case "replLag":
        return p.replica ? t("db.act.p.replLag", { replica: p.replica, time: dur(Math.round(p.value)) }) : t("db.act.p.replayLag", { time: dur(Math.round(p.value)) });
      case "conns":
        return t("db.act.p.conns", { pct: p.value });
      case "cacheHit":
        return t("db.act.p.cacheHit", { pct: p.value });
    }
  }

  async function stop() {
    const s = stopping;
    stopping = null;
    if (!s) return;
    const got = await stopDbSession(docId, s.session.id, s.terminate);
    if (!got.done) notifyError(t("db.act.stopFailed", { id: s.session.id, error: got.missing ? t("db.act.noSuch") : (got.error ?? "") }), { source: "db", sessionId });
    else notifySuccess(s.terminate ? t("db.act.terminated", { id: s.session.id }) : t("db.act.cancelled", { id: s.session.id }), { source: "db", sessionId });
    void read();
  }

  const stateLabel = (s: DbSession) => t(`db.act.state.${s.state}`);
  const sessions = $derived(a ? a.sessions.filter((s) => showIdle || s.state !== "idle") : []);
</script>

{#snippet tile(label: string, value: string, sub: string, tone: string, bar: number | null = null)}
  <div class="min-w-32 flex-1 border-r border-edge px-3 py-2 last:border-r-0">
    <div class="truncate text-caption uppercase tracking-wider text-muted">{label}</div>
    <div class="text-sm {tone}">{value}</div>
    {#if bar !== null}
      <div class="mt-1 h-1 overflow-hidden rounded bg-edge"><div class="h-full rounded {tone.includes('warn') || tone.includes('bad') ? 'bg-warn' : 'bg-accent'}" style="width: {Math.min(100, bar)}%"></div></div>
    {/if}
    <div class="truncate text-meta text-muted">{sub}</div>
  </div>
{/snippet}

{#snippet sessionActions(s: DbSession)}
  <button type="button" class="shrink-0 whitespace-nowrap rounded border border-edge px-1.5 py-0.5 text-meta text-text hover:border-accent" onclick={() => (stopping = { session: s, terminate: false })}>
    {t("db.act.cancel")}
  </button>
  <button type="button" class="shrink-0 whitespace-nowrap rounded border border-danger/50 px-1.5 py-0.5 text-meta text-danger" onclick={() => (stopping = { session: s, terminate: true })}>
    {t("db.act.terminate")}
  </button>
{/snippet}

<div class="flex h-full min-h-0 flex-col bg-panel text-xs @container" data-testid="db-activity">
  <div class="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1">
    <Icon name="activity" size={13} class="text-accent" />
    <span class="text-text">{profile ? profileTitle(profile) : ""}</span>
    <span class="text-meta text-muted">· {serverName}{#if d?.conn?.version} · {d.conn.version.split(" ")[0]}{/if}</span>
    <span class="ml-auto text-meta text-muted">{d?.activity?.at ? t("db.act.every", { s: settings.dbActivitySec }) : ""}</span>
    <button type="button" class="rounded p-1 text-muted hover:bg-edge hover:text-text" aria-label={t("db.act.read")} use:tooltip={t("db.act.read")} onclick={() => void read()}>
      <Icon name="refresh" size={13} />
    </button>
  </div>
  {#if d && d.status !== "ready"}
    <DbStatus {docId} {profile} />
  {/if}
  <PollFailStrip {failure} onretry={() => void read()} testid="db-activity-fail" />
  {#if a}
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="flex flex-wrap border-b border-edge">
        {@render tile(
          t("db.act.conns"),
          a.maxConns ? `${a.conns ?? "—"} / ${a.maxConns}` : `${a.conns ?? "—"}`,
          t("db.act.connsSub"),
          problems.some((p) => p.kind === "conns") ? "text-warn" : "text-text",
          a.conns !== null && a.maxConns ? (100 * a.conns) / a.maxConns : null,
        )}
        {@render tile(t("db.act.active"), String(a.sessions.filter((s) => s.state === "active").length), t("db.act.of", { n: a.sessions.length }), "text-text")}
        {@render tile(
          t("db.act.waiting"),
          String(a.sessions.filter((s) => s.blockedBy.length).length),
          t("db.act.waitingSub"),
          a.sessions.some((s) => s.blockedBy.length) ? "text-warn" : "text-text",
        )}
        {@render tile(
          t("db.act.replicas"),
          a.replica ? dur(a.replayLagS) : a.replicas === null ? "—" : a.replicas.length ? a.replicas.map((r) => (r.lagS === null ? "—" : `${r.lagS}`)).join(" · ") : "0",
          a.replica ? t("db.act.isReplica") : a.replicas === null ? t("db.act.unavailable") : t("db.act.replicasSub"),
          problems.some((p) => p.kind === "replLag") ? "text-warn" : "text-text",
        )}
        {@render tile(t("db.act.hit"), a.hitPct === null ? "—" : `${a.hitPct} %`, t("db.act.hitSub"), problems.some((p) => p.kind === "cacheHit") ? "text-warn" : "text-text")}
      </div>

      {#if problems.length}
        <div class="border-b border-edge px-2 py-1">
          <div class="text-caption uppercase tracking-wider text-muted">{t("db.act.attention")}</div>
          {#each problems as p, i (i)}
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 @wide:flex-nowrap" data-testid="db-problem">
              <Icon name={p.level === "bad" ? "octagon" : "alert"} size={13} class={p.level === "bad" ? "text-bad" : "text-warn"} />
              <span class="min-w-56 flex-1 text-text @wide:min-w-0 @wide:truncate">{problemText(p)}</span>
              {#if p.session && (p.kind === "idleTx" || p.kind === "lockWait")}<span class="ml-auto flex shrink-0 gap-1.5">{@render sessionActions(p.session)}</span>{/if}
            </div>
          {/each}
        </div>
      {/if}

      <div class="grid grid-cols-1 @wide:grid-cols-2">
        <div class="min-w-0 border-b border-edge">
          <div class="px-2 pt-1 text-caption uppercase tracking-wider text-muted">{t("db.act.locks")}</div>
          {#if d?.activity?.notes.locks}<p class="px-2 py-1 text-meta text-muted">{t("db.act.unavailableWhy", { why: d.activity.notes.locks })}</p>{/if}
          {#if tree.length === 0}
            <p class="px-2 py-1 text-meta text-muted">{t("db.act.noLocks")}</p>
          {/if}
          {#each tree as { session: s, depth } (s.id)}
            <div class="border-b border-edge/40 py-1 pr-2" style="padding-left: {0.5 + depth * 1}rem" data-testid="db-lock-row">
              <div class="flex items-center gap-1.5">
                {#if depth}<span class="text-muted">└</span>{/if}
                <span class="h-2 w-2 shrink-0 rounded-full {s.blockedBy.length ? 'bg-warn' : 'bg-bad'}"></span>
                <span class="font-mono">{s.id}</span><span class="text-muted">{s.user}</span>
                <span class="ml-auto text-meta {s.blockedBy.length ? 'text-warn' : 'text-bad'}">
                  {s.blockedBy.length ? t("db.act.waits", { time: dur(s.queryS) }) : `${stateLabel(s)} · ${dur(s.xactS ?? s.stateS)}`}
                </span>
              </div>
              <div class="truncate pl-4 font-mono text-meta text-muted" use:tooltip={s.query}>{s.query || "—"}</div>
            </div>
          {/each}
        </div>
        <div class="min-w-0 border-b border-edge @wide:border-l">
          <div class="px-2 pt-1 text-caption uppercase tracking-wider text-muted">{t("db.act.statements")}</div>
          {#if a.statements === null}
            <p class="px-2 py-1 text-meta text-muted">{t("db.act.unavailableWhy", { why: d?.activity?.notes.statements ?? "" })}</p>
          {:else if a.statements.length === 0}
            <p class="px-2 py-1 text-meta text-muted">{t("db.act.noStatements")}</p>
          {:else}
            {#each a.statements as st, i (i)}
              <div class="border-b border-edge/40 px-2 py-1">
                <div class="truncate font-mono text-meta text-text" use:tooltip={st.query}>{st.query}</div>
                <div class="flex items-center gap-2 text-meta text-muted">
                  <span class="w-16">{st.calls.toLocaleString()}</span><span class="w-20">{st.meanMs} {t("db.ms")}</span>
                  <span class="h-1 flex-1 overflow-hidden rounded bg-edge"><span class="block h-full rounded bg-accent" style="width: {Math.min(100, st.share)}%"></span></span>
                  <span class="w-12 text-right text-text">{st.share} %</span>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      {#if a.replicas?.length}
        <div class="border-b border-edge px-2 py-1">
          <div class="text-caption uppercase tracking-wider text-muted">{t("db.act.replicas")}</div>
          {#each a.replicas as r, i (i)}
            <div class="flex gap-3 py-0.5 text-meta"><span class="text-text">{r.name || r.client}</span><span class="text-muted">{r.client}</span><span class="text-muted">{r.state}</span><span class="ml-auto">{r.lagS === null ? "—" : `${r.lagS} ${t("db.s")}`}</span></div>
          {/each}
        </div>
      {/if}

      <div class="px-2 py-1">
        <div class="flex items-center gap-2">
          <span class="text-caption uppercase tracking-wider text-muted">{t("db.act.sessions")}</span>
          <label class="ml-auto flex items-center gap-1 text-meta text-muted"><input type="checkbox" bind:checked={showIdle} />{t("db.act.showIdle")}</label>
        </div>
        {#if d?.activity?.notes.sessions}<p class="py-1 text-meta text-muted">{t("db.act.unavailableWhy", { why: d.activity.notes.sessions })}</p>{/if}
        {#each sessions as s (s.id)}
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-edge/40 py-0.5 text-meta @wide:flex-nowrap" data-testid="db-session-row">
            <span class="w-14 shrink-0 font-mono text-text">{s.id}</span>
            <span class="w-24 shrink-0 truncate text-muted">{s.user}</span>
            <span class="w-28 shrink-0 truncate {s.state === 'idleTx' || s.state === 'idleTxAborted' ? 'text-warn' : 'text-muted'}">{stateLabel(s)}</span>
            <span class="w-14 shrink-0 text-right text-muted">{dur(s.queryS)}</span>
            <span class="min-w-0 basis-full truncate font-mono text-muted @wide:flex-1 @wide:basis-0" use:tooltip={s.query}>{s.query}</span>
            {#if s.state === "active" || s.state === "idleTx" || s.state === "idleTxAborted"}<span class="ml-auto flex shrink-0 gap-1.5">{@render sessionActions(s)}</span>{/if}
          </div>
        {/each}
        {#if sessions.length === 0}<p class="py-1 text-meta text-muted">{t("db.act.noSessions")}</p>{/if}
      </div>
    </div>
  {:else if d?.status === "ready"}
    <div class="flex flex-1 items-center justify-center gap-2 text-muted"><Icon name="loader" size={13} class="animate-spin" />{t("db.act.reading")}</div>
  {/if}
</div>

<ConfirmDialog
  open={stopping !== null}
  title={stopping ? (stopping.terminate ? t("db.act.terminateTitle", { id: stopping.session.id }) : t("db.act.cancelTitle", { id: stopping.session.id })) : ""}
  confirmLabel={stopping?.terminate ? t("db.act.terminate") : t("db.act.cancel")}
  danger={!!stopping && (stopping.terminate || prod)}
  onconfirm={() => void stop()}
  oncancel={() => (stopping = null)}
>
  {#if stopping}
    <p class="text-xs text-muted">{stopping.terminate ? t("db.act.terminateBody") : t("db.act.cancelBody")}</p>
    <pre class="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-panel-alt p-2 font-mono text-meta text-text">{stopping.session.user} · {stopping.session.client}
{stopping.session.query}</pre>
    {#if d?.conn?.readOnly}<p class="mt-2 text-xs text-warn">{prod ? t("db.ask.liftProd") : t("db.ask.liftProfile")}</p>{/if}
    {#if prod}<p class="mt-2 text-xs text-danger">{t("db.ask.prod", { server: serverName })}</p>{/if}
  {/if}
</ConfirmDialog>
