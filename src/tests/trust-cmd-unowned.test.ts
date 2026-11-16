// `yaw-mcp trust` / `trust --revoke` over a `.yaw-mcp/` OUTSIDE $HOME that the
// ownership gate (paths.ts ownedByCurrentUser) skips. The gate has two
// branches: with process.geteuid (POSIX) it is a uid match that never reads
// YAW_MCP_ALLOW_UNOWNED_PROJECT_DIRS; without one (win32) that variable is the
// only opt-in. The message must name the variable on the second branch only.
//
// Both branches run on any host by stubbing process.geteuid, the same way
// paths.test.ts and guide-outside-home-trust.test.ts do. Its own file because
// the stub is process-global.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localBundlesPath } from "../local-bundles.js";
import { ALLOW_UNOWNED_ENV, CONFIG_DIRNAME, untrustedProjectDirReason } from "../paths.js";
import { displaySafe, runTrust } from "../trust-cmd.js";

const ORIG_GETEUID = Object.getOwnPropertyDescriptor(process, "geteuid");

let home: string;
let outside: string;
let cfgDir: string;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "yaw-mcp-trust-unowned-home-")));
  outside = realpathSync.native(mkdtempSync(join(tmpdir(), "yaw-mcp-trust-unowned-proj-")));
  cfgDir = join(outside, CONFIG_DIRNAME);
  mkdirSync(cfgDir);
  writeFileSync(localBundlesPath(cfgDir), JSON.stringify({ version: 1, servers: [] }));
});

afterEach(() => {
  if (ORIG_GETEUID) Object.defineProperty(process, "geteuid", ORIG_GETEUID);
  else delete (process as { geteuid?: unknown }).geteuid;
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** POSIX model: a uid nothing on this machine owns (Windows stat reports 0),
 *  so the candidate is a uid mismatch on every host. */
function stubForeignOwner(): void {
  Object.defineProperty(process, "geteuid", { value: () => 999_999_999, configurable: true, writable: true });
}

/** win32 model: no geteuid, ownership unverifiable. */
function stubNoGeteuid(): void {
  Object.defineProperty(process, "geteuid", { value: undefined, configurable: true, writable: true });
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    push: (s: string) => void out.push(s),
    pushErr: (s: string) => void err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

describe("untrustedProjectDirReason", () => {
  it("names the env opt-in only where the gate reads it", () => {
    stubForeignOwner();
    expect(untrustedProjectDirReason()).toBe("it is owned by another user");
    stubNoGeteuid();
    expect(untrustedProjectDirReason()).toContain(`${ALLOW_UNOWNED_ENV}=1`);
  });
});

describe("trust over a skipped outside-$HOME .yaw-mcp/", () => {
  it("POSIX: grant says another user owns it and does not name the env var", async () => {
    // RED with the old wording, which told every host to set the variable --
    // a knob the POSIX uid gate never reads.
    stubForeignOwner();
    const io = capture();
    const r = await runTrust({ home, cwd: outside, env: {}, yes: true, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(1);
    expect(io.errText()).toContain(`the .yaw-mcp/ at ${displaySafe(cfgDir)} is outside your home directory`);
    expect(io.errText()).toContain("owned by another user");
    expect(io.errText()).not.toContain(ALLOW_UNOWNED_ENV);
  });

  it("POSIX: revoke --json keeps the explicit-path advice and does not name the env var", async () => {
    stubForeignOwner();
    const io = capture();
    const r = await runTrust({
      mode: "revoke",
      json: true,
      home,
      cwd: outside,
      env: {},
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(io.text()) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("owned by another user");
    expect(parsed.error).toContain("pass an explicit path");
    expect(parsed.error).not.toContain(ALLOW_UNOWNED_ENV);
  });

  it("win32: grant and revoke name the env opt-in, and revoke the explicit path", async () => {
    stubNoGeteuid();
    const grant = capture();
    expect(
      (await runTrust({ home, cwd: outside, env: {}, yes: true, out: grant.push, err: grant.pushErr })).exitCode,
    ).toBe(1);
    expect(grant.errText()).toContain(displaySafe(cfgDir));
    expect(grant.errText()).toContain(`${ALLOW_UNOWNED_ENV}=1`);
    expect(grant.errText()).not.toContain("owned by another user");

    const revoke = capture();
    const r = await runTrust({ mode: "revoke", home, cwd: outside, env: {}, out: revoke.push, err: revoke.pushErr });
    expect(r.exitCode).toBe(1);
    expect(revoke.errText()).toContain(`${ALLOW_UNOWNED_ENV}=1`);
    expect(revoke.errText()).toContain("pass an explicit path");
  });
});
