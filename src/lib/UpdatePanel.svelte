<script lang="ts">
  import { onMount } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { checkUpdate, downloadUpdate, updateSnapshot, type UpdateRelease } from "./api/updater";
  import { downloadPercent, updateError } from "./updates";
  import { t, type MessageKey } from "./i18n";
  import { renderMarkdown } from "./markdown";
  import { mdLinks } from "./actions/mdlinks";
  let { onInstall, mainWindow = true }: { onInstall: (version: string) => void; mainWindow?: boolean } = $props();
  let release = $state<UpdateRelease | null>(null);
  let busy = $state<"check" | "download" | null>(null);
  let ready = $state(false);
  let error = $state<MessageKey | null>(null);
  let percent = $state<number | null>(null);
  const notes = $derived(renderMarkdown(release?.notes ?? ""));
  onMount(() => {
    void updateSnapshot().then((snapshot) => { if (!busy && !release) { release = snapshot; ready = snapshot?.ready ?? false; } }).catch(() => {});
  });
  async function check() {
    if (busy) return;
    busy = "check"; error = null; ready = false;
    try { release = await checkUpdate(); ready = release.ready; } catch (e) { release = null; error = updateError(e); }
    finally { busy = null; }
  }
  async function download() {
    if (busy || !release) return;
    busy = "download"; error = null; percent = null;
    try {
      await downloadUpdate(release.version, (p) => { percent = downloadPercent(p.downloaded, p.total); });
      ready = true;
    } catch (e) { error = updateError(e); }
    finally { busy = null; }
  }
</script>
<div class="space-y-3 text-xs">
  <p class="text-muted">{t("updates.manualOnly")}</p>
  <button class="rounded bg-accent px-3 py-1.5 text-panel-alt disabled:opacity-50" disabled={!!busy} onclick={check}>
    {t(busy === "check" ? "updates.checking" : "menu.updates")}
  </button>
  {#if error}<p role="alert" class="text-bad">{t(error)}</p>{/if}
  {#if release}
    <p>{t("updates.current", { version: release.current })}</p>
    <p class={release.available ? "text-accent" : "text-ok"}>
      {t(release.available ? "updates.available" : "updates.currentLatest", { version: release.version })}
    </p>
    {#if release.available}
      <div class="flex flex-wrap gap-2">
        {#if ready && mainWindow}
          <button class="rounded bg-accent px-3 py-1.5 text-panel-alt" onclick={() => { if (release) onInstall(release.version); }}>{t("updates.install")}</button>
        {:else if release.kind && release.trustedUpdates}
          <button class="rounded bg-accent px-3 py-1.5 text-panel-alt disabled:opacity-50" disabled={!!busy || ready} onclick={download}>
            {t(busy === "download" ? "updates.downloading" : "updates.download")}
          </button>
        {/if}
        <button class="rounded border border-edge px-3 py-1.5 hover:bg-edge"
          onclick={() => { if (release) void openUrl(release.url).catch(() => { error = "updates.errorNetwork"; }); }}>
          {t("updates.releasePage")}
        </button>
      </div>
      {#if busy === "download"}
        <progress class="w-full accent-accent" max="100" value={percent ?? undefined} aria-label={t("updates.downloading")}></progress>
        {#if percent !== null}<p>{percent}%</p>{/if}
      {/if}
      {#if ready}<p class="text-ok">{t("updates.ready")}</p>{/if}
      {#if !mainWindow}<p class="text-muted">{t("updates.mainWindow")}</p>{/if}
      {#if !release.kind}<p class="text-muted">{t("updates.errorFormat")}</p>
      {:else if !release.trustedUpdates}<p class="text-muted">{t("updates.errorKey")}</p>{/if}
      <div class="space-y-2 leading-relaxed" use:mdLinks>{@html notes}</div>
    {/if}
  {/if}
</div>
