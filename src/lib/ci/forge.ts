// Where a repository's runs live (ADR 0069): the forge behind each of its
// remotes, read from `git remote -v`. GitHub and GitLab only — the two whose
// CLIs (`gh`, `glab`) the panel talks through. A host is known by its name
// (`github.com`, `gitlab.example.org`) or by the remote's (`gitlab` pointing at
// a LAN address); what neither says, the user says once per host
// (`settings.ciForges`). Pure.

import { remoteHostPath } from "../git/git";

export type Forge = "github" | "gitlab";
export const FORGES: readonly Forge[] = ["github", "gitlab"];

/** The program that speaks a forge's API. */
export const CLI: Record<Forge, "gh" | "glab"> = { github: "gh", gitlab: "glab" };

export interface Remote {
  name: string;
  url: string;
}

/** A repository on a host — known forge or not. */
export interface RepoRemote {
  /** The remote's name (`origin`). */
  remote: string;
  host: string;
  /** `owner/repo`, or a GitLab project's full path `group/sub/repo`. */
  path: string;
  /** null — the host says nothing, and the user has not told. */
  forge: Forge | null;
}

/** A repository whose forge is known: what the panel works on. */
export interface Repo extends RepoRemote {
  forge: Forge;
}

/** The remotes in `git remote -v`, each once (its fetch URL). */
export function parseRemotes(stdout: string): Remote[] {
  const out: Remote[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)\s*$/);
    if (!m || out.some((r) => r.name === m[1])) continue;
    out.push({ name: m[1], url: m[2] });
  }
  return out;
}

const isForge = (v: unknown): v is Forge => v === "github" || v === "gitlab";

/** The forge of a host: the user's word first, then the host's or the remote's name. */
export function forgeOf(host: string, remote: string, known: Readonly<Record<string, Forge>>): Forge | null {
  const said = known[host.toLowerCase()];
  if (isForge(said)) return said;
  const h = host.toLowerCase();
  if (h === "github.com" || /(^|[.-])github([.-]|$)/.test(h)) return "github";
  if (h === "gitlab.com" || /(^|[.-])gitlab([.-]|$)/.test(h)) return "gitlab";
  if (/github/i.test(remote)) return "github";
  if (/gitlab/i.test(remote)) return "gitlab";
  return null;
}

/** The repositories the remotes name, `origin` first, each host and path once. */
export function reposOf(remotes: readonly Remote[], known: Readonly<Record<string, Forge>>): RepoRemote[] {
  const out: RepoRemote[] = [];
  const ordered = [...remotes].sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin"));
  for (const r of ordered) {
    const hp = remoteHostPath(r.url);
    if (!hp) continue;
    if (out.some((x) => x.host === hp.host && x.path === hp.path)) continue;
    out.push({ remote: r.name, host: hp.host, path: hp.path, forge: forgeOf(hp.host, r.name, known) });
  }
  return out;
}

/** The repository to show: the one picked before if it is still there, else the first known. */
export function pickRepo(repos: readonly RepoRemote[], picked: string | null): RepoRemote | null {
  return repos.find((r) => r.remote === picked) ?? repos.find((r) => r.forge !== null) ?? repos[0] ?? null;
}

export const isKnown = (r: RepoRemote | null): r is Repo => r !== null && r.forge !== null;

/** The forges the user named by host, as kept in the settings. */
export function sanitizeForges(raw: unknown): Record<string, Forge> {
  const out: Record<string, Forge> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [host, forge] of Object.entries(raw)) {
    if (isForge(forge) && /^[A-Za-z0-9.:-]{1,253}$/.test(host)) out[host.toLowerCase()] = forge;
  }
  return out;
}

/** A file's path inside its repository, as git names it (`/`), or null — not inside it. */
export function repoRelative(root: string, file: string): string | null {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = file.replace(/\\/g, "/");
  return r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : null;
}

/** The repository's page on its forge. */
export function repoWebUrl(r: RepoRemote): string {
  return `https://${r.host}/${r.path}`;
}
