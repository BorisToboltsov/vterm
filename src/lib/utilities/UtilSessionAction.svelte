<script lang="ts">
  // One session action in the Utilities window (v1.16): whether it can run now,
  // why not when it cannot, and the button that runs it. The title, the
  // description and the pin are the window's — the same as for a tool. A thin
  // shell: what the button says and whether it is enabled is `sessionActionView`.
  import Icon from "../ui/Icon.svelte";
  import type { SessionActionDef, SessionActionView } from "./sessionactions";
  import { t } from "../i18n";

  let {
    def,
    view,
    notesFor = null,
    pinned = false,
    onrun,
  }: {
    def: SessionActionDef;
    view: SessionActionView;
    /** The server the notes would open for — named, so the button is not a guess. */
    notesFor?: string | null;
    /** The action has a button on the top bar. */
    pinned?: boolean;
    onrun: () => void;
  } = $props();
</script>

<div class="space-y-3" data-testid="session-action" data-action={def.id}>
  {#if def.id === "notes" && notesFor}
    <p class="text-xs text-text/90" data-testid="session-action-target">
      {t("sessionact.notesFor", { server: notesFor })}
    </p>
  {/if}
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-panel-alt hover:bg-accent-hover disabled:opacity-40"
      disabled={view.disabled}
      data-testid="session-action-run"
      onclick={onrun}
    >
      <Icon name={def.icon} size={14} />
      {t(view.buttonKey)}
    </button>
    <!-- A grey button says nothing: the reason stands next to it. -->
    {#if view.reasonKey}
      <span class="flex items-center gap-1 text-xs text-warn" data-testid="session-action-reason">
        <Icon name="alert" size={12} />{t(view.reasonKey)}
      </span>
    {:else if view.onKey}
      <span class="flex items-center gap-1.5 text-xs text-text/90" data-testid="session-action-on">
        <span class="h-1.5 w-1.5 rounded-full bg-ok"></span>{t(view.onKey)}
      </span>
    {/if}
  </div>
  {#if !pinned}
    <p class="border-t border-edge pt-2 text-meta text-muted" data-testid="session-action-offbar">
      {t("sessionact.offBar")}
    </p>
  {/if}
</div>
