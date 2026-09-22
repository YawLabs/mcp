// The ONE parser for a `YAW_MCP_*` opt-out variable.
//
// Five background features ship ON by default and each takes an env var that
// turns it off: YAW_MCP_AUTO_UPGRADE (auto-upgrade.ts), YAW_MCP_SIDECAR_REFRESH
// (sidecar-refresh.ts), YAW_MCP_AUTO_HEAL (heal-entries.ts), YAW_MCP_PREWARM
// and YAW_MCP_CONFIG_RELOAD (server.ts). Every one of them used to spell its
// own parse, and every copy carried a comment promising to match the others.
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
// about the product rather than five promises. Leaf module on purpose: it
// imports nothing, so server.ts, the two fire-and-forget siblings and the
// heal pass can all reach it without a cycle.

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
