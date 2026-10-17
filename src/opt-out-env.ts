// The ONE parser for a `YAW_MCP_*` opt-out variable.
//
// Every on-by-default feature with a `YAW_MCP_*` off switch reads it here --
// at the time of writing YAW_MCP_AUTO_UPGRADE (auto-upgrade.ts),
// YAW_MCP_SIDECAR_REFRESH (sidecar-refresh.ts), YAW_MCP_AUTO_HEAL
// (heal-entries.ts), YAW_MCP_PREWARM, YAW_MCP_CONFIG_RELOAD and
// YAW_MCP_AUTO_ACTIVATE (server.ts), and YAW_MCP_PRUNE_RESPONSES (prune.ts).
// The first five used to spell their own parse, and every copy carried a comment promising to match the others.
// They did not. Three shapes had grown:
//
//   - `=== "0"` only, untrimmed (AUTO_HEAL): `false` was not an opt-out there,
//     while its own comment said it took the same spellings as its siblings.
//   - `"0"` or case-insensitive `"false"`, UNTRIMMED (AUTO_UPGRADE,
//     CONFIG_RELOAD, SIDECAR_REFRESH).
//   - the same two spellings, TRIMMED (PREWARM, the deleted AUTO_PREWARM).
//
// The trim is the one that bites, and on Yaw's primary platform: cmd.exe's
// `set VAR=0 && yaw-mcp serve` keeps the space before `&&`, so the value
// arrives as "0 " with a trailing space. An untrimmed check reads that as
// "not an opt-out" and the feature runs -- silently, because the variable
// reads as set everywhere the user can look. A user who turned off the
// auto-heal the documented way was still healed.
//
// One helper, so "=0 or =false turns it off, whitespace ignored" is one fact
// about the product rather than one promise per feature. Leaf module on
// purpose: it imports nothing, so every caller above can reach it without a
// cycle. The opt-IN polarity (isFeatureEnabled) and the strict integer parse
// for numeric bounds (resolveNonNegativeIntEnv) live here for the same reason.

/**
 * Is the opt-out variable `name` set to an off spelling? `0` and `false` (any
 * case, surrounding whitespace stripped) disable; EVERYTHING else -- unset, the
 * empty string, `1`, `true`, `no`, `off`, and near-misses like `00` or `0abc`
 * -- leaves the feature on. Near-misses stay on by design: an opt-out that
 * engaged on anything vaguely zero-ish would turn a typo into an invisible
 * loss of the feature, which is the wrong direction to fail in.
 *
 * `env` defaults to `process.env` for the readers that have no injected
 * environment (server.ts, auto-upgrade.ts); doctor threads its own, which is
 * why the parameter exists.
 */
export function isFeatureDisabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name];
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  return trimmed === "0" || trimmed.toLowerCase() === "false";
}

/**
 * The opt-IN counterpart: is `name` set to an on spelling? `1` and `true` (any
 * case, surrounding whitespace stripped) enable; EVERYTHING else -- unset,
 * empty, `yes`, `on`, `0`, a near-miss like `11` -- leaves the feature off.
 * A typo fails CLOSED, the right direction for an opt-in. Trimmed for the
 * same cmd.exe reason as isFeatureDisabled: `set VAR=1 && ...` delivers "1 ".
 *
 * The one parser behind every `YAW_MCP_*` switch that is off unless set:
 * YAW_MCP_FOUNDRY (foundry.ts), YAW_MCP_REWARD_GRADER (reward-grader.ts),
 * YAW_MCP_AUTO_LOAD (server.ts), YAW_MCP_TRUST_PROJECT (trust.ts),
 * YAW_MCP_DISABLE_PERSISTENCE (persistence.ts), YAW_MCP_READONLY_DIAGNOSTICS
 * (config-loader.ts), YAW_MCP_INSTALL_NUDGE (install-nudge.ts), YAW_MCP_STDIO
 * (serve-gate.ts) and YAW_MCP_ALLOW_UNOWNED_PROJECT_DIRS (paths.ts) -- so the
 * next flag cannot quietly accept `yes` in one place only.
 */
export function isFeatureEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name];
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  return trimmed === "1" || trimmed.toLowerCase() === "true";
}

/**
 * Strict non-negative integer env parse: trimmed, then a bare digit run, else
 * `defaultValue`. Number.parseInt alone is not safe here: its PREFIX parsing
 * turns "0x1000", "100_000" and "0abc" into 0 and "1e2" into 1, and for the
 * ceilings that read this 0 is the DISABLE sentinel, so a typo would silently
 * remove a bound instead of falling back to it. Unset and empty also fall
 * back. `min` rejects a parsed value below it (to the default), for a reader
 * whose 0 would mean something harmful rather than "off".
 */
export function resolveNonNegativeIntEnv(
  name: string,
  defaultValue: number,
  env: NodeJS.ProcessEnv = process.env,
  min = 0,
): number {
  const raw = env[name];
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return defaultValue;
  const n = Number.parseInt(trimmed, 10);
  // A run of 309+ digits parses to Infinity; no bound wants that.
  if (!Number.isFinite(n) || n < min) return defaultValue;
  return n;
}

/**
 * Is a test harness driving this process? True whenever `VITEST` is set to
 * anything non-empty -- vitest exports it as `"true"` into every worker, and
 * a downstream suite that spawns `yaw-mcp` as a child INHERITS it.
 *
 * The ONE reader of that variable. It used to be spelled ten times across
 * auto-upgrade, upgrade-cmd and sidecar-refresh, each copy gating a different
 * default (a lock, a memo, a probe), and the set of gated defaults was not
 * closed: under an inherited VITEST the memos and the lock were no-ops while
 * the registry fetch was not, so a stale global copy spawned under some other
 * package's test run performed a real, UNSERIALIZED `npm install -g`. One
 * predicate makes "the background features are off under a test harness" one
 * fact, and gives every default the same seam: a test that wants the real
 * path injects an impl; one that forgets gets a deterministic no-op.
 *
 * Only the DEFAULT impls consult it. An injected hook (`fetchLatestImpl`,
 * `spawnImpl`, `acquireLock`, ...) always runs, which is how the unit tests
 * reach the real code paths from inside the harness.
 */
export function isTestSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VITEST;
  return raw !== undefined && raw !== "";
}
