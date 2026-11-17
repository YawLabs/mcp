// resolveServerEnv / verifyVaultPassphrase fixes from the vault-key full pass:
//   * "no vault" and "vault unreadable" refuse BEFORE the missing-passphrase
//     prompt error, so nobody is asked for a passphrase to a vault that is not
//     there;
//   * verifyVaultPassphrase tells "verified" from "nothing to check against";
//   * a corrupt check marker carries the CLI's hand-fix hint;
//   * the caller's copy of the derived key is zeroed after the decrypt;
//   * the typed error names the map the refs live in (env vs headers).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../secrets-vault.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets-vault.js")>();
  return {
    ...actual,
    loadVault: vi.fn(),
    unlock: vi.fn(),
    resolveSecretRefs: vi.fn(),
    checkVaultPassphrase: vi.fn(),
    vaultPath: vi.fn().mockReturnValue("/tmp/fake-vault.json"),
  };
});

vi.mock("../secrets-audit.js", () => ({
  appendAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  checkVaultPassphrase,
  loadVault,
  resolveSecretRefs,
  unlock,
  VAULT_CHECK_CORRUPT_ERROR,
  vaultCheckCorruptHint,
} from "../secrets-vault.js";
import {
  clearSessionVaultPassphrase,
  resolveServerEnv,
  setSessionVaultPassphrase,
  VaultPassphraseRequiredError,
  verifyVaultPassphrase,
} from "../upstream.js";

const REF_ENV = { TOKEN: "${secret:gh}" };
const VAULT = { version: 2, salt: "abc", entries: { gh: {} }, check: {} } as any;

beforeEach(() => {
  vi.mocked(loadVault).mockReset();
  vi.mocked(unlock).mockReset();
  vi.mocked(resolveSecretRefs).mockReset();
  vi.mocked(checkVaultPassphrase).mockReset();
  // A developer's real YAW_MCP_VAULT_PASSPHRASE must not stand in for "none".
  vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", undefined);
});

afterEach(() => {
  clearSessionVaultPassphrase();
  vi.unstubAllEnvs();
});

describe("resolveServerEnv -- vault state is checked before the passphrase", () => {
  it("no passphrase and NO vault: refuses with 'no vault exists yet', not the prompt-driving error", async () => {
    vi.mocked(loadVault).mockResolvedValue(null);
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect(err).not.toBeInstanceOf(VaultPassphraseRequiredError);
    expect((err as Error).message).toContain("no vault exists yet");
  });

  it("no passphrase and an UNREADABLE vault: refuses with the read error, not the prompt-driving error", async () => {
    vi.mocked(loadVault).mockRejectedValue(new Error("Unexpected token } in JSON"));
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect(err).not.toBeInstanceOf(VaultPassphraseRequiredError);
    expect((err as Error).message).toBe("vault unreadable: Unexpected token } in JSON");
  });

  it("no passphrase and a vault that exists: the typed 'missing' error, carrying its subject", async () => {
    vi.mocked(loadVault).mockResolvedValue(VAULT);
    const err = await resolveServerEnv({ Authorization: "Bearer ${secret:gh}" }, "lin", "remote server headers").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(VaultPassphraseRequiredError);
    expect(err.reason).toBe("missing");
    expect(err.subject).toBe("remote server headers");
    expect(err.refKeys).toEqual(["Authorization"]);
  });

  it("a wrong passphrase: the typed 'invalid' error carries the subject too", async () => {
    setSessionVaultPassphrase("nope");
    vi.mocked(loadVault).mockResolvedValue(VAULT);
    vi.mocked(unlock).mockRejectedValue(new Error("wrong passphrase for this vault (decryption failed)"));
    const err = await resolveServerEnv({ Authorization: "${secret:gh}" }, "lin", "remote server headers").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(VaultPassphraseRequiredError);
    expect(err.reason).toBe("invalid");
    expect(err.subject).toBe("remote server headers");
  });

  it("defaults the subject to the local server env", async () => {
    vi.mocked(loadVault).mockResolvedValue(VAULT);
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect(err.subject).toBe("server env");
  });
});

describe("resolveServerEnv -- a vault with no entries", () => {
  // The real resolveSecretRefs: it must report every well-formed ref as
  // missing without ever reading the (absent) key.
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../secrets-vault.js")>("../secrets-vault.js");
    vi.mocked(resolveSecretRefs).mockImplementation(actual.resolveSecretRefs);
  });

  it("legacy and emptied (no marker, no entries), no passphrase: names the missing secret, never prompts", async () => {
    // A prompt here is a dead loop: the typed value verifies as "unverifiable",
    // is discarded, and the next activation asks again.
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: {} } as any);
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect(err).not.toBeInstanceOf(VaultPassphraseRequiredError);
    expect((err as Error).message).toBe(
      "vault: missing or undecryptable secret refs: gh (the vault holds no secrets yet; store each with `yaw-mcp secrets set <name>`)",
    );
    expect(unlock).not.toHaveBeenCalled();
  });

  it("a passphrase IS set: still no unlock (no scrypt, no cache eviction) -- every ref is missing anyway", async () => {
    setSessionVaultPassphrase("right");
    // A marker but no entries verifies passphrases, and still cannot satisfy a ref.
    vi.mocked(loadVault).mockResolvedValue({ version: 2, salt: "abc", entries: {}, check: {} } as any);
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect((err as Error).message).toContain("missing or undecryptable secret refs: gh");
    expect(unlock).not.toHaveBeenCalled();
  });

  it("a vault WITH entries still asks for the passphrase", async () => {
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { other: {} } } as any);
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect(err).toBeInstanceOf(VaultPassphraseRequiredError);
  });
});

