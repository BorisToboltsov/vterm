<script lang="ts">
  // Where a database document's connection stands while it is not ready
  // (ADR 0080): connecting, the password, a failure, a closed connection. One
  // strip for the console and the activity — either may be the first to connect.
  import { t } from "../i18n";
  import { connectDb, dbDoc } from "../stores/db.svelte";
  import type { DbProfile } from "../types";
  import Icon from "../ui/Icon.svelte";
  import PasswordInput from "../ui/PasswordInput.svelte";
  import { failureText } from "./dberror";
  import { profileTitle } from "./dbprofile";

  let { docId, profile }: { docId: string; profile: DbProfile | null } = $props();

  const d = $derived(dbDoc(docId));
  const name = $derived(profile ? profileTitle(profile) : "");
  let password = $state("");
  let remember = $state(true);
  // Turned down is said only of a password given here: the first ask is no failure.
  let given = $state(false);

  function submit(e: SubmitEvent) {
    e.preventDefault();
    given = password !== "";
    void connectDb(docId, password, remember);
    password = "";
  }
</script>

<div class="shrink-0 border-b border-edge px-3 py-2 text-xs" data-testid="db-status">
  {#if !d || d.status === "connecting"}
    <span class="flex items-center gap-2 text-muted"><Icon name="loader" size={13} class="animate-spin" />{t("db.connecting", { name })}</span>
  {:else if d.status === "password"}
    <form class="flex flex-wrap items-center gap-2" onsubmit={submit}>
      <span class="text-text">{t("db.password", { user: profile?.user ?? "", name })}</span>
      <PasswordInput bind:value={password} autofocus class="w-48" inputClass="w-full rounded border border-edge bg-panel px-2 py-0.5 text-xs text-text outline-none focus:border-accent" testid="db-password" />
      <label class="flex items-center gap-1 text-muted"><input type="checkbox" bind:checked={remember} />{t("db.remember")}</label>
      <button type="submit" class="rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt">{t("db.connect")}</button>
      {#if given}<span class="text-meta text-bad" data-testid="db-password-refused">{t("db.err.auth")}</span>
      {:else if password === ""}<span class="text-meta text-muted">{t("db.passwordHint")}</span>{/if}
    </form>
  {:else}
    <span class="flex flex-wrap items-center gap-2">
      <Icon name="alert" size={13} class={d.status === "closed" ? "text-warn" : "text-bad"} />
      <span class={d.status === "closed" ? "text-warn" : "text-bad"}>{d.failure ? failureText(d.failure) : t("db.err.closed")}</span>
      <button type="button" class="rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt" onclick={() => void connectDb(docId)}>{t("db.reconnect")}</button>
    </span>
  {/if}
</div>
