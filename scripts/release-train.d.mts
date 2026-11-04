export type ReleaseKind = "minor" | "patch";
export interface Section {
  title: string;
  version: string | null;
  body: string;
}
export interface Unreleased {
  items: Record<ReleaseKind, string[]>;
  problems: string[];
}
export type Plan =
  | { release: false; reason: string }
  | { release: true; version: string; kind: ReleaseKind; minor: number; patch: number };
export interface Side {
  version: string;
  changelog: string;
}

export const UNRELEASED: string;
export const KINDS: Record<string, ReleaseKind>;
export const RELEASE_BRANCHES: string[];
export function compare(a: string, b: string): number;
export function bump(version: string, kind: ReleaseKind): string;
export function sectionsOf(changelog: string): Section[];
export function versionsOf(changelog: string): string[];
export function unreleasedOf(changelog: string): Unreleased | null;
export function plan(input: { changelog: string; version: string; tags: string[] }): Plan;
export function cut(changelog: string, version: string, date: string): string;
export function notes(changelog: string, tag: string, since: string | null): string;
export function instructions(tag: string): string;
export function body(changelog: string, tag: string, since: string | null): string;
export function prProblems(input: { branch: string; base: Side; head: Side }): string[];
export function tagDecision(input: {
  version: string;
  parentVersion: string;
  tagged: boolean;
  changelog: string;
}): { tag: string | null; note: string };
