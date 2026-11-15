<script lang="ts">
  // "New Ansible project" (ADR 0071): a folder in the one the file panel shows,
  // with an inventory of the servers picked from the catalog (no password in
  // it — a server that signs in with one is asked by Ansible), `site.yml` and a
  // role that only asks the servers to answer. Opens on its overview.
  import { t } from "../i18n";
  import { scaffoldAnsibleProject } from "../stores/scenarios.svelte";
  import Modal from "../ui/Modal.svelte";
  import type { ServerProfile } from "../types";
  import { catalogInventory } from "./inventory";
  import { projectFolderProblem } from "./scaffold";
  import TargetPicker from "./TargetPicker.svelte";

  let {
    open,
    sessionId,
    local,
    parent,
    where,
    servers,
    connected,
    onclose,
    oncreate,
  }: {
    open: boolean;
    sessionId: string;
    local: boolean;
    /** The folder the project is made in. */
    parent: string;
    /** "server:path" as the dialog names the place. */
    where: string;
    servers: ServerProfile[];
    connected: ReadonlySet<string>;
    onclose: () => void;
    oncreate: (root: string) => void;
  } = $props();

  let name = $state("ansible");
  let picked = $state<string[]>([]);
  let problem = $state("");
  let busy = $state(false);

  async function create() {
    const bad = projectFolderProblem(name);
    if (bad) return void (problem = bad === "empty" ? t("scenarios.newProject.nameRequired") : t("scenarios.newProject.nameBad"));
    busy = true;
    problem = "";
    try {
      const inv = catalogInventory(
        servers.filter((s) => picked.includes(s.id)),
        local,
      );
      oncreate(await scaffoldAnsibleProject(sessionId, local, parent, name, inv.text));
    } catch (e) {
      problem = t("scenarios.newProject.failed", { error: String(e) });
    } finally {
      busy = false;
    }
  }
</script>

<Modal {open} title={t("scenarios.newProject.title")} width="w-[32rem]" showClose {onclose}>
  <form
    class="space-y-2 text-xs"
    data-testid="new-project-dialog"
    onsubmit={(e) => {
      e.preventDefault();
      void create();
    }}
  >
    <p class="break-all font-mono text-meta text-muted">{where}</p>
    <label class="block text-muted" for="new-project-name">{t("scenarios.newProject.name")}</label>
    <input
      id="new-project-name"
      class="w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-text outline-none focus:border-accent"
      bind:value={name}
      oninput={() => (problem = "")}
    />
    <p class="text-muted">{t("scenarios.newProject.servers")}</p>
    <TargetPicker {servers} bind:selected={picked} {connected} hideStatus testid="new-project-targets" />
    <p class="text-meta text-muted">{t("scenarios.newProject.hint")}</p>
    {#if problem}<p class="text-meta text-danger" role="alert">{problem}</p>{/if}
    <div class="flex justify-end gap-2">
      <button type="button" class="rounded border border-edge px-3 py-1 text-text" onclick={onclose}>{t("common.cancel")}</button>
      <button type="submit" class="rounded bg-accent px-3 py-1 text-panel disabled:opacity-50" disabled={busy}>{t("scenarios.newProject.create")}</button>
    </div>
  </form>
</Modal>
