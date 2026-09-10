// `yaw-mcp status` -- ONE cheap, side-effect-free read of everything a GUI
// needs to render the state of this machine's yaw-mcp install.
//
// It exists because the Yaw Terminal MCP panel was composing that view from
// several separate spawns of this CLI (a server list, a grade source, a
// state/learning source) plus `yaw-mcp servers --json`, whose non-zero exit it
// read as "signed out" -- a check against a hosted backend that no longer
// exists. Every panel open therefore paid several process
// starts and still showed zero calls and no grades.
//
// The contract this command makes, in the order it matters to a poller:
//
//   SIDE-EFFECT-FREE. It reads four things and writes none of them: the
//   winning bundles.json (loadLocalBundles), the grade cache (readGradesCache),
//   the persisted state file (loadStateClassified), and one existsSync on the
//   vault. It never constructs ConnectServer, so it never spawns an upstream
//   and never reaches maybeAutoUpgrade (server.ts is the only caller of that).
//   It never calls loadVault. The bundles WRITE path is the only thing in
//   local-bundles.ts that takes the cross-process lock, and nothing here is on
//   it. A test snapshots size+mtime of every file under the config dir across
//   a run and requires them identical.
//
//   COMPOSED, NOT REIMPLEMENTED. Every reader above is the same function the
//   corresponding user-facing command already uses, so a status payload cannot
//   disagree with what `list`, `audit` and `reset-learning` report. The
//   flaky-namespace verdict comes from usage-hints' selectFlakyNamespaces --
//   the same selector `doctor` and the `mcp_connect_health` meta-tool call --
//   for the same reason: a second copy of "what counts as flaky" would let the
//   panel badge a server the dispatch penalty does not actually depress.
//
//   NO NETWORK. Nothing here dials anything, so a poll cannot block on a
//   registry or a slow upstream.
//
// Exit codes:
//   0  readable, INCLUDING an empty machine -- a fresh install has no
//      bundles.json and that is not a fault. Warnings do not raise it either:
//      the panel needs to keep rendering, and the warnings ride in the payload
//      (doctor is the command whose job is to turn a warning into exit 2).
//   1  genuinely unreadable: a bundles.json is present but could not be read
//      or parsed, so we cannot say what this machine loads.
//   2  argv error (index.ts's shared parse-then-dispatch tail).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { type GradesCache, readGradesCache } from "./grades-cache.js";
import type { NamespaceUsage } from "./learning.js";
import { isRemoteEntry, loadLocalBundles, localBundlesPath } from "./local-bundles.js";
import { createStreamWriter } from "./logger.js";
import { userConfigDir } from "./paths.js";
import { isPersistenceDisabled, loadStateClassified, statePath } from "./persistence.js";
import { collectSecretRefNames, vaultPath } from "./secrets-vault.js";
// The text table renders NAME straight out of bundles.json, a file a repo can
// ship and a badge can write. IMPORTED, never re-spelled: a second hand-rolled
// copy of the escape logic would drift from the one trust-cmd's tests cover.
import { displaySafe } from "./trust-cmd.js";
import { selectFlakyNamespaces } from "./usage-hints.js";

// tsup substitutes the bare identifier at build time; the typeof guard is what
// keeps an unbundled run (vitest, tsx) from throwing on it. Same shape as
// doctor-cmd.ts, upgrade-cmd.ts and server.ts.
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

/**
 * Payload schema version. A GUI pins on this rather than sniffing for fields,
 * so an ADDITIVE change (a new optional key) leaves it alone and only a
 * breaking one -- a field removed, renamed, or given a new meaning -- bumps it.
 */
export const STATUS_SCHEMA_VERSION = 1;

/** Where a server's letter grade came from. The distinction is not cosmetic:
 *  "audit" was measured by the compliance suite against the bytes on THIS
 *  machine (grades.json, written by `yaw-mcp audit`), while "catalog" is what
 *  the yaw.sh catalog claimed at `yaw-mcp add` time and was never verified
 *  here. A panel that renders them identically tells the user a build was
 *  graded when it was not. */
