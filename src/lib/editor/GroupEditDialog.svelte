<script lang="ts">
  // Editing a file on the synchronous-input group (ADR 0064): what the edit made
  // in the source's editor becomes on every other server's copy of the file —
  // where it landed, what each copy would look like after it, and which are
  // written. Nothing is written before the button; a copy where the edit found
  // no place is not offered at all. Presentational: page/groupeditflow reads,
  // patches and writes.
  import Modal from "../ui/Modal.svelte";
  import Icon from "../ui/Icon.svelte";
  import PasswordInput from "../ui/PasswordInput.svelte";
  import { t } from "../i18n";
  import { editTally, writable, type EditAsk, type HostEdit } from "./groupedit";
  import { changeView } from "./linepatch";

  let {
    ask = null,
    dirty = true,
    ontoggle,
    onsudo,
    onapply,
    onclose,
  }: {
    ask?: EditAsk | null;
    /** The source's file still has the edit unsaved — there is something to carry. */
    dirty?: boolean;
    ontoggle?: (id: string) => void;
    onsudo?: (password: string) => void;
    onapply?: () => void;
    onclose?: () => void;
  } = $props();

  let shown = $state<string | null>(null);
  let password = $state("");

  $effect(() => {
    if (!ask) {
      shown = null;
      password = "";
    }
  });

  const tally = $derived(ask ? editTally(ask.hosts.map((h) => h.edit), (i) => ask.hosts[i].picked) : null);
  const denied = $derived(!!ask?.hosts.some((h) => h.edit.kind === "denied"));
  const prodPicked = $derived(ask ? ask.hosts.filter((h) => h.picked && writable(h.edit) && h.prod).map((h) => h.label) : []);
  const reading = $derived(!!ask?.hosts.some((h) => h.edit.kind === "reading"));

  function status(edit: HostEdit): { text: string; tone: string } {
    switch (edit.kind) {
      case "reading":
        return { text: t("groupEdit.reading"), tone: "text-muted" };
      case "missing":
        return { text: t("groupEdit.missing"), tone: "text-muted" };
      case "denied":
        return { text: t("groupEdit.denied"), tone: "text-warn" };
      case "failed":
        return { text: t("groupEdit.failed", { error: edit.error }), tone: "text-warn" };
      case "written":
        return { text: t("groupEdit.written"), tone: "text-ok" };
      case "notWritten":
        return { text: t("groupEdit.notWritten", { error: edit.error }), tone: "text-bad" };
      case "patched":
        if (edit.outcome === "clean") return { text: t("groupEdit.clean"), tone: "text-muted" };
        if (edit.outcome === "offset") return { text: t("groupEdit.offset"), tone: "text-muted" };
        if (edit.outcome === "fuzzy") return { text: t("groupEdit.fuzzy"), tone: "text-warn" };
        if (edit.outcome === "already") return { text: t("groupEdit.already"), tone: "text-muted" };
        return { text: t("groupEdit.conflict"), tone: "text-bad" };
    }
  }

  const TONE = { "=": "text-muted", "-": "text-bad", "+": "text-ok", gap: "text-muted" } as const;
  const MARK = { "=": " ", "-": "-", "+": "+", gap: "…" } as const;
</script>

