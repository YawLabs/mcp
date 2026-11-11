// `yaw-mcp add <slug>` / `remove <slug>` / `list`
//
// These manage the LOCAL server set in ~/.yaw-mcp/bundles.json -- the file
// yaw-mcp loads its servers from. This is deliberately distinct from
// `yaw-mcp install <client>`, which wires the yaw-mcp aggregator INTO an AI
// client's config. "install" connects a client; "add" adds a server.
//
//   add <slug>     resolve <slug> from the yaw.sh/mcp catalog and write it
//                  into ~/.yaw-mcp/bundles.json
//   remove <slug>  drop a server (by slug or namespace) from bundles.json
//   list           show the servers yaw-mcp would load locally, each with the
//                  compliance grade `yaw-mcp audit` last cached for it
//
// `add` resolves through the same static catalog the website and the Yaw
// Terminal app use (catalog.ts), so a slug that works as an "Add to Yaw MCP"
// button works here too.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CATALOG_SLUG_RE, ENV_KEY_RE, type FetchCatalog, resolveCatalogSlug, tokenizeCommand } from "./catalog.js";
import { readClientEnv } from "./client-config.js";
import { probeClientsAsync } from "./doctor-cmd.js";
import { scriptConsentConfirm } from "./git-consent-prompt.js";
import {
  asciiLines,
  buildGitSource,
  discardUnpinnedBuild,
  GIT_MISSING_MESSAGE,
  type GitBuildContext,
  type GitManifest,
  type GitPinnedBuild,
  type GitSpec,
  gitAvailable,
  gitCheckoutDir,
  gitLivenessWarning,
  normalizeRepoUrl,
  parseGitSpec,
  planGitRemoval,
  prepareGit,
  printable,
  recordGitPin,
  redactGitOutput,
  removeGitCheckout,
  resolveGitRef,
  treeSizeBytes,
} from "./git-source.js";
import { type GradesCache, readGradesCache } from "./grades-cache.js";
import { CURRENT_OS, resolveAppDataDir } from "./install-targets.js";
// The removal gate must see the same files the WRITE path can modify, so it
// parses with the loader's JSONC parser (comments + trailing commas) rather
// than a stricter JSON.parse. See findRemovalTarget.
import { parseJsonc } from "./jsonc.js";
import {
  BundleCollisionError,
  deriveNamespace,
  findShadowingProjectBundles,
  formatBundleCollision,
  gitNodeCommand,
  HTTP_HEADER_NAME_RE,
  isRemoteEntry,
  type LaunchChange,
  loadLocalBundles,
  localBundlesPath,
  namespacesForStoredIdentity,
  previewUpsertUserBundle,
  RESERVED_HEADER_NAMES,
  rawEntryLoads,
  relativeSegments,
  removeUserBundle,
  STORED_TARGET_RE,
  type UpsertOrigin,
  unsafeRelativePathReason,
  upsertUserBundle,
} from "./local-bundles.js";
import { createStreamWriter } from "./logger.js";
import { CONFIG_DIRNAME, findProjectConfigDir, userConfigDir } from "./paths.js";
import { askYesNo, QUESTION_CANCELLED } from "./readline-question.js";
import { runSecrets, type SecretsCommandOptions } from "./secrets-cmd.js";
import {
  collectMalformedSecretRefs,
  collectSecretRefNames,
  listKeys,
  loadVault,
  SECRET_NAME_RE,
  vaultPath,
} from "./secrets-vault.js";
import { TransientConnectError, withTransientUpstream } from "./transient-upstream.js";
// The removal preview renders command / args / url / name straight out of
// bundles.json immediately above a [y/N] prompt, so it needs the same
// control-byte neutering the `trust` gate uses. IMPORTED, never re-spelled:
// a second hand-rolled copy of that escape logic would drift from the one
// trust-cmd's tests actually cover.
import { displayArg, displaySafe } from "./trust-cmd.js";
import type { GitSource, UpstreamServerConfig } from "./types.js";
import { shellActivationMessage } from "./upstream.js";

// --- add --------------------------------------------------------------------

export const ADD_USAGE = `Usage: yaw-mcp add <slug> [flags]
       yaw-mcp add <name> --command "<launch line>" [flags]
       yaw-mcp add <name> --url <https://...> [flags]
       yaw-mcp add [<name>] --git <url>[#ref] [flags] [-- <server args>]

  Add an MCP server to the local server set in ~/.yaw-mcp/bundles.json so
  yaw-mcp loads it. With neither --command nor --url, <slug> is resolved
  from the yaw.sh/mcp catalog; with either, you are defining the server
  yourself and no catalog is fetched -- so this also works offline, and
  --catalog is refused beside them (there is nothing for it to point at).

  This is NOT the same as \`yaw-mcp install\` -- install wires the yaw-mcp
  aggregator into an AI client; add adds an MCP server to yaw-mcp itself.

  Defining a server directly:

  --command <line>  Launch line for a LOCAL (stdio) server, quoted as one
                    argument: --command "npx -y @scope/my-mcp@latest". Split
                    with the same tokenizer the catalog's launch lines use.
  --url <url>       Endpoint for a REMOTE (http) server. http or https only.
  --header "K: V"   Send an HTTP header on every request to a remote server.
                    Repeatable. This is how a remote server gets a credential
                    -- it spawns no process, so --env cannot reach it. Use a
                    vault reference for a real one:
                    --header 'Authorization: Bearer \${secret:NAME}'
  --transport <t>   streamable-http (default) or sse, for --url.
  --description <s> Free text describing what the server is for. Worth
                    setting: dispatch ranks servers on it.

  Building a server from a git repository (--git):

  --git <url>[#ref] https://, ssh://, git@host:org/repo or file:// URL. The ref
                    (branch, tag, short or full SHA; default: the default
                    branch) is resolved to a full commit and pinned. Auth is
                    your own git: ssh-agent, ~/.ssh/config or a credential
                    helper. A token in the URL is refused.
  --git-token-secret <name>
                    HTTPS only: a vault secret holding a token, handed to git
                    through GIT_ASKPASS. Only the name is stored.
  --subdir <path>   The package's directory inside the repo.
  --entry <file>    The entry file, relative to the package. Default: its
                    package.json "bin" or "main".
  --yes             Allow the repo's install/build scripts to run. Asked once
                    per repo on a TTY; off one, required until the repo is
                    allowed here. Recorded per repo in
                    ~/.yaw-mcp/git/consent.json. Ctrl+C at that question
                    exits 130 with nothing built or written.
  --project         Write <project>/.yaw-mcp/bundles.json instead.
  --no-start-check  Skip the one real handshake after the build.
  -- <args>         Arguments passed to the server.
  The name is optional when the repo's yaw-mcp.json names a namespace (one
  another server already uses is refused; give a name instead). With
  --git, --dry-run only resolves the ref and prints the commit it would pin.

  --env KEY=value   Provide a required env var's value. Repeatable. Required
                    vars not given here AND not in your shell block the add.
                    The value lands in your shell history and process argv
                    like any argument, and is stored in plain text in
                    bundles.json (file mode 0600 on macOS/Linux; on Windows
                    the file is only as private as your user profile's
                    ACL). For a real credential, store it
                    with \`yaw-mcp secrets set NAME\` and pass
                    --env KEY='\${secret:NAME}' instead: the vault resolves it
                    at launch and only the reference is written. The single
                    quotes stop bash/zsh/PowerShell expanding it to nothing;
                    in cmd.exe use no quotes ($ is not special there --
                    cmd.exe keeps single quotes as part of the value, and the
                    server would receive a quoted token). Or leave it
                    out to keep a shell-resident secret off disk entirely --
                    the server inherits it at launch.
  --dry-run         Print what would be written without writing.
  --json            Emit the written entry as JSON.
                    Env vars appear as \`envKeys\` -- key NAMES only, never the
                    stored values. An add that writes nothing prints one
                    {"ok":false,"error":...,"exitCode":...} document on
                    stdout instead; the message is also on stderr. (An
                    --git add that was written but failed its start check
                    prints the ok:true document with "started":false and
                    a "startError", and exits 1.)
  --catalog <url>   Override the catalog URL. Precedence: --catalog, then
                    $YAW_MCP_CATALOG_URL, then the public catalog.`;

export interface AddCommandOptions {
  slug?: string;
  envOverrides?: Record<string, string>;
  dryRun?: boolean;
  json?: boolean;
  catalogUrl?: string;
  /** `--command "npx -y foo"`: define a LOCAL server directly, no catalog. */
  command?: string;
  /** `--url https://...`: define a REMOTE server directly, no catalog. */
  url?: string;
  /** `--header "K: V"`, repeatable. Remote entries only. */
  headers?: Record<string, string>;
  /** `--transport sse` for a remote entry; defaults to streamable-http. */
  transport?: "streamable-http" | "sse";
  /** `--description`: free text the BM25 ranker indexes for dispatch. */
  description?: string;
  /** `--git <url>[#ref]`, already through parseGitSpec. */
  git?: GitSpec;
  gitTokenSecret?: string;
  subdir?: string;
  entry?: string;
  /** `--yes`: the consent to run the repo's lifecycle scripts. */
  yes?: boolean;
  /** `--project`: write the project's .yaw-mcp/bundles.json. */
  project?: boolean;
  noStartCheck?: boolean;
  /** Server arguments after `--`. */
  serverArgs?: string[];
  /** Test seams for the git path: the TTY verdict, canned prompt answers, the
   *  package-manager runner, the token reader and the start check. */
  isTTY?: boolean;
  promptAnswer?: string;
  /** `terminal` forces readline's keypress mode, so a test can deliver
   *  Ctrl+C at the consent prompt the way a terminal does. */
  io?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; terminal?: boolean };
  runPm?: GitBuildContext["runPm"];
  resolveToken?: GitBuildContext["resolveToken"];
  startCheck?: (config: UpstreamServerConfig) => Promise<{ ok: true; tools: number } | { ok: false; error: string }>;
  storeSecret?: (name: string) => Promise<boolean>;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchCatalog?: FetchCatalog;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface AddCommandResult {
  exitCode: number;
  written: string[];
}

function parseEnvFlag(v: string | undefined, bag: Record<string, string>): string | null {
  if (!v?.includes("=")) return "--env requires KEY=value";
  const eq = v.indexOf("=");
  const key = v.slice(0, eq);
  // ENV_KEY_RE is the one definition of "a shell identifier" -- shared with
  // `set env.KEY=` and with the catalog's requiredEnv filter, so the three
  // surfaces that write an env key agree on what one is.
  if (!ENV_KEY_RE.test(key)) return `--env: invalid KEY "${key}"`;
  bag[key] = v.slice(eq + 1);
  return null;
}

/** `--header "Authorization: Bearer x"`. Split on the FIRST colon only: a
 *  value legitimately contains colons (a URL, a `Bearer` blob), and splitting
 *  greedily would truncate them. */
function parseHeaderFlag(v: string | undefined, bag: Record<string, string>): string | null {
  if (v === undefined) return '--header requires "Name: value"';
  const colon = v.indexOf(":");
  if (colon <= 0) return `--header: expected "Name: value", got ${JSON.stringify(v)}`;
  const name = v.slice(0, colon).trim();
  const value = v.slice(colon + 1).trim();
  // The loader's own name rule and reserved set (local-bundles.ts), not a
  // private copy: a name the loader drops on every load must be refused here,
  // while the user is still looking at the command, rather than written and
  // reported as configured. RFC 7230 field-name: no spaces, no colon, no
  // control bytes, so a newline can never be smuggled into a header name.
  if (!HTTP_HEADER_NAME_RE.test(name)) return `--header: invalid header name ${JSON.stringify(name)}`;
  if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
    return `--header: ${name} is set by the MCP transport and cannot be overridden`;
  }
  // A blank value is refused rather than dropped: silently omitting the header
  // the user just asked for would send an unauthenticated request and leave
  // them reading a 401 with no sign their flag did nothing.
  if (value === "") return `--header: ${name} has no value`;
  // A CR, LF or NUL cannot be sent as a header value -- Node's Headers throws
  // on one. upstream.ts refuses it at connect time too (bundles.json is
  // hand-editable, so that is the load-bearing guard); catching it here means
  // the typo is refused while the user is still looking at the command that
  // made it, rather than at their next session.
  if (/[\r\n\0]/.test(value)) {
    return `--header: ${name} value contains a newline or NUL`;
  }
  bag[name] = value;
  return null;
}