export type StatusGradeSource = "audit" | "catalog";

export interface StatusServer {
  namespace: string;
  /** Straight out of bundles.json, so UNTRUSTED for display purposes. JSON
   *  consumers get it verbatim (JSON.stringify escapes control bytes into
   *  \u form); the text renderer runs it through displaySafe. */
  name: string;
  type: "local" | "remote";
  active: boolean;
  /** Typed as a plain string, deliberately. validateEntry (local-bundles.ts)
   *  accepts ANY non-blank string in bundles.json as a grade and only trims
   *  and uppercases it -- on purpose, so compliance.ts can report an
   *  unrecognized grade rather than silently reading it as ungraded. So a
   *  consumer must not assume A-F here unless gradeSource is "audit", where
   *  grades-cache.ts's own validator did enforce the letter set. */
  grade: string | null;
  gradeSource: StatusGradeSource | null;
  /** Non-null only for gradeSource "audit" -- the cache is the only supplier
   *  of a score, a timestamp or a rubric version. */
  score: number | null;
  gradedAt: string | null;
  /** The @yawlabs/mcp-compliance package version that produced the letter.
   *  Null on an entry cached before the field existed, which is why it is
   *  reported separately from gradedAt rather than assumed present. */
  suiteVersion: string | null;
  /** This server's credentials come from the vault (`${secret:NAME}` in `env`
   *  for a local entry, in `headers` for a remote one). Paired with
   *  `vault.locked`, this is what lets a panel explain a server that will not
   *  start instead of just showing it as broken. Malformed refs are NOT
   *  counted: those are a typo in bundles.json, not a vault dependency. */
  needsSecrets: boolean;
  /** Dispatched proxy calls recorded across sessions, from state.json. 0 for
   *  a server that has never been routed to. */
  calls: number;
  /** succeeded/dispatched, rounded. Null (not 0) when calls is 0: "never
   *  called" and "called and always failed" are different states and a panel
   *  renders them differently. The numerator is a SUM of graded rewards in
   *  [0,1] per call (learning.ts recordOutcome), not a count of clean
   *  replies, so this is an average quality score rather than a pass rate. */
  successRate: number | null;
  lastUsedAt: number | null;
  /** The same >=3 dispatches AND <80% success rule the dispatch penalty uses,
   *  computed by usage-hints' shared selector so this cannot drift from what
   *  `doctor` and `mcp_connect_health` call flaky. */
  flaky: boolean;
}

