// `yaw-mcp try <slug>` — one-shot trial: fetches the canonical launch
// shape for an MCP server from the yaw.sh/mcp catalog (catalog.ts), wires
// it into the user's AI client config under a `yaw-mcp-try-<slug>` entry
// (NOT through yaw-mcp -- the trial entry points DIRECTLY at the upstream
// MCP server's command + args), drops a trial marker file under
// ~/.yaw-mcp/trials/<slug>.json so the doctor's GC pass can sweep it
// after expiry, and prints a 3-line "trial wired" nudge.
//
// Design notes:
//   - The trial entry is upstream-shape so the user can evaluate the
//     server end-to-end without onboarding yaw-mcp first. yaw-mcp's
//     value-add (learning, compliance gating, one connection for many
//     servers) is offered AFTER the user has decided the server is worth
//     keeping.
//   - The Windows `cmd /c` wrap is delegated to `buildLaunchEntry` —
//     same code path the canonical `yaw-mcp install` flow uses, so a
//     future fix to the wrapping logic propagates to trials for free.
//   - Trial marker fields are versioned (`schemaVersion`) so the GC pass can
//     refuse to act on a marker written by a NEWER yaw-mcp, whose
//     containerPath/entryName semantics it cannot know. Enforced in
//     scanTrials + runTryCleanup: a schemaVersion ABOVE TRIAL_SCHEMA_VERSION
//     is reported as malformed for the user to delete by hand. A marker with
//     no schemaVersion at all is read as v1 rather than rejected -- older
//     hand-rolled and third-party markers omit it, and stranding those would
//     leave real trial entries wired with no path to reclaim them.
//   - The GC also refuses any marker whose entryName is not `yaw-mcp-try-*`.
//     Every value it acts on (clientPath, containerPath, entryName) comes
//     straight out of the marker file, so without that guard a corrupt or
//     hand-edited marker makes the sweep delete an arbitrary key from an
//     arbitrary JSON file.
//   - NOTHING IS SENT ANYWHERE AND NOTHING IS FINGERPRINTED. `try` used to
//     POST a {slug, action, anonId} triple to /api/try/event; that endpoint
//     died with the hosted backend and the poster is now a no-op, so no trial
//     event leaves the machine. The anonId (a truncated SHA-256 of hostname +
//     username) is gone with it: it is no longer computed and no longer
//     persisted to ~/.yaw-mcp/trials/.anon.
//   - A `.anon` file left behind by an older version is inert -- scanTrials
//     only reads *.json, so nothing loads it -- and `try` deliberately does
//     NOT delete it. Silently removing a file from the user's home dir as a
//     side effect of an unrelated command is more surprising than leaving 17
//     dead bytes; `rm ~/.yaw-mcp/trials/.anon` clears it for anyone who cares.
//   - The postEvent seam is GONE too, along with TryEventBody, the
//     ANON_ID_PLACEHOLDER literal, and doctor's `postTryEvent` option. It
//     had become an injection point that existed only to be injected: the
//     default implementation was a no-op, so every test that passed one was
//     overriding nothing with nothing. `--base` and $YAW_MCP_BASE_URL went
//     with it: the value was parsed, threaded into the catalog seam and
//     ignored there, so the flag was a no-op that --help still described as
//     a base URL. It was accepted-and-ignored for one release (v0.79.x) and
//     is now rejected as an unknown flag like any other.
//   - A project-scope target -- the per-project file a client reads out of
//     the repo (.mcp.json, .cursor/mcp.json, .vscode/mcp.json,
//     .gemini/settings.json) -- is commit-to-share config, and the trial
//     entry carries its secret INLINE. Writing a plaintext credential into a
//     file that `git add -A` sweeps up is refused unless --yes is passed; see
//     step 5b. WHICH file is in play (if any) follows the RESOLVED SCOPE, not
//     the client id: this note used to name .vscode/mcp.json as the only one
//     `try` could reach, which stopped being true once the scope started
//     coming from the target table. `try` takes a user scope wherever the
//     client has one, so the refusal is reachable only by a client with no
//     user scope -- see step 3.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { atomicWriteFile } from "./atomic-write.js";
import { CATALOG_SLUG_RE, resolveCatalogSlug } from "./catalog.js";
import { clientChoices, resolveClientArg } from "./client-aliases.js";
import {
  applyClientConfigEdits,
  type ClientConfigView,
  type ConfigSite,
  classifyClientConfig,
  composeEntry,
  readClientConfigFile,
  readClientEnv,
  terminateWithNewline,
} from "./client-config.js";
import { probeClientsAsync, probeUsable } from "./doctor-cmd.js";
import { clientUnavailableMessage, describeUnreadableConfig } from "./install-cmd.js";
import {
  buildLaunchEntry,
  type ClientEnvValues,
  CURRENT_OS,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  resolveAppDataDir,
  resolveInstallSites,
} from "./install-targets.js";
import { createStreamWriter, log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";
import { QUESTION_CANCELLED, type QuestionCancelled, questionOrEmpty } from "./readline-question.js";

// The --client line is derived from the same table parseTryArgs validates
// against (and that completion-cmd builds INSTALL_CLIENTS from), not a
// hand-kept copy of it: the literal four-client list here outlived the
// windsurf and gemini-cli additions, so both were ACCEPTED by the parser and
// named nowhere a user could find them. Interpolating leaves one list to keep.

/** The flag column every continuation line in TRY_USAGE hangs from. */
const USAGE_INDENT = " ".repeat(23);

/** Wrap the derived client list to the flag column. Six clientIds on one line
 *  render at 93 columns while every other line in TRY_USAGE fits 80, so an
 *  80-column terminal soft-wrapped the list back to column 0 and broke the
 *  two-column layout the whole block is written in. Wrapping HERE rather than
 *  hand-splitting the literal keeps the list derived: a seventh target still
 *  cannot desync it, it just wraps. A continued line ends in "|" so the reader
 *  (and the test that parses this back) can tell the list is not finished. */
function wrapToUsageColumn(parts: string[], width = 80): string {
  const lines: string[] = [];
  let current = "";
  parts.forEach((part, i) => {
    const candidate = current === "" ? part : `${current} | ${part}`;
    // Reserve the trailing " |" unless this is the last item on the last line.
    const rendered = USAGE_INDENT.length + candidate.length + (i === parts.length - 1 ? 0 : 2);
    if (rendered > width && current !== "") {
      lines.push(`${current} |`);
      current = part;
    } else {
      current = candidate;
    }
  });
  lines.push(current);
  return lines.join(`\n${USAGE_INDENT}`);
}
export const TRY_USAGE = `Usage: yaw-mcp try <slug> [flags]

  Wire a one-off trial of an MCP server into your AI client. No account
  needed; the trial points directly at the upstream server. Nothing sweeps
  it on a timer -- once --ttl has elapsed it is removed by the next
  \`yaw-mcp doctor\` run. Run \`yaw-mcp try-cleanup <slug>\` to remove it now.

  --client <name>      ${wrapToUsageColumn(clientChoices("try"))}
                       (default: auto-detect, prefers the first installed
                       client in the order probed by \`yaw-mcp install --list\`)
  --ttl <duration>     How long the trial lives before doctor GCs it
                       (default: 1h; accepts e.g. 30m, 2h, 7d)
  --env KEY=value      Set an env var on the trial entry. Repeatable.
                       Required env vars not supplied here AND not in your
                       shell's env block the trial with an explainer.
  --dry-run            Print what would happen without writing anything.
  --yes, -y            Confirm writing an inline secret into a PROJECT-scope
                       config -- a per-project file the client reads out of
                       the repo (.mcp.json, .cursor/mcp.json,
                       .vscode/mcp.json, .gemini/settings.json), which is
                       routinely committed. Without it, a trial whose entry
                       carries a secret refuses that target and says why.
                       A trial takes a user-scope file wherever the client
                       has one, and every client shipped today has one, so
                       this flag is currently never required -- it is here
                       for a future project-only client.

  Point the catalog somewhere else with $YAW_MCP_CATALOG_URL.`;

export const TRY_CLEANUP_USAGE = `Usage: yaw-mcp try-cleanup <slug> [--force]

  Remove a previously-wired trial: peels the yaw-mcp-try-<slug> entry out of
  the AI client config and deletes the marker under ~/.yaw-mcp/trials/. Safe
  to run after the trial expires (no-op if nothing is wired).

  This rewrites a config file your AI client launches from, so when there IS
  a trial to remove you are shown the file and the entry and asked to
  confirm. A bare Enter is NO.

  An entry that is no longer the one the trial wrote -- you kept the name and
  pointed it at your own server -- is left alone; only the marker goes.

  --force, -y, --yes  Skip the confirmation. Required when stdin or stdout
                      is not a TTY (there is nothing to ask on).`;

export const TRIAL_SCHEMA_VERSION = 1;
export const TRIALS_DIRNAME = "trials";

/** Every entry `try` writes is named `yaw-mcp-try-<slug>`. The cleanup and GC
 *  paths delete `marker.entryName` from `marker.clientPath` using values read
 *  verbatim out of the marker file, so they check this prefix before acting:
 *  a marker naming anything else is corrupt, hand-edited, or from a writer we
 *  don't know, and honoring it would remove an arbitrary key from an
 *  arbitrary JSON file on disk. */
export const TRIAL_ENTRY_PREFIX = "yaw-mcp-try-";

export interface ExploreServerResponse {
  slug: string;
  name: string;
  command: string;
  args: string[];
  /** Names of env vars the server needs to function. yaw-mcp try refuses
   *  to wire the trial if any of these are missing from both --env and
   *  process.env, so the user sees the requirement up front instead of
   *  a silent runtime failure in the client. */
  requiredEnvVars?: string[];
  docUrl?: string;
}

export interface TrialMarker {
  schemaVersion: number;
  slug: string;
  name: string;
  /** Epoch ms when doctor's GC pass should evict the entry. */
  expiresAt: number;
  /** Absolute path of the client config file the entry was written to. */
  clientPath: string;
  /** Human-friendly client id (claude-code, cursor, ...). Used by doctor
   *  to surface "trial expires in Nm for <client>" without re-probing. */
  clientName: InstallClientId;
  /** Container path (mcpServers/servers/projects[..]) under which the
   *  trial entry was written. Doctor needs this to GC the entry from
   *  the right scope (especially Claude Code local-scope under projects). */
  containerPath: string[];
  /** Entry name in the container — almost always `yaw-mcp-try-<slug>` but
   *  persisted so a future rename doesn't orphan old markers. */
  entryName: string;
  /** Epoch ms when the trial was created. Diagnostic. */
  createdAt: number;
  /** Fingerprint of the LAUNCH this trial wrote (command + args), so the
   *  cleanup and GC paths can tell the entry they wrote from one the user has
   *  since replaced under the same key. See trialLaunchFingerprint.
   *
   *  OPTIONAL, and TRIAL_SCHEMA_VERSION deliberately does NOT move for it. The
   *  field is additive -- an older yaw-mcp ignores it -- while a version bump
   *  would make that older yaw-mcp REFUSE every marker this version writes
   *  (rejectUntrustedMarker rejects a version above its own), stranding live
   *  trials, inline secrets and all, on a downgrade. A marker without one is
   *  swept exactly as before: unprovable provenance is what every marker had
   *  until now, and refusing those would strand them too. */
  entryFingerprint?: string;
}

export interface TryCommandOptions {
  slug?: string;
  clientId?: InstallClientId;
  /** Trial TTL as a duration string (e.g. "30m", "1h", "7d"). */
  ttl?: string;
  envOverrides?: Record<string, string>;
  dryRun?: boolean;
  /** `--yes`: write an inline secret into a project-scope (commit-to-share)
   *  config anyway. Without it runTry refuses that combination -- see the
   *  step-5b gate. Irrelevant to user-scope targets and secret-free trials. */
  yes?: boolean;
  /** Override for tests. */
  home?: string;
  cwd?: string;
  os?: InstallOS;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to process.platform. Decides ONE thing --
   *  whether the 0600 tightening in step 7 applies, since POSIX perms are a
   *  no-op on win32. Injected rather than read globally so a test can pin the
   *  POSIX arm without redefining process.platform for the whole process,
   *  which also flips atomicWriteFile out of its Windows rename-retry path
   *  (the AV/indexer EPERM dance) on the machine this suite runs on. */
  platform?: NodeJS.Platform;
  /** Override for tests; defaults to the catalog read in defaultFetchExplore.
   *  `catalogUrl` carries runTry's resolved $YAW_MCP_CATALOG_URL override
   *  (undefined when unset or empty) so the seam never has to read
   *  process.env behind the caller's injected `env`. */
  fetchExplore?: (slug: string, catalogUrl?: string) => Promise<ExploreServerResponse>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Override for tests; defaults to Date.now(). */
  now?: () => number;
}

export interface TryCleanupOptions {
  slug?: string;
  home?: string;
  os?: InstallOS;
  /** Skip the confirmation. Required off a TTY. */
  force?: boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hooks, spelled as `remove` and `set` spell them so every
   *  confirmation in the CLI is driven the same way. */
  isTTY?: boolean;
  promptAnswer?: string;
  io?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; terminal?: boolean };
}

