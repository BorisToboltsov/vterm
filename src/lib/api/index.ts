// Barrel: single `$lib/api` entry point re-exporting the domain modules (split
// from a monolithic api.ts in Phase 18.6, mirroring the backend module layout).
export * from "./core";
export * from "./servers";
export * from "./session";
export * from "./files";
export * from "./recording";
export * from "./ai";
export * from "./git";
export * from "./probe";
export * from "./container";