export function parseAddArgs(
  argv: string[],
): { ok: true; options: AddCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: ADD_USAGE };
  const positional: string[] = [];
  const opts: AddCommandOptions = {};
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const gitOnly: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    if (a === "--") {
      opts.serverArgs = argv.slice(i + 1);
      gitOnly.push("--");
      break;
    }
    switch (a) {
      case "--git": {
        const v = next();
        if (v === undefined) return { ok: false, error: "--git requires a URL" };
        const parsed = parseGitSpec(v);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        opts.git = parsed.spec;
        break;
      }
      case "--git-token-secret": {
        const v = next();
        if (!v || !SECRET_NAME_RE.test(v))
          return { ok: false, error: "--git-token-secret requires a vault secret name" };
        opts.gitTokenSecret = v;
        gitOnly.push(a);
        break;
      }
      case "--subdir":
      case "--entry": {
        const v = next();
        if (v === undefined || v.startsWith("-")) return { ok: false, error: `${a} requires a relative path` };
        const reason = unsafeRelativePathReason(v);
        if (reason) return { ok: false, error: `${a} ${JSON.stringify(v)} is refused: ${reason}` };
        if (a === "--subdir") opts.subdir = v;
        else opts.entry = v;
        gitOnly.push(a);
        break;
      }
      case "--yes":
        opts.yes = true;
        gitOnly.push(a);
        break;
      case "--project":
        opts.project = true;
        gitOnly.push(a);
        break;
      case "--no-start-check":
        opts.noStartCheck = true;
        gitOnly.push(a);
        break;
      case "--env": {
        const e = parseEnvFlag(next(), env);
        if (e) return { ok: false, error: e };
        break;
      }
      case "--command": {
        const v = next();
        // Reject a following flag for the same reason --catalog does: a
        // launch line never starts with "-", and swallowing the next flag
        // would drop it silently.
        if (!v || v.startsWith("-")) return { ok: false, error: "--command requires a launch line" };
        opts.command = v;
        break;
      }
      case "--url": {
        const v = next();
        if (!v || v.startsWith("-")) return { ok: false, error: "--url requires a URL" };
        opts.url = v;
        break;
      }
      case "--header": {
        const e = parseHeaderFlag(next(), headers);
        if (e) return { ok: false, error: e };
        break;
      }
      case "--transport": {
        const v = next();
        if (v !== "streamable-http" && v !== "sse") {
          return { ok: false, error: "--transport must be streamable-http or sse" };
        }
        opts.transport = v;
        break;
      }
      case "--description": {
        const v = next();
        if (v === undefined || v.startsWith("-")) return { ok: false, error: "--description requires text" };
        opts.description = v;
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--catalog": {
        const v = next();
        // Reject a following flag (e.g. `add slug --catalog --dry-run`, which
        // would otherwise set catalogUrl="--dry-run" and drop the flag). Single
        // dash included, for the same reason the default case below rejects it:
        // a URL never starts with "-".
        if (!v || v.startsWith("-")) return { ok: false, error: "--catalog requires a URL" };
        opts.catalogUrl = v;
        break;
      }
      case "-h":
      case "--help":
        return { ok: false, error: ADD_USAGE, help: true };
      default:
        // Single dash included, not just "--": a mistyped SHORT flag (`add
        // fetch -y`, `add -f fetch`) must be reported as an unknown flag
        // instead of becoming a positional and failing later with the
        // misleading "invalid slug" / "Expected exactly one server slug". Same
        // posture parseRemoveArgs already takes, and no valid slug starts with
        // "-" (CATALOG_SLUG_RE requires a leading alphanumeric).
        if (a.startsWith("-")) return { ok: false, error: `Unknown flag: ${a}\n${ADD_USAGE}` };
        positional.push(a);
    }
  }
  if (opts.git !== undefined) {
    if (
      opts.command !== undefined ||
      opts.url !== undefined ||
      Object.keys(headers).length > 0 ||
      opts.transport !== undefined ||
      opts.catalogUrl !== undefined
    ) {
      return {
        ok: false,
        error: "--git cannot be combined with --command, --url, --header, --transport or --catalog.",
      };
    }
    if (positional.length > 1) {
      return { ok: false, error: `Expected at most one server name, got ${positional.length}.\n${ADD_USAGE}` };
    }
    if (Object.keys(env).length > 0) opts.envOverrides = env;
    if (positional[0] !== undefined) opts.slug = positional[0];
    return { ok: true, options: opts };
  }
  if (gitOnly.length > 0) {
    return { ok: false, error: `${gitOnly[0]} applies to a git server: pass --git <url>.` };
  }
  const custom = opts.command !== undefined || opts.url !== undefined;
  if (positional.length !== 1) {
    // The positional means different things in the two modes -- a catalog
    // slug, or the name for a server you are defining -- so the message says
    // which one is missing rather than always saying "slug".
    const what = custom ? "server name" : "server slug";
    return { ok: false, error: `Expected exactly one ${what}, got ${positional.length}.\n${ADD_USAGE}` };
  }
  if (opts.command !== undefined && opts.url !== undefined) {
    return { ok: false, error: "--command and --url are mutually exclusive: a server is local or remote, not both." };
  }
  // Flags that only mean something on the mode they belong to are refused
  // rather than ignored. Accepting-and-dropping is how you get a user who
  // passed --header to a stdio server and cannot work out why their token is
  // not being sent -- the same failure `install` was fixed for in 0.79.2.
  if (Object.keys(headers).length > 0) {
    if (opts.url === undefined) {
      return {
        ok: false,
        error: "--header applies to a remote server: pass --url, or set env vars with --env for a local one.",
      };
    }
    opts.headers = headers;
  }
  if (opts.transport !== undefined && opts.url === undefined) {
    return { ok: false, error: "--transport applies to a remote server: pass --url." };
  }
  // Same rule for --catalog in the other direction: a --command / --url add
  // fetches no catalog, so a --catalog beside it was accepted and did nothing
  // -- and a user who passed it to point a custom add at a private catalog
  // had no way to learn the override never ran.
  if (opts.catalogUrl !== undefined && custom) {
    return {
      ok: false,
      error: "--catalog applies to a catalog add: with --command or --url no catalog is fetched, so drop it.",
    };
  }
  if (Object.keys(env).length > 0) {
    if (opts.url !== undefined) {
      // Not a style preference: upstream.ts ignores `env` on a remote entry
      // outright, because there is no child process to put it in.
      return {
        ok: false,
        error: "--env does not apply to a remote server: it spawns no process. Use --header to send a credential.",
      };
    }
    opts.envOverrides = env;
  }
  opts.slug = positional[0];
  return { ok: true, options: opts };
}

/** Shape an entry for the `add --json` envelope: env KEY NAMES only, never
 *  values.
 *
 *  `add --json` reports the entry AS WRITTEN, and an update folds whatever was
 *  already on disk back into that object (upsertUserBundle -> mergeServerEntry
 *  copies the stored env), so printing `env` verbatim would put a token some
 *  EARLIER run persisted onto stdout for an invocation that passed no --env at
 *  all -- into CI logs, scrollback, and anything consuming the envelope.
 *
 *  `env` is REPLACED by `envKeys` rather than blanked to "": an empty value
 *  means "nothing persisted, the server depends on the ambient shell var"
 *  everywhere else here (see the ambient-env note in runAdd), so blanking would
 *  claim a stored secret is not on disk. Names only, never values -- the same
 *  posture printRemovalPreview, the dry-run text output and trust-cmd's env
 *  line already take. Read the values from bundles.json if you need them. */
function jsonEntry(entry: Partial<UpstreamServerConfig>): Record<string, unknown> {
  const { env, headers, ...rest } = entry;
  const out: Record<string, unknown> = { ...rest };
  const keys = Object.keys(env ?? {});
  if (keys.length > 0) out.envKeys = keys;
  // `headers` gets the SAME treatment, for the same reason and more sharply:
  // it is the credential channel for a remote server, so an Authorization
  // value here is a live bearer token, and this envelope is the thing that
  // gets piped into CI logs and pasted into bug reports. Redacting env while
  // printing headers in the clear was the shape this had when headers were
  // first added -- one output showed `envKeys: [...]` next to a full
  // `Bearer <token>`.
  //
  // Names only, like env: a `${secret:NAME}` reference is safe to print, but a
  // LITERAL token passed with --header is not, and the envelope cannot tell
  // the reader which one it holds without printing it.
  const headerNames = Object.keys(headers ?? {});
  if (headerNames.length > 0) out.headerNames = headerNames;
  return out;
}

/** Declared keys with no stored value while the shell HAS one: the value
 *  came from the ambient env, not --env, and was deliberately not persisted
 *  (see the seeding note in runAdd). Computed from the entry as written -- or
 *  as the dry run would write it -- never from the flags, so a re-add over an
 *  entry that already carries a stored value stays quiet instead of claiming
 *  nothing was persisted.
 *
 *  Key-agnostic: the callers pass the catalog's REQUIRED list and its
 *  OPTIONAL list separately, because the two earn different notes (a required
 *  var the server depends on; an optional one it merely reads when present)
 *  and this test is the same for both. */
function ambientOnlyKeys(keys: string[], entry: Partial<UpstreamServerConfig>, env: NodeJS.ProcessEnv): string[] {
  const stored = (entry.env ?? {}) as Record<string, string>;
  return keys.filter((k) => (stored[k] ?? "").trim() === "" && (readEnvVar(env, k) ?? "").trim() !== "");
}

/** The shell's value for `key`, with the platform's own case rule. Windows
 *  environment variables are case-insensitive, and process.env mirrors that
 *  (`process.env.Path` and `process.env.PATH` are one variable) -- but a
 *  plain object built by spreading it is not, so a gate that spread
 *  `{ ...env, ...overrides }` and read `supplied[k]` refused a required
 *  `GITHUB_TOKEN` that the shell held as `Github_Token`, while the
 *  ambient-env note right after it (reading process.env directly) called the
 *  same var present. One lookup, used by every reader of the shell env in
 *  this file, so the gate and the notes cannot disagree about one variable.
 *  Exact on POSIX, where the two spellings really are two variables. */
function readEnvVar(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return env[key];
  const wanted = key.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === wanted) return v;
  }
  return undefined;
}

/** Optional keys the entry carries EMPTY that the shell does not set either:
 *  seeded by `add` as a slot to fill (see the seeding note in runAdd), and
 *  worth one line so the user knows the slot exists and what fills it. Same
 *  as-written source as ambientOnlyKeys, for the same reason: a re-add over an
 *  entry whose optional value was filled since must not call it unset. */
function unsetOptionalKeys(keys: string[], entry: Partial<UpstreamServerConfig>, env: NodeJS.ProcessEnv): string[] {
  const stored = (entry.env ?? {}) as Record<string, string>;
  return keys.filter((k) => (stored[k] ?? "").trim() === "" && (readEnvVar(env, k) ?? "").trim() === "");
}

/** The dry run's `env keys:` line, with each optional key marked. The seeded
 *  slot for an optional var is a key like any other in the entry, and the
 *  preview is what a user reads to learn whether the add asks for anything,
 *  so an unmarked slot reads as a credential the server needs. */
function renderEnvKeys(env: Record<string, string>, optionalKeys: string[]): string {
  return Object.keys(env)
    .map((k) => (optionalKeys.includes(k) ? `${k} (optional)` : k))
    .join(", ");
}

/** What this entry's ${secret:...} references will do at spawn or connect:
 *  which names the vault does not hold, and which spans do not parse at all.
 *
 *  Reads ONE map, chosen by shape. Unioning env and headers looked harmless
 *  and was not: a remote entry's env is ignored outright by upstream, so
 *  warning about a ref in it invents a cause -- the same failure doctor's
 *  vault section is written to avoid, and a re-add that converts an entry can
 *  leave a stale env behind for it to fire on. The mirror (headers on a local
 *  entry) is never read either.
 *
 *  Malformed spans count as well as missing names. They fail identically at
 *  resolve time, and a mistyped name is exactly what this warning exists to
 *  catch -- reporting only the half that still parses would miss the typo
 *  class it was written for.
 *
 *  Names are read WITHOUT the passphrase: listKeys reads them off the file,
 *  and only a value needs unlocking, so this works in the ordinary shell where
 *  no passphrase is set. Any read problem yields nothing rather than a guess;
 *  `yaw-mcp doctor` is the surface that reports an unreadable vault properly. */
async function danglingSecretRefs(
  entry: Partial<UpstreamServerConfig>,
  home: string,
): Promise<{ missing: string[]; malformed: string[] }> {
  const refSource = isRemoteEntry(entry) ? entry.headers : entry.env;
  const malformed = collectMalformedSecretRefs(refSource);
  const referenced = collectSecretRefNames(refSource);
  if (referenced.size === 0) return { missing: [], malformed };
  try {
    const vault = await loadVault(vaultPath(home));
    const stored = new Set(vault ? listKeys(vault) : []);
    return { missing: [...referenced].filter((n) => !stored.has(n)).sort(), malformed };
  } catch {
    return { missing: [], malformed };
  }
}

/** The stderr notes that follow a write -- in the conditional voice for a
 *  dry run. The preview's stated purpose is to describe the run it previews,
 *  and it used to return before any note, so `add --dry-run` said nothing
 *  about the ambient var the server would depend on, nor about the project
 *  file that would shadow the write. stderr so every note survives --json. */
