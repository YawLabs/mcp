// yaw-mcp's OWN secrets, and the two helpers that keep them out of every
// process this package spawns.
//
// Dependency-free on purpose. The strip is called at every spawn site in src/
// -- the broker's upstream spawn (upstream.ts, which pulls in the whole MCP
// SDK), both self-upgrade paths (auto-upgrade.ts, upgrade-cmd.ts), the sidecar
// npm run (sidecars-cmd.ts), the compliance suite (compliance-cmd.ts), the
// oam and uv probes (oam-spawn.ts, uv-bootstrap.ts) and the browser launcher
// (secret-entry-page.ts) -- and those have very different import budgets: the
// `yaw-mcp upgrade` CLI should not have to load the SDK to print a command.
// src/tests/internal-secret-env.test.ts scans for a spawn that forgets it.
// Until this module existed the helpers lived in upstream.ts and only the
// upstream spawn used them: the two upgrade spawns inherited process.env
// untouched, so a passphrase parked in yaw-mcp's env block -- exactly where
// README tells the user to put it -- reached every pre/postinstall script in
// @yawlabs/mcp's dependency tree through `npm install -g`. upstream.ts
// still re-exports the Set and both helpers for the importers that reach
// them through it (audit-cmd.ts and upstream's tests); every other consumer,
// server.ts included, imports from here.

/** Env keys that are for THIS process only and must never leak into a
 *  spawned child -- an upstream server, or the package manager the
 *  self-upgrade runs:
 *    YAW_MCP_TOKEN                -- RETIRED. It authenticated the hosted Yaw
 *      MCP backend, which is decommissioned; nothing in this process reads it
 *      any more. Kept in the strip list purely for hygiene: an operator whose
 *      shell still exports the old key must not have it forwarded into every
 *      spawned child.
 *    YAW_MCP_VAULT_PASSPHRASE     -- unlocks the local secret vault
 *    YAW_MCP_VAULT_PASSPHRASE_NEW -- the incoming passphrase during a rotate
 *      (secrets-cmd.ts), i.e. the LIVE passphrase once the rotate lands */
export const INTERNAL_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "YAW_MCP_TOKEN",
  "YAW_MCP_VAULT_PASSPHRASE",
  "YAW_MCP_VAULT_PASSPHRASE_NEW",
]);

/** Is `key` one of yaw-mcp's own secrets, in ANY letter case? The one
 *  membership test every consumer of INTERNAL_SECRET_ENV_KEYS should use: a
 *  bare `INTERNAL_SECRET_ENV_KEYS.has(key)` is byte-exact and misses the
 *  lowercase twin Windows env lookups honour -- see
 *  stripInternalSecretsFromEnv for why that leaks the passphrase. */
export function isInternalSecretEnvKey(key: string): boolean {
  return INTERNAL_SECRET_ENV_KEYS.has(key.toUpperCase());
}

/** Delete yaw-mcp's own secrets from THIS process's env, in place. For the
 *  one-shot CLI paths that hand `process.env` to a third party that spawns a
 *  server with it (`yaw-mcp audit` -> @yawlabs/mcp-compliance spreads
 *  process.env into the child): the broker's spawn path strips these via
 *  stripInternalSecretsFromEnv, and a CLI that requires the passphrase to be
 *  SET (audit resolving vault refs) must not then forward it to the audited
 *  server. Same case-insensitive match, for the same Windows reason. */
export function scrubInternalSecretsFromProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (isInternalSecretEnvKey(key)) delete process.env[key];
  }
}

/** `process.env` minus yaw-mcp's own secrets, for spawning any child: an
 *  upstream server, or the `npm install -g` / `pnpm add -g` / `bun add -g`
 *  behind the self-upgrade (whose lifecycle scripts run every dependency's
 *  pre/postinstall with whatever env they inherit).
 *
 *  Matched case-INSENSITIVELY, and that is load-bearing on Windows: env
 *  lookups there are case-insensitive, so `process.env.YAW_MCP_VAULT_PASSPHRASE`
 *  happily reads a `yaw_mcp_vault_passphrase=` set in PowerShell or Git Bash
 *  -- the vault unlocks fine -- while a byte-exact strip (the previous
 *  rest-destructure) would miss the lowercase key and hand the passphrase to
 *  every spawned child. POSIX env IS case-sensitive, but these names are
 *  yaw-internal enough that stripping a differently-cased twin there costs
 *  nothing and keeps one code path on every platform.
 *
 *  Exported for tests. */
export function stripInternalSecretsFromEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (isInternalSecretEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}
