// The server-side vault reader (upstream.ts) against a REAL schema-v3 vault:
// the module is not mocked except for vaultPath (pointed at a temp file) and
// the audit writer. Pins three things the v3 layout adds:
//   * resolveServerEnv decrypts v3 entries through the DEK unlock returns;
//   * a recovery code is never a passphrase over MCP -- neither the resolve
//     path nor the elicitation pre-flight (verifyVaultPassphrase) accepts one;
//   * a damaged passphrase slot fails the activation with the slot error
//     instead of looping a passphrase prompt that no passphrase can satisfy.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let vaultFile = "";

vi.mock("../secrets-vault.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets-vault.js")>();
  return { ...actual, vaultPath: vi.fn(() => vaultFile) };
});

vi.mock("../secrets-audit.js", () => ({
  appendAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { type KdfParams, setDefaultKdfForTesting } from "../secrets-crypto.js";
import {
  createVaultV3,
  lock,
  saveVault,
  setSecret,
  unlock,
  VAULT_SLOT_DAMAGED_ERROR,
  type VaultFile,
} from "../secrets-vault.js";
import {
  clearSessionVaultPassphrase,
  resolveServerEnv,
  setSessionVaultPassphrase,
  VaultPassphraseRequiredError,
  verifyVaultPassphrase,
} from "../upstream.js";

const FAST_KDF: KdfParams = { N: 1024, r: 8, p: 1 };
const PASS = "correct horse";
const REF_ENV = { TOKEN: "${secret:gh}" };

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-v3-upstream-"));
  vaultFile = join(home, ".yaw-mcp", "secrets.json");
  mkdirSync(dirname(vaultFile), { recursive: true });
  lock();
  setDefaultKdfForTesting(FAST_KDF);
  vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", undefined);
});

afterEach(() => {
  clearSessionVaultPassphrase();
  lock();
  setDefaultKdfForTesting(null);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** A v3 vault holding gh=ghp_v3value, WITH a recovery slot, saved to vaultFile. */
async function seedV3(): Promise<{ vault: VaultFile; code: string }> {
  const built = await createVaultV3(PASS, { recovery: true });
  const dek = await unlock(built.vault, PASS);
  const vault = setSecret(built.vault, dek, "gh", "ghp_v3value");
  dek.fill(0);
  lock();
  await saveVault(vaultFile, vault);
  if (!built.recoveryCode) throw new Error("expected a recovery code");
  return { vault, code: built.recoveryCode };
}

/** Rewrite the on-disk passphrase slot's digest so it no longer matches. */
function damagePassphraseSlotDigest(): void {
  const raw = JSON.parse(readFileSync(vaultFile, "utf8"));
  const digest = Buffer.from(raw.keyslots.passphrase.digest, "base64");
  digest[0] ^= 0xff;
  raw.keyslots.passphrase.digest = digest.toString("base64");
  writeFileSync(vaultFile, JSON.stringify(raw));
}

describe("resolveServerEnv on a schema-v3 vault", () => {
  it("decrypts an entry with the passphrase", async () => {
    await seedV3();
    setSessionVaultPassphrase(PASS);
    await expect(resolveServerEnv(REF_ENV, "gh")).resolves.toEqual({ TOKEN: "ghp_v3value" });
  });

  it("a wrong passphrase is the 'invalid' prompt error, as on v1/v2", async () => {
    await seedV3();
    setSessionVaultPassphrase("not it");
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect(err).toBeInstanceOf(VaultPassphraseRequiredError);
    expect((err as VaultPassphraseRequiredError).reason).toBe("invalid");
  });

  it("the recovery code is NOT a passphrase: it opens nothing over MCP", async () => {
    const { code } = await seedV3();
    setSessionVaultPassphrase(code);
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect(err).toBeInstanceOf(VaultPassphraseRequiredError);
    expect((err as VaultPassphraseRequiredError).reason).toBe("invalid");
    expect(String((err as Error).message)).not.toContain(code);
  });

  it("a damaged passphrase slot fails with the slot error and its recover pointer -- no prompt", async () => {
    // A prompt here could only loop: unlock answers slot-damaged for every
    // passphrase, the right one included.
    await seedV3();
    damagePassphraseSlotDigest();
    setSessionVaultPassphrase(PASS);
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect(err).not.toBeInstanceOf(VaultPassphraseRequiredError);
    expect((err as Error).message).toBe(VAULT_SLOT_DAMAGED_ERROR);
    expect((err as Error).message).toContain("yaw-mcp secrets recover");
  });
});

describe("verifyVaultPassphrase (the elicitation pre-flight) on a schema-v3 vault", () => {
  it("verifies the passphrase", async () => {
    await seedV3();
    await expect(verifyVaultPassphrase(PASS)).resolves.toBe("verified");
  });

  it("rejects a wrong passphrase", async () => {
    await seedV3();
    await expect(verifyVaultPassphrase("not it")).resolves.toBe("wrong");
  });

  it("rejects the recovery code typed at the passphrase page", async () => {
    const { code } = await seedV3();
    await expect(verifyVaultPassphrase(code)).resolves.toBe("wrong");
  });

  it("a damaged slot is kept ('verified'), so the retry reports the damage instead of re-prompting", async () => {
    await seedV3();
    damagePassphraseSlotDigest();
    await expect(verifyVaultPassphrase("anything at all")).resolves.toBe("verified");
  });
});