export interface StatusPayload {
  schemaVersion: number;
  /** Mirrors the exit code: false only when `config.readable` is false. */
  ok: boolean;
  /** The yaw-mcp version answering, so a panel does not need a second spawn
   *  of `yaw-mcp --version`. "dev" on an unbundled run. */
  version: string;
  config: {
    /** The bundles.json that WON, or null when no file exists anywhere.
     *  Non-null with `readable: false` is the "there is a file and we cannot
     *  use it" state; null with `readable: true` is a fresh install. */
    path: string | null;
    /** Which scope won. A project-local file (approved via `yaw-mcp trust`)
     *  beats the user-global one outright. */
    scope: "project" | "user" | null;
    readable: boolean;
    /** Load diagnostics verbatim from loadLocalBundles: an ignored untrusted
     *  project file, a schema version from the future, a dropped entry. Also
     *  written to stderr so `status | jq` still explains itself. */
    warnings: string[];
  };
  serverCount: number;
  activeCount: number;
  servers: StatusServer[];
  vault: {
    path: string;
    exists: boolean;
    /**
     * Would a `${secret:NAME}` ref fail to resolve in a process spawned with
     * THIS environment: the vault file is present and no passphrase is in the
     * env. It is NOT a question about a global daemon -- secrets-vault's own
     * isUnlocked() answers only for the calling process (it reports whether an
     * unlock ran in it), so in a one-shot CLI spawn it is false by
     * construction and would tell a poller nothing.
     *
     * CAVEAT a GUI must not paper over: the env read is the env THIS process
     * was spawned with. The passphrase belongs in the `env` block of the MCP
     * client entry that launches `yaw-mcp`, so a panel spawning status from a
     * shell can legitimately see locked:true while the serving process is
     * unlocked. Treat it as "the caller's env cannot unlock it", which is
     * exactly what doctor's SECRET VAULT section reports as passphraseSet.
     */
    locked: boolean;
    /** The raw input to `locked`, never the value. Reported separately so a
     *  consumer can distinguish "no vault" from "vault, no passphrase". */
    passphraseInEnv: boolean;
  };
  learning: {
    path: string;
    /** False when YAW_MCP_DISABLE_PERSISTENCE is set, in which case a running
     *  broker neither loads nor writes this file: the counts below are real
     *  history but frozen, and no new call updates them. */
    enabled: boolean;
    /** False when the file exists but could not be read or parsed. Absent
     *  file reads as true: an empty state IS what is there. */
    readable: boolean;
    /** Rows in state.json, which can EXCEED serverCount: nothing prunes a row
     *  when its server is removed from bundles.json, so history for a
     *  since-removed namespace is still counted here (and still surfaces in
     *  doctor's flaky rollup). Per-server counts above only cover configured
     *  servers. */
    namespaces: number;
    /** Sum of `dispatched` over every row, same population as `namespaces`. */
    calls: number;
    packHistory: number;
    toolCaches: number;
    savedAt: number | null;
  };
}

export interface StatusCommandOptions {
  json?: boolean;
  home?: string;
  cwd?: string;
  /** Threaded rather than left to default inside the readers for the reason
   *  `list` threads it: the project-trust gate (YAW_MCP_TRUST_PROJECT) and the
   *  persistence opt-out both read it, and an embedded or test caller that
   *  supplies an env expects THAT env to decide the answer. */
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface StatusCommandResult {
  // No `lines` transcript: the exit code plus what reached the injected
  // out/err sinks IS the contract. The deleted servers-cmd carried a `lines`
  // field that nothing ever read; do not reintroduce the shape here.
  exitCode: number;
}

export interface ParsedStatusArgs {
  json?: boolean;
}

export const STATUS_USAGE = `Usage: yaw-mcp status [--json]

  Print one read-only snapshot of this machine's yaw-mcp state: the servers
  it loads and whether each is active and graded, whether the secret vault
  is locked, whether the config was readable, and the cross-session call
  counts yaw-mcp has learned.

  Reads only; it never starts a server, writes a file, or hits the network,
  so it is safe to poll. --json is the machine-readable form.

  Exits 1 only when a bundles.json exists but cannot be read. A machine with
  no servers yet exits 0.

  -h, --help  Show this help.`;

export function parseStatusArgs(
  argv: string[],
): { ok: true; options: ParsedStatusArgs } | { ok: false; error: string; help?: boolean } {
  const opts: ParsedStatusArgs = {};
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: STATUS_USAGE, help: true };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    return { ok: false, error: `yaw-mcp status: unknown argument "${a}"\n\n${STATUS_USAGE}` };
  }
  return { ok: true, options: opts };
}

/** Rounding denominator for successRate. `succeeded` is an accumulated sum of
 *  floats, so the raw quotient prints as 0.30000000000000004 in JSON; four
 *  decimals is finer than any panel renders and kills the artifact. Same
 *  hazard formatUsageHint rounds away for its "used Nx" line. */
const RATE_PRECISION = 10_000;

function successRateOf(usage: NamespaceUsage | undefined): number | null {
  if (!usage || usage.dispatched <= 0) return null;
  // sanitizeLearning (persistence.ts) clamps succeeded down to dispatched on
  // the way in, so this cannot exceed 1 even from a hand-edited file.
  return Math.round((usage.succeeded / usage.dispatched) * RATE_PRECISION) / RATE_PRECISION;
}

