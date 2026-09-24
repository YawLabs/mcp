// `yaw-mcp secrets <action>` -- manage the encrypted secret vault at
// ~/.yaw-mcp/secrets.json.
//
// Actions: set / get / list / remove / lock / rotate / reset / audit. The
// vault is local-only; spawn-time substitution of ${secret:NAME} references
// in bundles.json env values lives in upstream.ts.
//
// Passphrase resolution (highest precedence first -- resolvePassphrase):
//   0. opts.passphrase, the embedder/test hook (the CLI parser never sets it)
//   1. YAW_MCP_VAULT_PASSPHRASE env var
//   2. Interactive prompt on the controlling TTY (both ends a TTY; raw mode
//      turns echo off, and a terminal that refuses raw mode is refused)
//   3. Error -- no passphrase available
//
// Destructive paths are gated the way install-cmd gates an existing-entry
// collision -- confirm on a TTY, and off a TTY either refuse naming the
// flag to re-run with (remove) or proceed with a message that says what
// really happened (set over an existing name). See the block in runSecrets
// for why the two differ. --force skips only the confirmation, never the
// passphrase.

import { createHash } from "node:crypto";
import { chmod, copyFile, constants as fsConstants, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { createStreamWriter } from "./logger.js";
import { type AuditEvent, readAuditLog } from "./secrets-audit.js";
import {
  checkVaultPassphrase,
  createEmptyVault,
  getSecret,
  listKeys,
  loadVault,
  lock,
  newVault,
  removeSecret,
  rotateVault,
  SECRET_NAME_RE,
  SECRETS_SCHEMA_VERSION,
  saveVault,
  setSecret,
  unlock,
  VAULT_CHECK_CORRUPT_ERROR,
  VAULT_WRONG_PASSPHRASE_ERROR,
  VaultEntryCorruptError,
  type VaultFile,
  type VaultLoadWarning,
  type VaultPassphraseVerdict,
  vaultCheckCorruptHint,
  vaultPath,
  vaultVerifiesPassphrases,
} from "./secrets-vault.js";

export const SECRETS_USAGE = `Usage: yaw-mcp secrets <action> [args]

  Manage your encrypted secret vault at ~/.yaw-mcp/secrets.json.

Actions:
  set <name>              Store a secret. At a terminal, prompts for the
                          value (one line, no echo; a bare Enter asks
                          again). A piped stdin is read whole instead,
                          minus one trailing newline. Or pass --value <v>.
                          Setting a name that already exists REPLACES it
                          (confirmed first on a TTY; scripted runs proceed
                          and say "Replaced" instead of "Stored").
  get <name>              Decrypt and print one secret value to stdout.
                          NOTE: this prints the secret in CLEARTEXT (with
                          or without --json). Redirect to a file or pipe
                          to a consumer; avoid running it interactively so
                          the value does not land in terminal scrollback.
  list                    Show vault entry names (values stay encrypted).
  remove <name>           Delete an entry. Unrecoverable, so it asks you
                          to confirm on a TTY (bare Enter = no) and refuses
                          without --force when there is no TTY to ask on.
  lock                    Effectively a NO-OP from the CLI. Forgets the
                          passphrase cached in THIS process's memory, and
                          every CLI run is its own short-lived process with
                          its own cache, so there is nothing left to forget
                          by the time it runs. It CANNOT reach a yaw-mcp
                          server that is already running (that one keeps its
                          own cached key until it exits), does NOT change the
                          vault on disk (which only ever holds ciphertext),
                          and does NOT revoke anything. To cut off a running
                          server, stop the server.
  rotate                  Re-encrypt every entry under a NEW passphrase
                          (fresh salt + derived key). Re-wraps the
                          ENCRYPTION, NOT the underlying token values -- a
                          leaked token is still leaked; rotate it at its
                          source. Reads the current passphrase, then the
                          new one (env YAW_MCP_VAULT_PASSPHRASE_NEW or a
                          confirm-twice TTY prompt). Also the only upgrade
                          path for a vault file written under an older
                          schema: the rewritten file carries the current
                          version and every ciphertext is bound to its
                          entry name. (Every other command leaves the
                          file's schema as it found it, and says so on
                          stderr when it is behind.)
  reset                   Start the vault over when its passphrase is
                          forgotten. Moves the existing file aside as
                          secrets.json.reset-<timestamp>, next to it (it
                          still opens under the old passphrase, should that
                          turn up), prints the entry names it held (plaintext
                          keys, so no passphrase is needed) so you know what
                          to set again, and creates an empty vault under a
                          NEW passphrase -- confirmed twice on a TTY, or
                          YAW_MCP_VAULT_PASSPHRASE when it is set. Asks you
                          to type RESET first, and refuses without --force
                          when there is no TTY to ask on. Refuses when the
                          passphrase it is given already opens the vault:
                          that is \`rotate\`, not a reset.
  audit [--secret NAME] [--server NS]
                          Show the local secret-resolution audit trail
                          (~/.yaw-mcp/secrets-audit.log): which secret
                          NAMES were injected into (or missing for) which
                          server, and when. Never shows a value. A missing
                          row whose name starts with \`<malformed ref>\` is a
                          \${secret: reference that did not parse (a space
                          in the name, a dropped brace): fix the typo in
                          bundles.json. --secret matches that full marker
                          string, not the bare name.

Flags:
  --json                  Machine-readable output. stdout carries the result
                          envelope, one JSON line; stderr carries one JSON
                          object per line: {"warning":...} lines (a
                          schema-behind file, a malformed check marker, a
                          short passphrase, a vault just created or reset,
                          a value printed in cleartext to a terminal) and,
                          on failure, the {"ok":false,"error":...} envelope
                          last -- an argument error too (exit 2, no usage
                          text). Key on "warning" vs "ok", never on line
                          position.
  --value <v>             Inline secret value (set only). The value sits in
                          this process's argv, so it is visible to every
                          other local user via ps / /proc/<pid>/cmdline for
                          the whole run (which includes the ~100ms key
                          derivation), and it lands in your shell history.
                          For scripting pipe the value in on stdin;
                          interactively use the default no-echo prompt.
  --stdin                 Read the value from stdin even when stdin is a
                          terminal (set only): raw, multi-line, until EOF,
                          and the terminal echoes it. A piped stdin is read
                          that way without the flag. Either way the value
                          never appears in argv.
  --force                 Skip the destructive-action confirmation
                          (remove, reset, and a set that overwrites an
                          existing name). Required for remove and reset
                          when stdin or stdout is not a TTY (both ends are
                          needed to ask). NEVER skips the passphrase.
  --secret <name>         (audit only) Filter to one secret name.
  --server <ns>           (audit only) Filter to one server namespace.

Passphrase:
  Set YAW_MCP_VAULT_PASSPHRASE in the env, or you will be prompted on
  the controlling TTY. The passphrase derives the encryption key via
  scrypt and is cached in memory for the lifetime of this yaw-mcp
  process; the on-disk vault only ever holds ciphertext. For rotate, the
  NEW passphrase comes from YAW_MCP_VAULT_PASSPHRASE_NEW (or a TTY
  confirm-twice prompt).

Forgot the passphrase?
  There is no recovery: the file holds only ciphertext under a key derived
  from the passphrase, and nothing else -- no server, no recovery key -- can
  open it. \`yaw-mcp secrets reset\` is the way back to a working vault: it
  moves the old file aside (kept, in case the passphrase turns up), lists
  the entry names you have to set again, and starts an empty vault under a
  new passphrase.`;

/** The eight actions, spelled once: the parser accepts exactly these and
 *  runSecrets refuses anything else before it reads the vault. */
const SECRETS_ACTIONS = ["set", "get", "list", "remove", "lock", "rotate", "reset", "audit"] as const;
type SecretsAction = (typeof SECRETS_ACTIONS)[number];

function isSecretsAction(a: unknown): a is SecretsAction {
  return typeof a === "string" && (SECRETS_ACTIONS as readonly string[]).includes(a);
}

export interface SecretsCommandOptions {
  action?: SecretsAction;
  name?: string;
  value?: string;
  fromStdin?: boolean;
  json?: boolean;
  /** Skip the destructive-action confirmation (remove, reset, and a set
   *  that overwrites an existing name). Never skips the passphrase. */
  force?: boolean;
  /** For `audit`: filter to one secret name. */
  secretFilter?: string;
  /** For `audit`: filter to one server namespace. */
  serverFilter?: string;
  /** Test hooks. */
  home?: string;
  /** The passphrase (for `reset`: the NEW vault's). It takes the env var's
   *  place in the precedence -- ahead of it, and for `reset` checked against
   *  the old vault the same way -- but it is not reported as the env var:
   *  reset's `passphrase_source` reads "prompt" and its success line says
   *  "the new passphrase", since only YAW_MCP_VAULT_PASSPHRASE itself is
   *  reported as "env". */
  passphrase?: string;
  /** For `rotate`: the NEW passphrase (overrides env + TTY prompt in tests). */
  newPassphrase?: string;
  /** The streams the INTERACTIVE PROMPTS use: the raw-mode reader takes its
   *  bytes from `stdin` and writes its prompt text to `stdout`. Nothing else
   *  goes through here. Every warning and error takes runSecrets's `io.err`
   *  callback instead -- there used to be a `stderr` stream in this object
   *  that the short-passphrase and cleartext warnings wrote to, which meant
   *  an embedder supplying only the callbacks got those two lines on
   *  process.stderr and everything else through `err`. One sink now. */
  io?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
  };
}

/** The ONE output sink for everything that is not a prompt: results on
 *  `out`, and every error envelope, warning and nudge on `err`. Declared
 *  once and threaded through every helper, so an embedder that supplies
 *  the pair captures the whole command -- no helper reaches for
 *  process.stderr (or a stream in `opts.io`) on its own. */
