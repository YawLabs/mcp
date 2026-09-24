// A vault WRITE can fail for reasons that have nothing to do with the vault:
// EACCES on ~/.yaw-mcp, ENOSPC, EXDEV on the atomic rename. Awaited bare,
// that rejection escaped runSecrets entirely and was formatted by the CLI
// entry point as prose -- so a `--json` caller that had been handed a clean
// {ok:false,error} envelope for every other failure got a bare prose line for
// this one and its parse broke.
//
// The failure is injected at the saveVault boundary (a real unwritable path
// is not portable: chmod is POSIX-only and a no-op for root, and any on-disk
// trick that makes the write fail also makes the pre-write READ fail, which
// short-circuits earlier with a different message). Every other export passes
// through to the real module, including the module-scoped key cache.
//
// The last block injects a failed READ at the loadVault boundary the same
// way, for the errnos a directory fixture cannot give (it only ever yields
// EISDIR): EIO and EACCES on list and get, and a load that fails on `set`
// after its baseline read passed -- the one read failure set's fail-fast
// cannot catch.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { injected } = vi.hoisted(() => ({
  injected: { code: null as string | null, message: null as string | null, loadCode: null as string | null },
}));

vi.mock("../secrets-vault.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets-vault.js")>();
  return {
    ...actual,
    loadVault: async (path: string, opts?: Parameters<typeof actual.loadVault>[1]) => {
      if (injected.loadCode !== null) {
        // Node's shape for a read-phase errno ("EIO: i/o error, read"): the
        // code and the syscall, and no path -- so a path in the refusal can
        // only have come from the CLI.
        const err: NodeJS.ErrnoException = new Error(`${injected.loadCode}: injected read failure, read`);
        err.code = injected.loadCode;
        throw err;
      }
      return actual.loadVault(path, opts);
    },
    saveVault: async (path: string, vault: Parameters<typeof actual.saveVault>[1]) => {
      if (injected.code !== null || injected.message !== null) {
        // The default message deliberately does NOT repeat the errno. When it
        // did, `error).toContain("EACCES")` passed whether saveVaultOrReport
        // read `e.code` or fell back to the message text -- so the assertion
        // pinned nothing. Setting `injected.message` alone (no code) drives
        // the message-fallback arm instead.
        const err: NodeJS.ErrnoException = new Error(injected.message ?? `injected write failure, open '${path}'`);
        if (injected.code !== null) err.code = injected.code;
        throw err;
      }
      return actual.saveVault(path, vault);
    },
  };
});

import { runSecrets } from "../secrets-cmd.js";
import { isUnlocked, lock, vaultPath } from "../secrets-vault.js";

const PASS = "a-long-enough-passphrase";
const NEW_PASS = "another-long-passphrase";

