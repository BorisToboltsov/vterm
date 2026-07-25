<script lang="ts">
  // Folder create / rename / delete modals (extracted from +page.svelte in Phase
  // 18.4.3). Owns the modal state and the mutating calls; on any successful change
  // it fires `onchanged` so the parent reloads its servers + folders. Open via the
  // exported `openCreate` / `openRename` / `openDelete` (through `bind:this`).
  import Modal from "./Modal.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { nameOf } from "./tree";
  import { addFolder, renameFolder, deleteFolder } from "./api";
  import { notifySuccess, notifyError } from "./stores/toasts.svelte";
  import { t } from "./i18n";

  let {
    onchanged,
    onDeleteWithServers,
  }: {
    onchanged: () => void;
    /** Delete the folder together with its servers. Owned by the page because it
     *  must also tear down those servers' open tabs (workspaces, AI chat,
     *  broadcast) and fix the selection — layer the store/modal can't reach. */
    onDeleteWithServers: (path: string) => void;
  } = $props();

  let showCreate = $state(false);
  let createParent = $state("");
  let createName = $state("");
  let toRename = $state<string | null>(null);
  let renameName = $state("");
  let toDelete = $state<string | null>(null);
  // How many servers live in `toDelete`'s subtree — decides between the plain
  // confirm (empty folder) and the "what happens to the servers" chooser.
  let deleteCount = $state(0);
  // The chooser's selection: keep the servers (move to root) or delete them too.
  let deleteMode = $state<"root" | "servers">("root");
  // Second, explicit consent gate shown only for the destructive "servers" mode.
  let confirmServers = $state(false);

  /** Open the "new folder" form, optionally nested under `parent`. */
  export function openCreate(parent: string) {
    createParent = parent;
    createName = "";
    showCreate = true;
  }

  /** Open the rename form for an existing folder `path`. */
  export function openRename(path: string) {
    toRename = path;
    renameName = nameOf(path);
  }

  /** Open the delete confirmation for folder `path`. `serverCount` is how many
   *  servers live in its subtree — when > 0 the dialog offers a choice. */
  export function openDelete(path: string, serverCount = 0) {
    toDelete = path;
    deleteCount = serverCount;
    deleteMode = "root";
    confirmServers = false;
  }

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }

  async function submitCreate(event: Event) {
    event.preventDefault();
    const name = createName.trim();
    if (!name) return;
    const path = createParent ? `${createParent}/${name}` : name;
    try {
      await addFolder(path);
      showCreate = false;
      notifySuccess(t("page.folderCreated", { name }));
      onchanged();
    } catch (e) {
      notifyError(String(e));
    }
  }

  async function submitRename(event: Event) {
    event.preventDefault();
    const name = renameName.trim();
    if (!toRename || !name || name === nameOf(toRename)) {
      toRename = null;
      return;
    }
    try {
      await renameFolder(toRename, name);
      onchanged();
    } catch (e) {
      notifyError(String(e));
    }
    toRename = null;
  }

  function closeDelete() {
    toDelete = null;
    confirmServers = false;
  }

  /** From the chooser's "Delete": the servers-mode routes through a second
   *  confirmation; keep-mode deletes the folder straight away. */
  function submitDelete() {
    if (deleteMode === "servers") {
      confirmServers = true;
    } else {
      void deleteFolderOnly();
    }
  }

  /** Delete the folder, leaving its servers (they move to the root). */
  async function deleteFolderOnly() {
    if (!toDelete) return;
    const path = toDelete;
    closeDelete();
    try {
      await deleteFolder(path);
      notifySuccess(t("page.folderDeleted", { name: nameOf(path) }));
      onchanged();
    } catch (e) {
      notifyError(String(e));
    }
  }

  /** Hand the destructive folder+servers delete to the page (see prop doc). */
  function deleteFolderAndServers() {
    if (!toDelete) return;
    const path = toDelete;
    closeDelete();
    onDeleteWithServers(path);
  }
</script>

