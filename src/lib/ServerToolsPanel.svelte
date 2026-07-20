<script lang="ts">
  // Catalogue of optional server tools for the Settings panel (Phase 12.8): shows
  // each tool's install status on the active SSH connection and an Install action.
  import { serverToolsStatus } from "./api";
  import { tooltip } from "./actions/tooltip";
  import type { ToolStatus, ToolsStatus } from "./servertools";
  import Icon from "./Icon.svelte";
  import { notifyError } from "./stores/toasts.svelte";
  import { t, type MessageKey } from "./i18n";

  let {
    sessionId,
    onInstall,
    reloadToken = 0,
  }: {
    /** Active SSH session id, or null when none is connected. */
    sessionId: string | null;
    onInstall: (tool: ToolStatus) => void;
    /** Bump to force a re-check after an install finishes (Phase 20.14). */
    reloadToken?: number;
  } = $props();

  let status = $state<ToolsStatus | null>(null);
  let loading = $state(false);

  /** Per-tool purpose label (technical tool names aren't translated; purpose is). */
  const PURPOSE: Record<string, MessageKey> = {
    shellcheck: "servertools.purposeShell",
    yamllint: "servertools.purposeYaml",
    hadolint: "servertools.purposeDocker",
    ruff: "servertools.purposePython",
    "ansible-lint": "servertools.purposeAnsible",
    actionlint: "servertools.purposeActions",
    kubeconform: "servertools.purposeK8s",
    sensors: "servertools.purposeTemp",
  };

  export async function load() {
    if (!sessionId) {
      status = null;
      return;
    }
    loading = true;
    try {
      status = await serverToolsStatus(sessionId);
    } catch (e) {
      notifyError(String(e));
      status = null;
    } finally {
      loading = false;
    }
  }

  // (Re)load whenever the active connection changes or an install finishes.
  $effect(() => {
    void sessionId;
    void reloadToken;
    load();
  });
</script>

{#if !sessionId}
  <p class="text-xs text-muted">{t("servertools.connectFirst")}</p>
{:else}
  <div class="mb-2 flex items-center gap-2 text-meta text-muted">
    {#if status?.manager}
      <span>{t("servertools.manager", { mgr: status.manager })}</span>
    {/if}
    <button
      class="ml-auto flex items-center gap-1 rounded p-1 hover:bg-edge hover:text-white"
      use:tooltip={t("sftp.refresh")}
      aria-label={t("sftp.refresh")}
      onclick={load}
    >
      <Icon name="refresh" size={13} />
    </button>
  </div>
  {#if loading && !status}
    <p class="text-xs text-muted">{t("servertools.checking")}</p>
  {:else if status}
    <div class="divide-y divide-edge rounded border border-edge">
      {#each status.tools as tool (tool.id)}
        <div class="flex items-center gap-2 px-2 py-1.5 text-xs">
          <div class="min-w-0 flex-1">
            <div class="text-white">{tool.name}</div>
            <div class="truncate text-meta text-muted">{t(PURPOSE[tool.id] ?? "servertools.purposeShell")}</div>
          </div>
          {#if tool.installed}
            <span class="flex items-center gap-1 text-ok">
              <Icon name="check" size={13} />
              {t("servertools.installed")}
            </span>
          {:else}
            <button
              class="rounded bg-edge px-2 py-1 hover:bg-accent hover:text-panel-alt disabled:opacity-40"
              disabled={!tool.command}
              onclick={() => onInstall(tool)}
            >
              {t("servertools.install")}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
{/if}
