// `yaw-mcp secrets <action>` -- manage the encrypted secret vault at
// ~/.yaw-mcp/secrets.json.
//
// Actions: set / get / list / remove / lock / rotate / audit. The vault
// is local-only; spawn-time substitution of ${secret:NAME} references in
// bundles.json env values lives in upstream.ts.
//
// Passphrase resolution (highest precedence first):
//   1. YAW_MCP_VAULT_PASSPHRASE env var
//   2. Interactive prompt on stdin (TTY only, --no-echo via raw mode)
//   3. Error -- no passphrase available

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { type AuditEvent, readAuditLog } from "./secrets-audit.js";
import {
  getSecret,
  listKeys,
  loadVault,
  lock,
  newVault,
  removeSecret,
  rotateVault,
  SECRET_NAME_RE,
  saveVault,
  setSecret,
  unlock,
  type VaultFile,
  vaultPath,
} from "./secrets-vault.js";

export const SECRETS_USAGE = `Usage: yaw-mcp secrets <action> [args]

  Manage your encrypted secret vault at ~/.yaw-mcp/secrets.json.

Actions:
  set <name>              Store a secret. Reads value from stdin (one
                          line, no echo). Override with --value <v> or
                          --stdin (raw, multi-line) for scripting.
  get <name>              Decrypt and print one secret value to stdout.
                          NOTE: this prints the secret in CLEARTEXT (with
                          or without --json). Redirect to a file or pipe
                          to a consumer; avoid running it interactively so
                          the value does not land in terminal scrollback.
  list                    Show vault entry names (values stay encrypted).
  remove <name>           Delete an entry.
  lock                    Forget the passphrase cached in THIS process's
                          memory. The cache never outlives the process, so
                          for a one-shot CLI run this is close to a no-op --
                          it matters for a long-running yaw-mcp server. It
                          does NOT change the vault on disk (which only ever
                          holds ciphertext) and it does NOT revoke anything.
  rotate                  Re-encrypt every entry under a NEW passphrase
                          (fresh salt + derived key). Re-wraps the
                          ENCRYPTION, NOT the underlying token values -- a
                          leaked token is still leaked; rotate it at its
                          source. Reads the current passphrase, then the
                          new one (env YAW_MCP_VAULT_PASSPHRASE_NEW or a
                          confirm-twice TTY prompt).
  audit [--secret NAME] [--server NS]
                          Show the local secret-resolution audit trail
                          (~/.yaw-mcp/secrets-audit.log): which secret
                          NAMES were injected into (or missing for) which
                          server, and when. Never shows a value.

Flags:
  --json                  Machine-readable output (where applicable).
  --value <v>             Inline secret value (set only). Beware shell
                          history -- prefer the default stdin prompt.
  --stdin                 Read the secret from raw stdin (set only).
  --secret <name>         (audit only) Filter to one secret name.
  --server <ns>           (audit only) Filter to one server namespace.

Passphrase:
  Set YAW_MCP_VAULT_PASSPHRASE in the env, or you will be prompted on
  the controlling TTY. The passphrase derives the encryption key via
  scrypt and is cached in memory for the lifetime of this yaw-mcp
  process; the on-disk vault only ever holds ciphertext. For rotate, the
  NEW passphrase comes from YAW_MCP_VAULT_PASSPHRASE_NEW (or a TTY
  confirm-twice prompt).`;

export interface SecretsCommandOptions {
  action?: "set" | "get" | "list" | "remove" | "lock" | "rotate" | "audit";
  name?: string;
  value?: string;
  fromStdin?: boolean;
  json?: boolean;
  /** For `audit`: filter to one secret name. */
  secretFilter?: string;
  /** For `audit`: filter to one server namespace. */
  serverFilter?: string;
  /** Test hooks. */
  home?: string;
  passphrase?: string;
  /** For `rotate`: the NEW passphrase (overrides env + TTY prompt in tests). */
  newPassphrase?: string;
  io?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
}

