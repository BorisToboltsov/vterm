<script lang="ts">
  // Connection-lifecycle screen shown over the terminal area: while an SSH
  // session is connecting (animated comet orbit + live phase checklist driven by
  // `term://phase` events) and, in `failed` mode, when it could not connect / was
  // dropped (static icon with a red cross, the checklist frozen on the phase that
  // failed, plus action buttons via the default slot). Presentational — the page
  // owns the phase/identity props and wires the reconnect/re-auth actions.
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
  import { t } from "./i18n";
  import { phaseSteps, type ConnPhase, type ProxyShape, type PhaseStep } from "./connphase";

  let {
    alias,
    host,
    phase = "connecting",
    failed = false,
    detail,
    title,
    showSteps = true,
    proxy = null,
    via,
    children,
  }: {
    alias: string;
    host: string;
    /** Current phase (connecting) or the phase that failed (failed mode). */
    phase?: ConnPhase;
    /** Render the error state (static red icon, frozen checklist, actions). */
    failed?: boolean;
    /** Red detail line under the title (error reason). */
    detail?: string;
    /** Title override; defaults to the localized "Connecting to {alias}…". */
    title?: string;
    /** Show the phase checklist (hidden for a plain drop after connect). */
    showSteps?: boolean;
    /** Proxy shape — adds the grouped proxy sub-steps (variant B); null → direct. */
    proxy?: ProxyShape | null;
    /** Proxy address (`host:port`) shown as the proxy group header. */
    via?: string;
    /** Action buttons (reconnect / re-enter secret), rendered below the host. */
    children?: Snippet;
  } = $props();

  const steps = $derived(phaseSteps(phase, failed, proxy));
  const proxySteps = $derived(steps.filter((s) => s.group === "proxy"));
  const serverSteps = $derived(steps.filter((s) => s.group === "server"));
  const heading = $derived(title ?? t("connecting.connectingTo", { alias }));

  function phaseLabel(p: ConnPhase): string {
    switch (p) {
      // Proxy connect/auth reuse the target labels (the group header disambiguates).
      case "proxyConnecting":
      case "connecting":
        return t("connecting.phaseConnecting");
      case "proxyAuthenticating":
      case "authenticating":
        return t("connecting.phaseAuth");
      case "proxyTunnel":
        return t("connecting.phaseTunnel");
      case "proxyHandshake":
        return t("connecting.phaseHandshake");
      default:
        return t("connecting.phaseSession");
    }
  }

  const labelClass: Record<string, string> = {
    done: "text-text",
    active: "text-accent",
    error: "text-danger",
    pending: "text-muted",
  };
</script>

{#snippet stepRow(step: PhaseStep)}
  <li class="flex items-center gap-2.5 text-xs">
    <span class="flex w-4 shrink-0 items-center justify-center">
      {#if step.state === "done"}
        <Icon name="check" size={14} class="text-green-500" />
      {:else if step.state === "error"}
        <Icon name="close" size={14} class="text-danger" />
      {:else if step.state === "active"}
        <span class="conn-spin"></span>
      {:else}
        <span class="conn-pending"></span>
      {/if}
    </span>
    <span class={labelClass[step.state]}>
      {phaseLabel(step.phase)}{step.state === "active" ? "…" : ""}
    </span>
  </li>
{/snippet}

{#snippet group(icon: IconName, label: string, testid: string, groupSteps: PhaseStep[])}
  <div>
    <div class="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
      <Icon name={icon} size={13} class="text-muted" />
      <span class="font-mono" data-testid={testid}>{label}</span>
    </div>
    <ul class="ml-1.5 flex flex-col gap-2 border-l border-edge pl-3">
      {#each groupSteps as step (step.phase)}
        {@render stepRow(step)}
      {/each}
    </ul>
  </div>
{/snippet}

<div
  data-testid="connecting-overlay"
  class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-panel p-6"
  role={failed ? "alert" : "status"}
  aria-live={failed ? "assertive" : "polite"}
>
  <!-- Comet-trail orbit while connecting; static red-crossed icon on failure. -->
  <div class="orbit-stage">
    {#if failed}
      <span class="ring-failed" aria-hidden="true"></span>
      <Icon name="server" size={22} class="text-danger" />
      <span
        class="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-panel bg-danger text-panel"
      >
        <Icon name="close" size={11} />
      </span>
    {:else}
      <span class="orbit-trail" aria-hidden="true"></span>
      <Icon name="server" size={22} class="text-accent" />
    {/if}
  </div>

  <div class="space-y-1 text-center">
    <p class="text-sm font-medium text-text">{heading}</p>
    {#if detail}
      <p class="mx-auto max-w-xs break-words text-xs text-danger">{detail}</p>
    {/if}
  </div>

  {#if showSteps}
    <!-- Grouped checklist (variant B): the server steps always sit under a server
         header; when a proxy is used its sub-steps sit under a proxy header above. -->
    <div class="flex flex-col gap-3" data-testid="connecting-groups">
      {#if proxySteps.length > 0}
        {@render group("lock", via ?? "", "connecting-proxy-header", proxySteps)}
      {/if}
      {@render group("server", host, "connecting-server-header", serverSteps)}
    </div>
  {:else}
    <p class="font-mono text-xs text-muted">{host}</p>
  {/if}

  {#if children}
    <div class="flex flex-wrap items-center justify-center gap-2">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .orbit-stage {
    position: relative;
    width: 64px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .orbit-trail {
    position: absolute;
    inset: 2px;
    border-radius: 9999px;
    background: conic-gradient(from 0deg, var(--color-accent), transparent 150deg);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
    animation: orbit-spin 1.4s linear infinite;
  }
  .ring-failed {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    border: 1.5px solid var(--color-danger);
    background: var(--color-panel-alt);
    opacity: 0.6;
  }
  .conn-spin {
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    border: 2px solid var(--color-edge);
    border-top-color: var(--color-accent);
    animation: orbit-spin 0.9s linear infinite;
  }
  .conn-pending {
    width: 14px;
    height: 14px;
    border-radius: 9999px;
    border: 1.5px solid var(--color-edge);
    box-sizing: border-box;
  }
  @keyframes orbit-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
