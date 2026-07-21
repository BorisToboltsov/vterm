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

  let { onchanged }: { onchanged: () => void } = $props();

  let showCreate = $state(false);
  let createParent = $state("");
  let createName = $state("");
  let toRename = $state<string | null>(null);
  let renameName = $state("");
  let toDelete = $state<string | null>(null);

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

  /** Open the delete confirmation for folder `path`. */
  export function openDelete(path: string) {
    toDelete = path;
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

  async function confirmDelete() {
    if (!toDelete) return;
    const path = toDelete;
    toDelete = null;
    try {
      await deleteFolder(path);
      notifySuccess(t("page.folderDeleted", { name: nameOf(path) }));
      onchanged();
    } catch (e) {
      notifyError(String(e));
    }
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

<!-- Delete folder confirmation -->
<ConfirmDialog
  open={!!toDelete}
  title={t("page.deleteFolderTitle")}
  confirmLabel={t("common.delete")}
  onconfirm={confirmDelete}
  oncancel={() => (toDelete = null)}
>
  {t("page.deleteFolderBody1")} <span class="text-text">{toDelete}</span> {t("page.deleteFolderBody2")}
</ConfirmDialog>