/**
 * THE reader. Exported separately from the renderer so an embedded caller (or
 * a future meta-tool) gets the payload without going through stdout, and so
 * the tests assert on the shape rather than on parsed text.
 */
export async function collectStatus(opts: StatusCommandOptions = {}): Promise<StatusPayload> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const configDir = userConfigDir(home);
  const globalPath = localBundlesPath(configDir);
  const learningPath = statePath(configDir);

  // Four independent reads, issued together: none of them needs another's
  // result, and a panel opens on this command.
  const [loaded, grades, state] = await Promise.all([
    loadLocalBundles({ home, cwd, env }),
    // readGradesCache swallows its own read and parse failures and returns {}
    // (grades-cache.ts; only the strictRead WRITE path rethrows), so a missing
    // or garbled cache already degrades to "no grades". The catch is the belt
    // to that braces, and it is what keeps a future regression there from
    // rejecting this whole Promise.all and taking the panel's poll down over
    // disposable derived data. `list` wraps the same call the same way.
    readGradesCache(home).catch(() => ({}) as GradesCache),
    loadStateClassified(learningPath),
  ]);
  const vaultFile = vaultPath(home);
  const vaultExists = existsSync(vaultFile);

  const servers = loaded.config?.servers ?? [];
  // config === null with a non-null path is the only unreadable shape:
  // loadLocalBundles returns a null config either because no file exists
  // anywhere (path null too) or because the file it committed to could not be
  // read or parsed (path set, warnings populated). Nothing else here is fatal.
  const readable = loaded.config !== null || loaded.path === null;

  const learning = state.state.learning;
  // Ask the shared selector once for the whole population rather than
  // re-deriving the rule per server. The limit is a ceiling, and 0 entries
  // would make it 0 -- which selectFlakyNamespaces treats as "return nothing"
  // -- so the empty case short-circuits instead of relying on that.
  const entries = Object.entries(learning).map(([namespace, usage]) => ({ namespace, usage }));
  const flaky = new Set(
    entries.length === 0 ? [] : selectFlakyNamespaces(entries, entries.length).map((e) => e.namespace),
  );

  const statusServers: StatusServer[] = servers.map((s) => {
    const cached = grades[s.namespace];
    const usage = learning[s.namespace];
    // Cache BEATS the bundles.json letter, matching runList: the cached one
    // was measured against the bytes on this machine, the config one is what
    // the catalog claimed at add time. A miss leaves the config value
    // standing rather than blanking it.
    const grade = cached ? cached.grade : (s.complianceGrade ?? null);
    return {
      namespace: s.namespace,
      name: s.name,
      // isRemoteEntry, not s.type: it is the shared predicate for which map
      // carries the credentials, and reading the wrong one below would either
      // invent a vault dependency or hide a real one.
      type: isRemoteEntry(s) ? "remote" : "local",
      active: s.isActive,
      grade,
      gradeSource: cached ? "audit" : s.complianceGrade ? "catalog" : null,
      score: cached ? cached.score : null,
      gradedAt: cached ? cached.gradedAt : null,
      suiteVersion: cached?.suiteVersion ?? null,
      needsSecrets: collectSecretRefNames(isRemoteEntry(s) ? s.headers : s.env).size > 0,
      calls: usage?.dispatched ?? 0,
      successRate: successRateOf(usage),
      lastUsedAt: usage?.lastUsedAt ?? null,
      flaky: flaky.has(s.namespace),
    };
  });

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    ok: readable,
    version: VERSION,
    config: {
      path: loaded.path,
      scope: loaded.path === null ? null : loaded.path === globalPath ? "user" : "project",
      readable,
      warnings: loaded.warnings,
    },
    serverCount: statusServers.length,
    activeCount: statusServers.filter((s) => s.active).length,
    servers: statusServers,
    vault: {
      path: vaultFile,
      exists: vaultExists,
      locked: vaultExists && (env.YAW_MCP_VAULT_PASSPHRASE ?? "") === "",
      passphraseInEnv: (env.YAW_MCP_VAULT_PASSPHRASE ?? "") !== "",
    },
    learning: {
      path: learningPath,
      enabled: !isPersistenceDisabled(env),
      readable: state.parsedCleanly,
      // The SANITIZED state, not rawCounts: this reports what yaw-mcp will
      // USE, which is the question a panel is asking. rawCounts answers the
      // opposite question ("what did the file hold") and belongs to
      // reset-learning, which is about to destroy it.
      namespaces: Object.keys(learning).length,
      calls: Object.values(learning).reduce((n, u) => n + u.dispatched, 0),
      packHistory: state.state.packHistory.length,
      toolCaches: Object.keys(state.state.toolCache).length,
      savedAt: state.state.savedAt > 0 ? state.state.savedAt : null,
    },
  };
}

