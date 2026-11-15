<script lang="ts" module>
  /** Whom to ask about: the server, and — for a tab that exists — the tab. */
  export interface LoginAsk {
    server: import("../types").ServerProfile;
    /** An open tab to connect with the login picked (the "Other login" of a refused login). */
    forTab?: string;
    /** Where a new tab goes (the caller's `place`). */
    place?: (sessionId: string) => void;
    /** Start on "Other" — the menu's "Other login…". */
    other?: boolean;
  }
</script>

<script lang="ts">
  // Which login to connect with (ADR 0074): ⌥↵ or ⌥ + double-click in the tree,
  // "Other login…" in its menu, a server set to "Ask", the "Other login" of a
  // refused login. Every login of the server, numbered — a digit picks one, ↑↓
  // and Enter too — the default marked with a star; "Other" is a user for this
  // connection only, kept as a login of the server with "Add to the profile".
  import { t } from "../i18n";
  import Icon from "../ui/Icon.svelte";
  import Modal from "../ui/Modal.svelte";
  import type { TabLogin } from "../types";
  import { pickerItems, validLoginUser } from "./logins";

  let {
    ask,
    onpick,
    oncancel,
  }: {
    ask: LoginAsk | null;
    /** The login picked; `add` — a one-off user to keep in the profile. */
    onpick: (choice: TabLogin, add: boolean) => void;
    oncancel: () => void;
  } = $props();

  const items = $derived(ask ? pickerItems(ask.server) : []);
  // The row in focus: an index of `items`, or `items.length` — "Other".
  let at = $state(0);
  let other = $state("");
  let add = $state(false);
  let otherInput = $state<HTMLInputElement>();
  const onOther = $derived(at === items.length);
  const otherBad = $derived(onOther && other.trim() !== "" && !validLoginUser(other));

  // Each question starts at the default login (or at "Other", when asked so).
  $effect(() => {
    if (!ask) return;
    other = "";
    add = false;
    at = ask.other ? items.length : Math.max(0, items.findIndex((i) => i.isDefault));
    if (ask.other) queueMicrotask(() => otherInput?.focus());
  });

  function pick(index: number) {
    if (index < items.length) {
      onpick({ id: items[index].login.id }, false);
      return;
    }
    if (!validLoginUser(other)) {
      otherInput?.focus();
      return;
    }
    onpick({ once: other.trim() }, add);
  }

  function onkeydown(e: KeyboardEvent) {
    if (!ask) return;
    const typing = e.target instanceof HTMLInputElement && e.target.type === "text";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length + 1;
      at = (at + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      if (at === items.length) otherInput?.focus();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      pick(at);
      return;
    }
    // A digit picks a login at once — unless it is being typed into "Other".
    if (!typing && /^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < items.length) {
        e.preventDefault();
        pick(i);
      }
    }
  }
</script>

<Modal open={!!ask} title={ask ? t("logins.pickTitle", { name: ask.server.alias }) : ""} width="w-[26rem]" onclose={oncancel}>
  {#if ask}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div {onkeydown} data-testid="login-picker">
      <p class="mb-2 font-mono text-meta text-muted">{ask.server.host}:{ask.server.port}</p>
      <ul class="flex flex-col gap-0.5" role="listbox" aria-label={t("logins.pickTitle", { name: ask.server.alias })}>
        {#each items as item, i (item.login.id)}
          <li>
            <button
              type="button"
              role="option"
              aria-selected={at === i}
              class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs {at === i ? 'bg-edge text-text' : 'text-text hover:bg-edge/60'}"
              data-testid="login-pick"
              onfocus={() => (at = i)}
              onclick={() => pick(i)}
            >
              <span class="w-3 font-mono text-muted">{item.key}</span>
              <span class="font-mono">{item.login.username}</span>
              {#if item.isDefault}<Icon name="star" size={12} class="text-warn" />{/if}
              <span class="ml-auto rounded border border-edge px-1.5 text-caption text-muted">
                {item.login.authMethod === "key" ? t("logins.byKey") : item.login.hasSavedPassword ? t("logins.byPasswordSaved") : t("logins.byPassword")}
              </span>
            </button>
          </li>
        {/each}
      </ul>
      <div class="my-2 h-px bg-edge"></div>
      <label class="flex items-center gap-2 px-2 text-xs text-muted">
        {t("logins.other")}
        <input
          bind:this={otherInput}
          type="text"
          class="min-w-0 flex-1 rounded border bg-panel px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent {otherBad ? 'border-bad' : 'border-edge'}"
          placeholder={t("logins.otherPlaceholder")}
          autocomplete="off"
          spellcheck="false"
          data-testid="login-other"
          bind:value={other}
          onfocus={() => (at = items.length)}
        />
      </label>
      <label class="mt-1.5 flex items-center gap-2 px-2 text-caption text-muted">
        <input type="checkbox" data-testid="login-other-add" bind:checked={add} disabled={!other.trim()} />
        {t("logins.addToProfile")}
      </label>
      <div class="mt-4 flex items-center justify-between gap-2">
        <span class="text-caption text-muted">{t("logins.pickKeys")}</span>
        <span class="flex gap-2">
          <button type="button" class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={oncancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-40"
            data-testid="login-pick-connect"
            disabled={onOther && !validLoginUser(other)}
            onclick={() => pick(at)}
          >
            {t("common.connect")}
          </button>
        </span>
      </div>
    </div>
  {/if}
</Modal>
