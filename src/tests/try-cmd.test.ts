import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLaunchEntry, ENTRY_NAME } from "../install-targets.js";
import {
  anonIdPath,
  computeAnonId,
  type ExploreServerResponse,
  formatTtl,
  gcExpiredTrials,
  loadOrCreateAnonId,
  parseDurationMs,
  parseTryArgs,
  parseTryCleanupArgs,
  runTry,
  runTryCleanup,
  scanTrials,
  type TrialMarker,
  type TryEventBody,
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
});

describe("computeAnonId", () => {
  it("is a 16-char lowercase hex string", () => {
    const id = computeAnonId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable on the same machine across calls", () => {
    expect(computeAnonId()).toBe(computeAnonId());
  });
});

describe("loadOrCreateAnonId", () => {
  it("creates the file on first call and reuses on subsequent calls", async () => {
    const first = await loadOrCreateAnonId(synthHome);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(anonIdPath(synthHome))).toBe(true);

    // Mutate the file and re-load -- the file wins over a fresh compute.
    writeFileSync(anonIdPath(synthHome), "deadbeefdeadbeef\n");
    const second = await loadOrCreateAnonId(synthHome);
    expect(second).toBe("deadbeefdeadbeef");
  });

  it("regenerates when the persisted value is malformed", async () => {
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(anonIdPath(synthHome), "not-a-hex\n");
    const id = await loadOrCreateAnonId(synthHome);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toBe("not-a-hex");
  });
});

describe("runTry — happy path", () => {
  it("writes the trial entry + marker, posts the telemetry event, prints the 3-line nudge", async () => {
    const cap = captureIO();
    const events: TryEventBody[] = [];
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
      postEvent: async (_url, body) => {
        events.push(body);
      },
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

    // anonId seeded.
    expect(existsSync(anonIdPath(synthHome))).toBe(true);

    // Telemetry event fired.
    expect(events).toHaveLength(1);
    expect(events[0].slug).toBe("demo");
    expect(events[0].action).toBe("try");
    expect(events[0].anonId).toMatch(/^[0-9a-f]{16}$/);

    // 3-line nudge.
    const text = cap.text();
    expect(text).toMatch(/Trial wired/);
    expect(text).toMatch(/Expires in 1h/);
    expect(text).toMatch(/Sign up/);
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
      postEvent: async () => undefined,
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
      postEvent: async () => undefined,
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
      postEvent: async () => undefined,
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
      postEvent: async () => undefined,
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

describe("runTry — client config perms (POSIX)", () => {
  const posixOnly = process.platform === "win32" ? it.skip : it;

  posixOnly("chmods a freshly-created secret-bearing client config to 0600", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
      postEvent: async () => undefined,
    });
    expect(r.exitCode).toBe(0);
    const clientPath = join(synthHome, ".claude.json");
    expect(statSync(clientPath).mode & 0o777).toBe(0o600);
  });

  posixOnly("does NOT tighten perms on a pre-existing user-owned client file", async () => {
    const clientPath = join(synthHome, ".claude.json");
    // User's own file, group/other-readable.
    writeFileSync(clientPath, JSON.stringify({ mcpServers: {} }), { mode: 0o644 });
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
      postEvent: async () => undefined,
    });
    expect(r.exitCode).toBe(0);
    // Pre-existing file: we must not silently re-perm the user's file to 0600.
    expect(statSync(clientPath).mode & 0o777).not.toBe(0o600);
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
      postEvent: async () => undefined,
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
        postEvent: async () => undefined,
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
      postEvent: async () => undefined,
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
      postEvent: async () => undefined,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.model).toBe("claude-opus-4-7");
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    expect(client.mcpServers.other).toEqual({ command: "node", args: ["other.js"] });
    expect(client.mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });
});

describe("runTryCleanup", () => {
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
      postEvent: async () => undefined,
    });
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(true);

    const cap = captureIO();
    const events: TryEventBody[] = [];
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      postEvent: async (_url, body) => {
        events.push(body);
      },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"]).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("cleanup");
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
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      postEvent: async () => undefined,
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
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      postEvent: async () => undefined,
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

  it("GC peels the expired entry out of the client config + fires expiry-gc event + deletes the marker", async () => {
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

    const events: TryEventBody[] = [];
    const result = await gcExpiredTrials({
      home: synthHome,
      env: {},
      now: () => baseNow,
      postEvent: async (_url, body) => {
        events.push(body);
      },
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
    // Event fired.
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("expiry-gc");
    expect(events[0].slug).toBe("old");
  });

  it("GC is a no-op when no expired trials exist", async () => {
    const result = await gcExpiredTrials({ home: synthHome, env: {} });
    expect(result.cleared).toBe(0);
  });
});
