import { mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSecretsArgs, runSecrets, SECRETS_USAGE } from "../secrets-cmd.js";

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

  it("--help sets help:true so dispatcher routes to stdout+exit0", () => {
    const r = parseSecretsArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(SECRETS_USAGE);
      expect((r as { help?: boolean }).help).toBe(true);
    }
  });
  it("-h sets help:true", () => {
    const r = parseSecretsArgs(["-h"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { help?: boolean }).help).toBe(true);
  });

  it("rejects --value without arg", () => {
    const r = parseSecretsArgs(["set", "github", "--value"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --value followed by a flag instead of storing it as the secret", () => {
    const r = parseSecretsArgs(["set", "github", "--value", "--json"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--value requires a value/);
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
  return { ...actual, getSession: vi.fn(), getResource: vi.fn(), putResource: vi.fn() };
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

  it("--json empty-remote output carries the same human hint under `message` (parity with prose)", async () => {
    vi.mocked(getResource).mockResolvedValue({
      version: 1,
      data: { version: 1, salt: "", entries: {} },
      updated_at: null,
      updated_by: null,
    });
    const result = await runSecrets({ action: "pull", json: true }, io);
    expect(result.exitCode).toBe(0);
    const out = io.out.mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, empty: true });
    expect(parsed.message).toMatch(/push from this machine to seed it/i);
  });
});

import { lock, saveVault, vaultPath } from "../secrets-vault.js";
import { putResource } from "../team-sync.js";

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

// -----------------------------------------------------------------------
// runSecrets push -- three additional edge-case paths
// -----------------------------------------------------------------------

describe("runSecrets push -- edge cases", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const home = nodePath.join(os.tmpdir(), `yaw-test-push-${process.pid}`);

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    vi.mocked(getSession).mockResolvedValue(FAKE_SESSION);
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  it("(a) no local vault -> exitCode 1 + 'no local vault' message", async () => {
    // Ensure vault file is absent.
    try {
      await unlink(vaultPath(home));
    } catch {
      /* ok */
    }

    const result = await runSecrets({ action: "push", home }, io);
    expect(result.exitCode).toBe(1);
    const errOutput = io.err.mock.calls[0][0] as string;
    expect(errOutput.toLowerCase()).toContain("no local vault");
  });

  it("(b) putResource throws TeamSyncStaleVersionError -> JSON output carries currentVersion", async () => {
    // Write a real local vault so loadVault succeeds.
    await saveVault(vaultPath(home), makeVault("YWFh", { KEY: { iv: "iv", ciphertext: "ct", authTag: "at" } } as any));

    // getResource resolves so we get past the remote-version fetch.
    vi.mocked(getResource).mockResolvedValue({
      version: 3,
      data: null,
      updated_at: null,
      updated_by: null,
    });

    const { TeamSyncStaleVersionError } = await import("../team-sync.js");
    vi.mocked(putResource).mockRejectedValue(new TeamSyncStaleVersionError(5));

    const result = await runSecrets({ action: "push", home, json: true }, io);
    expect(result.exitCode).toBe(1);
    const errOutput = io.err.mock.calls[0][0] as string;
    const parsed = JSON.parse(errOutput);
    expect(parsed.currentVersion).toBe(5);
  });

  it("(c) putResource throws TeamSyncAuthError -> exitCode 1 + session-expired message", async () => {
    await saveVault(vaultPath(home), makeVault("YWFh", { KEY: { iv: "iv", ciphertext: "ct", authTag: "at" } } as any));

    vi.mocked(getResource).mockResolvedValue({
      version: 1,
      data: null,
      updated_at: null,
      updated_by: null,
    });

    const { TeamSyncAuthError } = await import("../team-sync.js");
    vi.mocked(putResource).mockRejectedValue(new TeamSyncAuthError());

    const result = await runSecrets({ action: "push", home }, io);
    expect(result.exitCode).toBe(1);
    const errOutput = io.err.mock.calls[0][0] as string;
    // Must mention session expiry or re-login.
    expect(errOutput.toLowerCase()).toMatch(/session expired|login/);
  });
});

