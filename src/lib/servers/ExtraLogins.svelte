<script lang="ts">
  // The server form's other logins (ADR 0074): the profile's own user stays the
  // form's first fields; these are the rest — each a row with the star of the
  // default, its user and how it signs in, unfolded to edit, removable. "On
  // connect" chooses between the default login and asking every time. A secret
  // typed here is saved under the login's own keychain scope after the profile.
  import { t } from "../i18n";
  import Icon from "../ui/Icon.svelte";
  import InfoHint from "../ui/InfoHint.svelte";
  import PasswordInput from "../ui/PasswordInput.svelte";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import { tooltip } from "../actions/tooltip";
  import { pickKeyFile } from "../api";
  import type { AuthMethod } from "../types";
  import { FIRST, newDraft, validLoginUser, type LoginDraft } from "./logins";

  let {
    drafts = $bindable([]),
    defaultLogin = $bindable(FIRST),
    askLogin = $bindable(false),
    submitted = false,
  }: {
    drafts?: LoginDraft[];
    defaultLogin?: string;
    askLogin?: boolean;
    /** The form was submitted: an empty user is shown as such. */
    submitted?: boolean;
  } = $props();

  // The row unfolded for editing; a new one opens unfolded.
  let shown = $state<string | null>(null);

  const authOptions = $derived<{ value: AuthMethod; label: string }[]>([
    { value: "password", label: t("page.authPassword") },
    { value: "key", label: t("page.authKey") },
  ]);
  const onConnectOptions = $derived<{ value: "default" | "ask"; label: string }[]>([
    { value: "default", label: t("logins.useDefault") },
    { value: "ask", label: t("logins.ask") },
  ]);

  function add() {
    const d = newDraft();
    drafts = [...drafts, d];
    shown = d.id;
  }

  function remove(id: string) {
    drafts = drafts.filter((d) => d.id !== id);
    if (defaultLogin === id) defaultLogin = FIRST;
    if (shown === id) shown = null;
  }

  async function browse(i: number) {
    const picked = await pickKeyFile();
    if (picked && drafts[i]) drafts[i].keyPath = picked;
  }

  /** The chip of a row: how it signs in, and whether its password is kept. */
  function how(d: LoginDraft): string {
    if (d.authMethod === "key") return `${t("logins.byKey")}${d.keyPath ? ` · ${d.keyPath.split(/[\\/]/).pop()}` : ""}`;
    return d.hasSavedPassword || d.secret ? t("logins.byPasswordSaved") : t("logins.byPassword");
  }
</script>

{#if drafts.length > 0}
  <p class="mb-1 flex items-center gap-1 text-xs text-muted">
    {t("logins.title")}
    <InfoHint text={t("logins.hint")} />
  </p>
  <ul class="mb-2 overflow-hidden rounded border border-edge" data-testid="extra-logins">
    {#each drafts as d, i (d.id)}
      {@const bad = submitted && !validLoginUser(d.username)}
      <li class="border-b border-edge last:border-b-0 {shown === d.id ? 'bg-panel' : ''}">
        <div class="flex items-center gap-2 px-2 py-1.5 text-xs">
          <button
            type="button"
            class="shrink-0 {defaultLogin === d.id ? 'text-warn' : 'text-muted hover:text-text'}"
            aria-label={t("logins.makeDefault")}
            aria-pressed={defaultLogin === d.id}
            data-testid="login-default"
            use:tooltip={t("logins.makeDefault")}
            onclick={() => (defaultLogin = d.id)}><Icon name="star" size={13} /></button
          >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
            aria-expanded={shown === d.id}
            data-testid="login-row"
            onclick={() => (shown = shown === d.id ? null : d.id)}
          >
            <span class="truncate font-mono {bad ? 'text-danger' : 'text-text'}">{d.username || "—"}</span>
            <span class="shrink-0 rounded border border-edge px-1.5 text-caption text-muted">{how(d)}</span>
            {#if defaultLogin === d.id}<span class="ml-auto shrink-0 text-caption text-muted">{t("logins.default")}</span>{/if}
            <Icon name={shown === d.id ? "chevronUp" : "chevronDown"} size={12} class="{defaultLogin === d.id ? '' : 'ml-auto'} shrink-0 text-muted" />
          </button>
        </div>
        {#if shown === d.id}
          <div class="grid grid-cols-[5rem_1fr] items-center gap-x-2 gap-y-1.5 px-2 pb-2 pl-7 text-xs text-muted">
            <span>{t("logins.user")}</span>
            <input
              class="w-full rounded border bg-panel-alt px-2 py-1 font-mono text-sm text-text outline-none focus:border-accent {bad ? 'border-danger' : 'border-edge'}"
              aria-invalid={bad}
              data-testid="login-user"
              autocomplete="off"
              spellcheck="false"
              bind:value={drafts[i].username}
            />
            <span>{t("logins.auth")}</span>
            <SegmentedControl bind:value={drafts[i].authMethod} options={authOptions} label={t("logins.auth")} testid="login-auth" />
            {#if d.authMethod === "key"}
              <span>{t("page.privateKeyFile")}</span>
              <span class="flex gap-2">
                <input readonly class="min-w-0 flex-1 rounded border border-edge bg-panel-alt px-2 py-1 text-sm text-text outline-none" value={d.keyPath ?? ""} placeholder="~/.ssh/id_ed25519" />
                <button type="button" class="shrink-0 rounded bg-edge px-2 py-1 text-sm hover:bg-accent hover:text-panel-alt" onclick={() => void browse(i)}
                  >{t("common.browse")}</button
                >
              </span>
            {/if}
            <span>{d.authMethod === "key" ? t("logins.secretPassphrase") : t("logins.secret")}</span>
            <PasswordInput testid="login-secret" bind:value={drafts[i].secret} placeholder={d.hasSavedPassword ? t("logins.secretKeep") : ""} />
            <span></span>
            <button type="button" class="justify-self-start text-caption text-danger hover:underline" data-testid="login-remove" onclick={() => remove(d.id)}>
              {t("logins.remove")}
            </button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  {#if submitted && drafts.some((d) => !validLoginUser(d.username))}
    <p class="-mt-1 mb-2 text-meta text-danger">{t("logins.emptyUser")}</p>
  {/if}
{/if}
<button type="button" class="mb-2 flex items-center gap-1 text-xs text-accent hover:underline" data-testid="login-add" onclick={add}>
  <Icon name="plus" size={12} />{t("logins.add")}
</button>
{#if drafts.length > 0}
  <div class="mb-3 text-xs text-muted">
    {t("logins.onConnect")}
    <div class="mt-1">
      <SegmentedControl
        bind:value={() => (askLogin ? "ask" : "default"), (v) => (askLogin = v === "ask")}
        options={onConnectOptions}
        label={t("logins.onConnect")}
        testid="login-on-connect"
      />
    </div>
  </div>
{/if}
