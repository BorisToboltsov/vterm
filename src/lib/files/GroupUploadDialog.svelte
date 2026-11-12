<script lang="ts">
  // The question before an upload to the synchronous-input group (ADR 0064):
  // what the same folder holds on each server, which servers get the files, and
  // whether the names already there are replaced — asked once, for all of them.
  // Presentational: the flow (page/groupuploadflow) lists and sends.
  import Modal from "../ui/Modal.svelte";
  import Icon from "../ui/Icon.svelte";
  import { t } from "../i18n";
  import { fmtBytes } from "../monitoring/format";
  import { formatModified } from "./lscolors";
  import { canReceive, hostSources, type HostCheck, type UploadAsk } from "./groupupload";

  let {
    ask = null,
    ontoggle,
    onreplace,
    onconfirm,
    oncancel,
  }: {
    ask?: UploadAsk | null;
    ontoggle?: (id: string) => void;
    onreplace?: (replace: boolean) => void;
    onconfirm?: () => void;
    oncancel?: () => void;
  } = $props();

  const what = $derived(
    ask
      ? ask.sources.length === 1
        ? ask.sources[0].name
        : t("groupUpload.items", { count: ask.sources.length })
      : "",
  );
  const anyTaken = $derived(!!ask?.hosts.some((h) => h.check?.kind === "ready" && h.check.taken.length > 0));
  const sending = $derived(
    ask ? ask.hosts.filter((h) => h.picked && h.check && hostSources(ask.sources, h.check, ask.replace)) : [],
  );
  const prod = $derived(sending.filter((h) => h.prod).map((h) => h.label));
  const reading = $derived(!!ask?.hosts.some((h) => h.check === null));

  function status(check: HostCheck | null): { text: string; tone: string } {
    if (check === null) return { text: t("groupUpload.reading"), tone: "text-muted" };
    if (check.kind === "noFolder") return { text: t("groupUpload.noFolder"), tone: "text-bad" };
    if (check.kind === "unread") return { text: t("groupUpload.unread", { error: check.error }), tone: "text-warn" };
    if (check.taken.length === 0) return { text: t("groupUpload.free"), tone: "text-muted" };
    if (check.taken.length === 1 && ask?.sources.length === 1) {
      const it = check.taken[0];
      const facts = it.isDir ? t("groupUpload.folder") : `${fmtBytes(it.size)}, ${formatModified(it.modified)}`;
      return {
        text: t(ask.replace ? "groupUpload.takenReplace" : "groupUpload.takenKeep", { facts }),
        tone: "text-warn",
      };
    }
    return {
      text: t(ask?.replace ? "groupUpload.someReplace" : "groupUpload.someKeep", {
        taken: check.taken.length,
        of: (ask?.sources.length ?? 0),
      }),
      tone: "text-warn",
    };
  }
</script>

<Modal open={!!ask} title={t("groupUpload.title", { what })} width="w-[36rem]" onclose={oncancel}>
  {#if ask}
    <p class="mb-2 truncate font-mono text-meta text-muted" data-testid="group-upload-dir">→ {ask.destDir}</p>
    <ul class="space-y-0.5" data-testid="group-upload-hosts">
      {#each ask.hosts as host (host.id)}
        {@const st = status(host.check)}
        {@const can = host.check !== null && canReceive(host.check)}
        <li>
          <label
            class="flex items-center gap-2 rounded px-1.5 py-1 text-xs {can ? 'cursor-pointer hover:bg-edge/40' : 'opacity-70'}"
            data-testid="group-upload-host"
          >
            <input type="checkbox" checked={host.picked} disabled={!can} onchange={() => ontoggle?.(host.id)} />
            <span class="w-32 shrink-0 truncate text-text">{host.label}</span>
            {#if host.prod}
              <span class="shrink-0 rounded border border-bad/50 px-1 text-caption text-bad">prod</span>
            {/if}
            <span class="min-w-0 flex-1 truncate {st.tone}">{st.text}</span>
          </label>
        </li>
      {/each}
    </ul>
    {#if ask.outside.length > 0}
      <p class="mt-2 text-meta text-muted">{t("groupUpload.outside", { names: ask.outside.join(", ") })}</p>
    {/if}
    {#if anyTaken}
      <label class="mt-3 flex cursor-pointer items-center gap-2 text-xs text-text">
        <input
          type="checkbox"
          data-testid="group-upload-replace"
          checked={ask.replace}
          onchange={(e) => onreplace?.((e.currentTarget as HTMLInputElement).checked)}
        />
        {t("groupUpload.replace")}
      </label>
    {/if}
    {#if prod.length > 0}
      <p class="mt-3 flex items-center gap-1.5 rounded border border-bad/50 bg-bad/10 px-2.5 py-1.5 text-xs text-bad">
        <Icon name="shield" size={13} />
        {t("groupUpload.prod", { names: prod.join(", ") })}
      </p>
    {/if}
    <div class="mt-4 flex items-center justify-end gap-2">
      {#if reading}
        <span class="mr-auto text-meta text-muted">{t("groupUpload.waiting")}</span>
      {/if}
      <button type="button" class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={() => oncancel?.()}>
        {t("common.cancel")}
      </button>
      <button
        type="button"
        data-testid="group-upload-confirm"
        disabled={sending.length === 0}
        class="rounded px-3 py-1 text-sm text-panel-alt disabled:cursor-not-allowed disabled:opacity-40 {prod.length > 0
          ? 'bg-danger hover:opacity-90'
          : 'bg-accent hover:bg-accent-hover'}"
        onclick={() => onconfirm?.()}
      >
        {t("groupUpload.confirm", { count: sending.length })}
      </button>
    </div>
  {/if}
</Modal>
