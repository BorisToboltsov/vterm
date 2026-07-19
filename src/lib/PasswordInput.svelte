<script lang="ts">
  // Secret input with a reveal ("eye") toggle (Phase 39.7). The single primitive
  // behind every password/passphrase/API-key field in the app — a new secret field
  // gets the toggle by construction instead of by remembering to add one.
  //
  // Security notes:
  //  * `shown` is component-local and starts `false` on every mount. Every call
  //    site lives inside a `Modal` (which unmounts its children on close) or the
  //    settings panel, so reopening a dialog always comes back masked — the state
  //    is never lifted, persisted or restored.
  //  * The toggle only ever reveals what the user typed here: no call site
  //    prefills a stored secret (a saved one shows as a placeholder — "••••••••"
  //    or "keep current" — and the field itself stays empty), so a keychain secret
  //    can't be read back out through this button.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";

  let {
    // No fallback: call sites bind into sparse maps (`keyDrafts[id]`, undefined
    // until typed), and a `$bindable` fallback rejects that binding outright.
    value = $bindable(),
    placeholder = "",
    testid,
    disabled = false,
    autofocus = false,
    class: cls = "",
    inputClass = "w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent",
  }: {
    /** The typed secret. Bindable. */
    value?: string;
    placeholder?: string;
    /** `data-testid` for the input itself (keeps existing e2e selectors working). */
    testid?: string;
    disabled?: boolean;
    /** Focus the field when it mounts (dialogs that open straight into it). */
    autofocus?: boolean;
    /** Classes for the wrapper — this is what the layout around it sees. */
    class?: string;
    /** Override the field styling (e.g. the smaller `text-xs` settings inputs). */
    inputClass?: string;
  } = $props();

  let shown = $state(false);

  function focusOnMount(node: HTMLElement) {
    if (autofocus) node.focus();
  }
</script>

<div class="relative {cls}">
  <input
    type={shown ? "text" : "password"}
    data-testid={testid}
    autocomplete="off"
    spellcheck="false"
    {disabled}
    {placeholder}
    use:focusOnMount
    class="pr-8 {inputClass}"
    bind:value
  />
  <!-- `type="button"`: several call sites sit inside a <form>, where a bare
       button would submit it (i.e. connect / save) instead of toggling. -->
  <button
    type="button"
    data-testid={testid ? `${testid}-reveal` : undefined}
    class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-white disabled:opacity-40"
    aria-label={shown ? t("common.hidePassword") : t("common.showPassword")}
    aria-pressed={shown}
    use:tooltip={shown ? t("common.hidePassword") : t("common.showPassword")}
    {disabled}
    onclick={() => (shown = !shown)}
  >
    <Icon name={shown ? "eyeOff" : "eye"} size={14} />
  </button>
</div>
