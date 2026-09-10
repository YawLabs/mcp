// The policy every path that SPAWNS a configured server has to clear, as a
// decision rather than as a sentence.
//
// WHY IT IS ITS OWN MODULE. The gate used to be a private method on
// ConnectServer, which was fine while the only two callers were also inside
// ConnectServer (persistent activate, transient read_tool). `yaw-mcp call`
// spawns a configured server from a SHELL, with no broker in the process at
// all -- and a shell entry point that skipped the deny list would be a hole
// straight through the policy, reachable from any git hook or script the user
// already trusts. It cannot import server.ts to get the gate: that module
// pulls in the MCP server SDK, the learning store, the reward grader and the
// whole broker, none of which a one-shot CLI call should pay for.
//
// WHY THE VERDICT IS DATA AND NOT TEXT. The DECISION is what must not drift
// between callers; the REMEDIATION legitimately differs. Inside the broker the
// fix for a disabled server is an edit picked up "on the next mcp_connect_*
// call"; from a shell it is `yaw-mcp enable <ns>`, and there is no
// mcp_connect_* call to wait for. So this module answers WHY a spawn is
// refused and each caller writes the sentence its own reader can act on. A
// shared sentence would have had to name both worlds, which is how a refusal
// stops being actionable in either.

import { type ComplianceGrade, classifyGrade, parseMinCompliance, passesMinCompliance } from "./compliance.js";
import { type Profile, profileAllows } from "./config-loader.js";
import type { UpstreamServerConfig } from "./types.js";

/** Why a spawn was refused. One variant per gate, in the order they are
 *  checked -- the FIRST failing gate is reported, so a server that is both
 *  disabled and below the compliance floor is reported as disabled (the thing
 *  the user turned off deliberately). */
export type SpawnRefusal =
  | { kind: "disabled"; namespace: string }
  /** `profilePath` is the config file the allow/deny list came from, so the
   *  refusal can name the file to edit. Undefined only when a caller passes a
   *  profile with no path, which toProfile never produces. */
  | { kind: "profile"; namespace: string; profilePath: string | undefined }
  /** `grade` is the server's grade AS STORED -- possibly an unrecognized
   *  string, which is a different refusal from "graded below the floor" and
   *  has to be reported as such (see complianceRefusalReason). */
  | { kind: "compliance"; namespace: string; grade: string | undefined; min: ComplianceGrade };

/**
 * Current minimum compliance filter, parsed from YAW_MCP_MIN_COMPLIANCE.
 * Re-read on every call so a mid-session change lands on the next spawn (and
 * so tests can stub the env between cases). Null means "filter disabled" --
 * every server passes regardless of grade. An invalid value logs a one-shot
 * warning (see parseMinCompliance) and falls back to disabled, so a typo never
 * hides the user's whole catalog.
 */
export function resolveMinCompliance(env: NodeJS.ProcessEnv = process.env): ComplianceGrade | null {
  return parseMinCompliance(env.YAW_MCP_MIN_COMPLIANCE);
}

/**
 * The policy gates every SPAWN path shares, in one place and one order:
 * disabled, then project profile, then the YAW_MCP_MIN_COMPLIANCE floor.
 * Returns the refusal, or null when the server clears all three.
 *
 * Every caller here actually EXECUTES the server's configured command with its
 * resolved env (vault secrets included), so "we disconnect afterwards" buys a
 * transient connect no exemption -- and neither does "this is only one tool
 * call from a shell".
 */
export function spawnGateVerdict(
  server: UpstreamServerConfig,
  profile: Profile | null,
  minCompliance: ComplianceGrade | null,
): SpawnRefusal | null {
  if (!server.isActive) return { kind: "disabled", namespace: server.namespace };
  if (!profileAllows(profile, server.namespace)) {
    return { kind: "profile", namespace: server.namespace, profilePath: profile?.path };
  }
  if (minCompliance !== null && !passesMinCompliance(server.complianceGrade, minCompliance)) {
    return { kind: "compliance", namespace: server.namespace, grade: server.complianceGrade, min: minCompliance };
  }
  return null;
}

/**
 * Human-readable reason a server is refused under a compliance floor.
 * passesMinCompliance returns a single boolean for both "unrecognized grade"
 * and "recognized grade below the minimum", so a naive message would call an
 * unrecognized "Pass" grade "below B". classifyGrade splits the two so the
 * refusal names the real problem. Ungraded servers never reach here (they pass
 * the floor).
 *
 * Shared by both renderings of a `compliance` refusal -- this half IS the same
 * sentence in the broker and in the shell, because it describes the grade
 * rather than what to do about it.
 */
export function complianceRefusalReason(grade: string | undefined | null, min: ComplianceGrade): string {
  const c = classifyGrade(grade);
  if (c.kind === "unrecognized") {
    return `unrecognized compliance grade "${c.raw}" (not A-F); failing closed under YAW_MCP_MIN_COMPLIANCE=${min}`;
  }
  return `compliance grade ${grade ?? "unknown"} is below YAW_MCP_MIN_COMPLIANCE=${min}`;
}

/**
 * Is this flattened wire tool name denied by a resolved `blockedTools` list?
 *
 * Matched literally and case-sensitively against `<namespace>_<tool>` -- the
 * exact string tools/list advertises, buildToolRoutes keys on, the client
 * sends, an exec step names, and `yaw-mcp call` builds from its two arguments.
 * A single trailing `*` is a prefix match.
 *
 * Namespace flattening means (ns `gh`, tool `actions_list`) and (ns
 * `gh_actions`, tool `list`) both render `gh_actions_list`, so a deny on that
 * string covers whichever upstream won the route collision. That is the safe
 * direction and is deliberately not disambiguated: a deny matching more than
 * the user pictured fails closed, one matching less fails open.
 */
export function isToolDenied(wireName: string, blockedTools: readonly string[] | undefined): boolean {
  if (!blockedTools || blockedTools.length === 0) return false;
  for (const entry of blockedTools) {
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      // A bare `*` is inert here as well as refused at load. Defence in depth
      // on a claim three surfaces make -- the README, the JSON schema and the
      // loader warning all promise a bare wildcard cannot match -- and an
      // empty prefix would otherwise deny EVERY tool, which is the one wrong
      // answer that fails closed hard enough to look broken.
      if (prefix !== "" && wireName.startsWith(prefix)) return true;
    } else if (wireName === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Which file the user has to edit to lift a `blockedTools` deny.
 *
 * `blockedTools` merges across scopes, so when both a project and a
 * user-global config contributed we cannot say which one carries THIS entry
 * without re-reading them -- name both rather than guess, since sending
 * someone to the wrong file is worse than sending them to two.
 */
export function blockedToolsSource(profile: Profile | null): string {
  if (!profile) return "your yaw-mcp config";
  return profile.userPath
    ? `whichever of ${profile.path} / ${profile.userPath} declares it (blockedTools merges across scopes)`
    : profile.path;
}
