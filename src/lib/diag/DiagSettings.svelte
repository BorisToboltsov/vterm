<script lang="ts">
  // Settings → Journal, the diagnostics layer (ADR 0063): what is written — a
  // threshold the user picks, kept by the backend — where it lies and how much,
  // and the three things to do with it: open the folder, export it through the
  // save dialog, clear it — and how much of it is kept, a size the user picks
  // too. There is no switch to turn it off: the quietest
  // threshold still writes errors, and when something has broken it is too
  // late to start writing. The list itself is `DiagList`.
  import Icon from "../ui/Icon.svelte";
  import InfoHint from "../ui/InfoHint.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import { diagExport, diagReveal, pickDiagExportPath } from "../api/diag";
  import { clearDiag, diagState, setDiagLevel, setDiagSize } from "../stores/diag.svelte";
  import { notifyError, notifySuccess } from "../stores/toasts.svelte";
  import { DIAG_SIZES_MB, errorText, mbBytes, sizeOf, THRESHOLDS, type DiagThreshold } from "./diag";
  import { t } from "../i18n";

  let asking = $state(false);
  let busy = $state(false);
  const cap = $derived(sizeOf(mbBytes(diagState.sizeMb)));

  async function pick(level: DiagThreshold) {
    try {
      await setDiagLevel(level);
    } catch (e) {
      notifyError(t("diag.levelFailed", { error: errorText(e) }), { source: "settings" });
    }
  }

  async function resize(sizeMb: number) {
    try {
      await setDiagSize(sizeMb);
    } catch (e) {
      notifyError(t("diag.sizeFailed", { error: errorText(e) }), { source: "settings" });
    }
  }

  async function exportAll() {
    busy = true;
    try {
      const path = await pickDiagExportPath();
      if (!path) return;
      await diagExport(path);
      notifySuccess(t("diag.exported", { path }), { source: "settings" });
    } catch (e) {
      notifyError(t("diag.exportFailed", { error: errorText(e) }), { source: "settings" });
    } finally {
      busy = false;
    }
  }

  async function reveal() {
    try {
      await diagReveal();
    } catch (e) {
      notifyError(t("diag.revealFailed", { error: errorText(e) }), { source: "settings" });
    }
  }

  async function clear() {
    asking = false;
    try {
      await clearDiag();
    } catch (e) {
      notifyError(t("diag.clearFailed", { error: errorText(e) }), { source: "settings" });
    }
  }
</script>

<div data-testid="diag-settings">
  <label class="block text-xs text-muted">
    <span class="flex items-center gap-1">{t("diag.threshold")}<InfoHint text={t("diag.thresholdHint")} /></span>
    <select
      data-testid="diag-threshold"
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
      value={diagState.level}
      onchange={(e) => void pick((e.currentTarget as HTMLSelectElement).value as DiagThreshold)}
    >
      {#each THRESHOLDS as level (level)}
        <option value={level}>{t(`diag.level.${level}`)}</option>
      {/each}
    </select>
  </label>
  <p class="mt-1 text-meta text-muted" data-testid="diag-threshold-says">
    {t(`diag.writes.${diagState.level}`)}{diagState.level === "debug" ? ` ${t("diag.debugCost", { cap })}` : ""}
  </p>
  <label class="mt-3 block text-xs text-muted">
    <span class="flex items-center gap-1">{t("diag.sizeLabel")}<InfoHint text={t("diag.sizeHint")} /></span>
    <select
      data-testid="diag-size-limit"
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
      value={diagState.sizeMb}
      onchange={(e) => void resize(Number((e.currentTarget as HTMLSelectElement).value))}
    >
      {#each DIAG_SIZES_MB as mb (mb)}
        <option value={mb}>{sizeOf(mbBytes(mb))}</option>
      {/each}
    </select>
  </label>
  {#if diagState.files?.error}
    <p class="mt-1 text-meta text-bad" data-testid="diag-write-failed">{t("diag.writeFailed", { error: diagState.files.error })}</p>
  {/if}

  <div class="mt-3 flex flex-wrap items-center gap-2">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-xs hover:bg-edge"
      data-testid="diag-reveal"
      onclick={() => void reveal()}
    >
      <Icon name="folder" size={12} />{t("diag.reveal")}
    </button>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-xs hover:bg-edge disabled:opacity-40"
      data-testid="diag-export"
      disabled={busy}
      onclick={() => void exportAll()}
    >
      <Icon name="download" size={12} />{t("diag.export")}
    </button>
    <button
      type="button"
      class="rounded border border-danger px-2.5 py-1 text-xs text-danger hover:bg-danger/15 disabled:opacity-40"
      data-testid="diag-clear"
      disabled={(diagState.files?.bytes ?? 0) === 0}
      onclick={() => (asking = true)}>{t("diag.clear")}</button
    >
    <span class="text-meta text-muted" data-testid="diag-size">{t("diag.size", { size: sizeOf(diagState.files?.bytes ?? 0), cap })}</span>
  </div>
</div>

<ConfirmDialog
  open={asking}
  title={t("diag.confirmTitle")}
  confirmLabel={t("diag.clearConfirm")}
  onconfirm={() => void clear()}
  oncancel={() => (asking = false)}
>
  {t("diag.confirmText")}
</ConfirmDialog>
