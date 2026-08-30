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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { injected } = vi.hoisted(() => ({ injected: { code: null as string | null } }));

vi.mock("../secrets-vault.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets-vault.js")>();
  return {
    ...actual,
    saveVault: async (path: string, vault: Parameters<typeof actual.saveVault>[1]) => {
      if (injected.code !== null) {
        const err: NodeJS.ErrnoException = new Error(`${injected.code}: injected write failure, open '${path}'`);
        err.code = injected.code;
        throw err;
      }
      return actual.saveVault(path, vault);
    },
  };
});

import { runSecrets } from "../secrets-cmd.js";
import { lock, vaultPath } from "../secrets-vault.js";

const PASS = "a-long-enough-passphrase";
const NEW_PASS = "another-long-passphrase";

describe("runSecrets -- a failed vault write stays inside the command's error envelope", () => {
  let home: string;
  const io = { out: vi.fn(), err: vi.fn() };

  const errJson = (): { ok: boolean; error: string } =>
    JSON.parse(
      io.err.mock.calls
        .map((c) => c[0] as string)
        .join("")
        .trim(),
    );

  beforeEach(() => {
    io.out.mockReset();
    io.err.mockReset();
    injected.code = null;
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-savefail-"));
  });

  afterEach(() => {
    injected.code = null;
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
  });

  it("remove reports ENOSPC as JSON and exits 1", async () => {
    await seed();
    injected.code = "ENOSPC";
    const r = await runSecrets(
      { action: "remove", name: "TOKEN", force: true, passphrase: PASS, home, json: true },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errJson().error).toContain("ENOSPC");
  });

  it("rotate reports EXDEV as JSON and exits 1", async () => {
    await seed();
    injected.code = "EXDEV";
    const r = await runSecrets({ action: "rotate", passphrase: PASS, newPassphrase: NEW_PASS, home, json: true }, io);
    expect(r.exitCode).toBe(1);
    expect(errJson().error).toContain("EXDEV");
  });

  it("prints prose (not JSON) on the same failure without --json", async () => {
    injected.code = "EACCES";
    const r = await runSecrets({ action: "set", name: "GH", value: "ghp", passphrase: PASS, home }, io);
    expect(r.exitCode).toBe(1);
    const text = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(text.startsWith("yaw-mcp secrets set:")).toBe(true);
    expect(text).toContain("EACCES");
  });
});
