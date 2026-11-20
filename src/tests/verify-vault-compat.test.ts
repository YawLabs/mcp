import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isMainModule } from "../../scripts/check-installed-deps.mjs";
import { evaluateV3Run, gateMessage, TARGETS, WRONG_PASSPHRASE } from "../../scripts/verify-vault-v3-compat.mjs";

// The half of scripts/verify-vault-v3-compat.mjs that needs no network: what
// each SHIPPED build must say to the checked-in v3 fixture, and the verdict
// that turns one probe's run + before/after sha256 into an OK or a FAIL line.
// The script itself (`npm run verify:vault-compat`) still packs and installs
// three real builds; nothing here spawns anything -- the verdict function takes
// the run and the re-read as arguments precisely so it can be driven in
// isolation (the unreadable-after-run branch is otherwise only reachable by
// having a shipped build delete the vault).
const VAULT = "/home/u/.yaw-mcp/secrets.json";
const VALUE = "ghp_fixture_v3";
// The same digest main computes over the file, so a message carrying both
// sha256s can be checked exactly.
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const okRun = { status: 1, stdout: "", stderr: `some text ${gateMessage(VAULT, 1)}`, error: undefined };

describe("verify-vault-v3-compat: the messages each build must give", () => {
  it("probes exactly the three boundary builds", () => {
    expect(TARGETS.map((t) => t.version)).toEqual(["0.73.1", "1.1.13", "0.73.0"]);
  });

  it("0.73.1 gates with schema 3 > 1, naming the vault path", () => {
    const msg = TARGETS[0].expected(VAULT);
    expect(msg).toBe(gateMessage(VAULT, 1));
    expect(msg).toContain("schema version 3 > 1");
    expect(msg).toContain(VAULT); // the gated message names the file
    expect(msg).toContain("upgrade yaw-mcp to read it");
  });

  it("1.1.13 gates with schema 3 > 2 -- the two builds disagree, so the table is not one string reused", () => {
    const msg = TARGETS[1].expected(VAULT);
    expect(msg).toBe(gateMessage(VAULT, 2));
    expect(msg).toContain("schema version 3 > 2");
    expect(msg).not.toBe(TARGETS[0].expected(VAULT));
    // Own-max is the only difference: same file version, same wording.
    expect(msg.replace("3 > 2", "3 > 1")).toBe(TARGETS[0].expected(VAULT));
  });

  it("0.73.0 has no gate: it reports the misleading wrong passphrase, path-independently", () => {
    expect(TARGETS[2].expected(VAULT)).toBe(WRONG_PASSPHRASE);
    expect(WRONG_PASSPHRASE).toBe("wrong passphrase for this vault (decryption failed)");
    // No gate means no path in the message (and nothing about a schema).
    expect(TARGETS[2].expected("/elsewhere/secrets.json")).toBe(WRONG_PASSPHRASE);
    expect(TARGETS[2].expected(VAULT)).not.toContain(VAULT);
    expect(TARGETS[2].expected(VAULT)).not.toContain("schema version");
  });
});

describe("verify-vault-v3-compat: the per-build verdict", () => {
  const base = { version: "0.73.1", vault: VAULT, before: sha("unchanged"), value: VALUE };
  const read = () => Buffer.from("unchanged");

  it("passes only on non-zero exit + expected stderr + no leak + unchanged vault", () => {
    const verdict = evaluateV3Run({ ...base, expected: TARGETS[0].expected, run: okRun, read });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toMatch(/^\[verify:vault-v3-compat\] OK -- 0\.73\.1 on v3: exit 1,/);
    expect(verdict.message).toContain(`vault bytes unchanged (sha256 ${sha("unchanged")})`);
  });

  it("FAILs when the vault's bytes changed, naming both sha256s (failure counted, not a pass)", () => {
    // Same everything as the passing case except the file on disk.
    const verdict = evaluateV3Run({
      ...base,
      expected: TARGETS[0].expected,
      run: okRun,
      read: () => Buffer.from("rewritten"),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("0.73.1 on v3: expected a non-zero exit");
    expect(verdict.message).toContain("vault changed");
    expect(verdict.message).toContain(`sha256 ${sha("unchanged")} -> ${sha("rewritten")}`);
    expect(verdict.message).not.toContain("OK --");
  });

  it("FAILs when the vault is unreadable after the run, as a message rather than a thrown stack", () => {
    // main() counts this as a failure for THIS build and carries on to the
    // remaining TARGETS; a raw throw would escape main and lose its report.
    const verdict = evaluateV3Run({
      ...base,
      expected: TARGETS[0].expected,
      run: okRun,
      read: () => {
        throw new Error("EACCES: permission denied, open '/home/u/.yaw-mcp/secrets.json'");
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("0.73.1 on v3: vault unreadable after the run");
    expect(verdict.message).toContain("EACCES: permission denied");
    expect(verdict.message).toContain(`before: sha256 ${sha("unchanged")}`);
    // Not a stack: one line, no frames, so `fail()`'s prefix stays readable.
    expect(verdict.message).not.toMatch(/\r?\n/);
    expect(verdict.message).not.toMatch(/^\s*at /m);
  });

  it("FAILs on a decrypted value in either stream", () => {
    const verdict = evaluateV3Run({
      ...base,
      expected: TARGETS[2].expected, // 0.73.0: its message is path-free, so only `leak` can fail it here
      run: { status: 1, stdout: VALUE, stderr: WRONG_PASSPHRASE, error: undefined },
      read,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("no decrypted value");
  });

  it("FAILs on a zero exit or the wrong message", () => {
    for (const run of [
      { status: 0, stdout: "", stderr: gateMessage(VAULT, 1), error: undefined },
      { status: 1, stdout: "", stderr: "something else entirely", error: undefined },
    ]) {
      const verdict = evaluateV3Run({ ...base, expected: TARGETS[0].expected, run, read });
      expect(verdict.ok).toBe(false);
      expect(verdict.message).toContain("expected a non-zero exit with stderr containing");
    }
  });
});

describe("verify-vault-v3-compat: importing it does not run it", () => {
  it("isMainModule is false under vitest, so the network probe never starts", () => {
    const scriptUrl = new URL("../../scripts/verify-vault-v3-compat.mjs", import.meta.url);
    expect(isMainModule(process.argv[1], scriptUrl.href)).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