export interface TryCommandResult {
  exitCode: number;
  /** Files written (empty in --dry-run or on error). */
  written: string[];
  /** Marker that was persisted (or would have been, in --dry-run). */
  marker?: TrialMarker;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

// Slug shape `try` and `try-cleanup` accept is CATALOG_SLUG_RE from catalog.ts
// -- the module that owns the slug set -- shared with `add` so the three
// sites cannot drift. It also keeps the entry name and marker filename free
// of shell-special characters.

/** Parse argv slice for `yaw-mcp try`. Exported for tests. */
export function parseTryArgs(
  argv: string[],
): { ok: true; options: TryCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: TRY_USAGE };
  const positional: string[] = [];
  const opts: TryCommandOptions = {};
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--client": {
        const v = next();
        // `clientChoices("try")` is the canonical client set with NO alias:
        // `try` picks a client by probing, so a second name for a slot it
        // already probes would let one file be trialled twice. A new row is
        // accepted here without touching any literal.
        const resolved = v === undefined ? null : resolveClientArg("try", v);
        if (!resolved) {
          return {
            ok: false,
            error: `--client requires ${clientChoices("try").join("|")}`,
          };
        }
        opts.clientId = resolved.clientId;
        break;
      }
      case "--ttl": {
        const v = next();
        if (!v) return { ok: false, error: "--ttl requires a value (e.g. 1h, 30m, 7d)" };
        if (parseDurationMs(v) === null) {
          return { ok: false, error: `--ttl: cannot parse "${v}" (try 30m, 1h, 2d)` };
        }
        opts.ttl = v;
        break;
      }
      case "--env": {
        const v = next();
        if (!v?.includes("=")) return { ok: false, error: "--env requires KEY=value" };
        const eq = v.indexOf("=");
        const key = v.slice(0, eq);
        const val = v.slice(eq + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return { ok: false, error: `--env: invalid KEY "${key}"` };
        }
        env[key] = val;
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      // -y / --yes is the spelling `trust` and `remove` accept for the same
      // job (confirming a write the command would otherwise refuse).
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "-h":
      case "--help":
        return { ok: false, error: TRY_USAGE, help: true };
      default:
        if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${TRY_USAGE}` };
        // A bare "-" is not a valid slug; reject it here with a clear
        // arg-parse error rather than letting it slip to the slug regex,
        // which would only reject it later with a generic "invalid slug".
        if (a === "-") return { ok: false, error: `Invalid argument "-".\n${TRY_USAGE}` };
        positional.push(a);
    }
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one server slug, got ${positional.length}.\n${TRY_USAGE}` };
  }
  opts.slug = positional[0];
  if (Object.keys(env).length > 0) opts.envOverrides = env;
  return { ok: true, options: opts };
}

export function parseTryCleanupArgs(
  argv: string[],
): { ok: true; options: TryCleanupOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: TRY_CLEANUP_USAGE };
  const opts: TryCleanupOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { ok: false, error: TRY_CLEANUP_USAGE, help: true };
    // Both spellings, for the same reason `remove` takes both: --force is what
    // `secrets remove` documents and -y/--yes is what `trust` and `try`
    // document, and a user should not have to remember which verb took which.
    if (a === "--force" || a === "-y" || a === "--yes") {
      opts.force = true;
      continue;
    }
    if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${TRY_CLEANUP_USAGE}` };
    // Reject a bare "-" with a clear arg-parse error rather than deferring
    // to the slug regex's generic "invalid slug" message.
    if (a === "-") return { ok: false, error: `Invalid argument "-".\n${TRY_CLEANUP_USAGE}` };
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one slug.\n${TRY_CLEANUP_USAGE}` };
  }
  opts.slug = positional[0];
  return { ok: true, options: opts };
}

/** Upper bound on a TTL: 100 years in ms, comfortably inside the ~±8.64e15ms
 *  range a JS Date can represent. `--ttl 100000000d` is a perfectly good digit
 *  run, but it pushes `now + ttl` past that range, where the dry-run preview's
 *  `new Date(expiresAt).toISOString()` throws a bare RangeError ("Invalid time
 *  value") that dispatch() renders as an opaque error -- and the real run
 *  persists the absurd marker without complaint. Rejecting at parse time gives
 *  both paths the same clear "cannot parse" message instead. */
const MAX_TTL_MS = 100 * 365 * 86_400_000;

/** Parse a duration suffix string (10s, 30m, 1h, 7d) into milliseconds.
 *  Returns null when the string is unparseable OR names a duration beyond
 *  MAX_TTL_MS, so callers can surface a clear error either way. */
export function parseDurationMs(s: string): number | null {
  const m = /^(\d+)\s*([smhd])$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const ms = n * factor;
  return ms > MAX_TTL_MS ? null : ms;
}

/** Trials root: `~/.yaw-mcp/trials/`. */
export function trialsDir(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, TRIALS_DIRNAME);
}

export function trialMarkerPath(slug: string, home: string = homedir()): string {
  return join(trialsDir(home), `${slug}.json`);
}

/** Why a marker must NOT be acted on, as a phrase that completes
 *  "marker at <path> ...", or null when it is safe to honor.
 *
 *  Both consumers (runTryCleanup, scanTrials -> gcExpiredTrials) delete
 *  `entryName` at `containerPath` from `clientPath` using values read verbatim
 *  from the marker file, so the blast radius of a bad marker is any JSON key
 *  on disk. `try` only ever writes `yaw-mcp-try-<slug>` at schemaVersion
 *  TRIAL_SCHEMA_VERSION; anything else is corrupt, hand-edited, or from a
 *  writer we don't know. */
function rejectUntrustedMarker(marker: { entryName: string; schemaVersion?: number }): string | null {
  if (!marker.entryName.startsWith(TRIAL_ENTRY_PREFIX)) {
    return `names a non-trial entry ("${marker.entryName}", expected "${TRIAL_ENTRY_PREFIX}*")`;
  }
  // An ABSENT schemaVersion is read as v1 (see the file header): markers
  // written by hand or by older tooling omit it, and rejecting those would
  // strand a live trial entry with nothing able to reclaim it. A version
  // ABOVE ours is the case the field exists for -- a newer yaw-mcp may mean
  // something different by containerPath/entryName, and we don't guess.
  if (typeof marker.schemaVersion === "number" && marker.schemaVersion > TRIAL_SCHEMA_VERSION) {
    return `was written by a newer yaw-mcp (schemaVersion ${marker.schemaVersion} > ${TRIAL_SCHEMA_VERSION})`;
  }
  return null;
}

/** Fingerprint of the LAUNCH an entry performs: its command and args, in the
 *  exact shape they were written to (or read back from) the client config.
 *
 *  WHAT IT IS FOR. `try-cleanup` and doctor's GC delete the entry AT A NAME
 *  (`yaw-mcp-try-<slug>`), read verbatim out of a marker file. That name is
 *  the user's to edit: someone who liked the trial can point the same key at
 *  their own build, or at a pinned version, and keep working. The sweep then
 *  deleted THAT -- their work, under our name, with nothing to say what
 *  happened. The marker could not tell the two apart because it recorded only
 *  where the entry lived, never what it was.
 *
 *  WHY COMMAND + ARGS AND NOT THE WHOLE ENTRY. env is deliberately excluded:
 *  the trial's own inline credential is the thing most likely to be edited in
 *  place (a rotated token), and that edit leaves the entry OURS -- refusing to
 *  reclaim it would strand exactly the entries whose secret we most want gone
 *  at expiry. A different command or args is a different program, which is the
 *  case worth protecting.
 *
 *  Hashed rather than stored plainly so the marker never grows a second copy
 *  of an argv that can carry a token in a --url or a flag value. Truncated to
 *  16 hex chars: this distinguishes an edit from a non-edit, it is not a
 *  security boundary -- an attacker who can write the client config can write
 *  the marker beside it. */
function trialLaunchFingerprint(entry: { command?: unknown; args?: unknown }): string {
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  return createHash("sha256")
    .update(JSON.stringify([command, args]))
    .digest("hex")
    .slice(0, 16);
}

