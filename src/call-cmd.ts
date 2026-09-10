// `yaw-mcp call <namespace> <tool> [args-json]` -- call ONE tool on ONE
// configured server and print the result.
//
// WHY IT EXISTS. Everything a user configures in bundles.json is reachable
// only by something that speaks MCP: an AI client, or the broker on its
// behalf. A git hook, a Makefile, a cron job, a shell function, an agent loop
// that is not MCP-shaped -- none of those can reach a single one of those
// servers, so the servers get configured twice (once for the model, once by
// hand for the script) or the script re-implements the API. This is the door
// for those callers: same bundles.json, same vault, same policy, one call, no
// protocol.
//
// WHAT IT IS NOT. It is not a session and it is not a shell. Nothing is loaded
// or kept: the upstream is connected, asked one question, and torn down (see
// transient-upstream.ts). Two `yaw-mcp call`s are two spawns -- for a batch,
// the broker's `mcp_connect_exec` pipeline is the right tool, and for
// something long-running an MCP client is.
//
// POLICY IS NOT OPTIONAL HERE. This entry point spawns a configured server's
// command with its resolved env, exactly as an activation does, so it clears
// the SAME gates: the server has to be enabled, allowed by the project profile
// and at or above YAW_MCP_MIN_COMPLIANCE, and the tool must not be on the
// `blockedTools` deny list. Skipping any of them would make every deny in the
// user's config a suggestion -- the model would be refused and a two-word
// shell command would not. The decision lives in spawn-gate.ts precisely so
// the broker and this command cannot drift apart on it.
//
// The grade that floor is measured against has TWO suppliers, and both have to
// be read here: bundles.json carries whatever the catalog claimed at add time,
// and ~/.yaw-mcp/grades.json carries the letter `yaw-mcp audit` MEASURED on
// this machine, which supersedes it. Gating on the un-overlaid server list is
// not a partial answer but an inert one -- to the gate an audited server is
// ungraded, and ungraded passes every floor. `yaw-mcp list`, `status` and the
// broker all apply the same overlay with the same precedence.
//
// STDOUT IS THE RESULT, VERBATIM. The tool's text content is written with no
// banner, no prefix and no escaping, because the caller is a script that will
// pipe it somewhere. That means a third-party server's bytes reach the
// terminal unfiltered, the same as `curl` -- diagnostics, which yaw-mcp writes
// itself, go to stderr and DO get their control bytes neutered (upstream tool
// names and upstream error text included: see every displaySafe below).
// Anything the caller needs to branch on is in the exit code, never in the
// text.
//
// A CONSUMER THAT LEAVES EARLY IS NORMAL. `yaw-mcp call ... | head -1` closes
// stdout mid-answer. The remaining output is dropped and the exit code stands:
// a reader walking away says nothing about whether the tool answered. What
// must NOT happen is the process dying on the unhandled EPIPE, which skips
// the teardown in transient-upstream.ts and orphans the spawned child -- see
// createStreamWriter (logger.ts).
//
// Exit codes:
//   0  the tool ran and returned a result
//   1  the call did not produce one -- unknown server or tool, the connect
//      failed, the transport errored -- or the tool answered with isError
//   2  usage error, or a policy gate refused before anything was spawned

import { homedir } from "node:os";
import { loadYawMcpConfig, toProfile } from "./config-loader.js";
import { closestNames } from "./fuzzy.js";
import { type GradesCache, readGradesCache } from "./grades-cache.js";
import { loadLocalBundles } from "./local-bundles.js";
import { createStreamWriter } from "./logger.js";
import { findTool, formatToolNotFound, normalizeToolName } from "./read-tool.js";
import {
  blockedToolsSource,
  complianceRefusalReason,
  isToolDenied,
  resolveMinCompliance,
  spawnGateVerdict,
} from "./spawn-gate.js";
import { TransientConnectError, withTransientUpstream } from "./transient-upstream.js";
import { displaySafe } from "./trust-cmd.js";
import type { UpstreamConnection, UpstreamServerConfig } from "./types.js";
import { resolveTimeoutEnv } from "./upstream.js";

