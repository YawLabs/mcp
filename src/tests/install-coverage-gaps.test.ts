// Coverage-gap tests for install / uninstall argv parsing and the stored
// oam-entry adoption gate. Each case names the edit that turns it red.
//
// HERMETIC: the runInstall cases run against a throwaway home under the OS
// temp dir, with the oam probe and the durable-entry resolver passed as
// seams, so no case reads this machine's client configs or spawns a real oam.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInstallArgs, parseUninstallArgs, runInstall } from "../install-cmd.js";
import { ENTRY_NAME } from "../install-targets.js";
import { MIN_OAM_VERSION, type OamProbe } from "../oam-spawn.js";

describe("parseUninstallArgs --project-dir refuses a following flag as its value", () => {
  // RED when parseSiteFlag drops `looksLikeFlag(value)` from its
  // --project-dir guard: `--dry-run` / `-y` becomes the directory, and the
  // preview flag the user typed is silently gone.
  it.each([["--dry-run"], ["-y"]])("uninstall --project-dir %s is an argv error", (flag) => {
    const r = parseUninstallArgs(["claude-code", "--project-dir", flag]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("--project-dir requires a value");
      expect(r.help).toBeUndefined();
    }
  });
});

describe("--scope and --os refuse a value outside their allow-list, for install and uninstall", () => {
  const parsers = [
    ["install", parseInstallArgs],
    ["uninstall", parseUninstallArgs],
  ] as const;

  // RED when the --scope allow-list check in parseSiteFlag is reduced to a
  // presence check (`if (!value) return ...`): `global` parses as a scope.
  // Only the `global` case guards the allow-list; the trailing `--scope` case
  // pins the message, since the presence check alone already refuses it.
  it.each(parsers)("%s --scope global / trailing --scope -> --scope requires user|project|local", (_verb, parse) => {
    for (const argv of [
      ["claude-code", "--scope", "global"],
      ["claude-code", "--scope"],
    ]) {
      const r = parse(argv);
      expect(r).toEqual({ ok: false, error: "--scope requires user|project|local" });
    }
  });

  // RED when the --os allow-list check in parseSiteFlag is reduced to a
  // presence check: `darwin` parses as an OS. As above, the trailing `--os`
  // case pins the message only.
  it.each(parsers)("%s --os darwin / trailing --os -> --os requires macos|linux|windows", (_verb, parse) => {
    for (const argv of [
      ["claude-code", "--os", "darwin"],
      ["claude-code", "--os"],
    ]) {
      const r = parse(argv);
      expect(r).toEqual({ ok: false, error: "--os requires macos|linux|windows" });
    }
  });
});

describe("install does not adopt a stored oam entry under an npx cache (_npx) directory", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-cov-gaps-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function captureIo() {
    const out: string[] = [];
    const err: string[] = [];
    const sink = (arr: string[]): NodeJS.WritableStream =>
      new Writable({
        write(chunk: Buffer, _enc, cb): void {
          arr.push(chunk.toString());
          cb();
        },
      }) as unknown as NodeJS.WritableStream;
    return {
      io: { stdin: process.stdin, stdout: sink(out), stderr: sink(err), isTTY: false },
      stdout: () => out.join(""),
      stderr: () => err.join(""),
    };
  }

  const OAM_BIN = "/usr/local/bin/oam";
  const OAM_PRESENT = async (): Promise<OamProbe> => ({
    bin: OAM_BIN,
    binPath: OAM_BIN,
    version: MIN_OAM_VERSION,
    belowMin: false,
    failure: null,
    failureDetail: null,
  });
  const clientFile = (): string => join(home, ".claude.json");
  const base = () => ({
    clientId: "claude-code" as const,
    scope: "user" as const,
    os: "linux" as const,
    home,
    oamProbe: OAM_PRESENT,
    suppressBundlesNote: true,
    resolveOamEntry: () => null,
  });

  /** A REAL entry file inside a node_modules/@yawlabs/mcp tree, but under
   *  the npx cache, which npm can evict at any time. */
  function seedNpxCacheEntry(): void {
    const entry = join(home, ".npm", "_npx", "abc123", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "// broker entry\n", "utf8");
    writeFileSync(
      clientFile(),
      `${JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: OAM_BIN, args: ["run", "--no-check", entry] } } }, null, 2)}\n`,
      "utf8",
    );
  }

  // RED when storedOamEntryFile drops `|| shape.includes("/_npx/")`: the
  // npx-cache path is adopted as durable, and the run is a no-op (exit 0)
  // that keeps the evictable path, and --repair leaves it on oam.
  it("reads the _npx entry as drift off a TTY, and --repair rewrites it to npx", async () => {
    seedNpxCacheEntry();
    const before = readFileSync(clientFile(), "utf8");

    const refused = captureIo();
    const off = await runInstall({ ...base(), io: refused.io });
    expect(off.exitCode).toBe(2);
    expect(off.collisionRefused).toBe(true);
    expect(readFileSync(clientFile(), "utf8")).toBe(before);

    const cap = captureIo();
    const r = await runInstall({ ...base(), io: cap.io, repair: true });
    expect(r.exitCode).toBe(0);
    const stored = JSON.parse(readFileSync(clientFile(), "utf8")).mcpServers[ENTRY_NAME];
    expect(stored).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
  });
});
