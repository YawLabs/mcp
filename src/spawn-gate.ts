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
import { loadYawMcpConfig, type PolicyError, type Profile, profileAllows, toProfile } from "./config-loader.js";
import {
  displayIdentity,
  normalizeIdentityEntry,
  type ServerIdentity,
  serverIdentity,
  sharedIdentity,
} from "./server-identity.js";
import type { UpstreamServerConfig } from "./types.js";

/** Why a spawn was refused. One variant per gate, in the order they are
 *  checked -- the FIRST failing gate is reported, so a server that is both
 *  disabled and below the compliance floor is reported as disabled (the thing
 *  the user turned off deliberately). */
export type SpawnRefusal =
  | { kind: "disabled"; namespace: string }
  /** A policy file is broken, so no server may start. */
  | { kind: "policy-invalid"; namespace: string; errors: PolicyError[] }
  /** `profilePath` is the config file the allow/deny list came from, so the
   *  refusal can name the file to edit. Undefined only when a caller passes a
   *  profile with no path, which toProfile never produces. */
  | { kind: "profile"; namespace: string; profilePath: string | undefined; identity?: string }
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
 * `allServers` is the configured server list: a deny written against one
 * namespace extends to every server with the same launch identity, which only
 * the whole list can answer.
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
  allServers: readonly UpstreamServerConfig[] = [server],
): SpawnRefusal | null {
  if (!server.isActive) return { kind: "disabled", namespace: server.namespace };
  if (profile?.policyErrors?.length) {
    return { kind: "policy-invalid", namespace: server.namespace, errors: profile.policyErrors };
  }
  if (!profileAllows(effectiveProfile(profile, allServers), server.namespace)) {
    const identity = profile ? identityBlockOf(profile, allServers, server.namespace) : null;
    return {
      kind: "profile",
      namespace: server.namespace,
      profilePath: profile?.path,
      ...(identity ? { identity } : {}),
    };
  }
  if (minCompliance !== null && !passesMinCompliance(server.complianceGrade, minCompliance)) {
    return { kind: "compliance", namespace: server.namespace, grade: server.complianceGrade, min: minCompliance };
  }
  return null;
}

/**
 * Why a shell command that starts a configured server only to check it (`audit`,
 * the start check in `add` and `update`) may not, or null. These do not load a
 * server for use, so "disabled" and the compliance floor do not apply (auditing
 * is how a server gets a grade). The allow/deny policy does.
 */
export async function policyRefusalForCheck(
  server: UpstreamServerConfig,
  allServers: readonly UpstreamServerConfig[],
  opts: { cwd?: string; home?: string } = {},
): Promise<string | null> {
  const profile = toProfile(await loadYawMcpConfig(opts));
  const others = allServers.filter((s) => s.namespace !== server.namespace);
  const refusal = spawnGateVerdict({ ...server, isActive: true }, profile, null, [...others, server]);
  // The remedy differs per refusal kind, so the sentence does too. Pointing an
  // identity refusal at `servers` is actively wrong: listing the namespace
  // there does not lift a `blocked` entry naming its launch identity (see the
  // broker's wording in server.ts spawnGateRefusalText), and a broken policy
  // file has no `servers`/`blocked` edit to make -- only the file message.
  if (refusal?.kind === "policy-invalid") return policyErrorText(refusal.errors);
  if (refusal?.kind !== "profile") return null;
  const where = refusal.profilePath ?? "your yaw-mcp config";
  if (refusal.identity) {
    return `"${refusal.namespace}" is not allowed by the project profile at ${where} (it launches ${refusal.identity}, the same server as a "blocked" entry), so it was not started. Remove that blocked entry to allow it; listing it in \`servers\` does not.`;
  }
  return `"${refusal.namespace}" is not allowed by the project profile at ${where}, so it was not started. Change \`servers\` or \`blocked\` there to allow it.`;
}

/** The refusal text for broken policy files: each file, what is wrong with it
 *  and how to fix it. Shared because the fix is the same from either side. */
export function policyErrorText(errors: readonly PolicyError[]): string {
  return `yaw-mcp's policy config is broken, so no MCP server may start. ${errors.map((e) => e.message).join(" ")}`;
}

type IdentifiedServer = ServerIdentity & { namespace: string };

const identify = (servers: readonly UpstreamServerConfig[]): IdentifiedServer[] =>
  servers.map((server) => ({ namespace: server.namespace, ...serverIdentity(server) }));