export const CALL_USAGE = `Usage: yaw-mcp call <namespace> <tool> [<json>] [flags]

  Call ONE tool on ONE server from your bundles.json and print the result, so a
  shell script, a git hook or a non-MCP agent loop can reach your configured
  servers (and the values in your vault) without speaking MCP.

  <namespace>  A server as shown by \`yaw-mcp list\`.
  <tool>       A tool on that server, bare ("search") or namespaced
               ("gh_search"). \`yaw-mcp call <namespace> <tool>\` with a tool
               that does not exist lists the ones that do.
  <json>       The tool's arguments, as a JSON OBJECT. Defaults to {}.

  The server is spawned for this one call and torn down again -- nothing is
  loaded, and two calls are two spawns. The result goes to stdout verbatim, so
  it can be piped; everything else goes to stderr.

Flags:
  --args <json>    The arguments object, as the flag form of the positional.
  --args-stdin     Read the arguments object from stdin instead. Use this
                   rather than fighting your shell's quoting.
  --json           Print the raw MCP result envelope instead of its text
                   content -- structuredContent, isError and non-text blocks
                   included.

Exit codes:
  0  the tool ran and returned a result
  1  it could not be called (unknown server or tool, connect or transport
     failure), or it answered with an error
  2  a usage error, or your config refuses this call

  The same policy a proxied call gets applies here: a disabled server, one your
  project profile blocks, one below YAW_MCP_MIN_COMPLIANCE, and any tool on the
  \`blockedTools\` deny list are all refused -- before the server is spawned.`;

/** Bound on the single tools/call this command makes, under the same operator
 *  knob the proxy's calls use (MCP_CALL_TIMEOUT, default the SDK's 60s). Read
 *  through the shared resolver so a bad value falls back with one warn rather
 *  than becoming a 3ms or a 24-day ceiling. A shell caller that needs longer
 *  raises the same env var it would raise for the broker -- one knob, not a
 *  second one that only this door reads. */
const CALL_TIMEOUT = resolveTimeoutEnv("MCP_CALL_TIMEOUT", 60_000);

/** The connect-run-teardown seam. Defaults to the real transient helper;
 *  tests inject a fake so the suite never spawns a child. Typed as the helper's
 *  own signature so an injected one cannot skip the teardown contract. */
export type ConnectSeam = <T>(
  config: UpstreamServerConfig,
  use: (connection: UpstreamConnection) => Promise<T>,
) => Promise<T>;

export interface CallCommandOptions {
  namespace?: string;
  tool?: string;
  /** Raw JSON text for the tool's arguments. */
  argsJson?: string;
  /** Read the arguments JSON from `stdin` instead of `argsJson`. */
  argsStdin?: boolean;
  json?: boolean;
  home?: string;
  cwd?: string;
  /** Environment the command runs under. Threaded rather than defaulted inside
   *  the readers: the compliance floor and the project-trust gate both read it,
   *  and an embedded or test caller that injects an env expects THAT env to
   *  decide, not the real process's. */
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test seam: replaces process.stdin for --args-stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Test seam: replaces the transient connect. */
  connect?: ConnectSeam;
}

export interface CallCommandResult {
  exitCode: number;
}

export function parseCallArgs(
  argv: string[],
): { ok: true; options: CallCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: CallCommandOptions = {};
  const positional: string[] = [];
  let flagArgs: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { ok: false, error: CALL_USAGE, help: true };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (a === "--args-stdin") {
      opts.argsStdin = true;
      continue;
    }
    if (a === "--args") {
      const value = argv[i + 1];
      // A missing value, or one that reads as the next flag. Both mean the
      // user's arguments were never passed, and swallowing a flag as the
      // payload would send `--json` to the upstream as an argument string.
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: `yaw-mcp call: --args needs a JSON object.\n${CALL_USAGE}` };
      }
      flagArgs = value;
      i++;
      continue;
    }
    if (a.startsWith("-")) return { ok: false, error: `yaw-mcp call: unknown flag "${a}"\n${CALL_USAGE}` };
    positional.push(a);
  }
  if (positional.length === 0) return { ok: false, error: CALL_USAGE };
  if (positional.length === 1) {
    return { ok: false, error: `yaw-mcp call: missing <tool>.\n${CALL_USAGE}` };
  }
  if (positional.length > 3) {
    return {
      ok: false,
      error: `yaw-mcp call: too many arguments -- the JSON object must be ONE argument, so quote it.\n${CALL_USAGE}`,
    };
  }
  opts.namespace = positional[0];
  opts.tool = positional[1];
  const inlineArgs = positional[2];
  // Two spellings of one argument, and no reading of "which wins" is obviously
  // right -- so neither is chosen. Silently preferring one is how a script
  // sends arguments its author cannot see in the command line.
  if (inlineArgs !== undefined && flagArgs !== undefined) {
    return {
      ok: false,
      error: `yaw-mcp call: pass the arguments either as the positional JSON or as --args, not both.\n${CALL_USAGE}`,
    };
  }
  // Same reasoning for --args-stdin: it is a THIRD spelling of the same thing.
  if (opts.argsStdin && (inlineArgs !== undefined || flagArgs !== undefined)) {
    return {
      ok: false,
      error: `yaw-mcp call: --args-stdin reads the arguments from stdin, so do not also pass them on the command line.\n${CALL_USAGE}`,
    };
  }
  const args = inlineArgs ?? flagArgs;
  if (args !== undefined) opts.argsJson = args;
  return { ok: true, options: opts };
}

