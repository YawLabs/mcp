// `yaw-mcp secrets <action>` -- manage the encrypted secret vault at
// ~/.yaw-mcp/secrets.json.
//
// Phase 6b ships: set / get / list / remove / lock.
// Phase 6c will add: sync push|pull (to mcp_secrets backend), spawn-
// time substitution of ${secret:NAME} references in bundles.json env
// values.
//
// Passphrase resolution (highest precedence first):
//   1. YAW_MCP_VAULT_PASSPHRASE env var
//   2. Interactive prompt on stdin (TTY only, --no-echo via raw mode)
//   3. Error -- no passphrase available

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { CONFIG_DIRNAME } from "./paths.js";
import { type AuditEvent, readAuditLog } from "./secrets-audit.js";
import {
  getSecret,
  listKeys,
  loadVault,
  lock,
  newVault,
  removeSecret,
  rotateVault,
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
  lock                    Clear the in-process passphrase cache.
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
  /** For `pull`: overwrite even when the local vault salt differs from remote. */
  force?: boolean;
  /** For `push`: overwrite even when the remote vault salt differs from local
   *  (i.e. team is rotating the vault passphrase). */
  replace?: boolean;
  /** For `rotate`: after re-encrypting, push the new blob to mcp_secrets. */
  push?: boolean;
  /** For `audit`: filter to one secret name. */
  secretFilter?: string;
  /** For `audit`: filter to one server namespace. */
  serverFilter?: string;
  /** Test hooks. */
  home?: string;
  passphrase?: string;
  /** For `rotate`: the NEW passphrase (overrides env + TTY prompt in tests). */
  newPassphrase?: string;
  baseUrl?: string;
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
    // Detect the corrupt-entry case and emit the requested actionable hint.
    const corruptMatch = /vault corrupt at entry (.+)$/.exec(raw);
    const msg = corruptMatch
      ? `secret entry ${corruptMatch[1]} is corrupt; remove it or run \`yaw-mcp secrets repair\``
      : raw;
    if (json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets${action ? ` ${action}` : ""}: ${msg}\n`);
    return { ok: false, result: { exitCode: 1 } };
  }
}

/** Read the passphrase. Env var wins; falls back to a stdin prompt
 *  that disables terminal echo via raw mode. Returns null when no
 *  passphrase can be obtained (non-TTY + no env). */
async function resolvePassphrase(opts: SecretsCommandOptions): Promise<string | null> {
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
 *  TTY entries disagree after the allowed prompts. */
async function resolveNewPassphrase(opts: SecretsCommandOptions): Promise<string | null> {
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
    if (first.length === 0) {
      stdout.write("Passphrase cannot be empty.\n");
      continue;
    }
    const second = await readPassphraseFromTTY(stdin as NodeJS.ReadStream, stdout, "Confirm new passphrase: ");
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

function readPassphraseFromTTY(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt = "Vault passphrase: ",
): Promise<string> {
  stdout.write(prompt);
  return new Promise<string>((resolve) => {
    const chunks: string[] = [];
    const wasRaw = stdin.isRaw === true;
    try {
      stdin.setRawMode?.(true);
    } catch {
      // not a TTY, fall through to line-buffered read
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          stdout.write("\n");
          stdin.removeListener("data", onData);
          try {
            stdin.setRawMode?.(wasRaw);
          } catch {
            // ignore
          }
          stdin.pause();
          resolve(chunks.join(""));
          return;
        }
        if (ch === "") {
          // ^D (EOT): cancel this entry. Resolve to "" so resolvePassphrase
          // treats it as an empty submission and re-prompts -- never a line
          // terminator that would submit a partial passphrase.
          stdout.write("\n");
          stdin.removeListener("data", onData);
          try {
            stdin.setRawMode?.(wasRaw);
          } catch {
            // ignore
          }
          stdin.pause();
          resolve("");
          return;
        }
        if (ch === "") {
          // ^C
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\b" || ch === "") {
          if (chunks.length > 0) chunks.pop();
          continue;
        }
        chunks.push(ch);
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdinValue(io?: SecretsCommandOptions["io"], forceRaw?: boolean): Promise<string> {
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

  // Push + pull use the team-sync cookie (not the vault passphrase).
  // The vault is shipped opaque to the server -- ciphertext + IV +
  // auth tag + salt only; the server never sees plaintext and never
  // derives the key. So sync push/pull don't need the passphrase
  // either; they just shuffle the encrypted blob between local and
  // remote.
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

  // Short-circuit get/remove when the vault is missing or the entry
  // doesn't exist -- avoids prompting for a passphrase and paying the
  // scrypt derivation just to say "not found".
  if (opts.action === "get" || opts.action === "remove") {
    const loaded = await safeLoadVault(path, io, opts.json, opts.action);
    if (!loaded.ok) return loaded.result;
    const existingVault = loaded.vault;
    if (!existingVault || !((opts.name as string) in existingVault.entries)) {
      const name = opts.name as string;
      const msg = `No secret named "${name}" in the vault.`;
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n`);
      return { exitCode: 1 };
    }
  }

  // Remaining actions all need the vault + passphrase.
  const loadedForMutate = await safeLoadVault(path, io, opts.json, opts.action ?? "");
  if (!loadedForMutate.ok) return loadedForMutate.result;
  let vault = loadedForMutate.vault ?? newVault();
  const isFresh = !existsSync(path);

  const passphrase = await resolvePassphrase(opts);
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
    else value = await readStdinValue(opts.io, opts.fromStdin);
    if (!value) {
      const msg = "Secret value cannot be empty.";
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n`);
      return { exitCode: 1 };
    }
    vault = setSecret(vault, key, name, value);
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
      const msg = err instanceof Error ? err.message : String(err);
      const hint = "Wrong passphrase, or the vault entry is corrupt.";
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg, hint })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n  ${hint}\n`);
      return { exitCode: 1 };
    }
  }

  // ----- remove ---------------------------------------------------------
  if (opts.action === "remove") {
    const name = opts.name as string;
    if (!(name in vault.entries)) {
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

const MCP_SECRETS_RESOURCE = "mcp_secrets";



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
 *   6. If --push and a session exists, push the re-encrypted blob.
 */
async function runSecretsRotate(
  opts: SecretsCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void },
): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);

  const vault = await loadVault(path);
  if (!vault) {
    const msg = `No vault at ${path} to rotate. Run \`yaw-mcp secrets set <name>\` first.`;
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    return { exitCode: 1 };
  }

  const currentPassphrase = await resolvePassphrase(opts);
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

  // The optional --push step was removed with the Yaw Team surface
  // (2026-07-21); rotation is a purely local re-encryption now.
  if (opts.json) {
    io.out(
      `${JSON.stringify({ ok: true, rotated: true, secret_count: count })}\n`,
    );
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

// Silence unused dir-creator warning
void CONFIG_DIRNAME;

// Re-export for tests + sibling modules
export type { VaultFile } from "./secrets-vault.js";