async function printPostWriteNotes(
  printErr: (s: string) => void,
  opts: {
    ambientOnly: string[];
    /** The catalog's optional vars, split by what the written entry and the
     *  shell hold: `ambient` mirrors ambientOnly (read from the shell, not
     *  persisted), `unset` is nowhere at all. Each gets its own note, in the
     *  optional voice -- the required note says the server DEPENDS on the
     *  var, and that claim is false for these. `namespace` is the one the
     *  file holds (or would), for the `yaw-mcp set` remedy. */
    optional: { ambient: string[]; unset: string[]; namespace: string };
    cwd: string;
    home: string;
    /** %APPDATA% for the client probe, resolved by the caller from the RAW
     *  `--home` override (see resolveAppDataDir). */
    appData: string;
    env: NodeJS.ProcessEnv;
    dryRun: boolean;
    dangling: { missing: string[]; malformed: string[] };
  },
): Promise<void> {
  const { ambientOnly, dryRun } = opts;
  // A ${secret:NAME} the vault does not hold is a spawn/connect refusal
  // waiting to happen, and the user finds out in their MCP client at the next
  // session -- far from the command that caused it. Says so here instead, in
  // the same breath as the write. A WARNING rather than a refusal: storing the
  // secret after wiring the server is a perfectly reasonable order, and the
  // catalog path's required-env gate already refuses the case where the value
  // is genuinely mandatory up front.
  if (opts.dangling.missing.length > 0) {
    const names = opts.dangling.missing;
    const one = names.length === 1;
    // The plural branch names the COMMAND SHAPE, not the first secret. Saying
    // "Store them with `secrets set aa`" hands the user a command that stores
    // exactly one of the names it just listed, and nothing tells them a second
    // run is needed. doctor's equivalent line already gets this right.
    const remedy = one ? `\`yaw-mcp secrets set ${names[0]}\`` : "`yaw-mcp secrets set <name>`, once per name";
    printErr(
      `Note: ${names.join(", ")} ${one ? "is" : "are"} referenced by this entry but not stored in your vault; the server will be refused until ${one ? "it is" : "they are"} set. Store ${one ? "it" : "each"} with ${remedy}.`,
    );
  }
  if (opts.dangling.malformed.length > 0) {
    // Reported in the bounded `display` form, never raw: a malformed span is a
    // slice of an env or header VALUE (an unterminated `${secret:` runs to the
    // end of it), so the raw text can carry the very credential the typo was
    // meant to reference.
    printErr(
      `Note: ${opts.dangling.malformed.join(", ")} is not a parseable \${secret:NAME} reference; the server will be refused until the typo is fixed in bundles.json.`,
    );
  }
  if (ambientOnly.length > 0) {
    const one = ambientOnly.length === 1;
    const verb = dryRun ? "would be" : one ? "was" : "were";
    printErr(
      `Note: ${ambientOnly.join(", ")} ${verb} read from your shell env and NOT persisted; the server depends on ${
        one ? "that var" : "those vars"
      } being present wherever yaw-mcp launches. Pass --env ${ambientOnly[0]}=... to persist a value.`,
    );
  }
  // The optional vars, after the required note and never merged into it:
  // "depends on that var" is exactly what the server does NOT do with these.
  // Two lines at most, and only when there is something to say -- a server
  // whose optional var is already stored, or that declares none, adds nothing
  // to the output it had before the flag existed.
  const optAmbient = opts.optional.ambient;
  if (optAmbient.length > 0) {
    const one = optAmbient.length === 1;
    const verb = dryRun ? "would be" : one ? "was" : "were";
    printErr(
      `Note: ${optAmbient.join(", ")} (optional) ${verb} read from your shell env and NOT persisted; the server reads ${
        one ? "it" : "them"
      } only where your shell sets ${one ? "it" : "them"}. Pass --env ${optAmbient[0]}=... to persist a value.`,
    );
  }
  const optUnset = opts.optional.unset;
  if (optUnset.length > 0) {
    const one = optUnset.length === 1;
    // Indicative even on a dry run, unlike the two ambient notes above: they
    // describe the write ("would be read ... and NOT persisted"), while this
    // one describes the var (optional) and the shell (unset), both true now.
    // "TFE_TOKEN would be optional" reads as if the flag depended on the run.
    const verb = one ? "is" : "are";
    printErr(
      `Note: ${optUnset.join(", ")} ${verb} optional and not set; the server runs without ${
        one ? "it" : "them"
      }. Set ${one ? "it" : "each"} later with \`yaw-mcp set ${opts.optional.namespace} env.${optUnset[0]}=...\`.`,
    );
  }
  // Honest warning: a project-local bundles.json shadows the user-global file.
  //
  // `env` is passed explicitly: the shadow verdict is trust-aware, and
  // YAW_MCP_TRUST_PROJECT is the documented opt-out. Defaulting it to
  // process.env read a DIFFERENT environment than the one this command was
  // told to run under, so an embedded/test caller that injected the bypass got
  // the un-bypassed answer.
  const shadow = await findShadowingProjectBundles(opts.cwd, opts.home, opts.env).catch(() => null);
  if (shadow) {
    printErr(
      `Note: ${displaySafe(shadow)} overrides your user-global bundles.json, so this entry ${
        dryRun ? "would not" : "won't"
      } load until you add it there or remove that file.`,
    );
  }
  // The other half of the setup, and the one `add` alone never mentions: a
  // server in bundles.json is reachable only through a client that launches
  // yaw-mcp. `install` already prints the mirror of this ("Servers: none
  // configured yet ... Add one with `yaw-mcp add <slug>`"), so a user who
  // started from install is told what is missing; a user who started from
  // `add` was told "no client restart" -- advice about restarting a client
  // that is not wired to anything -- and nothing else.
  //
  // Best-effort and quiet on failure: this is a note, and an unreadable client
  // config must never fail an add that already succeeded.
  if (!(await anyClientWiredToYawMcp(opts.home, opts.cwd, opts.env, opts.appData))) {
    printErr(
      `Note: no AI client is wired to yaw-mcp yet, so nothing ${
        dryRun ? "would load" : "loads"
      } this server. Run \`yaw-mcp install <client>\` (\`yaw-mcp install --list\` shows the clients it can detect).`,
    );
  }
}

/** True when at least one client config on this machine already launches
 *  yaw-mcp. `hasMcpEntry` is doctor's own verdict, read through the shared
 *  probe rather than re-derived here: which files a client reads (and which
 *  key inside them counts as the broker) is exactly the knowledge that drifts
 *  when a second copy of it exists.
 *
 *  Any probe failure reads as "wired" -- the caller only uses this to decide
 *  whether to print a nudge, and a nudge printed at someone who IS installed
 *  is worse than a nudge withheld from someone who is not. */
async function anyClientWiredToYawMcp(
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  appData: string,
): Promise<boolean> {
  const clientEnv = readClientEnv(env);
  try {
    const probes = await probeClientsAsync({
      home,
      os: CURRENT_OS,
      cwd,
      // Every client env var comes from `readClientEnv`, the ONE reader of
      // those names -- not from a `process.env.X` of this module's own, which
      // is how two commands came to disagree about whether an EMPTY value
      // counts as set. CLAUDE_CONFIG_DIR relocates claude-code's file; the
      // rest are read for the clients that have one, so a Continue- or
      // Cline-only user stops getting a false "nothing is wired" nudge.
      //
      // `appData` stays resolved by the CALLER (see runAdd): choosing between
      // the ambient %APPDATA% and a home-derived one is a caller's job --
      // resolving it from the ALREADY-defaulted home here would pin every
      // real run to <home>\AppData\Roaming and miss a redirected profile,
      // which is the exact split resolveAppDataDir exists to prevent.
      claudeConfigDir: clientEnv.claudeConfigDir,
      clientEnv,
      appData,
    });
    return probes.some((p) => p.hasMcpEntry);
  } catch {
    return true;
  }
}

/** The write path's failure message with the bundles.json path named ONCE.
 *
 *  readRawUserBundles (local-bundles.ts) builds its message as
 *  `<path> could not be parsed -- fix the JSON (<warnings>) ...`, and every
 *  warning readBundlesAt collects is itself prefixed `<path>: ` -- so a file
 *  with two warnings (say a future schema version AND a missing `servers`
 *  array) printed a full Windows profile path three times in one sentence,
 *  most of the terminal width, for one file.
 *
 *  The prefix is the redundant part and is exactly what this drops: the
 *  sentence already opened with the path, and the DETAIL each warning carries
 *  is kept. Matching on `<path>: ` -- path plus colon plus space -- is why the
 *  leading `<path> could not be parsed` survives: it is followed by a space,
 *  not a colon. This is a string the caller already knows (we built it from
 *  the same localBundlesPath), never a pattern guess.
 *
 *  A path embedded in an ERRNO message ("EACCES: permission denied, open
 *  '<path>'") is Node's own text and is left alone -- rewriting inside it
 *  would edit a message we do not own for a gain the parse case does not need.
 */
function nameBundlesFileOnce(message: string, path: string): string {
  return message.split(`${path}: `).join("");
}

/** Both halves of a launch swap, rendered like the removal preview: through
 *  renderLaunch, so a stored url-only entry reads as `HTTP <url>` instead of
 *  nothing, and control bytes or whitespace in a stored arg are neutered the
 *  same way every other bundles.json field this file prints is. */
function renderLaunchChange(change: LaunchChange): string {
  return `  from: ${renderLaunch(change.from)}\n    to: ${renderLaunch(change.to)}`;
}

/** The `add --json` failure document, one layout for every add path (catalog,
 *  --command, --url and --git): `{ok:false,error,exitCode}`, pretty-printed
 *  like the success document, with `error` the stderr line's text,
 *  `yaw-mcp add:` prefix included. */
function addJsonFailure(error: string, exitCode: number): string {
  return JSON.stringify({ ok: false, error, exitCode }, null, 2);
}

export async function runAdd(opts: AddCommandOptions): Promise<AddCommandResult> {
  const rawOut = opts.out ?? createStreamWriter(process.stdout);
  // Whether stdout has carried anything yet. Under --json every failure is
  // ONE {ok:false} document, so a rejection that escapes after the success
  // document (or a failure document) is already out must not add a second.
  let stdoutUsed = false;
  const out = (s: string): void => {
    stdoutUsed = true;
    rawOut(s);
  };
  const scoped = { ...opts, out };
  try {
    return opts.git !== undefined ? await runAddGit(scoped, opts.git) : await runAddDirect(scoped);
  } catch (e) {
    // The dispatcher prints `yaw-mcp add: <message>` on stderr and exits 1;
    // under --json stdout gets the matching document first.
    if (opts.json && !stdoutUsed) {
      out(`${addJsonFailure(`yaw-mcp add: ${e instanceof Error ? e.message : String(e)}`, 1)}\n`);
    }
    throw e;
  }
}

