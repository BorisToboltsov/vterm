<script lang="ts">
  // Kubernetes settings section (Phase 37). Two knobs: the kubectl program
  // override (for wrappers like `k3s kubectl` / `microk8s kubectl` or an absolute
  // path) and the live-view refresh interval. kubectl runs on the active session's
  // host, never from the app — the offline invariant holds (see k8s.ts / kube.rs).
  import InfoHint from "./InfoHint.svelte";
  import { settings, clampK8sRefresh } from "./settings.svelte";
  import { t } from "./i18n";
</script>

<section data-settings-section="k8s">
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionK8s")}<InfoHint text={t("settings.k8sNote")} />
  </h3>

  <label class="block text-xs text-muted">
    <span class="flex items-center gap-1">{t("settings.kubectlPath")}<InfoHint text={t("settings.kubectlPathHint")} /></span>
    <input
      type="text"
      autocomplete="off"
      spellcheck="false"
      placeholder="kubectl"
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
      bind:value={settings.kubectlPath}
    />
  </label>

  <label class="mt-3 block w-40 text-xs text-muted">
    <span class="flex items-center gap-1">{t("settings.k8sRefresh")}<InfoHint text={t("settings.k8sRefreshHint")} /></span>
    <input
      type="number"
      min="1"
      max="30"
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
      value={settings.k8sRefreshSec}
      onchange={(e) => (settings.k8sRefreshSec = clampK8sRefresh(e.currentTarget.valueAsNumber))}
    />
  </label>
</section>
