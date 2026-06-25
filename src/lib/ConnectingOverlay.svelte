<script lang="ts">
  // Friendly waiting state shown over the terminal area while an SSH session is
  // connecting. A comet-trail orbit around the server icon plus a checklist of
  // the real connection phases (driven by `term://phase` events; mapping lives
  // in connphase.ts). Presentational — the page owns the phase/identity props.
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";
  import { phaseSteps, type ConnPhase } from "./connphase";

  let {
    alias,
    host,
    phase = "connecting",
    errored = false,
  }: { alias: string; host: string; phase?: ConnPhase; errored?: boolean } = $props();

  const steps = $derived(phaseSteps(phase, errored));

  function phaseLabel(p: ConnPhase): string {
    return p === "connecting"
      ? t("connecting.phaseConnecting")
      : p === "authenticating"
        ? t("connecting.phaseAuth")
        : t("connecting.phaseSession");
  }

  const labelClass: Record<string, string> = {
    done: "text-text",
    active: "text-accent",
    error: "text-danger",
    pending: "text-muted",
  };
</script>

<div
  data-testid="connecting-overlay"
  class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-panel p-6"
  role="status"
  aria-live="polite"
>
  <!-- Comet-trail orbit around the server glyph. -->
  <div class="orbit-stage">
    <span class="orbit-trail" aria-hidden="true"></span>
    <Icon name="server" size={22} class="text-accent" />
  </div>

  <p class="text-sm font-medium text-text">{t("connecting.connectingTo", { alias })}</p>

  <ul class="flex flex-col gap-2.5">
    {#each steps as step (step.phase)}
      <li class="flex items-center gap-2.5 text-xs">
        <span class="flex w-4 shrink-0 items-center justify-center">
          {#if step.state === "done"}
            <Icon name="check" size={14} class="text-green-500" />
          {:else if step.state === "error"}
            <Icon name="alert" size={14} class="text-danger" />
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
    {/each}
  </ul>

  <p class="font-mono text-xs text-muted">{host}</p>
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
