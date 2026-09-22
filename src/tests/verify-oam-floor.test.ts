// scripts/verify-oam-floor.mjs -- the only thing allowed to raise
// MIN_OAM_VERSION, and the gate release.sh runs in step 1.
//
// Three harness shapes, none of which needs oam on the machine:
//
//   PURE -- the version helpers, the floor reader and the three-file raise are
//   pure functions over strings, driven directly. The comparator is pinned to
//   the package's own compareVersions so the script's copy (node cannot import
//   the .ts) cannot drift from what the broker enforces at spawn time.
//
//   STUBBED SPAWN -- `oam --version` goes through an injected spawn that plays
//   back a scripted child, and the hosting probe through an injected function,
//   so every branch of the run (absent oam, wrong OAM_BIN, a probe that fails,
//   an oam below / at / above the floor, --raise on each) is driven without a
//   process. The one real spawn is the probe itself, run against node hosting
//   the same server oam would host, which is how the probe and the server get
//   verified on a machine with no oam.
//
//   SUBPROCESS -- the script as `npm run verify:oam-floor` runs it, with
//   OAM_BIN pointed at nothing, to pin the CLI wiring: the FAIL line, the exit
//   code, and that it installs nothing.

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import {
  BLOCK_HEAD,
  compareVersions,
  FLOOR_CHANGELOG,
  FLOOR_SRC,
  FLOOR_TEST,
  installCommand,
  isPrerelease,
  oamVersion,
  PROBE_SERVER,
  parseArgs,
  parseVersion,
  probeHosting,
  REPO_ROOT,
  raiseFloorText,
  readFloor,
  renderFloorBlock,
  resolveOamBin,
  TAG,
  type VerifyDeps,
  verifyOamFloor,
} from "../../scripts/verify-oam-floor.mjs";
import { compareVersions as brokerCompare, MIN_OAM_VERSION, parseOamVersion } from "../oam-spawn.js";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // A leaked temp dir is not worth failing a suite over.
    }
  }
});

// ---------------------------------------------------------------------------
// PURE
// ---------------------------------------------------------------------------