describe("resolveServerEnv -- corrupt check marker", () => {
  it("re-throws with the same hand-fix hint the CLI prints, naming the vault path", async () => {
    setSessionVaultPassphrase("right");
    vi.mocked(loadVault).mockResolvedValue(VAULT);
    vi.mocked(unlock).mockRejectedValue(new Error(VAULT_CHECK_CORRUPT_ERROR));
    const err = await resolveServerEnv(REF_ENV, "gh").catch((e) => e);
    expect(err).not.toBeInstanceOf(VaultPassphraseRequiredError);
    expect((err as Error).message).toBe(
      `${VAULT_CHECK_CORRUPT_ERROR}. ${vaultCheckCorruptHint("/tmp/fake-vault.json")}`,
    );
  });
});

describe("resolveServerEnv -- the caller's key copy is zeroed", () => {
  it("after a successful decrypt", async () => {
    setSessionVaultPassphrase("right");
    vi.mocked(loadVault).mockResolvedValue(VAULT);
    const key = Buffer.alloc(32, 7);
    vi.mocked(unlock).mockResolvedValue(key);
    vi.mocked(resolveSecretRefs).mockImplementation((_env, _vault, k) => {
      // Still intact WHILE the decrypt runs.
      expect(k.every((b) => b === 7)).toBe(true);
      return { resolved: { TOKEN: "tok" }, missing: [], malformed: [], values: { gh: "tok" } } as any;
    });
    await expect(resolveServerEnv(REF_ENV, "gh")).resolves.toEqual({ TOKEN: "tok" });
    expect(key.every((b) => b === 0)).toBe(true);
  });

  it("when the decrypt throws", async () => {
    setSessionVaultPassphrase("right");
    vi.mocked(loadVault).mockResolvedValue(VAULT);
    const key = Buffer.alloc(32, 7);
    vi.mocked(unlock).mockResolvedValue(key);
    vi.mocked(resolveSecretRefs).mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(resolveServerEnv(REF_ENV, "gh")).rejects.toThrow("boom");
    expect(key.every((b) => b === 0)).toBe(true);
  });
});

describe("verifyVaultPassphrase -- nothing to check against", () => {
  it("a vault with no check marker and no entries is unverifiable, and is never unlocked", async () => {
    // unlock() accepts ANY passphrase for such a vault, so "it opened" would be
    // a claim nobody tested.
    vi.mocked(loadVault).mockResolvedValue({ version: 2, salt: "abc", entries: {} } as any);
    await expect(verifyVaultPassphrase("anything")).resolves.toBe("unverifiable");
    expect(checkVaultPassphrase).not.toHaveBeenCalled();
  });

  it("a vault with entries but no marker (legacy) is still checked", async () => {
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { gh: {} } } as any);
    vi.mocked(checkVaultPassphrase).mockResolvedValue("opens");
    await expect(verifyVaultPassphrase("right")).resolves.toBe("verified");
  });
});
