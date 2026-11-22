<script lang="ts">
  // A database's profile (ADR 0080): where it is (a server of the catalog or
  // this computer), which server it is, its address as that place sees it, the
  // user. The password is asked when it first connects and kept there if the
  // user says so — never here, never in the profile.
  import { untrack } from "svelte";
  import { t } from "../i18n";
  import { forgetDbPassword, profilesOf, saveDbProfiles } from "../stores/db.svelte";
  import { notifyError } from "../stores/toasts.svelte";
  import { dbFailure, failureText } from "./dberror";
  import type { DbKind, DbProfile, ServerProfile } from "../types";
  import Modal from "../ui/Modal.svelte";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import { DEFAULT_PORT, newProfile, profileIssue } from "./dbprofile";
  import { isProdServer } from "../ai/aiexec";

  let {
    open,
    servers,
    initial,
    onclose,
  }: {
    open: boolean;
    servers: ServerProfile[];
    /** The profile to edit, or a new one's start (`place` fixed when editing). */
    initial: { place: string | null; profile: DbProfile; editing: boolean } | null;
    onclose: () => void;
  } = $props();

  let place = $state<string | null>(null);
  let p = $state<DbProfile>(newProfile("postgres", "x"));
  let saving = $state(false);
  let touched = $state(false);
  let kind = $state<DbKind>("postgres");

  $effect(() => {
    if (!open || !initial) return;
    place = initial.place;
    p = { ...initial.profile };
    kind = initial.profile.kind;
    touched = false;
  });

  // The port follows the kind while it is left at the kind's default.
  $effect(() => {
    const k = kind;
    untrack(() => setKind(k));
  });

  const prod = $derived(place !== null && isProdServer(servers.find((s) => s.id === place)));
  const issue = $derived(profileIssue(p, place === null));
  const sortedServers = $derived([...servers].sort((a, b) => a.alias.localeCompare(b.alias)));

  function setKind(k: DbKind) {
    if (p.kind === k) return;
    const wasDefault = p.port === DEFAULT_PORT[p.kind];
    p = { ...p, kind: k, port: wasDefault ? DEFAULT_PORT[k] : p.port };
  }

  async function save() {
    touched = true;
    if (issue || !initial) return;
    saving = true;
    try {
      const list = profilesOf(place, servers).filter((x) => x.id !== p.id);
      const at = profilesOf(place, servers).findIndex((x) => x.id === p.id);
      const next = at < 0 ? [...list, { ...p, readOnly: p.readOnly }] : [...list.slice(0, at), p, ...list.slice(at)];
      await saveDbProfiles(place, next);
      onclose();
    } catch (e) {
      notifyError(t("db.form.saveFailed", { error: failureText(dbFailure(e)) }), { source: "db" });
    } finally {
      saving = false;
    }
  }

  const input = "w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-text outline-none focus:border-accent";
</script>

<Modal {open} title={initial?.editing ? t("db.form.editTitle") : t("db.form.addTitle")} width="w-96" {onclose}>
  <form
    class="space-y-2 text-xs"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
    data-testid="db-form"
  >
    <label class="block">
      <span class="text-muted">{t("db.form.place")}</span>
      <select class={input} bind:value={place} disabled={initial?.editing} data-testid="db-form-place">
        <option value={null}>{t("db.here")}</option>
        {#each sortedServers as s (s.id)}<option value={s.id}>{s.alias}</option>{/each}
      </select>
    </label>
    <SegmentedControl
      bind:value={kind}
      options={[
        { value: "postgres", label: "PostgreSQL" },
        { value: "mysql", label: "MySQL · MariaDB" },
      ]}
      label={t("db.form.kind")}
    />
    <div class="flex gap-2">
      <label class="block flex-1">
        <span class="text-muted">{t("db.form.host")}</span>
        <input class={input} bind:value={p.host} placeholder="127.0.0.1" data-testid="db-form-host" />
      </label>
      <label class="block w-24">
        <span class="text-muted">{t("db.form.port")}</span>
        <input class={input} type="number" min="1" max="65535" bind:value={p.port} data-testid="db-form-port" />
      </label>
    </div>
    <p class="text-meta text-muted">{place === null ? t("db.form.hostHintHere") : t("db.form.hostHint")}</p>
    <div class="flex gap-2">
      <label class="block flex-1">
        <span class="text-muted">{t("db.form.database")}</span>
        <input class={input} bind:value={p.database} data-testid="db-form-database" />
      </label>
      <label class="block flex-1">
        <span class="text-muted">{t("db.form.user")}</span>
        <input class={input} bind:value={p.user} data-testid="db-form-user" />
      </label>
    </div>
    <label class="block">
      <span class="text-muted">{t("db.form.name")}</span>
      <input class={input} bind:value={p.name} placeholder={p.database || p.host} />
    </label>
    <label class="flex items-center gap-2">
      <input type="checkbox" checked={prod || p.readOnly} disabled={prod} onchange={(e) => (p = { ...p, readOnly: (e.currentTarget as HTMLInputElement).checked })} />
      <span class="text-text">{t("db.form.readOnly")}</span>
    </label>
    <p class="text-meta {prod ? 'text-warn' : 'text-muted'}">{prod ? t("db.form.readOnlyProd") : t("db.form.readOnlyHint")}</p>
    {#if p.container}<p class="text-meta text-muted">{t("db.form.container", { name: p.container })}</p>{/if}
    <p class="text-meta text-muted">{t("db.form.passwordLater")}</p>
    {#if initial?.editing && p.hasSavedPassword}
      <button
        type="button"
        class="text-meta text-accent hover:underline"
        onclick={() =>
          void forgetDbPassword(place, p.id)
            .then(() => (p = { ...p, hasSavedPassword: false }))
            .catch((e) => notifyError(failureText(dbFailure(e)), { source: "db" }))}>{t("db.form.forgetPassword")}</button
      >
    {/if}
    {#if touched && issue}<p class="text-bad">{t(`db.form.issue.${issue}`)}</p>{/if}
    <div class="flex justify-end gap-2 pt-1">
      <button type="button" class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={onclose}>{t("db.form.cancel")}</button>
      <button type="submit" class="rounded bg-edge px-3 py-1 text-sm font-medium hover:bg-accent hover:text-panel-alt disabled:opacity-40" disabled={saving}>{t("db.form.save")}</button>
    </div>
  </form>
</Modal>
