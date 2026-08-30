import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { atomicWriteFile } from "../atomic-write.js";
import { buildLaunchEntry, ENTRY_NAME } from "../install-targets.js";
import {
  type ExploreServerResponse,
  formatTtl,
  gcExpiredTrials,
  parseDurationMs,
  parseTryArgs,
  parseTryCleanupArgs,
  runTry,
  runTryCleanup,
  scanTrials,
  type TrialMarker,
  trialMarkerPath,
  trialsDir,
} from "../try-cmd.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-try-home-"));
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

function captureIO(): {
  out: string[];
  err: string[];
  pushOut: (s: string) => void;
  pushErr: (s: string) => void;
  text: () => string;
  errText: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    pushOut: (s: string): void => {
      out.push(s);
    },
    pushErr: (s: string): void => {
      err.push(s);
    },
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

/** Path of the retired per-machine anon-id file. `try` no longer has a
 *  loader for it -- this literal exists so the tests below can assert the
 *  fingerprint is never written back. */
function legacyAnonPath(home: string): string {
  return join(trialsDir(home), ".anon");
}

const SAMPLE: ExploreServerResponse = {
  slug: "demo",
  name: "Demo MCP",
  command: "npx",
  args: ["-y", "@demo/mcp"],
  requiredEnvVars: [],
};

describe("parseTryArgs", () => {
  it("rejects empty argv with usage", () => {
    const r = parseTryArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Usage:/);
  });

  it("accepts a bare slug", () => {
    const r = parseTryArgs(["demo"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.slug).toBe("demo");
  });

  it("rejects more than one positional", () => {
    const r = parseTryArgs(["demo", "other"]);
    expect(r.ok).toBe(false);
  });

  it("parses --client", () => {
    const r = parseTryArgs(["demo", "--client", "cursor"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.clientId).toBe("cursor");
  });

  it("rejects --client with unknown value", () => {
    const r = parseTryArgs(["demo", "--client", "zed"]);
    expect(r.ok).toBe(false);
  });

  it("parses --ttl and rejects garbage", () => {
    const good = parseTryArgs(["demo", "--ttl", "30m"]);
    expect(good.ok).toBe(true);
    const bad = parseTryArgs(["demo", "--ttl", "later"]);
    expect(bad.ok).toBe(false);
  });

  it("parses repeated --env KEY=val", () => {
    const r = parseTryArgs(["demo", "--env", "FOO=bar", "--env", "BAZ=qux"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.envOverrides).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("rejects --env without =", () => {
    const r = parseTryArgs(["demo", "--env", "FOO"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --env with invalid key", () => {
    const r = parseTryArgs(["demo", "--env", "1FOO=bar"]);
    expect(r.ok).toBe(false);
  });

  it("parses --dry-run + --base", () => {
    const r = parseTryArgs(["demo", "--dry-run", "--base", "http://localhost:3000"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.dryRun).toBe(true);
      expect(r.options.baseUrl).toBe("http://localhost:3000");
    }
  });

  it("rejects --base followed by a flag instead of swallowing --dry-run as the URL", () => {
    const r = parseTryArgs(["demo", "--base", "--dry-run"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--base requires a URL/);
  });

  it("rejects unknown flags", () => {
    const r = parseTryArgs(["demo", "--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("rejects a bare '-' positional with a clear arg-parse error", () => {
    const r = parseTryArgs(["-"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid argument "-"/);
  });
});

describe("parseTryCleanupArgs", () => {
  it("requires a slug", () => {
    expect(parseTryCleanupArgs([]).ok).toBe(false);
    expect(parseTryCleanupArgs(["demo"]).ok).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(parseTryCleanupArgs(["demo", "--bogus"]).ok).toBe(false);
  });

  it("rejects --base followed by a flag instead of swallowing it as the URL", () => {
    const r = parseTryCleanupArgs(["demo", "--base", "--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--base requires a URL/);
  });

  it("still accepts --base with a real URL", () => {
    const r = parseTryCleanupArgs(["demo", "--base", "http://localhost:3000"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.baseUrl).toBe("http://localhost:3000");
  });

  it("rejects a bare '-' positional with a clear arg-parse error", () => {
    const r = parseTryCleanupArgs(["-"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid argument "-"/);
  });
});

describe("parseDurationMs", () => {
  it("parses s/m/h/d suffixes", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("3d")).toBe(259_200_000);
  });

  it("returns null on bogus input", () => {
    expect(parseDurationMs("later")).toBeNull();
    expect(parseDurationMs("0h")).toBeNull();
    expect(parseDurationMs("-5m")).toBeNull();
  });
});

describe("formatTtl", () => {
  it("renders seconds / minutes / hours / days", () => {
    expect(formatTtl(5000)).toBe("5s");
    expect(formatTtl(120_000)).toBe("2m");
    expect(formatTtl(7_200_000)).toBe("2h");
    expect(formatTtl(2 * 86_400_000)).toBe("2d");
  });

  it("floors rather than rounds so the nudge never overstates the time left", () => {
    // Rounding printed 90m as "2h" and 36h as "2d" -- half an hour and half a
    // day the user did not have, on a line that reads as a precise expiry.
    expect(formatTtl(90 * 60_000)).toBe("1h");
    expect(formatTtl(36 * 3_600_000)).toBe("1d");
    expect(formatTtl(5_700)).toBe("5s");
    expect(formatTtl(59_999)).toBe("59s");
  });
});

describe("anon-id retirement", () => {
  it("leaves a pre-existing .anon file alone instead of reading or rewriting it", async () => {
    // An older version persisted a machine fingerprint here. Nothing loads it
    // now, and `try` must neither consume it nor delete it out from under the
    // user -- it just stops being touched.
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(legacyAnonPath(synthHome), "deadbeefdeadbeef\n");

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    // Untouched on disk, byte for byte...
    expect(readFileSync(legacyAnonPath(synthHome), "utf8")).toBe("deadbeefdeadbeef\n");
    // ...and absent from everything the run emitted. There is no event body
    // to leak it into any more -- the reporting seam is gone outright -- so
    // the command's own output is the surface left worth checking.
    expect(cap.text()).not.toContain("deadbeef");
  });
});

describe("runTry — happy path", () => {
  it("writes the trial entry + marker, fires the lifecycle event, prints the 3-line nudge", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      ttl: "1h",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      now: () => 1_700_000_000_000,
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);

    // Trial marker exists with expected shape.
    const markerPath = trialMarkerPath("demo", synthHome);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as TrialMarker;
    expect(marker.slug).toBe("demo");
    expect(marker.expiresAt).toBe(1_700_000_000_000 + 3_600_000);
    expect(marker.entryName).toBe("yaw-mcp-try-demo");
    expect(marker.clientName).toBe("claude-code");

    // Client config has the entry with upstream command/args (NOT yaw-mcp's
    // npx invocation -- this is the spec contract).
    const clientPath = join(synthHome, ".claude.json");
    expect(existsSync(clientPath)).toBe(true);
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    const entry = client.mcpServers["yaw-mcp-try-demo"];
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "@demo/mcp"]);
    // The canonical yaw-mcp entry is NOT created by `try`.
    expect(client.mcpServers[ENTRY_NAME]).toBeUndefined();

    // No machine fingerprint persisted -- the .anon file is never created.
    expect(existsSync(legacyAnonPath(synthHome))).toBe(false);

    // 3-line nudge. The keep-it CTA points at the local `add` path -- the
    // hosted signup page it used to advertise is gone (404s).
    const text = cap.text();
    expect(text).toMatch(/Trial wired/);
    expect(text).toMatch(/Expires in 1h/);
    expect(text).toMatch(/Liking it\? Keep Demo MCP for good with: yaw-mcp add demo/);
    expect(text).not.toMatch(/Sign up|\/signup/);
  });

  it("reuses buildLaunchEntry's Windows cmd /c wrap for the trial entry", async () => {
    // Same upstream shape, OS=windows; entry must be { command: 'cmd',
    // args: ['/c', <command>, ...<args>] } -- the exact pattern
    // buildLaunchEntry encodes for the canonical yaw-mcp launcher.
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "windows",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);

    const clientPath = join(synthHome, ".claude.json");
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    const entry = client.mcpServers["yaw-mcp-try-demo"];
    expect(entry.command).toBe("cmd");
    expect(entry.args).toEqual(["/c", "npx", "-y", "@demo/mcp"]);

    // Sanity: same wrapping the canonical yaw-mcp entry uses.
    const canonical = buildLaunchEntry({ os: "windows" });
    expect(entry.command).toBe(canonical.command);
  });

  it("caret-escapes cmd metacharacters in catalog args on Windows (client-spawn injection guard)", async () => {
    // The trial entry is spawned by the MCP CLIENT, whose libuv only quotes
    // argv elements containing space/tab/quote -- so a catalog arg carrying a
    // bare `&` would reach cmd.exe unquoted and run the tail as a second
    // command at client-spawn time, with the config file looking innocuous.
    // `npx` is a `.cmd` shim: it forwards args through `%*`, which cmd RE-PARSES,
    // so a metachar must survive TWO cmd parses -- triple-caret (`^^^&`). The
    // single caret this once asserted was a no-op against the shim (bug #1).
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "windows",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({
        ...SAMPLE,
        args: ["-y", "@demo/mcp", "--url", "https://api/x?a=1&b=2"],
      }),
    });
    expect(r.exitCode).toBe(0);

    const clientPath = join(synthHome, ".claude.json");
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    const entry = client.mcpServers["yaw-mcp-try-demo"];
    expect(entry.command).toBe("cmd");
    expect(entry.args).toEqual(["/c", "npx", "-y", "@demo/mcp", "--url", "https://api/x?a=1^^^&b=2"]);
  });
});

describe("runTry — missing env vars", () => {
  it("refuses to wire the trial when a required env var is missing", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/needs the following env var/);
    expect(cap.errText()).toMatch(/FOO_TOKEN/);
    // Nothing written.
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
  });

  it("accepts the env var via --env override", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"].env).toEqual({ FOO_TOKEN: "secret" });
    // Supplied via --env, NOT the ambient shell -- no ambient-source note.
    expect(cap.errText()).not.toMatch(/read from your shell env/);
  });

  it("persists an ambient-shell value inline and warns it was sourced from the shell", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      // Value present in the ambient shell env, NOT via --env.
      env: { FOO_TOKEN: "ambient-secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    // `try` (unlike `add`) copies the resolved value inline so the directly-
    // launched trial entry can see it.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"].env).toEqual({ FOO_TOKEN: "ambient-secret" });
    // And warns on stderr that the value came from the shell.
    expect(cap.errText()).toMatch(/FOO_TOKEN/);
    expect(cap.errText()).toMatch(/read from your shell env/);
  });
});

// `try` decides the perms of the client config through the mode it hands
// atomicWriteFile: an explicit 0o600 when the launch entry carries an inline
// secret, and NO mode at all when it does not -- withholding is what makes
// atomicWriteFile carry the target's existing mode forward instead of widening
// it (see the preservation tests in atomic-write.test.ts). That REQUEST is this
// module's behaviour; whether the filesystem then honours POSIX bits is the
// OS's, and Windows does not honour them at all (stat reports a synthetic
// 0o666), so the old stat().mode assertions ran on no machine -- this suite
// only ever runs on Windows.
//
// process.platform is reported as POSIX throughout for the same reason:
// `tightenPerms = entryHasSecrets && process.platform !== "win32"`, so without
// it the 0o600 arm is unreachable AND the negative arms would pass for the
// platform's reason instead of the no-secret reason they exist to pin.
describe("runTry — client config perms", () => {
  let restorePlatform: (() => void) | null = null;

  beforeEach(() => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    restorePlatform = (): void => {
      if (original) Object.defineProperty(process, "platform", original);
    };
  });

  afterEach(() => {
    restorePlatform?.();
    restorePlatform = null;
    vi.restoreAllMocks();
  });

  const clientPath = (): string => join(synthHome, ".claude.json");

  /** Passthrough spy over the write helper -- the config is still really
   *  written, we just get to see the mode that was asked for. */
  async function spyOnWrites(): Promise<MockInstance<typeof atomicWriteFile>> {
    const atomic = await import("../atomic-write.js");
    return vi.spyOn(atomic, "atomicWriteFile");
  }

  /** The mode argument of the write to `path`. `undefined` means no explicit
   *  mode was passed, i.e. "preserve whatever the target already had". */
  function modeAskedFor(spy: MockInstance<typeof atomicWriteFile>, path: string): number | undefined {
    const call = spy.mock.calls.find((c) => c[0] === path);
    expect(call, `${path} was never written; saw ${JSON.stringify(spy.mock.calls.map((c) => c[0]))}`).toBeDefined();
    // Guards the fixture, not the SUT: a write that escaped synthHome would
    // otherwise be reported as "no write at all" (see the env note above).
    for (const c of spy.mock.calls) expect(String(c[0]).startsWith(synthHome)).toBe(true);
    return call?.[3];
  }

  it("asks for an owner-only (0600) config when it creates one carrying a secret", async () => {
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      // An EMPTY ambient env, not the process's: runTry reads CLAUDE_CONFIG_DIR
      // out of it, so inheriting process.env resolves the "claude-code" target
      // to the real config dir of whoever runs the suite instead of to
      // synthHome. (These three cases were skipped on win32, so the fixture
      // had never been exercised on a machine that sets that variable.)
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    // Born owner-only rather than chmodded after the rename: there is no
    // window where the plaintext credential sits at the umask default.
    expect(modeAskedFor(spy, clientPath())).toBe(0o600);
    const client = JSON.parse(readFileSync(clientPath(), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"].env).toEqual({ FOO_TOKEN: "secret" });
  });

  it("asks for 0600 when writing an inline secret into a pre-existing user file", async () => {
    // User's own content-bearing file. An explicit mode beats atomicWriteFile's
    // preserve-the-target's-mode default, so this TIGHTENS a config that was
    // group/other-readable: protecting the credential we just injected wins
    // over leaving the pre-existing perms alone.
    writeFileSync(clientPath(), JSON.stringify({ mcpServers: { alpha: { command: "x" } } }));
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      // An EMPTY ambient env, not the process's: runTry reads CLAUDE_CONFIG_DIR
      // out of it, so inheriting process.env resolves the "claude-code" target
      // to the real config dir of whoever runs the suite instead of to
      // synthHome. (These three cases were skipped on win32, so the fixture
      // had never been exercised on a machine that sets that variable.)
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    expect(modeAskedFor(spy, clientPath())).toBe(0o600);
    // ...and it really was the merge path: the user's own entry survived.
    const client = JSON.parse(readFileSync(clientPath(), "utf8"));
    expect(client.mcpServers.alpha.command).toBe("x");
  });

  it("asks for 0600 on an EMPTY pre-existing client file", async () => {
    // File exists but is empty -> `try` materializes its content, so it counts
    // as freshly created (the perms decision keys off content, not mere
    // existence). It must not be left at the umask default.
    writeFileSync(clientPath(), "");
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      // An EMPTY ambient env, not the process's: runTry reads CLAUDE_CONFIG_DIR
      // out of it, so inheriting process.env resolves the "claude-code" target
      // to the real config dir of whoever runs the suite instead of to
      // synthHome. (These three cases were skipped on win32, so the fixture
      // had never been exercised on a machine that sets that variable.)
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    expect(modeAskedFor(spy, clientPath())).toBe(0o600);
  });

  it("passes NO mode when the trial carries no secret, so the target's perms are preserved", async () => {
    // The other half of the contract: `try` must not force 0600, but it must
    // never LOOSEN either. atomicWriteFile renames a new inode over the target,
    // so before mode preservation this wrote a umask-default file over a 0600
    // one -- exposing whatever the user had already tightened it for (an
    // earlier trial's inline API key, or a hand chmod). Withholding the mode is
    // exactly how this path opts into preservation.
    writeFileSync(clientPath(), JSON.stringify({ mcpServers: { alpha: { env: { A_TOKEN: "s" } } } }));
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(modeAskedFor(spy, clientPath())).toBeUndefined();
    // And the pre-existing secret-bearing entry is still there to protect.
    const client = JSON.parse(readFileSync(clientPath(), "utf8"));
    expect(client.mcpServers.alpha.env.A_TOKEN).toBe("s");
  });

  it("try-cleanup passes no mode either, so peeling a trial cannot widen the config", async () => {
    const cap1 = captureIO();
    await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap1.pushOut,
      err: cap1.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    // Spy only around the cleanup, so the write under test is unambiguous.
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(modeAskedFor(spy, clientPath())).toBeUndefined();
    // The entry really was removed -- otherwise there was no write to judge.
    const client = JSON.parse(readFileSync(clientPath(), "utf8"));
    expect(client.mcpServers?.["yaw-mcp-try-demo"]).toBeUndefined();
  });

  it("does NOT tighten a freshly-created config when the trial entry carries no inline secret", async () => {
    // Negative arm: SAMPLE has requiredEnvVars:[] and no --env override, so the
    // trial entry's env resolves to undefined (entryHasSecrets === false) and
    // tightenPerms === false. Nothing secret was written, so `try` must not
    // force 0600 -- which is what stops a regression that unconditionally
    // tightens every config it touches.
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(clientPath())).toBe(true);
    expect(modeAskedFor(spy, clientPath())).toBeUndefined();
  });
});

describe("runTry — unparseable ttl (programmatic callers)", () => {
  it("errors out instead of silently substituting the 1h default", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      ttl: "later", // bypasses parseTryArgs -- programmatic caller bug
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.errText()).toMatch(/invalid ttl "later"/);
    // Nothing written.
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
  });
});

describe("runTry — dry-run", () => {
  it("writes nothing, returns the marker, prints the would-be plan", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(r.marker).toBeDefined();
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    expect(cap.text()).toMatch(/dry-run/);
  });
});

