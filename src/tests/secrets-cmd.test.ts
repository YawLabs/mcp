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

  // `push` / `pull` and the --replace / --push flags were removed 2026-07-21
  // with the Yaw Team surface. They must now be REJECTED, not silently
  // parsed -- these assertions are what stop them creeping back as no-op
  // flags that look supported. (--force came BACK on its own terms: it now
  // gates the destructive confirmations, not a vault sync.)
  it("push action is rejected", () => {
    expect(parseSecretsArgs(["push"]).ok).toBe(false);
  });

  it("pull action is rejected", () => {
    expect(parseSecretsArgs(["pull"]).ok).toBe(false);
  });

  it("--force parses and sets force (skips the destructive confirmation)", () => {
    const r = parseSecretsArgs(["remove", "github", "--force"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("remove");
      expect(r.options.name).toBe("github");
      expect(r.options.force).toBe(true);
    }
  });

  it("force is undefined when --force is absent (no accidental default-yes)", () => {
    const r = parseSecretsArgs(["remove", "github"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.force).toBeUndefined();
  });

  it("documents --force in the usage text (it is the only way to script a remove)", () => {
    expect(SECRETS_USAGE).toContain("--force");
  });

  // The confirmation needs stdin AND stdout to be a TTY, so the usage text
  // must not tell the user it is only about stdin -- `remove NAME | jq` from
  // an interactive shell hits the refusal with a TTY stdin.
  it("usage text does not blame stdin alone for the non-interactive remove refusal", () => {
    expect(SECRETS_USAGE).toMatch(/stdin or stdout/);
    expect(SECRETS_USAGE).not.toMatch(/Required for remove when stdin is not a/);
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

// -----------------------------------------------------------------------
// Destructive-action confirmation (remove, and a set that overwrites).
//
// Before this gate existed, `secrets remove TOKEN` deleted immediately and
// exited 0, and `secrets set TOKEN` over an existing name silently replaced
// the value while printing the same 'Stored secret "TOKEN".' as a fresh
// write. Both destroy a credential that may exist nowhere else.
//
// The two paths are asymmetric ON PURPOSE and each half is asserted below:
// remove is unrecoverable (non-TTY must pass --force), a set overwrite is a
// swap with the new value already in hand (non-TTY proceeds, but the
// message must say "Replaced").
// -----------------------------------------------------------------------

const CONFIRM_PASS = "confirm-passphrase-xyz";

/** Non-TTY stdin/stdout pair, so these tests never depend on whether the
 *  vitest worker's process.stdin happens to be a TTY. */
function nonTTYIo(stderr: NodeJS.WritableStream): {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
} {
  return {
    stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    stdout: { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream,
    stderr,
  };
}

describe("runSecrets remove -- confirmation gate", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  const stderr = { write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  /** Seed a one-entry vault and return its exact on-disk bytes, so a test
   *  can assert the file was not touched at all. */
  async function seed(): Promise<string> {
    const r = await runSecrets({ action: "set", name: "TOKEN", value: "ghp_abc", passphrase: CONFIRM_PASS, home }, io);
    expect(r.exitCode).toBe(0);
    lock();
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    return readFileSync(vaultPath(home), "utf8");
  }

  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  const promptText = (): string =>
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).join("");

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

  it("TTY + bare Enter does NOT delete (the prompt defaults to no)", async () => {
    const before = await seed();
    const stdin = new FakeTTYStdin(["\r"]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText().toLowerCase()).toContain("aborted");
    // The user was actually asked, and the vault is byte-identical.
    expect(promptText().toLowerCase()).toContain("delete");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  // The bare-Enter default above only pins "empty means no". It does NOT pin
  // the y/yes CHECK itself: relaxing promptYesNo to `answer.length > 0` (any
  // non-empty answer = consent) keeps every bare-Enter test green while
  // turning a typed "n" into a delete. On the unrecoverable path that is the
  // worst possible regression, so an explicit no is asserted directly.
  it.each(["n", "no"])('TTY + explicit "%s" does NOT delete', async (answer) => {
    const before = await seed();
    const stdin = new FakeTTYStdin([`${answer}\r`]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted.");
    // The user was actually asked, and the vault is byte-identical.
    expect(promptText().toLowerCase()).toContain("delete");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("TTY + explicit y deletes the entry", async () => {
    await seed();
    const stdin = new FakeTTYStdin(["y\r"]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Removed "TOKEN"');
    lock();

    io.err.mockReset();
    const after = await runSecrets({ action: "get", name: "TOKEN", passphrase: CONFIRM_PASS, home }, io);
    expect(after.exitCode).toBe(1);
    expect(errText()).toContain('No secret named "TOKEN"');
  });

  // Every other confirmation test injects opts.passphrase, which
  // short-circuits resolvePassphrase -- so none of them can tell whether the
  // gate runs before or after it. This one OMITS the passphrase (and the env
  // var is deleted in beforeEach), so the passphrase would have to come from
  // a real prompt. If the gate moved to after the passphrase resolution, the
  // single queued chunk would be eaten by "Vault passphrase: " instead, which
  // is exactly the cost the ordering exists to avoid.
  it("a declined confirmation costs no passphrase entry (the gate runs BEFORE the prompt)", async () => {
    const before = await seed();
    const stdin = new FakeTTYStdin(["n\r"]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted.");
    expect(promptText()).not.toContain("Vault passphrase: ");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("TTY + ^C at the prompt cancels with 130 and leaves the vault alone", async () => {
    const before = await seed();
    const ETX = String.fromCharCode(3);
    const stdin = new FakeTTYStdin([ETX]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(130);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  // The confirm prompt echoes what is typed (a y/n is not a secret), so any
  // byte the reader buffers goes straight back to the terminal. A raw ESC
  // sent back is EXECUTED by the terminal rather than displayed -- an arrow
  // key at the [y/N] prompt repainted the screen and desynced what the user
  // saw from what the answer buffer held.
  const ESC = String.fromCharCode(27);

  it("an ESC byte at the confirm prompt is dropped: not echoed, and the answer still reads as y", async () => {
    await seed();
    const stdin = new FakeTTYStdin([`${ESC}y\r`]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    // Buffered, the ESC would make the answer "\x1by" -- which is not "y",
    // so the delete would silently turn into an abort.
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Removed "TOKEN"');
    expect(promptText()).not.toContain(ESC);
  });

  it("an arrow-key sequence at the confirm prompt never echoes the raw ESC back to the terminal", async () => {
    const before = await seed();
    // Up-arrow is ESC + "[A". The decision is unaffected either way (neither
    // "[A" nor "\x1b[A" is consent) -- what matters is that the terminal is
    // never handed the escape byte.
    const stdin = new FakeTTYStdin([`${ESC}[A\r`]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted.");
    expect(promptText()).not.toContain(ESC);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  // Backspace still has to work, and it must never eat the prompt text
  // itself: "yy" then two Backspaces then "y" is a plain y.
  it("Backspace still edits the answer and cannot chew past the start of the buffer", async () => {
    await seed();
    const BS = String.fromCharCode(127);
    const stdin = new FakeTTYStdin([`yy${BS}${BS}${BS}${BS}y\r`]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Removed "TOKEN"');
  });

  it("non-TTY without --force refuses (exit 2), names the flag, and leaves the vault byte-identical", async () => {
    const before = await seed();
    const r = await runSecrets(
      { action: "remove", name: "TOKEN", passphrase: CONFIRM_PASS, home, io: nonTTYIo(stderr) },
      io,
    );
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain("--force");
    expect(errText()).toContain("neither stdin nor stdout is a TTY");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  // The gate needs BOTH ends (stdin to read the answer, stdout to show the
  // question), so the refusal has to name the end that actually failed.
  // Blaming stdin unconditionally sent `remove NAME --json | jq` -- run from
  // an interactive shell, so stdin IS a TTY -- to the wrong half of the pipe.
  it("names stdout when stdout is the half that is not a TTY (`remove NAME --json | jq`)", async () => {
    const before = await seed();
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: {
          stdin: { isTTY: true } as unknown as NodeJS.ReadableStream,
          stdout: { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream,
          stderr,
        },
      },
      io,
    );
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain("stdout is not a TTY");
    expect(errText()).not.toContain("stdin is not a TTY");
    expect(errText()).toContain("--force");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("names stdin when stdin is the half that is not a TTY (`echo x | remove NAME`)", async () => {
    const before = await seed();
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: {
          stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
          stdout: { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream,
          stderr,
        },
      },
      io,
    );
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain("stdin is not a TTY");
    expect(errText()).not.toContain("stdout is not a TTY");
    expect(errText()).toContain("--force");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("non-TTY with --force deletes", async () => {
    await seed();
    const r = await runSecrets(
      { action: "remove", name: "TOKEN", passphrase: CONFIRM_PASS, force: true, home, io: nonTTYIo(stderr) },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Removed "TOKEN"');
    lock();

    io.out.mockReset();
    const listed = await runSecrets({ action: "list", home, json: true }, io);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(outText()).keys).toEqual([]);
  });

  // --force's headline behavior is "skip the interactive confirm", and the
  // only place that is observable is a TTY -- the non-TTY tests above pass
  // whether or not the prompt is actually skipped, because there is no
  // prompt to skip. Mirrors the set-side "--force skips the overwrite prompt
  // on a TTY" test.
  it("--force skips the confirmation prompt on a TTY (nothing is asked, and it still deletes)", async () => {
    await seed();
    // Empty queue: if the gate tried to prompt, the read would never settle
    // and this test would time out instead of passing.
    const stdin = new FakeTTYStdin([]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        force: true,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(promptText()).toBe("");
    expect(outText()).toContain('Removed "TOKEN"');
    lock();

    io.out.mockReset();
    const listed = await runSecrets({ action: "list", home, json: true }, io);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(outText()).keys).toEqual([]);
  });

  it("--force skips the confirmation but NOT the passphrase", async () => {
    const before = await seed();
    // No passphrase hook, no env var, no TTY to prompt on: --force must not
    // turn into a free pass at the vault.
    const r = await runSecrets({ action: "remove", name: "TOKEN", force: true, home, io: nonTTYIo(stderr) }, io);
    expect(r.exitCode).toBe(1);
    expect(errText().toLowerCase()).toMatch(/passphrase required/);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("a missing name still reports not-found, never the --force refusal", async () => {
    await seed();
    const r = await runSecrets(
      { action: "remove", name: "NOPE", passphrase: CONFIRM_PASS, home, io: nonTTYIo(stderr) },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain('No secret named "NOPE"');
    expect(errText()).not.toContain("--force");
  });
});

describe("runSecrets set -- overwrite confirmation and Replaced/Stored split", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  const stderr = { write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  const promptText = (): string =>
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).join("");

  async function seed(): Promise<string> {
    const r = await runSecrets(
      { action: "set", name: "TOKEN", value: "old-value", passphrase: CONFIRM_PASS, home },
      io,
    );
    expect(r.exitCode).toBe(0);
    lock();
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    return readFileSync(vaultPath(home), "utf8");
  }

  async function readBack(): Promise<string | undefined> {
    lock();
    const probe = { out: vi.fn(), err: vi.fn() };
    const r = await runSecrets({ action: "get", name: "TOKEN", passphrase: CONFIRM_PASS, home, json: true }, probe);
    if (r.exitCode !== 0) return undefined;
    const line = probe.out.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    return line ? (JSON.parse(line).value as string) : undefined;
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

  it("TTY + bare Enter leaves the existing value in place", async () => {
    const before = await seed();
    const stdin = new FakeTTYStdin(["\r"]);
    const r = await runSecrets(
      {
        action: "set",
        name: "TOKEN",
        value: "new-value",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText().toLowerCase()).toContain("aborted");
    expect(promptText().toLowerCase()).toContain("already exists");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    expect(await readBack()).toBe("old-value");
  });

  // Same gap as the remove side: bare Enter alone does not pin the y/yes
  // check, so a typed no is asserted here too. Both gates share promptYesNo,
  // and a regression there overwrites a credential the user just declined to
  // replace.
  it.each(["n", "no"])('TTY + explicit "%s" leaves the existing value in place', async (answer) => {
    const before = await seed();
    const stdin = new FakeTTYStdin([`${answer}\r`]);
    const r = await runSecrets(
      {
        action: "set",
        name: "TOKEN",
        value: "new-value",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted.");
    expect(promptText().toLowerCase()).toContain("already exists");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    expect(await readBack()).toBe("old-value");
  });

  it("TTY + explicit y replaces the value and says Replaced, not Stored", async () => {
    await seed();
    const stdin = new FakeTTYStdin(["y\r"]);
    const r = await runSecrets(
      {
        action: "set",
        name: "TOKEN",
        value: "new-value",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Replaced secret "TOKEN".');
    expect(outText()).not.toContain("Stored secret");
    expect(await readBack()).toBe("new-value");
  });

  it("non-TTY overwrite PROCEEDS without --force (credential rotation must stay scriptable)", async () => {
    await seed();
    const r = await runSecrets(
      { action: "set", name: "TOKEN", value: "rotated", passphrase: CONFIRM_PASS, home, io: nonTTYIo(stderr) },
      io,
    );
    expect(r.exitCode).toBe(0);
    // ...but the message must NOT look like a fresh write.
    expect(outText()).toContain('Replaced secret "TOKEN".');
    expect(outText()).not.toContain("Stored secret");
    expect(await readBack()).toBe("rotated");
  });

  it("a fresh name still says Stored, and --json carries replaced:false", async () => {
    const r = await runSecrets(
      { action: "set", name: "FRESH", value: "v", passphrase: CONFIRM_PASS, home, json: true, io: nonTTYIo(stderr) },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(outText()).replaced).toBe(false);

    io.out.mockReset();
    lock();
    const again = await runSecrets(
      { action: "set", name: "FRESH", value: "v2", passphrase: CONFIRM_PASS, home, json: true, io: nonTTYIo(stderr) },
      io,
    );
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(outText()).replaced).toBe(true);
  });

  it("--force skips the overwrite prompt on a TTY (nothing is asked)", async () => {
    await seed();
    // Empty queue: if the gate tried to prompt, the read would never settle
    // and this test would time out instead of passing.
    const stdin = new FakeTTYStdin([]);
    const r = await runSecrets(
      {
        action: "set",
        name: "TOKEN",
        value: "forced",
        passphrase: CONFIRM_PASS,
        force: true,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(promptText()).toBe("");
    expect(await readBack()).toBe("forced");
  });

  it("prompts for the VALUE with a value label, not a second passphrase label", async () => {
    // The value prompt used to print "Secret value: Vault passphrase: " --
    // the label was written by the caller AND by the reader.
    const stdin = new FakeTTYStdin(["typed-value\r"]);
    const r = await runSecrets(
      {
        action: "set",
        name: "FRESH",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout, stderr },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(promptText()).toContain("Secret value: ");
    expect(promptText()).not.toContain("Vault passphrase: ");
  });
});
