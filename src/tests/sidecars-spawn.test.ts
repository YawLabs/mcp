// `sidecars install`'s DEFAULT npm runner -- the one that actually spawns.
//
// The sibling sidecars-cmd.test.ts injects `runNpm` everywhere, which is the
// right shape for the collect/manifest/report logic but structurally cannot
// observe the spawn. That left the spawn options untested, and BOTH production
// bugs this file has had lived exactly there: npm failing EINVAL on Windows
// because Node will not exec a .cmd shim without a shell, and the child's
// stdout being inherited so npm's progress landed ahead of the JSON document
// and made `--json` unparseable. Both were caught by hand. Neither would have
// survived this file.
//
// Split out (rather than added to the sibling) because the mock is
// module-scoped -- same reason oam-probe-options.test.ts is its own file.

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnCall {
  bin: string;
  args: string[];
  opts: Record<string, unknown>;
}

const spawnCalls: SpawnCall[] = [];
/** Exit code the fake npm reports; null + a signal models a killed child. */
let exitCode: number | null = 0;
let exitSignal: string | null = null;
/** When set, spawn() throws it -- npm missing from PATH entirely. */
let spawnThrows: Error | null = null;
/** When set, the child emits 'error' instead of exiting. */
let childError: Error | null = null;

vi.mock("node:child_process", () => ({
  spawn: (bin: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ bin, args: [...(args ?? [])], opts: { ...opts } });
    if (spawnThrows) throw spawnThrows;
    const child = new EventEmitter();
    setTimeout(() => {
      if (childError) {
        child.emit("error", childError);
        return;
      }
      child.emit("close", exitCode, exitSignal);
    }, 0);
    return child;
  },
}));

const { runSidecarsInstall, sidecarsRoot } = await import("../sidecars-cmd.js");

describe("sidecars install default npm runner", () => {
  let home: string;
  const realPlatform = process.platform;

  const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p });

  beforeEach(() => {
    spawnCalls.length = 0;
    exitCode = 0;
    exitSignal = null;
    spawnThrows = null;
    childError = null;
    home = mkdtempSync(join(tmpdir(), "sidecar-spawn-"));
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(
      join(home, ".yaw-mcp", "bundles.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: "1",
            name: "F",
            namespace: "fetch",
            type: "local",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@yawlabs/fetch-mcp@latest"],
          },
        ],
      }),
    );
  });

  afterEach(() => {
    setPlatform(realPlatform);
    rmSync(home, { recursive: true, force: true });
  });

  const run = () => runSidecarsInstall({ home, cwd: home, out: () => {} });

  it("keeps npm's own output off stdout so --json stays parseable", async () => {
    // THE regression this file exists for. npm writes its progress ("added 220
    // packages in 12s") to STDOUT; inheriting that put it ahead of the JSON
    // document, so `sidecars install --json | jq` failed outright. fd 2 keeps
    // the progress visible without it landing in the parsed stream.
    setPlatform("linux");

    await run();

    expect(spawnCalls).toHaveLength(1);
    const stdio = spawnCalls[0].opts.stdio as unknown[];
    expect(stdio[1], "npm stdout must not reach the caller's stdout").toBe(2);
    // stdin closed (nothing to answer with), stderr inherited (progress).
    expect(stdio[0]).toBe("ignore");
    expect(stdio[2]).toBe("inherit");
  });

  it("goes through the shell on Windows, where npm is a .cmd shim", async () => {
    // Node refuses to exec .cmd/.bat directly since the CVE-2024-27980 fix and
    // fails EINVAL before the process starts -- observed, not theoretical.
    setPlatform("win32");

    await run();

    expect(spawnCalls[0].bin).toBe("npm.cmd");
    expect(spawnCalls[0].opts.shell).toBe(true);
  });

  it("does NOT use a shell off Windows", async () => {
    // The shell is a Windows-only concession; taking it everywhere would put a
    // command line through an extra parser for no reason.
    setPlatform("linux");

    await run();

    expect(spawnCalls[0].bin).toBe("npm");
    expect(spawnCalls[0].opts.shell).toBe(false);
  });

  it("runs npm in the managed directory, never in the caller's cwd", async () => {
    // `cwd` travels as a spawn OPTION rather than in the command line, which
    // is what makes the Windows shell above safe -- no user-controlled path is
    // ever parsed by cmd. If this moved into the args it would be injectable.
    setPlatform("linux");

    await run();

    expect(spawnCalls[0].opts.cwd).toBe(sidecarsRoot(home));
    expect(spawnCalls[0].args).toEqual(["install", "--no-audit", "--no-fund"]);
    expect(spawnCalls[0].args.join(" ")).not.toContain(home);
  });

  it("reports failure when npm cannot be spawned at all", async () => {
    // npm missing from PATH. The command must degrade to "your servers keep
    // using npx", not crash the CLI.
    setPlatform("linux");
    childError = new Error("spawn npm ENOENT");

    const res = await run();

    expect(res.exitCode).toBe(1);
    expect(res.lines.join("\n")).toContain("npx cache");
  });

  it("treats a signal death as failure rather than success", async () => {
    // `close` reports code null when the child died on a signal; reading that
    // as 0 would declare an interrupted install (Ctrl-C, OOM) successful.
    setPlatform("linux");
    exitCode = null;
    exitSignal = "SIGKILL";

    const res = await run();

    expect(res.exitCode).toBe(1);
  });
});