/** Each namespace `blocked` reaches through a launch identity, and that identity. */
function identityBlocks(profile: Profile, identified: readonly IdentifiedServer[]): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const entry of profile.blocked ?? []) {
    const explicit = normalizeIdentityEntry(entry);
    if (explicit) {
      for (const s of identified) if (s.all.includes(explicit)) blocks.set(s.namespace, explicit);
      continue;
    }
    const source = identified.find((s) => s.namespace === entry);
    if (!source) continue;
    for (const s of identified) {
      const shared = s === source ? null : sharedIdentity(source, s);
      if (shared) blocks.set(s.namespace, shared);
    }
  }
  return blocks;
}

/**
 * The `blocked` entry that reaches a namespace through its launch identity, or
 * null when nothing does (the block is plain, or absent).
 *
 * Two callers need this separately from `effectiveProfile`: the check refusal
 * has to say WHICH entry to remove (removing a `blocked` namespace or editing
 * `servers` does not lift an identity deny), and `bundles match` has to print
 * the same remedy for a server its allow/deny filter excluded. Returns the
 * entry as a refusal may print it -- `displayIdentity` drops the arguments of
 * an exact-launch identity, which can hold a credential.
 */
export function identityBlockOf(
  profile: Profile,
  servers: readonly UpstreamServerConfig[],
  namespace: string,
): string | null {
  const matched = identityBlocks(profile, identify(servers)).get(namespace);
  if (!matched) return null;
  // Only when the RAW profile still allows the namespace: if `blocked` names it
  // directly too, the identity is not the reason and telling the user to remove
  // IT would leave the plain entry still refusing.
  if (!profileAllows(profile, namespace)) return null;
  return displayIdentity(matched);
}

/**
 * The profile the gates enforce: the configured lists plus what they imply for
 * the servers configured right now.
 *
 *   - a `blocked` namespace also blocks every server with its launch identity;
 *   - a `package:` / `command:` / `url:` entry blocks every server it matches;
 *   - a `<namespace>_<tool>` deny also covers that tool on those servers, and a
 *     wildcard covering a whole namespace (`ssh*`) covers all of theirs;
 *   - a `<identity>#<tool>` deny becomes `<namespace>_<tool>` for each match.
 *
 * Everything is expanded to plain namespaces and wire names, so the existing
 * predicates (isAllowed, isToolDenied) enforce it unchanged. Flattened names
 * are ambiguous when a namespace contains `_`; every reading is applied, which
 * denies more rather than less. Recompute whenever the server list changes.
 */
export function effectiveProfile(profile: Profile | null, servers: readonly UpstreamServerConfig[]): Profile | null {
  if (!profile || (!profile.blocked?.length && !profile.blockedTools?.length)) return profile;
  const identified = identify(servers);
  const blocked = new Set([...(profile.blocked ?? []), ...identityBlocks(profile, identified).keys()]);

  const blockedTools = new Set<string>();
  for (const entry of profile.blockedTools ?? []) {
    const hash = entry.lastIndexOf("#");
    const explicit = hash > 0 ? normalizeIdentityEntry(entry.slice(0, hash)) : null;
    if (explicit) {
      for (const s of identified) {
        if (s.all.includes(explicit)) blockedTools.add(`${s.namespace}_${entry.slice(hash + 1)}`);
      }
      continue;
    }
    blockedTools.add(entry);
    const prefix = entry.endsWith("*") ? entry.slice(0, -1) : "";
    for (const source of identified) {
      const head = `${source.namespace}_`;
      const tool = entry.startsWith(head) ? entry.slice(head.length) : prefix && head.startsWith(prefix) ? "*" : "";
      if (tool === "") continue;
      for (const s of identified) {
        if (sharedIdentity(source, s)) blockedTools.add(`${s.namespace}_${tool}`);
      }
    }
  }

  return {
    ...profile,
    ...(profile.blocked ? { blocked: [...blocked] } : {}),
    ...(profile.blockedTools ? { blockedTools: [...blockedTools] } : {}),
  };
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
 * `profile.blockedToolsPaths` lists the loaded files that declare the key (up
 * to three: config.local.json, the project config.json, user-global). One
 * file is named outright. `blockedTools` merges across scopes, so with more
 * than one we cannot say which carries THIS entry without re-reading them --
 * name them all rather than guess, since sending someone to the wrong file is
 * worse than sending them to several.
 *
 * A Profile built without that field (tests construct them by hand) falls
 * back to `path` / `userPath`, which cannot name a project config.json that
 * sits under a config.local.json.
 */
export function blockedToolsSource(profile: Profile | null): string {
  if (!profile) return "your yaw-mcp config";
  const files = profile.blockedToolsPaths;
  if (files && files.length === 1) return files[0];
  if (files && files.length > 1) {
    return `whichever of ${files.join(" / ")} declares it (blockedTools merges across scopes)`;
  }
  return profile.userPath
    ? `whichever of ${profile.path} / ${profile.userPath} declares it (blockedTools merges across scopes)`
    : profile.path;
}