// -----------------------------------------------------------------------
// runSecrets set -- wrong-passphrase and empty-passphrase rejection
// -----------------------------------------------------------------------

describe("runSecrets set -- passphrase guards", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const home = nodePath.join(os.tmpdir(), `yaw-test-set-${process.pid}`);

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock(); // clear any cached key from a prior test
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
    try {
      await unlink(vaultPath(home));
    } catch {
      /* ok */
    }
  });

  it("creates a vault on first set, then rejects a wrong passphrase on a later set", async () => {
    // First set creates the vault under the correct passphrase.
    const r1 = await runSecrets(
      { action: "set", name: "github", value: "ghp_abc", passphrase: "correct-horse", home },
      io,
    );
    expect(r1.exitCode).toBe(0);
    lock(); // force re-derivation on the next call

    // A second set with the WRONG passphrase must be rejected, not silently
    // written under a bad key.
    const r2 = await runSecrets(
      { action: "set", name: "aws", value: "aws_xyz", passphrase: "wrong-passphrase", home },
      io,
    );
    expect(r2.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput.toLowerCase()).toContain("wrong passphrase");
  });

  it('rejects an empty passphrase (no silent unlock under key derived from "")', async () => {
    const r = await runSecrets({ action: "set", name: "github", value: "ghp_abc", passphrase: "", home }, io);
    expect(r.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput.toLowerCase()).toMatch(/passphrase required/);
  });
});

// -----------------------------------------------------------------------
// readPassphraseFromTTY -- Ctrl-D (EOT) cancels instead of submitting a
// partial passphrase. Driven through runSecrets via a fake TTY stdin.
// -----------------------------------------------------------------------

/** Minimal controllable fake of a TTY ReadStream for the passphrase reader.
 *  Each `resume()` (one per prompt) flushes the next queued chunk to the
 *  registered "data" listener on the next microtask. */
class FakeTTYStdin {
  isTTY = true;
  isRaw = false;
  private listener: ((chunk: string) => void) | null = null;
  private queue: string[];
  constructor(chunks: string[]) {
    this.queue = [...chunks];
  }
  setRawMode(v: boolean): this {
    this.isRaw = v;
    return this;
  }
  setEncoding(): this {
    return this;
  }
  on(event: string, cb: (chunk: string) => void): this {
    if (event === "data") this.listener = cb;
    return this;
  }
  removeListener(event: string, cb: (chunk: string) => void): this {
    if (event === "data" && this.listener === cb) this.listener = null;
    return this;
  }
  resume(): this {
    // Deliver the next chunk after the current synchronous frame so the
    // reader's "data" listener (attached AFTER resume() in the reader) is
    // already registered. Read this.listener lazily inside the microtask.
    const next = this.queue.shift();
    if (next !== undefined) {
      queueMicrotask(() => this.listener?.(next));
    }
    return this;
  }
  pause(): this {
    return this;
  }
}

describe("readPassphraseFromTTY -- Ctrl-D cancel", () => {
  const home = nodePath.join(os.tmpdir(), `yaw-test-ctrld-${process.pid}`);
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  const stderr = { write: vi.fn() } as unknown as NodeJS.WritableStream;
  const io = { out: vi.fn(), err: vi.fn() };

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
    try {
      await unlink(vaultPath(home));
    } catch {
      /* ok */
    }
  });

  it("treats typed chars followed by Ctrl-D (\\u0004) as cancel, NOT a partial submit", async () => {
    const EOT = String.fromCharCode(4);
    // Three prompts, each: type "abc" then Ctrl-D. If EOT were a line
    // terminator (the old bug) the first prompt would submit "abc" and unlock;
    // as a cancel it resolves "" each time, so resolvePassphrase exhausts its
    // re-prompt budget and reports "passphrase required" (exit 1).
    const stdin = new FakeTTYStdin([`abc${EOT}`, `abc${EOT}`, `abc${EOT}`]);
    const r = await runSecrets(
      {
        action: "set",
        name: "github",
        value: "ghp_abc",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput.toLowerCase()).toMatch(/passphrase required/);
    // No vault should have been written under a "abc"-derived key.
  });
});