describe("verify-oam-floor version helpers", () => {
  it("compares versions exactly as the broker's compareVersions does", () => {
    // The script cannot import src/oam-spawn.ts, so it carries a copy. Every
    // pair here is one the broker's own tests care about: numeric parts,
    // prerelease precedence, build metadata, and unparseable input.
    const pairs: [string, string][] = [
      ["0.16.3", "0.16.3"],
      ["0.16.2", "0.16.3"],
      ["0.9.9", "0.10.0"],
      ["1.0.0", "0.99.99"],
      ["0.17.0-rc.1", "0.17.0"],
      ["0.17.0-rc.1", "0.17.0-rc.2"],
      ["0.17.0-rc.10", "0.17.0-rc.9"],
      ["0.17.0-alpha", "0.17.0-alpha.1"],
      ["0.17.0-1", "0.17.0-a"],
      ["0.16.3+build.5", "0.16.3"],
      ["v0.16.3", "0.16.3"],
      ["garbage", "0.16.3"],
    ];
    for (const [a, b] of pairs) {
      expect(Math.sign(compareVersions(a, b)), `${a} vs ${b}`).toBe(Math.sign(brokerCompare(a, b)));
      expect(Math.sign(compareVersions(b, a)), `${b} vs ${a}`).toBe(Math.sign(brokerCompare(b, a)));
    }
  });

  it("parses `oam --version` output the way parseOamVersion does", () => {
    for (const out of ["oam 0.16.3", "oam 0.16.3\n", "0.17.0-rc.1+sha.abc", "oam version: 1.2.3 (x64)", "no version"]) {
      expect(parseVersion(out), out).toBe(parseOamVersion(out));
    }
  });

  it("knows a prerelease from a release", () => {
    expect(isPrerelease("0.17.0-rc.1")).toBe(true);
    expect(isPrerelease("0.17.0")).toBe(false);
    expect(isPrerelease("0.17.0+build")).toBe(false);
    expect(isPrerelease("nope")).toBe(false);
  });

  it("parses --raise and --help, and refuses anything else", () => {
    expect(parseArgs([])).toEqual({ ok: true, raise: false, help: false });
    expect(parseArgs(["--raise"])).toEqual({ ok: true, raise: true, help: false });
    expect(parseArgs(["--help"])).toMatchObject({ ok: true, help: true });
    const bad = parseArgs(["--raise", "--bogus"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("unknown option --bogus");
  });

  it("resolves the binary the way the broker's probe does", () => {
    expect(resolveOamBin({}, "linux")).toEqual({ bin: "oam", explicit: false });
    expect(resolveOamBin({}, "win32")).toEqual({ bin: "oam.exe", explicit: false });
    expect(resolveOamBin({ OAM_BIN: "/opt/oam/bin/oam" }, "win32")).toEqual({
      bin: "/opt/oam/bin/oam",
      explicit: true,
    });
    expect(installCommand("win32")).toContain("install.ps1");
    expect(installCommand("darwin")).toContain("install.sh");
  });
});

describe("verify-oam-floor readFloor", () => {
  it("reads the real MIN_OAM_VERSION out of src/oam-spawn.ts", () => {
    // The regex and the constant's spelling are a contract: a reformatted
    // line would make the verifier -- and so release.sh's gate -- stop dead.
    expect(readFloor(readFileSync(join(REPO_ROOT, FLOOR_SRC), "utf8"))).toBe(MIN_OAM_VERSION);
  });

  it("refuses a source with no MIN_OAM_VERSION line, and one with two", () => {
    expect(() => readFloor("export const OTHER = 1;\n")).toThrow("expected exactly one MIN_OAM_VERSION line, found 0");
    const two = 'export const MIN_OAM_VERSION = "0.1.0";\nexport const MIN_OAM_VERSION = "0.2.0";\n';
    expect(() => readFloor(two)).toThrow("found 2");
  });
});

/** The three files a raise touches, shaped like the real ones. */
function fixture(floor = "0.16.3", ratchet = floor) {
  return {
    src: ["// fixture", "/** doc */", `export const MIN_OAM_VERSION = "${floor}";`, "export const OTHER = 1;", ""].join(
      "\n",
    ),
    test: ['describe("MIN_OAM_VERSION freshness floor", () => {', `  const FLOOR = "${ratchet}";`, "});", ""].join(
      "\n",
    ),
    changelog: [
      "# Changelog",
      "",
      "## Unreleased -- things",
      "",
      "**Fixed -- something**",
      "",
      "A paragraph.",
      "",
      "## 1.0.10 -- older",
      "",
      "Old text.",
      "",
    ].join("\n"),
  };
}

describe("verify-oam-floor raiseFloorText", () => {
  it("moves the constant, the ratchet literal and a changelog block together, naming the floor that was there", () => {
    const r = raiseFloorText({ ...fixture(), next: "0.17.0", day: "2026-09-21" });
    expect(r.prev).toBe("0.16.3");
    expect(r.src).toBe(fixture("0.17.0").src);
    expect(r.test).toBe(fixture("0.17.0").test);
    const block = renderFloorBlock({ next: "0.17.0", prev: "0.16.3", day: "2026-09-21" });
    expect(block[0]).toBe(`${BLOCK_HEAD}0.17.0**`);
    expect(block[2]).toContain(
      "`npm run verify:oam-floor` hosted a stdio `@modelcontextprotocol/sdk` server on oam v0.17.0",
    );
    expect(block[2]).toContain("on 2026-09-21");
    expect(block[2]).toContain("the floor was 0.16.3");
    expect(block[2]).toContain("`oam self-update`");
    // At the END of the Unreleased section, above the release before it, with
    // one blank line each side.
    expect(r.changelog).toBe(
      [
        "# Changelog",
        "",
        "## Unreleased -- things",
        "",
        "**Fixed -- something**",
        "",
        "A paragraph.",
        "",
        ...block,
        "",
        "## 1.0.10 -- older",
        "",
        "Old text.",
        "",
      ].join("\n"),
    );
  });

  it("appends at the end of the file when Unreleased is the only section, keeping one trailing newline", () => {
    const f = fixture();
    f.changelog = "# Changelog\n\n## Unreleased -- things\n\nA paragraph.\n";
    const r = raiseFloorText({ ...f, next: "0.17.0", day: "2026-09-21" });
    const block = renderFloorBlock({ next: "0.17.0", prev: "0.16.3", day: "2026-09-21" }).join("\n");
    expect(r.changelog.endsWith(`A paragraph.\n\n${block}\n`)).toBe(true);
    expect(r.changelog.endsWith("\n\n")).toBe(false);
  });

  it("keeps a CRLF changelog CRLF", () => {
    const f = fixture();
    f.changelog = f.changelog.replace(/\n/g, "\r\n");
    const r = raiseFloorText({ ...f, next: "0.17.0", day: "2026-09-21" });
    expect(/(^|[^\r])\n/.test(r.changelog)).toBe(false);
    expect(r.changelog).toContain(`${BLOCK_HEAD}0.17.0**\r\n`);
  });

  it("skips ## lines inside code fences when it looks for the end of the section", () => {
    const f = fixture();
    f.changelog = [
      "# Changelog",
      "",
      "## Unreleased -- things",
      "",
      "```",
      "## not a heading",
      "```",
      "",
      "After the fence.",
      "",
      "## 1.0.10 -- older",
      "",
    ].join("\n");
    const r = raiseFloorText({ ...f, next: "0.17.0", day: "2026-09-21" });
    expect(r.changelog.indexOf(BLOCK_HEAD)).toBeGreaterThan(r.changelog.indexOf("After the fence."));
    expect(r.changelog.indexOf(BLOCK_HEAD)).toBeLessThan(r.changelog.indexOf("## 1.0.10"));
  });

  it("refuses, touching nothing, a fence that never closes, a first section that is not Unreleased, and a block already there", () => {
    const f = fixture();
    const unclosed = { ...f, changelog: "# Changelog\n\n## Unreleased -- x\n\n```\n## 1.0.10 -- older\n" };
    expect(() => raiseFloorText({ ...unclosed, next: "0.17.0", day: "d" })).toThrow("never closes");
    const shipped = { ...f, changelog: "# Changelog\n\n## 1.0.11 -- x\n\nText.\n" };
    expect(() => raiseFloorText({ ...shipped, next: "0.17.0", day: "d" })).toThrow(
      '"## 1.0.11 -- x", not ## Unreleased',
    );
    const doubled = {
      ...f,
      changelog: f.changelog.replace("A paragraph.", `A paragraph.\n\n${BLOCK_HEAD}0.17.0**\n\nEarlier.`),
    };
    expect(() => raiseFloorText({ ...doubled, next: "0.17.0", day: "d" })).toThrow(
      "already holds a block for a floor of 0.17.0",
    );
  });

  it("refuses to lower the floor, to leave it where it is, or to raise it to a prerelease", () => {
    expect(() => raiseFloorText({ ...fixture(), next: "0.16.2", day: "d" })).toThrow(
      "refusing to LOWER the floor from 0.16.3 to 0.16.2",
    );
    expect(() => raiseFloorText({ ...fixture(), next: "0.16.3", day: "d" })).toThrow("the floor is already 0.16.3");
    expect(() => raiseFloorText({ ...fixture(), next: "0.17.0-rc.1", day: "d" })).toThrow(
      "a prerelease is never a floor",
    );
  });

  it("refuses when the ratchet literal is missing, so the constant cannot move without it", () => {
    const f = fixture();
    f.test = "describe('no ratchet here', () => {});\n";
    expect(() => raiseFloorText({ ...f, next: "0.17.0", day: "d" })).toThrow(
      `${FLOOR_TEST}: expected exactly one const FLOOR line, found 0`,
    );
  });
});

// ---------------------------------------------------------------------------
// STUBBED SPAWN
// ---------------------------------------------------------------------------

type Scripted = { stdout?: string; exit?: number | null; error?: NodeJS.ErrnoException; hang?: boolean };

/** A child that plays back one script: an `error` event, or some stdout then
 *  a `close` with the exit code. Shaped like enough of ChildProcess for
 *  oamVersion, which is the only consumer. */
function scriptedSpawn(script: Scripted, calls: string[][] = []) {
  return ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void; killed: boolean };
    child.stdout = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", null));
    };
    setImmediate(() => {
      if (script.error) {
        child.emit("error", script.error);
        return;
      }
      if (script.hang) return;
      child.stdout.end(script.stdout ?? "");
      setImmediate(() => child.emit("close", script.exit ?? 0));
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

function enoent(): NodeJS.ErrnoException {
  const e = new Error("spawn oam ENOENT") as NodeJS.ErrnoException;
  e.code = "ENOENT";
  return e;
}

describe("verify-oam-floor oamVersion", () => {
  it("resolves the version `oam --version` printed", async () => {
    const calls: string[][] = [];
    await expect(oamVersion("oam", { spawn: scriptedSpawn({ stdout: "oam 0.16.3\n" }, calls) })).resolves.toBe(
      "0.16.3",
    );
    expect(calls).toEqual([["oam", "--version"]]);
  });

  it("rejects with the spawn error itself, so ENOENT keeps its code", async () => {
    await expect(oamVersion("oam", { spawn: scriptedSpawn({ error: enoent() }) })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a non-zero exit, output with no version in it, and a binary that never answers", async () => {
    await expect(oamVersion("oam", { spawn: scriptedSpawn({ exit: 2 }) })).rejects.toThrow("`oam --version` exited 2");
    await expect(oamVersion("oam", { spawn: scriptedSpawn({ stdout: "hello" }) })).rejects.toThrow(
      "printed no version",
    );
    await expect(oamVersion("oam", { spawn: scriptedSpawn({ hang: true }), timeoutMs: 50 })).rejects.toThrow(
      "did not answer within 50 ms",
    );
  });
});

describe("verify-oam-floor probeHosting", () => {
  // The real probe against node hosting the real server: initialize,
  // tools/list and tools/call over stdio, exactly what `oam run` would carry.
  // This is the case that proves the server is a working SDK server before
  // anyone blames oam for it.
  it("completes initialize + tools/list + tools/call against the probe server on node", async () => {
    const r = await probeHosting({ command: process.execPath, args: [join(REPO_ROOT, PROBE_SERVER)], cwd: REPO_ROOT });
    expect(r.tools).toEqual(["ping"]);
    expect(r.reply).toMatch(/^pong:\d+-\d+$/);
    expect(r.ms).toBeGreaterThan(0);
  });

  it("rejects with the server's stderr tail when the child dies before initialize", async () => {
    await expect(
      probeHosting({
        command: process.execPath,
        args: ["-e", 'console.error("boom: no such module"); process.exit(3)'],
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/server stderr \(tail\): boom: no such module/);
  });

  it("rejects a server that answers tools/list without the probe's tool", async () => {
    // A stdio server that speaks MCP but is not ours: the probe must not pass
    // on a well-formed reply that proves nothing about the entry it named.
    const src = `
let buf = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "other", version: "1" } });
    else if (msg.method === "tools/list") reply(msg.id, { tools: [{ name: "other", inputSchema: { type: "object" } }] });
    else if (msg.id !== undefined) reply(msg.id, {});
  }
});
process.stdin.resume();
`;
    await expect(probeHosting({ command: process.execPath, args: ["-e", src], timeoutMs: 10_000 })).rejects.toThrow(
      'tools/list answered ["other"], not the probe\'s ["ping"]',
    );
  });
});

/** Drive verifyOamFloor over an in-memory repo. Returns the lines it printed,
 *  the files as they stand afterwards, and every probe call it made. */
function drive(opts: {
  raise?: boolean;
  installed?: string | NodeJS.ErrnoException | Error;
  probe?: "ok" | Error;
  floor?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  src?: string;
}) {
  const files: Record<string, string> = { ...fixture(opts.floor ?? "0.16.3") };
  const byPath: Record<string, string> = {
    [FLOOR_SRC]: files.src,
    [FLOOR_TEST]: files.test,
    [FLOOR_CHANGELOG]: files.changelog,
  };
  if (opts.src !== undefined) byPath[FLOOR_SRC] = opts.src;
  const lines: string[] = [];
  const probes: { command: string; args: string[]; cwd: string; timeoutMs: number }[] = [];
  const writes: string[] = [];
  const deps: VerifyDeps = {
    env: opts.env ?? {},
    platform: opts.platform ?? "linux",
    cwd: "/repo",
    out: (l) => lines.push(l),
    oamVersion: async () => {
      const v = opts.installed ?? "0.16.3";
      if (typeof v === "string") return v;
      throw v;
    },
    probeHosting: async (o) => {
      probes.push(o);
      if (opts.probe instanceof Error) throw opts.probe;
      return { tools: ["ping"], reply: "pong:1-1", ms: 42 };
    },
    readFile: (p) => {
      if (!(p in byPath)) throw new Error(`fixture has no ${p}`);
      return byPath[p];
    },
    writeFile: (p, t) => {
      writes.push(p);
      byPath[p] = t;
    },
    day: "2026-09-21",
  };
  const run = () => verifyOamFloor({ raise: opts.raise }, deps);
  return { run, lines, probes, writes, files: byPath };
}

describe("verify-oam-floor verifyOamFloor", () => {
  it("passes on an oam at the floor that hosts the probe, spawning `oam run <probe server>` in the repo", async () => {
    const d = drive({});
    expect(await d.run()).toBe(0);
    expect(d.probes).toEqual([{ command: "oam", args: ["run", PROBE_SERVER], cwd: "/repo", timeoutMs: 30_000 }]);
    expect(d.lines.at(-1)).toBe(
      `${TAG} OK -- oam 0.16.3 hosts a stdio @modelcontextprotocol/sdk server (initialize + tools/list + tools/call); the floor 0.16.3 stands`,
    );
    expect(d.lines.join("\n")).not.toContain("--raise");
    expect(d.writes).toEqual([]);
  });

  it("passes on an oam above the floor, leaves the floor alone, and says --raise would move it", async () => {
    const d = drive({ installed: "0.17.0" });
    expect(await d.run()).toBe(0);
    expect(d.lines.join("\n")).toContain(
      "oam 0.17.0 is above the floor 0.16.3; `npm run verify:oam-floor -- --raise` would move the floor to it",
    );
    expect(d.lines.at(-1)).toContain("the floor 0.16.3 stands");
    expect(d.writes).toEqual([]);
  });

  it("fails, and writes nothing even with --raise, on an oam below the floor, naming oam self-update", async () => {
    for (const raise of [false, true]) {
      const d = drive({ installed: "0.16.2", raise });
      expect(await d.run()).toBe(1);
      expect(d.lines.at(-1)).toBe(
        `${TAG} FAIL -- oam 0.16.2 on this machine is BELOW the floor 0.16.3, so it cannot vouch for it: run \`oam self-update\` (then restart any yaw-mcp that is serving) and re-run. The floor stays where it is.`,
      );
      // The mechanism check still ran -- an oam that is both old and broken
      // is two findings, and this one is the more important.
      expect(d.probes).toHaveLength(1);
      expect(d.writes).toEqual([]);
    }
  });

  it("fails, naming the installer and that it installs nothing, when oam is not on PATH", async () => {
    const d = drive({ installed: enoent(), platform: "win32" });
    expect(await d.run()).toBe(1);
    expect(d.lines.at(-1)).toBe(
      `${TAG} FAIL -- oam is not installed on this machine (nothing named oam.exe on PATH, and OAM_BIN is unset), so the oam floor 0.16.3 cannot be verified. Install it -- irm https://oamjs.org/install.ps1 | iex -- then re-run. This script installs nothing itself.`,
    );
    expect(d.probes).toEqual([]);
  });

  it("fails, blaming the variable rather than an install, when OAM_BIN names a path that does not exist", async () => {
    const d = drive({ installed: enoent(), env: { OAM_BIN: "/opt/oam/oam" } });
    expect(await d.run()).toBe(1);
    expect(d.lines.at(-1)).toBe(
      `${TAG} FAIL -- OAM_BIN=/opt/oam/oam does not exist, so the oam floor 0.16.3 cannot be verified on this machine. Fix or unset OAM_BIN. This script installs nothing.`,
    );
    expect(d.lines.join("\n")).not.toContain("oamjs.org");
  });

  it("fails on a version probe that errors for any other reason", async () => {
    const d = drive({ installed: new Error("`oam --version` exited 2") });
    expect(await d.run()).toBe(1);
    expect(d.lines.at(-1)).toBe(
      `${TAG} FAIL -- could not read the installed oam's version: \`oam --version\` exited 2`,
    );
  });

  it("fails on an oam that cannot host the probe, carrying the probe's reason", async () => {
    const d = drive({
      installed: "0.17.0",
      probe: new Error("Connection closed\n  server stderr (tail): OAM-NATIVE0001"),
      raise: true,
    });
    expect(await d.run()).toBe(1);
    expect(d.lines.at(-1)).toBe(
      `${TAG} FAIL -- oam 0.17.0 could not host a stdio @modelcontextprotocol/sdk server through \`oam run ${PROBE_SERVER}\`: Connection closed\n  server stderr (tail): OAM-NATIVE0001`,
    );
    expect(d.writes).toEqual([]);
  });

  it("stops before spawning anything when the source has no floor line", async () => {
    const d = drive({ src: "export const OTHER = 1;\n" });
    expect(await d.run()).toBe(1);
    expect(d.lines).toEqual([`${TAG} FAIL -- ${FLOOR_SRC}: expected exactly one MIN_OAM_VERSION line, found 0`]);
    expect(d.probes).toEqual([]);
  });

  it("--raise moves all three files to a verified oam above the floor", async () => {
    const d = drive({ installed: "0.17.0", raise: true });
    expect(await d.run()).toBe(0);
    expect(d.writes).toEqual([FLOOR_SRC, FLOOR_TEST, FLOOR_CHANGELOG]);
    expect(d.files[FLOOR_SRC]).toContain('export const MIN_OAM_VERSION = "0.17.0";');
    expect(d.files[FLOOR_TEST]).toContain('const FLOOR = "0.17.0";');
    expect(d.files[FLOOR_CHANGELOG]).toContain(`${BLOCK_HEAD}0.17.0**`);
    expect(d.files[FLOOR_CHANGELOG]).toContain("on 2026-09-21");
    expect(d.lines.join("\n")).toContain(
      `raised the oam floor 0.16.3 -> 0.17.0 in ${FLOOR_SRC}, ${FLOOR_TEST} and ${FLOOR_CHANGELOG}; review the diff and commit it`,
    );
    expect(d.lines.at(-1)).toContain("the floor is now 0.17.0");
  });

  it("--raise writes nothing when the floor is already the installed version", async () => {
    const d = drive({ raise: true });
    expect(await d.run()).toBe(0);
    expect(d.writes).toEqual([]);
    expect(d.lines.at(-1)).toContain("the floor is already 0.16.3, nothing to raise");
  });

  it("--raise refuses a prerelease oam, which still passes the plain check", async () => {
    const check = drive({ installed: "0.17.0-rc.1" });
    expect(await check.run()).toBe(0);
    const raise = drive({ installed: "0.17.0-rc.1", raise: true });
    expect(await raise.run()).toBe(1);
    expect(raise.lines.at(-1)).toContain(
      "oam 0.17.0-rc.1 is verified, but the floor cannot be raised to it: refusing to raise the floor to 0.17.0-rc.1: a prerelease is never a floor",
    );
    expect(raise.writes).toEqual([]);
  });

  it("--raise writes none of the three when one of them does not validate", async () => {
    const d = drive({ installed: "0.17.0", raise: true });
    d.files[FLOOR_CHANGELOG] = "# Changelog\n\n## 1.0.11 -- already named\n\nText.\n";
    expect(await d.run()).toBe(1);
    expect(d.lines.at(-1)).toContain("the floor cannot be raised to it: CHANGELOG.md: its first ## section is");
    expect(d.writes).toEqual([]);
    expect(d.files[FLOOR_SRC]).toContain('"0.16.3"');
  });

  it("honours VERIFY_OAM_FLOOR_TIMEOUT_MS, and falls back to 30 s on anything that is not a positive integer", async () => {
    const set = drive({ env: { VERIFY_OAM_FLOOR_TIMEOUT_MS: "5000" } });
    await set.run();
    expect(set.probes[0].timeoutMs).toBe(5000);
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      const d = drive({ env: { VERIFY_OAM_FLOOR_TIMEOUT_MS: bad } });
      await d.run();
      expect(d.probes[0].timeoutMs, JSON.stringify(bad)).toBe(30_000);
    }
  });
});

// ---------------------------------------------------------------------------
// SUBPROCESS
// ---------------------------------------------------------------------------

describe("verify-oam-floor as a script", () => {
  const script = join(REPO_ROOT, "scripts", "verify-oam-floor.mjs");
  function runScript(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("prints the FAIL line and exits 1 when OAM_BIN names nothing, installing nothing", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "verify-oam-floor-")), "no-such-oam");
    tmpRoots.push(join(missing, ".."));
    const before = readFileSync(join(REPO_ROOT, FLOOR_SRC), "utf8");
    const r = runScript([], { OAM_BIN: missing });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${TAG} FAIL -- OAM_BIN=${missing} does not exist`);
    expect(r.out).toContain("This script installs nothing.");
    expect(r.out).not.toContain(`${TAG} OK`);
    expect(readFileSync(join(REPO_ROOT, FLOOR_SRC), "utf8")).toBe(before);
  });

  it("prints usage on --help and refuses an unknown flag with exit 2", () => {
    const help = runScript(["--help"]);
    expect(help.status).toBe(0);
    expect(help.out).toContain("Usage: node scripts/verify-oam-floor.mjs [--raise]");
    const bad = runScript(["--nope"]);
    expect(bad.status).toBe(2);
    expect(bad.out).toContain("unknown option --nope");
  });

  it("is what `npm run verify:oam-floor` runs", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["verify:oam-floor"]).toBe("node scripts/verify-oam-floor.mjs");
  });
});