<Modal open={!!ask} title={t("groupEdit.title", { name: ask?.name ?? "" })} width="w-[40rem]" onclose={onclose}>
  {#if ask}
    <p class="mb-2 truncate font-mono text-meta text-muted">{ask.path}</p>
    {#if ask.hunks === null}
      <p class="rounded border border-warn/50 bg-warn/10 px-2.5 py-2 text-xs text-warn" data-testid="group-edit-too-large">
        {t("groupEdit.tooLarge")}
      </p>
    {:else}
      <div class="mb-1 flex items-center gap-2 px-1.5 text-xs">
        <Icon name="pencil" size={13} class="shrink-0 text-accent" />
        <span class="w-32 shrink-0 truncate text-text">{ask.leadLabel}</span>
        <span class="min-w-0 flex-1 truncate {ask.leadFailed ? 'text-bad' : 'text-muted'}">
          {ask.leadFailed ? t("groupEdit.leadFailed") : ask.done ? t("groupEdit.leadSaved") : t("groupEdit.lead")}
        </span>
      </div>
      <ul class="space-y-0.5" data-testid="group-edit-hosts">
        {#each ask.hosts as host (host.id)}
          {@const st = status(host.edit)}
          {@const can = writable(host.edit) && !ask.done && !ask.writing}
          <li data-testid="group-edit-host">
            <div class="flex items-center gap-2 rounded px-1.5 py-1 text-xs">
              <input
                type="checkbox"
                aria-label={host.label}
                checked={host.picked}
                disabled={!can}
                onchange={() => ontoggle?.(host.id)}
              />
              <span class="w-32 shrink-0 truncate text-text">{host.label}</span>
              {#if host.prod}
                <span class="shrink-0 rounded border border-bad/50 px-1 text-caption text-bad">prod</span>
              {/if}
              <span class="min-w-0 flex-1 truncate {st.tone}">{st.text}</span>
              {#if host.edit.kind === "patched" && host.edit.text !== null && host.edit.outcome !== "already"}
                <button
                  type="button"
                  class="shrink-0 rounded px-1.5 text-meta text-muted hover:text-text"
                  aria-expanded={shown === host.id}
                  onclick={() => (shown = shown === host.id ? null : host.id)}
                >
                  {shown === host.id ? t("groupEdit.hide") : t("groupEdit.show")}
                </button>
              {/if}
            </div>
            {#if shown === host.id && host.edit.kind === "patched" && host.edit.text !== null}
              <pre
                class="mx-1.5 mb-1 max-h-48 overflow-auto rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed"
                data-testid="group-edit-preview">{#each changeView(host.edit.file.content, host.edit.text) as line, i (i)}<span class="block {TONE[line.kind]}">{MARK[line.kind]} {line.text}</span>{/each}</pre>
            {/if}
          </li>
        {/each}
      </ul>
      {#if denied && !ask.done}
        <div class="mt-3 flex items-center gap-2">
          <PasswordInput bind:value={password} placeholder={t("groupEdit.sudoPassword")} class="min-w-0 flex-1" />
          <button
            type="button"
            class="shrink-0 rounded border border-edge px-2 py-1 text-xs text-muted hover:text-text disabled:opacity-40"
            disabled={password.length === 0}
            onclick={() => onsudo?.(password)}
          >
            {t("groupEdit.sudoRead")}
          </button>
        </div>
      {/if}
      {#if prodPicked.length > 0 && !ask.done}
        <p class="mt-3 flex items-center gap-1.5 rounded border border-bad/50 bg-bad/10 px-2.5 py-1.5 text-xs text-bad">
          <Icon name="shield" size={13} />
          {t("groupEdit.prod", { names: prodPicked.join(", ") })}
        </p>
      {/if}
    {/if}
    <div class="mt-4 flex items-center justify-end gap-2">
      {#if reading}
        <span class="mr-auto text-meta text-muted">{t("groupEdit.waiting")}</span>
      {/if}
      {#if ask.done}
        <button
          type="button"
          data-testid="group-edit-close"
          class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
          onclick={() => onclose?.()}
        >
          {t("common.close")}
        </button>
      {:else}
        <button type="button" class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={() => onclose?.()}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          data-testid="group-edit-apply"
          disabled={!dirty || ask.writing || ask.hunks === null || ask.leadFailed}
          class="rounded px-3 py-1 text-sm text-panel-alt disabled:cursor-not-allowed disabled:opacity-40 {prodPicked.length > 0
            ? 'bg-danger hover:opacity-90'
            : 'bg-accent hover:bg-accent-hover'}"
          onclick={() => onapply?.()}
        >
          {ask.writing ? t("groupEdit.writing") : t("groupEdit.apply", { count: tally?.write ?? 0 })}
        </button>
      {/if}
    </div>
  {/if}
</Modal>