describe("runTry — slug validation", () => {
  it("refuses uppercase / slashes / dots", async () => {
    const cap = captureIO();
    for (const bad of ["Foo", "foo/bar", "foo.bar", "../bad", ""]) {
      const r = await runTry({
        slug: bad,
        clientId: "claude-code",
        home: synthHome,
        cwd: synthCwd,
        os: "linux",
        env: {},
        out: cap.pushOut,
        err: cap.pushErr,
        fetchExplore: async () => SAMPLE,
      });
      expect(r.exitCode).toBe(2);
    }
  });
});

describe("runTry — fetch failure", () => {
  it("surfaces the error and writes nothing", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => {
        throw new Error('yaw-mcp try: no server with slug "demo"');
      },
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/no server with slug/);
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
  });
});

describe("runTry — preserves existing client config siblings", () => {
  it("does not stomp the canonical yaw-mcp entry or any other server", async () => {
    // Pre-populate ~/.claude.json with the canonical yaw-mcp entry and an
    // unrelated server.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({
        model: "claude-opus-4-7",
        mcpServers: {
          [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
          other: { command: "node", args: ["other.js"] },
        },
      }),
    );
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.model).toBe("claude-opus-4-7");
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    expect(client.mcpServers.other).toEqual({ command: "node", args: ["other.js"] });
    expect(client.mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });
});