/** The marker fields every consumer reads VERBATIM off disk and hands to the
 *  peel. Throws rather than returning a boolean so the one caller that reports
 *  the reason -- runTryCleanup's "marker at <path> is unreadable (...)" -- has
 *  a message, while the callers that treat "cannot tell" as "nothing to do"
 *  simply catch. Checking one field instead of all three let a marker with no
 *  clientPath through, and a peel handed no path reports "nothing there"
 *  rather than failing -- so the marker was unlinked and the user was told the
 *  trial was "cleaned up" while its entry, inline secret and all, stayed wired
 *  with nothing left on disk naming it. This check is the ONLY thing standing
 *  between such a marker and the peel. */
function assertTrialMarkerShape(parsed: unknown): asserts parsed is TrialMarker {
  const m = parsed as TrialMarker | null;
  if (
    !m ||
    typeof m !== "object" ||
    typeof m.clientPath !== "string" ||
    typeof m.entryName !== "string" ||
    !Array.isArray(m.containerPath)
  ) {
    throw new Error("marker is missing required fields");
  }
}

/** Load a trial marker off disk without throwing. Returns null when the file
 *  is absent, unreadable, unparseable, or missing the fields the peel path
 *  needs -- callers treat "cannot tell" the same as "nothing to do".
 *
 *  The RAW bytes come back alongside the parsed marker: runTry's rollback has
 *  to be able to put the previous marker back byte-for-byte when its own
 *  client-config write fails (re-serializing would be close, but the bytes on
 *  disk are what the user had). */
async function readTrialMarker(markerPath: string): Promise<{ marker: TrialMarker; raw: string } | null> {
  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    assertTrialMarkerShape(parsed);
    return { marker: parsed, raw };
  } catch {
    return null;
  }
}

/** The read -> parse -> remove -> write core the three peel sites share
 *  (peelTrialEntry, runTryCleanup, gcExpiredTrials). It reports WHAT happened
 *  and lets each caller decide what that MEANS -- the part that legitimately
 *  differs between them:
 *   - "removed":    the entry was present and the file was rewritten (or, with
 *                   `dryRun`, would have been).
 *   - "absent":     nothing to do (no file, empty file, entry already gone, or
 *                   a container on the way down that cannot hold it).
 *   - "not-object": the whole FILE is valid JSON that is NOT an object, so it
 *                   is not a client config at all and no peel is possible. The
 *                   GC refuses to unlink the marker on this; try-cleanup warns
 *                   and carries on.
 *   - "replaced":   an entry IS at that name, but it is not the one the trial
 *                   wrote (see trialLaunchFingerprint). Nothing is touched --
 *                   it is the user's now.
 *  Read/parse/write errors propagate to the caller's own catch.
 *
 *  `expectFingerprint` is undefined for a marker written before fingerprints
 *  existed, and then the provenance check is skipped entirely: every marker
 *  had unprovable provenance until now, and refusing those would strand the
 *  trials they name. */
async function peelEntryFromConfig(
  clientPath: string,
  containerPath: string[],
  entryName: string,
  dryRun = false,
  expectFingerprint?: string,
): Promise<"removed" | "absent" | "not-object" | "replaced"> {
  const site = markerSite(clientPath, containerPath);
  const view = await readClientConfigFile(site);
  const read = view.read;
  // No file, or a file that is empty or whitespace-only.
  if (read.kind === "absent") return "absent";
  // The bytes could not be read at all (EISDIR, EACCES, EBUSY). Thrown rather
  // than returned, because every caller's catch already turns that into the
  // "couldn't strip ..." warning that names the errno, and a new outcome kind
  // would need handling at three call sites to say the same thing.
  if (read.kind === "unreadable") throw new Error(read.message);
  if (read.kind === "malformed") {
    // The whole FILE is not a map: not a client config at all, so no peel is
    // possible. The GC keeps the marker on this rather than claiming a clean
    // sweep. A SYNTAX failure is the parser's refusal and propagates like a
    // read failure -- it is the same "cannot tell what is in there" as before.
    if (read.reason === "root") return "not-object";
    throw new Error(read.detail);
  }
  // A container along the path holds a non-object (mcpServers set to 5, to a
  // string, to an array): a non-object cannot hold a key, so the entry is not
  // in the file either and no future peel could ever succeed. Reporting it as
  // a failure would warn "still wired in" about an entry that is not there,
  // forever -- which is why this is "absent" and only the whole FILE not being
  // a map is "not-object" above.
  if (read.kind === "blocked") return "absent";
  // A shape the splicer will not edit (no JSON-family file produces one; a
  // TOML inline table would). Reported like a syntax failure: the caller's
  // warning names it and the marker is kept.
  if (read.kind === "unspliceable") throw new Error(`the "${read.key}" entry is ${read.reason}`);
  // The user pulled the trial entry and the now-empty mcpServers block (or, at
  // claude-code local scope, the whole projects[<dir>] block) out by hand, so
  // there is provably no entry left to peel.
  if (!read.containerPresent) return "absent";
  const current = view.entry(entryName);
  if (current === undefined) return "absent";
  // Provenance, read off the SAME view the removal below edits, so the entry
  // judged here is the entry that would go.
  if (
    expectFingerprint !== undefined &&
    typeof current.value === "object" &&
    current.value !== null &&
    trialLaunchFingerprint(current.value as { command?: unknown; args?: unknown }) !== expectFingerprint
  ) {
    return "replaced";
  }
  // Through the facade, which verifies the result before this function has
  // bytes to persist: nothing but the named entry moved, no neighbour changed,
  // and the file still reads back. A remove is allowed even into a file the
  // CLIENT itself cannot load -- taking our entry out of a file the client
  // skips is correct, and refusing it would strand the trial.
  const next = applyClientConfigEdits(view, [{ op: "remove", key: entryName }], site);
  if (next === view.raw) return "absent";
  if (dryRun) return "removed";
  // No explicit mode: atomicWriteFile carries the config's existing perms
  // forward, so peeling a trial can never widen a 0600 file that still
  // holds another trial's inline secret.
  await atomicWriteFile(clientPath, terminateWithNewline(next));
  return "removed";
}

/** The site a MARKER names, as the core reads sites.
 *
 *  `format` is `"jsonc"` for every marker, because a marker records
 *  `clientPath`, `containerPath` and `entryName` and has never recorded the
 *  file's SYNTAX or the scope it was resolved at -- so there is nothing on
 *  disk to derive a strictness from. `clientName` is deliberately not
 *  consulted for one either: it is unvalidated marker data, and a wrong id
 *  there would pick a syntax for a file it does not describe.
 *
 *  MEASURED, not assumed: for the one operation a marker drives -- a REMOVAL
 *  -- `"json"` here would behave identically, and the claim that it would
 *  strand a trial in a commented file is false. The strict adapter falls back
 *  to a lenient parse and reports the file `ok` with `unloadable` set, and the
 *  write facade allows a remove into an unloadable file on purpose (taking our
 *  entry out of a file the client skips is correct). A file that fails BOTH
 *  parsers is `malformed` either way. So this is the honest "the marker never
 *  said, and for a removal it does not matter" value, not a behaviour the peel
 *  depends on -- a mutation to `"json"` leaves every test green, which is what
 *  says so.
 *
 *  `containerPath` is EXACT, never folded through claudeCodeContainerPaths:
 *  it is the value the marker recorded when the trial entry was written, and
 *  a peel must delete that entry and nothing else. Folding a drive-letter-case
 *  sibling in here would let a cleanup remove a key the trial never wrote. */
function markerSite(clientPath: string, containerPath: readonly string[]): ConfigSite {
  return {
    id: "trial",
    label: "trial entry",
    resolved: { absolute: clientPath, display: clientPath, containerPath: [...containerPath] },
    format: "jsonc",
    detectDir: null,
  };
}

/** True when `raw` already holds an entry at `entryName` in `site`'s
 *  container. Read through the core, so this answers for the bytes that are
 *  about to be rewritten, with the same adapter the splice uses. Any
 *  unparseable or unexpected shape answers false: the run is about to fail on
 *  that anyway, and claiming a replacement it cannot see would be worse than
 *  staying quiet.
 *
 *  Deliberately asks the ONE site the write goes to: a trial entry under a
 *  drive-letter-case sibling of the project key is a different key that this
 *  run does not touch, so answering yes for it would promise a replacement
 *  that does not happen. */
function configHasEntry(raw: string | null, site: ConfigSite, entryName: string): boolean {
  return classifyClientConfig(raw, site).entry(entryName) !== undefined;
}

/** Peel `marker.entryName` out of the client config the marker names,
 *  preserving the user's comments. Best-effort; never throws.
 *   - "removed": the entry was present and the file was rewritten.
 *   - "absent":  nothing to do (no file, empty file, entry already gone).
 *   - "failed":  the marker is untrusted, or the file could not be read /
 *                parsed / written. The caller warns and carries on.
 *
 *  With `dryRun`, every check runs but the write does not -- so --dry-run can
 *  promise a removal only when the real run would actually perform one. */
async function peelTrialEntry(
  marker: TrialMarker,
  dryRun = false,
): Promise<"removed" | "absent" | "failed" | "replaced"> {
  if (rejectUntrustedMarker(marker) !== null) return "failed";
  try {
    const outcome = await peelEntryFromConfig(
      marker.clientPath,
      marker.containerPath,
      marker.entryName,
      dryRun,
      marker.entryFingerprint,
    );
    return outcome === "not-object" ? "failed" : outcome;
  } catch {
    return "failed";
  }
}

// NOTE: `computeAnonId` / `loadOrCreateAnonId` / `anonIdPath` used to live
// here. They hashed hostname + username into a durable id under
// ~/.yaw-mcp/trials/.anon purely to populate the anonId of an event body for
// a poster that no longer posts. Deleted rather than left dead so nothing
// re-adopts a machine fingerprint by accident; see the .anon note in the
// file header.

// Resolve the launch shape from the SAME static catalog the website and the
// Yaw Terminal app read (catalog.ts), so `try <slug>` accepts the exact slug
// set the catalog shows. (The old /api/explore/:slug endpoint was never
// deployed -- this is the path that actually works.)
//
// `catalogUrl` is PASSED IN rather than read from process.env here: runTry
// resolves every other env lookup through its injectable `opts.env`, and a
// lone process.env read inside the seam means an embedded caller (or a test)
// that supplies `env` is silently overridden by the ambient environment.
async function defaultFetchExplore(slug: string, catalogUrl?: string): Promise<ExploreServerResponse> {
  const resolved = await resolveCatalogSlug(slug, { catalogUrl });
  const out: ExploreServerResponse = {
    slug: resolved.slug,
    name: resolved.name,
    command: resolved.command,
    args: resolved.args,
    requiredEnvVars: resolved.requiredEnvKeys,
  };
  if (resolved.docUrl) out.docUrl = resolved.docUrl;
  return out;
}

