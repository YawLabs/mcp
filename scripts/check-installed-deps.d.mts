// Types for check-installed-deps.mjs, so src/tests/check-installed-deps.test.ts
// can import it under `tsc --noEmit` (tsconfig has no allowJs, and the script
// stays plain .mjs because release.sh runs it from a checkout with no build
// step). Keep in step with the exports there.

export interface Drift {
  name: string;
  locked: string;
  installed: string | null;
}

export const MAX_LISTED: number;
export function readInstalledVersion(root: string, key: string): string | null;
export function findDrift(lock: unknown, readVersion: (key: string) => string | null): Drift[];
export function formatDrift(drift: readonly Drift[], max?: number): string;
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean;