describe("runTry — unreadable vs invalid client config", () => {
  it("reports a read failure as a read failure, not as invalid JSON", async () => {
    // A directory where the config should be is the portable way to make
    // readFile fail (EISDIR); the real-world shape is a root-owned or
    // other-user-0600 ~/.claude.json (EACCES). Folding read and parse into one
    // catch told the user their JSON was invalid and sent them to inspect a
    // file they cannot even open.
    mkdirSync(join(synthHome, ".claude.json"), { recursive: true });
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/could not be read/);
    expect(cap.errText()).toMatch(/permissions/);
    expect(cap.errText()).not.toMatch(/not valid JSON/);
  });

  it("still reports genuinely invalid JSON as invalid JSON", async () => {
    writeFileSync(join(synthHome, ".claude.json"), "{ not json");
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/is not valid JSON/);
  });
});

describe("runTry — re-run against a different client", () => {
  it("peels the previous client's entry before the marker stops naming it", async () => {
    // The marker path is keyed on SLUG alone, so this re-run overwrites the
    // only record of the cursor wiring. Without the peel, the cursor entry --
    // inline secret included -- is orphaned past its TTL: try-cleanup reads
    // only the current marker and doctor's GC only walks markers.
    const cap1 = captureIO();
    await runTry({
      slug: "demo",
      clientId: "cursor",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { D_TOKEN: "secret" },
      out: cap1.pushOut,
      err: cap1.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["D_TOKEN"] }),
    });
    const cursorPath = join(synthHome, ".cursor", "mcp.json");
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeDefined();

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { D_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["D_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    // Old client's entry is gone (and the user was told).
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeUndefined();
    expect(cap.text()).toMatch(/Removed the previous demo trial/);
    // New client's entry is wired and the marker now points at it.
    const clientPath = join(synthHome, ".claude.json");
    expect(JSON.parse(readFileSync(clientPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeDefined();
    const marker = JSON.parse(readFileSync(trialMarkerPath("demo", synthHome), "utf8")) as TrialMarker;
    expect(marker.clientPath).toBe(clientPath);
  });

  it("leaves the entry alone when re-run against the SAME client", async () => {
    const common = {
      slug: "demo",
      clientId: "claude-code" as const,
      home: synthHome,
      cwd: synthCwd,
      os: "linux" as const,
      env: {},
      fetchExplore: async () => SAMPLE,
    };
    const cap1 = captureIO();
    await runTry({ ...common, out: cap1.pushOut, err: cap1.pushErr });
    const cap = captureIO();
    const r = await runTry({ ...common, ttl: "2h", out: cap.pushOut, err: cap.pushErr });
    expect(r.exitCode).toBe(0);
    // Same client + same entry name -> nothing to peel, no scary line.
    expect(cap.text()).not.toMatch(/Removed the previous/);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });
});

describe("marker trust guards", () => {
  function writeMarker(slug: string, extra: Partial<TrialMarker>): string {
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const marker: TrialMarker = {
      schemaVersion: 1,
      slug,
      name: "Demo MCP",
      expiresAt: Date.now() - 1,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: `yaw-mcp-try-${slug}`,
      createdAt: Date.now() - 3_600_000,
      ...extra,
    };
    const path = trialMarkerPath(slug, synthHome);
    writeFileSync(path, JSON.stringify(marker));
    return path;
  }

  it("try-cleanup refuses a marker naming a non-trial entry instead of deleting that key", async () => {
    // Blast radius without the guard: a hand-edited / corrupted marker makes
    // cleanup remove an ARBITRARY key from an arbitrary JSON file -- here the
    // canonical yaw-mcp launch entry.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx" } } }),
    );
    writeMarker("evil", { entryName: ENTRY_NAME });

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "evil",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/non-trial entry/);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toBeDefined();
  });

  it("scanTrials classifies a non-trial entryName as malformed rather than sweepable", async () => {
    writeMarker("evil", { entryName: ENTRY_NAME });
    const scan = await scanTrials({ home: synthHome });
    expect(scan.expired).toHaveLength(0);
    expect(scan.malformed).toHaveLength(1);
  });

  it("scanTrials refuses a marker from a NEWER schema, but accepts one with the field absent", async () => {
    // Above our version = semantics we cannot know, so the GC does not guess.
    // Absent = older / hand-rolled marker, read as v1; rejecting those would
    // strand a live trial entry with nothing able to reclaim it.
    writeMarker("future", { schemaVersion: 2 });
    writeMarker("legacy", { schemaVersion: undefined as unknown as number });
    const scan = await scanTrials({ home: synthHome });
    expect(scan.malformed).toHaveLength(1);
    expect(scan.malformed[0]).toContain("future");
    expect(scan.expired.map((e) => e.marker.slug)).toEqual(["legacy"]);
  });

  it("GC leaves a future-schema marker on disk for the user to deal with", async () => {
    const path = writeMarker("future", { schemaVersion: 99 });
    const result = await gcExpiredTrials({ home: synthHome });
    expect(result.cleared).toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});

describe("runTryCleanup", () => {
  it("leaves a BOM-prefixed config byte-identical when there is no entry to remove", async () => {
    // removeJsoncEntry's no-op used to return the de-BOM'd source, which reads
    // as "changed" here -- so cleanup rewrote a Notepad-saved ~/.claude.json,
    // stripped its BOM, and printed "Removed ..." having removed nothing.
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const clientPath = join(synthHome, ".claude.json");
    const original = ["﻿{", '  "mcpServers": { "other": { "command": "x" } }', "}", ""].join("\n");
    writeFileSync(clientPath, original, "utf8");
    const marker: TrialMarker = {
      schemaVersion: 1,
      slug: "demo",
      name: "Demo MCP",
      expiresAt: Date.now() + 3_600_000,
      clientPath,
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-demo",
      createdAt: Date.now(),
    };
    writeFileSync(trialMarkerPath("demo", synthHome), JSON.stringify(marker));

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(readFileSync(clientPath, "utf8")).toBe(original);
    expect(cap.text()).not.toMatch(/Removed yaw-mcp-try-demo/);
  });

  it("removes the entry + marker + fires cleanup event, written contains client path", async () => {
    // Wire a trial first.
    const cap1 = captureIO();
    await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap1.pushOut,
      err: cap1.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(true);

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"]).toBeUndefined();
    // Cleanup must not seed a machine fingerprint either.
    expect(existsSync(legacyAnonPath(synthHome))).toBe(false);
    // written must contain the client path because the entry was actually removed.
    expect(r.written).toContain(join(synthHome, ".claude.json"));
  });

  it("written is empty when the client config has no entry to remove", async () => {
    // Create a marker that points at a config file that no longer has the entry.
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    const marker: TrialMarker = {
      schemaVersion: 1,
      slug: "demo",
      name: "Demo MCP",
      expiresAt: Date.now() + 3_600_000,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-demo",
      createdAt: Date.now(),
    };
    writeFileSync(trialMarkerPath("demo", synthHome), JSON.stringify(marker));

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    // Nothing was written because the entry was already absent.
    expect(r.written).toEqual([]);
  });

  it("is a clean no-op when no trial is wired", async () => {
    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).toMatch(/nothing to do/);
  });
});

describe("scanTrials + gcExpiredTrials", () => {
  it("classifies live vs expired markers correctly", async () => {
    const baseNow = 1_700_000_000_000;
    // Write two markers by hand: one expired, one live.
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const expiredMarker: TrialMarker = {
      schemaVersion: 1,
      slug: "old",
      name: "Old MCP",
      expiresAt: baseNow - 1,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-old",
      createdAt: baseNow - 3_600_000,
    };
    const liveMarker: TrialMarker = {
      ...expiredMarker,
      slug: "new",
      name: "New MCP",
      expiresAt: baseNow + 1_800_000,
      entryName: "yaw-mcp-try-new",
    };
    writeFileSync(trialMarkerPath("old", synthHome), JSON.stringify(expiredMarker));
    writeFileSync(trialMarkerPath("new", synthHome), JSON.stringify(liveMarker));

    const scan = await scanTrials({ home: synthHome, now: () => baseNow });
    expect(scan.expired.map((e) => e.marker.slug)).toEqual(["old"]);
    expect(scan.live.map((e) => e.marker.slug)).toEqual(["new"]);
  });

  it("treats unparseable markers as malformed instead of crashing", async () => {
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(join(trialsDir(synthHome), "junk.json"), "{not json");
    const scan = await scanTrials({ home: synthHome });
    expect(scan.malformed).toHaveLength(1);
  });

  it("GC peels the expired entry out of the client config + deletes the marker", async () => {
    const baseNow = 1_700_000_000_000;
    // Pre-populate the client config with the entry the marker points at.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
          "yaw-mcp-try-old": { command: "npx", args: ["-y", "@old/mcp"] },
        },
      }),
    );
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const expiredMarker: TrialMarker = {
      schemaVersion: 1,
      slug: "old",
      name: "Old MCP",
      expiresAt: baseNow - 1,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-old",
      createdAt: baseNow - 3_600_000,
    };
    writeFileSync(trialMarkerPath("old", synthHome), JSON.stringify(expiredMarker));

    const result = await gcExpiredTrials({
      home: synthHome,
      now: () => baseNow,
    });
    expect(result.cleared).toBe(1);
    expect(result.failed).toBe(0);

    // Entry peeled out.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-old"]).toBeUndefined();
    // Canonical yaw-mcp entry untouched.
    expect(client.mcpServers[ENTRY_NAME]).toBeDefined();
    // Marker file deleted.
    expect(existsSync(trialMarkerPath("old", synthHome))).toBe(false);
    // The GC sweep no longer seeds a machine fingerprint on its way through.
    expect(existsSync(legacyAnonPath(synthHome))).toBe(false);
  });

  it("GC is a no-op when no expired trials exist", async () => {
    const result = await gcExpiredTrials({ home: synthHome });
    expect(result.cleared).toBe(0);
  });

  it("GC unlinks the scanned marker file even when its filename doesn't match its slug", async () => {
    const baseNow = 1_700_000_000_000;
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const expiredMarker: TrialMarker = {
      schemaVersion: 1,
      slug: "old",
      name: "Old MCP",
      expiresAt: baseNow - 1,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-old",
      createdAt: baseNow - 3_600_000,
    };
    // Filename intentionally mismatches the slug field ("renamed" vs "old").
    // Unlinking via trialMarkerPath(marker.slug) would ENOENT, count as
    // failed, and leave the marker to re-fail on every doctor GC forever.
    const mismatchedPath = join(trialsDir(synthHome), "renamed.json");
    writeFileSync(mismatchedPath, JSON.stringify(expiredMarker));

    const result = await gcExpiredTrials({
      home: synthHome,
      now: () => baseNow,
    });
    expect(result.cleared).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(mismatchedPath)).toBe(false);
  });

  it("keeps the marker and reports a peel failure when the client file is valid JSON but not an object", async () => {
    // A JSON array throws nothing, so the peel was silently skipped and the
    // marker unlinked anyway -- orphaning a still-wired trial entry with
    // nothing left on disk that could ever name it again.
    const baseNow = 1_700_000_000_000;
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, "[]\n");
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const expiredMarker: TrialMarker = {
      schemaVersion: 1,
      slug: "old",
      name: "Old MCP",
      expiresAt: baseNow - 1,
      clientPath,
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-old",
      createdAt: baseNow - 3_600_000,
    };
    const markerPath = trialMarkerPath("old", synthHome);
    writeFileSync(markerPath, JSON.stringify(expiredMarker));

    const result = await gcExpiredTrials({
      home: synthHome,
      now: () => baseNow,
    });
    expect(result.cleared).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures[0].stage).toBe("peel");
    expect(result.failures[0].slug).toBe("old");
    // Marker survives so doctor keeps surfacing the still-wired trial.
    expect(existsSync(markerPath)).toBe(true);
  });
});