/** Auto-detect which AI client to install the trial into. Probes in the
 *  same order as `yaw-mcp install --list` (claude-code -> claude-desktop ->
 *  cursor -> vscode, per INSTALL_TARGETS -- one slot per client AND scope),
 *  picking the first slot whose config file already EXISTS and could be read
 *  and parsed (probeUsable). Failing that it takes the first client merely
 *  AVAILABLE on this OS, which is always claude-code (the most likely target)
 *  since that is first in INSTALL_TARGETS and ships on every InstallOS.
 *
 *  Readability is part of the gate, not just parseability: the probe reports
 *  a read failure (a directory at ~/.claude.json, EACCES) as `unreadable`,
 *  NOT `malformed`, and filtering on malformed alone picked such a file as
 *  "the client in use" -- after which runTry aborted on the same read the
 *  probe had just watched fail, while a readable ~/.cursor/mcp.json sat one
 *  slot further along.
 *
 *  There is no writability probe: availability is decided by OS, not by
 *  whether the config directory can be written. A client whose directory is
 *  read-only is still selected here and fails later, at the write, with a
 *  path in the message. */
/** The (client, scope) slot `try` should write into. Returning the SCOPE as
 *  well as the id is what keeps the write in the file the probe actually
 *  found: a user with only a committed `.vscode/mcp.json` is detected on the
 *  workspace slot, and answering with the id alone left the caller to guess
 *  the scope from a hardcoded client list. */
async function autoDetectClient(opts: {
  home: string;
  os: InstallOS;
  cwd: string;
  claudeConfigDir: string | undefined;
  /** Every client env var, as `readClientEnv` reported it -- threaded for the
   *  same reason `claudeConfigDir` is, and it was the one consumer that
   *  missed it. `try` RESOLVES its write through `clientEnv` (see
   *  resolveInstallPath below), so probing without it split the two: with
   *  $XDG_CONFIG_HOME set and only Zed configured, the probe looked at
   *  `~/.config/zed/settings.json`, found nothing, and fell through to
   *  claude-code -- while a write to the Zed slot would have gone to the
   *  redirected file the user actually has. */
  clientEnv?: ClientEnvValues;
  appData?: string;
}): Promise<{ clientId: InstallClientId; scope: InstallScope | null }> {
  const probes = await probeClientsAsync({
    home: opts.home,
    os: opts.os,
    cwd: opts.cwd,
    claudeConfigDir: opts.claudeConfigDir,
    clientEnv: opts.clientEnv,
    appData: opts.appData,
  });
  // First: any client whose config file already exists AND whose contents
  // doctor could read (the user is actively using it, and `try` will be able
  // to splice into it).
  for (const p of probes) {
    if (probeUsable(p)) return { clientId: p.clientId, scope: p.scope };
  }
  // Second: any client that's available on this OS (config file not
  // yet created -- we'll create it). claude-code is availableOn every
  // InstallOS (see INSTALL_TARGETS), so it is always present and never
  // `unavailable` -- this loop always returns it (first in probe order)
  // when nothing else matches, which IS the claude-code fallback.
  // Nothing is configured yet, so there is no slot to inherit a scope from:
  // null means 'the caller picks', which is the user-scope preference below.
  for (const p of probes) {
    if (!p.unavailable) return { clientId: p.clientId, scope: null };
  }
  // Unreachable: the loop above always returns (claude-code is available on
  // every OS). Throw rather than return a redundant literal so a future
  // INSTALL_TARGETS change that breaks the invariant fails loud.
  throw new Error("autoDetectClient: no available install client for this OS");
}