/** A catalog, --command or --url add. `opts.out` is set (runAdd wraps it). */
async function runAddDirect(opts: AddCommandOptions): Promise<AddCommandResult> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);
  // Every refusal of this path: the stderr text is unchanged (the callers
  // print their own lines first, some of them several), and under --json
  // stdout gets ONE {ok:false} document -- the same one runAddGit's fail()
  // prints. `error` is the one-line summary of what stderr said.
  const failed = (exitCode: number, error: string): AddCommandResult => {
    if (opts.json) print(addJsonFailure(error, exitCode));
    return { exitCode, written: [] };
  };
  const refuse = (exitCode: number, error: string): AddCommandResult => {
    printErr(error);
    return failed(exitCode, error);
  };

  if (!opts.slug) {
    printErr(ADD_USAGE);
    return failed(2, "yaw-mcp add: a server slug (or a name with --command or --url) is required.");
  }
  const slug = opts.slug;
  // The same shape gates both modes: it is a catalog slug in one and the name
  // of a server you are defining in the other, and lowercase-dashes suits both.
  const custom = opts.command !== undefined || opts.url !== undefined;
  // Told to the write path so a collision refusal does not call a hand-typed
  // name a "catalog server" (see UpsertOrigin).
  const origin: UpsertOrigin = custom ? "custom" : "catalog";
  if (!CATALOG_SLUG_RE.test(slug)) {
    const what = custom ? "name" : "slug";
    return refuse(2, `yaw-mcp add: invalid ${what} "${slug}" (lowercase letters, digits, and dashes only).`);
  }

  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  // Resolved from the RAW override, not from `home` above: with no --home the
  // ambient %APPDATA% is the one Claude Desktop actually reads (it can be
  // redirected away from <home>\AppData\Roaming), while a synthetic home
  // must keep the probe inside itself. Same call `install` and `try` make.
  const appData = resolveAppDataDir({ home: opts.home, env });

  // Resolve the launch shape -- from the flags when the user supplied one, and
  // from the catalog otherwise.
  //
  // `--command` / `--url` make NO network call: the point of them is that the
  // 80-entry catalog is a curated front door rather than the only door, so a
  // server it does not list must not depend on reaching it. That also makes
  // this the one add path that works offline.
  let server: Awaited<ReturnType<typeof resolveCatalogSlug>>;
  if (custom) {
    if (opts.url !== undefined) {
      // Parse here rather than at connect time. upstream.ts already classifies
      // a malformed url as a permanent config error, but that is a failure the
      // user meets on their next session; refusing at add time keeps an entry
      // that can never connect out of bundles.json in the first place.
      let parsed: URL;
      try {
        parsed = new URL(opts.url);
      } catch {
        return refuse(
          2,
          `yaw-mcp add: invalid url ${JSON.stringify(opts.url)} -- include the scheme, e.g. https://host/mcp`,
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return refuse(2, `yaw-mcp add: url must be http or https, got ${JSON.stringify(parsed.protocol)}`);
      }
    }
    let command = "";
    let args: string[] = [];
    if (opts.command !== undefined) {
      // Same tokenizer the catalog's single-string launch lines go through, so
      // a quoted argument behaves identically however the entry was added.
      let tokens: string[];
      try {
        tokens = tokenizeCommand(opts.command);
      } catch (e) {
        return refuse(2, `yaw-mcp add: ${(e as Error).message}`);
      }
      [command = "", ...args] = tokens;
      if (!command) return refuse(2, "yaw-mcp add: --command had no executable in it.");
    }
    server = {
      slug,
      name: slug,
      command,
      args,
      // Nothing declares a requirement for a hand-defined server, so there is
      // no required-env gate to fail: whatever --env carries is all there is.
      requiredEnvKeys: [],
      optionalEnvKeys: [],
      description: opts.description,
    };
  } else {
    try {
      server = await resolveCatalogSlug(slug, {
        // A set-but-EMPTY YAW_MCP_CATALOG_URL survives this `??` (it is not
        // nullish) -- resolveCatalogSlug normalizes empty/whitespace-only back to
        // the default catalog so it can never reach fetch(""). See
        // normalizeCatalogUrl in catalog.ts for why that guard lives there.
        catalogUrl: opts.catalogUrl ?? env.YAW_MCP_CATALOG_URL,
        fetchCatalog: opts.fetchCatalog,
        // The staleness note goes to THIS command's stderr writer, not the
        // process's: an embedded caller that captured `err` otherwise saw the
        // note escape to the real terminal.
        warn: printErr,
      });
    } catch (e) {
      return refuse(1, `yaw-mcp add: ${(e as Error).message}`);
    }
  }

  // Derive the namespace from the resolved catalog NAME via the same algorithm
  // the Yaw Terminal app uses, NOT from the slug -- so the same server lands
  // under the same namespace whether added here or via the app's one-click /
  // "Add to Yaw MCP" badge. (deriveNamespace always returns a valid namespace.)
  const namespace = deriveNamespace(server.name);

  // Required-env gate: refuse with a re-run hint when a required var has no
  // value in --env or the shell. Same posture as `yaw-mcp try` so the two
  // commands behave alike. (The GUI provides the richer fill-in-the-blank UX.)
  //
  // REQUIRED keys only. A var the catalog flags `"optional": true` is declared
  // so the entry carries the key (seeded below), but the server runs without
  // it, so refusing on it would make a "no credentials needed" server refuse
  // to add -- the contradiction the flag exists to remove. The refusal still
  // NAMES the optional vars, apart and marked, because this is the one place
  // the user sees what the server takes before the write happens.
  //
  // --env first, then the shell -- through readEnvVar, the same lookup the
  // ambient-env notes use, so the gate and the notes agree on whether a var is
  // present (on Windows that means case-insensitively; see readEnvVar).
  const overrides = opts.envOverrides ?? {};
  const supplied = (k: string): string => overrides[k] ?? readEnvVar(env, k) ?? "";
  // Trim before the emptiness test so a whitespace-only value (FOO=" ") counts
  // as missing instead of slipping through and persisting a blank-ish secret to
  // bundles.json -- matching the required-env gate in runTry (try-cmd.ts).
  // Named by FUNCTION, not line: the line number this used to cite drifted into
  // an unrelated helper two refactors later.
  const missing = server.requiredEnvKeys.filter((k) => supplied(k).trim() === "");
  if (missing.length > 0) {
    printErr(`yaw-mcp add: ${server.name} needs the following env var(s) before it can run:`);
    for (const k of missing) printErr(`  - ${k}`);
    if (server.optionalEnvKeys.length > 0) {
      // Not in the re-run line below: that line is the command that gets the
      // add past the gate, and an optional var is not part of the gate.
      printErr(`Optional, not needed to run: ${server.optionalEnvKeys.join(", ")}`);
    }
    printErr("");
    printErr("Provide them with --env KEY=value (repeatable) or your shell, then re-run:");
    printErr(`  yaw-mcp add ${slug} ${missing.map((k) => `--env ${k}=...`).join(" ")}`);
    if (server.docUrl) printErr(`Docs: ${server.docUrl}`);
    return failed(
      1,
      `yaw-mcp add: ${server.name} needs the following env var(s) before it can run: ${missing.join(", ")}. Provide them with --env KEY=value or your shell, then re-run.`,
    );
  }

  // Seed required keys EMPTY and persist a VALUE only when the user passed it
  // explicitly via --env. yaw-mcp inherits the ambient shell env when it spawns
  // the upstream (upstream.ts), so a shell-resident secret reaches the server
  // at runtime WITHOUT being copied to disk -- matching the app's one-click
  // posture ("env values are not pulled from your shell") and avoiding writing
  // an ambient secret into bundles.json the user never asked to persist.
  //
  // Optional keys are seeded the same way. Declared-but-optional means the
  // entry still carries the key, so the app's env editor and `yaw-mcp set
  // <ns> env.KEY=...` have a slot to fill later; an empty seed is dropped by
  // the loader (see validateEntry), so it never blanks a shell value either.
  const entryEnv: Record<string, string> = {};
  for (const k of [...server.requiredEnvKeys, ...server.optionalEnvKeys]) entryEnv[k] = "";
  // Trim each --env value before persisting: a whitespace-only value is treated
  // as missing (a required key stays seeded EMPTY; a non-required key is skipped
  // entirely) so it never lands as a blank-ish secret in bundles.json --
  // consistent with the trimmed required-env gate above.
  for (const [k, v] of Object.entries(opts.envOverrides ?? {})) {
    const trimmed = v.trim();
    if (trimmed === "") continue;
    entryEnv[k] = trimmed;
  }

  // `slug` records the CATALOG slug this entry was added with. It is not part
  // of UpstreamServerConfig (validateEntry drops it at load time, and nothing
  // at runtime reads it) -- it exists so `yaw-mcp remove <slug>` can map the
  // slug back to the namespace when the two derive differently: the namespace
  // comes from the display NAME, so `add ga` ("Google Analytics") lands as
  // namespace "googleanalytics" and neither the literal target nor
  // deriveNamespace("ga") could ever find it again. The write path round-trips
  // unknown per-server fields, so the slug survives later add/remove writes.
  const remote = opts.url !== undefined;
  const entry: Partial<UpstreamServerConfig> & { slug: string; optionalEnvKeys?: string[] } = {
    id: `local-${namespace}`,
    name: server.name,
    namespace,
    slug: server.slug,
    // A remote entry carries url + headers and NO command/args: the two shapes
    // are exclusive, and leaving a stray `command: ""` on a remote entry would
    // read to the loader as a stdio server with no executable.
    ...(remote
      ? {
          type: "remote" as const,
          transport: opts.transport ?? ("streamable-http" as const),
          url: opts.url,
          headers: opts.headers,
        }
      : {
          type: "local" as const,
          transport: "stdio" as const,
          command: server.command,
          args: server.args,
          env: Object.keys(entryEnv).length > 0 ? entryEnv : undefined,
          // Which of the blank seeds above are optional. The entry env alone
          // cannot say -- a required key and an optional one are both "" until
          // filled -- and the Yaw app reads nothing but bundles.json when it
          // decides whether a server "needs key". The app writes the same
          // marker for the entries it adds; without ours, a server added here
          // showed "needs key" in the panel until re-added from the app.
          // Always an array so a re-add can CLEAR a stale marker; the write
          // never stores an empty one, fresh add or merge (mergedUpsertEntry
          // in local-bundles.ts), and an explicit-command add sends [].
          optionalEnvKeys: server.optionalEnvKeys,
        }),
    isActive: true,
    description: server.description,
    // The catalog's published grade, recorded at add time so the
    // YAW_MCP_MIN_COMPLIANCE gate has something to read on a fresh install.
    // Without it the gate was inert for every catalog server: grades.json is
    // written only by `yaw-mcp audit`, which the user has to run per server
    // by hand, so until they did, every server was ungraded and ungraded
    // always passes -- a floor nothing could fall below.
    //
    // It is a CLAIM recorded at a moment in time, not a measurement of the
    // bytes on this machine, and it does not go stale gracefully. A local
    // `audit` supersedes it: hydrateComplianceGrades (server.ts) and runList
    // both overlay grades.json ON TOP of the config value, so the letter the
    // user measured here always wins over the one the catalog published.
    complianceGrade: server.complianceGrade,
  };

  if (opts.dryRun) {
    // The preview must describe the run it previews: the real run can
    // REFUSE (a namespace collision with a different server) or KEEP an
    // existing entry's namespace (a name-matched legacy entry), and both
    // outcomes depend on the file on disk. previewUpsertUserBundle shares
    // the real write path's resolution logic, so the two cannot drift.
    let preview: Awaited<ReturnType<typeof previewUpsertUserBundle>>;
    try {
      preview = await previewUpsertUserBundle(entry, { home, origin });
    } catch (e) {
      // Same unreadable-file failure the real run surfaces -- including its
      // de-duplicated path (see nameBundlesFileOnce).
      return refuse(
        1,
        `yaw-mcp add: ${nameBundlesFileOnce((e as Error).message, localBundlesPath(userConfigDir(home)))}`,
      );
    }
    // The same read diagnostics the real run prints (see readRawUserBundles):
    // a preview that hid them described a quieter run than the real one.
    for (const w of preview.warnings) printErr(`warning: ${w}`);
    if (preview.refusal) {
      // The same channels as the REAL refusal (the catch around
      // upsertUserBundle below) and every other error exit of an add: the
      // text on stderr, and under --json one {ok:false} document on stdout.
      // Rendered through displaySafe: the stored half of the collision (name,
      // slug) comes straight out of bundles.json.
      return refuse(1, `yaw-mcp add (dry-run): would refuse: ${formatBundleCollision(preview.refusal, displaySafe)}`);
    }
    const previewNamespace = preview.namespace ?? namespace;
    // Render the entry the run would WRITE, never the pre-merge object built
    // above: an update folds onto whatever is already on disk (see
    // mergeServerEntry), so the two differ on exactly the entries a user
    // hand-edited -- a stored env value, a per-server override, and an
    // explicit `"isActive": false` the add does NOT re-enable. Previewing the
    // input described a file the run would never produce.
    const previewEntry = preview.entry;
    const previewPath = localBundlesPath(userConfigDir(home));
    if (preview.launchChanged) {
      printErr(
        `Note: this would CHANGE the entry's launch command:\n${renderLaunchChange(preview.launchChanged)}\nIf the existing entry is a different server you meant to keep, remove/re-add via the app or edit bundles.json instead.`,
      );
    }
    if (opts.json) {
      // Same wrapper shape as the real add below, with dryRun:true, so a
      // script parsing `add --json` sees one consistent shape either way --
      // including the env redaction (see jsonEntry). `path` and `replaced`
      // are part of that shape: the claim used to be made while the dry-run
      // omitted both, so a consumer reading `replaced` to decide "new install
      // vs update" silently saw undefined on every dry run. previewUpsert-
      // UserBundle already computes `replaced` from the same resolution the
      // real write uses, and the target path is the user-global file the write
      // would touch (a dry run never writes it, so naming it costs nothing).
      print(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            namespace: previewNamespace,
            path: previewPath,
            replaced: preview.replaced,
            entry: jsonEntry(previewEntry),
          },
          null,
          2,
        ),
      );
    } else {
      const nsNote =
        previewNamespace === namespace
          ? `as namespace "${previewNamespace}"`
          : `keeping existing namespace "${previewNamespace}"`;
      print(`yaw-mcp add (dry-run): would ${preview.replaced ? "update" : "write"} ${server.name} ${nsNote}`);
      // Through renderLaunch, not a hand-rolled `command + args`: a REMOTE
      // entry has neither, so the old line rendered a literal
      // "command: undefined " for every --url add. renderLaunch already knows
      // the three shapes (argv, url, neither) and is what the removal preview
      // and the trust gate print, so the preview now agrees with them.
      print(`  launch: ${renderLaunch(previewEntry)}`);
      if (previewEntry.env) print(`  env keys: ${renderEnvKeys(previewEntry.env, server.optionalEnvKeys)}`);
      // Header NAMES only. A --header value can be a live bearer token, and
      // --dry-run exists to be pasted into a bug report -- the same reason
      // env is printed by key here and redacted in the --json envelope.
      if (previewEntry.headers) print(`  header names: ${Object.keys(previewEntry.headers).join(", ")}`);
      // Same note the real run prints, in the conditional voice -- an add over
      // a hand-disabled entry keeps it disabled (mergeServerEntry rule 3), so
      // a preview that ended on the usual success line told the user this
      // would make the server loadable when it would not.
      if (previewEntry.isActive === false) {
        print(
          `Note: this entry is "isActive": false, so it would stay disabled and NOT load. Run \`yaw-mcp enable ${previewEntry.namespace}\` to turn it on.`,
        );
      }
    }
    await printPostWriteNotes(printErr, {
      ambientOnly: ambientOnlyKeys(server.requiredEnvKeys, previewEntry, env),
      optional: {
        ambient: ambientOnlyKeys(server.optionalEnvKeys, previewEntry, env),
        unset: unsetOptionalKeys(server.optionalEnvKeys, previewEntry, env),
        namespace: previewNamespace,
      },
      // Previewed from the entry the run WOULD write, so --dry-run reports the
      // same dangling refs the real run would.
      dangling: await danglingSecretRefs(previewEntry, home),
      cwd,
      home,
      appData,
      env,
      dryRun: true,
    });
    return { exitCode: 0, written: [] };
  }

  let res: Awaited<ReturnType<typeof upsertUserBundle>>;
  try {
    res = await upsertUserBundle(entry, { home, origin });
  } catch (e) {
    // The collision refusal quotes the STORED entry's name and slug -- fields
    // out of bundles.json -- so it is re-rendered through displaySafe rather
    // than printed as the Error's verbatim message.
    // Read diagnostics FIRST, exactly as the success path and the dry run
    // print them: the user is about to open bundles.json to resolve the
    // collision, and a malformed entry the loader skipped is what they most
    // need to know about before they do.
    if (e instanceof BundleCollisionError) for (const w of e.warnings) printErr(`warning: ${w}`);
    const msg =
      e instanceof BundleCollisionError
        ? formatBundleCollision(e.collision, displaySafe)
        : nameBundlesFileOnce((e as Error).message, localBundlesPath(userConfigDir(home)));
    return refuse(1, `yaw-mcp add: ${msg}`);
  }
  // Read diagnostics first, before the success line they qualify -- an
  // invalid `defaultRuntime` this write just dropped from the file is the
  // usual one (see readRawUserBundles).
  for (const w of res.warnings) printErr(`warning: ${w}`);

  // Report the entry AS WRITTEN, not the one built above: an update folds onto
  // whatever was already on disk (env values, an explicit isActive:false, a
  // per-server runtime override, a name-matched entry's KEPT namespace -- see
  // mergeServerEntry / upsertUserBundle), so the pre-merge object would
  // describe a file that doesn't exist.
  const written = res.entry;
  const finalNamespace = typeof written.namespace === "string" ? written.namespace : namespace;

  // A merge that replaced the launch shape -- a slug-less app-written entry
  // refreshed from the catalog, a catalog entry overwritten by `add <name>
  // --command`, or the reverse. The swap must never be SILENT: name what
  // changed, on stderr so it survives --json.
  if (res.launchChanged) {
    printErr(
      `Note: the entry's launch command changed:\n${renderLaunchChange(res.launchChanged)}\nIf the previous entry was a different server you meant to keep, restore it from the app or edit bundles.json.`,
    );
  }

  if (opts.json) {
    print(
      JSON.stringify(
        { ok: true, namespace: finalNamespace, path: res.path, replaced: res.replaced, entry: jsonEntry(written) },
        null,
        2,
      ),
    );
  } else {
    // Name the namespace the file actually holds -- and say so explicitly
    // when the merge kept an existing one instead of the catalog-derived
    // spelling, so the user is never told a namespace that does not exist.
    const nsNote =
      finalNamespace === namespace ? `namespace "${finalNamespace}"` : `kept existing namespace "${finalNamespace}"`;
    print(`${res.replaced ? "Updated" : "Added"} ${server.name} (${nsNote}) in ${res.path}`);
    // A re-add folds onto a stored `"isActive": false` instead of silently
    // re-enabling it (mergeServerEntry rule 3). That is deliberate, but it
    // makes the usual "restart to pick it up" line WRONG: a disabled entry
    // never loads, so the user restarts, sees nothing, and has no reason to
    // suspect the file. Name the verb that turns it on.
    if (written.isActive === false) {
      print(
        `Note: this entry is "isActive": false, so it stays disabled and will NOT load. Run \`yaw-mcp enable ${finalNamespace}\` to turn it on.`,
      );
    } else {
      print("A running yaw-mcp picks it up on its next mcp_connect_* call -- no client restart.");
    }
  }

  // Required keys that passed the gate but landed on disk EMPTY (the value
  // came from the ambient shell, not --env), the optional keys seeded empty,
  // and the project file that would shadow this write -- see
  // printPostWriteNotes. Computed from the WRITTEN entry, never the pre-merge
  // input.
  await printPostWriteNotes(printErr, {
    ambientOnly: ambientOnlyKeys(server.requiredEnvKeys, written, env),
    optional: {
      ambient: ambientOnlyKeys(server.optionalEnvKeys, written, env),
      unset: unsetOptionalKeys(server.optionalEnvKeys, written, env),
      namespace: finalNamespace,
    },
    // From the entry as WRITTEN, not from the flags: a re-add merges with what
    // was already on disk, so the stored refs are what will actually resolve.
    dangling: await danglingSecretRefs(written, home),
    cwd,
    home,
    appData,
    env,
    dryRun: false,
  });
  return { exitCode: 0, written: [res.path] };
}

