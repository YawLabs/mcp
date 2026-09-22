// Types for verify-oam-floor.mjs, so src/tests/verify-oam-floor.test.ts can
// import it under `tsc --noEmit` (tsconfig has no allowJs, and the script
// stays plain .mjs because it runs from a checkout with no build step). Keep
// in step with the exports there; the test imports every one of these.
import type { spawn } from "node:child_process";

export const REPO_ROOT: string;
export const FLOOR_SRC: string;
export const FLOOR_TEST: string;
export const FLOOR_CHANGELOG: string;
export const PROBE_SERVER: string;
export const TAG: string;
export const BLOCK_HEAD: string;

export function parseArgs(
  argv: readonly string[],
): { ok: true; raise: boolean; help: boolean } | { ok: false; error: string };
export function parseVersion(text: string): string | null;
export function compareVersions(a: string, b: string): number;
export function isPrerelease(v: string): boolean;
export function readFloor(srcText: string, srcName?: string): string;
export function resolveOamBin(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): { bin: string; explicit: boolean };
export function installCommand(platform?: NodeJS.Platform): string;
export function oamVersion(bin: string, deps?: { spawn?: typeof spawn; timeoutMs?: number }): Promise<string>;

export interface ProbeResult {
  tools: string[];
  reply: string;
  ms: number;
}
export function probeHosting(opts: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<ProbeResult>;

export function renderFloorBlock(f: { next: string; prev: string; day: string }): string[];
export function raiseFloorText(f: { src: string; test: string; changelog: string; next: string; day: string }): {
  src: string;
  test: string;
  changelog: string;
  prev: string;
};

export interface VerifyDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  out?: (line: string) => void;
  oamVersion?: (bin: string) => Promise<string>;
  probeHosting?: (o: { command: string; args: string[]; cwd: string; timeoutMs: number }) => Promise<ProbeResult>;
  readFile?: (p: string) => string;
  writeFile?: (p: string, text: string) => void;
  day?: string;
}
export function verifyOamFloor(opts?: { raise?: boolean }, deps?: VerifyDeps): Promise<number>;