describe("runTryCleanup — marker field validation", () => {
  const baseMarker = (): Record<string, unknown> => ({
    schemaVersion: 1,
    slug: "demo",
    name: "Demo MCP",
    expiresAt: Date.now() + 3_600_000,
    clientPath: join(synthHome, ".claude.json"),
    clientName: "claude-code",
    containerPath: ["mcpServers"],
    entryName: "yaw-mcp-try-demo",
    createdAt: Date.now(),
  });

  function wireTrial(marker: Record<string, unknown>): { clientPath: string; markerPath: string } {
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, JSON.stringify({ mcpServers: { "yaw-mcp-try-demo": { command: "npx" } } }));
    const markerPath = trialMarkerPath("demo", synthHome);
    writeFileSync(markerPath, JSON.stringify(marker));
    return { clientPath, markerPath };
  }

  it("refuses a marker with no clientPath instead of dropping it and printing 'cleaned up'", async () => {
    // The gate checked entryName only. existsSync(undefined) is false, so the
    // peel was skipped, the marker was unlinked, and the user was told the
    // trial was cleaned up -- while the entry stayed wired in the client
    // config with nothing left on disk naming it.
    const { clientPath, markerPath } = wireTrial({ ...baseMarker(), clientPath: undefined });

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/is unreadable/);
    expect(cap.text()).not.toMatch(/cleaned up/);
    expect(existsSync(markerPath)).toBe(true);
    expect(JSON.parse(readFileSync(clientPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });

  it("refuses a marker whose containerPath is not an array", async () => {
    const { markerPath } = wireTrial({ ...baseMarker(), containerPath: "mcpServers" });

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/is unreadable/);
    expect(existsSync(markerPath)).toBe(true);
  });
});