// --- add --git ----------------------------------------------------------------

/** Both ends a TTY, as for `remove` -- and never under --json, whose stdout is
 *  the document. */
function gitInteractive(opts: AddCommandOptions): boolean {
  if (opts.json) return false;
  if (opts.isTTY !== undefined) return opts.isTTY;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** The env a git entry is written with: each declared secret as a
 *  `${secret:NAME}` reference (never a value), a declared default as itself,
 *  and --env over both. */
function gitEntryEnv(manifest: GitManifest, overrides: Record<string, string>): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const [k, d] of Object.entries(manifest.env ?? {})) {
    if (d.secret) env[k] = `\${secret:${d.secret}}`;
    else if (d.default !== undefined) env[k] = d.default;
    else if (d.required) env[k] = "";
  }
  for (const [k, v] of Object.entries(overrides)) {
    const trimmed = v.trim();
    if (trimmed !== "") env[k] = trimmed;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/** One real handshake: connect, count the tools, disconnect. The teardown is
 *  withTransientUpstream's. A failure to connect comes back worded for a
 *  shell (shellActivationMessage): the activation error's own text ends in a
 *  remedy addressed to an MCP client. An error with no config pointer -- a
 *  locked vault -- passes through verbatim, which startRemedy relies on. */
export async function defaultStartCheck(
  config: UpstreamServerConfig,
): Promise<{ ok: true; tools: number } | { ok: false; error: string }> {
  try {
    const tools = await withTransientUpstream(config, async (conn) => conn.tools.length);
    return { ok: true, tools };
  } catch (e) {
    if (e instanceof TransientConnectError) return { ok: false, error: shellActivationMessage(e.cause) };
    throw e;
  }
}

/** `yaw-mcp secrets set` for these names: the real name for one, the command
 *  shape for several (one name in the command would store just that one). */
function secretsSetRemedy(names: string[]): string {
  return names.length === 1 ? `\`yaw-mcp secrets set ${names[0]}\`` : "`yaw-mcp secrets set <name>`, once per name";
}

/** What to do about a start check that failed. A locked or missing vault is
 *  fixed in the vault, not in the entry's env. */
function startRemedy(
  started: { ok: false; error: string } | { ok: true } | null,
  namespace: string,
  missingSecrets: string[],
): string {
  if (missingSecrets.length > 0) {
    return `Store ${missingSecrets.length === 1 ? "its secret" : "its secrets"} with ${secretsSetRemedy(missingSecrets)}, then check with yaw-mcp doctor.`;
  }
  if (started !== null && !started.ok && started.error.startsWith("vault locked:")) {
    return "Set YAW_MCP_VAULT_PASSPHRASE where yaw-mcp runs (the passphrase that unlocks your vault), then check with yaw-mcp doctor.";
  }
  return `Set its env (yaw-mcp set ${namespace} env.KEY ...) and check with yaw-mcp doctor.`;
}

/** A start-check failure cut to the part a reader acts on, safe to print. */
export function startFailureTail(error: string, secrets: Record<string, string>): string {
  const text = redactGitOutput(error, secrets).replace(/\s+/g, " ").trim();
  return printable(text.length > 400 ? `...${text.slice(-400)}` : text).replace(/\.$/, "");
}

/** The secret and env bindings a git entry is written with, one line each.
 *  Never a literal value: it may be a credential. */
function gitEnvBindingLines(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).map(([k, v]) => {
    const refs = [...collectSecretRefNames({ [k]: v })];
    if (refs.length > 0) return `  ${k} <- vault secret ${refs.join(", ")}`;
    return v === "" ? `  ${k} <- (required; not set)` : `  ${k} <- a value (not shown)`;
  });
}

async function runAddGit(opts: AddCommandOptions, spec: GitSpec): Promise<AddCommandResult> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  // The --json document is data and goes out as written; everything else is
  // text for a terminal, and build and git output is a repo's own text: it
  // can carry non-ASCII and terminal control sequences.
  const print = (s = ""): void => out(`${opts.json ? s : asciiLines(s)}\n`);
  const printErr = (s: string): void => err(`${asciiLines(s)}\n`);
  // Progress belongs with the result on a terminal, and off stdout under
  // --json, where stdout is the document.
  const progress = opts.json ? printErr : print;
  const warn = (w: string): void => printErr(`warning: ${w}`);
  const fail = (f: { exitCode: number; message: string }): AddCommandResult => {
    // Under --json the failure is the result, so it leaves as a document on
    // stdout as well as the human line on stderr -- zero bytes on stdout used
    // to mean both "refused" and "worked quietly". Every fail() here runs
    // BEFORE the success document is printed, so stdout carries exactly one
    // document either way. A catalog, --command or --url add prints the same
    // document on its failures (runAddDirect), and runAdd covers a rejection.
    if (opts.json) print(addJsonFailure(`yaw-mcp add: ${f.message}`, f.exitCode));
    printErr(`yaw-mcp add: ${f.message}`);
    return { exitCode: f.exitCode, written: [] };
  };
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const interactive = gitInteractive(opts);

  if (opts.slug !== undefined && !CATALOG_SLUG_RE.test(opts.slug)) {
    return fail({ exitCode: 2, message: `invalid name "${opts.slug}" (lowercase letters, digits, and dashes only).` });
  }
  const nameNamespace = opts.slug !== undefined ? deriveNamespace(opts.slug) : undefined;

  const prepared = await prepareGit(spec, opts.gitTokenSecret, {
    home,
    env,
    interactive,
    warn,
    resolveToken: opts.resolveToken,
  });
  if (!prepared.ok) return fail(prepared);
  if (!(await gitAvailable(prepared.run))) return fail({ exitCode: 2, message: GIT_MISSING_MESSAGE });
  const resolved = await resolveGitRef(spec, prepared, opts.gitTokenSecret, opts.project === true);
  if (!resolved.ok) return fail(resolved);
  const pin = resolved.commit ?? resolved.shortSha ?? "";
  const kindLabel = { branch: "branch", tag: "tag", sha: "commit", head: "HEAD" }[resolved.kind];
  progress(`Resolving ${spec.ref ?? "the default branch"} ... ${pin.slice(0, 12)} (${kindLabel})`);
  const tracking = resolved.kind === "sha" ? "pinned" : `tracking ${resolved.ref}`;

  if (opts.dryRun) {
    if (opts.json) {
      print(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            url: spec.url,
            ref: resolved.ref,
            kind: resolved.kind,
            commit: resolved.commit ?? null,
            namespace: nameNamespace ?? null,
          },
          null,
          2,
        ),
      );
    } else {
      const later = resolved.commit ? "" : " (a short SHA; the clone completes it to a full commit)";
      print(`yaw-mcp add (dry-run): would pin ${spec.url} @ ${pin} (${tracking})${later}`);
      if (nameNamespace) print(`  as "${nameNamespace}"`);
      else {
        print(
          `  name: from the repo's yaw-mcp.json if it declares a namespace (a dry run does not clone to read it); otherwise pass one: yaw-mcp add <name> --git ${spec.url}`,
        );
      }
    }
    return { exitCode: 0, written: [] };
  }

  const build = await buildGitSource(
    {
      spec,
      ref: resolved.ref,
      commit: pin,
      ...(nameNamespace ? { namespace: nameNamespace } : {}),
      ...(opts.subdir ? { subdir: opts.subdir } : {}),
      ...(opts.entry ? { entry: opts.entry } : {}),
      ...(opts.gitTokenSecret ? { tokenSecret: opts.gitTokenSecret } : {}),
    },
    {
      home,
      env,
      interactive,
      yes: opts.yes === true,
      progress,
      warn,
      // Ctrl+C there fails the build with exit 130, which fail() passes on.
      confirm: scriptConsentConfirm(opts, print),
      runPm: opts.runPm,
      git: prepared,
    },
  );
  if (!build.ok) return fail(build);
  const namespace = build.namespace;
  const manifest = build.manifest;

  const entryEnv = gitEntryEnv(manifest, opts.envOverrides ?? {});
  const git: GitSource = {
    url: spec.url,
    ref: resolved.ref,
    commit: build.commit,
    ...(build.subdir ? { subdir: build.subdir } : {}),
    entry: build.entry,
    ...(opts.gitTokenSecret && spec.protocol === "https" ? { tokenSecret: opts.gitTokenSecret } : {}),
  };
  const name = opts.slug ?? namespace;
  const entry: Partial<UpstreamServerConfig> & { slug?: string } = {
    id: `local-${namespace}`,
    name,
    namespace,
    ...(opts.slug ? { slug: opts.slug } : {}),
    type: "local",
    transport: "stdio",
    git,
    ...(opts.serverArgs ? { args: opts.serverArgs } : {}),
    ...(entryEnv ? { env: entryEnv } : {}),
    isActive: true,
    description: opts.description ?? manifest.description,
  };

  let configDir: string | undefined;
  if (opts.project) {
    configDir = (await findProjectConfigDir(cwd, home, env).catch(() => null)) ?? join(cwd, CONFIG_DIRNAME);
  }
  const upsertOpts = { home, origin: "custom" as const, ...(configDir ? { configDir } : {}) };
  const bundlesPath = localBundlesPath(configDir ?? userConfigDir(home));
  // A refusal past this point comes AFTER the build, and the entry that would
  // have pinned it is not written. A build this add made is deleted again
  // unless some file pins it; one that was already there is not this add's to
  // delete.
  const refuse = async (message: string): Promise<AddCommandResult> => {
    if (!build.reused) {
      const gone = await discardUnpinnedBuild(namespace, build.commit, home, { cwd, env });
      if (gone.reason !== undefined) warn(`the build at ${build.dir} was not deleted: ${gone.reason}`);
    }
    return fail({ exitCode: 1, message });
  };
  // What the write below would do, read once. An unreadable file is null: the
  // write fails on it with its own error.
  const preview = await previewUpsertUserBundle(entry, upsertOpts).catch(() => null);
  if (preview?.refusal) {
    for (const w of preview.warnings) printErr(`warning: ${w}`);
    return refuse(formatBundleCollision(preview.refusal, displaySafe));
  }
  // A name the repo chose may not take over an entry the user already has:
  // the merge would carry that entry's stored env (its credentials) into
  // this repo's server. Only a name the user typed replaces one -- or the
  // entry is this same repo and package, whose env it already had.
  if (opts.slug === undefined && preview !== null) {
    const was = preview.replacing?.git;
    const sameRepo =
      was !== undefined &&
      normalizeRepoUrl(was.url) === normalizeRepoUrl(spec.url) &&
      // Compared as directories: an entry an earlier add wrote may spell the
      // subdir "./pkg", and build.subdir is always the tidy "pkg".
      relativeSegments(was.subdir ?? "").join("/") === (build.subdir ?? "");
    if (preview.replaced && !sameRepo) {
      // Only a typed name that derives this same namespace replaces it.
      const replace =
        CATALOG_SLUG_RE.test(namespace) && deriveNamespace(namespace) === namespace
          ? `To replace it, name it yourself: yaw-mcp add ${namespace} --git ${spec.url}`
          : `To replace it, remove it first: yaw-mcp remove ${namespace}`;
      return refuse(
        `the repo's yaw-mcp.json names this server "${namespace}", and ${bundlesPath} already has a server by that name; nothing was written. ${replace}. To keep both, pick another name: yaw-mcp add <name> --git ${spec.url}`,
      );
    }
  }
  // The write keeps the STORED namespace of an entry it matches by name only
  // (see upsertUserBundle), and the loader launches a git entry from the build
  // directory of the namespace it stores -- while this build sits under
  // `namespace`. Written, the entry would point at a build that is not there.
  if (preview?.namespace !== undefined && preview.namespace !== namespace) {
    const kept = displaySafe(preview.namespace);
    return refuse(
      `${bundlesPath} already has a server named "${displaySafe(name)}" under the namespace "${kept}", and this build is for "${namespace}"; nothing was written. Remove that one first (yaw-mcp remove ${kept}), or pick another name: yaw-mcp add <name> --git ${spec.url}`,
    );
  }

  // Said every time, consent or --yes or not: these are what the repo's
  // server is handed at each start.
  const bindings = gitEnvBindingLines(entryEnv);
  if (bindings.length > 0) {
    progress("Env it is written with:");
    for (const l of bindings) progress(l);
  }

  // Each secret the entry will reference and the vault lacks is offered once,
  // through the same `secrets set` path; skipped, the server still asks at
  // runtime. Read off the env being written, so a --env ref is offered too.
  if (interactive) {
    const wanted = [...collectSecretRefNames(entryEnv)];
    let stored = new Set<string>();
    try {
      const vault = await loadVault(vaultPath(home));
      stored = new Set(vault ? listKeys(vault) : []);
    } catch {
      // An unreadable vault offers every secret; `secrets set` reports the cause.
    }
    const storeSecret =
      opts.storeSecret ??
      (async (secretName: string): Promise<boolean> => {
        const r = await runSecrets(
          {
            action: "set",
            name: secretName,
            home,
            cwd,
            referenceFollows: true,
            io: opts.io as SecretsCommandOptions["io"],
          },
          { out: (s) => out(s), err: (s) => err(s) },
        );
        return r.exitCode === 0;
      });
    for (const secretName of wanted.filter((n) => !stored.has(n))) {
      const answer = await askYesNo(opts, `${secretName} is not in your vault. Store it now? [Y/n] `);
      if (answer === QUESTION_CANCELLED || (answer !== "" && answer !== "y" && answer !== "yes")) continue;
      await storeSecret(secretName);
    }
  }

  let started: { ok: true; tools: number } | { ok: false; error: string } | null = null;
  if (!opts.noStartCheck) {
    const pkgDir = join(build.dir, ...(build.subdir ?? "").split(/[\\/]/).filter(Boolean));
    // Started with the args and env the write will store, not just the ones
    // this add brought: a git-over-git re-add (a ref switch) keeps the stored
    // server args, and the merge keeps stored env values. An unreadable file
    // fails the write below with its own error; the check then uses this add's.
    const willStore = preview?.entry ?? entry;
    const storedArgs = Array.isArray(willStore.args) ? willStore.args : [];
    const checkEnv = willStore.env && Object.keys(willStore.env).length > 0 ? willStore.env : undefined;
    // No `git` on this config: its activation preflight looks under the real
    // home, and the build it would look for is the one just made.
    started = await (opts.startCheck ?? defaultStartCheck)({
      id: `local-${namespace}`,
      name,
      namespace,
      type: "local",
      transport: "stdio",
      command: gitNodeCommand(),
      args: [join(pkgDir, ...build.entry.split(/[\\/]/)), ...storedArgs],
      cwd: pkgDir,
      ...(checkEnv ? { env: checkEnv } : {}),
      isActive: true,
    });
    progress(`Checking it starts ... ${started.ok ? `ok -- ${started.tools} tools` : "failed"}`);
  }

  let res: Awaited<ReturnType<typeof upsertUserBundle>>;
  try {
    res = await upsertUserBundle(entry, upsertOpts);
  } catch (e) {
    // A collision the preview above did not see: the file changed since.
    if (e instanceof BundleCollisionError) {
      for (const w of e.warnings) printErr(`warning: ${w}`);
      return refuse(formatBundleCollision(e.collision, displaySafe));
    }
    // An unreadable file: the build stays, and the re-run after the fix reuses it.
    return fail({ exitCode: 1, message: nameBundlesFileOnce((e as Error).message, bundlesPath) });
  }
  for (const w of res.warnings) warn(w);
  await recordGitPin(namespace, res.path, build.commit, home, warn);
  if (res.launchChanged) {
    printErr(`Note: the entry's launch changed:\n${renderLaunchChange(res.launchChanged)}`);
  }
  const written = res.entry;
  const dangling = await danglingSecretRefs(written, home);
  const startError = started && !started.ok ? startFailureTail(started.error, prepared.secrets) : null;
  if (opts.json) {
    print(
      JSON.stringify(
        {
          ok: true,
          namespace,
          path: res.path,
          replaced: res.replaced,
          commit: build.commit,
          reused: build.reused,
          started: started === null ? null : started.ok,
          ...(started?.ok ? { tools: started.tools } : {}),
          ...(startError !== null ? { startError } : {}),
          ...(res.projectTrust ? { projectTrust: res.projectTrust } : {}),
          entry: jsonEntry(written),
        },
        null,
        2,
      ),
    );
  } else {
    if (startError !== null) {
      print(`Added, but it did not start: ${startError}. ${startRemedy(started, namespace, dangling.missing)}`);
    } else {
      print(`${res.replaced ? "Updated" : "Added"} "${namespace}" in ${res.path}`);
    }
    print(`  git ${spec.url} @ ${build.commit.slice(0, 7)} (${tracking})`);
    print(`  Update with: yaw-mcp update ${namespace}`);
  }
  if (res.projectTrust === "regranted") {
    printErr(`Note: ${res.path} was trusted before this edit, so the new contents are trusted too.`);
  } else if (res.projectTrust === "untrusted") {
    printErr(`Note: ${res.path} is not trusted on this machine, so it does not load until you run yaw-mcp trust.`);
  }
  if (dangling.missing.length > 0) {
    const one = dangling.missing.length === 1;
    printErr(
      `Note: ${dangling.missing.join(", ")} ${one ? "is" : "are"} not in your vault yet; the server asks for ${one ? "it" : "them"} at runtime, or store ${one ? "it" : "each"} with ${secretsSetRemedy(dangling.missing)}.`,
    );
  }
  // The entry IS written (and `written` says so) while the handshake that
  // proves it launches failed: exit 0 told a script the add was fine when the
  // server it just added does not start. `update` exits 1 for the same
  // failure too, but WITHOUT writing: it keeps the previous pin, which still
  // runs (see the header of update-cmd.ts). `add` has no previous build to
  // keep, so the entry stays written and the exit code carries the failure.
  return { exitCode: startError !== null ? 1 : 0, written: [res.path] };
}