/** Read all of `stream` as UTF-8. Used only for --args-stdin, where the whole
 *  payload has to be in hand before the call is built. */
async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse the caller's arguments text into the object MCP's `arguments` field
 *  takes. An array, a string, a number and null all parse as valid JSON and
 *  are all wrong here: handed to the upstream they come back as a schema error
 *  that names neither the flag the user typed nor the shape it wanted. */
function parseArgumentsObject(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `yaw-mcp call: the arguments are not valid JSON (${(e as Error).message}).` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `yaw-mcp call: the arguments must be a JSON object like {"query":"..."}, not ${describeJson(parsed)}.`,
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** English for the shape of a parsed JSON value, for the message above. `typeof`
 *  alone calls both null and an array "object", which are two of the three
 *  shapes a caller actually gets wrong. */
function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** Render one MCP content block for a terminal. Text blocks are their text,
 *  verbatim. Everything else -- image, audio, resource_link, embedded resource
 *  -- carries no text at all, and printing nothing for one would make an answer
 *  that DID arrive look like an empty one, so it is NAMED and the reader is
 *  pointed at the flag that shows the whole envelope. */
function renderContentBlock(block: { type?: unknown; text?: unknown }): string {
  if (typeof block.text === "string") return block.text;
  const type = typeof block.type === "string" ? block.type : "unknown";
  return `[${displaySafe(type)} content -- re-run with --json to see it]`;
}

export async function runCall(opts: CallCommandOptions): Promise<CallCommandResult> {
  // Guarded writers, not bare `stream.write`. A script consuming this command
  // is entitled to stop reading -- `yaw-mcp call ... | head -1` is the shape
  // the whole command exists for -- and the next write then emits EPIPE on
  // stdout. Unhandled, that is Node taking the process down mid-await, which
  // SKIPS transient-upstream's teardown and orphans the spawned child (and
  // exits 1, the code documented below for "the tool answered with an
  // error"). createStreamWriter drops the rest of the output instead, so the
  // teardown runs and the exit code stays the one this command computed. See
  // logger.ts for why a try/catch alone does not cover it.
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const namespace = opts.namespace ?? "";
  const toolArg = opts.tool ?? "";
  if (!namespace || !toolArg) {
    // Unreachable from the CLI (parseCallArgs requires both), so this only
    // catches a programmatic caller. Exit 2 matches the parse layer.
    printErr(`yaw-mcp call: <namespace> and <tool> are both required.\n${CALL_USAGE}`);
    return { exitCode: 2 };
  }

  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  // ARGUMENTS FIRST, before the config is even read: a malformed JSON object
  // is the user's own typo, and finding out about it after a spawn wastes the
  // spawn and buries the message under whatever the server printed on stderr.
  let argsText = opts.argsJson ?? "";
  if (opts.argsStdin) {
    try {
      argsText = await readAll(opts.stdin ?? process.stdin);
    } catch (e) {
      printErr(`yaw-mcp call: could not read the arguments from stdin (${(e as Error).message}).`);
      return { exitCode: 2 };
    }
  }
  const parsedArgs = parseArgumentsObject(argsText);
  if (!parsedArgs.ok) {
    printErr(parsedArgs.error);
    return { exitCode: 2 };
  }

  const loaded = await loadLocalBundles({ home, cwd, env });
  // Same posture as `list` and `audit`: a malformed entry the loader skipped
  // would otherwise be reported below as a missing namespace, with nothing
  // saying why. stderr keeps stdout consumable.
  for (const w of loaded.warnings) printErr(`warning: ${w}`);
  const servers = loaded.config?.servers ?? [];
  const server = servers.find((s) => s.namespace === namespace);
  if (!server) {
    const suggestions = closestNames(
      namespace,
      servers.map((s) => s.namespace),
      3,
    );
    const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
    printErr(
      `yaw-mcp call: no server named "${displaySafe(namespace)}" in your bundles.json.${hint} Run \`yaw-mcp list\` to see what is configured.`,
    );
    return { exitCode: 1 };
  }

  // Two independent reads, issued together: neither needs the other's result.
  //
  // The allow/deny lists and the per-tool denies come from the same resolver
  // the broker uses (config.json at local > project > global). Read even when
  // no config file exists -- toProfile answers null then, and every gate below
  // treats null as "no policy configured".
  //
  // The grade cache is what `yaw-mcp audit` WRITES, and it is the only
  // supplier of a LOCALLY MEASURED compliance letter -- bundles.json can only
  // carry what the catalog claimed at add time. Without this overlay the floor
  // gate below never saw an audited grade at all, so `list` printed GRADE F
  // for a server this command then happily spawned. readGradesCache never
  // throws (a missing or garbled cache is {}); the catch is the belt to that
  // braces, and it must degrade to "use the config letter", never to
  // "ungraded" -- ungraded passes every floor.
  const [profile, grades] = await Promise.all([
    loadYawMcpConfig({ cwd, home, env }).then(toProfile),
    readGradesCache(home).catch(() => ({}) as GradesCache),
  ]);

  // Cache HIT REPLACES the config letter, the same precedence the two existing
  // readers document (local-add-cmd.ts runList and server.ts
  // hydrateComplianceGrades): the cached one was measured against the bytes on
  // this machine, the config one is a catalog claim about a version that may
  // since have moved. A miss leaves the config value standing rather than
  // blanking it. Object.hasOwn, not a bare index: NAMESPACE_RE admits
  // `constructor` and `tostring`, and an inherited Object.prototype member
  // read as a hit would hand the gate a grade of `undefined` -- which passes.
  const cached = Object.hasOwn(grades, server.namespace) ? grades[server.namespace] : undefined;
  const graded = cached ? { ...server, complianceGrade: cached.grade } : server;

  const refusal = spawnGateVerdict(graded, profile, resolveMinCompliance(env));
  if (refusal) {
    // The CLI's rendering of the shared verdict. The remediation is what
    // differs from the broker's wording: there is no mcp_connect_* call to
    // wait for out here, so the fix is named as the command that makes it.
    switch (refusal.kind) {
      case "disabled":
        printErr(
          `yaw-mcp call: "${refusal.namespace}" is configured but disabled, so it was not started. Run \`yaw-mcp enable ${refusal.namespace}\` to turn it back on.`,
        );
        break;
      case "profile":
        printErr(
          `yaw-mcp call: "${refusal.namespace}" is not allowed by the project profile at ${displaySafe(refusal.profilePath ?? "your yaw-mcp config")}, so it was not started.`,
        );
        break;
      case "compliance":
        // displaySafe around the whole reason, not around the grade: the
        // grade is embedded by complianceRefusalReason (spawn-gate.ts) and
        // bundles.json's `complianceGrade` is only trimmed and upper-cased at
        // load, never checked against A-F -- so an unrecognized one is echoed
        // back verbatim. Quoting the sentence is the only lever this caller
        // has, and it fires only when a control byte is actually present.
        printErr(
          `yaw-mcp call: refusing to start "${refusal.namespace}": ${displaySafe(
            complianceRefusalReason(refusal.grade, refusal.min),
          )}. Unset YAW_MCP_MIN_COMPLIANCE (or lower it) to override.`,
        );
        break;
    }
    return { exitCode: 2 };
  }

  // The deny list, checked BEFORE the spawn. The wire name is
  // `<namespace>_<tool>` and both halves are arguments, so nothing has to run
  // for this answer -- and a denied tool must not cost a spawn.
  //
  // The tool name is normalized WITHOUT the server's tool list here, which the
  // connect has not fetched yet: with no list to exact-match against,
  // normalizeToolName strips a leading `<namespace>_`, so `gh_search` and
  // `search` both resolve to the same wire name and a deny cannot be stepped
  // around by retyping the argument. The post-connect check below is the one
  // that runs against the REAL list, and covers the case this one gets wrong
  // (a server whose own tool is genuinely called `gh_search`).
  const preSpawnWire = `${namespace}_${normalizeToolName(namespace, toolArg)}`;
  if (isToolDenied(preSpawnWire, profile?.blockedTools)) {
    printErr(
      `yaw-mcp call: tool "${displaySafe(preSpawnWire)}" is blocked by the "blockedTools" list in ${displaySafe(
        blockedToolsSource(profile),
      )}. Nothing was started.`,
    );
    return { exitCode: 2 };
  }

  const connect: ConnectSeam = opts.connect ?? ((config, use) => withTransientUpstream(config, use));

  // `graded`, not `server`: the config that CLEARED the gate is the config
  // that gets spawned. They differ only in the compliance letter, but handing
  // the spawn the un-overlaid object is how a later reader picks up the one
  // the gate deliberately did not use.
  try {
    return await connect(graded, async (connection) => {
      // Re-normalize against the REAL tool list so an exact match beats
      // prefix-stripping: a server can expose a tool whose own name starts
      // with the namespace (`gh` + `gh_status`), and blindly stripping would
      // call a `status` that does not exist.
      const toolName = normalizeToolName(namespace, toolArg, connection.tools);
      const tool = findTool(connection.tools, toolName);
      if (!tool) {
        // displaySafe: every tool name in this sentence came off the UPSTREAM's
        // own tools/list, so without it a third-party server picks the bytes
        // that reach the terminal -- an erase-line escape in a tool name
        // rewrites the diagnostic yaw-mcp had just drawn. The header two
        // screens up promises the opposite for everything on stderr.
        printErr(`yaw-mcp call: ${displaySafe(formatToolNotFound(graded, toolName, connection.tools))}`);
        return { exitCode: 1 };
      }
      // The deny, again, against the name that was actually resolved. The
      // pre-spawn check above cannot see the tool list, so this is the one
      // that is authoritative -- and it is why an exact-match tool whose name
      // embeds the namespace is still covered.
      if (isToolDenied(tool.namespacedName, profile?.blockedTools)) {
        // Upstream-sourced too: `namespacedName` is `<namespace>_<the name the
        // server advertised>`, and a wildcard deny matches one carrying
        // control bytes even though a literal entry could not (TOOL_ENTRY_RE
        // in config-loader.ts refuses those).
        printErr(
          `yaw-mcp call: tool "${displaySafe(tool.namespacedName)}" is blocked by the "blockedTools" list in ${displaySafe(
            blockedToolsSource(profile),
          )}.`,
        );
        return { exitCode: 2 };
      }

      let result: { content?: unknown; isError?: unknown };
      try {
        result = (await connection.client.callTool(
          { name: tool.name, arguments: parsedArgs.value },
          // Second slot is the RESULT SCHEMA, not the options: passing options
          // there would silently replace CallToolResultSchema and take the
          // SDK's structured-output validation with it. Same shape as the
          // proxy's own call (proxy.ts routeToolCall).
          undefined,
          { timeout: CALL_TIMEOUT },
        )) as { content?: unknown; isError?: unknown };
      } catch (e) {
        // A transport-level failure: a timeout, a JSON-RPC error, a child that
        // died mid-call. Distinct from an `isError` RESULT, which is the
        // server answering.
        // Both halves are the upstream's: the name it advertised, and the
        // JSON-RPC error text it chose.
        printErr(`yaw-mcp call: ${displaySafe(tool.namespacedName)} failed: ${displaySafe((e as Error).message)}`);
        return { exitCode: 1 };
      }

      if (opts.json) {
        print(JSON.stringify(result));
      } else {
        const blocks = Array.isArray(result.content) ? result.content : [];
        for (const block of blocks) {
          print(renderContentBlock((block ?? {}) as { type?: unknown; text?: unknown }));
        }
      }
      // An `isError` result is a real answer -- the body is printed either way,
      // because the text IS the error message and a caller that only got a
      // non-zero code would have nothing to act on -- but a script has to be
      // able to tell it from success without parsing, so the code carries it.
      return { exitCode: result.isError === true ? 1 : 0 };
    });
  } catch (e) {
    if (e instanceof TransientConnectError) {
      // The widest upstream-text surface in the file: connectToUpstream puts
      // the child's own stderr TAIL into the ActivationError message, so any
      // server that fails to boot gets to write bytes onto this line. The
      // namespace is quoted too, for the same reason it is at the unknown-
      // server branch above -- it is an argument this process was handed.
      printErr(`yaw-mcp call: Could not connect to "${displaySafe(namespace)}": ${displaySafe(e.message)}`);
      return { exitCode: 1 };
    }
    // Anything else escaping the body is a bug here rather than an upstream
    // problem, and reporting it as "could not connect" would send the user to
    // check a server that started perfectly well.
    throw e;
  }
}
