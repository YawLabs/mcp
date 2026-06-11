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
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { CONFIG_DIRNAME } from "./paths.js";
import {
  type VaultFile,
  getSecret,
  listKeys,
  loadVault,
  lock,
  newVault,
  removeSecret,
  saveVault,
  setSecret,
  unlock,
  vaultPath,
} from "./secrets-vault.js";
import { TeamSyncAuthError, TeamSyncStaleVersionError, getResource, getSession, putResource } from "./team-sync.js";

export const SECRETS_USAGE = `Usage: yaw-mcp secrets <action> [args]

  Manage your encrypted secret vault at ~/.yaw-mcp/secrets.json.

Actions:
  set <name>              Store a secret. Reads value from stdin (one
                          line, no echo). Override with --value <v> or
                          --stdin (raw, multi-line) for scripting.
  get <name>              Decrypt and print one secret value to stdout.
  list                    Show vault entry names (values stay encrypted).
  remove <name>           Delete an entry.
  lock                    Clear the in-process passphrase cache.
  push                    Upload the vault (encrypted; server gets only
                          ciphertext) to the mcp_secrets team-resource.
                          Requires \`yaw-mcp login\` first.
  pull                    Download the vault from mcp_secrets and write
                          it locally. Overwrites local vault. Requires
                          \`yaw-mcp login\` first. Refuses when the local
                          vault has a different salt (different passphrase
                          lineage) unless --force is passed.

Flags:
  --json                  Machine-readable output (where applicable).
  --value <v>             Inline secret value (set only). Beware shell
                          history -- prefer the default stdin prompt.
  --stdin                 Read the secret from raw stdin (set only).
  --force                 (pull only) Overwrite even when the local vault
                          salt differs from the remote. Back up first.

Passphrase:
  Set YAW_MCP_VAULT_PASSPHRASE in the env, or you will be prompted on
  the controlling TTY. The passphrase derives the encryption key via
  scrypt and is cached in memory for the lifetime of this yaw-mcp
  process; the on-disk vault only ever holds ciphertext.`;

export interface SecretsCommandOptions {
  action?: "set" | "get" | "list" | "remove" | "lock" | "push" | "pull";
  name?: string;
  value?: string;
  fromStdin?: boolean;
  json?: boolean;
  /** For `pull`: overwrite even when the local vault salt differs from remote. */
  force?: boolean;
  /** Test hooks. */
  home?: string;
  passphrase?: string;
  baseUrl?: string;
  io?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
}

export function parseSecretsArgs(
  argv: string[],
): { ok: true; options: SecretsCommandOptions } | { ok: false; error: string } {
  const opts: SecretsCommandOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: false, error: SECRETS_USAGE };
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
      if (v === undefined) return { ok: false, error: "yaw-mcp secrets: --value requires a value\n\n" + SECRETS_USAGE };
      opts.value = v;
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
        a !== "push" &&
        a !== "pull"
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
  if (!opts.action) return { ok: false, error: "yaw-mcp secrets: missing action\n\n" + SECRETS_USAGE };
  if ((opts.action === "set" || opts.action === "get" || opts.action === "remove") && !opts.name) {
    return { ok: false, error: `yaw-mcp secrets ${opts.action}: <name> is required\n\n${SECRETS_USAGE}` };
  }
  return { ok: true, options: opts };
}

export interface SecretsCommandResult {
  exitCode: number;
}

/** Read the passphrase. Env var wins; falls back to a stdin prompt
 *  that disables terminal echo via raw mode. Returns null when no
 *  passphrase can be obtained (non-TTY + no env). */
async function resolvePassphrase(opts: SecretsCommandOptions): Promise<string | null> {
  if (opts.passphrase !== undefined) return opts.passphrase;
  const fromEnv = process.env.YAW_MCP_VAULT_PASSPHRASE;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  const isTTY = (stdin as { isTTY?: boolean }).isTTY === true && (stdout as { isTTY?: boolean }).isTTY === true;
  if (!isTTY) return null;
  return readPassphraseFromTTY(stdin as NodeJS.ReadStream, stdout);
}

