<script lang="ts">
  // Local-filesystem browser — a thin wrapper over the shared <FileBrowser>
  // (Phase 44.8). It supplies the local transport and the Windows-aware navigation
  // (the synthetic "This PC" drives level sits above a drive root) as an adapter,
  // and turns on the drive-row rendering. There is no connect step or transfers:
  // the local FS is always available and files open straight in the editor.
  import {
    localHome,
    localList,
    localMkdir,
    localCreateFile,
    localDelete,
    localRename,
    localCopy,
  } from "./api";
  import { DRIVES_ROOT, navParent } from "./fspath";
  import type { FileBrowserAdapter } from "./filebrowser";
  import FileBrowser from "./FileBrowser.svelte";
  import { t } from "./i18n";

  let {
    sessionId = null,
    width = 384,
    collapsed = $bindable(false),
    animateWidth = true,
    embedded = false,
    terminalCwd = null,
    followTerminal = false,
    visible = true,
    onToggleFollowTerminal,
    onOpenFile,
    onUserNavigate,
  }: {
    /** Owning terminal tab — the key its directory is remembered under (v1.0.14). */
    sessionId?: string | null;
    width?: number;
    collapsed?: boolean;
    animateWidth?: boolean;
    embedded?: boolean;
    terminalCwd?: string | null;
    followTerminal?: boolean;
    /** The dock is showing this tab (false = mounted but hidden behind another). */
    visible?: boolean;
    onToggleFollowTerminal?: () => void;
    onOpenFile?: (path: string) => void;
    onUserNavigate?: (path: string) => void;
  } = $props();

  // Local transport + Windows-aware navigation. The drives level (DRIVES_ROOT) is
  // synthetic: it has no filesystem, so it is not mutable and never mirrors to a
  // shell. `navParent` walks up through it so a drive stays reachable when the path
  // bar is read-only text (Phase 39.1).
  const adapter: FileBrowserAdapter = {
    list: (p) => localList(p),
    mkdir: (p) => localMkdir(p),
    createFile: (p) => localCreateFile(p),
    remove: (p, isDir) => localDelete(p, isDir),
    rename: (from, to) => localRename(from, to),
    copy: (from, to) => localCopy(from, to),
    home: () => localHome(),
    hasParent: (dir) => navParent(dir) !== null,
    parentForUp: (dir) => navParent(dir),
    mutable: (dir) => dir !== DRIVES_ROOT,
    mirrorsToTerminal: (path) => path !== DRIVES_ROOT,
  };
</script>

<FileBrowser
  {adapter}
  {width}
  bind:collapsed
  {animateWidth}
  {embedded}
  {terminalCwd}
  {followTerminal}
  {visible}
  sessionKey={sessionId}
  {onToggleFollowTerminal}
  {onOpenFile}
  {onUserNavigate}
  drives
  stripLabel={t("localfiles.label")}
  expandLabel={t("localfiles.expandPanel")}
  collapseLabel={t("localfiles.collapsePanel")}
  syntheticLabel={t("localfiles.thisPc")}
  testPrefix="localfiles"
/>
