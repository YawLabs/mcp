// Types for verify-clients.mjs, so src/tests/verify-clients.test.ts can import
// it under `tsc --noEmit` (tsconfig has no allowJs, and the script stays plain
// .mjs because it runs from a checkout with no build step). Keep in step with
// the exports there.

export const REPO_ROOT: string;
export const TAG: string;
export const ALIASES: ReadonlySet<string>;
export const SHARED_FILE_LANE: ReadonlySet<string>;

export function parseClientIds(usage: string): string[];
export function parseWrotePaths(out: string): string[];
export function findEntry(root: unknown, scope: string, projectDir: string): Record<string, unknown> | null;
export function parseConfig(path: string, text: string): unknown;
export function lanes(ids: readonly string[]): string[][];
export function sandboxEnv(home: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function startRegistry(
  tarball: string,
  manifest: Record<string, unknown>,
  version: string,
): Promise<{ base: string; hits: { packument: number; tarball: number }; close: () => void }>;
