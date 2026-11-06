<script lang="ts">
  // Connection-lifecycle screen shown over the terminal area: while an SSH
  // session is connecting (animated comet orbit + live phase checklist driven by
  // `term://phase` events) and, in `failed` mode, when it could not connect / was
  // dropped (static icon with a red cross, the checklist frozen on the phase that
  // failed, plus action buttons via the default slot). Presentational — the page
  // owns the phase/identity props and wires the reconnect/re-auth actions.
  //
  // It fits the room it is given (`connfit.ts`, `use:connFit`): the ring, the gaps
  // and the padding shrink together and the ring stays a circle; short of the
  // smallest ring, the spinner moves into the title's row (`line`), then the
  // checklist folds into it and the row names the step under way (`title`). The
  // mode is `data-mode` on the root, the sizes are its `--conn-*` properties. The
  // root clips, and `my-auto` centres the column only while there is room — short
  // of it, the column starts at the top instead of climbing over the tab strip.
  import type { Snippet } from "svelte";
  import Icon from "../ui/Icon.svelte";
  import type { IconName } from "../ui/icons";
  import { t } from "../i18n";
  import { connFit } from "../actions/connfit";
  import { CONN_MODES } from "./connfit";
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
  /** The step under way, or the one that failed — what the title's row names once
   *  the checklist has folded away. */
  const current = $derived(
    showSteps ? steps.find((s) => s.state === "active" || s.state === "error") : undefined,
  );
  /** The roomiest mode, before the action has measured. An expression, not a
   *  literal: Svelte would drop the `data-mode` selectors of the other modes. */
  const firstMode = CONN_MODES[0];

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
        <Icon name="check" size={14} class="text-ok" />
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
    <div class="mb-1.5 flex items-center gap-2 text-meta text-muted">
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
  data-mode={firstMode}
  class="conn-root absolute inset-0 z-20 flex flex-col items-center overflow-hidden bg-panel"
  role={failed ? "alert" : "status"}
  aria-live={failed ? "assertive" : "polite"}
  use:connFit={[heading, detail, failed, showSteps, proxy, via, children]}
>
  <div class="conn-column my-auto flex w-full flex-col items-center">
    <!-- Comet-trail orbit while connecting; static red-crossed icon on failure.
         Sized by the fit — never a flex item that may shrink: that made it an oval. -->
    <div class="orbit-stage" data-conn-ring>
      {#if failed}
        <span class="ring-failed" aria-hidden="true"></span>
        <span class="conn-glyph"><Icon name="server" size={22} class="text-danger" /></span>
        <span
          class="conn-badge absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-panel bg-danger text-panel"
        >
          <Icon name="close" size={11} />
        </span>
      {:else}
        <span class="orbit-trail" aria-hidden="true"></span>
        <span class="conn-glyph"><Icon name="server" size={22} class="text-accent" /></span>
      {/if}
    </div>

    <div class="max-w-full space-y-1 text-center">
      <p class="flex flex-wrap items-center justify-center gap-x-2 text-sm font-medium text-text">
        <!-- Without the ring, its spinner (or cross) moves into this row. -->
        <span class="conn-mark items-center" aria-hidden="true">
          {#if failed}
            <Icon name="close" size={14} class="text-danger" />
          {:else}
            <span class="conn-spin conn-spin-sm"></span>
          {/if}
        </span>
        <span>{heading}</span>
        {#if current}
          <span class="conn-now text-xs font-normal {labelClass[current.state]}"
            >· {phaseLabel(current.phase)}{current.state === "active" ? "…" : ""}</span
          >
        {/if}
      </p>
      {#if detail}
        <p class="mx-auto max-w-xs break-words text-xs text-danger">{detail}</p>
      {/if}
    </div>

    {#if showSteps}
      <!-- Grouped checklist (variant B): the server steps always sit under a server
           header; when a proxy is used its sub-steps sit under a proxy header above. -->
      <div class="conn-steps flex flex-col gap-3" data-testid="connecting-groups">
        {#if proxySteps.length > 0}
          {@render group("lock", via ?? "", "connecting-proxy-header", proxySteps)}
        {/if}
        {@render group("server", host, "connecting-server-header", serverSteps)}
      </div>
    {:else}
      <p class="conn-steps font-mono text-xs text-muted">{host}</p>
    {/if}

    {#if children}
      <div class="flex flex-wrap items-center justify-center gap-2">
        {@render children()}
      </div>
    {/if}
  </div>
</div>

<style>
  /* The defaults are the model's sizes at k = 1 (`layoutFor("ring", 1)`), the
     screen before the action has measured; the action overwrites them. */
  .conn-root {
    --conn-ring: 4rem;
    --conn-gap: 1.25rem;
    --conn-pad-y: 1.5rem;
    --conn-pad-x: 1.5rem;
    --conn-glyph: 1;
    padding: var(--conn-pad-y) var(--conn-pad-x);
  }
  .conn-column {
    gap: var(--conn-gap);
  }
  .orbit-stage {
    position: relative;
    flex-shrink: 0;
    width: var(--conn-ring);
    height: var(--conn-ring);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .conn-glyph {
    display: inline-flex;
    transform: scale(var(--conn-glyph));
  }
  .conn-badge {
    transform: scale(var(--conn-glyph));
    transform-origin: 100% 100%;
  }
  /* What the title's row gains without the ring is taken out of the flow and
     hidden, never `display: none`: the fit passes through the full screen to
     measure on every re-fit, and a display toggled off and on restarts the
     spinner and the fade — mid-drag the spinner would stand still, see-through.
     Shown again by `inherit`, never `visible`: a tab in the background is hidden by
     `visibility` on an ancestor, and `visible` on a child shows through it — the
     red cross and step of another tab's screen over the one in front. */
  .conn-mark,
  .conn-now {
    position: absolute;
    visibility: hidden;
    opacity: 0;
    transition: opacity var(--motion-fast) ease-out;
  }
  .conn-mark {
    display: inline-flex;
  }
  .conn-root:not([data-mode="ring"]) .orbit-stage {
    display: none;
  }
  .conn-root:not([data-mode="ring"]) .conn-mark,
  .conn-root[data-mode="title"] .conn-now {
    position: static;
    visibility: inherit;
    opacity: 1;
  }
  .conn-root[data-mode="title"] .conn-steps {
    display: none;
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
  .conn-spin-sm {
    width: 0.875rem;
    height: 0.875rem;
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
