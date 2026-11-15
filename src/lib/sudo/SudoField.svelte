<script lang="ts">
  // What sudo will take, said one way wherever sudo is asked (ADR 0073): the
  // editor's prompt, a tool install, the file panel working as another user. One
  // of four: still finding out; whose password will go (nothing to type); a
  // password to type — with why it is asked and "remember in the keychain"; or
  // sudo's refusal, in its own words under ours. The typed password stays in the
  // caller's state until it goes to `sudoCheck` once.
  import { t } from "../i18n";
  import Icon from "../ui/Icon.svelte";
  import PasswordInput from "../ui/PasswordInput.svelte";
  import { REFUSAL_HINT, REFUSAL_TITLE, SOURCE_TEXT, type SudoFieldState } from "./sudo";

  let {
    field,
    password = $bindable(""),
    remember = $bindable(true),
    who = "",
    testid = "sudo",
  }: {
    field: SudoFieldState;
    password?: string;
    remember?: boolean;
    /** `user@server` the password would be remembered for; empty — no "remember". */
    who?: string;
    testid?: string;
  } = $props();
</script>

{#if field.kind === "checking"}
  <p class="text-xs text-muted" data-testid="{testid}-checking">{t("sudo.badge.checking")}</p>
{:else if field.kind === "ready"}
  <p class="flex items-center gap-1.5 text-xs text-text" data-testid="{testid}-source">
    <Icon name="key" size={13} class="shrink-0 text-accent" />
    {t(SOURCE_TEXT[field.source])}
  </p>
{:else if field.kind === "type"}
  {#if field.note}
    <p class="mb-2 rounded border border-bad/50 px-2 py-1 text-xs text-bad" role="alert" data-testid="{testid}-note">
      {t(field.note)}
    </p>
  {/if}
  <PasswordInput testid="{testid}-password" autofocus placeholder={t("editor.sudoPassword")} bind:value={password} />
  {#if who}
    <label class="mt-2 flex items-center gap-2 text-xs text-muted">
      <input type="checkbox" data-testid="{testid}-remember" bind:checked={remember} />
      {t("sudo.remember", { who })}
    </label>
  {/if}
{:else}
  <div class="rounded border border-bad/50 px-2.5 py-2 text-xs" role="alert" data-testid="{testid}-refused">
    <p class="font-medium text-bad">{t(REFUSAL_TITLE[field.why])}</p>
    <p class="mt-1 text-muted">{t(REFUSAL_HINT[field.why])}</p>
    {#if field.said}
      <p class="mt-1 break-words font-mono text-meta text-muted">{t("sudo.serverSaid")}: {field.said}</p>
    {/if}
  </div>
{/if}