<!-- New folder -->
<Modal open={showCreate} title={t("page.newFolderTitle")} showClose onclose={() => (showCreate = false)}>
  <form onsubmit={submitCreate}>
    {#if createParent}
      <p class="mb-3 text-xs text-muted">
        {t("page.inside")} <span class="text-text">{createParent}</span>
      </p>
    {/if}
    <input
      use:focusOnMount
      class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
      placeholder={t("sftp.folderNamePlaceholder")}
      bind:value={createName}
    />
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
        onclick={() => (showCreate = false)}>{t("common.cancel")}</button
      >
      <button
        type="submit"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
        >{t("common.create")}</button
      >
    </div>
  </form>
</Modal>

<!-- Rename folder -->
<Modal open={!!toRename} title={t("page.renameFolderTitle")} showClose onclose={() => (toRename = null)}>
  <form onsubmit={submitRename}>
    <input
      use:focusOnMount
      class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
      placeholder={t("sftp.folderNamePlaceholder")}
      bind:value={renameName}
    />
    <div class="mt-4 flex justify-end gap-2">
      <button
        type="button"
        class="rounded px-3 py-1 text-sm text-muted hover:text-text"
        onclick={() => (toRename = null)}>{t("common.cancel")}</button
      >
      <button
        type="submit"
        class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover"
        >{t("common.rename")}</button
      >
    </div>
  </form>
</Modal>

<!-- Delete folder — empty: a plain confirm (servers-to-root wording still holds
     for an empty subtree; nothing actually moves). -->
<ConfirmDialog
  open={!!toDelete && deleteCount === 0}
  title={t("page.deleteFolderTitle")}
  confirmLabel={t("common.delete")}
  onconfirm={deleteFolderOnly}
  oncancel={closeDelete}
>
  {t("page.deleteFolderBody1")} <span class="text-text">{toDelete}</span> {t("page.deleteFolderBody2")}
</ConfirmDialog>

<!-- Delete folder that still holds servers — choose their fate. -->
<Modal
  open={!!toDelete && deleteCount > 0 && !confirmServers}
  title={t("page.deleteFolderTitle")}
  titleClass="text-danger"
  onclose={closeDelete}
>
  <p class="text-xs text-muted">
    {t("page.deleteFolderIntro", { name: toDelete ?? "" })}
    {t("page.deleteFolderServersCount", { n: deleteCount })}
  </p>
  <div class="mt-3 flex flex-col gap-2 text-sm text-text">
    <label class="flex items-start gap-2">
      <input type="radio" class="mt-0.5" value="root" bind:group={deleteMode} />
      <span>{t("page.deleteFolderKeepServers")}</span>
    </label>
    <label class="flex items-start gap-2">
      <input type="radio" class="mt-0.5" value="servers" bind:group={deleteMode} />
      <span>
        {t("page.deleteFolderDropServers")}
        <span class="text-danger">— {t("page.deleteFolderDropHint")}</span>
      </span>
    </label>
  </div>
  <div class="mt-4 flex justify-end gap-2">
    <button
      type="button"
      class="rounded px-3 py-1 text-sm text-muted hover:text-text"
      onclick={closeDelete}>{t("common.cancel")}</button
    >
    <button
      type="button"
      data-testid="confirm"
      class="rounded px-3 py-1 text-sm text-panel-alt hover:opacity-90 {deleteMode ===
      'servers'
        ? 'bg-danger'
        : 'bg-accent hover:bg-accent-hover'}"
      onclick={submitDelete}>{t("common.delete")}</button
    >
  </div>
</Modal>

<!-- Second, explicit consent for deleting the servers too. -->
<ConfirmDialog
  open={confirmServers}
  title={t("page.deleteServersTitle")}
  confirmLabel={t("page.deleteServersConfirm")}
  onconfirm={deleteFolderAndServers}
  oncancel={() => (confirmServers = false)}
>
  {t("page.deleteServersBody", { n: deleteCount })}
</ConfirmDialog>
