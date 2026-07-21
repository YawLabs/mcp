import { readFileSync } from "node:fs";
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

  // `push` / `pull` and the --force / --replace / --push flags were removed
  // 2026-07-21 with the Yaw Team surface. They must now be REJECTED, not
  // silently parsed -- these assertions are what stop them creeping back as
  // no-op flags that look supported.
  it("push action is rejected", () => {
    expect(parseSecretsArgs(["push"]).ok).toBe(false);
  });

  it("pull action is rejected", () => {
    expect(parseSecretsArgs(["pull"]).ok).toBe(false);
  });

  it("--force is rejected as an unknown flag", () => {
    expect(parseSecretsArgs(["rotate", "--force"]).ok).toBe(false);
  });

  it("--replace is rejected as an unknown flag", () => {
    expect(parseSecretsArgs(["rotate", "--replace"]).ok).toBe(false);
  });

  it("rotate --push is rejected as an unknown flag", () => {
    expect(parseSecretsArgs(["rotate", "--push"]).ok).toBe(false);
  });

  it("rotate action parses without a name", () => {
    const r = parseSecretsArgs(["rotate"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("rotate");
  });

  it("audit action parses with filters", () => {
    const r = parseSecretsArgs(["audit", "--secret", "gh", "--server", "github", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("audit");
      expect(r.options.secretFilter).toBe("gh");
      expect(r.options.serverFilter).toBe("github");
      expect(r.options.json).toBe(true);
    }
  });

  it("rejects --secret without arg", () => {
    const r = parseSecretsArgs(["audit", "--secret"]);
    expect(r.ok).toBe(false);
  });
});

// The push / pull test suites were removed 2026-07-21 with the Yaw Team
// surface -- `secrets push` and `secrets pull` no longer exist. The local
// vault suites below (set / rotate / audit / TTY) are unaffected.

import { lock, saveVault, vaultPath } from "../secrets-vault.js";


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

// -----------------------------------------------------------------------
// runSecrets rotate -- local re-encryption (no --push)
// -----------------------------------------------------------------------

describe("runSecrets rotate", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const home = nodePath.join(os.tmpdir(), `yaw-test-rotate-${process.pid}`);

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
    try {
      await unlink(vaultPath(home));
    } catch {
      /* ok */
    }
  });

  it("re-encrypts the vault: new passphrase reads, old one no longer does", async () => {
    // Seed a vault under the old passphrase.
    const r1 = await runSecrets(
      { action: "set", name: "github", value: "ghp_abc", passphrase: "old-passphrase-xyz", home },
      io,
    );
    expect(r1.exitCode).toBe(0);
    lock();

    // Rotate to a new passphrase (test hooks bypass env/TTY).
    const r2 = await runSecrets(
      { action: "rotate", passphrase: "old-passphrase-xyz", newPassphrase: "new-passphrase-xyz", home },
      io,
    );
    expect(r2.exitCode).toBe(0);
    lock();

    // get under the NEW passphrase succeeds.
    io.out.mockReset();
    const r3 = await runSecrets(
      { action: "get", name: "github", passphrase: "new-passphrase-xyz", home, json: true },
      io,
    );
    expect(r3.exitCode).toBe(0);
    const okLine = io.out.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    expect(okLine && JSON.parse(okLine).value).toBe("ghp_abc");
    lock();

    // get under the OLD passphrase is now rejected (wrong passphrase).
    io.err.mockReset();
    const r4 = await runSecrets({ action: "get", name: "github", passphrase: "old-passphrase-xyz", home }, io);
    expect(r4.exitCode).toBe(1);
    const err = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(err.toLowerCase()).toMatch(/wrong passphrase|decryption failed/);
  });

  it("aborts on a wrong current passphrase; vault is unchanged", async () => {
    await runSecrets({ action: "set", name: "k", value: "v", passphrase: "correct-current", home }, io);
    const before = readFileSync(vaultPath(home), "utf8");
    lock();

    const r = await runSecrets(
      { action: "rotate", passphrase: "wrong-current", newPassphrase: "whatever-new", home },
      io,
    );
    expect(r.exitCode).toBe(1);
    // On-disk vault untouched by the aborted rotate.
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("errors when there is no vault to rotate", async () => {
    const r = await runSecrets({ action: "rotate", passphrase: "x", newPassphrase: "y", home }, io);
    expect(r.exitCode).toBe(1);
    const err = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(err.toLowerCase()).toContain("no vault");
  });
});

// -----------------------------------------------------------------------
// runSecrets audit -- read the local audit log
// -----------------------------------------------------------------------

describe("runSecrets audit", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const home = nodePath.join(os.tmpdir(), `yaw-test-secaudit-${process.pid}`);

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  it("reports an empty trail when nothing has been recorded", async () => {
    const r = await runSecrets({ action: "audit", home }, io);
    expect(r.exitCode).toBe(0);
    const out = io.out.mock.calls.map((c) => c[0] as string).join("");
    expect(out.toLowerCase()).toContain("no secret-resolution audit");
  });

  it("renders recorded events and filters by server", async () => {
    const { appendAuditEvent } = await import("../secrets-audit.js");
    await appendAuditEvent({ server: "gh", secret: "token", event: "injected" }, home);
    await appendAuditEvent({ server: "aws", secret: "key", event: "missing" }, home);

    const r = await runSecrets({ action: "audit", serverFilter: "gh", home, json: true }, io);
    expect(r.exitCode).toBe(0);
    const out = io.out.mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(1);
    expect(parsed.events[0].server).toBe("gh");
    // No value field in any emitted event.
    expect(Object.keys(parsed.events[0]).sort()).toEqual(["event", "secret", "server", "ts"]);
  });
});
