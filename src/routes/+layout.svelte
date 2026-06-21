<script lang="ts">
  import "../app.css";
  // Bundled coding fonts (open source) so they work regardless of what the OS
  // has installed — referenced by name from the Settings font dropdown.
  import "@fontsource/jetbrains-mono/latin-400.css";
  import "@fontsource/fira-code/latin-400.css";
  import "@fontsource/source-code-pro/latin-400.css";
  import "@fontsource/cascadia-code/latin-400.css";
  // Retro display fonts, paired with the retro terminal themes.
  import "@fontsource/vt323/latin-400.css";
  import "@fontsource/press-start-2p/latin-400.css";
  import "@fontsource/share-tech-mono/latin-400.css";
  let { children } = $props();
</script>

{@render children()}