function readPassphraseFromTTY(stdin: NodeJS.ReadStream, stdout: NodeJS.WritableStream): Promise<string> {
  stdout.write("Vault passphrase: ");
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
        if (ch === "\n" || ch === "\r" || ch === "") {
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

async function readStdinValue(io?: SecretsCommandOptions["io"]): Promise<string> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const isTTY = (stdin as { isTTY?: boolean }).isTTY === true;
  if (isTTY) {
    stdout.write("Secret value: ");
    return readPassphraseFromTTY(stdin as NodeJS.ReadStream, stdout);
  }
  // Piped stdin -- read all and trim trailing newline.
  const chunks: string[] = [];
  stdin.setEncoding("utf8");
  for await (const chunk of stdin as unknown as AsyncIterable<string>) chunks.push(chunk);
  return chunks.join("").replace(/\r?\n$/, "");
}

async function ensureVaultDir(path: string): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
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
  if (opts.action === "push") {
    return await runSecretsPush(opts, io);
  }
  if (opts.action === "pull") {
    return await runSecretsPull(opts, io);
  }

  if (opts.action === "list") {
    const vault = await loadVault(path);
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

  // Remaining actions all need the vault + passphrase.
  let vault = (await loadVault(path)) ?? newVault();
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
    else value = await readStdinValue(opts.io);
    if (!value) {
      const msg = "Secret value cannot be empty.";
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n`);
      return { exitCode: 1 };
    }
    vault = setSecret(vault, key, name, value);
    await ensureVaultDir(path);
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

async function runSecretsPush(
  opts: SecretsCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void },
): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);
  const session = await getSession({ home, baseUrl: opts.baseUrl });
  if (!session) {
    const msg = "Not signed in. Run `yaw-mcp login --key <license-key>` first.";
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets push: ${msg}\n`);
    return { exitCode: 1 };
  }
  const vault = await loadVault(path);
  if (!vault) {
    const msg = `No local vault at ${path} to push. Run \`yaw-mcp secrets set <name>\` first.`;
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets push: ${msg}\n`);
    return { exitCode: 1 };
  }
  try {
    // Learn current remote version so the optimistic-concurrency PUT
    // is accepted. One extra round-trip per push -- acceptable for a
    // manual command.
    const remote = await getResource<VaultFile>(MCP_SECRETS_RESOURCE, { home, baseUrl: opts.baseUrl });
    const result = await putResource<VaultFile>(MCP_SECRETS_RESOURCE, remote.version, vault, {
      home,
      baseUrl: opts.baseUrl,
    });
    const count = Object.keys(vault.entries).length;
    if (opts.json) {
      io.out(`${JSON.stringify({ ok: true, secret_count: count, new_version: result.version }, null, 2)}\n`);
    } else {
      io.out(
        `Pushed ${count} secret${count === 1 ? "" : "s"} (encrypted, server-opaque) -> mcp_secrets v${result.version}.\n`,
      );
    }
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof TeamSyncStaleVersionError) {
      const hint = `Remote vault is at v${err.currentVersion}; pull and reconcile before pushing.`;
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: hint, currentVersion: err.currentVersion })}\n`);
      else io.err(`yaw-mcp secrets push: ${hint}\n`);
      return { exitCode: 1 };
    }
    if (err instanceof TeamSyncAuthError) {
      const msg = "Session expired. Run `yaw-mcp login --key <license-key>` again.";
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets push: ${msg}\n`);
      return { exitCode: 1 };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: message })}\n`);
    else io.err(`yaw-mcp secrets push: ${message}\n`);
    return { exitCode: 1 };
  }
}

async function runSecretsPull(
  opts: SecretsCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void },
): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);
  const session = await getSession({ home, baseUrl: opts.baseUrl });
  if (!session) {
    const msg = "Not signed in. Run `yaw-mcp login --key <license-key>` first.";
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets pull: ${msg}\n`);
    return { exitCode: 1 };
  }
  try {
    const remote = await getResource<VaultFile>(MCP_SECRETS_RESOURCE, { home, baseUrl: opts.baseUrl });
    // Treat remote as empty when: no data, no salt, OR entries present but
    // empty ({}) with no salt -- an entries:{} + missing/empty salt shape is
    // an uninitialised stub, not a real vault worth overwriting local data.
    const remoteEntries = remote.data?.entries;
    const remoteHasEntries =
      remoteEntries !== undefined &&
      remoteEntries !== null &&
      typeof remoteEntries === "object" &&
      Object.keys(remoteEntries).length > 0;
    if (!remote.data || !remote.data.salt || !remoteHasEntries) {
      const msg = "Remote mcp_secrets is empty. Push from this machine to seed it.";
      if (opts.json) io.out(`${JSON.stringify({ ok: true, empty: true })}\n`);
      else io.out(`${msg}\n`);
      return { exitCode: 0 };
    }
    // Salt-conflict guard: if a non-empty local vault exists whose salt
    // differs from the remote's, refuse -- the two vaults were derived from
    // different passphrases and overwriting would make local secrets
    // irrecoverable.  The user must back up and pass --force to proceed.
    const localVault = await loadVault(path);
    const localHasEntries = localVault !== null && Object.keys(localVault.entries).length > 0;
    if (localHasEntries && localVault.salt !== remote.data.salt && !opts.force) {
      const msg =
        `Local vault at ${path} has a different salt than the remote (different passphrase lineage). ` +
        `Back up ${path} first, then re-run with --force to overwrite.`;
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets pull: ${msg}\n`);
      return { exitCode: 1 };
    }
    await ensureVaultDir(path);
    await saveVault(path, remote.data);
    // Invalidate the in-process key cache -- the salt may have changed,
    // so the next operation must re-derive against the (possibly
    // identical) passphrase.
    lock();
    const count = Object.keys(remote.data.entries).length;
    if (opts.json) {
      io.out(
        `${JSON.stringify({ ok: true, secret_count: count, remote_version: remote.version, written: path }, null, 2)}\n`,
      );
    } else {
      io.out(
        `Local vault replaced with remote copy: ${count} secret${count === 1 ? "" : "s"} (encrypted) -> ${path}\n`,
      );
      io.out("Vault locked -- next secrets command will prompt for the passphrase.\n");
    }
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof TeamSyncAuthError) {
      const msg = "Session expired. Run `yaw-mcp login --key <license-key>` again.";
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets pull: ${msg}\n`);
      return { exitCode: 1 };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: message })}\n`);
    else io.err(`yaw-mcp secrets pull: ${message}\n`);
    return { exitCode: 1 };
  }
}

// Expose for vault file path tests
export function _vaultPathForHome(home: string): string {
  return vaultPath(home);
}

// Silence unused dir-creator warning
void CONFIG_DIRNAME;

// Re-export for tests + sibling modules
export type { VaultFile } from "./secrets-vault.js";