export interface SecretsIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export function parseSecretsArgs(
  argv: string[],
): { ok: true; options: SecretsCommandOptions } | { ok: false; error: string; help?: boolean } {
  // An argv error under --json is the same one-line {"ok":false,"error":...}
  // envelope every runtime failure emits (the promise SECRETS_USAGE makes for
  // stderr), not the prose-plus-usage dump: index.ts's shared run() writes
  // `error` to stderr verbatim with exit 2, so the JSON is spelled here. The
  // flag is looked for anywhere in argv, not just before the bad token:
  // `secrets get --bogus --json` asked for JSON as surely as
  // `--json get --bogus` did. That matches what the loop below would find --
  // no flag takes a dash-leading value, so a "--json" token is always the
  // flag. --help still prints the usage: asking for it is asking for prose.
  const json = argv.includes("--json");
  const opts: SecretsCommandOptions = {};
  // The prose label is read from opts.action when refuse() runs, so every
  // refusal made once the action is parsed reads `yaw-mcp secrets <action>:`
  // -- the label runSecrets's own refusals carry (failResult) -- and only the
  // ones made before it (an unknown or missing action, a bad flag ahead of
  // the action) read `yaw-mcp secrets:`. `secrets set X --bogus` used to say
  // `yaw-mcp secrets:` while `secrets set X --value ""` said
  // `yaw-mcp secrets set:`.
  const refuse = (msg: string): { ok: false; error: string } => ({
    ok: false,
    error: json
      ? JSON.stringify({ ok: false, error: msg })
      : `yaw-mcp secrets${opts.action ? ` ${opts.action}` : ""}: ${msg}\n\n${SECRETS_USAGE}`,
  });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: false, error: SECRETS_USAGE, help: true };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (a === "--stdin") {
      opts.fromStdin = true;
      continue;
    }
    if (a === "--force") {
      opts.force = true;
      continue;
    }
    if (a === "--value") {
      const v = argv[++i];
      // Reject a following flag (e.g. `secrets set NAME --value --json`)
      // instead of storing "--json" as the secret. For a value that really
      // begins with a dash, use `--stdin` (which reads the raw value).
      if (v === undefined || v.startsWith("-")) {
        return refuse("--value requires a value (for a dash-leading value use --stdin)");
      }
      opts.value = v;
      continue;
    }
    if (a === "--secret" || a === "--server") {
      const v = argv[++i];
      // Same rule as --value: a following flag is a MISSING value, not a
      // filter literally named "--json" -- `audit --secret --json` used to
      // store "--json" as the secret filter and print an empty trail. A
      // dash-leading value is never a real filter here: a namespace cannot
      // start with one, and the CLI cannot even `set` a dash-leading name
      // (the positional would parse as an unknown flag).
      if (v === undefined || v.startsWith("-")) {
        return refuse(`${a} requires a value`);
      }
      if (a === "--secret") opts.secretFilter = v;
      else opts.serverFilter = v;
      continue;
    }
    if (a.startsWith("-")) {
      return refuse(`unknown flag "${a}"`);
    }
    if (!opts.action) {
      if (!isSecretsAction(a)) return refuse(`unknown action "${a}"`);
      opts.action = a;
      continue;
    }
    if (!opts.name) {
      opts.name = a;
      continue;
    }
    return refuse(`unexpected positional argument "${a}"`);
  }
  if (!opts.action) return refuse("missing action");
  // Reject a positional for the actions that take no <name>. Swallowing it
  // was SILENT and actively misleading: `secrets audit GH_TOKEN` parsed,
  // dropped the name, and printed the ENTIRE trail -- so an operator asking
  // "where did GH_TOKEN go" read other secrets' events as if they were
  // GH_TOKEN's. The mistake is a natural one (set/get/remove all take
  // <name> positionally), so the audit message names the flag that really
  // filters.
  if (opts.name !== undefined && opts.action !== "set" && opts.action !== "get" && opts.action !== "remove") {
    const hint =
      opts.action === "audit"
        ? ` -- audit takes no <name>; filter with \`--secret ${opts.name}\` or \`--server ${opts.name}\``
        : ` -- ${opts.action} takes no <name>`;
    return refuse(`unexpected argument "${opts.name}"${hint}`);
  }
  // The usage text marks these flags "(set only)" / "(audit only)", but the
  // parser used to accept and then silently drop them on every other action:
  // `secrets get NAME --stdin` and `secrets list --secret GH` both looked
  // like they did something. Refuse instead of ignoring.
  if (opts.action !== "set" && (opts.value !== undefined || opts.fromStdin)) {
    const flag = opts.value !== undefined ? "--value" : "--stdin";
    return refuse(`${flag} applies to \`set\` only`);
  }
  // An empty --value is refused HERE for the same reason the name check
  // below is: runSecrets's own "cannot be empty" check sits after the
  // passphrase prompt and the scrypt derivation, so `--value ""` cost the
  // user a passphrase entry before hearing the value was never acceptable.
  // runSecrets keeps its check as the backstop for programmatic callers.
  if (opts.value !== undefined && opts.value.length === 0) {
    return refuse("Secret value cannot be empty.");
  }
  if (opts.action !== "audit" && (opts.secretFilter !== undefined || opts.serverFilter !== undefined)) {
    const flag = opts.secretFilter !== undefined ? "--secret" : "--server";
    return refuse(`${flag} applies to \`audit\` only`);
  }
  if ((opts.action === "set" || opts.action === "get" || opts.action === "remove") && !opts.name) {
    return refuse("<name> is required");
  }
  // Reject a name no ${secret:NAME} reference could ever address BEFORE any
  // prompt or key derivation. setSecret enforces the same rule, but only
  // after resolvePassphrase, the ~100ms scrypt derivation and the no-echo
  // value prompt -- so `yaw-mcp secrets set "my token"` used to make the
  // user type two secrets before hearing the name was never valid. The
  // regex is IMPORTED from secrets-vault.js, never re-spelled here: a
  // duplicated copy of this pattern was itself a finding in this repo.
  // Only `set` is checked. get/remove already short-circuit to `No secret
  // named "..."` without a prompt, and a vault written before the rule
  // existed must stay readable/removable by its legacy name.
  if (opts.action === "set" && opts.name !== undefined && !SECRET_NAME_RE.test(opts.name)) {
    return refuse(
      `invalid secret name "${opts.name}" -- use letters, digits, "_", "." or "-" only; other characters can never be referenced as \${secret:NAME}`,
    );
  }
  return { ok: true, options: opts };
}

export interface SecretsCommandResult {
  exitCode: number;
}

/** Every refusal runSecrets and its helpers print, rendered one way: under
 *  --json a one-line `{"ok":false,"error":...}` envelope on `err`, otherwise
 *  `yaw-mcp secrets <action>: <msg>` -- the action label always, so the same
 *  message never carries two prefixes depending on which copy caught it (the
 *  set block used to spell one refusal `secrets:` and its neighbours
 *  `secrets set:`). `action` is empty only for a call with no valid action.
 *  The argument refusals are parseSecretsArgs' own (index.ts prints them,
 *  with the usage text after the prose line) and follow the same label rule:
 *  `yaw-mcp secrets <action>:` once the action is parsed, `yaw-mcp secrets:`
 *  for one refused before it.
 *
 *  `detail` is a second prose line, indented under the first. Under --json it
 *  is appended to `error`, or with `detailAsHint` carried as its own `hint`
 *  field (get's decrypt failure keeps the raw crypto error apart from the
 *  fix). `fields` adds discriminators to the envelope (`cancelled`,
 *  `aborted`). Returns the result the caller hands back. */
function failResult(
  io: SecretsIo,
  json: boolean | undefined,
  action: string,
  msg: string,
  opts: { exitCode?: number; detail?: string; detailAsHint?: boolean; fields?: Record<string, unknown> } = {},
): SecretsCommandResult {
  const { exitCode = 1, detail, detailAsHint = false, fields } = opts;
  if (json) {
    const error = detail !== undefined && !detailAsHint ? `${msg} ${detail}` : msg;
    const hint = detail !== undefined && detailAsHint ? { hint: detail } : {};
    io.err(`${JSON.stringify({ ok: false, error, ...hint, ...fields })}\n`);
  } else {
    io.err(`yaw-mcp secrets${action ? ` ${action}` : ""}: ${msg}\n${detail !== undefined ? `  ${detail}\n` : ""}`);
  }
  return { exitCode };
}

/** One `err` line for a non-fatal condition loadVault met on a vault it still
 *  returned (today: a malformed check marker, which it ignores). Every
 *  loadVault call in this file passes this as `onWarning`, which also stops
 *  loadVault logging on its own: its log() lines go to process.stderr, past
 *  the `io` sink, and on the CLI surface they are prose -- a malformed marker
 *  made list/get/set/remove/rotate SUCCEED under --json with a non-JSON line
 *  on stderr, and a vault that is not JSON (or cannot be read) put one ahead
 *  of the `{"ok":false}` envelope. Under --json the warning is its own JSON
 *  line with `warning` as the discriminator, like schemaBehindNotice's. */
function vaultLoadWarningNotice(io: SecretsIo, warning: VaultLoadWarning, json: boolean | undefined): void {
  if (json) {
    io.err(`${JSON.stringify({ warning: warning.kind, path: warning.path, message: warning.message })}\n`);
    return;
  }
  io.err(`yaw-mcp secrets: warning -- ${warning.path}: ${warning.message}.\n`);
}

/** The sentence for a vault file that exists but cannot be read: its path,
 *  and the errno (the error's message when it carries none). Both refusals
 *  for that state use it -- safeLoadVault's when loadVault's own read fails,
 *  vaultUnreadableResult's when the baseline fingerprint's read does -- so
 *  every action that refuses over it names the same file and cause. The
 *  path has to be added here: Node's message for a read-phase errno
 *  (EISDIR, EIO) names none, and loadVault rethrows that error as it got
 *  it. */
function vaultUnreadableMessage(path: string, error: NodeJS.ErrnoException): string {
  return `could not read the vault file at ${path} (${error.code ?? error.message}) -- fix that and re-run.`;
}

/** Wrap loadVault so a corrupt or unreadable on-disk vault surfaces a
 *  named, actionable message to the user rather than crashing the
 *  process. ENOENT still resolves to null (vault absent) -- only real
 *  errors throw out of loadVault. We catch them here and translate to
 *  a structured result the caller can return as exitCode:1: a corrupt
 *  entry gets its fix-by-hand hint, a failed read (an errno) gets
 *  vaultUnreadableMessage, and every other error -- each one loadVault
 *  builds with the path in it -- passes through as its message. loadVault's
 *  warnings come back through vaultLoadWarningNotice. */
async function safeLoadVault(
  path: string,
  io: SecretsIo,
  json: boolean | undefined,
  action: string,
): Promise<{ ok: true; vault: VaultFile | null } | { ok: false; result: SecretsCommandResult }> {
  try {
    return { ok: true, vault: await loadVault(path, { onWarning: (w) => vaultLoadWarningNotice(io, w, json) }) };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Branch on the ERROR TYPE, not on the message text. The old
    // /vault corrupt at entry (.+)$/ sniff is the discipline
    // unlockErrorMessage was fixed to avoid, and it failed for exactly the
    // input it most needed to handle: a legacy entry name containing a
    // newline defeats `.+$` (which cannot cross one), so the actionable hint
    // silently degraded to the raw message. NOTE: loadVault validates EVERY
    // entry, so `secrets remove <name>` cannot clear it either -- the fix has
    // to happen in the file itself.
    const name = err instanceof VaultEntryCorruptError ? err.entryName : undefined;
    // Same rule for a failed read: an errno `code` marks the error readFile
    // threw (the ones loadVault builds itself carry none). Passed through
    // bare, `list` and `get` on a vault that is a directory printed
    // "EISDIR: illegal operation on a directory, read", naming no file,
    // while set/remove/rotate/reset named it for the same state.
    const readError =
      err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string"
        ? (err as NodeJS.ErrnoException)
        : undefined;
    const msg = name
      ? `secret entry ${name} is corrupt, and every secrets command fails until it is gone. Delete the "${name}" key from ${path} by hand (or run \`yaw-mcp secrets reset\` to start the vault over -- it keeps the old file), then re-add it with \`yaw-mcp secrets set ${name}\`.`
      : readError
        ? vaultUnreadableMessage(path, readError)
        : raw;
    return { ok: false, result: failResult(io, json, action, msg) };
  }
}

/** "The vault file exists but could not be read", for the fingerprint
 *  guard below. A branded object (never a hex digest, never the null that
 *  means "file absent") carrying the read error so the refusal can name
 *  the real errno, as safeLoadVault does for get/list. An unreadable file at
 *  either end of the comparison must read as CHANGED (refuse to save),
 *  never as a match. */
interface VaultUnreadable {
  readonly unreadable: true;
  readonly error: NodeJS.ErrnoException;
}
type VaultFingerprint = string | null | VaultUnreadable;

function isVaultUnreadable(fp: VaultFingerprint): fp is VaultUnreadable {
  return typeof fp === "object" && fp !== null && fp.unreadable === true;
}

/** sha256 of the vault file's current bytes; null when the file does not
 *  exist. Same role as trust-cmd's re-read-before-grant hash. */
async function vaultFingerprint(path: string): Promise<VaultFingerprint> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === "ENOENT" ? null : { unreadable: true, error: e };
  }
}

/** True when the vault on disk no longer matches the bytes the command
 *  loaded. Every mutating secrets action blocks on unbounded interactive
 *  pauses (confirmations, passphrase and value prompts) between its load
 *  and its save; without this check, a concurrent `secrets set` in
 *  another terminal -- or a `rotate` the user was just told succeeded --
 *  was silently reverted by the stale in-memory snapshot. Mirrors
 *  trust-cmd's "a prompt is an unbounded pause" re-read-and-refuse.
 *
 *  This is a re-check, NOT a lock: the window between it and the rename in
 *  saveVault stays open, so two scripted non-interactive writes started in
 *  the same instant can both pass it and the second rename wins. That is
 *  the accepted shape today -- the guard exists for the interactive pauses,
 *  which are seconds to minutes wide. If scripted parallel writes ever
 *  become a use case, the fix is an advisory lock file around the whole
 *  read-modify-write, not a tighter re-check. */
async function vaultChangedSinceLoad(path: string, baseline: VaultFingerprint): Promise<boolean> {
  const now = await vaultFingerprint(path);
  if (isVaultUnreadable(now) || isVaultUnreadable(baseline)) return true;
  return now !== baseline;
}

/** Refusal for a vault file that exists but could not be read for the
 *  baseline fingerprint. Emitted BEFORE any prompt: the pre-save re-check
 *  treats an unreadable baseline as "changed", so continuing would only
 *  collect the user's input and then refuse with the wrong reason. Its
 *  sentence is vaultUnreadableMessage's, the one get/list print through
 *  safeLoadVault for the identical on-disk state; the "Nothing was written."
 *  after it is this refusal's own, since only the actions that write reach
 *  it (set, remove, rotate, reset). */