// --- remove -----------------------------------------------------------------

export const REMOVE_USAGE = `Usage: yaw-mcp remove <slug-or-namespace> [--force] [--keep-checkout]

  Remove a server from your local ~/.yaw-mcp/bundles.json. Accepts the catalog
  slug it was added with (e.g. "brave-search"), its namespace as shown by
  \`yaw-mcp list\` (e.g. "bravesearch"), or its NAME from that same listing
  (e.g. "Brave Search") -- the name is the handle an IMPORTED server has, since
  it carries no catalog slug. No-op if it isn't present.

  Dropping an entry also drops any env value stored on it, so when there IS
  something to remove you are shown the server -- namespace, name, and the
  command or url it launches -- and asked to confirm. A bare Enter is NO.

  A git server's builds under ~/.yaw-mcp/git/<namespace> are deleted with it,
  except a build another bundles.json on this machine still pins; the
  confirmation names each one it keeps.

  --force, -y, --yes  Skip the confirmation. Required when stdin or stdout
                      is not a TTY (there is nothing to ask on).
  --keep-checkout     Keep a git server's builds on disk.`;

export interface RemoveCommandOptions {
  target?: string;
  /** Skip the destructive-action confirmation. Required off a TTY. */
  force?: boolean;
  /** Leave a git server's ~/.yaw-mcp/git/<ns> in place. */
  keepCheckout?: boolean;
  home?: string;
  cwd?: string;
  /** Environment the command runs under. Only the project-shadow check reads
   *  it (YAW_MCP_TRUST_PROJECT decides whether a project bundles.json is
   *  honoured at all), but it must be threaded rather than defaulted inside
   *  findShadowingProjectBundles: an embedded or test caller that injects an
   *  env expects THAT env to decide, not the real process's. */
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: override the TTY verdict instead of reading process.std*. */
  isTTY?: boolean;
  /** Test hook: answer the confirmation without a real TTY read. */
  promptAnswer?: string;
  /** Test hook: replaces process.stdin/stdout for the interactive prompt.
   *  `terminal` forces readline's keypress mode (what a real TTY gets), so a
   *  test can deliver Ctrl+C the way a terminal does. */
  io?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; terminal?: boolean };
}

export function parseRemoveArgs(
  argv: string[],
): { ok: true; options: RemoveCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: REMOVE_USAGE };
  const positional: string[] = [];
  const opts: RemoveCommandOptions = {};
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: REMOVE_USAGE, help: true };
    // --force is the name `secrets remove` uses; -y / --yes is the name `trust`
    // uses. Both siblings gate a destructive write, so both spellings are
    // accepted here rather than making the user remember which verb took which.
    if (a === "--force" || a === "--yes" || a === "-y") {
      opts.force = true;
      continue;
    }
    if (a === "--keep-checkout") {
      opts.keepCheckout = true;
      continue;
    }
    // Single dash included, not just "--": now that -y is a real flag, a
    // mistyped short flag must be reported as an unknown flag instead of
    // becoming the removal TARGET. (No valid target starts with "-";
    // STORED_TARGET_RE requires a leading alphanumeric.)
    if (a.startsWith("-")) return { ok: false, error: `Unknown flag: ${a}\n${REMOVE_USAGE}` };
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one slug or namespace.\n${REMOVE_USAGE}` };
  }
  opts.target = positional[0];
  return { ok: true, options: opts };
}

// --- removal confirmation ---------------------------------------------------
//
// `remove` was the only destructive verb in the CLI with no gate: it deleted
// the entry on a TTY and off it alike. It now follows the idiom its siblings
// already set -- `secrets remove` (confirm on a TTY, refuse off one without
// --force) and `trust` (isTTY + promptAnswer test hooks, bare Enter = NO).
//
// The gate fires ONLY when something is actually going to be deleted. A target
// that isn't in the file, or no file at all, stays the exit-0 "nothing to do"
// no-op it has always been -- refusing to no-op off a TTY would break cleanup
// scripts for no safety gain.

/** Enough of the doomed entry to show the user WHAT they are dropping. A slug
 *  alone would teach them to hit `y` without reading. */
interface RemovalTarget {
  namespace: string;
  name: string;
  /** Rendered launch line ("$ npx -y pkg" / "HTTP https://...") . */
  launch: string;
  /** env KEY names only -- never values; bundles.json env can hold secrets. */
  envKeys: string[];
  /** header NAMES only, same posture as envKeys and for a sharper reason: on a
   *  REMOTE entry `headers` is the credential channel (env is ignored on one --
   *  see upstream.ts), so an Authorization value here is a live bearer token.
   *  The preview listed env alone, which meant removing a remote server showed
   *  nothing at all about the credential going with it. */
  headerNames: string[];
  /** A git entry's builds on disk: the ones removal deletes (and their size),
   *  the ones it keeps because another bundles.json still pins them, and the
   *  files it could not read (then it deletes none). */
  checkout?: { dir: string; deletes: string[]; bytes: number; keeps: GitPinnedBuild[]; unreadable: string[] };
}

/**
 * The RAW `servers` array of a bundles.json, or null when this read cannot
 * say: no file, an unreadable file, a parse failure, or a root / `servers`
 * field that isn't the expected shape. Every raw lookup in this file goes
 * through here -- three copies of this preamble is how they drifted apart.
 *
 * PARSE WITH THE WRITE PATH'S PARSER. parseJsonc is what readBundlesAt (and so
 * removeUserBundle) uses, and it accepts `//` comments and trailing commas.
 * Gating on the stricter JSON.parse instead meant a bundles.json carrying one
 * hand-added `// prod token lives in 1Password` line looked malformed HERE
 * while the write path parsed and deleted from it happily -- so the removal
 * preview, the off-TTY refusal AND the [y/N] prompt were all skipped on
 * exactly the hand-edited files most likely to hold a stored secret. The two
 * parsers must see the same set of files or the gate does not cover the write.
 *
 * RAW, deliberately NOT through previewBundlesContent: that runs validateEntry,
 * which DROPS malformed entries, while removeUserBundle filters raw entries by
 * namespace string. An entry validateEntry rejects is still one
 * removeUserBundle deletes, so a validated lookup would let it be deleted with
 * no confirmation at all.
 */
async function readRawServers(path: string): Promise<unknown[] | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const servers = (parsed as { servers?: unknown }).servers;
  return Array.isArray(servers) ? servers : null;
}

/**
 * Which candidate namespace is really present in the user-global bundles.json,
 * plus the fields the preview renders. Null when there is nothing to confirm:
 * no match, or a file readRawServers could not read or parse (null `servers`).
 *
 * A null return skips the gate, which is safe because the two shapes behind it
 * end differently in runRemove: a genuine miss stays the exit-0 "nothing to do"
 * no-op it has always been, while an unreadable / malformed file reaches
 * removeUserBundle, whose readRawUserBundles THROWS rather than clobber a file
 * it could not parse -- surfacing the same error `remove` has always printed
 * instead of a bogus "nothing to remove". There is deliberately no
 * found/uncertain distinction in the return value: nothing ever consumed it,
 * and a flag no caller reads documents an invariant nothing enforces.
 */
