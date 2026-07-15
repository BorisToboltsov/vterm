<script lang="ts">
  // Docker settings section (Phase 36, point 6). Two things: the live-view refresh
  // interval, and registry credentials for `docker login`. The password is stored
  // ONLY in the OS keychain (via `set_registry_secret`, keyed by url) — never in
  // settings/localStorage, so it can't leak through a backup export. The non-secret
  // half (url + username) lives in `settings.dockerRegistries`. Login itself runs
  // from the Docker panel, on the active session's host (offline invariant intact).
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import { settings, clampDockerRefresh } from "./settings.svelte";
  import { setRegistrySecret, deleteRegistrySecret } from "./api";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import { registryLabel, type DockerRegistry } from "./docker";
  import { t } from "./i18n";

  let newUrl = $state("");
  let newUser = $state("");
  let newPass = $state("");
  let busy = $state(false);

  const canSave = $derived(newUser.trim().length > 0 && newPass.length > 0);

  async function saveRegistry() {
    if (!canSave || busy) return;
    const url = newUrl.trim();
    const username = newUser.trim();
    busy = true;
    try {
      await setRegistrySecret(url, newPass);
      const list = settings.dockerRegistries.filter((r) => r.url !== url);
      list.push({ url, username });
      settings.dockerRegistries = list;
      newUrl = "";
      newUser = "";
      newPass = "";
      notifySuccess(t("docker.registrySaved"));
    } catch (e) {
      notifyError(String(e));
    } finally {
      busy = false;
    }
  }

  async function removeRegistry(reg: DockerRegistry) {
    busy = true;
    try {
      await deleteRegistrySecret(reg.url);
      settings.dockerRegistries = settings.dockerRegistries.filter((r) => r.url !== reg.url);
    } catch (e) {
      notifyError(String(e));
    } finally {
      busy = false;
    }
  }
</script>

<section data-settings-section="docker">
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionDocker")}<InfoHint text={t("settings.dockerNote")} />
  </h3>

  <label class="block w-40 text-xs text-muted">
    <span class="flex items-center gap-1">{t("settings.dockerRefresh")}<InfoHint text={t("settings.dockerRefreshHint")} /></span>
    <input
      type="number"
      min="1"
      max="30"
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
      value={settings.dockerRefreshSec}
      onchange={(e) => (settings.dockerRefreshSec = clampDockerRefresh(e.currentTarget.valueAsNumber))}
    />
  </label>

  <h4 class="mt-4 mb-1 flex items-center gap-1 text-xs text-white/80">
    {t("settings.dockerRegistries")}<InfoHint text={t("settings.dockerRegistriesHint")} />
  </h4>

  {#if settings.dockerRegistries.length > 0}
    <ul class="mb-2 divide-y divide-edge/60 rounded border border-edge">
      {#each settings.dockerRegistries as reg (reg.url)}
        <li class="flex items-center gap-2 px-2 py-1.5 text-xs">
          <Icon name="container" size={13} class="shrink-0 text-accent" />
          <div class="min-w-0 flex-1 truncate">
            <span class="text-white/90">{registryLabel(reg.url)}</span>
            <span class="text-muted"> · {reg.username}</span>
          </div>
          <button
            class="shrink-0 rounded p-1 text-danger hover:bg-edge disabled:opacity-40"
            disabled={busy}
            aria-label={t("common.delete")}
            onclick={() => removeRegistry(reg)}
          >
            <Icon name="trash" size={13} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="grid grid-cols-2 gap-2">
    <label class="block text-xs text-muted">
      {t("settings.dockerRegistryUrl")}
      <input
        type="text"
        autocomplete="off"
        placeholder="ghcr.io"
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
        bind:value={newUrl}
      />
    </label>
    <label class="block text-xs text-muted">
      {t("settings.dockerRegistryUser")}
      <input
        type="text"
        autocomplete="off"
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
        bind:value={newUser}
      />
    </label>
    <label class="col-span-2 block text-xs text-muted">
      {t("settings.dockerRegistryPass")}
      <input
        type="password"
        autocomplete="off"
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
        bind:value={newPass}
      />
    </label>
  </div>
  <button
    class="mt-2 rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-40"
    disabled={!canSave || busy}
    onclick={saveRegistry}
  >
    {t("settings.dockerRegistryAdd")}
  </button>
</section>