function vaultUnreadableResult(
  io: SecretsIo,
  json: boolean | undefined,
  action: string,
  path: string,
  fp: VaultUnreadable,
): SecretsCommandResult {
  return failResult(io, json, action, `${vaultUnreadableMessage(path, fp.error)} Nothing was written.`);
}

/** Persist the vault. Returns null on success, or the CAUSE of the failure
 *  -- the errno when there is one, the message otherwise -- for the caller
 *  to word its own envelope around.
 *
 *  saveVault can reject for reasons that have nothing to do with the vault's
 *  contents -- EACCES on the config dir, ENOSPC, EXDEV on the atomic rename
 *  across a mount boundary. Awaited bare, that rejection unwound all the way
 *  to the CLI entry point, which prints prose (`yaw-mcp secrets: <msg>`) --
 *  so a `--json` caller that had received clean JSON envelopes for every
 *  other failure got a bare prose line on stderr for this one and its parse
 *  broke. saveVaultOrReport below is the sentence every action but `reset`
 *  wants; reset's disk state on a failed write is not "nothing was saved"
 *  (a copy of the old vault has already been taken), so it builds its own
 *  from the cause. */
async function trySaveVault(path: string, vault: VaultFile): Promise<string | null> {
  try {
    await saveVault(path, vault);
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code ?? (err instanceof Error ? err.message : String(err));
  }
}

/** trySaveVault, with the failure rendered as this command's normal error
 *  envelope. Returns null on success, or the result the caller must return. */
async function saveVaultOrReport(
  path: string,
  vault: VaultFile,
  io: SecretsIo,
  json: boolean | undefined,
  action: string,
): Promise<SecretsCommandResult | null> {
  const cause = await trySaveVault(path, vault);
  if (cause === null) return null;
  return failResult(io, json, action, `could not write the vault file at ${path} (${cause}) -- nothing was saved.`);
}

/** Standard refusal for a vault that changed under a prompt. */
function vaultChangedResult(io: SecretsIo, json: boolean | undefined, action: string): SecretsCommandResult {
  return failResult(
    io,
    json,
    action,
    "the vault changed on disk while this command was waiting for input -- nothing was written. Re-run to work from the current vault.",
  );
}

/** Render an unlock() failure for the user.
 *
 *  unlock() reports the corrupt-verification-token case distinctly from a
 *  wrong passphrase, but it cannot name the file the vault came from, so
 *  the actionable fix hint is attached here. Compared against the exported
 *  constants rather than sniffed out of the message text -- the same
 *  discipline safeLoadVault's corrupt-entry hint should have had. The
 *  wrong-passphrase case gets the one pointer this command can offer: a
 *  passphrase that is FORGOTTEN, not mistyped, has no way back in, and until
 *  `reset` existed nothing anywhere said so -- `set` reported the wrong
 *  passphrase and exited 1, with no pointer. Every other unlock error passes
 *  through verbatim. */
function unlockErrorMessage(err: unknown, path: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === VAULT_CHECK_CORRUPT_ERROR) {
    return `${msg}. ${vaultCheckCorruptHint(path)}`;
  }
  if (msg === VAULT_WRONG_PASSPHRASE_ERROR) {
    return `${msg}. If it is forgotten, \`yaw-mcp secrets reset\` moves this vault aside and starts a new one (the old file is kept).`;
  }
  return msg;
}

/** Returned by the passphrase readers when the user hits ^C at a prompt.
 *  Distinct from "" (empty submission -> re-prompt) and from null (no
 *  passphrase obtainable). The reader NEVER calls process.exit(): the io
 *  streams are injectable, so a test or an embedder must not be able to
 *  kill the host process by feeding it a 0x03 byte. runSecrets turns this
 *  into exitCode 130 (128 + SIGINT) and the CLI entry point owns the exit. */
const CANCELLED: unique symbol = Symbol("yaw-mcp:passphrase-cancelled");
type Cancelled = typeof CANCELLED;

/** Standard result for a ^C at any prompt (passphrase, value, or
 *  confirmation). */
function cancelledResult(io: SecretsIo, json: boolean | undefined, action: string): SecretsCommandResult {
  return failResult(io, json, action, "Cancelled.", { exitCode: 130, fields: { cancelled: true } });
}

/** Standard result for a confirmation the user declined (or let default
 *  to no). Exit 1, matching install-cmd's "Aborted." abort path -- the
 *  command did not do what was asked, so it must not report success. */
function abortedResult(io: SecretsIo, json: boolean | undefined, action: string): SecretsCommandResult {
  return failResult(io, json, action, "Aborted.", { fields: { aborted: true } });
}

/** Which ends are a TTY. Reads the INJECTED streams (never process.stdin
 *  directly) so tests drive it the same way they drive the passphrase
 *  prompts. Split out from isInteractiveTTY because the refusal message
 *  has to name the end that ACTUALLY failed. */
function ttyEnds(opts: SecretsCommandOptions): { stdin: boolean; stdout: boolean } {
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  return {
    stdin: (stdin as { isTTY?: boolean }).isTTY === true,
    stdout: (stdout as { isTTY?: boolean }).isTTY === true,
  };
}

/** Can we prompt? Both ends must be a TTY: stdin to read the answer,
 *  stdout to show the question. */
function isInteractiveTTY(opts: SecretsCommandOptions): boolean {
  const ends = ttyEnds(opts);
  return ends.stdin && ends.stdout;
}

/** Name the end(s) that are not a TTY, for the non-interactive refusal.
 *  Naming stdin unconditionally was wrong for the common
 *  `yaw-mcp secrets remove NAME --json | jq` shape: run from an interactive
 *  shell that has a perfectly good TTY stdin and only a piped STDOUT, so the
 *  message sent the user to inspect the wrong half of their pipeline. */
function nonTTYEnds(opts: SecretsCommandOptions): string {
  const ends = ttyEnds(opts);
  if (!ends.stdin && !ends.stdout) return "neither stdin nor stdout is a TTY";
  return ends.stdin ? "stdout is not a TTY" : "stdin is not a TTY";
}

/** The "cannot obtain a passphrase" refusal. The default wording sends the
 *  user to "a TTY" -- which is actively WRONG on Git Bash / MSYS, where the
 *  user IS sitting at a terminal but MSYS emulates it with named pipes, so
 *  Node reports isTTY false and the prompt can never fire. When the env says
 *  MSYS and prompting really was impossible (a std end is not a TTY, as
 *  opposed to a TTY user exhausting the re-prompt budget), name the real
 *  cause and the remedies instead of telling the user their terminal does
 *  not exist. MSYSTEM is set by every Git Bash flavour (MINGW64 / MINGW32 /
 *  UCRT64 / MSYS). */
function promptUnavailableMessage(opts: SecretsCommandOptions, required: string, envVar: string): string {
  if (!isInteractiveTTY(opts) && (process.env.MSYSTEM ?? "") !== "") {
    return `${required} Node cannot prompt under Git Bash/MSYS -- the terminal is emulated with pipes, not a TTY. Set ${envVar}, run under winpty (winpty yaw-mcp ...), or use PowerShell/cmd.`;
  }
  return `${required} Set ${envVar} or run from a TTY so we can prompt.`;
}

/** Ask a destructive-action question on the TTY. Defaults to NO: only an
 *  explicit y/yes proceeds, so a bare Enter (or ^D, or anything else)
 *  leaves the vault alone. Echoes what is typed -- a confirmation is not
 *  a secret -- but otherwise shares the passphrase reader, so ^C still
 *  cancels the whole command instead of counting as "no". */
async function promptYesNo(opts: SecretsCommandOptions, question: string): Promise<boolean | Cancelled> {
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  const answer = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, `${question} [y/N] `, true);
  if (answer === CANCELLED) return CANCELLED;
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

/** Warn (never block) when an ACCEPTED passphrase is under the soft floor.
 *
 *  Applies to every path a passphrase can arrive on, not just the env var.
 *  Warning only on the env path was backwards: the interactive prompt is
 *  the one place a human actually CHOOSES a passphrase, so `secrets set` on
 *  a fresh vault could create it under "abc" with no feedback while the
 *  equivalent YAW_MCP_VAULT_PASSPHRASE=abc run warned. Against the exfil
 *  threat model the vault is built for (offline attack on the stolen file),
 *  a 3-character passphrase is trivially brute-forced regardless of which
 *  path it came in on.
 *
 *  Always the `err` channel (stderr by default), never `out`: stdout
 *  carries `get`'s cleartext value and the --json envelopes, and a warning
 *  must never pollute either. The same `io.err` every error envelope takes,
 *  not a separate stream -- this used to write to `opts.io.stderr`, so an
 *  embedder supplying only the callbacks got this one line on
 *  process.stderr and everything else through `err`.
 *
 *  Under --json it is one JSON LINE, for the reason schemaBehindNotice gives:
 *  every failure envelope goes to `err` too, and this warning fires at the
 *  passphrase step -- BEFORE a `{"ok":false}` from the changed-on-disk
 *  re-check or a failed write -- so a prose line here made that stderr
 *  unparseable to a --json wrapper. `warning` is its discriminator. */
function warnIfShortPassphrase(
  io: SecretsIo,
  json: boolean | undefined,
  passphrase: string,
  subject: string,
  hint?: string,
): void {
  if (passphrase.length >= MIN_PASSPHRASE_WARN_LEN) return;
  if (json) {
    io.err(
      `${JSON.stringify({
        warning: "short-passphrase",
        subject,
        min_length: MIN_PASSPHRASE_WARN_LEN,
        ...(hint ? { hint } : {}),
      })}\n`,
    );
    return;
  }
  io.err(
    `yaw-mcp secrets: warning -- ${subject} is shorter than ${MIN_PASSPHRASE_WARN_LEN} characters; consider a longer passphrase.${
      hint ? ` ${hint}` : ""
    }\n`,
  );
}

/** One-time guidance printed when `set` CREATES the vault.
 *
 *  The gap this closes: STORING a secret and USING one happen in two
 *  different processes. `secrets set` runs in the user's own shell, where
 *  the passphrase was just supplied. The "${secret:NAME}" substitution runs
 *  inside the yaw-mcp that the MCP CLIENT spawns (upstream.ts's
 *  resolveServerEnv), which has its own environment and cannot prompt for
 *  anything. Set the passphrase only in the shell you typed this command
 *  in and you get a vault that works perfectly from the CLI and a server
 *  that refuses to start, with nothing on either surface connecting the
 *  two. No SUCCESS path in the CLI mentioned the env var at all before
 *  this -- it was discoverable by reading the README, or by hitting the
 *  failure and reading the error.
 *
 *  Fires on vault CREATION only: once per vault, at the one moment the
 *  user has just proven they intend to use secrets, and never again on the
 *  second or the hundredth `set`. doctor carries the standing check from
 *  there on, including for vaults created before this nudge existed.
 *
 *  Always stderr, even under --json: stdout carries the JSON envelope and
 *  `get`'s cleartext, and neither may be polluted. Same rule as
 *  warnIfShortPassphrase -- and, like it, one JSON line under --json rather
 *  than prose, so the stderr a wrapper parses stays JSON throughout. Reports
 *  only WHETHER the env var is set, never its value -- CLI output gets
 *  pasted into bug reports. */
function freshVaultNudge(io: SecretsIo, path: string, json: boolean | undefined): void {
  const envSet = (process.env.YAW_MCP_VAULT_PASSPHRASE ?? "").length > 0;
  if (json) {
    io.err(
      `${JSON.stringify({
        warning: "vault-created",
        path,
        env_set_here: envSet,
        hint: envSet
          ? "YAW_MCP_VAULT_PASSPHRASE is set in this shell; the yaw-mcp your MCP client launches has its own environment -- set it there too. `yaw-mcp doctor` reports whether it is set."
          : "set YAW_MCP_VAULT_PASSPHRASE in the environment your MCP client launches yaw-mcp from; without it a server referencing ${secret:...} asks in-session or fails to start. `yaw-mcp doctor` reports whether it is set.",
      })}\n`,
    );
    return;
  }
  // Plain quoted strings, not template literals: every line below carries a
  // literal "${secret:...}" that a template literal would try to interpolate.
  const lines = envSet
    ? [
        "  YAW_MCP_VAULT_PASSPHRASE is set in THIS shell, but ${secret:NAME} refs are resolved",
        "  by the yaw-mcp your MCP client launches, which has its own environment -- set it",
        "  there too, or that process starts locked. `yaw-mcp doctor` reports whether it is set.",
      ]
    : [
        "  yaw-mcp resolves ${secret:NAME} refs at server-spawn time and needs this passphrase",
        "  to do it. Set YAW_MCP_VAULT_PASSPHRASE in the environment your MCP client launches",
        "  yaw-mcp from. Without it, a server whose env references ${secret:...} asks for the",
        "  passphrase in-session (on clients that support elicitation) or fails to start.",
        "  `yaw-mcp doctor` reports whether it is set.",
      ];
  io.err(`yaw-mcp secrets: created the vault at ${path}.\n${lines.join("\n")}\n`);
}