describe("runTry — previous marker naming the SAME client file", () => {
  it("does not re-insert the entry the step-6b peel just removed", async () => {
    const common = {
      slug: "demo",
      clientId: "claude-code" as const,
      home: synthHome,
      cwd: synthCwd,
      os: "linux" as const,
      env: {},
      fetchExplore: async (): Promise<ExploreServerResponse> => SAMPLE,
    };
    const cap1 = captureIO();
    await runTry({ ...common, out: cap1.pushOut, err: cap1.pushErr });
    const clientPath = join(synthHome, ".claude.json");

    // A previous trial of the same slug wired under a DIFFERENT entry name in
    // the SAME file (a renamed / hand-edited marker). Step 6b peels it out of
    // the file, but the splice was built from the bytes read BEFORE the peel,
    // so writing that render put the peeled entry straight back.
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    client.mcpServers["yaw-mcp-try-demo-old"] = { command: "npx", args: ["-y", "@old/mcp"] };
    writeFileSync(clientPath, JSON.stringify(client, null, 2));
    const markerPath = trialMarkerPath("demo", synthHome);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as TrialMarker;
    writeFileSync(markerPath, JSON.stringify({ ...marker, entryName: "yaw-mcp-try-demo-old" }));

    const cap = captureIO();
    const r = await runTry({ ...common, out: cap.pushOut, err: cap.pushErr });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).toMatch(/Removed the previous demo trial/);
    const after = JSON.parse(readFileSync(clientPath, "utf8"));
    expect(after.mcpServers["yaw-mcp-try-demo-old"]).toBeUndefined();
    expect(after.mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });
});