export function parseSecretsArgs(
  argv: string[],
): { ok: true; options: SecretsCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: SecretsCommandOptions = {};
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
    if (a === "--value") {
      const v = argv[++i];
      // Reject a following flag (e.g. `secrets set NAME --value --json`)
      // instead of storing "--json" as the secret. For a value that really
      // begins with a dash, use `--stdin` (which reads the raw value).
      if (v === undefined || v.startsWith("-")) {
        return {
          ok: false,
          error: `yaw-mcp secrets: --value requires a value (for a dash-leading value use --stdin)\n\n${SECRETS_USAGE}`,
        };
      }
      opts.value = v;
      continue;
    }
    if (a === "--secret") {
      const v = argv[++i];
      if (v === undefined)
        return { ok: false, error: `yaw-mcp secrets: --secret requires a value\n\n${SECRETS_USAGE}` };
      opts.secretFilter = v;
      continue;
    }
    if (a === "--server") {
      const v = argv[++i];
      if (v === undefined)
        return { ok: false, error: `yaw-mcp secrets: --server requires a value\n\n${SECRETS_USAGE}` };
      opts.serverFilter = v;
      continue;
    }
    if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp secrets: unknown flag "${a}"\n\n${SECRETS_USAGE}` };
    }
    if (!opts.action) {
      if (
        a !== "set" &&
        a !== "get" &&
        a !== "list" &&
        a !== "remove" &&
        a !== "lock" &&
        a !== "rotate" &&
        a !== "audit"
      ) {
        return { ok: false, error: `yaw-mcp secrets: unknown action "${a}"\n\n${SECRETS_USAGE}` };
      }
      opts.action = a;
      continue;
    }
    if (!opts.name) {
      opts.name = a;
      continue;
    }
    return { ok: false, error: `yaw-mcp secrets: unexpected positional argument "${a}"\n\n${SECRETS_USAGE}` };
  }
  if (!opts.action) return { ok: false, error: `yaw-mcp secrets: missing action\n\n${SECRETS_USAGE}` };
  if ((opts.action === "set" || opts.action === "get" || opts.action === "remove") && !opts.name) {
    return { ok: false, error: `yaw-mcp secrets ${opts.action}: <name> is required\n\n${SECRETS_USAGE}` };
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
    return {
      ok: false,
      error: `yaw-mcp secrets set: invalid secret name "${opts.name}" -- use letters, digits, "_", "." or "-" only; other characters can never be referenced as \${secret:NAME}\n\n${SECRETS_USAGE}`,
    };
  }
  return { ok: true, options: opts };
}

export interface SecretsCommandResult {
  exitCode: number;
}

/** Wrap loadVault so a corrupt or unreadable on-disk vault surfaces a
 *  named, actionable message to the user rather than crashing the
 *  process. ENOENT still resolves to null (vault absent) -- only real
 *  errors throw out of loadVault. We catch them here and translate to
 *  a structured result the caller can return as exitCode:1. */
async function safeLoadVault(
  path: string,
  io: { out: (s: string) => void; err: (s: string) => void },
  json: boolean | undefined,
  action: string,
): Promise<{ ok: true; vault: VaultFile | null } | { ok: false; result: SecretsCommandResult }> {
  try {
    return { ok: true, vault: await loadVault(path) };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Detect the corrupt-entry case and emit an actionable hint. NOTE:
    // loadVault validates EVERY entry, so `secrets remove <name>` cannot
    // clear it either -- the fix has to happen in the file itself.
    const corruptMatch = /vault corrupt at entry (.+)$/.exec(raw);
    const name = corruptMatch?.[1];
    const msg = name
      ? `secret entry ${name} is corrupt, and every secrets command fails until it is gone. Delete the "${name}" key from ${path} by hand (or delete that file to start the vault over), then re-add it with \`yaw-mcp secrets set ${name}\`.`
      : raw;
    if (json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets${action ? ` ${action}` : ""}: ${msg}\n`);
    return { ok: false, result: { exitCode: 1 } };
  }
}

/** Returned by the passphrase readers when the user hits ^C at a prompt.
 *  Distinct from "" (empty submission -> re-prompt) and from null (no
 *  passphrase obtainable). The reader NEVER calls process.exit(): the io
 *  streams are injectable, so a test or an embedder must not be able to
 *  kill the host process by feeding it a 0x03 byte. runSecrets turns this
 *  into exitCode 130 (128 + SIGINT) and the CLI entry point owns the exit. */
const CANCELLED: unique symbol = Symbol("yaw-mcp:passphrase-cancelled");
type Cancelled = typeof CANCELLED;

/** Standard result for a ^C at any passphrase prompt. */
function cancelledResult(
  io: { out: (s: string) => void; err: (s: string) => void },
  json: boolean | undefined,
): SecretsCommandResult {
  const msg = "Cancelled.";
  if (json) io.err(`${JSON.stringify({ ok: false, error: msg, cancelled: true })}\n`);
  else io.err(`yaw-mcp secrets: ${msg}\n`);
  return { exitCode: 130 };
}

/** Read the passphrase. Env var wins; falls back to a stdin prompt
 *  that disables terminal echo via raw mode. Returns null when no
 *  passphrase can be obtained (non-TTY + no env), or CANCELLED when the
 *  user hit ^C at the prompt. */
async function resolvePassphrase(opts: SecretsCommandOptions): Promise<string | null | Cancelled> {
  if (opts.passphrase !== undefined) return opts.passphrase.length > 0 ? opts.passphrase : null;
  const fromEnv = process.env.YAW_MCP_VAULT_PASSPHRASE;
  // An empty env var ("") is treated the same as absent -- deriving a key
  // from "" would otherwise silently unlock any vault.
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    if (fromEnv.length < MIN_PASSPHRASE_WARN_LEN) {
      const stderr = opts.io?.stderr ?? process.stderr;
      stderr.write(
        `yaw-mcp secrets: warning -- YAW_MCP_VAULT_PASSPHRASE is shorter than ${MIN_PASSPHRASE_WARN_LEN} characters; consider a longer passphrase.\n`,
      );
    }
    return fromEnv;
  }
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  const isTTY = (stdin as { isTTY?: boolean }).isTTY === true && (stdout as { isTTY?: boolean }).isTTY === true;
  if (!isTTY) return null;
  // Reject an empty passphrase (bare Enter / EOF with nothing typed):
  // deriving a key from "" would otherwise unlock any vault. Re-prompt up
  // to a few times, then give up so we never spin forever on a closed pipe.
  for (let attempt = 0; attempt < MAX_PASSPHRASE_PROMPTS; attempt++) {
    const entered = await readPassphraseFromTTY(stdin as NodeJS.ReadStream, stdout);
    if (entered === CANCELLED) return CANCELLED;
    if (entered.length > 0) return entered;
    stdout.write("Passphrase cannot be empty.\n");
  }
  return null;
}

/** Resolve the NEW passphrase for `rotate`. Precedence:
 *    1. opts.newPassphrase (test hook)
 *    2. YAW_MCP_VAULT_PASSPHRASE_NEW env var
 *    3. TTY confirm-twice prompt (must match; non-empty)
 *  Returns null when none can be obtained (non-TTY + no env) or the two
 *  TTY entries disagree after the allowed prompts, and CANCELLED when the
 *  user hit ^C at either prompt. */
async function resolveNewPassphrase(opts: SecretsCommandOptions): Promise<string | null | Cancelled> {
  if (opts.newPassphrase !== undefined) return opts.newPassphrase.length > 0 ? opts.newPassphrase : null;
  const fromEnv = process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    if (fromEnv.length < MIN_PASSPHRASE_WARN_LEN) {
      const stderr = opts.io?.stderr ?? process.stderr;
      stderr.write(
        `yaw-mcp secrets: warning -- the new passphrase is shorter than ${MIN_PASSPHRASE_WARN_LEN} characters; consider a longer passphrase.\n`,
      );
    }
    return fromEnv;
  }
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  const isTTY = (stdin as { isTTY?: boolean }).isTTY === true && (stdout as { isTTY?: boolean }).isTTY === true;
  if (!isTTY) return null;
  for (let attempt = 0; attempt < MAX_PASSPHRASE_PROMPTS; attempt++) {
    const first = await readPassphraseFromTTY(stdin as NodeJS.ReadStream, stdout, "New vault passphrase: ");
    if (first === CANCELLED) return CANCELLED;
    if (first.length === 0) {
      stdout.write("Passphrase cannot be empty.\n");
      continue;
    }
    const second = await readPassphraseFromTTY(stdin as NodeJS.ReadStream, stdout, "Confirm new passphrase: ");
    if (second === CANCELLED) return CANCELLED;
    if (first === second) return first;
    stdout.write("Passphrases did not match. Try again.\n");
  }
  return null;
}

/** Cap re-prompts for an empty passphrase so a closed/EOF stdin can't
 *  loop forever. */
const MAX_PASSPHRASE_PROMPTS = 3;

/** Soft floor for a passphrase: shorter than this triggers a stderr
 *  warning (never a hard block). */
const MIN_PASSPHRASE_WARN_LEN = 12;

/** Control bytes the raw-mode reader reacts to. Spelled as escapes: the
 *  literal bytes are invisible in an editor and get mangled by tooling. */
const CTRL_C = "\x03"; // ETX -- cancel the whole command
const CTRL_D = "\x04"; // EOT -- cancel this entry (caller re-prompts)
const DEL = "\x7f"; // what most terminals send for Backspace

function readPassphraseFromTTY(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt = "Vault passphrase: ",
): Promise<string | Cancelled> {
  stdout.write(prompt);
  return new Promise<string | Cancelled>((resolve) => {
    const chunks: string[] = [];
    const wasRaw = stdin.isRaw === true;
    try {
      stdin.setRawMode?.(true);
    } catch {
      // not a TTY, fall through to line-buffered read
    }
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
    // Hoisted declaration so `finish` above can name it.
    function onData(chunk: string): void {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          finish(chunks.join(""));
          return;
        }
        if (ch === CTRL_D) {
          // Cancel this entry. Resolve to "" so the caller treats it as an
          // empty submission and re-prompts -- never a line terminator that
          // would submit a partial passphrase.
          finish("");
          return;
        }
        if (ch === CTRL_C) {
          // Cancel the command. We deliberately do NOT process.exit() here:
          // the io streams are injectable, so a fed 0x03 must not be able to
          // kill the host process. The caller maps CANCELLED to exit 130.
          finish(CANCELLED);
          return;
        }
        if (ch === "\b" || ch === DEL) {
          if (chunks.length > 0) chunks.pop();
          continue;
        }
        chunks.push(ch);
      }
    }
    stdin.on("data", onData);
  });
}

async function readStdinValue(io?: SecretsCommandOptions["io"], forceRaw?: boolean): Promise<string | Cancelled> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const isTTY = (stdin as { isTTY?: boolean }).isTTY === true;
  if (isTTY && !forceRaw) {
    stdout.write("Secret value: ");
    return readPassphraseFromTTY(stdin as NodeJS.ReadStream, stdout);
  }
  // Piped stdin -- read all and trim trailing newline.
  const chunks: string[] = [];
  stdin.setEncoding("utf8");
  for await (const chunk of stdin as unknown as AsyncIterable<string>) chunks.push(chunk);
  return chunks.join("").replace(/\r?\n$/, "");
}

export async function runSecrets(
  opts: SecretsCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);

  // Lock is the only action that does not need a passphrase.
  if (opts.action === "lock") {
    lock();
    if (opts.json) io.out(`${JSON.stringify({ ok: true, locked: true })}\n`);
    else io.out("Vault locked. Passphrase cache cleared.\n");
    return { exitCode: 0 };
  }

  // rotate resolves BOTH passphrases itself (current + new), so it runs
  // ahead of the shared single-passphrase path below.
  if (opts.action === "rotate") {
    return await runSecretsRotate(opts, io);
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
    const keys = vault ? listKeys(vault) : [];
    if (opts.json) io.out(`${JSON.stringify({ ok: true, vault: existsSync(path), keys }, null, 2)}\n`);
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
  const loaded = await safeLoadVault(path, io, opts.json, opts.action ?? "");
  if (!loaded.ok) return loaded.result;

  // Short-circuit get/remove when the vault is missing or the entry
  // doesn't exist -- avoids prompting for a passphrase and paying the
  // scrypt derivation just to say "not found".
  if (opts.action === "get" || opts.action === "remove") {
    const name = opts.name as string;
    // Object.hasOwn, not `in`: entries comes from JSON.parse and inherits
    // Object.prototype, so `secrets get toString` would otherwise pass.
    if (!loaded.vault || !Object.hasOwn(loaded.vault.entries, name)) {
      const msg = `No secret named "${name}" in the vault.`;
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n`);
      return { exitCode: 1 };
    }
  }

  // Remaining actions all need the vault + passphrase.
  let vault = loaded.vault ?? newVault();
  const isFresh = !existsSync(path);

  const passphrase = await resolvePassphrase(opts);
  if (passphrase === CANCELLED) return cancelledResult(io, opts.json);
  if (passphrase === null) {
    const msg = "Passphrase required. Set YAW_MCP_VAULT_PASSPHRASE or run from a TTY so we can prompt.";
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets: ${msg}\n`);
    return { exitCode: 1 };
  }

  let key: Buffer;
  try {
    key = await unlock(vault, passphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets: ${msg}\n`);
    return { exitCode: 1 };
  }

  // ----- set ------------------------------------------------------------
  if (opts.action === "set") {
    const name = opts.name as string;
    let value: string;
    if (opts.value !== undefined) value = opts.value;
    else {
      const entered = await readStdinValue(opts.io, opts.fromStdin);
      if (entered === CANCELLED) return cancelledResult(io, opts.json);
      value = entered;
    }
    if (!value) {
      const msg = "Secret value cannot be empty.";
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n`);
      return { exitCode: 1 };
    }
    try {
      // setSecret rejects a name no ${secret:NAME} reference could ever
      // address (spaces, colons, braces) -- surface that as a normal CLI
      // error instead of an unhandled rejection. For the CLI path
      // parseSecretsArgs already rejected it before any prompt; this is
      // the backstop for programmatic callers of runSecrets.
      vault = setSecret(vault, key, name, value);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets set: ${msg}\n`);
      return { exitCode: 1 };
    }
    // atomicWriteFile mkdirs the target dir, so no ensureVaultDir needed.
    await saveVault(path, vault);
    if (opts.json) io.out(`${JSON.stringify({ ok: true, name, fresh_vault: isFresh })}\n`);
    else io.out(`${isFresh ? "Created vault and " : ""}Stored secret "${name}".\n`);
    return { exitCode: 0 };
  }

  // ----- get ------------------------------------------------------------
  if (opts.action === "get") {
    const name = opts.name as string;
    try {
      const value = getSecret(vault, key, name);
      if (value === null) {
        const msg = `No secret named "${name}" in the vault.`;
        if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
        else io.err(`yaw-mcp secrets: ${msg}\n`);
        return { exitCode: 1 };
      }
      // Warn (to stderr, never stdout -- keeps the value pipeable) when the
      // caller is interactive: `get` prints cleartext, so an interactive run
      // scrolls a secret into terminal scrollback. Skipped for piped/redirected
      // stdout, which is the intended consumption path.
      const outStream = opts.io?.stdout ?? process.stdout;
      if ((outStream as { isTTY?: boolean }).isTTY === true) {
        const stderr = opts.io?.stderr ?? process.stderr;
        stderr.write(
          `yaw-mcp secrets: warning -- printing "${name}" in cleartext to your terminal; it will remain in scrollback.\n`,
        );
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
      const msg = err instanceof Error ? err.message : String(err);
      const hint = `Entry "${name}" failed to decrypt: it is corrupt, or it was written under a different passphrase than the rest of the vault. Remove it and set it again.`;
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg, hint })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n  ${hint}\n`);
      return { exitCode: 1 };
    }
  }

  // ----- remove ---------------------------------------------------------
  if (opts.action === "remove") {
    const name = opts.name as string;
    if (!Object.hasOwn(vault.entries, name)) {
      const msg = `No secret named "${name}" in the vault.`;
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n`);
      return { exitCode: 1 };
    }
    vault = removeSecret(vault, name);
    await saveVault(path, vault);
    if (opts.json) io.out(`${JSON.stringify({ ok: true, removed: name })}\n`);
    else io.out(`Removed "${name}".\n`);
    return { exitCode: 0 };
  }

  // Should not reach here -- parseSecretsArgs guards the action set.
  io.err(`yaw-mcp secrets: unknown action ${opts.action}\n`);
  return { exitCode: 2 };
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
async function runSecretsRotate(
  opts: SecretsCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void },
): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);

  // safeLoadVault, not raw loadVault: a corrupt vault must come back as the
  // same {ok:false} envelope the sibling actions emit (and stay JSON under
  // --json) instead of escaping as a rejection the dispatcher formats.
  const loaded = await safeLoadVault(path, io, opts.json, "rotate");
  if (!loaded.ok) return loaded.result;
  const vault = loaded.vault;
  if (!vault) {
    const msg = `No vault at ${path} to rotate. Run \`yaw-mcp secrets set <name>\` first.`;
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    return { exitCode: 1 };
  }

  const currentPassphrase = await resolvePassphrase(opts);
  if (currentPassphrase === CANCELLED) return cancelledResult(io, opts.json);
  if (currentPassphrase === null) {
    const msg = "Current passphrase required. Set YAW_MCP_VAULT_PASSPHRASE or run from a TTY so we can prompt.";
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    return { exitCode: 1 };
  }

  let oldKey: Buffer;
  try {
    oldKey = await unlock(vault, currentPassphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    return { exitCode: 1 };
  }

  const newPassphrase = await resolveNewPassphrase(opts);
  if (newPassphrase === CANCELLED) return cancelledResult(io, opts.json);
  if (newPassphrase === null) {
    const msg =
      "New passphrase required (and must be confirmed). Set YAW_MCP_VAULT_PASSPHRASE_NEW or run from a TTY so we can prompt.";
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    return { exitCode: 1 };
  }

  let rotated: VaultFile;
  try {
    // rotateVault decrypts EVERY entry first; if any fails it throws
    // before re-encrypting, so the on-disk vault stays untouched.
    rotated = await rotateVault(vault, oldKey, newPassphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    // On-disk vault is untouched by definition (we never reached save).
    lock();
    return { exitCode: 1 };
  }

  await saveVault(path, rotated);
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

/** Render + filter the local secret-resolution audit log. Read-only; never
 *  decrypts anything (the log holds only names/timestamps). */
async function runSecretsAudit(
  opts: SecretsCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void },
): Promise<SecretsCommandResult> {
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
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets audit: ${msg}\n`);
    return { exitCode: 1 };
  }

  if (opts.json) {
    io.out(`${JSON.stringify({ ok: true, count: events.length, events }, null, 2)}\n`);
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

// Expose for vault file path tests
export function _vaultPathForHome(home: string): string {
  return vaultPath(home);
}

// Re-export for tests + sibling modules
export type { VaultFile } from "./secrets-vault.js";