/** One `err` line when a loaded vault is behind this build's schema.
 *
 *  The v2 name binding (secrets-vault.ts's AAD) only engages for a file
 *  that SAYS v2, and nothing but `rotate` ever rewrites the version:
 *  setSecret spreads the vault it was given, so a v1 file stays v1 through
 *  years of `set`s -- every entry position-independent (a blob swapped
 *  between PROD and DEV still decrypts) while the vault header and the
 *  CHANGELOG describe the binding as shipped. No surface told the user:
 *  not `list`, not `set`, not doctor. This is that surface -- once per
 *  command that loads such a vault, on `err` (never `out`, which carries
 *  `get`'s cleartext and the --json envelopes; same rule as
 *  warnIfShortPassphrase, and like it, it fires under --json too). rotate
 *  is the one command that does not call it: it IS the upgrade.
 *
 *  Under --json the notice is its own JSON LINE, not prose: every error
 *  envelope this command emits goes to `err` too, so a --json wrapper parses
 *  stderr line by line -- and a prose warning ahead of an `{"ok":false,...}`
 *  envelope made every failing list/get/set/remove on a pre-v2 vault
 *  unparseable to it. No `ok` key on this line: the warning is about the
 *  FILE, not the command, and `ok` is the discriminator the error envelopes
 *  carry -- a wrapper that read the first stderr line and keyed on `ok` took
 *  a failed command as fine when this line said `ok: true` ahead of the
 *  `{"ok":false}` envelope. `warning` is this line's discriminator. */
function schemaBehindNotice(io: SecretsIo, vault: VaultFile, path: string, json: boolean | undefined): void {
  if (vault.version >= SECRETS_SCHEMA_VERSION) return;
  if (json) {
    io.err(
      `${JSON.stringify({
        warning: "schema-behind",
        schema: vault.version,
        current: SECRETS_SCHEMA_VERSION,
        upgrade: "yaw-mcp secrets rotate",
        path,
      })}\n`,
    );
    return;
  }
  io.err(
    `yaw-mcp secrets: warning -- the vault at ${path} is schema v${vault.version} (this build writes v${SECRETS_SCHEMA_VERSION}); its ciphertexts are not bound to their entry names until \`yaw-mcp secrets rotate\` rewrites it. No other command upgrades the file.\n`,
  );
}

/** The two prompt labels and the warning subject of a confirm-twice
 *  passphrase entry. Two sets exist. CREATE_VAULT_LABELS is what a first
 *  `set` establishes the vault under. NEW_PASSPHRASE_LABELS is rotate's
 *  pair, and `reset` borrows it: a user whose defining state is NOT knowing
 *  the vault passphrase must not be shown the bare "Vault passphrase: "
 *  every unlock prompt opens with (under --force it would be the first line
 *  on screen), or the old passphrase typed from memory becomes the new
 *  vault's with nothing saying a NEW one was being chosen. */
interface PassphrasePromptLabels {
  first: string;
  confirm: string;
  /** How warnIfShortPassphrase names an accepted entry. */
  subject: string;
}
const CREATE_VAULT_LABELS: PassphrasePromptLabels = {
  first: "Vault passphrase: ",
  confirm: "Confirm passphrase: ",
  subject: "the passphrase you chose",
};
const NEW_PASSPHRASE_LABELS: PassphrasePromptLabels = {
  first: "New vault passphrase: ",
  confirm: "Confirm new passphrase: ",
  subject: "the new passphrase",
};

/** The confirm-twice TTY entry: the one loop behind vault creation
 *  (resolvePassphrase with `confirm`), rotate's new passphrase and reset's.
 *  Two entries must agree before anything is committed; an empty first entry
 *  (bare Enter or ^D) re-prompts; MAX_PASSPHRASE_PROMPTS attempts of either
 *  kind (empty or mismatched) give up (null), so a closed pipe or a held ^D
 *  never spins forever. The caller has already established that both ends
 *  are a TTY. These are the
 *  prompts where a human picks a vault's passphrase for good -- warn on a
 *  short one HERE or the weak choice is never mentioned. */
async function promptPassphraseTwice(
  opts: SecretsCommandOptions,
  io: SecretsIo,
  labels: PassphrasePromptLabels,
): Promise<string | null | Cancelled | NoEcho> {
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  for (let attempt = 0; attempt < MAX_PASSPHRASE_PROMPTS; attempt++) {
    const first = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, labels.first);
    if (first === CANCELLED || first === NO_ECHO) return first;
    if (first.length === 0) {
      stdout.write("Passphrase cannot be empty.\n");
      continue;
    }
    const second = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, labels.confirm);
    if (second === CANCELLED || second === NO_ECHO) return second;
    if (first === second) {
      warnIfShortPassphrase(io, opts.json, first, labels.subject);
      return first;
    }
    stdout.write("Passphrases did not match. Try again.\n");
  }
  return null;
}

/** Read the passphrase. Env var wins; falls back to a stdin prompt
 *  that disables terminal echo via raw mode. Returns null when no
 *  passphrase can be obtained (non-TTY + no env), CANCELLED when the
 *  user hit ^C at the prompt, or NO_ECHO when the terminal would not turn
 *  echo off (nothing was read). With `confirm` the TTY entry is made twice
 *  under `labels` (see PassphrasePromptLabels). */
async function resolvePassphrase(
  opts: SecretsCommandOptions,
  io: SecretsIo,
  confirm = false,
  labels: PassphrasePromptLabels = CREATE_VAULT_LABELS,
): Promise<string | null | Cancelled | NoEcho> {
  if (opts.passphrase !== undefined) return opts.passphrase.length > 0 ? opts.passphrase : null;
  const fromEnv = process.env.YAW_MCP_VAULT_PASSPHRASE;
  // An empty env var ("") is treated the same as absent -- deriving a key
  // from "" would otherwise silently unlock any vault. The env path is
  // single-shot even when `confirm` is set: a scripted value has no second
  // entry to compare against, and a CI passphrase is not a typo to catch.
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    warnIfShortPassphrase(io, opts.json, fromEnv, "YAW_MCP_VAULT_PASSPHRASE");
    return fromEnv;
  }
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  if (!isInteractiveTTY(opts)) return null;
  // Creating a vault: it has no check marker yet, so unlock() accepts ANY
  // passphrase -- a first-set typo would silently BECOME the vault's
  // (unrecoverable) passphrase. Confirm it twice, like rotate's
  // resolveNewPassphrase, so the two entries must agree before we commit.
  if (confirm) return promptPassphraseTwice(opts, io, labels);
  // Reject an empty passphrase (bare Enter / EOF with nothing typed):
  // deriving a key from "" would otherwise unlock any vault. Re-prompt up
  // to a few times, then give up so we never spin forever on a closed pipe.
  for (let attempt = 0; attempt < MAX_PASSPHRASE_PROMPTS; attempt++) {
    const entered = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout);
    if (entered === CANCELLED || entered === NO_ECHO) return entered;
    if (entered.length > 0) {
      // Unlocking an EXISTING vault. unlock() has NOT run yet, so this string
      // is just what was typed -- it may be a typo that is about to be rejected.
      // Describe it as "the passphrase you entered" (never as the vault's) and
      // make the rotate pointer conditional: a fat-fingered short entry must
      // not be told to re-key a passphrase that was never wrong. When the entry
      // IS the vault's, `secrets rotate` remains the fix -- a retype cannot
      // lengthen a passphrase already committed to the vault.
      warnIfShortPassphrase(
        io,
        opts.json,
        entered,
        "the passphrase you entered",
        "If it unlocks this vault, re-key it with `yaw-mcp secrets rotate`.",
      );
      return entered;
    }
    stdout.write("Passphrase cannot be empty.\n");
  }
  return null;
}

/** Resolve the NEW passphrase for `rotate`. Precedence:
 *    1. opts.newPassphrase (test hook)
 *    2. YAW_MCP_VAULT_PASSPHRASE_NEW env var
 *    3. TTY confirm-twice prompt (must match; non-empty)
 *  Returns null when none can be obtained (non-TTY + no env) or the two
 *  TTY entries disagree after the allowed prompts, CANCELLED when the
 *  user hit ^C at either prompt, and NO_ECHO when the terminal would not
 *  turn echo off. */
async function resolveNewPassphrase(
  opts: SecretsCommandOptions,
  io: SecretsIo,
): Promise<string | null | Cancelled | NoEcho> {
  if (opts.newPassphrase !== undefined) return opts.newPassphrase.length > 0 ? opts.newPassphrase : null;
  const fromEnv = process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    warnIfShortPassphrase(io, opts.json, fromEnv, "the new passphrase");
    return fromEnv;
  }
  if (!isInteractiveTTY(opts)) return null;
  return promptPassphraseTwice(opts, io, NEW_PASSPHRASE_LABELS);
}

/** Cap re-prompts for an empty entry so a closed/EOF stdin can't loop
 *  forever. Every no-echo prompt shares it: the passphrase prompts and the
 *  secret-value prompt (readStdinValue). */
const MAX_PASSPHRASE_PROMPTS = 3;

/** Soft floor for a passphrase: shorter than this triggers a stderr
 *  warning (never a hard block) on EVERY path a passphrase arrives on --
 *  env var, TTY creation prompt, TTY unlock prompt, and rotate's new
 *  passphrase. See warnIfShortPassphrase. */
const MIN_PASSPHRASE_WARN_LEN = 12;

/** Control bytes the raw-mode reader reacts to. Spelled as escapes: the
 *  literal bytes are invisible in an editor and get mangled by tooling. */
const CTRL_C = "\x03"; // ETX -- cancel the whole command
const CTRL_D = "\x04"; // EOT -- cancel this entry (resolves as an empty one)
const TAB = "\x09"; // HT -- kept only at the secret-value prompt (keepTab)
const DEL = "\x7f"; // what most terminals send for Backspace
const ESC = "\x1b"; // opens a key sequence (arrow, Alt chord) -- never input

/** Returned by the no-echo reads when the terminal could not be switched to
 *  raw mode. Raw mode is what turns echo OFF: without it the read would be
 *  line-buffered by the terminal, which ECHOES every character -- the secret
 *  on screen, in plain text, for anyone walking by. So the no-echo prompts
 *  refuse instead (see noEchoRefusal). Distinct from CANCELLED (the user
 *  did nothing) and from null (no prompt was possible at all). */
const NO_ECHO: unique symbol = Symbol("yaw-mcp:no-echo-unavailable");
type NoEcho = typeof NO_ECHO;

/** The refusal for NO_ECHO, worded like promptUnavailableMessage: what was
 *  required, why the prompt would not run, and the non-interactive way in. */
function noEchoRefusal(required: string, remedy: string): string {
  return `${required} Refusing to prompt: this terminal would not turn echo off, so what you type would be shown on screen. ${remedy}`;
}

/** Raw-mode line reader for the controlling TTY. Shared by the passphrase
 *  prompts (echo OFF -- the default), the destructive-action confirmation
 *  (echo ON, so the user can see the y/n they typed), and -- via
 *  readAnswerFromTTY below -- `yaw-mcp trust`'s approval prompt. One reader
 *  means ^C / ^D / Backspace / a stray ESC behave identically at every
 *  prompt in the product.
 *
 *  A no-echo read that cannot enter raw mode resolves NO_ECHO without
 *  writing the prompt or reading a byte. An echo read carries on
 *  line-buffered: its answer was going to be shown anyway.
 *
 *  `keepTab` (no-echo reads only) buffers a Tab instead of dropping it with
 *  the other control bytes; only the secret-value prompt sets it -- see the
 *  drop below. */