export async function runTry(opts: TryCommandOptions): Promise<TryCommandResult> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.slug) {
    printErr(TRY_USAGE);
    return { exitCode: 2, written: [] };
  }
  const slug = opts.slug;
  if (!CATALOG_SLUG_RE.test(slug)) {
    printErr(`yaw-mcp try: invalid slug "${slug}" (lowercase letters, digits, and dashes only).`);
    return { exitCode: 2, written: [] };
  }

  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const os = opts.os ?? CURRENT_OS;
  const now = opts.now ? opts.now() : Date.now();
  // The CLI pre-validates --ttl in parseTryArgs, so only programmatic callers
  // can reach this with an unparseable value -- error out rather than
  // silently substituting the 1h default (which would mask the caller's bug).
  let ttlMs = DEFAULT_TTL_MS;
  if (opts.ttl !== undefined) {
    const parsedTtl = parseDurationMs(opts.ttl);
    if (parsedTtl === null) {
      printErr(`yaw-mcp try: invalid ttl "${opts.ttl}" (cannot parse; try 30m, 1h, 2d).`);
      return { exitCode: 2, written: [] };
    }
    ttlMs = parsedTtl;
  }
  // Every client env var through the ONE reader (empty counts as unset, one
  // rule in one place), so a trial lands in the same file install writes --
  // including a client whose path an env var redirects. `try` used to spell
  // the CLAUDE_CONFIG_DIR rule for itself, which is how two commands come to
  // disagree about whether an empty value relocates anything.
  const clientEnv = readClientEnv(env);
  const claudeConfigDir = clientEnv.claudeConfigDir;
  // Hermetic-home seam: keep the %APPDATA%-based claude-desktop path inside an
  // overridden home, and otherwise read the ambient %APPDATA% so try names the
  // same file install writes. Computed ONCE -- the step-2 probe and the step-3
  // resolve have to agree on it, and spelling the same expression at both sites
  // is how they drift; the shared helper is why it no longer drifts from
  // install-cmd and doctor either.
  const appData = resolveAppDataDir({ home: opts.home, env });

  // Step 1: fetch the canonical launch shape. The catalog override comes from
  // the SAME injectable env every other lookup here uses -- and an EMPTY value
  // counts as unset: `fetch("")` throws a bare TypeError that catalog.ts's
  // friendly wrapper cannot recognize as its own URL, so it is rethrown raw.
  const fetchExplore = opts.fetchExplore ?? defaultFetchExplore;
  const catalogUrl =
    env.YAW_MCP_CATALOG_URL !== undefined && env.YAW_MCP_CATALOG_URL.length > 0 ? env.YAW_MCP_CATALOG_URL : undefined;
  let server: ExploreServerResponse;
  try {
    server = await fetchExplore(slug, catalogUrl);
  } catch (e) {
    // Prefixed like every other message this command prints. It was the one
    // bare line here, so a user reading a piped stderr (or a bug report) could
    // not tell which command produced "no server named x in the catalog".
    printErr(`yaw-mcp try: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }

  // Step 2: pick a client (explicit > auto-detect).
  const detected = opts.clientId
    ? null
    : await autoDetectClient({ home, os, cwd, claudeConfigDir, clientEnv, appData });
  const clientId = opts.clientId ?? (detected as { clientId: InstallClientId }).clientId;

  // Step 3: resolve the config file path (user scope; project scope
  // requires extra flags we don't expose in `try` -- trials are
  // user-scoped by design).
  // Prefer a user scope, falling back to the client's first scope when it has
  // none -- trials are user-scoped by design, and a project-scoped fallback
  // then needs --yes for a secret-bearing entry (step 5b) because that file is
  // commit-to-share config.
  //
  // Derived from the target table rather than from a hardcoded client id: this
  // used to read `clientId === "vscode" ? "project" : "user"`, which was true
  // only while VS Code had no user scope. autoDetectClient returns the id of
  // the first usable probe SLOT, so the moment VS Code gained one, that line
  // would have detected the user slot and then written the workspace file --
  // a different file, possibly in a directory that is not a workspace at all.
  // The slot auto-detect actually found wins. That is what keeps a trial in
  // the file the user is already using -- a repo shipping .vscode/mcp.json
  // and no personal config is detected on the WORKSPACE slot, and writing a
  // trial (possibly carrying an inline token) into a committed file is a
  // hazard step 5b exists to warn about. Deriving the scope from the client
  // id instead would silently move that write to the user file and lose the
  // warning with it.
  //
  // ...but only when the client has NO user scope of its own. Inheriting a
  // project slot unconditionally went too far: claude-code and cursor both
  // have a user scope, so a checkout carrying a committed .mcp.json would
  // put the trial into a commit-to-share file for them too, which is exactly
  // what "trials are user-scoped by design" rules out. A user scope wins
  // whenever one exists; the detected slot decides only for a client that
  // cannot honour that (today: none, after VS Code gained one -- so this is
  // the branch that keeps the rule true if a project-only client is added).
  const tryTarget = INSTALL_TARGETS.find((t) => t.clientId === clientId);
  // A client yaw-mcp cannot configure on this OS is refused HERE, in the same
  // sentence `install` uses, rather than at resolveInstallPath -- whose bare
  // throw reached the user as a resolver internal with nothing to do about
  // it. Exit 2: the argv named a client that cannot work on this machine,
  // which is a usage error, and the same code install's identical refusal
  // returns.
  //
  // The generic fix line is `try`'s own: install offers `--os <os> --dry-run`,
  // a flag pair `try` does not have, so advertising it here would hand the
  // user a command that fails on an unknown flag.
  if (tryTarget && !tryTarget.availableOn.includes(os)) {
    const alternatives = INSTALL_TARGETS.filter((t) => t.availableOn.includes(os)).map((t) => t.clientId);
    printErr(clientUnavailableMessage("try", tryTarget, os, `Pick another client: --client ${alternatives.join("|")}`));
    return { exitCode: 2, written: [] };
  }
  const hasUserScope = tryTarget?.scopes.some((sc) => sc.scope === "user") ?? false;
  const scope: InstallScope = hasUserScope ? "user" : (detected?.scope ?? tryTarget?.scopes[0].scope ?? "user");
  const projectDir = scope === "project" ? resolve(cwd) : undefined;
  // SITES, not a bare path: the file's syntax comes from the row and the scope
  // through this one resolve, so the read and the write below cannot disagree
  // about it. `try` writes exactly ONE file -- the first site, whose `resolved`
  // is byte-for-byte what `resolveInstallPath` returns (asserted in
  // install-targets.test.ts) -- because every message it prints, and the marker
  // it writes, name one path. A fan-out across Cline's per-editor copies is
  // install's behaviour, not a trial's.
  let site: ConfigSite;
  try {
    site = resolveInstallSites({
      clientId,
      scope,
      os,
      home,
      appData,
      projectDir,
      claudeConfigDir,
      // A MODULAR row resolves its own path from these, so a trial written for
      // an env-redirected client lands where that client reads.
      clientEnv,
    })[0];
  } catch (e) {
    printErr(`yaw-mcp try: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }
  const resolved = site.resolved;

  // Step 4: required-env-var check. Anything in requiredEnvVars not
  // supplied via --env AND not in the current process env blocks the
  // trial — silent runtime failure inside the client is worse than a
  // clear "you need to set FOO" up front.
  //
  // A LOOKUP, not a merged object. Spreading `env` into a plain object drops
  // whatever lookup semantics the source had -- and on Windows process.env is
  // case-INSENSITIVE, so a var the user actually stores as `Github_Token`
  // answers to process.env.GITHUB_TOKEN but misses in the copy, and `try`
  // reports a required var missing that is sitting right there in the shell.
  // Reading THROUGH the original object preserves those semantics. Overrides
  // still win on exactly the old spread's terms: an explicit "" from --env
  // shadows the shell value, an absent key falls through to it.
  const lookup = (k: string): string | undefined => opts.envOverrides?.[k] ?? env[k];
  // Trim before the emptiness test so a whitespace-only value (FOO=" ")
  // counts as missing instead of slipping through and writing a blank-ish
  // secret into the trial entry.
  const missing = (server.requiredEnvVars ?? []).filter((k) => (lookup(k) ?? "").trim() === "");
  if (missing.length > 0) {
    printErr(`yaw-mcp try: ${server.name} needs the following env var(s) before it can run:`);
    for (const k of missing) printErr(`  - ${k}`);
    printErr("");
    printErr("Set them via --env KEY=value (repeatable) or your shell, then re-run:");
    const example = missing.map((k) => `--env ${k}=...`).join(" ");
    printErr(`  yaw-mcp try ${slug} ${example}`);
    if (server.docUrl) printErr(`Docs: ${server.docUrl}`);
    return { exitCode: 1, written: [] };
  }

  // Step 5: build the trial entry — upstream-shape, NOT through yaw-mcp.
  // Reuse buildLaunchEntry so the Windows `cmd /c` wrap stays in one
  // place. Only carry the env vars the upstream actually wants (from
  // requiredEnvVars + any --env overrides the user supplied); we don't
  // want to leak every var in the user's shell into the entry.
  //
  // INTENTIONAL DIVERGENCE from `yaw-mcp add` (local-add-cmd.ts:174-190):
  // `add` seeds required keys EMPTY and persists a value ONLY for explicit
  // --env, deliberately NOT copying ambient-shell secrets to disk (yaw-mcp
  // inherits the shell env at spawn time). `try` cannot do that -- the trial
  // entry is upstream-shape and launched DIRECTLY by the client, not through
  // yaw-mcp, so there is no env-inheriting launcher in the path; the resolved
  // value (including an ambient-shell secret) MUST be written inline or the
  // server has no way to see it. The ambientOnlyRequired note below warns the
  // user when a value was sourced from the shell rather than --env.
  const trialEnv: Record<string, string> = {};
  for (const k of server.requiredEnvVars ?? []) {
    // Use the trimmed value so a padded entry doesn't carry surrounding
    // whitespace into the secret (the missing-check above already trims).
    const v = (lookup(k) ?? "").trim();
    if (v) trialEnv[k] = v;
  }
  // Honor any --env overrides for keys NOT in requiredEnvVars too --
  // some servers have optional env knobs (LOG_LEVEL, DATABASE_URL).
  // Trimmed and emptiness-gated on the same terms as the required keys above:
  // `--env LOG_LEVEL=` (or a whitespace-only value) is the user clearing a
  // knob, not asking for a blank one, and persisting "" into the trial entry
  // makes the client launch the server with the var explicitly set to empty --
  // which several upstreams read as "configured" rather than "unset".
  for (const [k, v] of Object.entries(opts.envOverrides ?? {})) {
    if (k in trialEnv) continue;
    const trimmed = v.trim();
    if (trimmed) trialEnv[k] = trimmed;
  }
  // Required keys whose value came from the ambient shell, NOT --env. Unlike
  // `add`, `try` DOES persist these inline (see divergence note above); the
  // note at step 9 tells the user the secret was sourced from their shell so
  // they're aware it now lives in the client config on disk.
  // `!overrides[k]` alone covers both "key absent" and "key present but empty"
  // -- "" is falsy, so the old `|| overrides[k] === ""` disjunct could never
  // add a case the first one had not already caught.
  const overrides = opts.envOverrides ?? {};
  const ambientOnlyRequired = (server.requiredEnvVars ?? []).filter(
    (k) => !overrides[k] && (lookup(k) ?? "").trim() !== "",
  );
  const entry = buildLaunchEntry({
    os,
    upstream: {
      command: server.command,
      args: server.args,
      env: Object.keys(trialEnv).length > 0 ? trialEnv : undefined,
    },
  });
  // The entry as it goes into the FILE: the launch shape above plus whatever
  // the target declares an entry must carry beyond command/args/env for this
  // purpose (`extraFields`, e.g. a startup timeout a client requires). No row
  // declares one today, so this is `{...entry}` on every current target -- but
  // routing the trial entry through the same composer install uses is what
  // keeps a row from having to be true for install and wrong for `try`.
  //
  // Nothing is CARRIED here, deliberately: `carry` and the env fill exist to
  // preserve what a user set on OUR broker entry across a re-install, and a
  // trial entry is a fresh one-shot pointing at someone else's server. Adding
  // a previous trial's fields to it would be inventing state, not preserving
  // it -- so `composeEntry` is called with neither `carried` nor `env`, the
  // way `--force` is.
  const entryToWrite = composeEntry({ base: entry, transform: tryTarget?.entry, os, purpose: "upstream" });
  // Whether the entry carries inline env: every value in it is a credential
  // or a knob the user chose to persist. Decides two things -- the
  // project-scope refusal right below, and the 0600 tightening in step 7.
  const entryHasSecrets = entry.env !== undefined && Object.keys(entry.env).length > 0;

  // Step 5b: refuse to write a secret into a commit-to-share file without an
  // explicit --yes. A project-scope target is per-project config the client
  // expects to be checked in (install-targets.ts labels such a scope
  // "Workspace -- commit to share"), and unlike `add` the trial entry carries
  // its values INLINE (see the divergence note above), so `git add -A` in
  // that repo publishes the credential. The warning prints on stderr either
  // way; --yes lifts only the refusal. It runs BEFORE the --dry-run return
  // so a preview never promises a write the real run declines.
  //
  // Unreachable today, and kept on purpose. Step 3 prefers a user scope
  // whenever the client has one and all six shipped targets do, so `scope`
  // is always "user" by the time control arrives here. It last fired while
  // VS Code was project-only. Keeping it is what makes a project-only client
  // added later refuse rather than silently commit the secret; there is no
  // test that exercises the refusal firing, because no shipped target can
  // reach it -- the sibling suite pins the AVOIDANCE instead (a trial lands
  // in the private user file while a committed .vscode/mcp.json sits beside
  // it, untouched and unwarned about).
  if (scope === "project" && entryHasSecrets) {
    const target = INSTALL_TARGETS.find((t) => t.clientId === clientId);
    const scopeSpec = target?.scopes.find((s) => s.scope === scope);
    const where = `${target?.label ?? clientId}'s ${scopeSpec?.label ?? scope} config`;
    const why = scopeSpec?.description ? ` (${scopeSpec.description})` : "";
    const keys = Object.keys(entry.env ?? {}).join(", ");
    printErr(
      `yaw-mcp try: warning -- ${resolved.absolute} is ${where}${why}, and the trial entry writes ${keys} into it in plaintext. Committing that file publishes the value.`,
    );
    if (!opts.yes) {
      const userScoped = INSTALL_TARGETS.filter(
        (t) => t.availableOn.includes(os) && t.scopes.some((s) => s.scope === "user"),
      ).map((t) => t.clientId);
      printErr(
        `yaw-mcp try: refusing to write it without --yes. Re-run with --yes to accept that (and keep the file out of version control), or target a user-scope client instead: --client ${userScoped.join("|")}`,
      );
      return { exitCode: 1, written: [] };
    }
  }

  const entryName = `${TRIAL_ENTRY_PREFIX}${slug}`;
  const expiresAt = now + ttlMs;
  const marker: TrialMarker = {
    schemaVersion: TRIAL_SCHEMA_VERSION,
    slug,
    name: server.name,
    expiresAt,
    clientPath: resolved.absolute,
    clientName: clientId,
    containerPath: resolved.containerPath,
    entryName,
    createdAt: now,
    // What this run is about to write, so a later sweep can tell this entry
    // from one the user has since put at the same name (see
    // trialLaunchFingerprint). Taken from `entryToWrite` -- the object
    // actually written -- not from `server`, so the Windows `cmd /c` wrap that
    // buildLaunchEntry adds is inside the fingerprint, exactly as it will be
    // read back out of the config.
    entryFingerprint: trialLaunchFingerprint(entryToWrite),
  };

  // Step 6: read existing client config (if any).
  // A missing or empty file reads as `null`, which selects the fresh-render
  // write route below. (Step 7's perms-tightening keys off entryHasSecrets -- see the
  // rationale where tightenPerms is computed: an inline secret must be
  // owner-only whether `try` created the file or merged into the user's
  // pre-existing config. rawClient decides only the write ROUTE:
  // comment-preserving splice vs fresh render.)
  // The read goes THROUGH THE CORE: one reader for every syntax, and the
  // entry-level question below ("is there already something at this name")
  // answered by the VIEW rather than by a container walk here. The VIEW itself
  // is retained, not just the bytes, because it is what the write facade edits
  // -- and that facade preserves the user's `//` and `/* */` comments, which a
  // read-modify-write through JSON.parse + JSON.stringify would silently strip
  // (~/.claude.json on Claude Code carries user comments routinely).
  //
  // Broken out into a closure because step 6b's cross-client peel can rewrite
  // THIS file: when it does, the view read here is stale and both the read and
  // the splice have to be redone against the post-peel file.
  const readClientView = async (): Promise<{ ok: true; view: ClientConfigView } | { ok: false }> => {
    const view = await readClientConfigFile(site);
    const read = view.read;
    // Read and parse are reported SEPARATELY. Folding them into one catch
    // told a user whose ~/.claude.json is root-owned or 0600-another-user
    // that their JSON was invalid ("is not valid JSON (EACCES: permission
    // denied...)"), sending them to inspect a file they cannot even read
    // instead of to the permissions. Same shape for EISDIR.
    if (read.kind === "unreadable") {
      // A DIRECTORY at the path is not a permissions problem, and the
      // permissions-and-ownership advice sends the user nowhere on one. The
      // shared helper says what `add`, `install` and `uninstall` all say for
      // that shape, and keeps the errno wording for every other read failure,
      // which is what a real permissions problem needs.
      printErr(
        read.code === "EISDIR"
          ? `${describeUnreadableConfig("try", resolved.absolute, { code: read.code, message: read.message })} Refusing to overwrite.`
          : `yaw-mcp try: ${resolved.absolute} could not be read (${read.code ?? read.message}) -- check its permissions and ownership. Refusing to overwrite.`,
      );
      return { ok: false };
    }
    // `read.syntax` is the adapter's own name for the file's language, so a
    // non-JSON client would say what it actually is. Every client `try` can
    // target today is JSON-family, where that name is "JSON" -- these two
    // lines are byte-for-byte what they printed before.
    if (read.kind === "malformed") {
      printErr(
        read.reason === "root"
          ? `yaw-mcp try: ${resolved.absolute} is not a ${read.syntax} object — refusing to overwrite.`
          : `yaw-mcp try: ${resolved.absolute} is not valid ${read.syntax} (${read.detail}). Refusing to overwrite.`,
      );
      return { ok: false };
    }
    return { ok: true, view };
  };

  const firstRead = await readClientView();
  if (!firstRead.ok) return { exitCode: 1, written: [] };

  // Is there already an entry at this exact name in this exact file? A re-run
  // for a wired slug simply spliced over it: same file, same key, and the
  // nudge said "Trial wired" as though nothing had been there -- so a user
  // re-running with a different --ttl or --env had no signal that the previous
  // wiring, and the inline secret in it, was gone. Read from the config rather
  // than inferred from the marker: the marker can name an entry a user has
  // already deleted by hand, and the file is what the splice will actually
  // overwrite.
  const replacesEntryInPlace = configHasEntry(firstRead.view.raw, site, entryName);

  // If a previous trial of the same slug is wired, overwrite it (the
  // user is re-running `try`, presumably with a different --ttl or env).
  // We never collide with the canonical "yaw-mcp" entry — trials
  // live under their own `yaw-mcp-try-<slug>` name.
  //
  // ONE write route: `applyClientConfigEdits`, which is the only exported way
  // to obtain edited client-config text and therefore the only one that
  // VERIFIES it -- the entry reads back as written, no neighbour moved or
  // changed, nothing else in the document differs, and a file its client
  // cannot load is refused rather than added to. A file that does not exist is
  // rendered fresh by the same call, container chain and all, byte-identical
  // to the JSON.stringify render this replaces (pinned in
  // client-config-json.test.ts). A file that does exist is spliced into its
  // original bytes, so the user's comments survive.
  const buildClientJson = (view: ClientConfigView): { ok: true; json: string } | { ok: false } => {
    try {
      // The facade leaves the user's bytes alone outside what it splices, so a
      // file that already ends in a newline keeps exactly the one it had; one
      // that does not is given one here.
      const edits = [{ op: "upsert" as const, key: entryName, entry: entryToWrite }];
      return { ok: true, json: terminateWithNewline(applyClientConfigEdits(view, edits, site)) };
    } catch (e) {
      printErr(
        `yaw-mcp try: failed to splice entry into ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
      );
      return { ok: false };
    }
  };

  const firstSplice = buildClientJson(firstRead.view);
  if (!firstSplice.ok) return { exitCode: 1, written: [] };
  let clientJson = firstSplice.json;
  const markerJson = `${JSON.stringify(marker, null, 2)}\n`;

  // Step 6b: the marker path is keyed on SLUG alone (trials/<slug>.json), so a
  // re-run of the same slug against a DIFFERENT --client is about to overwrite
  // the only record of the previous wiring. Left alone, that entry -- inline
  // secret and all -- stays in the old client config forever: `try-cleanup`
  // reads only the current marker and doctor's GC only walks markers, so
  // nothing would ever name it again. Peel it out first, best-effort.
  //
  // The marker is read BEFORE the dry-run return so the preview can name the
  // removal too: a --dry-run that omits a write the real run performs is
  // exactly the report a user consults --dry-run to avoid.
  const previousRead = await readTrialMarker(trialMarkerPath(slug, home));
  const previousMarker = previousRead?.marker ?? null;
  const peelsPrevious =
    previousMarker !== null &&
    (previousMarker.clientPath !== resolved.absolute || previousMarker.entryName !== entryName);
  // The real peel routes through peelTrialEntry, whose FIRST act is to refuse
  // an untrusted marker (a non-`yaw-mcp-try-*` entryName, or a schemaVersion
  // from a newer yaw-mcp). The preview has to consult the same gate or it
  // promises a removal the real run declines -- which is the one thing a
  // --dry-run must never do.
  const previousRefusal = previousMarker === null ? null : rejectUntrustedMarker(previousMarker);

  if (opts.dryRun) {
    print(`yaw-mcp try (dry-run): would write ${resolved.absolute}`);
    print(`  entry name: ${entryName}`);
    print(`  command:    ${entry.command} ${entry.args.join(" ")}`);
    if (entry.env) print(`  env keys:   ${Object.keys(entry.env).join(", ")}`);
    print(`  expires:    ${new Date(expiresAt).toISOString()}`);
    print(`  marker:     ${trialMarkerPath(slug, home)}`);
    if (replacesEntryInPlace) {
      print(`  would replace: the existing ${entryName} entry in ${resolved.absolute}`);
    }
    if (previousMarker && peelsPrevious) {
      if (previousRefusal !== null) {
        print(
          `  would NOT remove: the previous ${slug} marker ${previousRefusal} -- remove that entry from ${previousMarker.clientPath} by hand`,
        );
      } else {
        // Every check the real peel runs, minus the write -- and run ONCE, so
        // the two branches below cannot describe two different reads of the
        // same file. Naming the removal on the STRENGTH of the
        // clientPath/entryName comparison alone over-promised: when that file
        // (or that entry inside it) is already gone, the real run's peel
        // returns "absent" and prints nothing at all. An "absent"/"failed"
        // preview therefore stays quiet too, which is the direction --dry-run
        // is allowed to be wrong in.
        const previewOutcome = await peelTrialEntry(previousMarker, true);
        if (previewOutcome === "removed") {
          print(
            `  would remove: the previous ${slug} trial (${previousMarker.entryName}) from ${previousMarker.clientPath}`,
          );
        } else if (previewOutcome === "replaced") {
          print(
            `  would NOT remove: the previous ${slug} trial's entry (${previousMarker.entryName}) in ${previousMarker.clientPath} is no longer the one the trial wrote`,
          );
        }
      }
    }
    return { exitCode: 0, written: [], marker };
  }

  // Set when step 6b tried to peel a marker it TRUSTED and the peel failed
  // anyway (an unreadable / unparseable / unwritable old client file). The
  // previous entry is then STILL LIVE, so the rollback in step 7 has to put its
  // marker back rather than unlink it -- see the comment there. Deliberately
  // NOT set for an untrusted or newer-schema marker: peelTrialEntry reports
  // those as "failed" too, but it refused them before touching anything and
  // every other consumer refuses them as well, so restoring one would only
  // re-arm a marker nothing on disk will ever act on.
  let previousPeelFailedWhileTrusted = false;
  if (previousMarker && peelsPrevious) {
    const outcome = await peelTrialEntry(previousMarker);
    if (outcome === "removed") {
      print(`Removed the previous ${slug} trial (${previousMarker.entryName}) from ${previousMarker.clientPath}`);
      if (previousMarker.clientPath === resolved.absolute) {
        // Same file, different entry name (a hand-edited or renamed marker):
        // the peel just rewrote the bytes the splice above was built from, so
        // writing that stale render would re-insert the entry we just removed.
        // Re-read and re-splice against the post-peel file.
        const reread = await readClientView();
        if (!reread.ok) return { exitCode: 1, written: [] };
        const respliced = buildClientJson(reread.view);
        if (!respliced.ok) return { exitCode: 1, written: [] };
        clientJson = respliced.json;
      }
    } else if (outcome === "replaced") {
      // The previous trial's key now holds something else -- the user kept the
      // name and pointed it at their own server. Leaving it is the whole point
      // of the fingerprint; saying so is what stops it reading as a silent
      // no-op. The marker is not restored on a later rollback either (see
      // previousPeelFailedWhileTrusted): nothing of OURS is wired there any
      // more, so there is nothing for a marker to name.
      printErr(
        `yaw-mcp try: the previous ${slug} trial's entry (${previousMarker.entryName}) in ${previousMarker.clientPath} is no longer the one the trial wrote, so it was left alone.`,
      );
    } else if (outcome === "failed") {
      previousPeelFailedWhileTrusted = previousRefusal === null;
      printErr(
        `yaw-mcp try: warning -- couldn't remove the previous ${slug} trial (${previousMarker.entryName}) from ${previousMarker.clientPath}. Remove that entry by hand; the marker below no longer points at it.`,
      );
    }
  }

  // Step 7: write everything atomically. Order: marker first, then client
  // config. Rationale: if the process CRASHES between the two writes (where
  // the catch-block rollback below cannot run), a sweepable marker is left
  // behind so doctor's GC can reclaim it. On a CAUGHT client-write failure we
  // do NOT rely on that -- the catch rolls the marker back (see below) so
  // doctor never sees a trial whose launch entry was never written. "Rolls
  // back" is not always "unlinks": on a same-target re-run the marker we are
  // about to overwrite still names a LIVE entry, so it is restored, not
  // deleted.
  const written: string[] = [];
  try {
    await mkdir(trialsDir(home), { recursive: true });
    await atomicWriteFile(trialMarkerPath(slug, home), markerJson);
    written.push(trialMarkerPath(slug, home));
  } catch (e) {
    printErr(`yaw-mcp try: failed to write trial marker: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }

  // When the launch entry carries inline env (secrets), the written config
  // must be owner-only (0600) -- whether `try` created the file or merged the
  // entry into the user's pre-existing config. We just wrote a plaintext
  // credential into it, and atomicWriteFile renames a fresh tmp over the
  // target (a new inode), so without an explicit mode the file would be born
  // at the umask default (~0644) with the secret world-readable. No-op on
  // Windows (POSIX perms don't apply).
  //
  // The false branch passes `undefined`, which is NOT "born 0644": that is
  // atomicWriteFile's preserve-the-target's-mode path. A no-secret trial (or a
  // try-cleanup / doctor GC pass) must never widen a config that is already
  // 0600 -- it may hold ANOTHER trial's inline secret, or the user may simply
  // have tightened it by hand. Only a genuinely new file lands at the umask
  // default.
  const tightenPerms = entryHasSecrets && (opts.platform ?? process.platform) !== "win32";
  try {
    // Born-0600 on the create path closes the TOCTOU window where a 0644
    // file with secrets exists between rename and the post-hoc chmod.
    await atomicWriteFile(resolved.absolute, clientJson, "utf8", tightenPerms ? 0o600 : undefined);
    written.push(resolved.absolute);
    // Belt-and-suspenders chmod normalizes any umask masking applied to the
    // born mode above (e.g. a umask that widened 0600 -> nothing extra, but
    // this pins it exactly to owner-only).
    if (tightenPerms) {
      try {
        await chmod(resolved.absolute, 0o600);
      } catch {
        // chmod best-effort -- the trial still works at default perms.
      }
    }
  } catch (e) {
    printErr(`yaw-mcp try: failed to write ${resolved.absolute}: ${(e as Error).message}`);
    // Best-effort marker rollback so doctor doesn't think a trial is
    // active when its launch entry was never written.
    //
    // On a re-run that targets the SAME client file and entry name, though,
    // unlinking is the wrong rollback: the marker we just overwrote named the
    // PREVIOUS run's entry, which is still live in the file this write failed
    // on -- inline secret and all -- and that marker was the only thing on
    // disk naming it. Deleting it strands the entry beyond the reach of both
    // `try-cleanup` ("no trial marker ... nothing to do") and doctor's GC.
    // Put the previous bytes back instead. When the previous marker named a
    // DIFFERENT file or entry, step 6b normally peeled it, so there is nothing
    // left for a restored marker to point at -- unlink stays right there, as
    // it does for a first run with no previous marker at all. But that peel is
    // best-effort: on a trusted marker whose old client file could not be read,
    // parsed, or written, it returned "failed" and the previous entry is STILL
    // wired, so its marker has to come back here too. (An untrusted or
    // newer-schema marker is excluded -- see previousPeelFailedWhileTrusted.)
    //
    // The restore writes to the same disk that just failed us, so it is
    // best-effort on the same terms as the unlink, and passes no explicit mode
    // -- atomicWriteFile's preserve-the-target path is what a marker wants.
    if (previousRead !== null && (!peelsPrevious || previousPeelFailedWhileTrusted)) {
      await atomicWriteFile(trialMarkerPath(slug, home), previousRead.raw).catch(() => undefined);
    } else {
      await unlink(trialMarkerPath(slug, home)).catch(() => undefined);
    }
    return { exitCode: 1, written: [] };
  }

  // Step 9: nudge. The keep-it path is local (`add` writes the server into
  // ~/.yaw-mcp/bundles.json) -- there is no account and no signup page.
  const ttlPretty = formatTtl(ttlMs);
  // `entryName`, not a rebuilt literal: the name printed here has to be the
  // name actually written, or a change to TRIAL_ENTRY_PREFIX makes this line
  // lie about what is in the file.
  // Above the nudge, because it is about the state the nudge describes: the
  // entry that was there is gone, and if it carried its own inline value that
  // value went with it.
  if (replacesEntryInPlace) {
    print(`Replaced the existing ${entryName} entry in ${resolved.absolute}`);
  }
  print(`Trial wired: ${server.name} via ${entryName} -> ${resolved.absolute}`);
  // "Expires in Nh" alone read as a timer. Nothing sweeps on a schedule: the
  // TTL is only consumed by gcExpiredTrials, which runs from `yaw-mcp doctor`
  // and nowhere else. A user who never runs doctor keeps the entry -- and its
  // inline secret -- wired indefinitely, so say what actually reclaims it.
  print(
    `Expires in ${ttlPretty}, then swept by the next \`yaw-mcp doctor\` run; remove it now with: yaw-mcp try-cleanup ${slug}`,
  );
  print(`Liking it? Keep ${server.name} for good with: yaw-mcp add ${slug}`);

  // If a required key was satisfied by the ambient shell (not --env), its
  // value was copied INTO the trial entry on disk (unlike `add`, which seeds
  // it empty). Warn on stderr so the user knows a shell-resident secret was
  // persisted to the client config.
  if (ambientOnlyRequired.length > 0) {
    printErr(
      `Note: ${ambientOnlyRequired.join(", ")} ${
        ambientOnlyRequired.length === 1 ? "was" : "were"
      } read from your shell env and written into the trial entry at ${resolved.absolute}. Remove the trial with: yaw-mcp try-cleanup ${slug}`,
    );
  }
  return { exitCode: 0, written, marker };
}