describe("runTry — catalog URL threading", () => {
  async function runWithCatalogEnv(catalogEnv: Record<string, string>): Promise<Array<string | undefined>> {
    const seen: Array<string | undefined> = [];
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: catalogEnv,
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async (_base, _slug, catalogUrl) => {
        seen.push(catalogUrl);
        return SAMPLE;
      },
    });
    expect(r.exitCode).toBe(0);
    return seen;
  }

  it("threads $YAW_MCP_CATALOG_URL from the injected env into the fetch seam", async () => {
    // Read from process.env inside the seam, an injected `env` was silently
    // overridden by the ambient environment -- the one lookup in runTry that
    // did not honor its own injection point.
    expect(await runWithCatalogEnv({ YAW_MCP_CATALOG_URL: "https://example.test/catalog.json" })).toEqual([
      "https://example.test/catalog.json",
    ]);
  });

  it("treats an EMPTY $YAW_MCP_CATALOG_URL as unset", async () => {
    // "" is not nullish, so it sailed past `??` into fetch(""), which throws a
    // bare TypeError the catalog's friendly wrapper cannot recognize.
    expect(await runWithCatalogEnv({ YAW_MCP_CATALOG_URL: "" })).toEqual([undefined]);
  });
});

describe("runTry — optional --env overrides", () => {
  it("trims override values and drops empty ones instead of persisting a blank var", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { LOG_LEVEL: "", BLANK: "   ", DATABASE_URL: "  postgres://x  " },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    const entry = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8")).mcpServers["yaw-mcp-try-demo"];
    // `--env LOG_LEVEL=` is the user clearing a knob, not asking for a blank
    // one; several upstreams read a set-but-empty var as "configured".
    expect(entry.env).toEqual({ DATABASE_URL: "postgres://x" });
  });
});