function readLineFromTTY(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt: string,
  echo: true,
): Promise<string | Cancelled>;
function readLineFromTTY(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt?: string,
  echo?: false,
  keepTab?: boolean,
): Promise<string | Cancelled | NoEcho>;
function readLineFromTTY(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt = "Vault passphrase: ",
  echo = false,
  keepTab = false,
): Promise<string | Cancelled | NoEcho> {
  return new Promise<string | Cancelled | NoEcho>((resolve) => {
    const chunks: string[] = [];
    const wasRaw = stdin.isRaw === true;
    // Raw mode BEFORE the prompt is written, so a refused no-echo read leaves
    // no dangling "Vault passphrase: " on the line. A stream with no
    // setRawMode at all is treated as a failure on the no-echo path too:
    // every no-echo caller reads only when stdin.isTTY is true, and a TTY
    // that cannot be put in raw mode echoes.
    let raw = false;
    try {
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(true);
        raw = true;
      }
    } catch {
      // Raw mode refused; handled just below.
    }
    if (!raw && !echo) {
      resolve(NO_ECHO);
      return;
    }
    stdout.write(prompt);
    stdin.resume();
    stdin.setEncoding("utf8");
    // Single teardown path: detach the listener, restore the previous raw
    // mode, pause stdin, then settle. Every exit from onData goes through it.
    const finish = (value: string | Cancelled): void => {
      stdout.write("\n");
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
        // ignore
      }
      stdin.pause();
      resolve(value);
    };
    // Escape-sequence parser state, carried ACROSS chunks: a terminal can
    // split an arrow key's bytes over two reads, and the tail of one must
    // not be taken for typed text.
    let esc: "none" | "esc" | "seq" = "none";
    // Hoisted declaration so `finish` above can name it.
    function onData(chunk: string): void {
      let consumed = 0;
      // Settle, then RE-BUFFER whatever follows the byte that ended this
      // read. A terminal paste arrives as one chunk, so without this,
      // pasting "passphrase\nvalue\n" consumed the passphrase and silently
      // dropped the value line -- the next prompt then hung waiting for
      // input the user believes they already gave. unshift() puts the
      // residual at the head of the stream (finish() has already paused
      // it), so the NEXT reader's resume() picks it up. Optional call: the
      // injectable io contract only promises a ReadableStream shape.
      const finishAndRebuffer = (value: string | Cancelled): void => {
        finish(value);
        const rest = chunk.slice(consumed);
        if (rest.length > 0) (stdin as { unshift?: (c: string) => void }).unshift?.(rest);
      };
      for (const ch of chunk) {
        consumed += ch.length;
        // ESC "[" (CSI) and ESC "O" (SS3) open a key sequence the terminal
        // sent on the user's behalf -- an arrow, Home/End, a function key --
        // and NONE of its bytes is input: it runs through a final byte in
        // 0x40-0x7e. Dropping only the 0x1b byte and buffering the rest
        // inserted "[D" / "[A" into the NO-ECHO value and passphrase prompts,
        // where the user could not see the corruption: a Left arrow to fix a
        // typo in a pasted token stored `ghp_abc[D`, and the server later
        // failed auth with nothing pointing at the vault. Any OTHER byte
        // after an ESC is handled as typed: the ESC was a lone Escape key,
        // or the meta prefix of an Alt chord, and neither is a reason to
        // lose the keystroke that follows -- so Escape-then-Enter still
        // submits, and Escape-then-y at a [y/N] prompt is still a y. A
        // control byte never continues a sequence either.
        if (esc === "esc") {
          esc = "none";
          if (ch === "[" || ch === "O") {
            esc = "seq";
            continue;
          }
        } else if (esc === "seq") {
          if (ch >= " ") {
            if (ch >= "@" && ch <= "~") esc = "none";
            continue;
          }
          esc = "none";
        }
        if (ch === ESC) {
          esc = "esc";
          continue;
        }
        if (ch === "\n" || ch === "\r") {
          // A pasted CRLF is ONE Enter: swallow the \n so it cannot be
          // re-buffered and submit the next prompt as empty.
          if (ch === "\r" && chunk[consumed] === "\n") consumed += 1;
          finishAndRebuffer(chunks.join(""));
          return;
        }
        if (ch === CTRL_D) {
          // Cancel this entry. Resolve to "", an empty submission -- the
          // no-echo prompts (passphrase and value) re-prompt on it, and a
          // y/N or RESET confirmation reads it as no. Never a line
          // terminator that would submit a partial entry.
          finishAndRebuffer("");
          return;
        }
        if (ch === CTRL_C) {
          // Cancel the command. We deliberately do NOT process.exit() here:
          // the io streams are injectable, so a fed 0x03 must not be able to
          // kill the host process. The caller maps CANCELLED to exit 130.
          finishAndRebuffer(CANCELLED);
          return;
        }
        if (ch === "\b" || ch === DEL) {
          if (chunks.length > 0) {
            chunks.pop();
            if (echo) stdout.write("\b \b");
          }
          continue;
        }
        // Drop every remaining control byte instead of buffering + echoing
        // it. On the echo path (the y/n confirmation) a raw control byte
        // written back is EXECUTED by the terminal rather than displayed.
        // Everything else meaningful (\n \r ^C ^D \b ESC) is handled above.
        // The one byte kept is a Tab at the secret-VALUE prompt (keepTab): a
        // pasted token can carry one, and dropping it stored a different
        // secret behind a green "Stored secret", with nothing on the no-echo
        // line to show it (a piped value always kept it). The passphrase
        // prompts still drop it, deliberately: a vault created by typing a
        // Tab there is keyed under the Tab-less string, and keeping the byte
        // now would stop the same keystrokes opening that vault.
        if (ch < " " && !(keepTab && ch === TAB)) continue;
        chunks.push(ch);
        if (echo) stdout.write(ch);
      }
    }
    stdin.on("data", onData);
  });
}

/**
 * Ask a one-line question on the terminal and hand back what was typed
 * (trimmed, lowercased by the caller). Returns null when the user hit ^C.
 *
 * Exists so `yaw-mcp trust` and `yaw-mcp secrets` share ONE prompt reader
 * instead of two. trust-cmd used node:readline, this file uses the raw-mode
 * reader above, and the fix for an ESC/arrow key at a [y/N] prompt (a raw ESC
 * echoed back is EXECUTED by the terminal, and "\x1by" is not "y", so the
 * answer silently flipped) landed in only one of them. Two implementations of
 * "read one confirmation" drift; this is the one.
 *
 * Echo is ON: a y/n answer is not a secret, and the user has to see it.
 */
export async function readAnswerFromTTY(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  question: string,
): Promise<string | null> {
  const answer = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, question, true);
  return answer === CANCELLED ? null : answer;
}

/** Returned by readStdinValue when stdin is a TTY (so there is nothing piped
 *  to read) but stdout is not (so the prompt cannot be shown). Distinct from
 *  CANCELLED: the user did not decline anything, the command simply has no
 *  way to ask. */
const PROMPT_IMPOSSIBLE: unique symbol = Symbol("yaw-mcp:value-prompt-impossible");
type PromptImpossible = typeof PROMPT_IMPOSSIBLE;

/** Read the secret VALUE: the interactive no-echo prompt, or raw stdin when
 *  it is piped (or --stdin forces it).
 *
 *  The interactive branch needs BOTH ends of the terminal, the same rule
 *  isInteractiveTTY applies to every other prompt in this file. Gating on
 *  stdin.isTTY alone meant `yaw-mcp secrets set GH > out.json` -- TTY stdin,
 *  redirected stdout -- wrote "Secret value: " INTO the redirect target,
 *  switched the terminal to raw no-echo mode, and then sat there waiting on
 *  a prompt the user could not see. Refusing is the honest answer; --value
 *  and a piped stdin are the scripted paths.
 *
 *  An empty entry (bare Enter, or ^D) re-prompts, up to
 *  MAX_PASSPHRASE_PROMPTS times like the passphrase prompts, and then comes
 *  back "" for runSecrets's "cannot be empty" refusal. Refusing on the first
 *  one cost the user the passphrase entry and scrypt derivation that run
 *  before this prompt -- the cost parseSecretsArgs refuses `--value ""` early
 *  to avoid. */
async function readStdinValue(
  io?: SecretsCommandOptions["io"],
  forceRaw?: boolean,
): Promise<string | Cancelled | PromptImpossible | NoEcho> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const stdinIsTTY = (stdin as { isTTY?: boolean }).isTTY === true;
  const stdoutIsTTY = (stdout as { isTTY?: boolean }).isTTY === true;
  if (stdinIsTTY && !forceRaw) {
    if (!stdoutIsTTY) return PROMPT_IMPOSSIBLE;
    for (let attempt = 0; attempt < MAX_PASSPHRASE_PROMPTS; attempt++) {
      // Pass the label as the reader's PROMPT rather than writing it first:
      // the reader writes its own prompt, so pre-writing one printed
      // "Secret value: Vault passphrase: " and asked the user for the wrong
      // thing at the value prompt. keepTab: a Tab in a pasted token is part
      // of it (see readLineFromTTY).
      const entered = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, "Secret value: ", false, true);
      if (entered === CANCELLED || entered === NO_ECHO || entered.length > 0) return entered;
      stdout.write("Secret value cannot be empty.\n");
    }
    return "";
  }
  // Piped stdin (or --stdin at a terminal) -- read all of it, then strip ONE
  // trailing newline, LF or CRLF: `echo v |` must store `v` (a stored `v\n`
  // fails auth wherever it is injected, and `get` hides it behind its own
  // newline), while anything before that last newline is the value.
  const chunks: string[] = [];
  stdin.setEncoding("utf8");
  for await (const chunk of stdin as unknown as AsyncIterable<string>) chunks.push(chunk);
  return chunks.join("").replace(/\r?\n$/, "");
}