/** Both ends must be a TTY: stdin to read the answer, stdout to show the
 *  question. Same predicate, and the same test seams, as `remove` and `set`. */
function isInteractive(opts: TryCleanupOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Ask the confirmation. Defaults to NO -- a bare Enter, a stray keystroke, or
 *  EOF (^D, a piped stdin running dry) leaves the client config alone.
 *  questionOrEmpty is what makes EOF an answer at all: a bare rl.question()
 *  never settles once its input closes. */
async function askYesNo(opts: TryCleanupOptions, question: string): Promise<string | QuestionCancelled> {
  if (opts.promptAnswer !== undefined) return opts.promptAnswer.trim().toLowerCase();
  const input = opts.io?.stdin ?? process.stdin;
  const output = opts.io?.stdout ?? process.stdout;
  const rl = createInterface({ input, output, terminal: opts.io?.terminal });
  try {
    const raw = await questionOrEmpty(rl, question);
    // Ctrl+C is not "no": it is the user leaving, and the exit code says so.
    return raw === QUESTION_CANCELLED ? raw : raw.trim().toLowerCase();
  } finally {
    rl.close();
  }
}

export async function runTryCleanup(opts: TryCleanupOptions): Promise<TryCommandResult> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.slug) {
    printErr(TRY_CLEANUP_USAGE);
    return { exitCode: 2, written: [] };
  }
  const slug = opts.slug;
  if (!CATALOG_SLUG_RE.test(slug)) {
    printErr(`yaw-mcp try-cleanup: invalid slug "${slug}".`);
    return { exitCode: 2, written: [] };
  }

  const home = opts.home ?? homedir();
  const markerPath = trialMarkerPath(slug, home);

  if (!existsSync(markerPath)) {
    print(`yaw-mcp try-cleanup: no trial marker for "${slug}" (nothing to do).`);
    return { exitCode: 0, written: [] };
  }

  let marker: TrialMarker;
  try {
    // The SAME field checks readTrialMarker applies, from the same helper --
    // spelled out separately here, the two drifted (this one checked entryName
    // alone for a while, which let a marker with no clientPath through).
    // assertTrialMarkerShape throws a message, which is what this catch needs
    // and readTrialMarker's own catch discards.
    const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    assertTrialMarkerShape(parsed);
    marker = parsed;
  } catch (e) {
    printErr(`yaw-mcp try-cleanup: marker at ${markerPath} is unreadable (${(e as Error).message}).`);
    return { exitCode: 1, written: [] };
  }

  // Everything below deletes marker.entryName at marker.containerPath from
  // marker.clientPath -- three values read straight out of a file on disk. A
  // marker we did not write (hand-edited, corrupted, or produced by a newer
  // yaw-mcp) could therefore name ANY key in ANY JSON file. Refuse instead of
  // acting; the user deletes the marker by hand.
  const rejection = rejectUntrustedMarker(marker);
  if (rejection) {
    printErr(`yaw-mcp try-cleanup: marker at ${markerPath} ${rejection} -- refusing to edit ${marker.clientPath}.`);
    printErr(`  Delete it by hand if it is stale: ${markerPath}`);
    return { exitCode: 1, written: [] };
  }

  // ----- destructive-action confirmation --------------------------------
  // This rewrites a file the user's AI client launches from, which is the
  // same class of write `install` prompts over and `remove` shows a preview
  // for -- try-cleanup was the last one doing it on the bare verb. Gated on
  // there BEING a trial to remove: the no-marker case above already returned
  // exit 0, so a cleanup script that runs this unconditionally still no-ops
  // rather than starting to refuse.
  if (!opts.force) {
    print("");
    print(`  Remove the "${slug}" trial:`);
    print("");
    print(`    entry:  ${marker.entryName}`);
    print(`    from:   ${marker.clientPath}`);
    print(`    marker: ${markerPath}`);
    print("");
    print("  The entry stops launching, and any value stored inline on it goes");
    print("  with it. Your other entries in that file are untouched.");
    print("");
    if (!isInteractive(opts)) {
      // Exit 2, the code every off-TTY confirmation refusal in this CLI uses
      // (`remove`, `set`, `uninstall`, `secrets remove`).
      printErr(
        `yaw-mcp try-cleanup: refusing to edit ${marker.clientPath} without a confirmation -- stdin/stdout is not a TTY.`,
      );
      printErr("  Re-run with --force (or -y) to remove it.");
      return { exitCode: 2, written: [] };
    }
    const answer = await askYesNo(opts, `  Remove "${marker.entryName}"? [y/N] `);
    if (answer === QUESTION_CANCELLED) {
      printErr("yaw-mcp try-cleanup: Cancelled. Nothing was removed.");
      return { exitCode: 130, written: [] };
    }
    if (answer !== "y" && answer !== "yes") {
      printErr("yaw-mcp try-cleanup: Aborted. Nothing was removed.");
      return { exitCode: 1, written: [] };
    }
  }

  // Peel the entry out of the client config (no-op if already gone). Routed
  // through the client-config core's write facade so user comments in the
  // client config survive -- a JSON.parse + JSON.stringify pass would silently
  // strip them -- and so the removal is VERIFIED before anything is persisted.
  const written: string[] = [];
  /** Set when the entry at the marker's name turned out to be someone else's
   *  work, so the closing line does not claim a cleanup that did not happen. */
  let leftReplacedEntry = false;
  try {
    const outcome = await peelEntryFromConfig(
      marker.clientPath,
      marker.containerPath,
      marker.entryName,
      false,
      marker.entryFingerprint,
    );
    if (outcome === "replaced") {
      leftReplacedEntry = true;
      // The key is the user's now -- they kept the trial's name and pointed it
      // at something else. Leave it, and still drop the marker: what the
      // marker described is gone, and keeping it would make doctor report an
      // expired trial forever over an entry nothing here will ever remove.
      printErr(
        `yaw-mcp try-cleanup: ${marker.entryName} in ${marker.clientPath} is no longer the entry this trial wrote -- it was replaced, so it has been left alone.`,
      );
      printErr("  Remove it by hand if you no longer want it.");
    } else if (outcome === "removed") {
      written.push(marker.clientPath);
      print(`Removed ${marker.entryName} from ${marker.clientPath}`);
    } else if (outcome === "not-object") {
      // Valid JSON that is not an object (an array, a string, a number): there
      // is no container the entry could be named in, so no peel is possible.
      // SAY so. Skipping it silently and then printing "cleaned
      // up" is the same false all-clear over a plaintext credential that the
      // GC was fixed to refuse -- the user reads "cleaned up", and the entry
      // is still wired.
      printErr(
        `yaw-mcp try-cleanup: warning -- couldn't strip ${marker.entryName} from ${marker.clientPath} (${marker.clientPath} is not a JSON object).`,
      );
    }
  } catch (e) {
    printErr(
      `yaw-mcp try-cleanup: warning -- couldn't strip ${marker.entryName} from ${marker.clientPath} (${(e as Error).message}).`,
    );
    // Continue -- still drop the marker so doctor stops surfacing it.
  }

  // Drop the marker.
  try {
    await unlink(markerPath);
  } catch (e) {
    printErr(`yaw-mcp try-cleanup: couldn't delete marker ${markerPath} (${(e as Error).message}).`);
    return { exitCode: 1, written: [] };
  }

  // "cleaned up" would over-claim on the replaced path: the marker is gone,
  // but the entry at that name is still wired -- deliberately, because it is
  // the user's. Say which of the two happened.
  print(
    leftReplacedEntry
      ? `Trial marker for "${slug}" removed; the entry at ${marker.entryName} was left in place.`
      : `Trial for "${slug}" cleaned up.`,
  );
  return { exitCode: 0, written };
}