describe("runTry — dry-run names the cross-client removal", () => {
  it("says a real run would peel the previous trial out of the other client's config", async () => {
    const cap1 = captureIO();
    await runTry({
      slug: "demo",
      clientId: "cursor",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap1.pushOut,
      err: cap1.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    const cursorPath = join(synthHome, ".cursor", "mcp.json");

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    // The preview must name every write the real run performs -- a removal it
    // omits is exactly what --dry-run is consulted to catch.
    expect(cap.text()).toMatch(/would remove: the previous demo trial/);
    expect(cap.text()).toContain(cursorPath);
    // ...and dry-run still wrote nothing.
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeDefined();
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
  });

  it("does NOT promise to peel a previous marker the real run would refuse", async () => {
    // peelTrialEntry refuses an untrusted marker before touching anything, so
    // a preview built from the clientPath/entryName comparison ALONE printed
    // "would remove: ..." for a removal the real run declines with a warning.
    // A --dry-run that over-promises is worse than one that under-reports:
    // the user reads it as the plan and never checks the real output.
    const otherClient = join(synthHome, ".cursor", "mcp.json");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    writeFileSync(otherClient, JSON.stringify({ mcpServers: { "not-a-trial-entry": { command: "x", args: [] } } }));
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(
      trialMarkerPath("demo", synthHome),
      JSON.stringify({
        schemaVersion: 1,
        slug: "demo",
        name: "Demo",
        expiresAt: Date.now() + 3_600_000,
        clientPath: otherClient,
        clientName: "cursor",
        containerPath: ["mcpServers"],
        // Not a `yaw-mcp-try-*` name: rejectUntrustedMarker refuses it.
        entryName: "not-a-trial-entry",
        createdAt: Date.now(),
      }),
    );

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).not.toMatch(/would remove: the previous demo trial/);
    expect(cap.text()).toMatch(/would NOT remove: the previous demo marker names a non-trial entry/);
  });
});
