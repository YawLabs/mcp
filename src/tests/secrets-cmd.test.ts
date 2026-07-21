import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  // The name character-class check used to live ONLY in setSecret, which
  // runs after the passphrase prompt, the scrypt derivation and the no-echo
  // value prompt -- so the user typed two secrets before being told the name
  // was never valid. The parser owns it now.
  it("rejects a set name with a space, and says what is allowed", () => {
    const r = parseSecretsArgs(["set", "my token"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/invalid secret name "my token"/);
      expect(r.error).toMatch(/letters, digits/);
      expect((r as { help?: boolean }).help).toBeUndefined();
    }
  });

  it("rejects a set name with a colon or braces (unreferenceable as ${secret:NAME})", () => {
    expect(parseSecretsArgs(["set", "gh:token"]).ok).toBe(false);
    expect(parseSecretsArgs(["set", "{gh}"]).ok).toBe(false);
  });

  it("accepts the full allowed character class for a set name", () => {
    const r = parseSecretsArgs(["set", "GH.token-1_x"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.name).toBe("GH.token-1_x");
  });

  // Deliberately scoped to `set`: get/remove already short-circuit to
  // `No secret named "..."` without prompting, and a vault written before
  // the rule existed must stay readable and removable by its legacy name.
  it("does not apply the name check to get/remove", () => {
    expect(parseSecretsArgs(["get", "my token"]).ok).toBe(true);
    expect(parseSecretsArgs(["remove", "my token"]).ok).toBe(true);
  });
});

// The push / pull test suites were removed 2026-07-21 with the Yaw Team
// surface -- `secrets push` and `secrets pull` no longer exist. The local
// vault suites below (set / rotate / audit / TTY) are unaffected.

import { lock, vaultPath } from "../secrets-vault.js";

/** Fresh throwaway HOME per test. mkdtemp (not a fixed tmpdir path) so
 *  parallel runs can't collide, and rmSync in afterEach so the suite does
 *  not leave a pile of yaw-test-* directories behind in os.tmpdir(). */
function makeHome(): string {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), "yaw-mcp-cmd-"));
  return dir;
}

// -----------------------------------------------------------------------
// runSecrets set -- wrong-passphrase and empty-passphrase rejection
// -----------------------------------------------------------------------

describe("runSecrets set -- passphrase guards", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock(); // clear any cached key from a prior test
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
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
  let home: string;
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  const stderr = { write: vi.fn() } as unknown as NodeJS.WritableStream;
  const io = { out: vi.fn(), err: vi.fn() };

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
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

  it("treats Ctrl-C (\\u0003) as cancel -> exit 130, without killing the process", async () => {
    const ETX = String.fromCharCode(3);
    // A single prompt: type "abc" then ^C. The reader must hand back a
    // cancellation (exit 130) rather than calling process.exit(130) itself --
    // if it did, this test would take the whole vitest worker down with it.
    const stdin = new FakeTTYStdin([`abc${ETX}`]);
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
    expect(r.exitCode).toBe(130);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput.toLowerCase()).toContain("cancelled");
  });
});

// -----------------------------------------------------------------------
// Invalid secret name -- rejected by the PARSER, so the command body (and
// its passphrase prompt, scrypt derivation and vault read) never runs.
// -----------------------------------------------------------------------

describe("secrets set -- invalid name fails before any prompt", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  const stderr = { write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  /** Mirror the CLI dispatcher (src/index.ts:237): parse first, and reach
   *  runSecrets ONLY when the parse succeeded. `ran` records whether the
   *  command body executed -- everything the finding is about (prompt,
   *  ~100ms scrypt, vault read) lives behind it. */
  async function dispatch(
    argv: string[],
    stdin: FakeTTYStdin,
  ): Promise<{ ran: boolean; exitCode: number; error: string }> {
    const parsed = parseSecretsArgs(argv);
    // index.ts writes parsed.error to stderr and exits 2 on a parse failure.
    if (!parsed.ok) return { ran: false, exitCode: 2, error: parsed.error };
    const r = await runSecrets(
      {
        ...parsed.options,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    return { ran: true, exitCode: r.exitCode, error: io.err.mock.calls.map((c) => c[0] as string).join("") };
  }

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it('rejects `set "my token"` at parse time -- no passphrase prompt, no value prompt, vault untouched', async () => {
    // Seed a vault so a read/write by the command body would be observable.
    const seed = await runSecrets(
      { action: "set", name: "github", value: "ghp_abc", passphrase: "seed-passphrase-xyz", home },
      io,
    );
    expect(seed.exitCode).toBe(0);
    const before = readFileSync(vaultPath(home), "utf8");
    lock();
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();

    // stdin is preloaded with a passphrase AND a secret value: if the check
    // regresses to setSecret-only, the command body consumes BOTH prompts
    // before reporting the bad name -- which is exactly the UX being fixed.
    const stdin = new FakeTTYStdin(["seed-passphrase-xyz\r", "some-value\r"]);
    const r = await dispatch(["set", "my token"], stdin);

    expect(r.ran).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/invalid secret name "my token"/);
    expect(r.error).toMatch(/letters, digits/);
    // Nothing was written to the terminal -- both prompts go through
    // stdout.write, so zero calls means the user was never asked anything.
    expect(stdout.write).not.toHaveBeenCalled();
    // ...and the vault on disk is byte-identical: no entry, no re-save.
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });
});

// -----------------------------------------------------------------------
// runSecrets rotate -- local re-encryption (no --push)
// -----------------------------------------------------------------------

describe("runSecrets rotate", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
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
  let home: string;

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
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