export async function runStatus(opts: StatusCommandOptions = {}): Promise<StatusCommandResult> {
  const write = opts.out ?? createStreamWriter(process.stdout);
  const writeErr = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => write(`${s}\n`);

  const payload = await collectStatus(opts);

  // Warnings to stderr in BOTH modes, same split runList uses: a script
  // parsing stdout stays clean while a human still sees the diagnostic. They
  // are ALSO in the payload for a consumer that captured stdout alone.
  for (const w of payload.config.warnings) writeErr(`warning: ${w}\n`);

  if (opts.json) {
    print(JSON.stringify(payload, null, 2));
    return { exitCode: payload.ok ? 0 : 1 };
  }

  print(`yaw-mcp ${payload.version}`);
  if (payload.config.path === null) {
    print(`config:   none yet -- add a server with \`yaw-mcp add <slug>\``);
  } else {
    print(`config:   ${payload.config.path} (${payload.config.scope})${payload.config.readable ? "" : " UNREADABLE"}`);
  }
  const graded = payload.servers.filter((s) => s.grade !== null).length;
  print(`servers:  ${payload.serverCount} total, ${payload.activeCount} active, ${graded} graded`);
  print(`vault:    ${payload.vault.exists ? (payload.vault.locked ? "locked" : "unlocked") : "none yet"}`);
  const learningState = payload.learning.readable
    ? `${payload.learning.namespaces} namespace${payload.learning.namespaces === 1 ? "" : "s"}, ${payload.learning.calls} calls`
    : "unreadable";
  print(`learning: ${learningState}${payload.learning.enabled ? "" : " (persistence disabled)"}`);

  if (payload.servers.length > 0) {
    print();
    // Same column shape as `list`, minus LAUNCH (which is what `list` is for)
    // and plus the two numbers only this command has. GRADE is displaySafe'd
    // for the same reason NAME is: it can be any string bundles.json carries.
    const cols: Array<[string, (s: StatusServer) => string]> = [
      ["NAMESPACE", (s) => s.namespace],
      ["NAME", (s) => displaySafe(s.name)],
      ["STATUS", (s) => (s.active ? "active" : "disabled")],
      ["GRADE", (s) => (s.grade ? displaySafe(s.grade) : "-")],
      ["CALLS", (s) => String(s.calls)],
      ["SUCCESS", (s) => (s.successRate === null ? "-" : `${Math.round(s.successRate * 100)}%${s.flaky ? " !" : ""}`)],
    ];
    const rows = [...payload.servers].sort((a, b) => a.namespace.localeCompare(b.namespace));
    const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)));
    const fmt = (cells: string[]): string =>
      cells
        .map((c, i) => c.padEnd(widths[i]))
        .join("  ")
        .trimEnd();
    print(fmt(cols.map(([h]) => h)));
    for (const r of rows) print(fmt(cols.map(([, get]) => get(r))));
  }

  return { exitCode: payload.ok ? 0 : 1 };
}