async function findRemovalTarget(
  candidates: string[],
  servers: unknown[] | null,
  home: string,
  where: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<RemovalTarget | null> {
  if (servers === null) return null;
  for (const ns of candidates) {
    // Same predicate as doRemoveUserBundle's filter (s?.namespace !== ns), so
    // the preview can never disagree with what the write actually deletes.
    const hit = servers.find((s) => (s as { namespace?: unknown } | null)?.namespace === ns) as Record<
      string,
      unknown
    > | null;
    if (!hit) continue;
    const name = typeof hit.name === "string" && hit.name.length > 0 ? hit.name : "(unnamed)";
    // Same shape test for both maps: this entry is RAW (never validated -- see
    // the doc above), so an array or a string in either field must read as "no
    // keys" rather than reaching Object.keys and rendering indices.
    const plainMap = (v: unknown): Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const env = plainMap(hit.env);
    const headers = plainMap(hit.headers);
    return {
      namespace: ns,
      name,
      launch: renderLaunch(hit),
      envKeys: Object.keys(env),
      headerNames: Object.keys(headers),
      ...(isGitEntry(hit) && existsSync(gitCheckoutDir(ns, home))
        ? { checkout: await checkoutPlan(ns, home, where) }
        : {}),
    };
  }
  return null;
}

async function checkoutPlan(
  ns: string,
  home: string,
  where: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<NonNullable<RemovalTarget["checkout"]>> {
  const plan = await planGitRemoval(ns, home, localBundlesPath(userConfigDir(home)), where);
  return {
    dir: gitCheckoutDir(ns, home),
    deletes: plan.deletes.map((d) => d.sha12),
    bytes: plan.deletes.reduce((n, d) => n + d.bytes, 0),
    keeps: plan.keeps,
    unreadable: plan.unreadable,
  };
}

/** Builds by their short commit, as one list. */
function buildNames(sha12s: string[]): string {
  return sha12s.map((s) => s.slice(0, 7)).join(", ");
}

/** What remove keeps of a git server's builds, and which file still pins each. */
function keptBuildLines(keeps: GitPinnedBuild[]): string[] {
  return keeps.map((k) => `keeps ${k.sha12.slice(0, 7)}: still pinned by ${k.files.map(displaySafe).join(", ")}`);
}

/** A raw entry carrying a git block, the shape the loader launches from it. */
function isGitEntry(entry: unknown): boolean {
  const git = (entry as { git?: unknown } | null)?.git;
  return git !== null && typeof git === "object" && typeof (git as { url?: unknown }).url === "string";
}

/** How the entry would be launched, as one reviewable line. Mirrors
 *  trust-cmd's renderLaunch, but reads an UNVALIDATED raw entry (see
 *  findRemovalTarget) so every field is type-checked before use. The
 *  parameter is typed loosely so a raw bundles.json record and a LaunchShape
 *  (see renderLaunchChange) both fit; the checks below are the contract. */
function renderLaunch(entry: { command?: unknown; args?: unknown; url?: unknown; git?: unknown }): string {
  // Git first, as the loader lets it win over a command the entry also carries.
  const git = entry.git !== null && typeof entry.git === "object" ? (entry.git as Record<string, unknown>) : undefined;
  if (git && typeof git.url === "string" && git.url.length > 0) {
    const subdir = typeof git.subdir === "string" && git.subdir.length > 0 ? ` (subdir ${displayArg(git.subdir)})` : "";
    const at =
      typeof git.commit === "string" && git.commit.length > 0 ? ` @ ${displayArg(git.commit.slice(0, 12))}` : "";
    return `git ${displaySafe(git.url)}${at}${subdir}`;
  }
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  const parts = [command, ...args].filter((p) => p.length > 0);
  // Args containing whitespace or quotes are quoted, so `sh -c "curl ... | sh"`
  // reads as the single argument it really is instead of blending into the line.
  if (parts.length > 0) return `$ ${parts.map(displayArg).join(" ")}`;
  const url = typeof entry.url === "string" ? entry.url : "";
  return url.length > 0 ? `HTTP ${displaySafe(url)}` : "(no command)";
}

/** Render the doomed entry. Shared by the TTY prompt and the off-TTY refusal:
 *  a scripted run gets to see what it WOULD have removed before being told
 *  which flag to re-run with (same courtesy as `yaw-mcp trust`). */
function printRemovalPreview(print: (s?: string) => void, path: string, t: RemovalTarget, keepCheckout: boolean): void {
  print("");
  print(`  Remove from ${displaySafe(path)}:`);
  print("");
  print(`    namespace: ${t.namespace}`);
  print(`    name:      ${displaySafe(t.name)}`);
  print(`    launch:    ${t.launch}`);
  if (t.envKeys.length > 0) print(`    env keys:  ${t.envKeys.map(displayArg).join(", ")}`);
  // NAMES only, like env -- and the line only appears when there are headers,
  // so a local entry's preview is unchanged.
  if (t.headerNames.length > 0) print(`    header names: ${t.headerNames.map(displayArg).join(", ")}`);
  if (t.checkout) {
    const c = t.checkout;
    const size = `${(c.bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (keepCheckout) {
      const all = `${(treeSizeBytes(c.dir) / (1024 * 1024)).toFixed(1)} MB`;
      print(`    checkout:  keeps ${displaySafe(c.dir)} (${all}; --keep-checkout)`);
    } else if (c.unreadable.length > 0) {
      print(
        `    checkout:  deletes nothing under ${displaySafe(c.dir)}: could not read ${c.unreadable.map(displaySafe).join(", ")}`,
      );
      for (const line of keptBuildLines(c.keeps)) print(`               ${line}`);
    } else if (c.keeps.length === 0) {
      print(`    checkout:  deletes ${displaySafe(c.dir)} (${size})`);
      if (c.deletes.length > 0) print(`               builds ${buildNames(c.deletes)}`);
    } else {
      const n = `${c.deletes.length} build${c.deletes.length === 1 ? "" : "s"}`;
      print(`    checkout:  deletes ${n} under ${displaySafe(c.dir)} (${size})`);
      if (c.deletes.length > 0) print(`               deletes ${buildNames(c.deletes)}`);
      for (const line of keptBuildLines(c.keeps)) print(`               ${line}`);
    }
  }
  print("");
  print("  yaw-mcp will stop loading it. Any env value or header stored on the");
  print("  entry goes with it -- and for a remote server the header IS the");
  print("  credential. Re-adding it will not bring those values back.");
  print("");
}

/** Both ends must be a TTY: stdin to read the answer, stdout to show the
 *  question. Mirrors trust-cmd.ts:isInteractive. */
function isInteractive(opts: RemoveCommandOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

export async function runRemove(opts: RemoveCommandOptions): Promise<AddCommandResult> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.target) {
    printErr(REMOVE_USAGE);
    return { exitCode: 2, written: [] };
  }
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  // Try the literal target first -- covers a namespace copied from `list`
  // (including legacy underscore namespaces from older `add` versions). Then
  // any namespace whose entry RECORDS this target as its slug or its display
  // name (namespacesForStoredIdentity; `add` persists the slug, so "ga" ->
  // "googleanalytics" is unreachable any other way, and an IMPORTED entry has
  // no slug at all so its name is the only identity the user has been shown).
  // Then the derived form so passing the catalog SLUG also works for the common
  // case where slug and name agree ("brave-search" -> "bravesearch").
  // deriveNamespace strips non-alphanumerics, so it would mangle an underscore
  // namespace; that's why the literal goes first.
  //
  // ONE read for both raw lookups (the identity map and the removal preview).
  // They used to read and parse the same file independently, before
  // removeUserBundle read it a third time -- and two reads of one file are two
  // chances to disagree about its contents. A concurrent edit can still land
  // between this read and the write, which is why the write path re-reads and
  // re-matches; this snapshot only decides what to SHOW and which namespaces
  // to try.
  const path = localBundlesPath(userConfigDir(home));
  const rawServers = await readRawServers(path);
  const byIdentity = namespacesForStoredIdentity(opts.target, rawServers);
  const candidates = [...new Set([opts.target, ...byIdentity, deriveNamespace(opts.target)])];

  // The shape gate runs AFTER the identity lookup, not before it, and that
  // ordering is the whole of the name feature: a display name can hold spaces,
  // capitals and dots, none of which STORED_TARGET_RE admits, so checking
  // first refused every imported server by the only name its owner has been
  // shown. It is demoted, not deleted -- a target that no stored entry answers
  // to is still a usage error (exit 2), which is what keeps `remove GA` from
  // becoming the exit-0 "nothing to do" that reads as "already gone".
  //
  // The read above cannot report a target as valid on a file it could not
  // parse (byIdentity is [] then), so a malformed bundles.json still reaches
  // the write path below and surfaces its own parse error.
  if (byIdentity.length === 0 && !STORED_TARGET_RE.test(opts.target)) {
    printErr(
      `yaw-mcp remove: "${displaySafe(opts.target)}" isn't a valid slug or namespace (lowercase letters, digits, dashes and underscores only), and no configured server carries that name.`,
    );
    return { exitCode: 2, written: [] };
  }

  // ----- destructive-action confirmation --------------------------------
  // Gated on there being something to delete (see findRemovalTarget): a miss
  // or an unreadable/malformed file skips straight to the loop below, which
  // keeps the exit-0 no-op and the existing parse-error message intact.
  //
  // The preview is not re-checked after the answer the way `trust` re-hashes
  // the file it is approving. That check exists there because approval grants
  // EXECUTION authority to content a repo controls; here the file is the
  // user's own, the write below re-reads it anyway, and the worst case of a
  // concurrent edit is an entry `yaw-mcp add` puts straight back.
  if (!opts.force) {
    const doomed = await findRemovalTarget(candidates, rawServers, home, { cwd, env });
    if (doomed) {
      printRemovalPreview(print, path, doomed, opts.keepCheckout === true);
      if (!isInteractive(opts)) {
        // Exit 2, matching `secrets remove`'s off-TTY refusal: a required flag
        // is missing, which is this CLI's usage-error code. (A DECLINED prompt
        // is exit 1 below -- the argv was fine, the user said no.)
        printErr(
          `yaw-mcp remove: refusing to remove "${doomed.namespace}" without a confirmation -- stdin/stdout is not a TTY.`,
        );
        printErr("  Re-run with --force (or -y) to remove it.");
        return { exitCode: 2, written: [] };
      }
      const answer = await askYesNo(opts, `  Remove "${doomed.namespace}"? [y/N] `);
      if (answer === QUESTION_CANCELLED) {
        // Ctrl+C at the prompt: exit 130, like every other prompt in the
        // product, rather than the decline's exit 1.
        printErr("yaw-mcp remove: Cancelled. Nothing was removed.");
        return { exitCode: 130, written: [] };
      }
      if (answer !== "y" && answer !== "yes") {
        printErr("yaw-mcp remove: Aborted. Nothing was removed.");
        return { exitCode: 1, written: [] };
      }
    }
  }

  let res: Awaited<ReturnType<typeof removeUserBundle>> | null = null;
  let matched = "";
  // One file, several candidate namespaces: every attempt re-reads it and
  // reports the same diagnostics, so they are deduped before printing.
  const warnings = new Set<string>();
  try {
    for (const ns of candidates) {
      res = await removeUserBundle(ns, { home });
      for (const w of res.warnings) warnings.add(w);
      if (res.removed) {
        matched = ns;
        break;
      }
    }
  } catch (e) {
    // Same writer, same message, same de-duplication -- `remove` reaches
    // readRawUserBundles through removeUserBundle.
    printErr(`yaw-mcp remove: ${nameBundlesFileOnce((e as Error).message, path)}`);
    return { exitCode: 1, written: [] };
  }
  for (const w of warnings) printErr(`warning: ${w}`);

  if (!res?.removed) {
    // No-op exits 0 (like try-cleanup): "make it absent" succeeded. The file is
    // named from `path` above rather than off `res`: `candidates` is never
    // empty, so the loop always ran and `res` is only nullable to the type
    // checker -- and removeUserBundle derives the very same path from `home`,
    // so a `res?.path ?? "bundles.json"` fallback could never fire and only
    // documented an outcome that does not exist.
    print(`yaw-mcp remove: no server matching "${opts.target}" in ${path} (nothing to do).`);
    // `list` reads the project-local bundles.json when present (it overrides
    // user-global), but `remove` only manages user-global -- so a server the
    // user just saw in `list` can be "not found" here. Explain when that's why.
    const shadow = await findShadowingProjectBundles(cwd, home, env).catch(() => null);
    if (shadow) {
      printErr(
        `Note: a project-local ${displaySafe(shadow)} is in effect; \`remove\` only manages your user-global bundles.json, so a server defined there must be removed from that file directly.`,
      );
    }
    return { exitCode: 0, written: [] };
  }
  print(
    `Removed "${matched}" from ${res.path}. A running yaw-mcp unloads it on its next mcp_connect_* call -- no client restart.`,
  );

  // The raw snapshot says whether the entry was a git one; the builds are
  // deleted only after the entry is gone, so nothing loads a half-deleted tree.
  const removedRaw = rawServers?.find((s) => (s as { namespace?: unknown } | null)?.namespace === matched);
  if (isGitEntry(removedRaw) && !opts.keepCheckout) {
    const dir = gitCheckoutDir(matched, home);
    const existed = existsSync(dir);
    // cwd and env too: the project file found from here is one of the files
    // whose pins are kept, which is what makes the shadow note below true.
    const gone = await removeGitCheckout(matched, home, { cwd, env });
    for (const n of gone.notes) printErr(`warning: ${displaySafe(n)}`);
    const deleted = (removed: string[]): void => {
      if (removed.length > 0)
        print(`Deleted build${removed.length === 1 ? "" : "s"} ${buildNames(removed)} under ${displaySafe(dir)}.`);
    };
    if (!gone.ok) {
      deleted(gone.removed);
      // Only the builds that failed: the directory may hold builds another
      // file pins, so deleting all of it is never the advice.
      if (gone.failed.length > 0) {
        const paths = gone.failed.map((s) => displaySafe(join(dir, s))).join(", ");
        printErr(
          `Note: could not delete ${paths}: ${gone.message} Delete ${gone.failed.length === 1 ? "it" : "them"} once nothing runs from ${gone.failed.length === 1 ? "it" : "them"}.`,
        );
      } else {
        printErr(`Note: its git builds under ${displaySafe(dir)} were left in place: ${gone.message}`);
      }
      for (const line of keptBuildLines(gone.kept)) print(`  ${line}`);
    } else if (gone.unreadable.length > 0) {
      printErr(`Note: ${displaySafe(gitLivenessWarning(matched, gone.unreadable))}`);
      for (const line of keptBuildLines(gone.kept)) print(`  ${line}`);
    } else if (gone.kept.length === 0) {
      if (existed) {
        const which =
          gone.removed.length > 0 ? ` (build${gone.removed.length === 1 ? "" : "s"} ${buildNames(gone.removed)})` : "";
        print(`Deleted its git checkout at ${displaySafe(dir)}${which}.`);
      }
    } else {
      deleted(gone.removed);
      print(
        `Kept under ${displaySafe(dir)}, because another bundles.json pins ${gone.kept.length === 1 ? "it" : "them"}:`,
      );
      for (const line of keptBuildLines(gone.kept)) print(`  ${line}`);
    }
  }

  // Honest warning: a project-local bundles.json shadows the user-global file,
  // so the server may keep loading from there even after this removal.
  const shadow = await findShadowingProjectBundles(cwd, home, env).catch(() => null);
  if (shadow) {
    printErr(
      `Note: ${displaySafe(shadow)} shadows your user-global bundles.json; a server defined there is unaffected by this removal.`,
    );
  }
  return { exitCode: 0, written: [res.path] };
}

// --- list -------------------------------------------------------------------

export const LIST_USAGE = `Usage: yaw-mcp list [--json]

  List the MCP servers yaw-mcp loads locally from bundles.json (the
  project-local file wins over user-global), with the compliance grade
  \`yaw-mcp audit\` last cached for each. --json for machine output.
  Env vars appear as \`envKeys\` -- key NAMES only, never the stored
  values (same posture as \`add --json\`).

  Exits 0 when the file was read -- including a machine with no servers
  configured yet, which is not a fault. Exits 1 when bundles.json is there
  and could not be read or parsed, in both modes, so a script gating on
  \`list\` does not read a broken config as an empty machine.`;

export interface ListCommandOptions {
  json?: boolean;
  home?: string;
  cwd?: string;
  /** Environment the command runs under. Only the project-trust gate inside
   *  loadLocalBundles reads it (YAW_MCP_TRUST_PROJECT decides whether a project
   *  bundles.json is honoured at all), but it must be threaded rather than left
   *  to default inside the loader: `add` and `remove` deliberately inject theirs,
   *  and an embedded or test caller that supplies an env expects THAT env to
   *  decide which file `list` reads, not the real process's. */
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: supply a grade cache instead of reading ~/.yaw-mcp/grades.json. */
  gradesReader?: (home?: string) => Promise<GradesCache>;
}

/**
 * Env KEY names per namespace, read from the RAW winning bundles.json -- keys
 * only, never values. `list --json` cannot derive envKeys from the
 * loader-validated entries: validateEntry DROPS blank env values ("" is the
 * "required key, nothing stored" seed `add` writes -- see the blank-drop note
 * in local-bundles.ts), which is right for the spawn env but silently erased
 * exactly the required-key documentation `add --json` reports. Reading the raw
 * entry is the same posture printRemovalPreview already takes, and for the
 * same reason: describe what is ON DISK, not what the loader would spawn with.
 *
 * Best-effort: an unreadable or unparseable file yields an empty map and the
 * caller keeps the validated-entry derivation as its fallback.
 *
 * One QUEUE of key lists per namespace, in file order, because a namespace
 * can be duplicated and each entry must report its OWN keys. The pairing is
 * exact because only raw entries the loader KEEPS are queued (rawEntryLoads,
 * the loader's own validateEntry): an entry it skips -- a non-object, an
 * invalid namespace, a malformed `git` block -- is skipped here too, so the
 * n-th validated entry under a namespace is the n-th queued one. The caller
 * shifts the queue as it walks the validated list in order. (First-entry-wins
 * used to copy the first duplicate's keys onto the second, misreporting the
 * second's; queueing every raw object did the same once a bad git block could
 * drop the first duplicate.)
 */
async function rawEnvKeysByNamespace(path: string | null, home: string): Promise<Map<string, string[][]>> {
  const out = new Map<string, string[][]>();
  if (!path) return out;
  // Note the path is whichever file the LOADER won with (project-local can
  // beat user-global), unlike the removal lookups which are user-global only.
  const servers = await readRawServers(path);
  if (servers === null) return out;
  for (const s of servers) {
    const e = s as { namespace?: unknown; env?: unknown } | null;
    if (!e || typeof e.namespace !== "string" || !rawEntryLoads(s, home)) continue;
    const env = e.env && typeof e.env === "object" && !Array.isArray(e.env) ? (e.env as Record<string, unknown>) : {};
    const queue = out.get(e.namespace) ?? [];
    queue.push(Object.keys(env));
    out.set(e.namespace, queue);
  }
  return out;
}

export function parseListArgs(
  argv: string[],
): { ok: true; options: ListCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: ListCommandOptions = {};
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: LIST_USAGE, help: true };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument: ${a}\n${LIST_USAGE}` };
  }
  return { ok: true, options: opts };
}

export async function runList(opts: ListCommandOptions): Promise<AddCommandResult> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const loaded = await loadLocalBundles({ home, cwd, env: opts.env ?? process.env });
  const servers = loaded.config?.servers ?? [];

  // Always surface load warnings so malformed-file problems aren't silently
  // swallowed. They go to stderr in BOTH modes, before the listing / empty
  // state, so a script can still parse stdout cleanly while a human sees the
  // diagnostic; --json ALSO embeds them in the response body, for a consumer
  // that captured stdout alone.
  for (const w of loaded.warnings) printErr(`warning: ${w}`);

  // A bundles.json that is THERE and could not be used. The predicate is
  // `install`'s (summarizeBundles in install-cmd.ts): a null config WITH a
  // path means the file was found and could not be parsed, while a null path
  // means there was nothing to find. Computed here, above the --json return,
  // because both surfaces have to report it the same way.
  //
  // It is exit 1, the CLI's generic-failure code (2 is argv/usage, emitted by
  // index.ts's shared parse-then-dispatch tail). This is the same condition
  // and the same code `status` documents at the top of status-cmd.ts --
  // "genuinely unreadable: a bundles.json is present but could not be read or
  // parsed, so we cannot say what this machine loads" -- and the same one
  // `sidecars install` returns for its own `Could not read <path>` branch.
  // `doctor` reports 2 for the same file instead, which is not a
  // disagreement: doctor's documented gate is UNCONDITIONALLY "any warning is
  // a 2" (doctor-cmd.ts), and 0.77.0's CHANGELOG entry says in as many words
  // that a script keying on that 2 is the point of it.
  //
  // This branch printed a correct diagnostic and then exited 0, so a script
  // gating on `yaw-mcp list` saw success over a config yaw-mcp cannot load,
  // with zero servers available.
  //
  // Carried as the PATH rather than a boolean so the branch below still
  // narrows it for the message; a bare boolean does not, and re-spelling the
  // predicate there is how the two drift apart.
  const unreadablePath = loaded.config === null ? loaded.path : null;

  // Overlay the compliance grades `yaw-mcp audit` cached in ~/.yaw-mcp/
  // grades.json. This is the ONLY reader of that cache in local mode -- without
  // it, `audit` would be write-only and the grade would never reach a human.
  // A bundles.json entry can also carry a grade now (`yaw-mcp add` records the
  // catalog's published one), so the map below is a genuine precedence
  // decision rather than a fill-in: a cache hit REPLACES the config value,
  // because that letter was measured against the bytes on this machine while
  // the config one is what the catalog claimed at add time. A miss leaves
  // `s.complianceGrade` standing rather than blanking it. Applied to BOTH
  // --json and the table so the two surfaces agree. readGradesCache never
  // throws -- a missing or garbled cache just means no overlay.
  const gradesReader = opts.gradesReader ?? readGradesCache;
  const grades = await gradesReader(home).catch(() => ({}) as GradesCache);
  const graded: UpstreamServerConfig[] = servers.map((s) => {
    const cached = grades[s.namespace];
    return cached ? { ...s, complianceGrade: cached.grade } : s;
  });

  if (opts.json) {
    // Same env redaction as `add --json` (jsonEntry): a bundles.json entry can
    // carry a `--env` secret, and `list --json` gets piped into CI logs and
    // bug reports -- so servers are reported with `envKeys` (key NAMES only),
    // never the stored values. The keys come from the RAW on-disk entry (see
    // rawEnvKeysByNamespace): the validated entry has already had `add`'s ""
    // required-key seeds dropped, so deriving from it hid those keys from the
    // one machine surface that documents them. `complianceGradedAt` and (when
    // the cache entry carries it) `complianceSuiteVersion` ride along with the
    // grade, so a consumer can tell a letter graded under an older rubric from
    // a current one; entries audited before suiteVersion existed surface
    // timestamp only.
    const rawEnvKeys = await rawEnvKeysByNamespace(loaded.path, home);
    const jsonServers = graded.map((s) => {
      const entry = jsonEntry(s);
      // `graded` is the validated list in file order, so shifting pairs each
      // entry with its own raw keys even when the namespace is duplicated.
      const keys = rawEnvKeys.get(s.namespace)?.shift();
      if (keys !== undefined && keys.length > 0) entry.envKeys = keys;
      const cached = grades[s.namespace];
      if (cached) {
        entry.complianceGradedAt = cached.gradedAt;
        if (cached.suiteVersion) entry.complianceSuiteVersion = cached.suiteVersion;
      }
      return entry;
    });
    print(JSON.stringify({ path: loaded.path, servers: jsonServers, warnings: loaded.warnings }, null, 2));
    // Same code the text path returns below. The document is still emitted --
    // `warnings` is where a --json consumer reads what is wrong -- but the two
    // surfaces must not disagree about whether this run succeeded.
    return { exitCode: unreadablePath === null ? 0 : 1, written: [] };
  }

  if (servers.length === 0) {
    // "Nothing configured" and "we could not read what you configured" are
    // different facts, and this printed the first for both. A directory (or a
    // malformed file) at bundles.json produced the fresh-install line -- "Add
    // one with `yaw-mcp add <slug>`" -- under a `warning:` most readers skim,
    // which reads as an all-clear over a config yaw-mcp cannot load AND hands
    // out advice that does not work (`add` refuses that same file).
    if (unreadablePath !== null) {
      print(`Could not read ${displaySafe(unreadablePath)} -- yaw-mcp has nothing to load from it.`);
      print("The `warning:` line above says what is wrong; `yaw-mcp doctor` prints the same detail.");
      return { exitCode: 1, written: [] };
    }
    print("No local servers configured. Add one with `yaw-mcp add <slug>`");
    print("(browse the catalog at https://yaw.sh/mcp/catalog/).");
    return { exitCode: 0, written: [] };
  }

  const rows = [...graded].sort((a, b) => a.namespace.localeCompare(b.namespace));
  // NAME and LAUNCH come STRAIGHT out of bundles.json, which is a file a repo
  // can ship (project-local) or a badge can write -- so they get the same
  // control-byte neutering the removal preview and the trust gate already
  // apply. Without it, an entry whose name carries ANSI or a bidi override
  // repainted this table in the user's terminal, and a `sh -c "a | b"` arg
  // joined by a bare space read as separate tokens. NAMESPACE is skipped on
  // purpose: NAMESPACE_RE (local-bundles.ts) already restricts it to
  // [a-z0-9_]. GRADE is NOT exempt: it reads as a validated A-F letter, but
  // validateEntry (local-bundles.ts) accepts any non-blank string from
  // bundles.json and only trims and uppercases it -- neither of which touches
  // an ESC byte -- deliberately, so compliance.ts can report an unrecognized
  // grade instead of silently treating it as ungraded. bundles.json is a file
  // a repo can ship, so that cell carries the same untrusted-string risk as
  // NAME.
  const cols: Array<[string, (s: UpstreamServerConfig) => string]> = [
    ["NAMESPACE", (s) => s.namespace],
    ["NAME", (s) => displaySafe(s.name)],
    // The pin rides in the STATUS cell rather than taking a column of its own:
    // it modifies "will this server be loaded and STAY loaded", which is the
    // question this column already answers, and a dedicated column would be
    // blank for nearly every row. "disabled, pinned" is a real combination (a
    // pin on a server the user later disabled) and showing both is what makes
    // it findable -- the pin does nothing at all until the server is enabled.
    ["STATUS", (s) => (s.isActive ? "active" : "disabled") + (s.pinned ? ", pinned" : "")],
    // "-" for never-audited, matching the GRADE column this ported from.
    // LAUNCH stays last: it's the only variable-width cell, so anything after
    // it would be ragged.
    ["GRADE", (s) => (s.complianceGrade ? displaySafe(s.complianceGrade) : "-")],
    [
      "LAUNCH",
      (s) =>
        [s.command, ...(s.args ?? [])]
          .filter((t): t is string => typeof t === "string" && t.length > 0)
          .map((t) => displayArg(t))
          .join(" ") || (s.url ? displaySafe(s.url) : ""),
    ],
  ];
  const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  print(fmt(cols.map(([h]) => h)));
  for (const r of rows) print(fmt(cols.map(([, get]) => get(r))));
  if (loaded.path) print(`\n${servers.length} server${servers.length === 1 ? "" : "s"} in ${loaded.path}`);
  return { exitCode: 0, written: [] };
}
