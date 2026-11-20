// Types for verify-vault-v3-compat.mjs, so src/tests/verify-vault-compat.test.ts
// can import it under `tsc --noEmit` (tsconfig has no allowJs, and the script
// stays plain .mjs because `npm run verify:vault-compat` runs it from a
// checkout with no build step). Keep in step with the exports there.

/** What runCli hands the verdict: status, both streams, and the spawn error. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: { message: string } | undefined;
}

/** The line main prints: `ok` selects OK vs FAIL, `message` is its body. */
export interface V3Verdict {
  ok: boolean;
  message: string;
}

export interface Target {
  version: string;
  expected: (path: string) => string;
}

export const WRONG_PASSPHRASE: string;
export const gateMessage: (path: string, ownMax: number) => string;
export const TARGETS: readonly Target[];

/** Pure verdict over one probed build's v3 run; `read` re-reads the vault file
 *  AFTER the run and may throw (the unreadable-after-run failure path). */
export function evaluateV3Run(args: {
  version: string;
  expected: (path: string) => string;
  vault: string;
  run: RunResult;
  before: string;
  read: () => Buffer | string;
  value?: string;
}): V3Verdict;
