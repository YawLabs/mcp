import { mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SECRETS_USAGE, parseSecretsArgs, runSecrets } from "../secrets-cmd.js";

describe("parseSecretsArgs", () => {
  it("rejects missing action", () => {
    const r = parseSecretsArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing action/);
  });

  it("rejects unknown action", () => {
    const r = parseSecretsArgs(["nuke"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown action "nuke"/);
  });

  it("set requires a name", () => {
    const r = parseSecretsArgs(["set"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/<name> is required/);
  });

  it("set <name> parses", () => {
    const r = parseSecretsArgs(["set", "github"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("set");
      expect(r.options.name).toBe("github");
    }
  });

  it("set <name> --value v parses inline", () => {
    const r = parseSecretsArgs(["set", "github", "--value", "ghp_abc"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.value).toBe("ghp_abc");
    }
  });

  it("set <name> --stdin parses", () => {
    const r = parseSecretsArgs(["set", "github", "--stdin"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.fromStdin).toBe(true);
  });

  it("get <name> parses", () => {
    const r = parseSecretsArgs(["get", "github"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("get");
      expect(r.options.name).toBe("github");
    }
  });

  it("list does not need a name", () => {
    const r = parseSecretsArgs(["list"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("list");
  });

  it("remove requires a name", () => {
    const r = parseSecretsArgs(["remove"]);
    expect(r.ok).toBe(false);
  });

  it("lock parses with no name", () => {
    const r = parseSecretsArgs(["lock"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("lock");
  });

  it("--json applies", () => {
    const r = parseSecretsArgs(["list", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.json).toBe(true);
  });

  it("--help returns usage", () => {
    const r = parseSecretsArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(SECRETS_USAGE);
  });

  it("rejects --value without arg", () => {
    const r = parseSecretsArgs(["set", "github", "--value"]);
    expect(r.ok).toBe(false);
  });

  it("rejects extra positional", () => {
    const r = parseSecretsArgs(["set", "github", "extra"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unexpected positional/);
  });

  it("rejects unknown flag", () => {
    const r = parseSecretsArgs(["list", "--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown flag "--bogus"/);
  });

  it("push action parses without a name", () => {
    const r = parseSecretsArgs(["push"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("push");
  });

  it("pull action parses without a name", () => {
    const r = parseSecretsArgs(["pull"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("pull");
  });

  it("pull --force parses", () => {
    const r = parseSecretsArgs(["pull", "--force"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.force).toBe(true);
  });
});

// -----------------------------------------------------------------------
// runSecrets pull -- empty-remote guard and salt-conflict protection
// -----------------------------------------------------------------------

vi.mock("../team-sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSession: vi.fn(), getResource: vi.fn() };
});

import type { VaultFile } from "../secrets-vault.js";
import { getResource, getSession } from "../team-sync.js";

/** Build a minimal VaultFile shape for test. */
function makeVault(salt: string, entries: Record<string, unknown> = {}): VaultFile {
  return {
    version: 1,
    salt,
    entries: entries as VaultFile["entries"],
  };
}

const FAKE_SESSION = {
  email: "user@example.com",
  role: "member" as const,
  order_id: "ord-1",
  exp: Date.now() + 86400_000,
};

describe("runSecrets pull -- empty-remote guard", () => {
  const io = { out: vi.fn(), err: vi.fn() };

  beforeEach(() => {
    io.out.mockReset();
    io.err.mockReset();
    vi.mocked(getSession).mockResolvedValue(FAKE_SESSION);
  });

  it("treats remote with entries:{} and no salt as empty", async () => {
    vi.mocked(getResource).mockResolvedValue({
      version: 1,
      data: { version: 1, salt: "", entries: {} },
      updated_at: null,
      updated_by: null,
    });
    const result = await runSecrets({ action: "pull" }, io);
    expect(result.exitCode).toBe(0);
    expect(io.out).toHaveBeenCalledWith(expect.stringContaining("empty"));
  });

  it("treats remote with entries:{} and a salt as empty (no entries -- stub vault)", async () => {
    vi.mocked(getResource).mockResolvedValue({
      version: 1,
      data: { version: 1, salt: "c2FsdA==", entries: {} },
      updated_at: null,
      updated_by: null,
    });
    const result = await runSecrets({ action: "pull" }, io);
    expect(result.exitCode).toBe(0);
    expect(io.out).toHaveBeenCalledWith(expect.stringContaining("empty"));
  });

  it("treats remote with null entries as empty", async () => {
    vi.mocked(getResource).mockResolvedValue({
      version: 1,
      data: { version: 1, salt: "c2FsdA==", entries: null as unknown as VaultFile["entries"] },
      updated_at: null,
      updated_by: null,
    });
    const result = await runSecrets({ action: "pull" }, io);
    expect(result.exitCode).toBe(0);
  });
});

import { saveVault, vaultPath } from "../secrets-vault.js";

describe("runSecrets pull -- salt-conflict protection", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  // Use a tmp dir so loadVault finds a real file on disk.
  const home = nodePath.join(os.tmpdir(), `yaw-test-pull-${process.pid}`);

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    vi.mocked(getSession).mockResolvedValue(FAKE_SESSION);
    // Ensure the home dir exists for vault writes.
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  it("refuses when local non-empty vault has a different salt (no --force)", async () => {
    // Write a local vault with salt "aaa"
    await saveVault(
      vaultPath(home),
      makeVault("YWFh", { MY_KEY: { iv: "iv", ciphertext: "ct", authTag: "at" } } as any),
    );

    // Remote has salt "bbb" and a real entry
    vi.mocked(getResource).mockResolvedValue({
      version: 2,
      data: makeVault("YmJi", { OTHER: { iv: "iv2", ciphertext: "ct2", authTag: "at2" } } as any),
      updated_at: null,
      updated_by: null,
    });

    const result = await runSecrets({ action: "pull", home }, io);
    expect(result.exitCode).toBe(1);
    expect(io.err).toHaveBeenCalledWith(expect.stringContaining("different salt"));
    expect(io.err).toHaveBeenCalledWith(expect.stringContaining("--force"));
  });

  it("proceeds when local non-empty vault has a different salt with --force", async () => {
    await saveVault(
      vaultPath(home),
      makeVault("YWFh", { MY_KEY: { iv: "iv", ciphertext: "ct", authTag: "at" } } as any),
    );

    vi.mocked(getResource).mockResolvedValue({
      version: 2,
      data: makeVault("YmJi", { OTHER: { iv: "iv2", ciphertext: "ct2", authTag: "at2" } } as any),
      updated_at: null,
      updated_by: null,
    });

    const result = await runSecrets({ action: "pull", home, force: true }, io);
    expect(result.exitCode).toBe(0);
    expect(io.out).toHaveBeenCalledWith(expect.stringContaining("replaced"));
  });

  it("proceeds when local vault has same salt (no conflict)", async () => {
    await saveVault(
      vaultPath(home),
      makeVault("c2FtZQ==", { KEY: { iv: "iv", ciphertext: "ct", authTag: "at" } } as any),
    );

    vi.mocked(getResource).mockResolvedValue({
      version: 2,
      data: makeVault("c2FtZQ==", { KEY2: { iv: "iv2", ciphertext: "ct2", authTag: "at2" } } as any),
      updated_at: null,
      updated_by: null,
    });

    const result = await runSecrets({ action: "pull", home }, io);
    expect(result.exitCode).toBe(0);
    expect(io.out).toHaveBeenCalledWith(expect.stringContaining("replaced"));
  });

  it("proceeds when no local vault exists (first pull)", async () => {
    // Remove vault if it exists from a prior test run
    try {
      await unlink(vaultPath(home));
    } catch {
      /* ok */
    }

    vi.mocked(getResource).mockResolvedValue({
      version: 1,
      data: makeVault("bmV3", { KEY: { iv: "iv", ciphertext: "ct", authTag: "at" } } as any),
      updated_at: null,
      updated_by: null,
    });

    const result = await runSecrets({ action: "pull", home }, io);
    expect(result.exitCode).toBe(0);
    expect(io.out).toHaveBeenCalledWith(expect.stringContaining("replaced"));
  });

  it("error message names the vault path", async () => {
    await saveVault(
      vaultPath(home),
      makeVault("YWFh", { MY_KEY: { iv: "iv", ciphertext: "ct", authTag: "at" } } as any),
    );

    vi.mocked(getResource).mockResolvedValue({
      version: 2,
      data: makeVault("YmJi", { OTHER: { iv: "iv2", ciphertext: "ct2", authTag: "at2" } } as any),
      updated_at: null,
      updated_by: null,
    });

    const result = await runSecrets({ action: "pull", home }, io);
    expect(result.exitCode).toBe(1);
    // Error should name the vault path so the user knows what to back up
    const errOutput = io.err.mock.calls[0][0] as string;
    expect(errOutput).toContain(vaultPath(home));
  });
});