describe("runSecrets -- a failed vault write stays inside the command's error envelope", () => {
  let home: string;
  const io = { out: vi.fn(), err: vi.fn() };

  /** Every stderr line, each parsed as JSON; a line that is not JSON fails
   *  naming it, rather than as a bare SyntaxError over the joined stream. */
  const errLines = (): Array<Record<string, unknown>> =>
    io.err.mock.calls
      .map((c) => c[0] as string)
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          throw new Error(`stderr line is not JSON: ${l}`);
        }
      });

  /** The {"ok":false} envelope, which ends stderr. Warning lines may come
   *  first -- SECRETS_USAGE: key on "warning" vs "ok", never on line
   *  position -- so this parses the LAST line and requires `warning` on any
   *  before it, instead of assuming the envelope is the only line. */
  const errJson = (): { ok: boolean; error: string } => {
    const lines = errLines();
    expect(lines.length, "no JSON line on stderr").toBeGreaterThan(0);
    const envelope = lines[lines.length - 1];
    expect(envelope).toHaveProperty("ok", false);
    for (const line of lines.slice(0, -1)) expect(line).toHaveProperty("warning");
    return envelope as { ok: boolean; error: string };
  };

  beforeEach(() => {
    io.out.mockReset();
    io.err.mockReset();
    injected.code = null;
    injected.message = null;
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-savefail-"));
  });

  afterEach(() => {
    injected.code = null;
    injected.message = null;
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  /** Seed a real (successfully written) vault, then arm the injection. */
  async function seed(): Promise<void> {
    const probe = { out: vi.fn(), err: vi.fn() };
    const r = await runSecrets({ action: "set", name: "TOKEN", value: "v1", passphrase: PASS, home }, probe);
    expect(r.exitCode).toBe(0);
    lock();
  }

  it("set reports EACCES as JSON and exits 1", async () => {
    injected.code = "EACCES";
    const r = await runSecrets({ action: "set", name: "GH", value: "ghp", passphrase: PASS, home, json: true }, io);
    expect(r.exitCode).toBe(1);
    const parsed = errJson();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("EACCES");
    expect(parsed.error).toContain(vaultPath(home));
    expect(parsed.error).toContain("nothing was saved");
    // stdout stays EMPTY: the success line lives after saveVaultOrReport, and
    // moving it above would hand a --json caller a `{ok:true}` envelope for a
    // write that never landed.
    expect(io.out).not.toHaveBeenCalled();
  });

  it("remove reports ENOSPC as JSON and exits 1", async () => {
    await seed();
    injected.code = "ENOSPC";
    const r = await runSecrets(
      { action: "remove", name: "TOKEN", force: true, passphrase: PASS, home, json: true },
      io,
    );
    expect(r.exitCode).toBe(1);
    const parsed = errJson();
    // Same three claims the set case pins -- the errno, the file it is about,
    // and the guarantee that nothing was written.
    expect(parsed.error).toContain("ENOSPC");
    expect(parsed.error).toContain(vaultPath(home));
    expect(parsed.error).toContain("nothing was saved");
    expect(io.out).not.toHaveBeenCalled();
  });

  it("rotate reports EXDEV as JSON, drops the cached key, and exits 1", async () => {
    await seed();
    injected.code = "EXDEV";
    const r = await runSecrets({ action: "rotate", passphrase: PASS, newPassphrase: NEW_PASS, home, json: true }, io);
    expect(r.exitCode).toBe(1);
    const parsed = errJson();
    expect(parsed.error).toContain("EXDEV");
    expect(parsed.error).toContain(vaultPath(home));
    expect(parsed.error).toContain("nothing was saved");
    expect(io.out).not.toHaveBeenCalled();
    // rotate's save-failure exit deliberately lock()s (secrets-cmd.ts): the
    // caller was just told nothing was saved, so this process must not keep
    // holding a derived key for the vault it failed to replace.
    expect(isUnlocked()).toBe(false);
  });

  it("reset leaves the old vault untouched and removes its copy when the new vault cannot be written", async () => {
    await seed();
    const before = readFileSync(vaultPath(home), "utf8");
    injected.code = "EACCES";
    const r = await runSecrets({ action: "reset", force: true, passphrase: NEW_PASS, home, json: true }, io);
    expect(r.exitCode).toBe(1);
    const parsed = errJson();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("EACCES");
    expect(parsed.error).toContain(vaultPath(home));
    // Not "nothing was saved": that sentence is false here (a copy was
    // taken), and the one true statement is that the old vault is as it was
    // -- the new one is written over it atomically, so a failed write never
    // touches it.
    expect(parsed.error).toContain("the old vault is untouched");
    expect(parsed.error).not.toContain("nothing was saved");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    // The copy taken before the write is removed again: no `.reset-` sibling
    // survives a failed reset.
    expect(readdirSync(dirname(vaultPath(home))).filter((f) => f.includes(".reset-"))).toEqual([]);
    expect(io.out).not.toHaveBeenCalled();
  });

  it("keeps the envelope last when a warning line precedes it (a short env passphrase)", async () => {
    // The warning fires at the passphrase step, ahead of the failed write:
    // the documented shape, and the one a join-and-parse helper choked on.
    process.env.YAW_MCP_VAULT_PASSPHRASE = "abc";
    try {
      injected.code = "EACCES";
      const r = await runSecrets({ action: "set", name: "GH", value: "ghp", home, json: true }, io);
      expect(r.exitCode).toBe(1);
      const lines = errLines();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ warning: "short-passphrase", subject: "YAW_MCP_VAULT_PASSPHRASE" });
      expect(errJson().error).toContain("EACCES");
      expect(io.out).not.toHaveBeenCalled();
    } finally {
      delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    }
  });

  it("falls back to the error MESSAGE when the write failure carries no errno", async () => {
    // saveVaultOrReport reads `e.code` first. A rejection with no `code` (a
    // wrapper's plain Error, an EXDEV re-thrown by a helper) has to surface
    // its message rather than the string "undefined".
    injected.message = "the volume went away mid-write";
    const r = await runSecrets({ action: "set", name: "GH", value: "ghp", passphrase: PASS, home, json: true }, io);
    expect(r.exitCode).toBe(1);
    const parsed = errJson();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("the volume went away mid-write");
    expect(parsed.error).not.toContain("undefined");
    expect(io.out).not.toHaveBeenCalled();
  });

  it("prints prose (not JSON) on the same failure without --json", async () => {
    injected.code = "EACCES";
    const r = await runSecrets({ action: "set", name: "GH", value: "ghp", passphrase: PASS, home }, io);
    expect(r.exitCode).toBe(1);
    const text = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(text.startsWith("yaw-mcp secrets set:")).toBe(true);
    expect(text).toContain("EACCES");
    expect(io.out).not.toHaveBeenCalled();
  });
});