export async function runSecrets(
  opts: SecretsCommandOptions,
  io: SecretsIo = {
    out: createStreamWriter(process.stdout),
    err: createStreamWriter(process.stderr),
  },
): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);

  // An action outside the eight is refused FIRST, before the fingerprint,
  // the load, the passphrase prompt and the scrypt derivation -- the CLI
  // parser never lets one through, but `action` is optional for an embedder,
  // and the old fallthrough at the bottom made that caller pay for all four
  // to hear "unknown action", in prose even under --json. The `never` binding
  // at the bottom makes tsc name a ninth action with no branch below.
  if (!isSecretsAction(opts.action)) {
    return failResult(io, opts.json, "", `unknown action ${String(opts.action)}`, { exitCode: 2 });
  }

  // Lock is the only action that does not need a passphrase. From the CLI it
  // is effectively a no-op (see SECRETS_USAGE): this process's cache is the
  // only thing it can clear, and the process is about to exit anyway. The
  // output says exactly that -- "Vault locked." read as a revocation, and
  // the bare {locked:true} envelope let a script believe one had happened.
  if (opts.action === "lock") {
    lock();
    if (opts.json) {
      io.out(
        `${JSON.stringify({ ok: true, locked: true, scope: "this-process", running_servers_affected: false, vault_changed: false })}\n`,
      );
    } else {
      io.out(
        "Passphrase cache cleared for this process only. A running yaw-mcp server keeps its own cached key until it exits, and the vault on disk is unchanged.\n",
      );
    }
    return { exitCode: 0 };
  }

  // rotate resolves BOTH passphrases itself (current + new), so it runs
  // ahead of the shared single-passphrase path below.
  if (opts.action === "rotate") {
    return await runSecretsRotate(opts, io);
  }

  // reset needs no CURRENT passphrase at all -- a forgotten one is its whole
  // reason to exist -- and takes the NEW one through the creation prompt, so
  // it runs ahead of the shared path too.
  if (opts.action === "reset") {
    return await runSecretsReset(opts, io);
  }

  // audit is a read-only command -- no passphrase needed (it never
  // touches ciphertext, only the names/timestamps in the audit log).
  if (opts.action === "audit") {
    return await runSecretsAudit(opts, io);
  }

  if (opts.action === "list") {
    const loaded = await safeLoadVault(path, io, opts.json, "list");
    if (!loaded.ok) return loaded.result;
    const vault = loaded.vault;
    if (vault) schemaBehindNotice(io, vault, path, opts.json);
    const keys = vault ? listKeys(vault) : [];
    // `vault` here is the load result, not a second existsSync probe: two
    // reads of the same fact can disagree under a concurrent create, and
    // loadVault already distinguished absent (null) from unreadable (threw).
    // One compact line, like every other --json envelope (this one and
    // audit's used to be pretty-printed over several).
    if (opts.json) io.out(`${JSON.stringify({ ok: true, vault: vault !== null, keys })}\n`);
    else if (!vault) io.out(`No vault at ${path}. Run \`yaw-mcp secrets set <name>\` to create one.\n`);
    else if (keys.length === 0) io.out(`Vault at ${path} is empty.\n`);
    else {
      io.out(`Vault at ${path}\n`);
      for (const k of keys) io.out(`  ${k}\n`);
    }
    return { exitCode: 0 };
  }

  // One load for every remaining action -- the get/remove existence check
  // below and the mutate path share it (reading the file twice raced with
  // itself and doubled the I/O for no benefit).
  // Fingerprint the on-disk bytes BEFORE the load, not after: the mutating
  // actions re-check it immediately before their save and refuse if the
  // file moved (vaultChangedSinceLoad), and taking the baseline second
  // would open a load-to-baseline gap where a concurrent writer's bytes
  // become the baseline while the in-memory vault is the older parse --
  // the re-check would then pass and silently revert that write. In the
  // baseline-first order a write landing between the two reads makes the
  // re-check FAIL (refusal), the safe direction. get never saves, so it
  // skips the extra read.
  const baseline = opts.action === "get" ? null : await vaultFingerprint(path);
  // An unreadable baseline dooms every save (the re-check can never match),
  // so fail NOW with the real cause rather than after the confirmation,
  // scrypt derivation and value prompt with a misleading "changed on disk".
  if (isVaultUnreadable(baseline)) return vaultUnreadableResult(io, opts.json, opts.action, path, baseline);
  const loaded = await safeLoadVault(path, io, opts.json, opts.action);
  if (!loaded.ok) return loaded.result;
  if (loaded.vault) schemaBehindNotice(io, loaded.vault, path, opts.json);

  // Short-circuit get/remove when the vault is missing or the entry
  // doesn't exist -- avoids prompting for a passphrase and paying the
  // scrypt derivation just to say "not found".
  //
  // This is the ONLY place the not-found message and its exit code live.
  // The get and remove bodies below used to repeat the same check against
  // the same (already-proven) vault; both copies were unreachable, and a
  // future edit to the wording or exit code here would have silently
  // diverged from them.
  if (opts.action === "get" || opts.action === "remove") {
    const name = opts.name as string;
    // Object.hasOwn, not `in`: entries comes from JSON.parse and inherits
    // Object.prototype, so `secrets get toString` would otherwise pass.
    if (!loaded.vault || !Object.hasOwn(loaded.vault.entries, name)) {
      return failResult(io, opts.json, opts.action, `No secret named "${name}" in the vault.`);
    }
  }

  // ----- destructive-action confirmation --------------------------------
  // Same shape as install-cmd's existing-entry collision gate: prompt when
  // stdin+stdout are a TTY, and when they are not, either refuse naming the
  // flag to re-run with, or proceed -- per action.
  //
  // The asymmetry between remove and set is deliberate:
  //   remove -- UNRECOVERABLE. The ciphertext is gone and nothing in this
  //             tool can bring it back, so a non-interactive run has to opt
  //             in explicitly with --force.
  //   set    -- an overwrite is a SWAP the user is performing with the new
  //             value already in hand, and re-setting a name is the normal
  //             credential-rotation path. Requiring --force there would
  //             break every rotation script, so a non-TTY run proceeds --
  //             the success message just has to say it REPLACED a value
  //             rather than claiming a fresh write.
  //
  // Both gates run BEFORE the passphrase prompt so a declined confirmation
  // never costs the user a passphrase entry. --force skips only the
  // confirmation: the passphrase and its scrypt derivation still happen.
  const replacing =
    opts.action === "set" && loaded.vault !== null && Object.hasOwn(loaded.vault.entries, opts.name as string);

  if (opts.action === "remove" && !opts.force) {
    if (isInteractiveTTY(opts)) {
      const confirmed = await promptYesNo(opts, `Permanently delete secret "${opts.name}"? This cannot be undone.`);
      if (confirmed === CANCELLED) return cancelledResult(io, opts.json, "remove");
      if (!confirmed) return abortedResult(io, opts.json, "remove");
    } else {
      return failResult(
        io,
        opts.json,
        "remove",
        `refusing to delete "${opts.name}" without confirmation and ${nonTTYEnds(opts)}.`,
        { exitCode: 2, detail: "Re-run with --force to delete it. This cannot be undone." },
      );
    }
  }

  if (replacing && !opts.force && isInteractiveTTY(opts)) {
    const confirmed = await promptYesNo(
      opts,
      `Secret "${opts.name}" already exists. Replace it? The stored value is overwritten.`,
    );
    if (confirmed === CANCELLED) return cancelledResult(io, opts.json, "set");
    if (!confirmed) return abortedResult(io, opts.json, "set");
  }

  // Remaining actions all need the vault + passphrase. "Fresh" is the load
  // result itself, not a second existsSync probe: the probe re-asked the
  // filesystem a fact the load already settled, and the two could disagree
  // under a concurrent create (file appears between load and probe -> the
  // in-memory vault is empty but the run says it is not creating one).
  let vault = loaded.vault ?? newVault();
  const isFresh = loaded.vault === null;

  // A vault with no check marker AND no entries has nothing for unlock() to
  // verify a passphrase against, so it accepts ANY passphrase -- the first
  // interactive `set` silently ESTABLISHES the vault passphrase, and a typo
  // there creates a vault the user can never unlock again. Confirm it twice
  // on the TTY (like rotate's new passphrase). Only `set` reaches here on a
  // fresh vault -- get/remove short-circuit above -- and the env-var path
  // stays single-shot inside resolvePassphrase.
  const creatingVault = opts.action === "set" && !vault.check && Object.keys(vault.entries).length === 0;

  const passphrase = await resolvePassphrase(opts, io, creatingVault);
  if (passphrase === CANCELLED) return cancelledResult(io, opts.json, opts.action);
  if (passphrase === NO_ECHO) {
    return failResult(
      io,
      opts.json,
      opts.action,
      noEchoRefusal("Passphrase required.", "Set YAW_MCP_VAULT_PASSPHRASE instead."),
    );
  }
  if (passphrase === null) {
    return failResult(
      io,
      opts.json,
      opts.action,
      promptUnavailableMessage(opts, "Passphrase required.", "YAW_MCP_VAULT_PASSPHRASE"),
    );
  }

  let key: Buffer;
  try {
    key = await unlock(vault, passphrase);
  } catch (err) {
    return failResult(io, opts.json, opts.action, unlockErrorMessage(err, path));
  }

  // ----- set ------------------------------------------------------------
  if (opts.action === "set") {
    const name = opts.name as string;
    let value: string;
    if (opts.value !== undefined) value = opts.value;
    else {
      const entered = await readStdinValue(opts.io, opts.fromStdin);
      if (entered === CANCELLED) return cancelledResult(io, opts.json, "set");
      if (entered === NO_ECHO) {
        return failResult(
          io,
          opts.json,
          "set",
          noEchoRefusal("Secret value required.", "Pipe the value in with --stdin instead."),
        );
      }
      if (entered === PROMPT_IMPOSSIBLE) {
        return failResult(
          io,
          opts.json,
          "set",
          "cannot prompt for the value: stdin is a TTY but stdout is not, so the prompt would be written into the redirect instead of shown. Pass --value <v>, or pipe the value in with --stdin.",
        );
      }
      value = entered;
    }
    if (!value) return failResult(io, opts.json, "set", "Secret value cannot be empty.");
    try {
      // setSecret rejects a name no ${secret:NAME} reference could ever
      // address (spaces, colons, braces) -- surface that as a normal CLI
      // error instead of an unhandled rejection. For the CLI path
      // parseSecretsArgs already rejected it before any prompt; this is
      // the backstop for programmatic callers of runSecrets.
      vault = setSecret(vault, key, name, value);
    } catch (err) {
      return failResult(io, opts.json, "set", err instanceof Error ? err.message : String(err));
    }
    if (await vaultChangedSinceLoad(path, baseline)) return vaultChangedResult(io, opts.json, "set");
    // atomicWriteFile mkdirs the target dir, so no ensureVaultDir needed.
    const failed = await saveVaultOrReport(path, vault, io, opts.json, "set");
    if (failed) return failed;
    // "Replaced" vs "Stored" is the only signal a scripted run gets that it
    // just destroyed a previous value (the non-TTY path proceeds without a
    // confirmation), so the two cases must never print the same line.
    if (opts.json) io.out(`${JSON.stringify({ ok: true, name, fresh_vault: isFresh, replaced: replacing })}\n`);
    else if (replacing) io.out(`Replaced secret "${name}".\n`);
    else io.out(`${isFresh ? "Created vault and " : ""}Stored secret "${name}".\n`);
    // Creating the vault is the one moment the CLI can tell the user that
    // the passphrase has to reach the yaw-mcp their CLIENT spawns, not just
    // the shell they typed this in. See freshVaultNudge.
    if (isFresh) freshVaultNudge(io, path, opts.json);
    return { exitCode: 0 };
  }

  // ----- get ------------------------------------------------------------
  if (opts.action === "get") {
    const name = opts.name as string;
    try {
      // Non-null by construction: the short-circuit above returned exit 1
      // for a missing name (and for a missing vault) before the passphrase
      // prompt, so `vault` is `loaded.vault` with `name` present and
      // getSecret's own hasOwn check cannot fail. The not-found message
      // lives there, once.
      const value = getSecret(vault, key, name) as string;
      // Warn (on `err`, never `out` -- keeps the value pipeable) when the
      // caller is interactive: `get` prints cleartext, so an interactive run
      // scrolls a secret into terminal scrollback. Skipped for piped/redirected
      // stdout, which is the intended consumption path. Under --json it is a
      // JSON line like every other warning (this was the last prose one, and
      // a pty-driven wrapper parsing stderr per SECRETS_USAGE choked on it).
      const outStream = opts.io?.stdout ?? process.stdout;
      if ((outStream as { isTTY?: boolean }).isTTY === true) {
        if (opts.json) io.err(`${JSON.stringify({ warning: "cleartext-on-tty", name })}\n`);
        else {
          io.err(
            `yaw-mcp secrets: warning -- printing "${name}" in cleartext to your terminal; it will remain in scrollback.\n`,
          );
        }
      }
      if (opts.json) io.out(`${JSON.stringify({ ok: true, name, value })}\n`);
      else io.out(`${value}\n`);
      return { exitCode: 0 };
    } catch (err) {
      // The passphrase itself was already verified by unlock() above (via
      // the vault check stamp, or the first-entry canary on a legacy
      // vault), so "wrong passphrase" is NOT reachable here. What is: this
      // one entry is damaged, or it was written under a different key than
      // the rest of the vault by an older build.
      return failResult(io, opts.json, "get", err instanceof Error ? err.message : String(err), {
        detail: `Entry "${name}" failed to decrypt: it is corrupt, or it was written under a different passphrase than the rest of the vault. Remove it and set it again.`,
        detailAsHint: true,
      });
    }
  }

  // ----- remove ---------------------------------------------------------
  if (opts.action === "remove") {
    const name = opts.name as string;
    // Existence was proven by the short-circuit above (the single owner of
    // the not-found message), so removeSecret always has something to drop.
    if (await vaultChangedSinceLoad(path, baseline)) return vaultChangedResult(io, opts.json, "remove");
    vault = removeSecret(vault, name);
    const failed = await saveVaultOrReport(path, vault, io, opts.json, "remove");
    if (failed) return failed;
    if (opts.json) io.out(`${JSON.stringify({ ok: true, removed: name })}\n`);
    else io.out(`Removed "${name}".\n`);
    return { exitCode: 0 };
  }

  // Unreachable: the guard at the top admits only the eight actions, and
  // each has returned above. Typed `never` so a ninth action added to
  // SECRETS_ACTIONS without a branch here fails tsc instead of reaching this.
  const unhandled: never = opts.action;
  return failResult(io, opts.json, "", `unknown action ${String(unhandled)}`, { exitCode: 2 });
}

