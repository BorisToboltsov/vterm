export interface TimingRow {
  job: string;
  label: string;
  group: string | null;
  start: number;
  dur: number;
}
export interface Timing {
  tag: string;
  date: string;
  run: number;
  total: number;
  rows: TimingRow[];
}
export interface WorkflowJob {
  id: string;
  runners: number;
  calls: boolean;
}
export interface GhJob {
  name: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function jobsOf(yaml: string): WorkflowJob[];
export function triggersOf(yaml: string): { pr: boolean; main: boolean; tag: boolean; month: boolean; weekday: number | null; manual: boolean };
export function callsOf(yaml: string): string[];
export function requiredChecks(ciYaml: string): number;
export function readWorkflows(): Record<string, string>;
export function readTiming(): Timing;
export function renderAll(input: { workflows: Record<string, string>; timing: Timing }): Record<string, string>;
export const TIMING_ROWS: { job: string; match: RegExp; label: string; group: string | null }[];
export function timingFromRun(run: { jobs: GhJob[] }, meta: { tag: string; date: string; id: number }): Timing;
