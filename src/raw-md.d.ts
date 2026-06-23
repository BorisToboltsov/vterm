// Vite's `?raw` suffix imports a file's contents as a string. Declared here so
// the type-checker accepts `import readme from "../../README.md?raw"` (used by
// the in-app manual in HelpPanel).
declare module "*.md?raw" {
  const content: string;
  export default content;
}