describe("runSecrets -- a failed vault read names the vault file", () => {
  let home: string;
  const io = { out: vi.fn(), err: vi.fn() };
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");

  beforeEach(() => {
    io.out.mockReset();
    io.err.mockReset();
    injected.loadCode = null;
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-readfail-"));
  });

  afterEach(() => {
    injected.loadCode = null;
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  // list and get take no baseline read, so loadVault's read is the only one
  // they make, and its error used to be printed as Node worded it: the errno
  // and the syscall, with no file named anywhere.
  it.each([
    ["list", "EIO"],
    ["get", "EACCES"],
  ] as const)("%s --json on a %s read names the vault path and the errno", async (action, code) => {
    injected.loadCode = code;
    const r = await runSecrets(
      action === "list" ? { action, home, json: true } : { action, name: "TOKEN", passphrase: PASS, home, json: true },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toBe(
      `${JSON.stringify({ ok: false, error: `could not read the vault file at ${vaultPath(home)} (${code}) -- fix that and re-run.` })}\n`,
    );
    expect(io.out).not.toHaveBeenCalled();
  });

  it("set names the file in the same sentence when the load's read fails after the baseline read passed", async () => {
    const probe = { out: vi.fn(), err: vi.fn() };
    expect(
      (await runSecrets({ action: "set", name: "TOKEN", value: "v1", passphrase: PASS, home }, probe)).exitCode,
    ).toBe(0);
    lock();
    const before = readFileSync(vaultPath(home), "utf8");
    injected.loadCode = "EIO";
    const r = await runSecrets({ action: "set", name: "GH", value: "ghp", passphrase: PASS, home }, io);
    expect(r.exitCode).toBe(1);
    // Without the fail-fast's closing "Nothing was written.": that refusal
    // is the baseline read's, and this baseline read succeeded.
    expect(errText()).toBe(
      `yaw-mcp secrets set: could not read the vault file at ${vaultPath(home)} (EIO) -- fix that and re-run.\n`,
    );
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    expect(io.out).not.toHaveBeenCalled();
  });
});