/**
 * Re-encrypt the whole vault under a new passphrase.
 *
 * Flow:
 *   1. Load the local vault; error if none.
 *   2. Resolve + verify the CURRENT passphrase (unlock validates the key
 *      against vault.check, so a wrong current passphrase is rejected
 *      before any rotation).
 *   3. Resolve the NEW passphrase (env / TTY confirm-twice).
 *   4. rotateVault decrypts every entry under the old key FIRST (aborting
 *      on any failure with the on-disk vault untouched), then re-encrypts
 *      under a fresh salt + the new key.
 *   5. Save atomically, lock() to drop the stale in-memory key.
 */
async function runSecretsRotate(opts: SecretsCommandOptions, io: SecretsIo): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);

  // safeLoadVault, not raw loadVault: a corrupt vault must come back as the
  // same {ok:false} envelope the sibling actions emit (and stay JSON under
  // --json) instead of escaping as a rejection the dispatcher formats.
  // Same pre-load fingerprint as runSecrets (baseline BEFORE the load so a
  // write straddling the two reads fails the re-check instead of slipping
  // under it): both passphrase prompts below are unbounded pauses, and
  // saving a rotation derived from a stale snapshot would revert whatever
  // landed in the meantime (or, the mirror image, a concurrent `set`
  // would revert this rotation).
  const baseline = await vaultFingerprint(path);
  // Same fail-fast as runSecrets: an unreadable baseline can never pass the
  // pre-save re-check, so refuse before either passphrase prompt.
  if (isVaultUnreadable(baseline)) return vaultUnreadableResult(io, opts.json, "rotate", path, baseline);
  const loaded = await safeLoadVault(path, io, opts.json, "rotate");
  if (!loaded.ok) return loaded.result;
  const vault = loaded.vault;
  if (!vault) {
    return failResult(
      io,
      opts.json,
      "rotate",
      `No vault at ${path} to rotate. Run \`yaw-mcp secrets set <name>\` first.`,
    );
  }

  const currentPassphrase = await resolvePassphrase(opts, io);
  if (currentPassphrase === CANCELLED) return cancelledResult(io, opts.json, "rotate");
  if (currentPassphrase === NO_ECHO) {
    return failResult(
      io,
      opts.json,
      "rotate",
      noEchoRefusal("Current passphrase required.", "Set YAW_MCP_VAULT_PASSPHRASE instead."),
    );
  }
  if (currentPassphrase === null) {
    return failResult(
      io,
      opts.json,
      "rotate",
      promptUnavailableMessage(opts, "Current passphrase required.", "YAW_MCP_VAULT_PASSPHRASE"),
    );
  }

  let oldKey: Buffer;
  try {
    oldKey = await unlock(vault, currentPassphrase);
  } catch (err) {
    return failResult(io, opts.json, "rotate", unlockErrorMessage(err, path));
  }

  const newPassphrase = await resolveNewPassphrase(opts, io);
  if (newPassphrase === CANCELLED) return cancelledResult(io, opts.json, "rotate");
  if (newPassphrase === NO_ECHO) {
    return failResult(
      io,
      opts.json,
      "rotate",
      noEchoRefusal("New passphrase required.", "Set YAW_MCP_VAULT_PASSPHRASE_NEW instead."),
    );
  }
  if (newPassphrase === null) {
    return failResult(
      io,
      opts.json,
      "rotate",
      promptUnavailableMessage(
        opts,
        "New passphrase required (and must be confirmed).",
        "YAW_MCP_VAULT_PASSPHRASE_NEW",
      ),
    );
  }

  let rotated: VaultFile;
  try {
    // rotateVault decrypts EVERY entry first; if any fails it throws
    // before re-encrypting, so the on-disk vault stays untouched.
    rotated = await rotateVault(vault, oldKey, newPassphrase);
  } catch (err) {
    // On-disk vault is untouched by definition (we never reached save).
    lock();
    return failResult(io, opts.json, "rotate", err instanceof Error ? err.message : String(err));
  }

  if (await vaultChangedSinceLoad(path, baseline)) {
    // Belt-and-braces, NOT load-bearing: unlock() keys its cache on the
    // vault's salt (cachedSalt in secrets-vault.ts), so a key derived against
    // the snapshot we just refused to overwrite can never be handed to
    // whatever replaced it -- which is why `set` and `remove` take these same
    // two exits without a lock() and still cannot leak a stale key. rotate
    // drops it anyway: holding a derived key for a vault this command was
    // just told it does not have is state with no use left.
    lock();
    return vaultChangedResult(io, opts.json, "rotate");
  }
  const failed = await saveVaultOrReport(path, rotated, io, opts.json, "rotate");
  if (failed) {
    // Same belt-and-braces drop as the refusal above: the on-disk vault is
    // still the pre-rotation one (so the cached key remains valid for it),
    // but the caller was just told nothing was saved. Only the lock() on the
    // success path below is load-bearing -- there the salt really changed.
    lock();
    return failed;
  }
  // Drop the stale key derived from the OLD passphrase. The salt changed,
  // so the next secrets command must re-derive against the new passphrase.
  lock();

  const count = Object.keys(rotated.entries).length;

  if (opts.json) {
    io.out(`${JSON.stringify({ ok: true, rotated: true, secret_count: count })}\n`);
  } else {
    io.out(
      `Rotated ${count} secret${count === 1 ? "" : "s"} under a new passphrase (encryption re-wrapped, token values unchanged).\n`,
    );
    io.out("Vault locked -- the next secrets command will prompt for the new passphrase.\n");
  }
  return { exitCode: 0 };
}

/** Where `reset` parks the vault it replaces: `<vault path>.reset-<stamp>`,
 *  next to the vault. The stamp is the ISO 8601 instant with its colons
 *  replaced by dashes (`2026-09-23T18-04-05.123Z`): a colon is illegal in an
 *  NTFS file name, and the replacement keeps the name readable and
 *  sortable. `-2`, `-3`, ... follow when that exact name is taken
 *  (copyVaultAside bumps `attempt` on EEXIST), so two resets in one
 *  millisecond cannot land on one backup. Exported for tests. */
export function resetBackupPath(path: string, at: Date, attempt = 1): string {
  return `${path}.reset-${at.toISOString().replace(/:/g, "-")}${attempt > 1 ? `-${attempt}` : ""}`;
}

/** The entry NAMES in the vault file at `path`, read WITHOUT loadVault's
 *  validation. Names are plaintext object keys (only values are ciphertext),
 *  so this needs no passphrase -- and it must not need a well-formed vault
 *  either: a file loadVault refuses (a corrupt entry, a bad salt, a schema
 *  from a newer build) is exactly one a user may be resetting their way out
 *  of, and the corrupt-entry hint has always said "start the vault over".
 *  This reader never decrypts (names need no passphrase), so none of
 *  loadVault's guarantees are needed here; the one shape checked is the one
 *  the names depend on. (Reset's only decryption is the already-opens
 *  guard's key check, which runs solely on a vault loadVault accepted and,
 *  when the check marker is absent or damaged, tries entry values as
 *  canaries and discards what it recovers -- see verifyKey.) An `entries`
 *  that is an array is reported unreadable here, and loadVault refuses it
 *  too ("missing or invalid salt/entries"): no yaw-mcp ever writes that
 *  shape, and it holds no names either way. */
async function readVaultEntryNames(path: string): Promise<{ names: string[] } | { unreadable: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { unreadable: e.code ?? (err instanceof Error ? err.message : String(err)) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { unreadable: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { unreadable: "root is not a JSON object" };
  }
  const entries = (parsed as Record<string, unknown>).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return { unreadable: '"entries" is missing or not an object' };
  }
  return { names: Object.keys(entries).sort() };
}

/** Copy the vault at `path` to its backup name, never over an existing
 *  file: COPYFILE_EXCL makes "that name is taken" an EEXIST from the kernel
 *  rather than a stat-then-copy race, and the suffix is bumped until a name
 *  is free. Reads THROUGH a symlinked vault (copyFile follows links), so the
 *  backup lands next to the vault PATH -- outside a dotfiles checkout the
 *  real file may live in, where an untracked ciphertext file is not wanted.
 *  Best-effort 0o600 on the copy afterwards, the guard every other
 *  secret-bearing write in the repo carries (saveVault, the audit log):
 *  copyFile carries the source mode on POSIX, but a vault widened by hand
 *  would otherwise be the one ciphertext file nothing ever narrows again.
 *  Returns the path the copy landed at. Throws what copyFile threw for
 *  anything but EEXIST; the caller words that. */
async function copyVaultAside(path: string, at: Date): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const target = resetBackupPath(path, at, attempt);
    try {
      await copyFile(path, target, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt < 100) continue;
      throw err;
    }
    if (process.platform !== "win32") await chmod(target, 0o600).catch(() => undefined);
    return target;
  }
}

/** The pointers a refused reset gives instead: what a user who has NOT lost
 *  the passphrase actually wants is one of these. */
const RESET_ALTERNATIVES =
  "To change the passphrase of a vault that opens, use `yaw-mcp secrets rotate`; to drop an entry from it, `yaw-mcp secrets remove <name>`.";

/** The refusal for a passphrase that is already this vault's, worded for
 *  where it came from. On "marker-corrupt" the passphrase is right and the
 *  MARKER is broken: still nothing to reset (the entries are intact), but the
 *  way forward is the hand-fix, not `rotate` -- which refuses that vault
 *  too. */
function alreadyOpensMessage(verdict: Exclude<VaultPassphraseVerdict, "wrong">, subject: string, path: string): string {
  if (verdict === "marker-corrupt") {
    return `${subject} is this vault's passphrase; it is the check marker in ${path} that is corrupt -- nothing to reset, and the vault was not touched. ${vaultCheckCorruptHint(path)}`;
  }
  return `${subject} already opens the vault at ${path} -- nothing to reset, and the vault was not touched. ${RESET_ALTERNATIVES}`;
}

/** The already-opens guard's check: checkVaultPassphrase with the derived
 *  key dropped whatever happens, and a THROW -- a key-derivation failure,
 *  which says nothing about the passphrase (see checkVaultPassphrase) --
 *  handed back as its message instead of escaping to the dispatcher as a
 *  prose line (under --json, a non-JSON line on stderr). reset refuses on it:
 *  a check that could not run is no ground for moving a vault aside. */
async function resetGuardVerdict(
  vault: VaultFile,
  candidate: string,
): Promise<VaultPassphraseVerdict | { failed: string }> {
  try {
    return await checkVaultPassphrase(vault, candidate);
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) };
  } finally {
    lock();
  }
}

/** The refusal for a guard check that could not run. */
function guardFailedMessage(subject: string, path: string, cause: string): string {
  return `could not check ${subject} against the vault at ${path} (${cause}) -- nothing was changed.`;
}

/** What the TTY user reads before typing RESET: what the vault holds, where
 *  it goes, what a reset costs, and where the new passphrase will come from.
 *  Written to the PROMPT stream -- it is part of the dialogue, like the
 *  question after it -- never to io.out, which under --json carries only the
 *  envelope. Names come BEFORE the confirmation (and so before the passphrase
 *  prompt): they are what the decision is about. */
function resetPreamble(
  path: string,
  backup: string,
  names: Awaited<ReturnType<typeof readVaultEntryNames>>,
  envKeyed: boolean,
): string {
  const lines: string[] = [];
  if ("names" in names) {
    const n = names.names.length;
    lines.push(
      n === 0
        ? `The vault at ${path} has no entries.`
        : `The vault at ${path} holds ${n} ${n === 1 ? "entry" : "entries"}: ${names.names.join(", ")}`,
    );
  } else {
    lines.push(`The vault at ${path} could not be read (${names.unreadable}).`);
  }
  lines.push(`It will be moved to ${backup} -- it still opens under its old passphrase, should that turn up --`);
  lines.push("and an empty vault will be started in its place. Every entry has to be set again.");
  lines.push(
    envKeyed
      ? "The new vault will be keyed under the passphrase in YAW_MCP_VAULT_PASSPHRASE (set in this shell)."
      : "You will be asked to choose the new vault's passphrase next.",
  );
  return `${lines.join("\n")}\n`;
}