/** Pretty-print a TTL in ms as `Nh`, `Nm`, or `Nd` for the nudge.
 *
 *  Floor, never round: both surfaces that render this ("Expires in Nh" in the
 *  try nudge, "expires in Nh" in doctor's TRIALS section) read as a precise
 *  expiry, and rounding UP overstates the time left -- 90m printed as "2h"
 *  told the user they had half an hour they did not have. Flooring can only
 *  understate, which is the safe direction for a deadline. */
export function formatTtl(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.floor(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.floor(clamped / 60_000)}m`;
  if (clamped < 86_400_000) return `${Math.floor(clamped / 3_600_000)}h`;
  return `${Math.floor(clamped / 86_400_000)}d`;
}

/** Doctor-side: list every trial marker on disk and classify expired vs live.
 *  Returns a structured summary so doctor can render it inline. Sweeping the
 *  expired ones is gcExpiredTrials' job, not this function's -- scanTrials
 *  takes no GC flag and has no side effects. */
export interface TrialScanEntry {
  marker: TrialMarker;
  /** Absolute path of the scanned marker file. GC must unlink THIS path --
   *  not trialMarkerPath(marker.slug) -- so a marker whose filename doesn't
   *  match its slug field is still reclaimed instead of re-failing forever. */
  path: string;
  /** ms until expiry; negative when already expired. */
  msUntilExpiry: number;
  expired: boolean;
}

export interface TrialScanResult {
  live: TrialScanEntry[];
  expired: TrialScanEntry[];
  /** Markers that exist on disk but failed to parse — surface so doctor
   *  can tell the user to delete them by hand. */
  malformed: string[];
}

export async function scanTrials(opts: { home?: string; now?: () => number } = {}): Promise<TrialScanResult> {
  const home = opts.home ?? homedir();
  const now = opts.now ? opts.now() : Date.now();
  const dir = trialsDir(home);
  const result: TrialScanResult = { live: [], expired: [], malformed: [] };
  if (!existsSync(dir)) return result;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }
  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    const path = join(dir, filename);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as TrialMarker;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.slug !== "string" ||
        typeof parsed.expiresAt !== "number" ||
        typeof parsed.clientPath !== "string" ||
        // Not consumed by the peel, but doctor PRINTS it verbatim ("demo ->
        // claude-code (expires in 42m)"), so a hand-rolled marker without it
        // renders as "demo -> undefined". Malformed is the honest reading of a
        // marker missing a field every writer of ours fills in.
        typeof parsed.clientName !== "string" ||
        !Array.isArray(parsed.containerPath) ||
        typeof parsed.entryName !== "string" ||
        // Same trust check runTryCleanup applies: the GC deletes these three
        // fields' worth of state from a file named by the marker itself, so a
        // marker naming a non-trial entry -- or written by a schema we don't
        // understand -- is surfaced as malformed for the user rather than
        // acted on.
        rejectUntrustedMarker(parsed) !== null
      ) {
        result.malformed.push(path);
        continue;
      }
      const msUntilExpiry = parsed.expiresAt - now;
      const expired = msUntilExpiry <= 0;
      const entry: TrialScanEntry = { marker: parsed, path, msUntilExpiry, expired };
      if (expired) result.expired.push(entry);
      else result.live.push(entry);
    } catch {
      result.malformed.push(path);
    }
  }
  return result;
}

/** Sweep expired trials: peel each one out of its client config and delete
 *  the marker. Best-effort — failures on individual entries don't abort the
 *  sweep. Returns the count cleared so doctor can report it. */
export async function gcExpiredTrials(opts: {
  home?: string;
  now?: () => number;
  /** Precomputed scan to sweep. When omitted, gcExpiredTrials scans itself.
   *  doctor passes the scan it already needs for readout so the trials dir
   *  is scanned once per invocation instead of once here + once for readout. */
  scan?: TrialScanResult;
}): Promise<{ cleared: number; failed: number; failures: TrialGcFailure[] }> {
  const home = opts.home ?? homedir();
  const scan = opts.scan ?? (await scanTrials({ home, now: opts.now }));
  if (scan.expired.length === 0) return { cleared: 0, failed: 0, failures: [] };

  let cleared = 0;
  const failures: TrialGcFailure[] = [];
  for (const { marker, path } of scan.expired) {
    // Which step blew up decides what the user is told: a failed PEEL means
    // the entry is still wired into the client config; a failed UNLINK means
    // the config is already clean and only the marker lingers.
    let stage: TrialGcFailure["stage"] = "peel";
    try {
      // Routed through the client-config core (inside the shared peel) so user
      // comments in the client config survive doctor's GC pass -- the previous
      // JSON.parse + JSON.stringify shape silently stripped them.
      const outcome = await peelEntryFromConfig(
        marker.clientPath,
        marker.containerPath,
        marker.entryName,
        false,
        marker.entryFingerprint,
      );
      if (outcome === "replaced") {
        // The entry at that name is not the one this trial wrote: the user
        // kept the key and pointed it at their own server. The sweep used to
        // delete it -- their work, silently, on a timer.
        //
        // Reported as a failure so doctor SAYS so once (it renders every
        // failure through trialGcFailureWarning), and the marker is unlinked
        // anyway: what it described is gone, and keeping it would re-report
        // the same non-event on every sweep forever -- the exact never-clears
        // loop the not-object branch below was written to avoid.
        stage = "replaced";
        // Unlinked in its OWN catch, not the loop's: a failure here leaves the
        // marker on disk, and the surrounding catch would then report the
        // errno under stage "replaced" -- whose wording promises the marker
        // WAS removed. Falling back to stage "unlink" is no better (that line
        // says the entry was removed, and it deliberately was not), so this
        // one keeps its own message.
        let markerRemoved = true;
        try {
          await unlink(path);
        } catch {
          markerRemoved = false;
        }
        failures.push({
          slug: marker.slug,
          clientPath: marker.clientPath,
          markerPath: path,
          stage,
          // The WHOLE sentence, because the two cases differ in what actually
          // happened -- see trialGcFailureWarning, which prints this verbatim
          // for stage "replaced" rather than adding a tail that could contradict it.
          error: markerRemoved
            ? `${marker.entryName} in ${marker.clientPath} was replaced since the trial wrote it, so it was left in place; the expired trial marker was deleted -- remove that entry by hand if you do not want it`
            : `${marker.entryName} in ${marker.clientPath} was replaced since the trial wrote it, so it was left in place; its marker ${path} could not be deleted either, so this will be reported again -- delete that marker by hand`,
        });
        continue;
      }
      if (outcome === "not-object") {
        // Valid JSON, but not an object (an array, a string, a number): there
        // is no container the entry could be named in, so the peel cannot
        // happen. Fail LOUDLY rather than falling through to
        // the unlink -- dropping the marker here would leave the trial
        // entry wired with nothing on disk that could ever name it again.
        // Throwing keeps stage "peel", which is what the user needs told.
        throw new Error(`${marker.clientPath} is not a JSON object`);
      }
      // Unlink the file that was actually scanned -- deriving the path from
      // marker.slug would orphan a marker whose filename mismatches its slug.
      stage = "unlink";
      await unlink(path);
      cleared++;
    } catch (e) {
      const error = (e as Error).message;
      log("debug", "trial gc failed", { slug: marker.slug, stage, error });
      failures.push({ slug: marker.slug, clientPath: marker.clientPath, markerPath: path, stage, error });
    }
  }
  return { cleared, failed: failures.length, failures };
}

/** One expired trial the sweep could not finish. Surfaced by doctor (text,
 *  --json, and the warnings that drive exit 2) with enough detail to act
 *  on: which slug, which file, and which step failed. */
export interface TrialGcFailure {
  slug: string;
  clientPath: string;
  markerPath: string;
  /** "peel": the entry is STILL in the client config. "unlink": the config
   *  is clean; only the marker file could not be deleted. "replaced": the
   *  entry at that name is not the one the trial wrote, so it was deliberately
   *  left alone (the marker WAS removed) -- not a failure of the sweep so much
   *  as a thing the user needs told once. */
  stage: "peel" | "unlink" | "replaced";
  error: string;
}

/** The doctor-facing wording for one gc failure, shared by the text TRIALS
 *  section, the --json warnings, and the stderr warning stream so all three
 *  surfaces say the same thing and gate exit 2 identically. */
export function trialGcFailureWarning(f: TrialGcFailure): string {
  // Printed verbatim: the replaced case has two outcomes (marker deleted or
  // not), and a tail appended here could only be right for one of them.
  if (f.stage === "replaced") return `trial "${f.slug}": ${f.error}`;
  return f.stage === "unlink"
    ? `trial "${f.slug}": its entry was removed from ${f.clientPath}, but the marker ${f.markerPath} could not be deleted (${f.error}) -- delete that marker by hand`
    : `trial "${f.slug}": expired but could not be removed from ${f.clientPath} (${f.error}) -- still wired in; run \`yaw-mcp try-cleanup ${f.slug}\` or edit that file by hand`;
}