/** What a successful reset leaves the user to do elsewhere -- printed on
 *  `err` like freshVaultNudge, because it is guidance, not the result, and
 *  as one JSON line under --json for the same reason that nudge is.
 *
 *  Two processes hold the OLD passphrase after a reset and neither is told
 *  by the file: a yaw-mcp server that is already running keeps what it
 *  started with (its env, or an in-session prompt it already answered and
 *  will not repeat), and a YAW_MCP_VAULT_PASSPHRASE in a client config's
 *  `env` block is a value written down that now opens nothing. */
function resetVaultNudge(io: SecretsIo, path: string, json: boolean | undefined, envKeyed: boolean): void {
  if (json) {
    io.err(
      `${JSON.stringify({
        warning: "vault-reset",
        path,
        passphrase_source: envKeyed ? "env" : "prompt",
        hint: "A running yaw-mcp server keeps the passphrase it started with -- restart it (restart your MCP client) to use the new vault, and update YAW_MCP_VAULT_PASSPHRASE in any client config `env` block that carries the old value. `yaw-mcp doctor` reports whether the passphrase it sees unlocks the vault.",
      })}\n`,
    );
    return;
  }
  const lines = [
    "  A yaw-mcp server that is already running keeps the passphrase it started with and will not",
    "  open the new vault with it: restart it (restart your MCP client), or answer its in-session",
    "  prompt with the new passphrase if it offers one.",
    envKeyed
      ? "  The new vault is keyed under YAW_MCP_VAULT_PASSPHRASE as set in THIS shell; a client config"
      : "  A YAW_MCP_VAULT_PASSPHRASE in the `env` block of a client config still holds the OLD",
    envKeyed
      ? "  whose `env` block carries a different value still holds the OLD passphrase -- update it."
      : "  passphrase -- update it to the new one.",
    "  `yaw-mcp doctor` reports whether the passphrase it can see unlocks the vault.",
  ];
  io.err(`yaw-mcp secrets: the vault at ${path} was reset.\n${lines.join("\n")}\n`);
}

/**
 * Start the vault over when its passphrase is forgotten.
 *
 * There is nothing to recover -- the file holds ciphertext under a key
 * derived from the passphrase alone -- so a reset is a MOVE ASIDE plus a
 * fresh start: the old file is kept next to the new one (a passphrase
 * remembered later still opens it), its entry names are printed (plaintext
 * keys, no passphrase needed) because they are the list the user has to
 * re-enter, and an empty vault is written under a new passphrase.
 *
 * Flow, in this order for these reasons:
 *   1. Fingerprint, then read the entry names LENIENTLY (readVaultEntryNames)
 *      and, only for a file that read as a vault, parse it for the guard
 *      below (best-effort: a vault loadVault refuses is one reset exists
 *      for).
 *   2. A passphrase available WITHOUT a prompt -- the env var, or the test
 *      hook standing in for it -- is what the new vault would be keyed under
 *      (resolvePassphrase's precedence). If it already opens THIS vault
 *      there is nothing to reset: moving a working vault aside for an empty
 *      one under the SAME passphrase is pure loss. Refused before the user
 *      types RESET, so the refusal costs nothing. A passphrase that is right
 *      while only the check marker is damaged is refused the same way, with
 *      the hand-fix instead of a pointer at `rotate` (which refuses that
 *      vault too). A check that cannot run at all (a key-derivation failure)
 *      is refused as well, with nothing changed: it proves nothing either
 *      way.
 *   3. Confirmation: the word RESET typed on a TTY (case-insensitive, like
 *      every other gate in the CLI: typing the WORD is the deliberate act,
 *      and a reflexive y/yes/Enter carried over from remove's prompt is a
 *      no), or --force. Off a TTY without --force: refuse with exit 2, the
 *      way remove does. BEFORE any passphrase prompt, so a decline costs no
 *      typing.
 *   4. The new passphrase, through the same confirm-twice creation prompt a
 *      first `set` uses, under rotate's "New vault passphrase" labels.
 *   5. The TYPED passphrase gets the same check as the scripted one: a user
 *      who "forgot" it and then types it from memory has just proven it
 *      works, and that vault must not be moved aside either.
 *   6. The new vault is built IN MEMORY -- the scrypt derivation and the
 *      check marker -- before anything on disk changes, the way rotate
 *      derives before it re-checks and saves.
 *   7. The fingerprint re-check (the prompts above are unbounded pauses),
 *      then the old vault is COPIED aside and the new one is written over it
 *      through the same atomic write every other action uses.
 *
 * Copy-then-replace rather than rename-then-write, deliberately: the vault
 * path is never absent, so a process killed at any point leaves the old
 * vault where it was; a failed write leaves it untouched (atomicWriteFile
 * publishes by rename), so there is no rollback to get right; and a
 * symlinked vault is written THROUGH, exactly as set/remove/rotate write it,
 * instead of being severed. The copy is the only thing to tidy on failure.
 */
async function runSecretsReset(opts: SecretsCommandOptions, io: SecretsIo): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);
  const json = opts.json;
  const fail = (msg: string): SecretsCommandResult => failResult(io, json, "reset", msg);

  // Baseline BEFORE any read, as every mutating action takes it (see the
  // note above runSecrets's own): a write landing between the two reads then
  // fails the re-check instead of slipping under it.
  const baseline = await vaultFingerprint(path);
  if (isVaultUnreadable(baseline)) return vaultUnreadableResult(io, json, "reset", path, baseline);
  if (baseline === null) {
    return fail(`No vault at ${path} to reset. Run \`yaw-mcp secrets set <name>\` to create one.`);
  }

  const names = await readVaultEntryNames(path);
  // Parsed for the already-opens guard only, and only when the lenient read
  // found a vault-shaped file: one it refused would fail loadVault too (vault
  // stays null, the guard is skipped). onWarning, as at every loadVault call
  // here: loadVault then logs nothing itself, and a malformed check marker
  // comes out through io.err like every other line.
  let vault: VaultFile | null = null;
  if ("names" in names) {
    try {
      vault = await loadVault(path, { onWarning: (w) => vaultLoadWarningNotice(io, w, json) });
    } catch {
      // Corrupt or newer than this build: the guard below cannot run, and
      // reset is the way out of that state too.
      vault = null;
    }
  }
  // A vault with no check marker and no entries accepts every passphrase, so
  // "it unlocked" would claim what was never tested -- the guard is skipped
  // there, and the reset yields a properly stamped empty vault instead.
  const guardable = vault !== null && vaultVerifiesPassphrases(vault);

  // `??`, not `||`: an empty test-hook passphrase means "none supplied"
  // (resolvePassphrase returns null for it), not "fall through to the env".
  const scripted = opts.passphrase ?? process.env.YAW_MCP_VAULT_PASSPHRASE ?? "";
  if (guardable && vault !== null && scripted.length > 0) {
    const verdict = await resetGuardVerdict(vault, scripted);
    if (typeof verdict === "object") return fail(guardFailedMessage("YAW_MCP_VAULT_PASSPHRASE", path, verdict.failed));
    if (verdict !== "wrong") return fail(alreadyOpensMessage(verdict, "YAW_MCP_VAULT_PASSPHRASE", path));
  }

  // Named once, before the preamble, so the path the user is shown is the
  // path the copy lands at (copyVaultAside only adds a suffix on EEXIST).
  const at = new Date();
  const envKeyed = opts.passphrase === undefined && (process.env.YAW_MCP_VAULT_PASSPHRASE ?? "").length > 0;

  if (!opts.force) {
    if (isInteractiveTTY(opts)) {
      const stdin = opts.io?.stdin ?? process.stdin;
      const stdout = opts.io?.stdout ?? process.stdout;
      stdout.write(resetPreamble(path, resetBackupPath(path, at), names, envKeyed));
      const answer = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, "Type RESET to continue: ", true);
      if (answer === CANCELLED) return cancelledResult(io, json, "reset");
      if (answer.trim().toLowerCase() !== "reset") return abortedResult(io, json, "reset");
    } else {
      return failResult(
        io,
        json,
        "reset",
        `refusing to reset the vault without confirmation and ${nonTTYEnds(opts)}.`,
        {
          exitCode: 2,
          detail:
            "Re-run with --force to reset it. The old vault is moved aside, not deleted, and every entry has to be set again.",
        },
      );
    }
  }

  const passphrase = await resolvePassphrase(opts, io, true, NEW_PASSPHRASE_LABELS);
  if (passphrase === CANCELLED) return cancelledResult(io, json, "reset");
  if (passphrase === NO_ECHO) {
    return fail(noEchoRefusal("New passphrase required.", "Set YAW_MCP_VAULT_PASSPHRASE instead."));
  }
  if (passphrase === null) {
    return fail(
      promptUnavailableMessage(opts, "New passphrase required (and must be confirmed).", "YAW_MCP_VAULT_PASSPHRASE"),
    );
  }

  // The scripted value was checked above and the resolved passphrase IS that
  // value when one was available, so only a TYPED one is derived here.
  if (guardable && vault !== null && scripted.length === 0) {
    const verdict = await resetGuardVerdict(vault, passphrase);
    if (typeof verdict === "object") return fail(guardFailedMessage("that passphrase", path, verdict.failed));
    if (verdict !== "wrong") return fail(alreadyOpensMessage(verdict, "that passphrase", path));
  }

  let fresh: VaultFile;
  try {
    fresh = await createEmptyVault(passphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`could not derive the new vault's key (${msg}) -- nothing was changed.`);
  }

  if (await vaultChangedSinceLoad(path, baseline)) return vaultChangedResult(io, json, "reset");

  let movedTo: string;
  try {
    movedTo = await copyVaultAside(path, at);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const cause = e.code ?? (err instanceof Error ? err.message : String(err));
    return fail(`could not copy the vault aside next to ${path} (${cause}) -- nothing was changed.`);
  }

  const cause = await trySaveVault(path, fresh);
  if (cause !== null) {
    // atomicWriteFile publishes by rename, so a failed write leaves the old
    // vault at `path` exactly as it was; the copy is the only surplus.
    const stray = await unlink(movedTo).then(
      () => "",
      () => ` A copy of it was left at ${movedTo}.`,
    );
    return fail(`could not write the new vault at ${path} (${cause}) -- the old vault is untouched.${stray}`);
  }

  if (json) {
    io.out(
      `${JSON.stringify({
        ok: true,
        path,
        moved_to: movedTo,
        entries: "names" in names ? names.names : null,
        unreadable: "unreadable" in names ? names.unreadable : null,
      })}\n`,
    );
  } else {
    io.out(`Moved the old vault to ${movedTo}. It still opens under its old passphrase, should that turn up.\n`);
    io.out(
      `Created an empty vault at ${path} under ${envKeyed ? "the passphrase in YAW_MCP_VAULT_PASSPHRASE" : "the new passphrase"}.\n`,
    );
    if ("names" in names) {
      const n = names.names.length;
      if (n === 0) io.out("The old vault held no entries.\n");
      else {
        io.out(`Entries to set again (${n}): ${names.names.join(", ")}\n`);
        io.out("  yaw-mcp secrets set <name>   for each\n");
      }
    } else {
      io.out(`Could not read the old vault's entry names (${names.unreadable}); the file is kept at ${movedTo}.\n`);
    }
  }
  resetVaultNudge(io, path, json, envKeyed);
  return { exitCode: 0 };
}

/** Render + filter the local secret-resolution audit log. Read-only; never
 *  decrypts anything (the log holds only names/timestamps). */
async function runSecretsAudit(opts: SecretsCommandOptions, io: SecretsIo): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  let events: AuditEvent[];
  try {
    events = await readAuditLog(
      {
        ...(opts.secretFilter !== undefined ? { secret: opts.secretFilter } : {}),
        ...(opts.serverFilter !== undefined ? { server: opts.serverFilter } : {}),
      },
      home,
    );
  } catch (err) {
    return failResult(io, opts.json, "audit", err instanceof Error ? err.message : String(err));
  }

  if (opts.json) {
    // One compact line, like list's and every other --json envelope.
    io.out(`${JSON.stringify({ ok: true, count: events.length, events })}\n`);
    return { exitCode: 0 };
  }

  if (events.length === 0) {
    io.out("No secret-resolution audit events recorded yet.\n");
    return { exitCode: 0 };
  }
  for (const e of events) {
    io.out(`${e.ts}  ${e.event === "injected" ? "injected" : "missing "}  ${e.server}  ${e.secret}\n`);
  }
  return { exitCode: 0 };
}
